import { randomUUID } from 'crypto';
import { constants } from 'fs';
import {
  FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'fs/promises';
import path from 'path';

import { NativeFilesystemIdentity } from '../../native/NativeFilesystemHelperClient';

export type TransactionMode = 'copy' | 'move';

export type TransactionState =
  | 'planned'
  | 'reserved'
  | 'staged'
  | 'verified'
  | 'transformed'
  | 'committed'
  | 'source-delete-pending'
  | 'source-deleted'
  | 'completed'
  | 'duplicate'
  | 'cancelled'
  | 'failed';

export interface JournalSourceIdentity {
  dev: string;
  ino: string;
  nlink: number;
  size: number;
  modifiedTimeMs: number;
  mtimeNs: string;
  ctimeNs: string;
}

export interface JournalRecord {
  operationId: string;
  state: TransactionState;
  mode: TransactionMode;
  sequence?: number;
  timestamp?: string;
  sourcePath?: string;
  sourceIdentity?: JournalSourceIdentity;
  sourceNativeIdentity?: NativeFilesystemIdentity;
  destinationPath?: string;
  stagingPath?: string;
  stagingNativeIdentity?: NativeFilesystemIdentity;
  reservationPath?: string;
  reservationNativeIdentity?: NativeFilesystemIdentity;
  conservationPath?: string;
  conservationNativeIdentity?: NativeFilesystemIdentity;
  sourceDeleteId?: string;
  sourceDeleteReceiptPath?: string;
  sourceDeleteReceiptState?: 'created' | 'exact';
  hash?: string;
  sourceHash?: string;
  outputHash?: string;
  transformationVerified?: boolean;
  transformationReceipt?: Readonly<Record<string, unknown>>;
  bytes?: number;
  committed?: boolean;
  sourceRetained?: boolean;
  quarantined?: boolean;
  recoveryFinalized?: boolean;
  error?: string;
  residue?: string[];
}

export interface JournalOutcomes {
  completed: number;
  moved: number;
  duplicate: number;
  cancelled: number;
  failed: number;
  committedSourceRetained: number;
  nonterminal: number;
  total: number;
}

export interface TransactionJournalOptions {
  afterLockPublished?: (context: {
    lockPath: string;
    candidatePath: string;
    token: string;
  }) => void | Promise<void>;
  afterLockQuarantined?: (context: {
    lockPath: string;
    quarantinePath: string;
    token: string;
  }) => void | Promise<void>;
  onLiveLockQuarantineObserved?: (context: {
    lockPath: string;
    quarantinePath: string;
    reclaimerPid: number;
  }) => void | Promise<void>;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 30_000;

async function valueOrUndefined<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch {
    return undefined;
  }
}

export class TransactionJournal {
  private static readonly processTails = new Map<string, Promise<void>>();
  private static readonly nondurableSequences = new Map<string, number>();
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly sequencePath: string;
  private readonly handle: FileHandle;
  private readonly controlDirectoryHandle: FileHandle;
  private readonly durable: boolean;
  private readonly options: TransactionJournalOptions;
  private appendTail: Promise<void> = Promise.resolve();
  private isClosed = false;
  private sequenceFloor = 0;
  private knownJournalSize = 0;

  private constructor(
    journalPath: string,
    handle: FileHandle,
    controlDirectoryHandle: FileHandle,
    durable: boolean,
    options: TransactionJournalOptions
  ) {
    this.journalPath = journalPath;
    this.lockPath = `${journalPath}.lock`;
    this.sequencePath = `${journalPath}.sequence`;
    this.handle = handle;
    this.controlDirectoryHandle = controlDirectoryHandle;
    this.durable = durable;
    this.options = options;
  }

  static async open(
    journalPath: string,
    durable = true,
    options: TransactionJournalOptions = {}
  ): Promise<TransactionJournal> {
    await mkdir(path.dirname(journalPath), { recursive: true });
    const controlDirectoryHandle = await this.openTrustedDirectory(path.dirname(journalPath));
    try {
      const stats = await lstat(journalPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('Transaction journal must be a regular non-symlink file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await controlDirectoryHandle.close();
        throw error;
      }
    }

    let handle: FileHandle | undefined;
    try {
      handle = await open(
        journalPath,
        constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      const journalStats = await handle.stat({ bigint: true });
      const journalPathStats = await lstat(journalPath, { bigint: true });
      if (
        !journalStats.isFile() ||
        journalStats.nlink !== 1n ||
        journalStats.dev !== journalPathStats.dev ||
        journalStats.ino !== journalPathStats.ino
      ) {
        throw new Error('Transaction journal must be a singly linked regular file');
      }
      const journal = new TransactionJournal(
        journalPath,
        handle,
        controlDirectoryHandle,
        durable,
        options
      );
      await journal.rejectSymlinkIfPresent(journal.sequencePath);
      await journal.rejectSymlinkIfPresent(journal.lockPath);
      await journal.withFileLock(async () => {
        await journal.repairTornTailLocked();
        await journal.initializeSequenceLocked();
      });
      return journal;
    } catch (error) {
      if (handle) await handle.close();
      await controlDirectoryHandle.close();
      throw error;
    }
  }

  async append(record: JournalRecord): Promise<void> {
    if (this.isClosed) throw new Error('Transaction journal is closed');

    const write = this.appendTail.then(() =>
      this.withFileLock(async () => {
        // A peer or crashed writer can only change the tail while holding this lock. Avoid a
        // full read on the unchanged single-writer path, but repair whenever the inode size
        // differs from the last size this handle validated or appended.
        if (this.durable && (await this.handle.stat()).size !== this.knownJournalSize) {
          await this.repairTornTailLocked();
        }
        const sequence = await this.nextSequenceLocked();
        const persisted: JournalRecord = {
          ...record,
          sequence,
          timestamp: new Date().toISOString(),
        };
        const line = `${JSON.stringify(persisted)}\n`;
        await this.handle.appendFile(line, 'utf8');
        this.knownJournalSize += Buffer.byteLength(line, 'utf8');
        if (this.durable) await this.handle.sync();
      })
    );

    this.appendTail = write.catch(() => undefined);
    await write;
  }

  async readRecords(): Promise<JournalRecord[]> {
    await this.appendTail;
    return this.withFileLock(async () => {
      await this.repairTornTailLocked();
      return this.readRecordsFromDisk();
    });
  }

  async deriveOutcomes(): Promise<JournalOutcomes> {
    const records = await this.readRecords();
    const latest = new Map<string, JournalRecord>();
    for (const record of records) latest.set(record.operationId, record);

    const outcomes: JournalOutcomes = {
      completed: 0,
      moved: 0,
      duplicate: 0,
      cancelled: 0,
      failed: 0,
      committedSourceRetained: 0,
      nonterminal: 0,
      total: latest.size,
    };

    for (const record of latest.values()) {
      if (record.state === 'completed') {
        if (record.mode === 'move') outcomes.moved++;
        else outcomes.completed++;
      } else if (record.state === 'duplicate') {
        outcomes.duplicate++;
      } else if (record.state === 'cancelled') {
        if (record.committed && record.sourceRetained === true) {
          outcomes.committedSourceRetained++;
        } else outcomes.cancelled++;
      } else if (record.state === 'failed') {
        if (record.committed && record.sourceRetained === true) {
          outcomes.committedSourceRetained++;
        } else outcomes.failed++;
      } else {
        outcomes.nonterminal++;
      }
    }

    return outcomes;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    await this.appendTail;
    const results = await Promise.allSettled([
      this.handle.close(),
      this.controlDirectoryHandle.close(),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new Error(
        `Failed to close transaction journal resources: ${failures
          .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
          .join('; ')}`
      );
    }
  }

  private async readRecordsFromDisk(): Promise<JournalRecord[]> {
    const content = await this.readJournalContent();

    const records: JournalRecord[] = [];
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      records.push(JSON.parse(line) as JournalRecord);
    }
    return records;
  }

  private async repairTornTailLocked(): Promise<void> {
    const content = await this.readJournalContent();

    const lines = content.split('\n');
    const nonemptyIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim().length > 0)
      .map(({ index }) => index);
    const lastNonempty = nonemptyIndexes[nonemptyIndexes.length - 1];
    if (lastNonempty === undefined) {
      this.knownJournalSize = Buffer.byteLength(content, 'utf8');
      return;
    }

    for (const index of nonemptyIndexes) {
      try {
        JSON.parse(lines[index]);
      } catch (error) {
        if (index !== lastNonempty) {
          throw new Error(
            `Interior transaction journal corruption at line ${index + 1}: ${
              error instanceof Error ? error.message : 'Unknown parse error'
            }`
          );
        }
        const torn = lines[index];
        const validContent = index === 0 ? '' : `${lines.slice(0, index).join('\n')}\n`;
        await this.revalidateControlDirectory();
        await writeFile(`${this.journalPath}.torn.${Date.now()}`, torn, {
          encoding: 'utf8',
          flag: 'wx',
        });
        await this.handle.truncate(Buffer.byteLength(validContent, 'utf8'));
        this.knownJournalSize = Buffer.byteLength(validContent, 'utf8');
        if (this.durable) await this.handle.sync();
        return;
      }
    }

    if (!content.endsWith('\n')) {
      await this.handle.appendFile('\n', 'utf8');
      this.knownJournalSize = Buffer.byteLength(content, 'utf8') + 1;
      if (this.durable) await this.handle.sync();
    } else {
      this.knownJournalSize = Buffer.byteLength(content, 'utf8');
    }
  }

  private async withFileLock<T>(work: () => Promise<T>): Promise<T> {
    if (!this.durable) return this.withProcessLock(work);

    const startedAt = Date.now();
    while (true) {
      if (!(await this.restoreLockQuarantine())) {
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(
            `Timed out waiting for transaction journal lock release: ${this.lockPath}`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        continue;
      }
      let lockHandle: FileHandle | undefined;
      let published = false;
      const token = randomUUID();
      const candidatePath = `${this.lockPath}.candidate.${process.pid}.${token}`;
      try {
        await this.revalidateControlDirectory();
        lockHandle = await open(candidatePath, 'wx', 0o600);
        await lockHandle.writeFile(
          JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
          'utf8'
        );
        await lockHandle.close();
        lockHandle = undefined;
        await link(candidatePath, this.lockPath);
        published = true;
        await this.options.afterLockPublished?.({
          lockPath: this.lockPath,
          candidatePath,
          token,
        });
        try {
          await unlink(candidatePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const published = await this.readLockSnapshot();
          if (!published || published.pid !== process.pid || published.token !== token) {
            throw new Error('Transaction journal lock publication identity changed');
          }
        }
      } catch (error) {
        if (lockHandle) await lockHandle.close();
        await unlink(candidatePath).catch((cleanupError: NodeJS.ErrnoException) => {
          if (cleanupError.code !== 'ENOENT') throw cleanupError;
        });
        if (published) {
          await this.releaseOwnedLock(token);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.repairLockAliases();
        const stats = await valueOrUndefined(lstat(this.lockPath));
        if (stats && Date.now() - stats.mtimeMs > LOCK_STALE_MS && (await this.reclaimDeadLock())) {
          continue;
        }
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out acquiring transaction journal lock: ${this.lockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
        continue;
      }

      try {
        return await work();
      } finally {
        await this.releaseOwnedLock(token);
      }
    }
  }

  private async initializeSequenceLocked(): Promise<void> {
    const records = await this.readRecordsFromDisk();
    const journalMaximum = records.reduce(
      (highest, entry) => Math.max(highest, entry.sequence ?? 0),
      0
    );
    const stored = await this.readStoredSequence();
    this.sequenceFloor = Math.max(stored, journalMaximum);
    if (!this.durable) {
      TransactionJournal.nondurableSequences.set(this.journalPath, this.sequenceFloor);
      return;
    }
    if (stored < journalMaximum) {
      await this.writeStoredSequence(journalMaximum);
    }
  }

  private async nextSequenceLocked(): Promise<number> {
    if (!this.durable) {
      const next = (TransactionJournal.nondurableSequences.get(this.journalPath) ?? 0) + 1;
      TransactionJournal.nondurableSequences.set(this.journalPath, next);
      return next;
    }
    const next = Math.max(await this.readStoredSequence(), this.sequenceFloor) + 1;
    await this.writeStoredSequence(next);
    this.sequenceFloor = next;
    return next;
  }

  private async readStoredSequence(): Promise<number> {
    let sequenceHandle: FileHandle | undefined;
    try {
      await this.revalidateControlDirectory();
      sequenceHandle = await open(
        this.sequencePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      const stats = await sequenceHandle.stat();
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error('Transaction sequence control file must be a singly linked regular file');
      }
      const value = Number.parseInt(await sequenceHandle.readFile('utf8'), 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    } finally {
      if (sequenceHandle) await sequenceHandle.close();
    }
  }

  private async writeStoredSequence(sequence: number): Promise<void> {
    await this.revalidateControlDirectory();
    const temporaryPath = `${this.sequencePath}.tmp.${process.pid}.${randomUUID()}`;
    const sequenceHandle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      await sequenceHandle.writeFile(sequence.toString(), 'utf8');
      if (this.durable) await sequenceHandle.sync();
    } finally {
      await sequenceHandle.close();
    }
    try {
      await this.revalidateControlDirectory();
      await rename(temporaryPath, this.sequencePath);
      if (this.durable) {
        await this.controlDirectoryHandle.sync();
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async reclaimDeadLock(): Promise<boolean> {
    const snapshot = await this.readLockSnapshot();
    if (!snapshot) return true;
    if (snapshot.pid && this.processIsAlive(snapshot.pid)) return false;
    const current = await this.readLockSnapshot();
    if (
      !current ||
      current.raw !== snapshot.raw ||
      current.dev !== snapshot.dev ||
      current.ino !== snapshot.ino
    ) {
      return false;
    }
    await this.revalidateControlDirectory();
    const final = await this.readLockSnapshot();
    if (
      !final ||
      final.raw !== snapshot.raw ||
      final.dev !== snapshot.dev ||
      final.ino !== snapshot.ino
    ) {
      return false;
    }
    const quarantinePath = `${this.lockPath}.reclaim.${process.pid}.${randomUUID()}`;
    await rename(this.lockPath, quarantinePath);
    const displaced = await this.readLockSnapshot(quarantinePath);
    if (
      !displaced ||
      displaced.raw !== snapshot.raw ||
      displaced.dev !== snapshot.dev ||
      displaced.ino !== snapshot.ino
    ) {
      await link(quarantinePath, this.lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      throw new Error('Transaction journal lock identity changed during reclamation');
    }
    await unlink(quarantinePath);
    return true;
  }

  private async releaseOwnedLock(token: string): Promise<void> {
    const snapshot = await this.readLockSnapshot();
    if (!snapshot || snapshot.token !== token || snapshot.pid !== process.pid) return;
    await this.revalidateControlDirectory();
    const current = await this.readLockSnapshot();
    if (
      !current ||
      current.raw !== snapshot.raw ||
      current.dev !== snapshot.dev ||
      current.ino !== snapshot.ino
    ) {
      return;
    }
    const quarantinePath = `${this.lockPath}.reclaim.${process.pid}.${randomUUID()}`;
    await rename(this.lockPath, quarantinePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await this.options.afterLockQuarantined?.({
      lockPath: this.lockPath,
      quarantinePath,
      token,
    });
    let displaced = await this.readLockSnapshot(quarantinePath);
    if (!displaced) {
      const restored = await this.readLockSnapshot();
      if (restored?.token === token && restored.pid === process.pid) {
        await rename(this.lockPath, quarantinePath);
        displaced = await this.readLockSnapshot(quarantinePath);
      }
    }
    if (displaced && displaced.token === token && displaced.pid === process.pid) {
      await unlink(quarantinePath);
    } else if (displaced) {
      await link(quarantinePath, this.lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      throw new Error('Transaction journal lock identity changed during release');
    }
  }

  private async readLockSnapshot(
    lockPath = this.lockPath
  ): Promise<
    { raw: string; pid?: number; token?: string; dev?: string; ino?: string } | undefined
  > {
    let handle: FileHandle | undefined;
    try {
      await this.revalidateControlDirectory();
      handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stats = await handle.stat({ bigint: true });
      if (stats.nlink === 0n) return undefined;
      if (!stats.isFile() || stats.nlink !== 1n) {
        throw new Error('Transaction lock must be a singly linked regular file');
      }
      const raw = await handle.readFile('utf8');
      const owner = JSON.parse(raw) as { pid?: number; token?: string };
      return {
        raw,
        pid: Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 ? owner.pid : undefined,
        token: typeof owner.token === 'string' ? owner.token : undefined,
        dev: stats.dev.toString(),
        ino: stats.ino.toString(),
      };
    } catch (error) {
      if (error instanceof SyntaxError) return { raw: '' };
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }

  private async repairLockAliases(): Promise<void> {
    const lockStats = await valueOrUndefined(lstat(this.lockPath, { bigint: true }));
    if (!lockStats || lockStats.nlink <= 1n) return;
    const prefixes = [
      `${path.basename(this.lockPath)}.candidate.`,
      `${path.basename(this.lockPath)}.reclaim.`,
    ];
    let removed = false;
    for (const entry of await readdir(path.dirname(this.lockPath))) {
      if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
      const aliasPath = path.join(path.dirname(this.lockPath), entry);
      const stats = await valueOrUndefined(lstat(aliasPath, { bigint: true }));
      if (stats && stats.dev === lockStats.dev && stats.ino === lockStats.ino) {
        await unlink(aliasPath);
        removed = true;
      }
    }
    if (removed) await this.controlDirectoryHandle.sync();
  }

  private async restoreLockQuarantine(): Promise<boolean> {
    if (
      await lstat(this.lockPath)
        .then(() => true)
        .catch(() => false)
    ) {
      await this.repairLockAliases();
      return true;
    }
    const prefix = `${path.basename(this.lockPath)}.reclaim.`;
    const entries = (await readdir(path.dirname(this.lockPath))).filter((entry) =>
      entry.startsWith(prefix)
    );
    if (entries.length === 0) return true;
    if (entries.length !== 1) throw new Error('Transaction journal has ambiguous lock residue');
    const prefixLength = prefix.length;
    const reclaimerPid = Number.parseInt(entries[0].slice(prefixLength).split('.')[0], 10);
    if (
      Number.isSafeInteger(reclaimerPid) &&
      reclaimerPid > 0 &&
      this.processIsAlive(reclaimerPid)
    ) {
      await this.options.onLiveLockQuarantineObserved?.({
        lockPath: this.lockPath,
        quarantinePath: path.join(path.dirname(this.lockPath), entries[0]),
        reclaimerPid,
      });
      return false;
    }
    await rename(path.join(path.dirname(this.lockPath), entries[0]), this.lockPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }
    );
    await this.controlDirectoryHandle.sync();
    return true;
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw error;
    }
  }

  private async readJournalContent(): Promise<string> {
    const stats = await this.handle.stat();
    if (!Number.isSafeInteger(stats.size)) {
      throw new Error('Transaction journal exceeds the safe readable size');
    }
    const content = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await this.handle.read(
        content,
        offset,
        content.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return content.subarray(0, offset).toString('utf8');
  }

  private async rejectSymlinkIfPresent(filePath: string): Promise<void> {
    try {
      await this.revalidateControlDirectory();
      if ((await lstat(filePath)).isSymbolicLink()) {
        throw new Error(`Transaction control file is a symbolic link: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async revalidateControlDirectory(): Promise<void> {
    const [current, captured] = await Promise.all([
      lstat(path.dirname(this.journalPath), { bigint: true }),
      this.controlDirectoryHandle.stat({ bigint: true }),
    ]);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== captured.dev ||
      current.ino !== captured.ino
    ) {
      throw new Error('Transaction journal control directory identity changed');
    }
  }

  private static async openTrustedDirectory(directoryPath: string): Promise<FileHandle> {
    const expected = await lstat(directoryPath, { bigint: true });
    const handle = await open(
      directoryPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
    );
    try {
      const actual = await handle.stat({ bigint: true });
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new Error('Transaction journal control directory identity changed while opening');
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async withProcessLock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = TransactionJournal.processTails.get(this.journalPath) ?? Promise.resolve();
    TransactionJournal.processTails.set(this.journalPath, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (TransactionJournal.processTails.get(this.journalPath) === current) {
        TransactionJournal.processTails.delete(this.journalPath);
      }
    }
  }
}
