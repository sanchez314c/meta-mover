import {
  appendFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  closeFileHandlePreservingError,
  copyFileToStaging,
  copyHandleToStaging,
  hashFile,
} from '../../../src/main/core/transaction/Hashing';
import {
  TransactionJournal,
  TransactionJournalOptions,
} from '../../../src/main/core/transaction/TransactionJournal';
import * as transaction from '../../../src/main/core/transaction';

describe('transaction hashing and journal primitives', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-transaction-unit-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('streams a source into staging while producing an independently reproducible hash', async () => {
    const source = path.join(root, 'source.bin');
    const staging = path.join(root, 'staging.part');
    const content = Buffer.concat([
      Buffer.from('header'),
      Buffer.alloc(1024 * 1024, 0x5a),
      Buffer.from('footer'),
    ]);
    await writeFile(source, content);

    const streamed = await copyFileToStaging(source, staging);

    expect(streamed.bytes).toBe(content.length);
    expect(streamed.hash).toBe(await hashFile(source));
    expect(await hashFile(staging)).toBe(streamed.hash);
    expect(await readFile(staging)).toEqual(content);
  });

  it('aborts hashing before reading and permits explicitly nondurable staging copies', async () => {
    const source = path.join(root, 'source.bin');
    const staging = path.join(root, 'staging.part');
    await writeFile(source, 'content');
    const controller = new AbortController();
    controller.abort();

    await expect(hashFile(source, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(copyFileToStaging(source, staging, undefined, false)).resolves.toMatchObject({
      bytes: 7,
    });
    expect(transaction.TransactionalFileCore).toBeDefined();
  });

  it('uses durable staging by default when copying from an already-open source', async () => {
    const sourcePath = path.join(root, 'source-handle.bin');
    const stagingPath = path.join(root, 'staging-handle.part');
    await writeFile(sourcePath, 'handle-content');
    const source = await open(sourcePath, 'r');

    try {
      await expect(copyHandleToStaging(source, stagingPath)).resolves.toEqual({
        bytes: 14,
        hash: await hashFile(sourcePath),
      });
      await expect(readFile(stagingPath, 'utf8')).resolves.toBe('handle-content');
    } finally {
      await source.close();
    }
  });

  it('preserves simultaneous hashing and file-close failures', async () => {
    const operationError = new Error('hashing failed');
    const closeError = new Error('close failed');

    await expect(
      closeFileHandlePreservingError(
        { close: async () => Promise.reject(closeError) },
        operationError
      )
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [operationError, closeError],
    });

    await expect(
      closeFileHandlePreservingError({ close: async () => Promise.reject(closeError) })
    ).rejects.toBe(closeError);
    await expect(
      closeFileHandlePreservingError({ close: async () => Promise.resolve() })
    ).resolves.toBeUndefined();
  });

  it('preserves cancellation while closing both staging handles', async () => {
    const source = path.join(root, 'cancelled-source.bin');
    const staging = path.join(root, 'cancelled-staging.part');
    await writeFile(source, 'content');
    const controller = new AbortController();
    controller.abort();

    await expect(copyFileToStaging(source, staging, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('derives terminal outcomes from durable records rather than mutable counters', async () => {
    const journal = await TransactionJournal.open(path.join(root, 'journal.jsonl'));
    await journal.append({ operationId: 'copy-1', state: 'planned', mode: 'copy' });
    await journal.append({ operationId: 'copy-1', state: 'committed', mode: 'copy' });
    await journal.append({ operationId: 'copy-1', state: 'completed', mode: 'copy' });
    await journal.append({ operationId: 'move-1', state: 'planned', mode: 'move' });
    await journal.append({
      operationId: 'move-1',
      state: 'failed',
      mode: 'move',
      error: 'injected',
    });
    await journal.append({ operationId: 'move-2', state: 'completed', mode: 'move' });
    await journal.append({ operationId: 'duplicate-1', state: 'duplicate', mode: 'copy' });
    await journal.append({ operationId: 'cancel-1', state: 'cancelled', mode: 'copy' });
    await journal.append({
      operationId: 'retained-1',
      state: 'failed',
      mode: 'move',
      committed: true,
      sourceRetained: true,
    });
    await journal.append({
      operationId: 'cancel-retained-1',
      state: 'cancelled',
      mode: 'move',
      committed: true,
      sourceRetained: true,
    });
    await journal.append({ operationId: 'pending-1', state: 'verified', mode: 'copy' });

    expect(await journal.deriveOutcomes()).toEqual({
      completed: 1,
      moved: 1,
      duplicate: 1,
      cancelled: 1,
      failed: 1,
      committedSourceRetained: 2,
      nonterminal: 1,
      total: 8,
    });
    await journal.close();
    await journal.close();
  });

  it('persists source delete intent and receipt before accepting a terminal source deletion', async () => {
    const journalPath = path.join(root, 'delete-intent.jsonl');
    const journal = await TransactionJournal.open(journalPath);
    const sourceDeleteId = '00000000-0000-4000-8000-000000000031';
    const sourceDeleteReceiptPath = path.join(root, 'delete-receipts', `${sourceDeleteId}.json`);

    await journal.append({
      operationId: 'move-with-delete-intent',
      state: 'source-delete-pending',
      mode: 'move',
      sourceDeleteId,
      sourceDeleteReceiptPath,
      committed: true,
    });
    await journal.append({
      operationId: 'move-with-delete-intent',
      state: 'source-deleted',
      mode: 'move',
      sourceDeleteId,
      sourceDeleteReceiptPath,
      sourceDeleteReceiptState: 'created',
      committed: true,
    });
    await journal.close();

    const records = (await readFile(journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ sourceDeleteId, sourceDeleteReceiptPath });
    expect(records[1]).toMatchObject({
      sourceDeleteId,
      sourceDeleteReceiptPath,
      sourceDeleteReceiptState: 'created',
    });
  });

  it('serializes sequence numbers across concurrent journal instances', async () => {
    const journalPath = path.join(root, 'shared.jsonl');
    const first = await TransactionJournal.open(journalPath, false);
    const second = await TransactionJournal.open(journalPath, false);

    await Promise.all([
      first.append({ operationId: 'first', state: 'planned', mode: 'copy' }),
      second.append({ operationId: 'second', state: 'planned', mode: 'copy' }),
    ]);

    const sequences = (await first.readRecords()).map((record) => record.sequence);
    expect(sequences).toHaveLength(2);
    expect(new Set(sequences).size).toBe(2);
    await Promise.all([first.close(), second.close()]);
  });

  it('repairs a peer-grown durable tail before appending the next sequence', async () => {
    const journalPath = path.join(root, 'peer-grown.jsonl');
    const first = await TransactionJournal.open(journalPath);
    const second = await TransactionJournal.open(journalPath);

    await second.append({ operationId: 'peer', state: 'planned', mode: 'copy' });
    await first.append({ operationId: 'local', state: 'completed', mode: 'copy' });

    expect((await first.readRecords()).map((record) => record.sequence)).toEqual([1, 2]);
    await Promise.all([first.close(), second.close()]);
  });

  it('repairs a torn final record without accepting interior journal corruption', async () => {
    const journalPath = path.join(root, 'torn.jsonl');
    const journal = await TransactionJournal.open(journalPath, false);
    await journal.append({ operationId: 'valid', state: 'planned', mode: 'copy' });
    await journal.close();
    await appendFile(journalPath, '{"operationId":"torn"', 'utf8');

    const reopened = await TransactionJournal.open(journalPath, false);

    expect(await reopened.readRecords()).toHaveLength(1);
    await reopened.close();
  });

  it('repairs a journal containing only one torn record to an empty valid prefix', async () => {
    const journalPath = path.join(root, 'single-torn.jsonl');
    await writeFile(journalPath, '{"operationId":"torn"');

    const journal = await TransactionJournal.open(journalPath);

    expect(await journal.readRecords()).toEqual([]);
    expect(await readFile(journalPath, 'utf8')).toBe('');
    await journal.close();
  });

  it('rejects interior corruption and append attempts after close', async () => {
    const closedPath = path.join(root, 'closed.jsonl');
    const closed = await TransactionJournal.open(closedPath, false);
    await closed.close();
    await expect(
      closed.append({ operationId: 'closed', state: 'planned', mode: 'copy' })
    ).rejects.toThrow(/closed/i);

    const corruptPath = path.join(root, 'corrupt.jsonl');
    await writeFile(
      corruptPath,
      '{"operationId":"first","state":"planned","mode":"copy","sequence":1}\n' +
        '{not-json}\n' +
        '{"operationId":"last","state":"planned","mode":"copy","sequence":2}\n'
    );
    await expect(TransactionJournal.open(corruptPath)).rejects.toThrow(/interior/i);
  });

  it('rejects symlinked journal control files without touching their targets', async () => {
    const journalPath = path.join(root, 'controlled.jsonl');
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    const outsideSequence = path.join(outside, 'sequence');
    await writeFile(outsideSequence, '41');
    await symlink(outsideSequence, `${journalPath}.sequence`);

    await expect(TransactionJournal.open(journalPath)).rejects.toThrow(/symbolic link/i);
    expect(await readFile(outsideSequence, 'utf8')).toBe('41');
  });

  it('rejects a sequence symlink introduced after journal open without mutating its target', async () => {
    const journalPath = path.join(root, 'late-controlled.jsonl');
    const outsideSequence = path.join(root, 'late-outside-sequence');
    const journal = await TransactionJournal.open(journalPath);
    await writeFile(outsideSequence, '700');
    await symlink(outsideSequence, `${journalPath}.sequence`);

    await expect(
      journal.append({ operationId: 'blocked', state: 'planned', mode: 'copy' })
    ).rejects.toThrow();
    expect(await readFile(outsideSequence, 'utf8')).toBe('700');
    await journal.close();
  });

  it('derives sequence from journal history after a regular sequence-file rollback', async () => {
    const journalPath = path.join(root, 'sequence-rollback.jsonl');
    const journal = await TransactionJournal.open(journalPath);
    await journal.append({ operationId: 'first', state: 'planned', mode: 'copy' });
    await writeFile(`${journalPath}.sequence`, '0');

    await journal.append({ operationId: 'second', state: 'planned', mode: 'copy' });

    expect((await journal.readRecords()).map((record) => record.sequence)).toEqual([1, 2]);
    await journal.close();
  });

  it('never truncates an outside inode hardlinked over the sequence path', async () => {
    const journalPath = path.join(root, 'sequence-hardlink.jsonl');
    const outsideSequence = path.join(root, 'outside-hardlink-sequence');
    const journal = await TransactionJournal.open(journalPath);
    await writeFile(outsideSequence, '700');
    await unlink(`${journalPath}.sequence`).catch(() => undefined);
    await link(outsideSequence, `${journalPath}.sequence`);

    await expect(
      journal.append({ operationId: 'blocked', state: 'planned', mode: 'copy' })
    ).rejects.toThrow(/link|regular|control/i);
    expect(await readFile(outsideSequence, 'utf8')).toBe('700');
    await journal.close();
  });

  it('rejects a journal path that is not a regular file', async () => {
    const journalPath = path.join(root, 'journal-directory');
    await mkdir(journalPath);

    await expect(TransactionJournal.open(journalPath)).rejects.toThrow(/regular non-symlink/i);
  });

  it('rejects a hardlinked journal inode without modifying the other name', async () => {
    const journalPath = path.join(root, 'hardlinked-journal.jsonl');
    const outsidePath = path.join(root, 'outside-hardlink.txt');
    await writeFile(outsidePath, 'DO-NOT-MUTATE');
    await link(outsidePath, journalPath);

    await expect(TransactionJournal.open(journalPath)).rejects.toThrow(/link|regular/i);
    expect(await readFile(outsidePath, 'utf8')).toBe('DO-NOT-MUTATE');
  });

  it('reclaims a stale journal lock and repairs a lagging durable sequence', async () => {
    const journalPath = path.join(root, 'recover-lock.jsonl');
    await writeFile(
      journalPath,
      '{"operationId":"existing","state":"planned","mode":"copy","sequence":9}\n'
    );
    await writeFile(`${journalPath}.sequence`, '2');
    await writeFile(`${journalPath}.lock`, '{}');
    const stale = new Date(Date.now() - 60_000);
    await utimes(`${journalPath}.lock`, stale, stale);

    const journal = await TransactionJournal.open(journalPath);
    await journal.append({ operationId: 'next', state: 'planned', mode: 'copy' });
    const records = await journal.readRecords();

    expect(records.map((record) => record.sequence)).toEqual([9, 10]);
    await journal.close();
  });

  it('does not steal a stale lock owned by a live process', async () => {
    const journalPath = path.join(root, 'live-stale-lock.jsonl');
    const lockPath = `${journalPath}.lock`;
    await writeFile(journalPath, '');
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }));
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    let observedProbe!: () => void;
    const probeObserved = new Promise<void>((resolve) => {
      observedProbe = resolve;
    });
    const originalKill = process.kill;
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
      if (pid === process.pid && signal === 0) observedProbe();
      return originalKill(pid, signal);
    }) as typeof process.kill);
    const opening = TransactionJournal.open(journalPath);
    await probeObserved;
    expect(await readFile(lockPath, 'utf8')).toContain(process.pid.toString());
    await unlink(lockPath);
    const journal = await opening;

    await journal.close();
    killSpy.mockRestore();
  });

  it('preserves the valid journal prefix when repair is interrupted after truncation', async () => {
    const journalPath = path.join(root, 'repair-crash.jsonl');
    const valid = '{"operationId":"valid","state":"planned","mode":"copy","sequence":1}\n';
    await writeFile(journalPath, `${valid}{"operationId":"torn"`);
    const probe = await open(path.join(root, 'prototype-probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as {
      truncate: (size?: number) => Promise<void>;
    };
    await probe.close();
    const originalTruncate = prototype.truncate;
    const truncateSpy = jest.spyOn(prototype, 'truncate').mockImplementation(async function (
      this: unknown,
      size?: number
    ) {
      await originalTruncate.call(this, size);
      throw new Error('simulated power loss after truncate');
    });

    await expect(TransactionJournal.open(journalPath)).rejects.toThrow(/power loss/i);
    truncateSpy.mockRestore();

    expect(await readFile(journalPath, 'utf8')).toBe(valid);
  });

  it('preserves blank lines inside the valid journal prefix when torn-tail repair crashes', async () => {
    const journalPath = path.join(root, 'repair-blank-lines-crash.jsonl');
    const first = '{"operationId":"first","state":"planned","mode":"copy","sequence":1}\n';
    const blankLines = '\n\n\n\n';
    const second = '{"operationId":"second","state":"completed","mode":"copy","sequence":2}\n';
    const validPrefix = `${first}${blankLines}${second}`;
    await writeFile(journalPath, `${validPrefix}{"operationId":"torn"`);
    const probe = await open(path.join(root, 'blank-prefix-prototype-probe'), 'w');
    const prototype = Object.getPrototypeOf(probe) as {
      truncate: (size?: number) => Promise<void>;
    };
    await probe.close();
    const originalTruncate = prototype.truncate;
    const truncateSpy = jest.spyOn(prototype, 'truncate').mockImplementation(async function (
      this: unknown,
      size?: number
    ) {
      await originalTruncate.call(this, size);
      throw new Error('simulated power loss after blank-prefix truncate');
    });

    await expect(TransactionJournal.open(journalPath)).rejects.toThrow(/power loss/i);
    truncateSpy.mockRestore();

    expect(await readFile(journalPath, 'utf8')).toBe(validPrefix);
  });

  it('keeps a live journal lock publisher valid when a contender repairs its candidate alias', async () => {
    const journalPath = path.join(root, 'journal-live-publication.jsonl');
    let publisherBlocked!: () => void;
    const publisherReached = new Promise<void>((resolve) => {
      publisherBlocked = resolve;
    });
    let firstCandidateRelease!: () => void;
    const firstCandidateBlocked = new Promise<void>((resolve) => {
      firstCandidateRelease = resolve;
    });
    let candidatePath: string | undefined;
    type OpenWithBarrier = (
      filePath: string,
      durable: boolean,
      options: {
        afterLockPublished: (context: { candidatePath: string }) => Promise<void>;
      }
    ) => Promise<TransactionJournal>;
    const firstOpening = (TransactionJournal.open as unknown as OpenWithBarrier).call(
      TransactionJournal,
      journalPath,
      true,
      {
        afterLockPublished: async (context) => {
          candidatePath = context.candidatePath;
          publisherBlocked();
          await firstCandidateBlocked;
        },
      }
    );
    const observedInTime = await Promise.race([
      publisherReached.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!observedInTime) {
      const unexpectedlyOpened = await firstOpening;
      await unexpectedlyOpened.close();
    }
    expect(observedInTime).toBe(true);

    const secondOpening = TransactionJournal.open(journalPath);
    const aliasRemoved = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          candidatePath &&
          !(await lstat(candidatePath)
            .then(() => true)
            .catch(() => false))
        ) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return false;
    })();
    firstCandidateRelease();
    const [first, second] = await Promise.all([firstOpening, secondOpening]);

    expect(aliasRemoved).toBe(true);
    await first.close();
    await second.close();
  });

  it('cleans a vanished lock candidate when publication instrumentation fails', async () => {
    const journalPath = path.join(root, 'publication-hook-failure.jsonl');
    type OpenWithFailureHook = (
      filePath: string,
      durable: boolean,
      options: {
        afterLockPublished: (context: { candidatePath: string }) => Promise<void>;
      }
    ) => Promise<TransactionJournal>;

    await expect(
      (TransactionJournal.open as unknown as OpenWithFailureHook).call(
        TransactionJournal,
        journalPath,
        true,
        {
          afterLockPublished: async ({ candidatePath }) => {
            await unlink(candidatePath);
            throw new Error('injected publication instrumentation failure');
          },
        }
      )
    ).rejects.toThrow(/instrumentation failure/i);

    await expect(lstat(`${journalPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a published lock after instrumentation removes only its candidate alias', async () => {
    const journalPath = path.join(root, 'candidate-alias-gone.jsonl');
    type OpenWithAliasHook = (
      filePath: string,
      durable: boolean,
      options: {
        afterLockPublished: (context: { candidatePath: string }) => Promise<void>;
      }
    ) => Promise<TransactionJournal>;

    const journal = await (TransactionJournal.open as unknown as OpenWithAliasHook).call(
      TransactionJournal,
      journalPath,
      true,
      { afterLockPublished: async ({ candidatePath }) => unlink(candidatePath) }
    );

    await journal.close();
  });

  it('rejects publication when the retained lock identity changes after alias removal', async () => {
    const journalPath = path.join(root, 'publication-identity-change.jsonl');
    const lockPath = `${journalPath}.lock`;
    type OpenWithAliasHook = (
      filePath: string,
      durable: boolean,
      options: {
        afterLockPublished: (context: { candidatePath: string }) => Promise<void>;
      }
    ) => Promise<TransactionJournal>;

    await expect(
      (TransactionJournal.open as unknown as OpenWithAliasHook).call(
        TransactionJournal,
        journalPath,
        true,
        {
          afterLockPublished: async ({ candidatePath }) => {
            await unlink(candidatePath);
            await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement' }));
          },
        }
      )
    ).rejects.toThrow(/publication identity changed/i);

    await unlink(lockPath).catch(() => undefined);
  });

  it('never restores a live journal lock release quarantine as crash residue', async () => {
    const journalPath = path.join(root, 'journal-live-release.jsonl');
    let releaseReached!: () => void;
    const releaseObserved = new Promise<void>((resolve) => {
      releaseReached = resolve;
    });
    let resumeRelease!: () => void;
    const releaseBarrier = new Promise<void>((resolve) => {
      resumeRelease = resolve;
    });
    let releasingToken: string | undefined;
    type OpenWithReleaseBarrier = (
      filePath: string,
      durable: boolean,
      options: {
        afterLockQuarantined: (context: { token: string }) => Promise<void>;
      }
    ) => Promise<TransactionJournal>;
    const firstOpening = (TransactionJournal.open as unknown as OpenWithReleaseBarrier).call(
      TransactionJournal,
      journalPath,
      true,
      {
        afterLockQuarantined: async (context) => {
          releasingToken = context.token;
          releaseReached();
          await releaseBarrier;
        },
      }
    );
    const observedInTime = await Promise.race([
      releaseObserved.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    if (!observedInTime) {
      const unexpectedlyOpened = await firstOpening;
      await unexpectedlyOpened.close();
    }
    expect(observedInTime).toBe(true);

    let contenderObserved!: () => void;
    const contenderSawQuarantine = new Promise<void>((resolve) => {
      contenderObserved = resolve;
    });
    const secondOpening = TransactionJournal.open(journalPath, true, {
      onLiveLockQuarantineObserved: () => contenderObserved(),
    });
    await contenderSawQuarantine;
    resumeRelease();
    const first = await firstOpening;
    let strandedOwner = false;
    try {
      const owner = JSON.parse(await readFile(`${journalPath}.lock`, 'utf8')) as {
        token?: string;
      };
      strandedOwner = owner.token === releasingToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (strandedOwner) await unlink(`${journalPath}.lock`);
    const second = await secondOpening;

    expect(strandedOwner).toBe(false);
    await first.close();
    await second.close();
  });

  it('attempts both journal handle closes when the first close reports a failure', async () => {
    const journal = await TransactionJournal.open(path.join(root, 'close-all-handles.jsonl'));
    const internals = journal as unknown as {
      handle: { close: () => Promise<void> };
      controlDirectoryHandle: { close: () => Promise<void> };
    };
    const originalJournalClose = internals.handle.close.bind(internals.handle);
    const journalClose = jest.spyOn(internals.handle, 'close').mockImplementationOnce(async () => {
      await originalJournalClose();
      throw new Error('injected journal handle close failure');
    });
    const controlClose = jest.spyOn(internals.controlDirectoryHandle, 'close');

    await expect(journal.close()).rejects.toThrow(/journal handle close failure/i);

    expect(journalClose).toHaveBeenCalledTimes(1);
    expect(controlClose).toHaveBeenCalledTimes(1);
  });

  it('reports non-Error close rejection reasons without skipping the second handle', async () => {
    const journal = await TransactionJournal.open(path.join(root, 'close-string-reason.jsonl'));
    const internals = journal as unknown as {
      handle: { close: () => Promise<void> };
      controlDirectoryHandle: { close: () => Promise<void> };
    };
    const originalJournalClose = internals.handle.close.bind(internals.handle);
    jest.spyOn(internals.handle, 'close').mockImplementationOnce(async () => {
      await originalJournalClose();
      return Promise.reject('raw close rejection');
    });
    const controlClose = jest.spyOn(internals.controlDirectoryHandle, 'close');

    await expect(journal.close()).rejects.toThrow(/raw close rejection/i);
    expect(controlClose).toHaveBeenCalledTimes(1);
  });

  it('does not reread an unchanged journal tail before every durable append', async () => {
    const journal = await TransactionJournal.open(path.join(root, 'linear-append.jsonl'));
    const readSpy = jest.spyOn(
      journal as unknown as { scanJournalLines: () => Promise<unknown> },
      'scanJournalLines'
    );

    for (let index = 0; index < 10; index++) {
      await journal.append({
        operationId: `append-${index}`,
        state: 'planned',
        mode: 'copy',
      });
    }

    expect(readSpy).not.toHaveBeenCalled();
    await journal.close();
  });

  it('rejects a hardlinked journal lock without modifying the other name', async () => {
    const journalPath = path.join(root, 'hardlinked-lock.jsonl');
    const lockPath = `${journalPath}.lock`;
    const outsideLock = path.join(root, 'outside-lock');
    await writeFile(journalPath, '');
    await writeFile(outsideLock, JSON.stringify({ pid: 99_999_999 }));
    await link(outsideLock, lockPath);
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    await expect(TransactionJournal.open(journalPath)).rejects.toThrow(/singly linked/i);
    expect(await readFile(outsideLock, 'utf8')).toContain('99999999');
  });

  it('starts at sequence one when a stored sequence is invalid', async () => {
    const journalPath = path.join(root, 'invalid-sequence.jsonl');
    await writeFile(`${journalPath}.sequence`, 'not-a-sequence');
    const journal = await TransactionJournal.open(journalPath);

    await journal.append({ operationId: 'first', state: 'planned', mode: 'copy' });

    expect((await journal.readRecords())[0].sequence).toBe(1);
    await journal.close();
  });

  it('treats a historical record without a sequence as sequence zero', async () => {
    const journalPath = path.join(root, 'missing-sequence.jsonl');
    await writeFile(journalPath, '{"operationId":"legacy","state":"planned","mode":"copy"}\n');
    const journal = await TransactionJournal.open(journalPath);

    await journal.append({ operationId: 'next', state: 'completed', mode: 'copy' });

    expect((await journal.readRecords()).map((record) => record.sequence)).toEqual([undefined, 1]);
    await journal.close();
  });

  it('fails closed across journal lock identity, residue, and owner-probe boundaries', async () => {
    const journalPath = path.join(root, 'journal-private-boundaries.jsonl');
    const lockPath = `${journalPath}.lock`;
    const journal = await TransactionJournal.open(journalPath);
    type LockSnapshot = {
      raw: string;
      pid?: number;
      token?: string;
      dev?: string;
      ino?: string;
    };
    const internals = journal as unknown as {
      readLockSnapshot(lockPath?: string): Promise<LockSnapshot | undefined>;
      reclaimDeadLock(): Promise<boolean>;
      releaseOwnedLock(token: string): Promise<void>;
      repairLockAliases(): Promise<void>;
      restoreLockQuarantine(): Promise<boolean>;
      processIsAlive(pid: number): boolean;
    };

    expect(await internals.reclaimDeadLock()).toBe(true);
    await internals.releaseOwnedLock('not-owned');
    await internals.repairLockAliases();

    const snapshot: LockSnapshot = {
      raw: '{"pid":99999999,"token":"dead"}',
      pid: 99_999_999,
      token: 'dead',
      dev: '1',
      ino: '2',
    };
    const ownerProbe = jest.spyOn(internals, 'processIsAlive').mockReturnValue(false);
    const changedCurrent = jest
      .spyOn(internals, 'readLockSnapshot')
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, raw: 'changed' });
    expect(await internals.reclaimDeadLock()).toBe(false);
    changedCurrent.mockRestore();

    const changedFinal = jest
      .spyOn(internals, 'readLockSnapshot')
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, ino: '3' });
    expect(await internals.reclaimDeadLock()).toBe(false);
    changedFinal.mockRestore();

    const changedRelease = jest
      .spyOn(internals, 'readLockSnapshot')
      .mockResolvedValueOnce({ ...snapshot, pid: process.pid, token: 'owned' })
      .mockResolvedValueOnce({ ...snapshot, pid: process.pid, token: 'owned', ino: '3' });
    await internals.releaseOwnedLock('owned');
    changedRelease.mockRestore();
    ownerProbe.mockRestore();

    await writeFile(lockPath, '{not-json');
    await expect(internals.readLockSnapshot()).resolves.toEqual({ raw: '' });
    await unlink(lockPath);

    const residuePrefix = `${lockPath}.reclaim.`;
    await Promise.all([
      writeFile(`${residuePrefix}99999998.first`, 'one'),
      writeFile(`${residuePrefix}99999997.second`, 'two'),
    ]);
    await expect(internals.restoreLockQuarantine()).rejects.toThrow(/ambiguous/i);
    await Promise.all([
      unlink(`${residuePrefix}99999998.first`),
      unlink(`${residuePrefix}99999997.second`),
    ]);

    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof process.kill);
    expect(internals.processIsAlive(12345)).toBe(true);
    killSpy.mockImplementation((() => {
      const error = new Error('unexpected probe failure') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      throw error;
    }) as typeof process.kill);
    expect(() => internals.processIsAlive(12345)).toThrow(/unexpected probe failure/i);
    killSpy.mockRestore();

    await journal.close();
  });

  it('refuses lock reclamation and release when quarantine identity is replaced', async () => {
    const journalPath = path.join(root, 'journal-quarantine-replacement.jsonl');
    const lockPath = `${journalPath}.lock`;
    const journal = await TransactionJournal.open(journalPath);
    type LockSnapshot = {
      raw: string;
      pid?: number;
      token?: string;
      dev?: string;
      ino?: string;
    };
    const internals = journal as unknown as {
      lockPath: string;
      options: TransactionJournalOptions;
      readLockSnapshot(lockPath?: string): Promise<LockSnapshot | undefined>;
      reclaimDeadLock(): Promise<boolean>;
      releaseOwnedLock(token: string): Promise<void>;
    };
    const deadOwner = JSON.stringify({ pid: 99_999_999, token: 'dead-owner' });
    await writeFile(lockPath, deadOwner);
    const originalRead = internals.readLockSnapshot.bind(internals);
    let reads = 0;
    const readSpy = jest
      .spyOn(internals, 'readLockSnapshot')
      .mockImplementation(async (filePath) => {
        reads += 1;
        if (reads === 4 && filePath && filePath !== lockPath) {
          await writeFile(
            filePath,
            JSON.stringify({ pid: process.pid, token: 'foreign-quarantine' })
          );
          await writeFile(
            lockPath,
            JSON.stringify({ pid: process.pid, token: 'replacement-lock' })
          );
        }
        return originalRead(filePath);
      });

    await expect(internals.reclaimDeadLock()).rejects.toThrow(/identity changed/i);
    readSpy.mockRestore();
    for (const entry of await readdir(root)) {
      if (entry.startsWith(`${path.basename(lockPath)}.reclaim.`)) {
        await unlink(path.join(root, entry));
      }
    }
    await unlink(lockPath);

    const ownedToken = 'owned-release-token';
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: ownedToken }));
    internals.options.afterLockQuarantined = async ({ quarantinePath }) => {
      await writeFile(
        quarantinePath,
        JSON.stringify({ pid: process.pid, token: 'foreign-quarantine' })
      );
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement-lock' }));
    };

    await expect(internals.releaseOwnedLock(ownedToken)).rejects.toThrow(/identity changed/i);
    await journal.close();
  });

  it('durably repairs a torn final journal record', async () => {
    const journalPath = path.join(root, 'durable-torn.jsonl');
    await writeFile(
      journalPath,
      '{"operationId":"valid","state":"planned","mode":"copy","sequence":1}\n' +
        '{"operationId":"torn"'
    );

    const journal = await TransactionJournal.open(journalPath);

    expect(await journal.readRecords()).toHaveLength(1);
    await journal.close();
  });

  it('normalizes a valid final record without a newline before appending', async () => {
    const journalPath = path.join(root, 'valid-without-newline.jsonl');
    await writeFile(
      journalPath,
      '{"operationId":"first","state":"planned","mode":"copy","sequence":1}'
    );

    const journal = await TransactionJournal.open(journalPath);
    await journal.append({ operationId: 'second', state: 'completed', mode: 'copy' });

    expect((await journal.readRecords()).map((record) => record.operationId)).toEqual([
      'first',
      'second',
    ]);
    expect(await readFile(journalPath, 'utf8')).toMatch(/\}\n\{/);
    await journal.close();
  });

  it('streams records across chunk, newline, and UTF-8 code point boundaries', async () => {
    const journalPath = path.join(root, 'stream-boundaries.jsonl');
    const base = {
      operationId: 'unicode-boundary',
      state: 'planned',
      mode: 'copy',
      error: '',
    };
    const prefixBytes = Buffer.byteLength(JSON.stringify(base).replace('""}', '"'), 'utf8');
    const padding = 'x'.repeat(65_534 - prefixBytes);
    const first = JSON.stringify({ ...base, error: `${padding}📷` });
    const newlineBoundary = JSON.stringify({
      operationId: 'newline-boundary',
      state: 'completed',
      mode: 'copy',
      error: '',
    });
    const firstRecordBytes = Buffer.byteLength(`${first}\n`, 'utf8');
    const bytesToNextChunk = 65_536 - (firstRecordBytes % 65_536);
    const secondTargetBytes =
      bytesToNextChunk >= Buffer.byteLength(newlineBoundary, 'utf8')
        ? bytesToNextChunk
        : bytesToNextChunk + 65_536;
    const newlinePadding = 'y'.repeat(
      secondTargetBytes - Buffer.byteLength(newlineBoundary, 'utf8')
    );
    const second = JSON.stringify({
      operationId: 'newline-boundary',
      state: 'completed',
      mode: 'copy',
      error: newlinePadding,
    });
    await writeFile(journalPath, `${first}\n${second}\n`, 'utf8');

    const journal = await TransactionJournal.open(journalPath, false);

    expect((await journal.readRecords()).map((record) => record.operationId)).toEqual([
      'unicode-boundary',
      'newline-boundary',
    ]);
    await journal.close();
  });

  it('reports the exact line for malformed interior streamed records', async () => {
    const journalPath = path.join(root, 'streamed-interior-corruption.jsonl');
    await writeFile(
      journalPath,
      '{"operationId":"first","state":"planned","mode":"copy"}\n' +
        '{not-json}\n' +
        '{"operationId":"last","state":"completed","mode":"copy"}\n'
    );

    await expect(TransactionJournal.open(journalPath)).rejects.toThrow(
      /Interior transaction journal corruption at line 2:/
    );
  });

  it('rejects a complete interior record that does not match the journal schema', async () => {
    const journalPath = path.join(root, 'streamed-schema-corruption.jsonl');
    await writeFile(
      journalPath,
      '{"operationId":"first","state":"planned","mode":"copy"}\n' +
        '{"operationId":"wrong","state":"invented","mode":"copy"}\n' +
        '{"operationId":"last","state":"completed","mode":"copy"}\n'
    );

    await expect(TransactionJournal.open(journalPath, false)).rejects.toThrow(/schema.*line 2/i);
  });

  it('reads a simulated journal larger than the V8 string limit with bounded buffers', async () => {
    const journal = await TransactionJournal.open(path.join(root, 'simulated-huge.jsonl'), false);
    const internals = journal as unknown as {
      handle: {
        stat: () => Promise<{ size: number }>;
        read: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number
        ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      };
      readRecordsFromDisk: () => Promise<Array<{ operationId: string }>>;
    };
    const originalStat = internals.handle.stat.bind(internals.handle);
    const originalRead = internals.handle.read.bind(internals.handle);
    const line = Buffer.from(
      '{"operationId":"simulated-huge","state":"planned","mode":"copy"}\n',
      'utf8'
    );
    let delivered = false;
    const statSpy = jest
      .spyOn(internals.handle, 'stat')
      .mockResolvedValue({ size: 600 * 1024 * 1024 });
    const readSpy = jest.spyOn(internals.handle, 'read').mockImplementation(async (buffer) => {
      expect(buffer.length).toBeLessThanOrEqual(64 * 1024);
      if (delivered) return { bytesRead: 0, buffer };
      line.copy(buffer);
      delivered = true;
      return { bytesRead: line.length, buffer };
    });

    await expect(internals.readRecordsFromDisk()).resolves.toMatchObject([
      { operationId: 'simulated-huge' },
    ]);
    expect(readSpy).toHaveBeenCalledTimes(2);
    statSpy.mockRestore();
    readSpy.mockRestore();
    internals.handle.stat = originalStat;
    internals.handle.read = originalRead;
    await journal.close();
  });

  it('derives outcomes by folding the stream without materializing readRecords', async () => {
    const journalPath = path.join(root, 'streamed-outcomes.jsonl');
    await writeFile(
      journalPath,
      [
        '{"operationId":"copy","state":"planned","mode":"copy"}',
        '{"operationId":"move","state":"planned","mode":"move"}',
        '{"operationId":"copy","state":"completed","mode":"copy"}',
        '{"operationId":"move","state":"completed","mode":"move"}',
      ].join('\n') + '\n'
    );
    const journal = await TransactionJournal.open(journalPath, false);
    const readRecords = jest
      .spyOn(journal, 'readRecords')
      .mockRejectedValue(new Error('must not materialize journal records'));

    await expect(journal.deriveOutcomes()).resolves.toMatchObject({
      completed: 1,
      moved: 1,
      total: 2,
      nonterminal: 0,
    });
    expect(readRecords).not.toHaveBeenCalled();
    await journal.close();
  });
});
