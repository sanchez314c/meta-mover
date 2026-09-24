import { createHash, randomUUID } from 'crypto';
import { BigIntStats, constants } from 'fs';
import {
  FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'fs/promises';
import path from 'path';

import {
  NativeFilesystemHelperClientError,
  NativeFilesystemIdentity,
} from '../../native/NativeFilesystemHelperClient';

import { hashFile, hashFileHandle } from './Hashing';
import {
  JournalOutcomes,
  JournalRecord,
  JournalSourceIdentity,
  TransactionJournal,
  TransactionMode,
} from './TransactionJournal';
import { NativeTransactionFilesystem } from './NativeTransactionFilesystem';

export type FailurePoint =
  | 'before-source-hash'
  | 'after-source-hash'
  | 'after-stage-written'
  | 'after-stage-verified'
  | 'before-publish'
  | 'after-commit'
  | 'before-source-delete'
  | 'before-source-directory-preflight'
  | 'after-source-directory-preflight'
  | 'after-source-delete-pending'
  | 'after-source-unlink'
  | 'before-source-directory-post-unlink-sync'
  | 'after-source-directory-post-unlink-sync'
  | 'after-guard-release-verification'
  | 'after-guard-unlink'
  | 'before-core-lock-candidate-cleanup'
  | 'after-core-lock-quarantined'
  | 'live-core-lock-quarantine-observed'
  | 'before-core-lock-reclaim'
  | 'after-final-source-identity-before-unlink'
  | 'before-recovery-mutation';

export interface FailureContext {
  operationId: string;
  sourcePath: string;
  stagingPath?: string;
  destinationPath?: string;
}

export interface TransactionalFileCoreOptions {
  durableJournal?: boolean;
  durableFileOperations?: boolean;
  failureInjector?: (point: FailurePoint, context: FailureContext) => void | Promise<void>;
  durabilityVerifier?: (destinationRoot: string) => void | Promise<void>;
  cleanupFailureInjector?: (filePath: string) => void | Promise<void>;
  nativeFilesystem?: NativeTransactionFilesystem;
  nativeFilesystemFactory?: (
    canonicalDestinationRoot: string,
    canonicalControlRoot: string
  ) => Promise<NativeTransactionFilesystem>;
}

export interface ExpectedSourceIdentity {
  device: number;
  inode: number;
  links: number;
  size: number;
  modifiedTimeMs: number;
}

export interface TransactionRequest {
  operationId?: string;
  sourcePath: string;
  targetFilename: string;
  expectedDestinationPath?: string;
  collisionMode?: 'allocate' | 'exact-no-clobber';
  expectedSourceIdentity?: ExpectedSourceIdentity;
  expectedSha256?: string;
  mode?: TransactionMode;
  signal?: AbortSignal;
  transformStaging?: (context: {
    stagingPath: string;
    signal?: AbortSignal;
  }) => Promise<void | Readonly<Record<string, unknown>>>;
}

export interface TransactionPreview {
  sourcePath: string;
  targetFilename: string;
  destinationPath: string;
  expectedDestinationPath: string;
  mode: TransactionMode;
  collision: boolean;
  duplicate: boolean;
  provisional: true;
}

export interface TransactionResult {
  operationId: string;
  sourcePath: string;
  destinationPath?: string;
  status: 'copied' | 'moved' | 'duplicate' | 'cancelled' | 'failed';
  committed: boolean;
  sourceRetained: boolean;
  hash?: string;
  bytes?: number;
  error?: string;
  residue?: string[];
}

type SourceIdentity = JournalSourceIdentity;

interface Reservation {
  candidatePath: string;
  reservationPath?: string;
  reservationNativeIdentity?: NativeFilesystemIdentity;
  duplicate: boolean;
}

interface TargetDirectoryBinding {
  directoryPath: string;
  handle: FileHandle;
}

interface AsyncClosable {
  close(): Promise<unknown>;
}

async function closeIgnoringErrors(resource: AsyncClosable | undefined): Promise<void> {
  if (!resource) return;
  try {
    await resource.close();
  } catch {
    // Cleanup is best effort; the original transaction failure remains authoritative.
  }
}

async function valueOrUndefined<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch {
    return undefined;
  }
}

export class TransactionalFileCore {
  private readonly destinationRoot: string;
  private readonly controlRoot: string;
  private readonly stagingRoot: string;
  private readonly reservationRoot: string;
  private readonly objectRoot: string;
  private readonly deleteReceiptRoot: string;
  private readonly coreLockPath: string;
  private readonly coreLockToken: string;
  private readonly journal: TransactionJournal;
  private readonly controlDirectoryHandle: FileHandle;
  private readonly destinationDirectoryHandle: FileHandle;
  private readonly stagingDirectoryHandle: FileHandle;
  private readonly reservationDirectoryHandle: FileHandle;
  private readonly objectDirectoryHandle: FileHandle;
  private readonly failureInjector?: TransactionalFileCoreOptions['failureInjector'];
  private readonly cleanupFailureInjector?: TransactionalFileCoreOptions['cleanupFailureInjector'];
  private readonly durableFileOperations: boolean;
  private readonly nativeFilesystem?: NativeTransactionFilesystem;
  private allocationTail: Promise<void> = Promise.resolve();
  private readonly nextCounters = new Map<string, number>();
  private readonly committedByHash = new Map<string, string>();
  private readonly managedNativeIdentities = new Map<string, NativeFilesystemIdentity>();
  private moveDurabilityError?: string;
  private isClosed = false;
  private closePromise?: Promise<void>;

  private constructor(
    destinationRoot: string,
    journal: TransactionJournal,
    coreLockPath: string,
    coreLockToken: string,
    controlDirectoryHandle: FileHandle,
    destinationDirectoryHandle: FileHandle,
    stagingDirectoryHandle: FileHandle,
    reservationDirectoryHandle: FileHandle,
    objectDirectoryHandle: FileHandle,
    options: TransactionalFileCoreOptions
  ) {
    this.destinationRoot = destinationRoot;
    this.controlRoot = path.join(destinationRoot, '.meta-mover');
    this.stagingRoot = path.join(this.controlRoot, 'staging');
    this.reservationRoot = path.join(this.controlRoot, 'reservations');
    this.objectRoot = path.join(this.controlRoot, 'objects');
    this.deleteReceiptRoot = path.join(this.controlRoot, 'delete-receipts');
    this.coreLockPath = coreLockPath;
    this.coreLockToken = coreLockToken;
    this.journal = journal;
    this.controlDirectoryHandle = controlDirectoryHandle;
    this.destinationDirectoryHandle = destinationDirectoryHandle;
    this.stagingDirectoryHandle = stagingDirectoryHandle;
    this.reservationDirectoryHandle = reservationDirectoryHandle;
    this.objectDirectoryHandle = objectDirectoryHandle;
    this.failureInjector = options.failureInjector;
    this.cleanupFailureInjector = options.cleanupFailureInjector;
    this.durableFileOperations = options.durableFileOperations ?? true;
    this.nativeFilesystem = options.nativeFilesystem;
  }

  static async create(
    destinationRoot: string,
    options: TransactionalFileCoreOptions = {}
  ): Promise<TransactionalFileCore> {
    await mkdir(destinationRoot, { recursive: true });
    const resolvedDestination = await realpath(destinationRoot);
    const controlRoot = path.join(resolvedDestination, '.meta-mover');
    const stagingRoot = path.join(controlRoot, 'staging');
    const reservationRoot = path.join(controlRoot, 'reservations');
    const objectRoot = path.join(controlRoot, 'objects');
    await this.ensureSecureDirectory(controlRoot, resolvedDestination);
    await this.ensureSecureDirectory(stagingRoot, resolvedDestination);
    await this.ensureSecureDirectory(reservationRoot, resolvedDestination);
    await this.ensureSecureDirectory(objectRoot, resolvedDestination);

    const coreLockPath = path.join(controlRoot, 'core.lock');
    const coreLockToken = await this.acquireCoreLock(coreLockPath, options.failureInjector);
    let nativeFilesystem = options.nativeFilesystem;
    let journal: TransactionJournal | undefined;
    let controlDirectoryHandle: FileHandle | undefined;
    let destinationDirectoryHandle: FileHandle | undefined;
    let stagingDirectoryHandle: FileHandle | undefined;
    let reservationDirectoryHandle: FileHandle | undefined;
    let objectDirectoryHandle: FileHandle | undefined;
    try {
      nativeFilesystem ??= await options.nativeFilesystemFactory?.(
        resolvedDestination,
        controlRoot
      );
      // Capture each handle as it opens so the catch path owns and closes every successful
      // acquisition if a later directory fails identity validation.
      controlDirectoryHandle = await this.openTrustedDirectory(controlRoot);
      destinationDirectoryHandle = await this.openTrustedDirectory(resolvedDestination);
      stagingDirectoryHandle = await this.openTrustedDirectory(stagingRoot);
      reservationDirectoryHandle = await this.openTrustedDirectory(reservationRoot);
      objectDirectoryHandle = await this.openTrustedDirectory(objectRoot);
      journal = await TransactionJournal.open(
        path.join(controlRoot, 'transactions.jsonl'),
        options.durableJournal ?? true
      );
      const core = new TransactionalFileCore(
        resolvedDestination,
        journal,
        coreLockPath,
        coreLockToken,
        controlDirectoryHandle,
        destinationDirectoryHandle,
        stagingDirectoryHandle,
        reservationDirectoryHandle,
        objectDirectoryHandle,
        { ...options, nativeFilesystem }
      );
      try {
        if (options.durableJournal === false) {
          throw new Error('Transaction journal durability is disabled');
        } else if (!core.durableFileOperations) {
          throw new Error('Durable file operations are disabled');
        } else if (options.durabilityVerifier) {
          await options.durabilityVerifier(resolvedDestination);
        } else {
          await core.verifyMoveDurability();
        }
      } catch (error) {
        core.moveDurabilityError =
          error instanceof Error ? error.message : 'Unknown durability error';
      }
      await core.recoverInterruptedOperations();
      await core.revalidateDirectoryBindings();
      return core;
    } catch (error) {
      await closeIgnoringErrors(journal);
      await Promise.all([
        closeIgnoringErrors(controlDirectoryHandle),
        closeIgnoringErrors(destinationDirectoryHandle),
        closeIgnoringErrors(stagingDirectoryHandle),
        closeIgnoringErrors(reservationDirectoryHandle),
        closeIgnoringErrors(objectDirectoryHandle),
        closeIgnoringErrors(nativeFilesystem),
      ]);
      try {
        await this.releaseCoreLock(coreLockPath, coreLockToken, options.failureInjector);
      } catch {
        // Preserve the admission failure even if lock cleanup also fails.
      }
      throw error;
    }
  }

  async preview(request: TransactionRequest): Promise<TransactionPreview> {
    await this.revalidateDirectoryBindings();
    const targetRelativePath = this.normalizeTargetRelativePath(request.targetFilename);
    await this.validateTargetAncestors(targetRelativePath);
    const sourcePath = await this.resolveRegularSource(request.sourcePath);
    const sourceHash = await hashFile(sourcePath, request.signal);
    const candidate = await this.findPreviewCandidate(targetRelativePath, sourceHash);

    return {
      sourcePath,
      targetFilename: path.relative(this.destinationRoot, candidate.candidatePath),
      destinationPath: candidate.candidatePath,
      expectedDestinationPath: candidate.candidatePath,
      mode: request.mode ?? 'copy',
      collision: candidate.candidatePath !== path.join(this.destinationRoot, targetRelativePath),
      duplicate: candidate.duplicate,
      provisional: true,
    };
  }

  async execute(request: TransactionRequest): Promise<TransactionResult> {
    const operationId = request.operationId ?? randomUUID();
    const mode = request.mode ?? 'copy';
    let sourcePath = request.sourcePath;
    let sourceHandle: FileHandle | undefined;
    let sourceHash: string | undefined;
    let outputHash: string | undefined;
    let sourceIdentity: SourceIdentity | undefined;
    let sourceNativeIdentity: NativeFilesystemIdentity | undefined;
    let stagingPath: string | undefined;
    let stagingNativeIdentity: NativeFilesystemIdentity | undefined;
    let destinationPath: string | undefined;
    let reservationPath: string | undefined;
    let reservationNativeIdentity: NativeFilesystemIdentity | undefined;
    let targetDirectory: TargetDirectoryBinding | undefined;
    let committed = false;
    let transformationStarted = false;
    let sourceDeleteIntentDurable = false;
    let bytes: number | undefined;
    const residue: string[] = [];

    try {
      if (this.isClosed) throw new Error('Transactional file core is closed');
      this.validateOperationId(operationId);
      if (request.expectedSha256 && !/^[a-f0-9]{64}$/.test(request.expectedSha256)) {
        throw new Error('Expected source hash must be a lowercase SHA-256 digest');
      }
      await this.revalidateDirectoryBindings();
      const targetRelativePath = this.normalizeTargetRelativePath(request.targetFilename);
      const expectedDestinationPath = request.expectedDestinationPath
        ? this.validateExpectedDestinationPath(targetRelativePath, request.expectedDestinationPath)
        : undefined;
      if (request.collisionMode === 'exact-no-clobber' && !expectedDestinationPath) {
        throw new Error('Exact destination is required for exact-no-clobber mode');
      }
      this.throwIfCancelled(request.signal);
      if (mode === 'move' && this.moveDurabilityError) {
        throw new Error(`Move durability cannot be proven: ${this.moveDurabilityError}`);
      }

      sourcePath = await this.resolveRegularSource(request.sourcePath);
      sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      sourceIdentity = await this.getHandleIdentity(sourceHandle);
      await this.requirePathIdentity(sourcePath, sourceIdentity);
      if (sourceIdentity.nlink !== 1) {
        throw new Error('Multiply linked source files are not accepted for transaction admission');
      }
      if (request.expectedSourceIdentity) {
        this.requireExpectedIdentity(sourceIdentity, request.expectedSourceIdentity);
      }

      // Same-filesystem rename fast path for moves: no hashing, no staging, instant rename.
      if (
        mode === 'move' &&
        request.expectedSha256 === undefined &&
        request.transformStaging === undefined
      ) {
        const targetDirectoryForDevCheck = await this.prepareTargetDirectory(targetRelativePath);
        const targetDirIdentity = await this.getHandleIdentity(targetDirectoryForDevCheck.handle);
        if (sourceIdentity.dev === targetDirIdentity.dev) {
          targetDirectory = targetDirectoryForDevCheck;
          // Save counter state so a cross-device fallback starts the
          // staged-copy path with the same allocation cursor.
          const savedCounter = this.nextCounters.get(targetRelativePath);
          try {
            return await this.executeSameFilesystemMove(
              operationId,
              sourcePath,
              sourceHandle,
              sourceIdentity,
              targetRelativePath,
              expectedDestinationPath,
              request.collisionMode,
              request.signal,
              targetDirectory
            );
          } catch (renameError) {
            if (this.isCrossDeviceError(renameError)) {
              // st_dev matched but the rename returned EXDEV (different mount
              // points sharing a device number, or bind-mount edge). Fall
              // through to the full staged-copy path. Restore the allocation
              // counter so hash-based duplicate detection at counter 0 is
              // not skipped.
              if (savedCounter === undefined) {
                this.nextCounters.delete(targetRelativePath);
              } else {
                this.nextCounters.set(targetRelativePath, savedCounter);
              }
            } else {
              throw renameError;
            }
          }
        } else {
          await closeIgnoringErrors(targetDirectoryForDevCheck.handle);
          targetDirectory = undefined;
        }
      }

      await this.inject('before-source-hash', { operationId, sourcePath });
      sourceHash = await hashFileHandle(sourceHandle, request.signal);
      outputHash = sourceHash;
      await this.inject('after-source-hash', { operationId, sourcePath });
      await this.requirePathIdentity(sourcePath, sourceIdentity);
      if (request.expectedSha256 && sourceHash !== request.expectedSha256) {
        throw new Error('Source content does not match the expected source hash');
      }

      await this.journal.append({
        operationId,
        state: 'planned',
        mode,
        sourcePath,
        sourceIdentity,
        hash: sourceHash,
        bytes: sourceIdentity.size,
      });

      if (!targetDirectory) {
        targetDirectory = await this.prepareTargetDirectory(targetRelativePath);
      }
      const activeTargetDirectory = targetDirectory;

      let reservation = await this.reserveCandidate(
        targetRelativePath,
        request.transformStaging ? undefined : sourceHash,
        operationId,
        activeTargetDirectory,
        expectedDestinationPath
      );
      destinationPath = reservation.candidatePath;
      reservationPath = reservation.reservationPath;
      reservationNativeIdentity = reservation.reservationNativeIdentity;

      if (reservation.duplicate) {
        committed = true;
        return await this.finishDuplicate(
          operationId,
          mode,
          sourcePath,
          sourceHandle,
          sourceIdentity,
          sourceHash,
          destinationPath,
          request.signal,
          residue,
          (protectedPath, protectedIdentity) => {
            stagingPath = protectedPath;
            stagingNativeIdentity = protectedIdentity;
          },
          () => {
            sourceDeleteIntentDurable = true;
          },
          activeTargetDirectory
        );
      }

      await this.journal.append({
        operationId,
        state: 'reserved',
        mode,
        sourcePath,
        sourceIdentity,
        destinationPath,
        reservationPath,
        reservationNativeIdentity,
        hash: sourceHash,
      });

      stagingPath = path.join(this.stagingRoot, `${operationId}.part`);
      const nativeFilesystem = this.requireNativeFilesystem();
      const staged = await nativeFilesystem.stageCopy(
        sourcePath,
        stagingPath,
        sourceHash,
        request.signal
      );
      if (!staged.before || !staged.after || !staged.sha256) {
        throw new Error('Native staging receipt is incomplete');
      }
      sourceNativeIdentity = staged.before;
      stagingNativeIdentity = staged.after;
      this.managedNativeIdentities.set(stagingPath, staged.after);
      bytes = Number(staged.after.size);
      await this.journal.append({
        operationId,
        state: 'staged',
        mode,
        sourcePath,
        sourceIdentity,
        destinationPath,
        stagingPath,
        stagingNativeIdentity,
        reservationPath,
        reservationNativeIdentity,
        hash: staged.sha256,
        bytes,
      });
      await this.inject('after-stage-written', {
        operationId,
        sourcePath,
        stagingPath,
        destinationPath,
      });
      this.throwIfCancelled(request.signal);

      if (bytes !== sourceIdentity.size || staged.sha256 !== sourceHash) {
        throw new Error('Streamed staging verification failed');
      }
      const independentlyVerifiedHash = await hashFile(stagingPath, request.signal);
      if (independentlyVerifiedHash !== sourceHash) {
        throw new Error('Independent hash verification failed for staging file');
      }
      await this.requirePathIdentity(sourcePath, sourceIdentity);
      await this.journal.append({
        operationId,
        state: 'verified',
        mode,
        sourcePath,
        sourceIdentity,
        destinationPath,
        stagingPath,
        stagingNativeIdentity,
        reservationPath,
        reservationNativeIdentity,
        hash: independentlyVerifiedHash,
        bytes,
      });
      await this.inject('after-stage-verified', {
        operationId,
        sourcePath,
        stagingPath,
        destinationPath,
      });
      this.throwIfCancelled(request.signal);

      outputHash = independentlyVerifiedHash;
      if (request.transformStaging) {
        transformationStarted = true;
        const transformationReceipt = await request.transformStaging({
          stagingPath,
          signal: request.signal,
        });
        if (transformationReceipt?.verified !== true) {
          throw new Error('Staging transformation did not return a verified receipt');
        }
        this.throwIfCancelled(request.signal);
        await this.requirePathIdentity(sourcePath, sourceIdentity);
        const transformedStats = await lstat(stagingPath, { bigint: true });
        if (transformedStats.isSymbolicLink() || !transformedStats.isFile()) {
          throw new Error('Transformed staging output must remain a regular non-symlink file');
        }
        stagingNativeIdentity = await this.freshNativeIdentity(stagingPath);
        if (!stagingNativeIdentity) {
          throw new Error('Transformed staging output identity could not be verified');
        }
        this.managedNativeIdentities.set(stagingPath, stagingNativeIdentity);
        outputHash = await hashFile(stagingPath, request.signal);
        bytes = Number(transformedStats.size);
        await this.journal.append({
          operationId,
          state: 'transformed',
          mode,
          sourcePath,
          sourceIdentity,
          destinationPath,
          stagingPath,
          stagingNativeIdentity,
          reservationPath,
          reservationNativeIdentity,
          hash: outputHash,
          sourceHash,
          outputHash,
          bytes,
          transformationVerified: true,
          ...(transformationReceipt === undefined ? {} : { transformationReceipt }),
        });
      }

      while (true) {
        await this.inject('before-publish', {
          operationId,
          sourcePath,
          stagingPath,
          destinationPath,
        });
        await this.revalidateDirectoryBindings();
        await this.revalidateDirectoryBinding(
          activeTargetDirectory.directoryPath,
          activeTargetDirectory.handle
        );
        try {
          const publication = await nativeFilesystem.hardLinkNoReplace(
            stagingPath,
            destinationPath,
            stagingNativeIdentity,
            request.signal
          );
          if (!publication.after) throw new Error('Native publication receipt is incomplete');
          stagingNativeIdentity = publication.after;
          this.managedNativeIdentities.set(stagingPath, publication.after);
          committed = true;
          break;
        } catch (error) {
          if (!this.isTargetExistsError(error)) throw error;
          if (expectedDestinationPath) {
            throw new Error('Exact preview target is no longer available');
          }
          await this.cleanupPath(reservationPath, residue, true, reservationNativeIdentity);
          reservation = await this.reserveCandidate(
            targetRelativePath,
            request.transformStaging ? undefined : sourceHash,
            operationId,
            activeTargetDirectory,
            undefined
          );
          destinationPath = reservation.candidatePath;
          reservationPath = reservation.reservationPath;
          reservationNativeIdentity = reservation.reservationNativeIdentity;
          if (reservation.duplicate) {
            committed = true;
            await this.cleanupPath(stagingPath, residue, true, stagingNativeIdentity);
            stagingPath = undefined;
            return await this.finishDuplicate(
              operationId,
              mode,
              sourcePath,
              sourceHandle,
              sourceIdentity,
              sourceHash,
              destinationPath,
              request.signal,
              residue,
              (protectedPath, protectedIdentity) => {
                stagingPath = protectedPath;
                stagingNativeIdentity = protectedIdentity;
              },
              () => {
                sourceDeleteIntentDurable = true;
              },
              activeTargetDirectory
            );
          }
        }
      }

      await this.syncDirectoryHandle(activeTargetDirectory.handle);
      if ((await hashFile(destinationPath)) !== outputHash) {
        throw new Error('Published destination hash verification failed');
      }
      this.committedByHash.set(this.hashKey(targetRelativePath, outputHash), destinationPath);
      await this.journal.append({
        operationId,
        state: 'committed',
        mode,
        sourcePath,
        sourceIdentity,
        sourceNativeIdentity,
        destinationPath,
        stagingPath,
        stagingNativeIdentity,
        reservationPath,
        reservationNativeIdentity,
        hash: outputHash,
        sourceHash,
        outputHash,
        bytes,
        committed: true,
      });
      await this.inject('after-commit', {
        operationId,
        sourcePath,
        stagingPath,
        destinationPath,
      });

      if (request.signal?.aborted) {
        await this.cleanupPath(stagingPath, residue, true, stagingNativeIdentity);
        await this.cleanupPath(reservationPath, residue, true, reservationNativeIdentity);
        if (residue.length === 0) {
          await this.journal.append({
            operationId,
            state: 'cancelled',
            mode,
            sourcePath,
            sourceIdentity,
            sourceNativeIdentity,
            destinationPath,
            hash: outputHash,
            sourceHash,
            outputHash,
            bytes,
            committed: true,
            sourceRetained: true,
            residue,
          });
        }
        return {
          operationId,
          sourcePath,
          destinationPath,
          status: 'cancelled',
          committed: true,
          sourceRetained: true,
          hash: outputHash,
          bytes,
          residue,
        };
      }

      if (mode === 'move') {
        await this.deleteSourceAfterCommit(
          operationId,
          mode,
          sourcePath,
          sourceHandle,
          sourceIdentity,
          sourceNativeIdentity!,
          sourceHash,
          outputHash,
          destinationPath,
          stagingPath,
          request.signal,
          () => {
            sourceDeleteIntentDurable = true;
          },
          activeTargetDirectory
        );
      }

      if (mode === 'move') {
        await this.releaseProtectedGuard(
          operationId,
          sourcePath,
          stagingPath,
          destinationPath,
          outputHash,
          residue,
          activeTargetDirectory
        );
      } else {
        await this.cleanupPath(stagingPath, residue, true, stagingNativeIdentity);
      }
      stagingPath = undefined;
      await this.cleanupPath(reservationPath, residue, true, reservationNativeIdentity);
      reservationPath = undefined;
      await this.journal.append({
        operationId,
        state: 'completed',
        mode,
        sourcePath,
        sourceIdentity,
        destinationPath,
        hash: outputHash,
        sourceHash,
        outputHash,
        bytes,
        committed: true,
        sourceRetained: mode !== 'move',
        residue,
      });

      return {
        operationId,
        sourcePath,
        destinationPath,
        status: mode === 'move' ? 'moved' : 'copied',
        committed: true,
        sourceRetained: mode !== 'move',
        hash: outputHash,
        bytes,
        residue,
      };
    } catch (error) {
      const cancelled = this.isAbortError(error) || request.signal?.aborted === true;
      if (stagingPath && !committed) {
        if (transformationStarted) {
          stagingNativeIdentity = await this.freshNativeIdentity(stagingPath);
        }
        await this.cleanupPath(stagingPath, residue, true, stagingNativeIdentity);
      }
      await this.cleanupPath(reservationPath, residue, true, reservationNativeIdentity);
      const sourceRetained = sourceIdentity
        ? await this.sourceIdentityMatchesPath(sourcePath, sourceIdentity)
        : await this.pathExists(sourcePath);
      const committedDestinationVerified = Boolean(
        stagingPath &&
          committed &&
          sourceRetained &&
          sourceDeleteIntentDurable &&
          outputHash &&
          destinationPath &&
          (await valueOrUndefined(this.regularFileHash(destinationPath))) === outputHash
      );
      if (committedDestinationVerified) {
        await this.cleanupPath(stagingPath, residue, true, stagingNativeIdentity, outputHash);
      } else if (
        cancelled &&
        sourceRetained &&
        stagingPath &&
        committed &&
        destinationPath &&
        (await this.isSameInode(stagingPath, destinationPath))
      ) {
        // Cancelled after publish with the source still in place: destination and source both
        // hold the bytes and the staging link shares the destination's inode, so it is redundant.
        // Reclaim it now instead of leaving a second hard link that later marks the media as
        // ambiguous. Genuine failures keep their guard for restart recovery.
        await this.cleanupPath(
          stagingPath,
          residue,
          true,
          await this.freshNativeIdentity(stagingPath)
        );
      }
      const message = error instanceof Error ? error.message : 'Unknown transaction failure';

      const recoverableNativeUnknown =
        error instanceof NativeFilesystemHelperClientError &&
        error.outcome === 'unknown' &&
        committed &&
        mode === 'move';
      try {
        if (recoverableNativeUnknown) throw error;
        if (!(committed && sourceRetained && residue.length > 0)) {
          await this.journal.append({
            operationId,
            state: cancelled ? 'cancelled' : 'failed',
            mode,
            sourcePath,
            sourceIdentity,
            destinationPath,
            stagingPath,
            reservationPath,
            hash: outputHash ?? sourceHash,
            sourceHash,
            outputHash,
            bytes,
            committed,
            sourceRetained,
            error: message,
            residue,
          });
        }
      } catch (journalError) {
        if (recoverableNativeUnknown && journalError === error) {
          // The durable source-delete-pending record remains authoritative. Startup recovery
          // must reconcile the helper's deterministic delete intent before terminalizing it.
        } else {
          residue.push(
            `journal: ${journalError instanceof Error ? journalError.message : 'Unknown error'}`
          );
        }
      }

      return {
        operationId,
        sourcePath,
        destinationPath: committed ? destinationPath : undefined,
        status: cancelled ? 'cancelled' : 'failed',
        committed,
        sourceRetained,
        hash: outputHash ?? sourceHash,
        bytes,
        error: message,
        residue,
      };
    } finally {
      await closeIgnoringErrors(sourceHandle);
      await closeIgnoringErrors(targetDirectory?.handle);
    }
  }

  private async executeSameFilesystemMove(
    operationId: string,
    sourcePath: string,
    sourceHandle: FileHandle,
    sourceIdentity: SourceIdentity,
    targetRelativePath: string,
    expectedDestinationPath: string | undefined,
    collisionMode: TransactionRequest['collisionMode'],
    signal: AbortSignal | undefined,
    activeTargetDirectory: TargetDirectoryBinding
  ): Promise<TransactionResult> {
    const bytes = sourceIdentity.size;
    const residue: string[] = [];

    // Reserve the candidate name without hash-based duplicate detection.
    const reservation = await this.reserveCandidate(
      targetRelativePath,
      undefined,
      operationId,
      activeTargetDirectory,
      expectedDestinationPath
    );
    const destinationPath = reservation.candidatePath;
    const reservationPath = reservation.reservationPath;
    const reservationNativeIdentity = reservation.reservationNativeIdentity;

    if (reservation.duplicate) {
      // Name-only reservation cannot detect duplicates; this branch should
      // not execute, but defensively fail clearly if it does.
      throw new Error('Name-only reservation detected an unexpected duplicate');
    }

    this.throwIfCancelled(signal);

    // Build the source native identity from sourceIdentity for the expected
    // parameter so the helper refuses to rename a swapped file.
    const sourceNativeIdentity: NativeFilesystemIdentity = {
      kind: 'unix',
      device: sourceIdentity.dev,
      inode: sourceIdentity.ino,
      links: sourceIdentity.nlink.toString(),
      size: sourceIdentity.size.toString(),
      mtimeNs: sourceIdentity.mtimeNs,
    };

    const nativeFilesystem = this.requireNativeFilesystem();
    try {
      await nativeFilesystem.renameNoReplace(
        sourcePath,
        destinationPath,
        sourceNativeIdentity,
        signal
      );
    } catch (renameError) {
      // On cross-device or any error, clean up the reservation and re-throw
      // so the caller can decide whether to fall back.
      await this.cleanupPath(reservationPath, residue, true, reservationNativeIdentity);
      throw renameError;
    }

    // Verify that the same inode landed at the destination.
    const destStats = await lstat(destinationPath, { bigint: true });
    const destIdentity = this.identityFromStats(destStats);
    if (
      destIdentity.dev !== sourceIdentity.dev ||
      destIdentity.ino !== sourceIdentity.ino ||
      destIdentity.size !== sourceIdentity.size
    ) {
      throw new Error('Renamed destination identity does not match the source');
    }

    // Durability: sync the target directory.
    await this.syncDirectoryHandle(activeTargetDirectory.handle);
    if (this.moveDurabilityError) {
      throw new Error(`Move durability cannot be proven: ${this.moveDurabilityError}`);
    }

    // Journal the entire operation atomically after the rename succeeds.
    // No journal records exist for this operation before this point on the
    // fast path, so a crash before here is a no-op (source still at origin,
    // reservation marker is orphaned and cleaned on recovery).
    await this.journal.append({
      operationId,
      state: 'planned',
      mode: 'move',
      sourcePath,
      sourceIdentity,
      bytes,
    });

    await this.journal.append({
      operationId,
      state: 'reserved',
      mode: 'move',
      sourcePath,
      sourceIdentity,
      destinationPath,
      reservationPath,
      reservationNativeIdentity,
    });

    await this.journal.append({
      operationId,
      state: 'committed',
      mode: 'move',
      sourcePath,
      sourceIdentity,
      destinationPath,
      bytes,
      committed: true,
    });

    // Clean up the reservation marker.
    await this.cleanupPath(reservationPath, residue, true, reservationNativeIdentity);

    await this.journal.append({
      operationId,
      state: 'completed',
      mode: 'move',
      sourcePath,
      sourceIdentity,
      destinationPath,
      bytes,
      committed: true,
      sourceRetained: false,
      residue,
    });

    return {
      operationId,
      sourcePath,
      destinationPath,
      status: 'moved',
      committed: true,
      sourceRetained: false,
      bytes,
      residue,
    };
  }

  async getLedger(): Promise<JournalOutcomes> {
    return this.journal.deriveOutcomes();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.isClosed = true;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const results = await Promise.allSettled([
      this.journal.close(),
      this.controlDirectoryHandle.close(),
      this.destinationDirectoryHandle.close(),
      this.stagingDirectoryHandle.close(),
      this.reservationDirectoryHandle.close(),
      this.objectDirectoryHandle.close(),
      this.nativeFilesystem?.close() ?? Promise.resolve(),
      TransactionalFileCore.releaseCoreLock(
        this.coreLockPath,
        this.coreLockToken,
        this.failureInjector
      ),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new Error(
        `Failed to close transaction core resources: ${failures
          .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
          .join('; ')}`
      );
    }
  }

  async listStagingResidue(): Promise<string[]> {
    await this.revalidateDirectoryBindings();
    return (await readdir(this.stagingRoot)).map((entry) => path.join(this.stagingRoot, entry));
  }

  private async finishDuplicate(
    operationId: string,
    mode: TransactionMode,
    sourcePath: string,
    sourceHandle: FileHandle,
    sourceIdentity: SourceIdentity,
    sourceHash: string,
    destinationPath: string,
    signal: AbortSignal | undefined,
    residue: string[],
    onProtectedGuard: (protectedPath: string, protectedIdentity: NativeFilesystemIdentity) => void,
    onSourceDeleteIntentDurable: () => void,
    targetDirectory: TargetDirectoryBinding
  ): Promise<TransactionResult> {
    this.committedByHash.set(
      this.hashKey(path.relative(this.destinationRoot, destinationPath), sourceHash),
      destinationPath
    );
    if (path.resolve(sourcePath) === path.resolve(destinationPath) || mode === 'copy') {
      await this.journal.append({
        operationId,
        state: 'duplicate',
        mode,
        sourcePath,
        sourceIdentity,
        destinationPath,
        hash: sourceHash,
        bytes: sourceIdentity.size,
        committed: true,
        sourceRetained: true,
      });
      return {
        operationId,
        sourcePath,
        destinationPath,
        status: 'duplicate',
        committed: true,
        sourceRetained: true,
        hash: sourceHash,
        bytes: sourceIdentity.size,
      };
    }

    const protectedPath = path.join(this.stagingRoot, `${operationId}.duplicate-guard`);
    const protectedCopy = await this.requireNativeFilesystem().stageCopy(
      sourcePath,
      protectedPath,
      sourceHash,
      signal
    );
    if (!protectedCopy.before || !protectedCopy.after || protectedCopy.sha256 !== sourceHash) {
      throw new Error('Duplicate protection receipt is incomplete');
    }
    this.managedNativeIdentities.set(protectedPath, protectedCopy.after);
    onProtectedGuard(protectedPath, protectedCopy.after);
    if ((await hashFile(protectedPath)) !== sourceHash) {
      throw new Error('Duplicate protection hash verification failed');
    }
    await this.journal.append({
      operationId,
      state: 'committed',
      mode,
      sourcePath,
      sourceIdentity,
      sourceNativeIdentity: protectedCopy.before,
      destinationPath,
      stagingPath: protectedPath,
      stagingNativeIdentity: protectedCopy.after,
      hash: sourceHash,
      bytes: sourceIdentity.size,
      committed: true,
    });
    await this.inject('after-commit', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    if (signal?.aborted) {
      await this.cleanupPath(protectedPath, residue, true, protectedCopy.after);
      if (residue.length === 0) {
        await this.journal.append({
          operationId,
          state: 'cancelled',
          mode,
          sourcePath,
          sourceIdentity,
          destinationPath,
          hash: sourceHash,
          committed: true,
          sourceRetained: true,
          residue,
        });
      }
      return {
        operationId,
        sourcePath,
        destinationPath,
        status: 'cancelled',
        committed: true,
        sourceRetained: true,
        hash: sourceHash,
        bytes: sourceIdentity.size,
        residue,
      };
    }

    await this.deleteSourceAfterCommit(
      operationId,
      mode,
      sourcePath,
      sourceHandle,
      sourceIdentity,
      protectedCopy.before,
      sourceHash,
      sourceHash,
      destinationPath,
      protectedPath,
      signal,
      onSourceDeleteIntentDurable,
      targetDirectory
    );
    await this.releaseProtectedGuard(
      operationId,
      sourcePath,
      protectedPath,
      destinationPath,
      sourceHash,
      residue,
      targetDirectory
    );
    await this.journal.append({
      operationId,
      state: 'completed',
      mode,
      sourcePath,
      sourceIdentity,
      destinationPath,
      hash: sourceHash,
      bytes: sourceIdentity.size,
      committed: true,
      sourceRetained: false,
      residue,
    });
    return {
      operationId,
      sourcePath,
      destinationPath,
      status: 'moved',
      committed: true,
      sourceRetained: false,
      hash: sourceHash,
      bytes: sourceIdentity.size,
      residue,
    };
  }

  private async deleteSourceAfterCommit(
    operationId: string,
    mode: TransactionMode,
    sourcePath: string,
    sourceHandle: FileHandle,
    sourceIdentity: SourceIdentity,
    sourceNativeIdentity: NativeFilesystemIdentity,
    sourceHash: string,
    outputHash: string,
    destinationPath: string,
    protectedPath: string,
    signal: AbortSignal | undefined,
    onSourceDeleteIntentDurable: () => void,
    targetDirectory: TargetDirectoryBinding
  ): Promise<void> {
    this.throwIfCancelled(signal);
    await this.inject('before-source-delete', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    await this.requirePathIdentity(sourcePath, sourceIdentity);
    if ((await hashFileHandle(sourceHandle, signal)) !== sourceHash) {
      throw new Error('Source hash changed before deletion');
    }
    await this.verifyProtectedCommit(destinationPath, protectedPath, outputHash, targetDirectory);
    const conservationPath = await this.ensureConservationObject(protectedPath, outputHash);
    const sourceDeleteId = randomUUID();
    const sourceDeleteReceiptPath = path.join(this.deleteReceiptRoot, `${sourceDeleteId}.json`);
    if (this.nativeFilesystem) {
      await this.nativeFilesystem.ensureControlDirectory(this.deleteReceiptRoot, signal);
    }
    const sourceDirectory = path.dirname(sourcePath);
    await this.inject('before-source-directory-preflight', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    await this.syncDirectory(sourceDirectory);
    await this.inject('after-source-directory-preflight', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    await this.journal.append({
      operationId,
      state: 'source-delete-pending',
      mode,
      sourcePath,
      sourceIdentity,
      destinationPath,
      stagingPath: protectedPath,
      conservationPath,
      sourceNativeIdentity,
      sourceDeleteId,
      sourceDeleteReceiptPath,
      hash: outputHash,
      sourceHash,
      outputHash,
      committed: true,
      sourceRetained: false,
    });
    onSourceDeleteIntentDurable();
    await this.inject('after-source-delete-pending', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    if (!this.nativeFilesystem) {
      throw new Error('Native filesystem helper is required for source deletion');
    }
    await this.requirePathIdentity(sourcePath, sourceIdentity);
    await this.verifyProtectedCommit(destinationPath, protectedPath, outputHash, targetDirectory);
    await this.requirePathIdentity(sourcePath, sourceIdentity);
    this.throwIfCancelled(signal);
    await this.inject('after-final-source-identity-before-unlink', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    const deletion = await this.nativeFilesystem.deleteSourceExact(
      sourcePath,
      sourceNativeIdentity,
      sourceHash,
      sourceDeleteId,
      sourceDeleteReceiptPath,
      signal
    );
    await this.inject('after-source-unlink', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    await this.restoreDestinationFromGuard(
      destinationPath,
      protectedPath,
      outputHash,
      targetDirectory
    );
    await this.inject('before-source-directory-post-unlink-sync', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    await this.syncDirectory(sourceDirectory);
    await this.inject('after-source-directory-post-unlink-sync', {
      operationId,
      sourcePath,
      stagingPath: protectedPath,
      destinationPath,
    });
    await this.journal.append({
      operationId,
      state: 'source-deleted',
      mode,
      sourcePath,
      sourceIdentity,
      destinationPath,
      stagingPath: protectedPath,
      conservationPath,
      sourceNativeIdentity,
      sourceDeleteId,
      sourceDeleteReceiptPath,
      sourceDeleteReceiptState: deletion.receiptState,
      hash: outputHash,
      sourceHash,
      outputHash,
      committed: true,
    });
  }

  private async verifyProtectedCommit(
    destinationPath: string,
    protectedPath: string,
    expectedHash: string,
    targetDirectory: TargetDirectoryBinding
  ): Promise<void> {
    await this.revalidateDirectoryBinding(targetDirectory.directoryPath, targetDirectory.handle);
    const [destinationHash, protectedHash] = await Promise.all([
      this.regularFileHash(destinationPath),
      this.regularFileHash(protectedPath),
    ]);
    if (destinationHash !== expectedHash || protectedHash !== expectedHash) {
      throw new Error('Committed destination or protected hardlink failed revalidation');
    }
  }

  private async restoreDestinationFromGuard(
    destinationPath: string,
    protectedPath: string,
    expectedHash: string,
    targetDirectory: TargetDirectoryBinding
  ): Promise<void> {
    await this.revalidateDirectoryBinding(targetDirectory.directoryPath, targetDirectory.handle);
    if ((await this.regularFileHash(protectedPath)) !== expectedHash) {
      throw new Error('Protected hardlink failed post-unlink verification');
    }
    if ((await this.regularFileHash(destinationPath)) === expectedHash) return;
    if (await this.pathExists(destinationPath)) {
      throw new Error('Published destination was replaced after source deletion');
    }

    try {
      const protectedIdentity = this.managedNativeIdentities.get(protectedPath);
      if (!protectedIdentity) throw new Error('Protected guard has no native identity receipt');
      await this.requireNativeFilesystem().hardLinkNoReplace(
        protectedPath,
        destinationPath,
        protectedIdentity
      );
    } catch (error) {
      if (!this.isTargetExistsError(error)) throw error;
    }
    if ((await this.regularFileHash(destinationPath)) !== expectedHash) {
      throw new Error('Published destination could not be restored from protected hardlink');
    }
  }

  private async releaseProtectedGuard(
    operationId: string,
    sourcePath: string,
    protectedPath: string,
    destinationPath: string,
    expectedHash: string,
    residue: string[],
    targetDirectory: TargetDirectoryBinding
  ): Promise<void> {
    try {
      await this.cleanupFailureInjector?.(protectedPath);
      await this.restoreDestinationFromGuard(
        destinationPath,
        protectedPath,
        expectedHash,
        targetDirectory
      );
      const [destinationHash, protectedHash] = await Promise.all([
        this.regularFileHash(destinationPath),
        this.regularFileHash(protectedPath),
      ]);
      if (destinationHash !== expectedHash || protectedHash !== expectedHash) {
        throw new Error('Guard release verification failed');
      }
      await this.inject('after-guard-release-verification', {
        operationId,
        sourcePath,
        stagingPath: protectedPath,
        destinationPath,
      });
      const protectedIdentity = this.managedNativeIdentities.get(protectedPath);
      if (!protectedIdentity) throw new Error('Protected guard has no native identity receipt');
      await this.requireNativeFilesystem().removeManagedExact(protectedPath, protectedIdentity);
      this.managedNativeIdentities.delete(protectedPath);
      await this.inject('after-guard-unlink', {
        operationId,
        sourcePath,
        stagingPath: protectedPath,
        destinationPath,
      });
      if ((await this.regularFileHash(destinationPath)) !== expectedHash) {
        throw new Error('Destination equivalence was lost during exact guard release');
      }
    } catch (error) {
      residue.push(
        `${protectedPath}: ${error instanceof Error ? error.message : 'Unknown guard-release error'}`
      );
      throw error;
    }
  }

  private async ensureConservationObject(
    protectedPath: string,
    expectedHash: string
  ): Promise<string> {
    const objectPath = path.join(this.objectRoot, expectedHash);
    await this.revalidateDirectoryBindings();
    await this.syncRegularFile(protectedPath);
    await this.cleanupConservationAliases(objectPath, expectedHash);
    const existingHash = await this.singleLinkedRegularFileHash(objectPath);
    if (existingHash === expectedHash) return objectPath;
    if (existingHash !== undefined || (await this.pathExists(objectPath))) {
      throw new Error('Conservation object path is occupied by different content');
    }

    const temporaryPath = path.join(
      this.objectRoot,
      `.${expectedHash}.${process.pid}.${randomUUID()}.tmp`
    );
    let temporaryIdentity: NativeFilesystemIdentity | undefined;
    try {
      const copied = await this.requireNativeFilesystem().stageCopy(
        protectedPath,
        temporaryPath,
        expectedHash
      );
      if (
        !copied.after ||
        copied.sha256 !== expectedHash ||
        (await hashFile(temporaryPath)) !== expectedHash
      ) {
        throw new Error('Conservation object staging failed independent hash verification');
      }
      temporaryIdentity = copied.after;
      this.managedNativeIdentities.set(temporaryPath, copied.after);
      try {
        const publication = await this.requireNativeFilesystem().hardLinkNoReplace(
          temporaryPath,
          objectPath,
          copied.after
        );
        if (!publication.after) throw new Error('Conservation publication receipt is incomplete');
        temporaryIdentity = publication.after;
        this.managedNativeIdentities.set(temporaryPath, publication.after);
        this.managedNativeIdentities.set(objectPath, publication.after);
      } catch (error) {
        if (!this.isTargetExistsError(error)) throw error;
      }
    } finally {
      if (temporaryIdentity) {
        const residue: string[] = [];
        await this.cleanupPath(temporaryPath, residue, false, temporaryIdentity);
        if (residue.length > 0) throw new Error(residue.join('; '));
      }
    }
    await this.cleanupConservationAliases(objectPath, expectedHash);
    if ((await this.singleLinkedRegularFileHash(objectPath)) !== expectedHash) {
      throw new Error('Conservation object failed durable hash verification');
    }
    return objectPath;
  }

  private async cleanupConservationAliases(
    objectPath: string,
    expectedHash: string
  ): Promise<void> {
    let objectStats;
    try {
      objectStats = await lstat(objectPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (objectStats.isSymbolicLink() || !objectStats.isFile()) return;
    let removed = false;
    for (const entry of await readdir(this.objectRoot)) {
      if (!entry.startsWith(`.${expectedHash}.`) || !entry.endsWith('.tmp')) continue;
      const aliasPath = path.join(this.objectRoot, entry);
      const aliasStats = await valueOrUndefined(lstat(aliasPath, { bigint: true }));
      if (
        aliasStats &&
        !aliasStats.isSymbolicLink() &&
        aliasStats.isFile() &&
        aliasStats.dev === objectStats.dev &&
        aliasStats.ino === objectStats.ino
      ) {
        const residue: string[] = [];
        await this.cleanupPath(aliasPath, residue, false);
        removed = residue.length === 0;
      }
    }
    if (removed) await this.syncDirectory(this.objectRoot);
  }

  private async singleLinkedRegularFileHash(filePath: string): Promise<string | undefined> {
    try {
      await this.revalidateManagedPath(filePath);
      const stats = await lstat(filePath, { bigint: true });
      if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n) return undefined;
      return await hashFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async syncRegularFile(filePath: string): Promise<void> {
    if (!this.durableFileOperations) return;
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('Protected commit is not a regular file');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async reserveCandidate(
    targetRelativePath: string,
    sourceHash: string | undefined,
    operationId: string,
    targetDirectory: TargetDirectoryBinding,
    expectedDestinationPath?: string
  ): Promise<Reservation> {
    await this.revalidateDirectoryBindings();
    return this.withAllocationLock(async () => {
      await this.revalidateDirectoryBinding(targetDirectory.directoryPath, targetDirectory.handle);
      if (sourceHash !== undefined) {
        const key = this.hashKey(targetRelativePath, sourceHash);
        const cached = this.committedByHash.get(key);
        if (cached && (await this.regularFileHash(cached)) === sourceHash) {
          return { candidatePath: cached, duplicate: true };
        }
      }

      let counter = expectedDestinationPath ? 0 : (this.nextCounters.get(targetRelativePath) ?? 0);
      while (true) {
        await this.revalidateDirectoryBinding(
          targetDirectory.directoryPath,
          targetDirectory.handle
        );
        const candidatePath = path.join(
          targetDirectory.directoryPath,
          this.collisionFilename(path.basename(targetRelativePath), counter)
        );
        if (expectedDestinationPath && candidatePath !== expectedDestinationPath) {
          throw new Error('Exact preview target does not match the requested relative target');
        }
        if (sourceHash !== undefined) {
          const existingHash = await this.regularFileHash(candidatePath);
          if (existingHash === sourceHash) {
            this.committedByHash.set(this.hashKey(targetRelativePath, sourceHash), candidatePath);
            this.nextCounters.set(targetRelativePath, counter + 1);
            return { candidatePath, duplicate: true };
          }
          if (existingHash !== undefined || (await this.pathExists(candidatePath))) {
            if (expectedDestinationPath) {
              throw new Error('Exact preview target is no longer available');
            }
            counter++;
            continue;
          }
        } else {
          if (await this.pathExists(candidatePath)) {
            if (expectedDestinationPath) {
              throw new Error('Exact preview target is no longer available');
            }
            counter++;
            continue;
          }
        }

        const reservationName = `${createHash('sha256').update(candidatePath).digest('hex')}.reserve`;
        const reservationPath = path.join(this.reservationRoot, reservationName);
        let reservationNativeIdentity: NativeFilesystemIdentity | undefined;
        try {
          await this.revalidateDirectoryBinding(
            this.reservationRoot,
            this.reservationDirectoryHandle
          );
          const marker = await this.requireNativeFilesystem().writeMarkerNew(
            reservationPath,
            JSON.stringify({ operationId, candidatePath })
          );
          if (!marker.after) throw new Error('Native reservation receipt is incomplete');
          reservationNativeIdentity = marker.after;
          this.managedNativeIdentities.set(reservationPath, marker.after);
        } catch (error) {
          if (this.isTargetExistsError(error)) {
            if (expectedDestinationPath) {
              throw new Error('Exact preview target is no longer available');
            }
            counter++;
            continue;
          }
          throw error;
        }

        if (await this.pathExists(candidatePath)) {
          await this.cleanupPath(reservationPath, [], false, reservationNativeIdentity);
          if (expectedDestinationPath) {
            throw new Error('Exact preview target is no longer available');
          }
          counter++;
          continue;
        }

        this.nextCounters.set(targetRelativePath, counter + 1);
        return {
          candidatePath,
          reservationPath,
          reservationNativeIdentity,
          duplicate: false,
        };
      }
    });
  }

  private async findPreviewCandidate(
    targetRelativePath: string,
    sourceHash: string
  ): Promise<Reservation> {
    let counter = 0;
    while (true) {
      const candidatePath = path.join(
        this.destinationRoot,
        path.dirname(targetRelativePath),
        this.collisionFilename(path.basename(targetRelativePath), counter)
      );
      const existingHash = await this.regularFileHash(candidatePath);
      if (existingHash === sourceHash) return { candidatePath, duplicate: true };
      if (existingHash === undefined && !(await this.pathExists(candidatePath))) {
        return { candidatePath, duplicate: false };
      }
      counter++;
    }
  }

  private async recoverInterruptedOperations(): Promise<void> {
    const aggregate = await this.journal.foldRecords(
      new Map<string, JournalRecord>(),
      (records, record) => {
        records.set(record.operationId, { ...records.get(record.operationId), ...record });
        return records;
      }
    );

    for (const record of aggregate.values()) {
      if (record.stagingPath && record.stagingNativeIdentity) {
        this.managedNativeIdentities.set(record.stagingPath, record.stagingNativeIdentity);
      }
      if (record.reservationPath && record.reservationNativeIdentity) {
        this.managedNativeIdentities.set(record.reservationPath, record.reservationNativeIdentity);
      }
      if (record.conservationPath && record.conservationNativeIdentity) {
        this.managedNativeIdentities.set(
          record.conservationPath,
          record.conservationNativeIdentity
        );
      }
      if (record.quarantined || record.recoveryFinalized) continue;
      if (['completed', 'duplicate', 'cancelled'].includes(record.state)) {
        await this.reclaimTerminalResidue(record);
        continue;
      }
      try {
        await this.validateRecoveryRecordPaths(record);
      } catch (error) {
        if (record.state === 'source-delete-pending') continue;
        await this.journal.append({
          operationId: record.operationId,
          state: 'failed',
          mode: record.mode,
          committed: record.committed === true,
          quarantined: true,
          error: `Quarantined hostile recovery record: ${
            error instanceof Error ? error.message : 'Unknown path validation error'
          }`,
        });
        continue;
      }
      let recoveryDestinationHandle: FileHandle | undefined;
      try {
        if (record.destinationPath) {
          recoveryDestinationHandle = await TransactionalFileCore.openTrustedDirectory(
            path.dirname(path.resolve(record.destinationPath))
          );
        }
        await this.inject('before-recovery-mutation', {
          operationId: record.operationId,
          sourcePath: record.sourcePath ?? '',
          stagingPath: record.stagingPath,
          destinationPath: record.destinationPath,
        });
        const destinationPath = this.recoveryDestinationPath(
          record.destinationPath,
          recoveryDestinationHandle
        );
        const stagingPath = this.anchoredRecoveryPath(
          record.stagingPath,
          this.stagingRoot,
          this.stagingDirectoryHandle
        );
        this.anchoredRecoveryPath(
          record.reservationPath,
          this.reservationRoot,
          this.reservationDirectoryHandle
        );
        const conservationPath = this.anchoredRecoveryPath(
          record.conservationPath,
          this.objectRoot,
          this.objectDirectoryHandle
        );
        if (record.state === 'source-delete-pending') {
          if (!this.hasCompleteSourceDeleteIntent(record)) continue;
          if (!this.nativeFilesystem) {
            throw new Error('Native filesystem helper is required for source-delete recovery');
          }
          try {
            const reconciliation = await this.nativeFilesystem.reconcileSourceDelete(
              record.sourcePath,
              record.sourceNativeIdentity,
              record.sourceHash ?? record.hash,
              record.sourceDeleteId,
              record.sourceDeleteReceiptPath
            );
            if (reconciliation.state === 'source-retained') {
              record.sourceRetained = true;
            } else {
              await this.journal.append({
                ...record,
                state: 'source-deleted',
                sourceRetained: false,
                sourceDeleteReceiptState: reconciliation.receiptState,
              });
              record.state = 'source-deleted';
              record.sourceRetained = false;
              record.sourceDeleteReceiptState = reconciliation.receiptState;
            }
          } catch (error) {
            if (error instanceof NativeFilesystemHelperClientError && error.outcome === 'unknown') {
              continue;
            }
            throw error;
          }
        }
        if (record.committed && record.destinationPath && record.hash) {
          const expectedOutputHash = record.outputHash ?? record.hash;
          let destinationHash = await this.regularFileHash(destinationPath!);
          const stagingHash = stagingPath ? await this.regularFileHash(stagingPath) : undefined;
          const conservationHash = conservationPath
            ? await this.regularFileHash(conservationPath)
            : undefined;
          const protectedPath =
            stagingHash === expectedOutputHash
              ? record.stagingPath
              : conservationHash === expectedOutputHash
                ? record.conservationPath
                : undefined;
          if (destinationHash !== expectedOutputHash && protectedPath) {
            if (destinationHash === undefined && !(await this.pathExists(destinationPath!))) {
              const restored = await this.requireNativeFilesystem().stageCopy(
                protectedPath,
                record.destinationPath,
                expectedOutputHash
              );
              if (!restored.after || restored.sha256 !== expectedOutputHash) {
                throw new Error('Recovered destination failed protected-copy verification');
              }
              destinationHash = await this.regularFileHash(destinationPath!);
            }
          }

          if (destinationHash === expectedOutputHash) {
            const sourceRetained = await this.recordedSourceStillRetained(record);
            const residue: string[] = [];
            await this.cleanupPath(
              record.stagingPath,
              residue,
              false,
              record.stagingNativeIdentity,
              expectedOutputHash
            );
            await this.cleanupPath(
              record.reservationPath,
              residue,
              false,
              record.reservationNativeIdentity
            );
            if (residue.length > 0) {
              await this.journal.append({
                ...record,
                state:
                  record.state === 'source-delete-pending' || record.state === 'source-deleted'
                    ? record.state
                    : 'committed',
                committed: true,
                sourceRetained: record.mode === 'copy' ? true : sourceRetained,
                recoveryFinalized: false,
                residue,
              });
              continue;
            }
            await this.journal.append({
              ...record,
              state: record.mode === 'copy' || !sourceRetained ? 'completed' : 'cancelled',
              committed: true,
              sourceRetained: record.mode === 'copy' ? true : sourceRetained,
              recoveryFinalized: true,
              residue,
            });
            continue;
          }

          const sourceRetained = await this.recordedSourceStillRetained(record);
          await this.journal.append({
            ...record,
            state: 'failed',
            committed: true,
            sourceRetained,
            recoveryFinalized: true,
            error: 'Committed recovery destination is occupied or failed hash verification',
          });
          continue;
        }

        if (!record.committed) {
          const residue: string[] = [];
          await this.cleanupPath(record.stagingPath, residue, false, record.stagingNativeIdentity);
          await this.cleanupPath(
            record.reservationPath,
            residue,
            false,
            record.reservationNativeIdentity
          );
          if (!['failed', 'cancelled'].includes(record.state)) {
            await this.journal.append({
              ...record,
              state: 'cancelled',
              committed: false,
              residue,
            });
          }
        }
      } finally {
        if (recoveryDestinationHandle) await recoveryDestinationHandle.close();
      }
    }

    const anchoredReservationRoot =
      this.anchoredDirectoryPath(this.reservationDirectoryHandle) ?? this.reservationRoot;
    for (const entry of await readdir(anchoredReservationRoot)) {
      await this.cleanupPath(path.join(this.reservationRoot, entry), [], false);
    }
  }

  private recoveryDestinationPath(
    candidatePath: string | undefined,
    parentHandle: FileHandle | undefined
  ): string | undefined {
    if (!candidatePath) return undefined;
    if (!parentHandle) throw new Error('Recovery destination parent is unavailable');
    const parentPath = path.dirname(path.resolve(candidatePath));
    const anchoredParent = this.anchoredDirectoryPath(parentHandle) ?? parentPath;
    return path.join(anchoredParent, path.basename(candidatePath));
  }

  private async recordedSourceStillRetained(record: JournalRecord): Promise<boolean> {
    if (!record.sourcePath || !record.sourceIdentity) return false;
    return this.sourceIdentityMatchesPath(record.sourcePath, record.sourceIdentity);
  }

  private async sourceIdentityMatchesPath(
    sourcePath: string,
    sourceIdentity: SourceIdentity
  ): Promise<boolean> {
    try {
      const stats = await lstat(sourcePath, { bigint: true });
      return (
        !stats.isSymbolicLink() &&
        stats.isFile() &&
        stats.dev.toString() === sourceIdentity.dev &&
        stats.ino.toString() === sourceIdentity.ino &&
        Number(stats.nlink) === sourceIdentity.nlink &&
        Number(stats.size) === sourceIdentity.size &&
        stats.mtimeNs.toString() === sourceIdentity.mtimeNs &&
        stats.ctimeNs.toString() === sourceIdentity.ctimeNs
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async validateRecoveryRecordPaths(record: JournalRecord): Promise<void> {
    await this.validateControlledRecoveryPath(
      record.destinationPath,
      this.destinationRoot,
      this.destinationDirectoryHandle,
      'destination',
      true
    );
    await this.validateControlledRecoveryPath(
      record.stagingPath,
      this.stagingRoot,
      this.stagingDirectoryHandle,
      'staging'
    );
    await this.validateControlledRecoveryPath(
      record.reservationPath,
      this.reservationRoot,
      this.reservationDirectoryHandle,
      'reservation'
    );
    await this.validateControlledRecoveryPath(
      record.conservationPath,
      this.objectRoot,
      this.objectDirectoryHandle,
      'conservation'
    );
    if (record.state === 'source-delete-pending' && !this.hasCompleteSourceDeleteIntent(record)) {
      throw new Error('Source-delete intent is incomplete or malformed');
    }
    if (record.sourceDeleteReceiptPath) {
      const receiptPath = path.resolve(record.sourceDeleteReceiptPath);
      const deleteId = record.sourceDeleteId;
      const canonicalUuidV4 =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (
        !deleteId ||
        !canonicalUuidV4.test(deleteId) ||
        path.dirname(receiptPath) !== this.deleteReceiptRoot ||
        path.basename(receiptPath) !== `${deleteId}.json`
      ) {
        throw new Error('Source-delete receipt path escapes its transaction root');
      }
    }
  }

  private hasCompleteSourceDeleteIntent(
    record: JournalRecord
  ): record is JournalRecord &
    Required<
      Pick<
        JournalRecord,
        | 'sourcePath'
        | 'sourceNativeIdentity'
        | 'hash'
        | 'sourceDeleteId'
        | 'sourceDeleteReceiptPath'
      >
    > {
    return (
      typeof record.sourcePath === 'string' &&
      record.sourcePath.length > 0 &&
      record.sourceNativeIdentity !== undefined &&
      typeof record.hash === 'string' &&
      /^[0-9a-f]{64}$/.test(record.hash) &&
      typeof record.sourceDeleteId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        record.sourceDeleteId
      ) &&
      typeof record.sourceDeleteReceiptPath === 'string' &&
      record.sourceDeleteReceiptPath.length > 0
    );
  }

  private async validateControlledRecoveryPath(
    candidatePath: string | undefined,
    expectedParent: string,
    directoryHandle: FileHandle,
    label: string,
    allowNested = false
  ): Promise<void> {
    if (!candidatePath) return;
    const anchoredPath = this.anchoredRecoveryPath(
      candidatePath,
      expectedParent,
      directoryHandle,
      allowNested
    )!;
    if (allowNested) {
      const anchoredRoot = this.anchoredDirectoryPath(directoryHandle) ?? expectedParent;
      const relative = path.relative(expectedParent, path.resolve(candidatePath));
      let current = anchoredRoot;
      for (const component of relative.split(path.sep).slice(0, -1)) {
        current = path.join(current, component);
        const ancestorStats = await lstat(current);
        if (ancestorStats.isSymbolicLink() || !ancestorStats.isDirectory()) {
          throw new Error(`${label} ancestor is not a regular non-symlink directory`);
        }
      }
    }
    try {
      const stats = await lstat(anchoredPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`${label} path is not a regular non-symlink file`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private anchoredRecoveryPath(
    candidatePath: string | undefined,
    expectedParent: string,
    directoryHandle: FileHandle,
    allowNested = false
  ): string | undefined {
    if (!candidatePath) return undefined;
    const resolvedCandidate = path.resolve(candidatePath);
    const relative = path.relative(expectedParent, resolvedCandidate);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      (!allowNested && path.dirname(resolvedCandidate) !== expectedParent) ||
      (allowNested && relative.split(path.sep)[0].toLocaleLowerCase('en-US') === '.meta-mover')
    ) {
      throw new Error('Recovery path escapes its transaction root');
    }
    const anchoredDirectory = this.anchoredDirectoryPath(directoryHandle) ?? expectedParent;
    return path.join(anchoredDirectory, allowNested ? relative : path.basename(resolvedCandidate));
  }

  private anchoredDirectoryPath(directoryHandle: FileHandle): string | undefined {
    return process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}` : undefined;
  }

  private async revalidateDirectoryBindings(): Promise<void> {
    await Promise.all([
      this.revalidateDirectoryBinding(this.controlRoot, this.controlDirectoryHandle),
      this.revalidateDirectoryBinding(this.destinationRoot, this.destinationDirectoryHandle),
      this.revalidateDirectoryBinding(this.stagingRoot, this.stagingDirectoryHandle),
      this.revalidateDirectoryBinding(this.reservationRoot, this.reservationDirectoryHandle),
      this.revalidateDirectoryBinding(this.objectRoot, this.objectDirectoryHandle),
    ]);
  }

  private async revalidateDirectoryBinding(
    directoryPath: string,
    handle: FileHandle
  ): Promise<void> {
    const [current, captured] = await Promise.all([
      lstat(directoryPath, { bigint: true }),
      handle.stat({ bigint: true }),
    ]);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== captured.dev ||
      current.ino !== captured.ino
    ) {
      throw new Error(`Transaction directory identity changed: ${directoryPath}`);
    }
  }

  private async revalidateManagedPath(filePath: string): Promise<void> {
    const resolved = path.resolve(filePath);
    if (resolved === this.controlRoot || resolved.startsWith(`${this.controlRoot}${path.sep}`)) {
      await this.revalidateDirectoryBinding(this.controlRoot, this.controlDirectoryHandle);
    }
    if (resolved === this.stagingRoot || resolved.startsWith(`${this.stagingRoot}${path.sep}`)) {
      await this.revalidateDirectoryBinding(this.stagingRoot, this.stagingDirectoryHandle);
    }
    if (
      resolved === this.reservationRoot ||
      resolved.startsWith(`${this.reservationRoot}${path.sep}`)
    ) {
      await this.revalidateDirectoryBinding(this.reservationRoot, this.reservationDirectoryHandle);
    }
    if (
      resolved === this.destinationRoot ||
      resolved.startsWith(`${this.destinationRoot}${path.sep}`)
    ) {
      await this.revalidateDirectoryBinding(this.destinationRoot, this.destinationDirectoryHandle);
    }
    if (resolved === this.objectRoot || resolved.startsWith(`${this.objectRoot}${path.sep}`)) {
      await this.revalidateDirectoryBinding(this.objectRoot, this.objectDirectoryHandle);
    }
  }

  private async verifyMoveDurability(): Promise<void> {
    const id = randomUUID();
    const stageProbe = path.join(this.stagingRoot, `${id}.probe`);
    const finalProbe = path.join(this.destinationRoot, `.meta-mover-commit-probe-${id}`);
    let stageIdentity: NativeFilesystemIdentity | undefined;
    let finalIdentity: NativeFilesystemIdentity | undefined;
    try {
      const stage = await this.requireNativeFilesystem().writeMarkerNew(
        stageProbe,
        'durability-probe'
      );
      if (!stage.after) throw new Error('Durability probe staging receipt is incomplete');
      stageIdentity = stage.after;
      const publication = await this.requireNativeFilesystem().hardLinkNoReplace(
        stageProbe,
        finalProbe,
        stage.after
      );
      if (!publication.after) throw new Error('Durability probe publication receipt is incomplete');
      stageIdentity = publication.after;
      finalIdentity = publication.after;
    } finally {
      const nativeFilesystem = this.nativeFilesystem;
      if (nativeFilesystem && finalIdentity) {
        try {
          await nativeFilesystem.removeManagedExact(finalProbe, finalIdentity);
          stageIdentity = this.identityAfterOneLinkRemoval(finalIdentity);
        } catch {
          // The surviving stage still has the original link count when exact final removal fails.
        }
      }
      if (nativeFilesystem && stageIdentity) {
        const refreshedHash = await valueOrUndefined(hashFile(stageProbe));
        if (refreshedHash) {
          await this.cleanupPath(stageProbe, [], false, stageIdentity);
        }
      }
    }
  }

  private async syncDirectory(directoryPath: string): Promise<void> {
    if (!this.durableFileOperations) return;
    await this.revalidateManagedPath(directoryPath);
    const handle = await open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectoryHandle(handle: FileHandle): Promise<void> {
    if (this.durableFileOperations) await handle.sync();
  }

  private async isSameInode(left: string, right: string): Promise<boolean> {
    try {
      const [a, b] = await Promise.all([
        lstat(left, { bigint: true }),
        lstat(right, { bigint: true }),
      ]);
      return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
    } catch {
      return false;
    }
  }

  private async freshNativeIdentity(
    filePath: string
  ): Promise<NativeFilesystemIdentity | undefined> {
    try {
      const stats = await lstat(filePath, { bigint: true });
      if (!stats.isFile()) return undefined;
      return {
        kind: 'unix',
        device: stats.dev.toString(),
        inode: stats.ino.toString(),
        links: stats.nlink.toString(),
        size: stats.size.toString(),
        mtimeNs: stats.mtimeNs.toString(),
      };
    } catch {
      return undefined;
    }
  }

  // Terminal journal records (completed, cancelled, duplicate) must not leave staging
  // links or reservation markers behind. A cancelled job aborts the helper channel mid-cleanup,
  // so every core open sweeps what earlier runs could not finish. Staging is only reclaimed when
  // the bytes provably live elsewhere: the destination shares the inode, the operation never
  // committed (staging is a partial copy of a retained source), or the source was retained.
  private async reclaimTerminalResidue(record: JournalRecord): Promise<void> {
    const residue: string[] = [];
    if (record.stagingPath) {
      let stagingPath: string | undefined;
      try {
        stagingPath = this.anchoredRecoveryPath(
          record.stagingPath,
          this.stagingRoot,
          this.stagingDirectoryHandle
        );
      } catch {
        stagingPath = undefined;
      }
      if (stagingPath && (await this.pathExists(stagingPath))) {
        const twin =
          record.destinationPath !== undefined &&
          (await this.isSameInode(stagingPath, record.destinationPath));
        const safe = twin || record.committed !== true || record.sourceRetained === true;
        if (safe) {
          await this.cleanupPath(
            stagingPath,
            residue,
            false,
            await this.freshNativeIdentity(stagingPath)
          );
        }
      }
    }
    if (record.reservationPath) {
      let reservationPath: string | undefined;
      try {
        reservationPath = this.anchoredRecoveryPath(
          record.reservationPath,
          this.reservationRoot,
          this.reservationDirectoryHandle
        );
      } catch {
        reservationPath = undefined;
      }
      if (reservationPath && (await this.pathExists(reservationPath))) {
        await this.cleanupPath(
          reservationPath,
          residue,
          false,
          await this.freshNativeIdentity(reservationPath)
        );
      }
    }
  }

  private async cleanupPath(
    filePath: string | undefined,
    residue: string[],
    injectFailure = true,
    expectedIdentity?: NativeFilesystemIdentity,
    expectedHash?: string
  ): Promise<void> {
    if (!filePath) return;
    try {
      if (injectFailure) await this.cleanupFailureInjector?.(filePath);
      if (!(await this.pathExists(filePath))) {
        this.managedNativeIdentities.delete(filePath);
        return;
      }
      const identity = expectedIdentity ?? this.managedNativeIdentities.get(filePath);
      const nativeFilesystem = this.requireNativeFilesystem();
      if (identity) {
        try {
          await nativeFilesystem.removeManagedExact(filePath, identity);
          this.managedNativeIdentities.delete(filePath);
          return;
        } catch (error) {
          if (error instanceof NativeFilesystemHelperClientError && error.outcome === 'unknown') {
            throw error;
          }
          if (!expectedHash) {
            throw new Error(
              `Managed cleanup refused identity drift at ${filePath}: ${
                error instanceof Error ? error.message : 'exact cleanup failed'
              }`
            );
          }
          const probePath = path.join(this.stagingRoot, `.cleanup-${randomUUID()}.part`);
          const refreshed = await nativeFilesystem.stageCopy(filePath, probePath, expectedHash);
          if (
            !refreshed.before ||
            !refreshed.after ||
            refreshed.sha256 !== expectedHash ||
            (await hashFile(probePath)) !== expectedHash
          ) {
            throw new Error('Managed cleanup identity refresh receipt is incomplete');
          }
          await nativeFilesystem.removeManagedExact(probePath, refreshed.after);
          if (!this.isOneLinkRemovalOfSameIdentity(identity, refreshed.before)) {
            throw new Error(`Managed cleanup refused non-link identity drift at ${filePath}`);
          }
          await nativeFilesystem.removeManagedExact(filePath, refreshed.before);
          this.managedNativeIdentities.delete(filePath);
          return;
        }
      }
      const currentHash = await hashFile(filePath);
      const probePath = path.join(this.stagingRoot, `.cleanup-${randomUUID()}.part`);
      const refreshed = await nativeFilesystem.stageCopy(filePath, probePath, currentHash);
      if (!refreshed.before || !refreshed.after || refreshed.sha256 !== currentHash) {
        throw new Error('Managed cleanup identity refresh receipt is incomplete');
      }
      await nativeFilesystem.removeManagedExact(probePath, refreshed.after);
      await nativeFilesystem.removeManagedExact(filePath, refreshed.before);
      this.managedNativeIdentities.delete(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      residue.push(
        `${filePath}: ${error instanceof Error ? error.message : 'Unknown cleanup error'}`
      );
    }
  }

  private collisionFilename(filename: string, counter: number): string {
    if (counter === 0) return filename;
    const parsed = path.parse(filename);
    const suffix = counter < 100 ? counter.toString().padStart(2, '0') : counter.toString();
    return `${parsed.name}_${suffix}${parsed.ext}`;
  }

  private isTargetExistsError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return (
      code === 'EEXIST' ||
      (error instanceof NativeFilesystemHelperClientError && error.code === 'target-exists')
    );
  }

  private isCrossDeviceError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return (
      code === 'EXDEV' ||
      (error instanceof NativeFilesystemHelperClientError && error.code === 'cross-device')
    );
  }

  private identityAfterOneLinkRemoval(
    identity: NativeFilesystemIdentity
  ): NativeFilesystemIdentity {
    const links = BigInt(identity.links);
    if (links <= 1n) {
      throw new Error('Managed identity cannot survive removal of its final link');
    }
    return { ...identity, links: (links - 1n).toString() };
  }

  private isOneLinkRemovalOfSameIdentity(
    expected: NativeFilesystemIdentity,
    observed: NativeFilesystemIdentity
  ): boolean {
    if (expected.kind !== observed.kind) return false;
    const expectedLinks = BigInt(expected.links);
    const observedLinks = BigInt(observed.links);
    const commonIdentityMatches =
      expected.size === observed.size && expected.mtimeNs === observed.mtimeNs;
    if (!commonIdentityMatches || expectedLinks !== observedLinks + 1n) return false;
    return expected.kind === 'unix' && observed.kind === 'unix'
      ? expected.device === observed.device && expected.inode === observed.inode
      : expected.kind === 'windows' && observed.kind === 'windows'
        ? expected.volumeSerial === observed.volumeSerial && expected.fileId === observed.fileId
        : false;
  }

  private normalizeTargetRelativePath(targetPath: string): string {
    if (
      !targetPath ||
      targetPath.includes('\0') ||
      path.posix.isAbsolute(targetPath) ||
      path.win32.isAbsolute(targetPath)
    ) {
      throw new Error('Target must be a safe relative path');
    }
    const components = targetPath.split(/[\\/]/);
    if (
      components.some((component) => !component || component === '.' || component === '..') ||
      components[0].toLocaleLowerCase('en-US') === '.meta-mover'
    ) {
      throw new Error('Target must be a safe relative path outside transaction controls');
    }
    const normalized = components.join(path.sep);
    const resolved = path.resolve(this.destinationRoot, normalized);
    const relative = path.relative(this.destinationRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Target must remain inside the destination root');
    }
    return normalized;
  }

  private validateExpectedDestinationPath(
    targetRelativePath: string,
    expectedDestinationPath: string
  ): string {
    const expected = path.resolve(expectedDestinationPath);
    const derived = path.join(this.destinationRoot, targetRelativePath);
    if (expected !== derived) {
      throw new Error('Exact preview target does not match the requested relative target');
    }
    return expected;
  }

  private async validateTargetAncestors(targetRelativePath: string): Promise<string> {
    const directoryComponents = targetRelativePath.split(path.sep).slice(0, -1);
    let currentDirectory = this.destinationRoot;
    for (const component of directoryComponents) {
      const childDirectory = path.join(currentDirectory, component);
      let stats;
      try {
        stats = await lstat(childDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return path.join(this.destinationRoot, ...directoryComponents);
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Nested target ancestor is a symbolic link: ${childDirectory}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Nested target ancestor is not a directory: ${childDirectory}`);
      }
      const resolved = await realpath(childDirectory);
      if (resolved !== path.resolve(childDirectory)) {
        throw new Error(`Nested target ancestor changed identity: ${childDirectory}`);
      }
      currentDirectory = childDirectory;
    }
    return currentDirectory;
  }

  private async prepareTargetDirectory(
    targetRelativePath: string
  ): Promise<TargetDirectoryBinding> {
    await this.revalidateDirectoryBinding(this.destinationRoot, this.destinationDirectoryHandle);
    const directoryPath = path.join(this.destinationRoot, path.dirname(targetRelativePath));
    if (directoryPath !== this.destinationRoot) {
      await this.requireNativeFilesystem().ensureDestinationDirectory(directoryPath);
    }
    await this.validateTargetAncestors(targetRelativePath);
    const handle = await TransactionalFileCore.openTrustedDirectory(directoryPath);
    try {
      await this.validateTargetAncestors(targetRelativePath);
      await this.revalidateDirectoryBinding(directoryPath, handle);
      return { directoryPath, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async syncOpenedDirectory(directoryPath: string): Promise<void> {
    if (!this.durableFileOperations) return;
    const handle = await TransactionalFileCore.openTrustedDirectory(directoryPath);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async resolveRegularSource(sourcePath: string): Promise<string> {
    const suppliedStats = await lstat(sourcePath);
    if (suppliedStats.isSymbolicLink() || !suppliedStats.isFile()) {
      throw new Error('Transaction source must be a regular non-symlink file');
    }
    return realpath(sourcePath);
  }

  private async getHandleIdentity(handle: FileHandle): Promise<SourceIdentity> {
    const stats = await handle.stat({ bigint: true });
    return this.identityFromStats(stats);
  }

  private validateOperationId(operationId: string): void {
    if (
      operationId.length === 0 ||
      operationId.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)
    ) {
      throw new Error('Operation ID must be a non-empty safe identifier');
    }
  }

  private requireExpectedIdentity(actual: SourceIdentity, expected: ExpectedSourceIdentity): void {
    if (
      ![expected.device, expected.inode, expected.links, expected.size].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) ||
      !Number.isFinite(expected.modifiedTimeMs) ||
      expected.modifiedTimeMs < 0 ||
      Number(actual.dev) !== expected.device ||
      Number(actual.ino) !== expected.inode ||
      actual.nlink !== expected.links ||
      actual.size !== expected.size ||
      Math.abs(actual.modifiedTimeMs - expected.modifiedTimeMs) > 0.001
    ) {
      throw new Error('Source does not match the expected source identity');
    }
  }

  private async requirePathIdentity(sourcePath: string, expected: SourceIdentity): Promise<void> {
    const stats = await lstat(sourcePath, { bigint: true });
    const actual = this.identityFromStats(stats);
    if (
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.nlink !== expected.nlink ||
      actual.size !== expected.size ||
      actual.mtimeNs !== expected.mtimeNs ||
      actual.ctimeNs !== expected.ctimeNs
    ) {
      throw new Error('Source identity changed during transaction');
    }
  }

  private identityFromStats(stats: BigIntStats): SourceIdentity {
    const size = Number(stats.size);
    if (!Number.isSafeInteger(size)) throw new Error('Source file size exceeds safe integer range');
    return {
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
      nlink: Number(stats.nlink),
      size,
      modifiedTimeMs: Number(stats.mtimeNs) / 1_000_000,
      mtimeNs: stats.mtimeNs.toString(),
      ctimeNs: stats.ctimeNs.toString(),
    };
  }

  private async regularFileHash(filePath: string): Promise<string | undefined> {
    try {
      await this.revalidateManagedPath(filePath);
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
      return await hashFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async inject(point: FailurePoint, context: FailureContext): Promise<void> {
    await this.failureInjector?.(point, context);
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error('Transaction cancelled');
    error.name = 'AbortError';
    throw error;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private requireNativeFilesystem(): NativeTransactionFilesystem {
    if (!this.nativeFilesystem) {
      throw new Error('Native filesystem helper is required for transaction mutation');
    }
    return this.nativeFilesystem;
  }

  private async withAllocationLock<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.allocationTail;
    this.allocationTail = current;
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private hashKey(targetFilename: string, sourceHash: string): string {
    return `${targetFilename}\0${sourceHash}`;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await this.revalidateManagedPath(filePath);
      await lstat(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private static async ensureSecureDirectory(
    directoryPath: string,
    destinationRoot: string
  ): Promise<void> {
    try {
      const stats = await lstat(directoryPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Transaction control path is a symbolic link: ${directoryPath}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Transaction control path is not a directory: ${directoryPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(directoryPath);
    }
    const resolved = await realpath(directoryPath);
    const relative = path.relative(destinationRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Transaction control path escapes destination root: ${directoryPath}`);
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
        throw new Error(`Transaction directory identity changed while opening: ${directoryPath}`);
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private static async acquireCoreLock(
    lockPath: string,
    failureInjector?: TransactionalFileCoreOptions['failureInjector']
  ): Promise<string> {
    await this.restoreCoreLockQuarantine(lockPath, failureInjector);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = randomUUID();
      const candidatePath = `${lockPath}.candidate.${process.pid}.${token}`;
      let handle: FileHandle | undefined;
      let published = false;
      try {
        handle = await open(candidatePath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await link(candidatePath, lockPath);
        published = true;
        await this.syncTrustedDirectory(path.dirname(lockPath));
        await failureInjector?.('before-core-lock-candidate-cleanup', {
          operationId: token,
          sourcePath: '',
        });
        try {
          await unlink(candidatePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const published = await this.readCoreLockSnapshot(lockPath);
          if (!published || published.pid !== process.pid || published.token !== token) {
            throw new Error('Destination transaction lock publication identity changed');
          }
        }
        await this.syncTrustedDirectory(path.dirname(lockPath));
        return token;
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        await unlink(candidatePath).catch((cleanupError: NodeJS.ErrnoException) => {
          if (cleanupError.code !== 'ENOENT') throw cleanupError;
        });
        if (published) {
          await this.releaseCoreLock(lockPath, token);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        await this.repairCoreLockPublicationAliases(lockPath);
        const snapshot = await this.readCoreLockSnapshot(lockPath);
        if (!snapshot) continue;
        if (this.processIsAlive(snapshot.pid)) {
          throw new Error(`Destination already has an active transaction writer`);
        }
        await failureInjector?.('before-core-lock-reclaim', {
          operationId: snapshot.token,
          sourcePath: '',
        });
        const current = await this.readCoreLockSnapshot(lockPath);
        if (
          !current ||
          current.dev !== snapshot.dev ||
          current.ino !== snapshot.ino ||
          current.pid !== snapshot.pid ||
          current.token !== snapshot.token
        ) {
          continue;
        }
        const quarantinePath = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`;
        await rename(lockPath, quarantinePath);
        await this.syncTrustedDirectory(path.dirname(lockPath));
        const displaced = await this.readCoreLockSnapshot(quarantinePath);
        if (
          !displaced ||
          displaced.dev !== snapshot.dev ||
          displaced.ino !== snapshot.ino ||
          displaced.pid !== snapshot.pid ||
          displaced.token !== snapshot.token
        ) {
          await link(quarantinePath, lockPath).catch((restoreError: NodeJS.ErrnoException) => {
            if (restoreError.code !== 'EEXIST') throw restoreError;
          });
          await this.syncTrustedDirectory(path.dirname(lockPath));
          throw new Error('Destination transaction lock identity changed during reclamation');
        }
        await unlink(quarantinePath);
        await this.syncTrustedDirectory(path.dirname(lockPath));
      }
    }
    throw new Error('Could not acquire destination transaction lock');
  }

  private static async repairCoreLockPublicationAliases(lockPath: string): Promise<void> {
    const lockStats = await valueOrUndefined(lstat(lockPath, { bigint: true }));
    if (!lockStats || lockStats.isSymbolicLink() || !lockStats.isFile() || lockStats.nlink <= 1n) {
      return;
    }
    const directoryPath = path.dirname(lockPath);
    const candidatePrefixes = [
      `${path.basename(lockPath)}.candidate.`,
      `${path.basename(lockPath)}.reclaim.`,
    ];
    let removed = false;
    for (const entry of await readdir(directoryPath)) {
      if (!candidatePrefixes.some((prefix) => entry.startsWith(prefix))) continue;
      const candidatePath = path.join(directoryPath, entry);
      const candidateStats = await valueOrUndefined(lstat(candidatePath, { bigint: true }));
      if (
        candidateStats &&
        !candidateStats.isSymbolicLink() &&
        candidateStats.isFile() &&
        candidateStats.dev === lockStats.dev &&
        candidateStats.ino === lockStats.ino
      ) {
        await unlink(candidatePath);
        removed = true;
      }
    }
    if (removed) await this.syncTrustedDirectory(directoryPath);
  }

  private static async restoreCoreLockQuarantine(
    lockPath: string,
    failureInjector?: TransactionalFileCoreOptions['failureInjector']
  ): Promise<void> {
    if (await valueOrUndefined(lstat(lockPath))) {
      await this.repairCoreLockPublicationAliases(lockPath);
      return;
    }
    const directoryPath = path.dirname(lockPath);
    const prefix = `${path.basename(lockPath)}.reclaim.`;
    const quarantines = (await readdir(directoryPath)).filter((entry) => entry.startsWith(prefix));
    if (quarantines.length === 0) return;
    if (quarantines.length !== 1) {
      throw new Error('Destination transaction lock has ambiguous reclamation residue');
    }
    const prefixLength = prefix.length;
    const reclaimerPid = Number.parseInt(quarantines[0].slice(prefixLength).split('.')[0], 10);
    if (
      Number.isSafeInteger(reclaimerPid) &&
      reclaimerPid > 0 &&
      this.processIsAlive(reclaimerPid)
    ) {
      await failureInjector?.('live-core-lock-quarantine-observed', {
        operationId: quarantines[0],
        sourcePath: '',
      });
      throw new Error('Destination already has an active transaction writer releasing its lock');
    }
    await rename(path.join(directoryPath, quarantines[0]), lockPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      }
    );
    await this.syncTrustedDirectory(directoryPath);
  }

  private static async readCoreLockSnapshot(
    lockPath: string
  ): Promise<{ pid: number; token: string; dev: bigint; ino: bigint } | undefined> {
    let handle: FileHandle | undefined;
    try {
      const expected = await lstat(lockPath, { bigint: true });
      if (expected.isSymbolicLink()) {
        throw new Error(`Destination transaction lock is a symbolic link`);
      }
      if (!expected.isFile() || expected.nlink !== 1n) {
        throw new Error(`Destination transaction lock is not a singly linked regular file`);
      }
      handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await handle.stat({ bigint: true });
      if (
        !actual.isFile() ||
        actual.nlink !== 1n ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino
      ) {
        throw new Error(`Destination transaction lock identity changed while reading`);
      }
      let owner: unknown;
      try {
        owner = JSON.parse(await handle.readFile('utf8'));
      } catch {
        throw new Error(`Destination transaction lock contains invalid owner data`);
      }
      if (
        typeof owner !== 'object' ||
        owner === null ||
        !Number.isSafeInteger((owner as { pid?: unknown }).pid) ||
        Number((owner as { pid: number }).pid) <= 0 ||
        typeof (owner as { token?: unknown }).token !== 'string' ||
        (owner as { token: string }).token.length === 0
      ) {
        throw new Error(`Destination transaction lock contains invalid owner data`);
      }
      return {
        pid: (owner as { pid: number }).pid,
        token: (owner as { token: string }).token,
        dev: actual.dev,
        ino: actual.ino,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }

  private static processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
      throw error;
    }
  }

  private static async syncTrustedDirectory(directoryPath: string): Promise<void> {
    const handle = await this.openTrustedDirectory(directoryPath);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private static async releaseCoreLock(
    lockPath: string,
    token: string,
    failureInjector?: TransactionalFileCoreOptions['failureInjector']
  ): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1) return;
      const owner = JSON.parse(await handle.readFile('utf8')) as {
        pid?: number;
        token?: string;
      };
      if (owner.pid !== process.pid || owner.token !== token) return;
      const expectedDev = stats.dev;
      const expectedIno = stats.ino;
      await handle.close();
      handle = undefined;
      const current = await lstat(lockPath);
      if (
        current.dev !== expectedDev ||
        current.ino !== expectedIno ||
        !current.isFile() ||
        current.nlink !== 1
      ) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    } finally {
      if (handle) await handle.close();
    }
    const quarantinePath = `${lockPath}.reclaim.${process.pid}.${randomUUID()}`;
    await rename(lockPath, quarantinePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await failureInjector?.('after-core-lock-quarantined', {
      operationId: token,
      sourcePath: '',
    });
    let displaced = await this.readCoreLockSnapshot(quarantinePath);
    if (!displaced) {
      const restored = await this.readCoreLockSnapshot(lockPath);
      if (restored?.pid === process.pid && restored.token === token) {
        await rename(lockPath, quarantinePath);
        displaced = await this.readCoreLockSnapshot(quarantinePath);
      }
    }
    if (displaced && displaced.pid === process.pid && displaced.token === token) {
      await unlink(quarantinePath);
    } else if (displaced) {
      await link(quarantinePath, lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      throw new Error('Destination transaction lock identity changed during release');
    }
    await this.syncTrustedDirectory(path.dirname(lockPath));
  }
}
