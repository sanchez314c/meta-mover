import { lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  TransactionCorePort,
  TransactionalOperationExecutor,
} from '../../../src/main/services/TransactionalOperationExecutor';
import { PlannedOperation } from '../../../src/main/services/ProcessingCoordinator';
import { OperationMode } from '../../../src/shared/types/processing';
import { TransactionRequest, TransactionResult } from '../../../src/main/core/transaction';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
}

describe('TransactionalOperationExecutor', () => {
  let root: string;
  let destinationRoot: string;
  let sourcePath: string;
  let rootIdentity: { path: string; device: number; inode: number };
  let destinationIdentity: { path: string; device: number; inode: number };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-executor-unit-'));
    destinationRoot = path.join(root, 'destination');
    sourcePath = path.join(root, 'source.jpg');
    await mkdir(destinationRoot);
    const [rootStats, destinationStats] = await Promise.all([lstat(root), lstat(destinationRoot)]);
    rootIdentity = { path: root, device: rootStats.dev, inode: rootStats.ino };
    destinationIdentity = {
      path: destinationRoot,
      device: destinationStats.dev,
      inode: destinationStats.ino,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function operation(overrides: Partial<PlannedOperation> = {}): PlannedOperation {
    const targetPath =
      overrides.targetPath ?? path.join(destinationRoot, '2024', '05', 'photo.jpg');
    return {
      id: 'operation-001',
      sourcePath,
      targetPath,
      bytes: 12,
      payload: {
        destinationRoot,
        validatedRoots: {
          sourcePaths: [root],
          destinationPath: destinationRoot,
          sourceIdentities: [rootIdentity],
          destinationIdentity,
        },
        sourceIdentity: { device: 1, inode: 2, links: 1, size: 12 },
        modifiedTimeMs: 1234,
        contentSha256: 'a'.repeat(64),
        destinationSnapshot: {
          path: targetPath,
          occupied: false,
          source: 'filesystem',
        },
      },
      ...overrides,
      targetPath,
    };
  }

  function result(overrides: Partial<TransactionResult> = {}): TransactionResult {
    return {
      operationId: 'operation-001',
      sourcePath,
      destinationPath: path.join(destinationRoot, '2024', '05', 'photo.jpg'),
      status: 'copied',
      committed: true,
      sourceRetained: true,
      hash: 'a'.repeat(64),
      bytes: 12,
      ...overrides,
    };
  }

  function context(mode = OperationMode.COPY) {
    return {
      jobId: 'job-1',
      previewId: 'preview-1',
      mode,
      signal: new AbortController().signal,
    };
  }

  it('serializes and caches one core per canonical destination root', async () => {
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    const factoryBarrier = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const core: TransactionCorePort = {
      execute: jest.fn(async (request) =>
        result({
          operationId: request.operationId,
          destinationPath: request.expectedDestinationPath,
        })
      ),
      close: jest.fn(async () => undefined),
    };
    const executor = new TransactionalOperationExecutor({
      coreFactory: async () => {
        factoryCalls += 1;
        await factoryBarrier;
        return core;
      },
    });

    const first = executor.execute(operation(), context());
    const second = executor.execute(
      operation({ id: 'operation-002', targetPath: path.join(destinationRoot, 'other.jpg') }),
      context()
    );
    await waitUntil(() => factoryCalls === 1);
    expect(factoryCalls).toBe(1);
    releaseFactory();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(core.execute).toHaveBeenCalledTimes(2);
    await executor.close();
  });

  it('rejects a changed source-root capability set for an already cached destination core', async () => {
    const core: TransactionCorePort = {
      execute: jest.fn(async (request) =>
        result({
          operationId: request.operationId,
          destinationPath: request.expectedDestinationPath,
        })
      ),
      close: jest.fn(async () => undefined),
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });
    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      outcome: 'committed',
    });

    const additionalRoot = path.join(root, 'additional-source-root');
    await mkdir(additionalRoot);
    const additionalStats = await lstat(additionalRoot);
    const planned = operation({ id: 'operation-with-expanded-roots' });
    const payload = planned.payload as Record<string, unknown>;
    const validatedRoots = payload.validatedRoots as Record<string, unknown>;
    const expanded = {
      ...planned,
      payload: {
        ...payload,
        validatedRoots: {
          ...validatedRoots,
          sourcePaths: [root, additionalRoot],
          sourceIdentities: [
            rootIdentity,
            {
              path: additionalRoot,
              device: additionalStats.dev,
              inode: additionalStats.ino,
            },
          ],
        },
      },
    };

    await expect(executor.execute(expanded, context())).rejects.toThrow(
      /different source-root set/i
    );
    expect(core.execute).toHaveBeenCalledTimes(1);
    await executor.close();
    expect(core.close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed non-object payloads before native admission', async () => {
    const executor = new TransactionalOperationExecutor({
      coreFactory: jest.fn<Promise<TransactionCorePort>, [string]>(),
    });
    const invalid = { ...operation(), payload: null } as unknown as PlannedOperation;

    await expect(executor.execute(invalid, context())).rejects.toThrow(/plain object/i);
    await executor.close();
  });

  it('rejects a signal already cancelled before parsing or native admission', async () => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute(operation(), { ...context(), signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('requires a native helper factory when constructed with production defaults', async () => {
    const executor = new TransactionalOperationExecutor();

    await expect(executor.execute(operation(), context())).rejects.toThrow(
      /native filesystem helper factory/i
    );
    await executor.close();
  });

  it.each([
    ['outside target', () => operation({ targetPath: path.join(root, 'outside.jpg') })],
    [
      'control target',
      () => operation({ targetPath: path.join(destinationRoot, '.meta-mover', 'bad.jpg') }),
    ],
    [
      'snapshot mismatch',
      () => {
        const planned = operation();
        return {
          ...planned,
          payload: {
            ...(planned.payload as Record<string, unknown>),
            destinationSnapshot: {
              path: path.join(destinationRoot, 'different.jpg'),
              occupied: false,
              source: 'filesystem',
            },
          },
        };
      },
    ],
  ])('rejects an invalid %s before opening a core', async (_label, buildOperation) => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(buildOperation(), context())).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it.each([
    ['relative destination root', { destinationRoot: 'relative-destination' }],
    ['negative source device', { sourceIdentity: { device: -1, inode: 2, links: 1, size: 12 } }],
    ['non-finite modified time', { modifiedTimeMs: Number.NaN }],
    ['uppercase content hash', { contentSha256: 'A'.repeat(64) }],
    [
      'unknown snapshot source',
      {
        destinationSnapshot: {
          path: '/invalid-snapshot-source',
          occupied: false,
          source: 'unknown',
        },
      },
    ],
  ])('rejects payload evidence with %s', async (_label, payloadOverride) => {
    const planned = operation();
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        {
          ...planned,
          payload: { ...(planned.payload as Record<string, unknown>), ...payloadOverride },
        },
        context()
      )
    ).rejects.toThrow(/invalid preview evidence/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it.each([
    [
      'destination root identity drift',
      () => {
        const planned = operation();
        const payload = planned.payload as Record<string, unknown>;
        const validatedRoots = payload.validatedRoots as Record<string, unknown>;
        return {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              destinationIdentity: { ...destinationIdentity, inode: destinationIdentity.inode + 1 },
            },
          },
        };
      },
    ],
    [
      'source root identity drift',
      () => {
        const planned = operation();
        const payload = planned.payload as Record<string, unknown>;
        const validatedRoots = payload.validatedRoots as Record<string, unknown>;
        return {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              sourceIdentities: [{ ...rootIdentity, device: rootIdentity.device + 1 }],
            },
          },
        };
      },
    ],
  ])('rejects %s before transaction-core admission', async (_label, buildOperation) => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(buildOperation(), context())).rejects.toThrow(/root identity/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a source outside every validated source root before core admission', async () => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        operation({ sourcePath: path.join(path.dirname(root), 'outside.jpg') }),
        context()
      )
    ).rejects.toThrow(/outside.*source root/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a noncanonical validated root identity path before core admission', async () => {
    const planned = operation();
    const payload = planned.payload as Record<string, unknown>;
    const validatedRoots = payload.validatedRoots as Record<string, unknown>;
    const noncanonicalRoot = `${root}${path.sep}.`;
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              sourcePaths: [noncanonicalRoot],
              sourceIdentities: [{ ...rootIdentity, path: noncanonicalRoot }],
            },
          },
        },
        context()
      )
    ).rejects.toThrow(/not canonical/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a non-normalized exact target before core admission', async () => {
    const rawTarget = `${destinationRoot}${path.sep}2024${path.sep}..${path.sep}photo.jpg`;
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(operation({ targetPath: rawTarget }), context())).rejects.toThrow(
      /canonical and normalized/i
    );
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a validated source root identity that is not a directory', async () => {
    await writeFile(sourcePath, 'not-a-root-directory');
    const stats = await lstat(sourcePath);
    const planned = operation();
    const payload = planned.payload as Record<string, unknown>;
    const validatedRoots = payload.validatedRoots as Record<string, unknown>;
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              sourcePaths: [sourcePath],
              sourceIdentities: [{ path: sourcePath, device: stats.dev, inode: stats.ino }],
            },
          },
        },
        context()
      )
    ).rejects.toThrow(/non-symlink directory/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('evicts a rejected core creation so a later admission can retry', async () => {
    const core: TransactionCorePort = {
      execute: async () => result(),
      close: async () => undefined,
    };
    let attempt = 0;
    const factory = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('core creation failed');
      return core;
    });
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(operation(), context())).rejects.toThrow(/creation failed/i);
    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      outcome: 'committed',
    });
    expect(factory).toHaveBeenCalledTimes(2);
    await executor.close();
  });

  it.each([
    ['copied', true, 'committed', 12],
    ['moved', true, 'committed', 12],
    ['duplicate', true, 'skipped', 0],
    ['cancelled', true, 'committed', 12],
    ['failed', true, 'committed', 12],
    ['failed', false, 'failed', 0],
  ] as const)('maps %s committed=%s to %s', async (status, committed, outcome, bytes) => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status,
          committed,
          ...(status === 'failed' ? { error: 'post-commit verification failed' } : {}),
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      operationId: 'operation-001',
      outcome,
      bytes,
    });
    await executor.close();
  });

  it('returns an exact source-retained outcome for precommit cancellation', async () => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({ status: 'cancelled', committed: false, destinationPath: undefined }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context())).resolves.toEqual({
      operationId: 'operation-001',
      outcome: 'cancelled',
      bytes: 0,
      cancellationState: 'cancelled-before-commit',
      sourceRetained: true,
      destinationCommitted: false,
      error: 'Transaction cancelled before commit',
    });
    await executor.close();
  });

  it('reports a committed cancelled Move as destination residue with the source retained', async () => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status: 'cancelled',
          committed: true,
          sourceRetained: true,
          error: 'operator cancelled after destination commit',
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context(OperationMode.MOVE))).resolves.toEqual({
      operationId: 'operation-001',
      outcome: 'cancelled',
      bytes: 12,
      cancellationState: 'destination-committed-source-retained',
      sourceRetained: true,
      destinationCommitted: true,
      error: 'operator cancelled after destination commit',
    });
    await executor.close();
  });

  it('preserves a zero-byte post-commit Move cancellation as committed destination residue', async () => {
    const planned = operation({ bytes: 0 });
    planned.payload = {
      ...(planned.payload as Record<string, unknown>),
      sourceIdentity: { device: 1, inode: 2, links: 1, size: 0 },
    };
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status: 'cancelled',
          committed: true,
          sourceRetained: true,
          bytes: 0,
          error: 'cancelled after zero-byte destination commit',
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(planned, context(OperationMode.MOVE))).resolves.toMatchObject({
      outcome: 'cancelled',
      bytes: 0,
      cancellationState: 'destination-committed-source-retained',
      destinationCommitted: true,
      sourceRetained: true,
    });
    await executor.close();
  });

  it('does not report a failed partial Move with retained source as successful', async () => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status: 'failed',
          committed: true,
          sourceRetained: true,
          error: 'move did not reach its requested terminal state',
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context(OperationMode.MOVE))).resolves.toEqual({
      operationId: 'operation-001',
      outcome: 'failed',
      bytes: 12,
      sourceRetained: true,
      destinationCommitted: true,
      error: 'move did not reach its requested terminal state',
    });
    await executor.close();
  });

  it('uses deterministic fallback errors for incomplete failed core results', async () => {
    const core: TransactionCorePort = {
      execute: jest
        .fn<Promise<TransactionResult>, [TransactionRequest]>()
        .mockResolvedValueOnce(
          result({ status: 'failed', committed: true, sourceRetained: true, error: undefined })
        )
        .mockResolvedValueOnce(
          result({
            status: 'failed',
            committed: false,
            destinationPath: undefined,
            error: undefined,
          })
        ),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context(OperationMode.MOVE))).resolves.toMatchObject(
      {
        outcome: 'failed',
        error: 'Move committed bytes but did not complete source transfer',
      }
    );
    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      outcome: 'failed',
      error: 'Transaction failed before commit',
    });
    await executor.close();
  });

  it.each([
    ['operation ID', { operationId: 'different-operation' }],
    ['content hash', { hash: 'b'.repeat(64) }],
    ['byte count', { bytes: 13 }],
    ['committed destination', { destinationPath: path.join(tmpdir(), 'wrong-destination.jpg') }],
  ])('rejects a core result that diverges in %s', async (_label, resultOverride) => {
    const core: TransactionCorePort = {
      execute: async () => result(resultOverride),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context())).rejects.toThrow(/diverges/i);
    await executor.close();
  });

  it('waits for admitted work and closes cached cores exactly once', async () => {
    let releaseExecution!: () => void;
    const executionBarrier = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const core: TransactionCorePort = {
      execute: jest.fn(async () => {
        await executionBarrier;
        return result();
      }),
      close: jest.fn(async () => undefined),
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });
    const execution = executor.execute(operation(), context());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstClose = executor.close();
    const secondClose = executor.close();
    expect(core.close).not.toHaveBeenCalled();
    await expect(executor.execute(operation(), context())).rejects.toThrow(/closed|closing/i);
    releaseExecution();

    await execution;
    await Promise.all([firstClose, secondClose]);
    expect(core.close).toHaveBeenCalledTimes(1);
  });
});
