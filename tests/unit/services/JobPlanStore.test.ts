import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { JobPlanStore, JobPlanStoreError } from '../../../src/main/services/JobPlanStore';

interface PlanPayload {
  sourcePath: string;
  targetPath: string;
}

describe('JobPlanStore', () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-plan-'));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const create = (identity = 'source-fingerprint', policy = 'resolver-policy-v2') =>
    new JobPlanStore<PlanPayload>(sandbox, { identity, policy, chunkSize: 3 });

  const appendAndCollect = async (
    store: JobPlanStore<PlanPayload>,
    inputs: Array<{ operationId: string; payload: PlanPayload }>
  ) => {
    const references = [];
    for await (const page of store.appendPages(inputs)) references.push(...page);
    return references;
  };

  it('streams records through bounded chunks and pages without retaining the corpus', async () => {
    const store = create();
    await store.initialize();
    const input = Array.from({ length: 8 }, (_, index) => ({
      operationId: `operation-${index}`,
      payload: { sourcePath: `/source/${index}`, targetPath: `/target/${index}` },
    }));

    const references = await appendAndCollect(store, input);
    expect(references).toHaveLength(8);
    expect(await store.getSummary()).toMatchObject({ totalRecords: 8, terminalRecords: 0 });
    expect((await fs.readdir(path.join(sandbox, 'chunks'))).sort()).toEqual([
      'chunk-00000000.jsonl',
      'chunk-00000001.jsonl',
      'chunk-00000002.jsonl',
    ]);

    const pageSizes: number[] = [];
    const observed: string[] = [];
    for await (const page of store.pages({ pageSize: 2 })) {
      pageSizes.push(page.length);
      observed.push(...page.map((record) => record.operationId));
    }
    expect(pageSizes).toEqual([2, 2, 2, 2]);
    expect(observed).toEqual(input.map((record) => record.operationId));
  });

  it('persists terminal state in a bounded bitmap and skips completed operation IDs on resume', async () => {
    const store = create();
    await store.initialize();
    const references = await appendAndCollect(
      store,
      Array.from({ length: 7 }, (_, index) => ({
        operationId: `operation-${index}`,
        payload: { sourcePath: `/source/${index}`, targetPath: `/target/${index}` },
      }))
    );
    await store.markTerminal([references[1], references[4], references[6]]);

    const resumed = create();
    await resumed.initialize();
    const pending: string[] = [];
    for await (const page of resumed.pages({ pageSize: 2 })) {
      pending.push(...page.map((record) => record.operationId));
    }
    expect(pending).toEqual(['operation-0', 'operation-2', 'operation-3', 'operation-5']);
    expect(await resumed.getSummary()).toMatchObject({ totalRecords: 7, terminalRecords: 3 });
  });

  it('fails closed when an existing plan has a different source identity or policy', async () => {
    const store = create();
    await store.initialize();
    await store.append([
      { operationId: 'one', payload: { sourcePath: '/one', targetPath: '/target/one' } },
    ]);

    await expect(create('different-source').initialize()).rejects.toMatchObject({
      code: 'IDENTITY_MISMATCH',
    });
    await expect(
      create('source-fingerprint', 'different-policy').initialize()
    ).rejects.toMatchObject({ code: 'POLICY_MISMATCH' });
  });

  it('recovers a torn final JSONL tail and repairs the atomic checkpoint', async () => {
    const store = create();
    await store.initialize();
    await store.append(
      Array.from({ length: 4 }, (_, index) => ({
        operationId: `operation-${index}`,
        payload: { sourcePath: `/source/${index}`, targetPath: `/target/${index}` },
      }))
    );
    const finalChunk = path.join(sandbox, 'chunks', 'chunk-00000001.jsonl');
    await fs.appendFile(finalChunk, '{"sequence":4,"operationId":"torn');
    await fs.writeFile(path.join(sandbox, 'checkpoint.json'), '{"torn":', 'utf8');

    const resumed = create();
    await resumed.initialize();
    const records = [];
    for await (const page of resumed.pages({ pageSize: 10, includeTerminal: true })) {
      records.push(...page);
    }
    expect(records.map((record) => record.operationId)).toEqual([
      'operation-0',
      'operation-1',
      'operation-2',
      'operation-3',
    ]);
    expect(await fs.readFile(finalChunk, 'utf8')).toMatch(/\n$/);
    expect(
      JSON.parse(await fs.readFile(path.join(sandbox, 'checkpoint.json'), 'utf8'))
    ).toMatchObject({ totalRecords: 4, terminalRecords: 0 });
  });

  it('rejects duplicate IDs, stale terminal references, and terminal records beyond the plan', async () => {
    const store = create();
    await store.initialize();
    const [reference] = await appendAndCollect(store, [
      { operationId: 'one', payload: { sourcePath: '/one', targetPath: '/target/one' } },
    ]);
    await expect(
      store.append([{ operationId: 'one', payload: { sourcePath: '/x', targetPath: '/y' } }])
    ).rejects.toBeInstanceOf(JobPlanStoreError);
    await expect(store.markTerminal([{ sequence: 0, operationId: 'wrong' }])).rejects.toMatchObject(
      {
        code: 'INVALID_TERMINAL_REFERENCE',
      }
    );
    await expect(
      store.markTerminal([{ sequence: 2, operationId: 'missing' }])
    ).rejects.toMatchObject({ code: 'INVALID_TERMINAL_REFERENCE' });
    await store.markTerminal([reference, reference]);
    expect((await store.getSummary()).terminalRecords).toBe(1);
  });

  it('poisons a live instance after a partial append and recovers safely on reinitialize', async () => {
    let fail = true;
    const store = new JobPlanStore<PlanPayload>(sandbox, {
      identity: 'source-fingerprint',
      policy: 'resolver-policy-v2',
      chunkSize: 3,
      testHooks: {
        afterPlanRecordsSynced: async () => {
          if (fail) throw new Error('injected append failure');
        },
      },
    });
    await store.initialize();
    await expect(
      store.append([{ operationId: 'durable', payload: { sourcePath: '/s', targetPath: '/t' } }])
    ).rejects.toThrow('injected append failure');
    await expect(store.getSummary()).rejects.toMatchObject({ code: 'CORRUPT_STORE' });

    fail = false;
    await store.initialize();
    expect(await store.getSummary()).toMatchObject({ totalRecords: 1, terminalRecords: 0 });
  });

  it('poisons after a partial terminal commit and reconstructs the terminal count', async () => {
    let fail = false;
    const store = new JobPlanStore<PlanPayload>(sandbox, {
      identity: 'source-fingerprint',
      policy: 'resolver-policy-v2',
      chunkSize: 3,
      testHooks: {
        afterTerminalBitmapSynced: async () => {
          if (fail) throw new Error('injected terminal failure');
        },
      },
    });
    await store.initialize();
    const [reference] = await appendAndCollect(store, [
      { operationId: 'durable', payload: { sourcePath: '/s', targetPath: '/t' } },
    ]);
    fail = true;
    await expect(store.markTerminal([reference])).rejects.toThrow('injected terminal failure');
    await expect(store.getSummary()).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
    fail = false;
    await store.initialize();
    expect(await store.getSummary()).toMatchObject({ totalRecords: 1, terminalRecords: 1 });
  });

  it('poisons when terminal checkpoint persistence fails after the bitmap is durable', async () => {
    let failCheckpoint = false;
    const store = new JobPlanStore<PlanPayload>(sandbox, {
      identity: 'source-fingerprint',
      policy: 'resolver-policy-v2',
      chunkSize: 3,
      testHooks: {
        beforeCheckpointWrite: async () => {
          if (failCheckpoint) throw new Error('injected checkpoint failure');
        },
      },
    });
    await store.initialize();
    const [reference] = await appendAndCollect(store, [
      { operationId: 'durable', payload: { sourcePath: '/s', targetPath: '/t' } },
    ]);
    failCheckpoint = true;
    await expect(store.markTerminal([reference])).rejects.toThrow('injected checkpoint failure');
    await expect(store.getSummary()).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
    failCheckpoint = false;
    await store.initialize();
    expect(await store.getSummary()).toMatchObject({ totalRecords: 1, terminalRecords: 1 });
  });

  it('repairs a valid final record missing its delimiter before a resumed append', async () => {
    const store = create();
    await store.initialize();
    await store.append([
      { operationId: 'first', payload: { sourcePath: '/s1', targetPath: '/t1' } },
    ]);
    const chunk = path.join(sandbox, 'chunks', 'chunk-00000000.jsonl');
    const contents = await fs.readFile(chunk, 'utf8');
    await fs.writeFile(chunk, contents.trimEnd(), 'utf8');

    const resumed = create();
    await resumed.initialize();
    await resumed.append([
      { operationId: 'second', payload: { sourcePath: '/s2', targetPath: '/t2' } },
    ]);
    const reopened = create();
    await reopened.initialize();
    const ids: string[] = [];
    for await (const page of reopened.pages({ includeTerminal: true })) {
      ids.push(...page.map((record) => record.operationId));
    }
    expect(ids).toEqual(['first', 'second']);
  });

  it('preserves a valid unterminated record when delimiter repair fails', async () => {
    const store = create();
    await store.initialize();
    await store.append([
      { operationId: 'first', payload: { sourcePath: '/s1', targetPath: '/t1' } },
    ]);
    const chunk = path.join(sandbox, 'chunks', 'chunk-00000000.jsonl');
    const unterminated = (await fs.readFile(chunk, 'utf8')).trimEnd();
    await fs.writeFile(chunk, unterminated, 'utf8');

    const failing = new JobPlanStore<PlanPayload>(sandbox, {
      identity: 'source-fingerprint',
      policy: 'resolver-policy-v2',
      chunkSize: 3,
      testHooks: {
        beforeTailDelimiterRepair: async () => {
          throw new Error('injected delimiter failure');
        },
      },
    });
    await expect(failing.initialize()).rejects.toThrow('injected delimiter failure');
    expect(await fs.readFile(chunk, 'utf8')).toBe(unterminated);
  });

  it('rejects an over-sized recovery line without buffering the corpus', async () => {
    const store = create();
    await store.initialize();
    await fs.writeFile(
      path.join(sandbox, 'chunks', 'chunk-00000000.jsonl'),
      `{"sequence":0,"operationId":"one","payload":"${'x'.repeat(1024 * 1024)}"}\n`
    );
    await expect(create().initialize()).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
  });
});
