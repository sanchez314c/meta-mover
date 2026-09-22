import { createHash } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';

import { isReviewOverrideRecord, type ReviewOverrideRecord } from '../../shared/types/review';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type ReviewOverrideStoreErrorCode =
  | 'INVALID_INPUT'
  | 'UNSAFE_STORE_PATH'
  | 'STORE_LOCKED'
  | 'STORE_CLOSED'
  | 'STORE_POISONED'
  | 'CORRUPT_STORE'
  | 'SEQUENCE_REJECTED';

export class ReviewOverrideStoreError extends Error {
  constructor(
    public readonly code: ReviewOverrideStoreErrorCode,
    message: string,
    public readonly line?: number
  ) {
    super(message);
    this.name = 'ReviewOverrideStoreError';
  }
}

export interface ReviewOverrideStoreOptions {
  testHooks?: {
    beforeSync?: () => Promise<void>;
  };
}

interface Identity {
  dev: number;
  ino: number;
}

export function reviewOverrideId(
  record: Pick<ReviewOverrideRecord, 'jobId' | 'previewId' | 'rowIndex' | 'output'>
): string {
  return createHash('sha256')
    .update(
      `${record.jobId}\0${record.previewId}\0${record.rowIndex}\0${record.output.path}\0${record.output.sha256}`
    )
    .digest('hex');
}

function validRecord(value: unknown): value is ReviewOverrideRecord {
  return isReviewOverrideRecord(value) && value.reviewId === reviewOverrideId(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ReviewOverrideStore {
  private readonly latest = new Map<string, ReviewOverrideRecord>();
  private handle?: FileHandle;
  private lockIdentity?: Identity;
  private tail: Promise<void> = Promise.resolve();
  private poisoned = false;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private knownSize = 0;

  private constructor(
    private readonly filePath: string,
    private readonly directoryPath: string,
    private readonly lockPath: string,
    private readonly options: ReviewOverrideStoreOptions
  ) {}

  static async open(
    filePath: string,
    options: ReviewOverrideStoreOptions = {}
  ): Promise<ReviewOverrideStore> {
    if (!path.isAbsolute(filePath))
      throw new ReviewOverrideStoreError('INVALID_INPUT', 'override path must be absolute');
    const directoryPath = path.dirname(filePath);
    await fs.mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const directory = await fs.lstat(directoryPath);
    if (directory.isSymbolicLink() || !directory.isDirectory())
      throw new ReviewOverrideStoreError('UNSAFE_STORE_PATH', 'override parent is unsafe');
    await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
    const canonicalDirectory = await fs.realpath(directoryPath);
    const canonicalPath = path.join(canonicalDirectory, path.basename(filePath));
    const store = new ReviewOverrideStore(
      canonicalPath,
      canonicalDirectory,
      `${canonicalPath}.lock`,
      options
    );
    await store.initialize();
    return store;
  }

  private async initialize(): Promise<void> {
    await this.acquireLock();
    try {
      this.handle = await fs.open(
        this.filePath,
        constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | NO_FOLLOW,
        PRIVATE_FILE_MODE
      );
      await this.handle.chmod(PRIVATE_FILE_MODE);
      await this.assertFileIdentity();
      await this.replay();
      this.knownSize = (await this.handle.stat()).size;
      await this.handle.sync();
      await syncDirectory(this.directoryPath);
    } catch (error) {
      await this.handle?.close().catch(() => undefined);
      await this.releaseLock().catch(() => undefined);
      throw error;
    }
  }

  private async acquireLock(retried = false): Promise<void> {
    try {
      const lock = await fs.open(
        this.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
        PRIVATE_FILE_MODE
      );
      try {
        await lock.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, 'utf8');
        await lock.sync();
        const stat = await lock.stat();
        this.lockIdentity = { dev: stat.dev, ino: stat.ino };
      } finally {
        await lock.close();
      }
      await syncDirectory(this.directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (retried || !(await this.reclaimStaleLock()))
        throw new ReviewOverrideStoreError('STORE_LOCKED', 'override store is locked');
      await this.acquireLock(true);
    }
  }

  private async reclaimStaleLock(): Promise<boolean> {
    const before = await fs.lstat(this.lockPath).catch(() => undefined);
    if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) return false;
    let pid: number;
    try {
      const parsed = JSON.parse(await fs.readFile(this.lockPath, 'utf8')) as { pid?: unknown };
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return false;
      pid = parsed.pid as number;
    } catch {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    const after = await fs.lstat(this.lockPath).catch(() => undefined);
    if (!after || after.dev !== before.dev || after.ino !== before.ino) return false;
    await fs.unlink(this.lockPath);
    await syncDirectory(this.directoryPath);
    return true;
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockIdentity) return;
    const visible = await fs.lstat(this.lockPath).catch(() => undefined);
    if (
      !visible ||
      visible.isSymbolicLink() ||
      visible.dev !== this.lockIdentity.dev ||
      visible.ino !== this.lockIdentity.ino
    )
      throw new ReviewOverrideStoreError('STORE_LOCKED', 'override lock ownership changed');
    await fs.unlink(this.lockPath);
    await syncDirectory(this.directoryPath);
    this.lockIdentity = undefined;
  }

  private async assertLockIdentity(): Promise<void> {
    if (!this.lockIdentity)
      throw new ReviewOverrideStoreError('STORE_LOCKED', 'override lock is missing');
    const visible = await fs.lstat(this.lockPath).catch(() => undefined);
    if (
      !visible ||
      visible.isSymbolicLink() ||
      !visible.isFile() ||
      visible.nlink !== 1 ||
      visible.dev !== this.lockIdentity.dev ||
      visible.ino !== this.lockIdentity.ino
    ) {
      this.poisoned = true;
      throw new ReviewOverrideStoreError('STORE_LOCKED', 'override lock ownership changed');
    }
  }

  private async assertFileIdentity(): Promise<void> {
    if (!this.handle) throw new ReviewOverrideStoreError('STORE_CLOSED', 'store is closed');
    const [held, visible] = await Promise.all([this.handle.stat(), fs.lstat(this.filePath)]);
    if (
      !held.isFile() ||
      held.nlink !== 1 ||
      visible.isSymbolicLink() ||
      !visible.isFile() ||
      visible.nlink !== 1 ||
      held.dev !== visible.dev ||
      held.ino !== visible.ino
    )
      throw new ReviewOverrideStoreError('UNSAFE_STORE_PATH', 'override file identity is unsafe');
  }

  private async replay(): Promise<void> {
    if (!this.handle) return;
    const data = await this.handle.readFile();
    if (data.length === 0) return;
    const finalNewline = data[data.length - 1] === 0x0a;
    let complete = data;
    if (!finalNewline) {
      const lastNewline = data.lastIndexOf(0x0a);
      const tail = data.subarray(lastNewline + 1);
      try {
        JSON.parse(tail.toString('utf8'));
        this.poisoned = true;
        throw new ReviewOverrideStoreError(
          'STORE_POISONED',
          'complete trailing record has ambiguous durability'
        );
      } catch (error) {
        if (error instanceof ReviewOverrideStoreError) throw error;
      }
      const length = lastNewline + 1;
      await this.handle.truncate(length);
      await this.handle.sync();
      complete = data.subarray(0, length);
    }
    const lines = complete.toString('utf8').split('\n');
    lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      const bytes = Buffer.byteLength(lines[index]);
      if (bytes === 0 || bytes > MAX_RECORD_BYTES) this.corrupt(index + 1, 'invalid record size');
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]);
      } catch {
        this.corrupt(index + 1, 'invalid JSON');
      }
      if (!validRecord(parsed)) this.corrupt(index + 1, 'invalid override schema');
      this.acceptReplay(parsed, index + 1);
    }
  }

  private corrupt(line: number, reason: string): never {
    this.poisoned = true;
    throw new ReviewOverrideStoreError('CORRUPT_STORE', reason, line);
  }

  private acceptReplay(record: ReviewOverrideRecord, line: number): void {
    const prior = this.latest.get(record.reviewId);
    const expected = (prior?.sequence ?? 0) + 1;
    if (record.sequence !== expected) this.corrupt(line, 'non-monotonic review sequence');
    this.latest.set(record.reviewId, Object.freeze(clone(record)));
  }

  async append(record: ReviewOverrideRecord): Promise<ReviewOverrideRecord> {
    this.assertAccepting();
    return new Promise<ReviewOverrideRecord>((resolve, reject) => {
      const operation = async () => {
        try {
          this.assertOperational();
          if (!validRecord(record))
            throw new ReviewOverrideStoreError('INVALID_INPUT', 'invalid override record');
          const expected = (this.latest.get(record.reviewId)?.sequence ?? 0) + 1;
          if (record.sequence !== expected)
            throw new ReviewOverrideStoreError(
              'SEQUENCE_REJECTED',
              `expected review sequence ${expected}`
            );
          await this.assertLockIdentity();
          await this.assertFileIdentity();
          const currentSize = (await this.handle!.stat()).size;
          if (currentSize !== this.knownSize) {
            this.poisoned = true;
            throw new ReviewOverrideStoreError(
              'STORE_POISONED',
              'override store changed outside the exclusive writer'
            );
          }
          const snapshot = clone(record);
          const line = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
          if (line.length > MAX_RECORD_BYTES)
            throw new ReviewOverrideStoreError('INVALID_INPUT', 'override record is too large');
          try {
            await this.handle!.writeFile(line);
            await this.options.testHooks?.beforeSync?.();
            await this.handle!.sync();
          } catch (error) {
            try {
              await this.reconcileAmbiguousAppend(this.knownSize, line);
            } catch {
              this.poisoned = true;
              throw new ReviewOverrideStoreError(
                'STORE_POISONED',
                `override append durability is ambiguous: ${String(error)}`
              );
            }
          }
          this.knownSize += line.length;
          await this.assertFileIdentity();
          this.latest.set(snapshot.reviewId, Object.freeze(snapshot));
          resolve(clone(snapshot));
        } catch (error) {
          reject(error);
        }
      };
      this.tail = this.tail.then(operation, operation);
    });
  }

  private async reconcileAmbiguousAppend(startSize: number, line: Buffer): Promise<void> {
    const handle = this.handle!;
    const stats = await handle.stat();
    if (stats.size < startSize || stats.size > startSize + line.length)
      throw new Error('unexpected append size');
    const appendedLength = stats.size - startSize;
    const appended = Buffer.alloc(appendedLength);
    if (appendedLength > 0) await handle.read(appended, 0, appendedLength, startSize);
    if (!line.subarray(0, appendedLength).equals(appended))
      throw new Error('unexpected append bytes');
    if (appendedLength !== line.length) {
      await handle.truncate(startSize);
      await handle.sync();
      await handle.writeFile(line);
    }
    await handle.sync();
  }

  async get(reviewId: string): Promise<ReviewOverrideRecord | null> {
    this.assertAccepting();
    await this.assertCurrentState();
    const value = this.latest.get(reviewId);
    return value ? clone(value) : null;
  }

  async list(): Promise<ReviewOverrideRecord[]> {
    this.assertAccepting();
    await this.assertCurrentState();
    return [...this.latest.values()].map((value) => clone(value));
  }

  close(): Promise<void> {
    if (!this.closePromise) this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    await this.tail.catch(() => undefined);
    await this.handle?.close();
    this.handle = undefined;
    await this.releaseLock();
    this.closed = true;
  }

  private async assertCurrentState(): Promise<void> {
    try {
      await this.assertLockIdentity();
      await this.assertFileIdentity();
      if ((await this.handle!.stat()).size !== this.knownSize)
        throw new ReviewOverrideStoreError(
          'STORE_POISONED',
          'override store size changed outside the exclusive writer'
        );
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  private assertAccepting(): void {
    if (this.closing || this.closed || !this.handle)
      throw new ReviewOverrideStoreError('STORE_CLOSED', 'override store is closed');
    this.assertOperational();
  }

  private assertOperational(): void {
    if (this.closed || !this.handle)
      throw new ReviewOverrideStoreError('STORE_CLOSED', 'override store is closed');
    if (this.poisoned)
      throw new ReviewOverrideStoreError('STORE_POISONED', 'override store is poisoned');
  }
}
