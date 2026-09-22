import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { ReviewOverrideStore } from '../../../src/main/services/ReviewOverrideStore';
import type { ReviewOverrideRecord } from '../../../src/shared/types/review';

const hash = (character: string) => character.repeat(64);
function record(
  key = hash('a'),
  sequence = 1,
  status: 'kept' | 'failed' = 'kept'
): ReviewOverrideRecord {
  const jobId = `job-${key}`;
  const previewId = 'preview-1';
  const rowIndex = 0;
  const output = {
    path: '/output/photo.jpg',
    device: 1,
    inode: 2,
    size: 3,
    modifiedTimeMs: 4,
    mtimeNs: '4000000',
    sha256: hash('b'),
  };
  const reviewId = createHash('sha256')
    .update(`${jobId}\0${previewId}\0${rowIndex}\0${output.path}\0${output.sha256}`)
    .digest('hex');
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    reviewId,
    sequence,
    recordedAt: '2026-09-22T12:00:00.000Z',
    jobId,
    previewId,
    rowIndex,
    output,
    evidenceRevision: hash('c'),
    action: { type: 'keep' },
    result:
      status === 'kept'
        ? { status: 'kept', currentPath: '/output/photo.jpg' }
        : { status: 'failed', currentPath: '/output/photo.jpg', error: 'failed' },
  };
}

describe('ReviewOverrideStore', () => {
  let root: string;
  let storePath: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-review-overrides-'));
    storePath = path.join(root, 'private', 'review-overrides.jsonl');
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it('creates private durable storage and replays the latest record per review', async () => {
    const store = await ReviewOverrideStore.open(storePath);
    await store.append(record());
    await store.append(record(hash('a'), 2, 'failed'));
    await store.append(record(hash('d')));
    expect((await store.list()).map((entry) => entry.sequence)).toEqual([2, 1]);
    await store.close();
    expect((await fs.stat(path.dirname(storePath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
    const reopened = await ReviewOverrideStore.open(storePath);
    await expect(reopened.get(record(hash('a')).reviewId)).resolves.toMatchObject({ sequence: 2 });
    await reopened.close();
  });

  it('enforces one live owner and reclaims a dead lock', async () => {
    const first = await ReviewOverrideStore.open(storePath);
    await expect(ReviewOverrideStore.open(storePath)).rejects.toMatchObject({
      code: 'STORE_LOCKED',
    });
    await first.close();
    await fs.writeFile(`${storePath}.lock`, `${JSON.stringify({ pid: 2147483647 })}\n`, {
      mode: 0o600,
    });
    const reclaimed = await ReviewOverrideStore.open(storePath);
    await reclaimed.close();
  });

  it('repairs only an invalid partial trailing record', async () => {
    const first = await ReviewOverrideStore.open(storePath);
    await first.append(record());
    await first.close();
    await fs.appendFile(storePath, '{"schemaVersion":1');
    const repaired = await ReviewOverrideStore.open(storePath);
    await expect(repaired.get(record(hash('a')).reviewId)).resolves.toMatchObject({ sequence: 1 });
    await repaired.close();
    expect((await fs.readFile(storePath, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('poisons a complete non-newline append because durability is ambiguous', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(storePath, JSON.stringify(record()), { mode: 0o600 });
    await expect(ReviewOverrideStore.open(storePath)).rejects.toMatchObject({
      code: 'STORE_POISONED',
    });
  });

  it('poisons malformed middle records and non-monotonic replay', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(storePath, `${JSON.stringify(record())}\nnot-json\n`, { mode: 0o600 });
    await expect(ReviewOverrideStore.open(storePath)).rejects.toMatchObject({
      code: 'CORRUPT_STORE',
      line: 2,
    });
    await fs.writeFile(
      storePath,
      `${JSON.stringify(record())}\n${JSON.stringify(record(hash('a'), 3))}\n`,
      { mode: 0o600 }
    );
    await expect(ReviewOverrideStore.open(storePath)).rejects.toMatchObject({
      code: 'CORRUPT_STORE',
      line: 2,
    });
  });

  it('rejects invalid and non-monotonic appends without changing durable bytes', async () => {
    const store = await ReviewOverrideStore.open(storePath);
    await store.append(record());
    const before = await fs.readFile(storePath);
    await expect(store.append(record(hash('a'), 3))).rejects.toMatchObject({
      code: 'SEQUENCE_REJECTED',
    });
    await expect(
      store.append({ ...record(hash('d')), secret: true } as ReviewOverrideRecord)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await fs.readFile(storePath)).toEqual(before);
    await store.close();
  });

  it('reconciles an append when the first durability sync is ambiguous', async () => {
    const store = await ReviewOverrideStore.open(storePath, {
      testHooks: {
        beforeSync: async () => {
          throw new Error('injected fsync failure');
        },
      },
    });
    await expect(store.append(record())).resolves.toMatchObject({ sequence: 1 });
    await expect(store.list()).resolves.toHaveLength(1);
    await store.close();
  });

  it('rejects symlink and multiply linked store leaves', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, '', { mode: 0o600 });
    await fs.symlink(outside, storePath);
    await expect(ReviewOverrideStore.open(storePath)).rejects.toBeDefined();
    await fs.unlink(storePath);
    await fs.link(outside, storePath);
    await expect(ReviewOverrideStore.open(storePath)).rejects.toMatchObject({
      code: 'UNSAFE_STORE_PATH',
    });
  });

  it('drains an admitted append before close and rejects only later admissions', async () => {
    let reached!: () => void;
    let release!: () => void;
    const barrierReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = await ReviewOverrideStore.open(storePath, {
      testHooks: {
        beforeSync: async () => {
          reached();
          await barrier;
        },
      },
    });
    const admitted = store.append(record());
    await barrierReached;
    let closeSettled = false;
    const closing = store.close().finally(() => {
      closeSettled = true;
    });
    await expect(store.append(record(hash('d')))).rejects.toMatchObject({ code: 'STORE_CLOSED' });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    release();
    await expect(admitted).resolves.toMatchObject({ sequence: 1 });
    await expect(closing).resolves.toBeUndefined();
    const reopened = await ReviewOverrideStore.open(storePath);
    await expect(reopened.list()).resolves.toHaveLength(1);
    await reopened.close();
  });

  it.each(['get', 'list'] as const)(
    'poisons %s after external append changes the durable size',
    async (operation) => {
      const store = await ReviewOverrideStore.open(storePath);
      await store.append(record());
      await fs.appendFile(storePath, '{}\n');
      const read = operation === 'get' ? store.get(record().reviewId) : store.list();
      await expect(read).rejects.toMatchObject({ code: 'STORE_POISONED' });
      await expect(store.list()).rejects.toMatchObject({ code: 'STORE_POISONED' });
      await store.close();
    }
  );

  it.each(['get', 'list'] as const)(
    'rejects and poisons %s after the held store pathname is replaced',
    async (operation) => {
      const store = await ReviewOverrideStore.open(storePath);
      await store.append(record());
      await fs.rename(storePath, `${storePath}.old`);
      await fs.writeFile(storePath, '', { mode: 0o600 });
      const read = operation === 'get' ? store.get(record().reviewId) : store.list();
      await expect(read).rejects.toMatchObject({ code: 'UNSAFE_STORE_PATH' });
      await expect(store.list()).rejects.toMatchObject({ code: 'STORE_POISONED' });
      await store.close();
    }
  );

  it.each(['get', 'list'] as const)(
    'poisons %s after external truncation changes the durable size',
    async (operation) => {
      const store = await ReviewOverrideStore.open(storePath);
      await store.append(record());
      await fs.truncate(storePath, 0);
      const read = operation === 'get' ? store.get(record().reviewId) : store.list();
      await expect(read).rejects.toMatchObject({ code: 'STORE_POISONED' });
      await store.close();
    }
  );
});
