import { createHash } from 'crypto';
import { constants } from 'fs';
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  DateCandidateInput,
  DateResolutionRecord,
  MediaKind,
  resolveDateCandidates,
} from '../core/date';
import {
  InventoryMediaFile,
  MediaInventory,
  SupportedInventoryMediaFile,
} from '../core/inventory/MediaInventory';
import {
  CollectMetadataCandidatesRequest,
  MetadataCandidateCollector,
  MetadataCollectionResult,
} from '../core/metadata/MetadataCandidateCollector';
import { MediaPlanner } from '../core/planning/MediaPlanner';
import { copyHandleToStaging, hashFileHandle } from '../core/transaction/Hashing';
import {
  assertProcessingRootIdentitiesUnchanged,
  ProcessingRootValidator,
  ValidatedProcessingRoots,
} from '../security/ProcessingRoots';
import {
  PlannedOperation,
  PreviewDecisionRecord,
  PreviewPlan,
  PreviewPlannerPort,
  PreviewPlanningRequest,
} from './ProcessingCoordinator';
import {
  ConflictPolicy,
  DateEvidenceDTO,
  DateEvidenceSource,
  OperationMode,
  PreviewProgressDTO,
  PreviewRowDTO,
  ProcessingPhase,
} from '../../shared/types/processing';
import { classifyMediaExtension, normalizedFileExtension } from '../../shared/constants';

export interface PlannedMediaPayload {
  destinationRoot: string;
  validatedRoots: ValidatedProcessingRoots;
  sourceIdentity: {
    device: number;
    inode: number;
    links: number;
    size: number;
  };
  modifiedTimeMs: number;
  mediaKind: MediaKind;
  contentSha256: string;
  destinationSnapshot: DestinationSnapshot;
  dateResolution: DateResolutionRecord;
}

export interface DestinationIdentity {
  device: number;
  inode: number;
  links: number;
  type: 'file' | 'directory' | 'symlink' | 'other';
}

export interface DestinationSnapshot {
  path: string;
  occupied: boolean;
  source: 'filesystem' | 'preview-reservation';
  identity?: DestinationIdentity;
}

export interface SourceContentSnapshot {
  sha256: string;
  verifiedExtractionPath: string;
  filesystemBirthTimeUtc: string | null;
  release(): Promise<void>;
}

export interface SourceContentProbePort {
  capture(file: Readonly<InventoryMediaFile>, signal?: AbortSignal): Promise<SourceContentSnapshot>;
}

export interface SnapshotCleanupFilesystem {
  chmod(filePath: string, mode: number): Promise<void>;
  unlink(filePath: string): Promise<void>;
  rmdir(directoryPath: string): Promise<void>;
}

export interface MediaInventoryPort {
  inventory(sourcePaths: readonly string[], signal?: AbortSignal): Promise<InventoryMediaFile[]>;
}

export interface MetadataCollectionPort {
  collectDetailed(request: CollectMetadataCandidatesRequest): Promise<MetadataCollectionResult>;
}

export interface DestinationProbePort {
  inspect(targetPath: string): Promise<DestinationSnapshot>;
}

export interface ProcessingRootValidationPort {
  validate(
    sourcePaths: readonly string[],
    destinationPath: string,
    signal?: AbortSignal
  ): Promise<ValidatedProcessingRoots>;
}

export interface MediaPreviewPlannerDependencies {
  inventory: MediaInventoryPort;
  roots?: ProcessingRootValidationPort;
  metadata: MetadataCollectionPort;
  destination: DestinationProbePort;
  sourceContent?: SourceContentProbePort;
  now?: () => number;
  platform?: NodeJS.Platform;
  maxCollisionAttempts?: number;
}

export type PreviewProgressReporter = (
  progress: Readonly<PreviewProgressDTO>
) => Promise<void> | void;

class FilesystemDestinationProbe implements DestinationProbePort {
  async inspect(targetPath: string): Promise<DestinationSnapshot> {
    try {
      const stats = await lstat(targetPath);
      const type = stats.isSymbolicLink()
        ? 'symlink'
        : stats.isFile()
          ? 'file'
          : stats.isDirectory()
            ? 'directory'
            : 'other';
      return {
        path: targetPath,
        occupied: true,
        source: 'filesystem',
        identity: { device: stats.dev, inode: stats.ino, links: stats.nlink, type },
      };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return { path: targetPath, occupied: false, source: 'filesystem' };
      }
      throw error;
    }
  }
}

const DEFAULT_SNAPSHOT_CLEANUP_FILESYSTEM: SnapshotCleanupFilesystem = { chmod, unlink, rmdir };

export class FilesystemSourceContentProbe implements SourceContentProbePort {
  constructor(
    private readonly cleanupFilesystem: SnapshotCleanupFilesystem = DEFAULT_SNAPSHOT_CLEANUP_FILESYSTEM
  ) {}

  async capture(
    file: Readonly<InventoryMediaFile>,
    signal?: AbortSignal
  ): Promise<SourceContentSnapshot> {
    throwIfAborted(signal);
    const sourceHandle = await open(
      file.filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    );
    let snapshotHandle: Awaited<ReturnType<typeof open>> | undefined;
    let snapshotDirectory: string | undefined;
    let snapshotPath: string | undefined;
    const cleanupState: SnapshotCleanupState = {
      sourceClosed: false,
      snapshotClosed: true,
      directoryWritable: true,
      snapshotWritable: true,
      snapshotRemoved: true,
      directoryRemoved: true,
    };
    try {
      const before = await sourceHandle.stat();
      assertSourceIdentity(file, before, 'before hashing');
      snapshotDirectory = await mkdtemp(path.join(tmpdir(), 'meta-mover-metadata-'));
      cleanupState.directoryRemoved = false;
      snapshotPath = path.join(snapshotDirectory, `snapshot${path.extname(file.filePath)}`);
      cleanupState.snapshotRemoved = false;
      const copied = await copyHandleToStaging(sourceHandle, snapshotPath, signal);
      if (copied.bytes !== file.size) {
        throw new Error(`Source size changed while creating metadata snapshot: ${file.filePath}`);
      }
      const after = await sourceHandle.stat();
      assertSourceIdentity(file, after, 'after hashing');

      await this.cleanupFilesystem.chmod(snapshotPath, 0o400);
      cleanupState.snapshotWritable = false;
      snapshotHandle = await open(snapshotPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      cleanupState.snapshotClosed = false;
      const snapshotIdentity = await snapshotHandle.stat();
      assertSnapshotIdentity(snapshotPath, snapshotIdentity, copied.bytes);
      const pathIdentity = await lstat(snapshotPath);
      assertSameSnapshot(snapshotPath, snapshotIdentity, pathIdentity);
      const initialSnapshotHash = await hashFileHandle(snapshotHandle, signal);
      if (initialSnapshotHash !== copied.hash) {
        throw new Error(`Metadata snapshot digest mismatch: ${file.filePath}`);
      }
      await this.cleanupFilesystem.chmod(snapshotDirectory, 0o500);
      cleanupState.directoryWritable = false;

      let verificationAttempted = false;
      let verificationError: unknown;
      let releasePromise: Promise<void> | undefined;
      let terminalReleasePromise: Promise<void> | undefined;
      const heldSource = sourceHandle;
      const heldSnapshot = snapshotHandle;
      const heldDirectory = snapshotDirectory;
      const heldPath = snapshotPath;
      return {
        sha256: copied.hash,
        verifiedExtractionPath: heldPath,
        filesystemBirthTimeUtc: Number.isFinite(before.birthtime.getTime())
          ? before.birthtime.toISOString()
          : null,
        release: async () => {
          if (terminalReleasePromise) return terminalReleasePromise;
          if (releasePromise) return releasePromise;
          const attempt = async () => {
            if (!verificationAttempted) {
              verificationAttempted = true;
              try {
                const currentPathIdentity = await lstat(heldPath);
                assertSameSnapshot(heldPath, snapshotIdentity, currentPathIdentity);
                const finalSnapshotHash = await hashFileHandle(heldSnapshot);
                if (finalSnapshotHash !== copied.hash) {
                  throw new Error(`Metadata snapshot changed during extraction: ${file.filePath}`);
                }
                const finalSource = await heldSource.stat();
                assertSourceIdentity(file, finalSource, 'during metadata extraction');
              } catch (error) {
                verificationError = error;
              }
            }
            const cleanupErrors = await cleanupSnapshot(
              cleanupState,
              heldSource,
              heldSnapshot,
              heldPath,
              heldDirectory,
              this.cleanupFilesystem
            );
            if (cleanupErrors.length > 0 && !snapshotCleanupComplete(cleanupState)) {
              cleanupErrors.push(
                ...(await cleanupSnapshot(
                  cleanupState,
                  heldSource,
                  heldSnapshot,
                  heldPath,
                  heldDirectory,
                  this.cleanupFilesystem
                ))
              );
            }
            const errors = [verificationError, ...cleanupErrors].filter(
              (error) => error !== undefined
            );
            if (errors.length > 1) {
              throw new CombinedPreviewError(errors, 'Snapshot verification and cleanup failed');
            }
            if (errors.length === 1) throw errors[0];
          };
          releasePromise = attempt();
          try {
            await releasePromise;
            terminalReleasePromise = Promise.resolve();
          } catch (error) {
            if (snapshotCleanupComplete(cleanupState)) {
              terminalReleasePromise = Promise.reject(error);
              terminalReleasePromise.catch(() => undefined);
            }
            throw error;
          } finally {
            releasePromise = undefined;
          }
        },
      };
    } catch (error) {
      const cleanupErrors = await cleanupSnapshot(
        cleanupState,
        sourceHandle,
        snapshotHandle,
        snapshotPath,
        snapshotDirectory,
        this.cleanupFilesystem
      );
      if (cleanupErrors.length > 0 && !snapshotCleanupComplete(cleanupState)) {
        cleanupErrors.push(
          ...(await cleanupSnapshot(
            cleanupState,
            sourceHandle,
            snapshotHandle,
            snapshotPath,
            snapshotDirectory,
            this.cleanupFilesystem
          ))
        );
      }
      if (cleanupErrors.length > 0) {
        throw new CombinedPreviewError(
          [error, ...cleanupErrors],
          'Snapshot capture and cleanup both failed'
        );
      }
      throw error;
    }
  }
}

function assertSnapshotIdentity(
  snapshotPath: string,
  stats: Awaited<ReturnType<typeof lstat>>,
  expectedSize: number
): void {
  if (!stats.isFile() || stats.nlink !== 1 || stats.size !== expectedSize) {
    throw new Error(`Metadata snapshot identity is unsafe: ${snapshotPath}`);
  }
}

function assertSameSnapshot(
  snapshotPath: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  actual: Awaited<ReturnType<typeof lstat>>
): void {
  if (
    !actual.isFile() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.nlink !== expected.nlink ||
    actual.size !== expected.size
  ) {
    throw new Error(`Metadata snapshot pathname changed during extraction: ${snapshotPath}`);
  }
}

interface SnapshotCleanupState {
  sourceClosed: boolean;
  snapshotClosed: boolean;
  directoryWritable: boolean;
  snapshotWritable: boolean;
  snapshotRemoved: boolean;
  directoryRemoved: boolean;
}

function cleanupErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return (error as NodeJS.ErrnoException).code;
}

function snapshotCleanupComplete(state: SnapshotCleanupState): boolean {
  return (
    state.sourceClosed && state.snapshotClosed && state.snapshotRemoved && state.directoryRemoved
  );
}

async function cleanupSnapshot(
  state: SnapshotCleanupState,
  sourceHandle: Awaited<ReturnType<typeof open>>,
  snapshotHandle?: Awaited<ReturnType<typeof open>>,
  snapshotPath?: string,
  snapshotDirectory?: string,
  filesystem: SnapshotCleanupFilesystem = DEFAULT_SNAPSHOT_CLEANUP_FILESYSTEM
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const attempt = async (
    operation: () => Promise<unknown>,
    complete: () => void
  ): Promise<void> => {
    try {
      await operation();
      complete();
    } catch (error) {
      if (cleanupErrorCode(error) === 'ENOENT' || cleanupErrorCode(error) === 'EBADF') complete();
      else errors.push(error);
    }
  };
  if (snapshotHandle && !state.snapshotClosed) {
    await attempt(
      () => snapshotHandle.close(),
      () => {
        state.snapshotClosed = true;
      }
    );
  }
  if (!state.sourceClosed) {
    await attempt(
      () => sourceHandle.close(),
      () => {
        state.sourceClosed = true;
      }
    );
  }
  if (snapshotDirectory && !state.directoryWritable && !state.directoryRemoved) {
    await attempt(
      () => filesystem.chmod(snapshotDirectory, 0o700),
      () => {
        state.directoryWritable = true;
      }
    );
  }
  if (snapshotPath && !state.snapshotWritable && !state.snapshotRemoved) {
    await attempt(
      () => filesystem.chmod(snapshotPath, 0o600),
      () => {
        state.snapshotWritable = true;
      }
    );
  }
  if (snapshotPath && !state.snapshotRemoved && state.directoryWritable) {
    await attempt(
      () => filesystem.unlink(snapshotPath),
      () => {
        state.snapshotRemoved = true;
      }
    );
  }
  if (snapshotDirectory && !state.directoryRemoved && state.snapshotRemoved) {
    await attempt(
      () => filesystem.rmdir(snapshotDirectory),
      () => {
        state.directoryRemoved = true;
      }
    );
  }
  return errors;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'Preview cancelled');
  error.name = 'AbortError';
  throw error;
}

class CombinedPreviewError extends Error {
  readonly name = 'AggregateError';

  constructor(
    public readonly errors: readonly unknown[],
    message: string
  ) {
    super(message);
  }
}

function assertSourceIdentity(
  file: Readonly<InventoryMediaFile>,
  stats: Awaited<ReturnType<typeof lstat>>,
  phase: string
): void {
  if (
    !stats.isFile() ||
    stats.dev !== file.device ||
    stats.ino !== file.inode ||
    stats.nlink !== file.links ||
    stats.size !== file.size ||
    stats.mtimeMs !== file.modifiedTimeMs
  ) {
    throw new Error(`Source identity changed ${phase}: ${file.filePath}`);
  }
}

function validateInventoryFile(file: InventoryMediaFile): void {
  const classifiedKind = classifyMediaExtension(file.filePath);
  if (
    typeof file.filePath !== 'string' ||
    !path.isAbsolute(file.filePath) ||
    file.extension !== normalizedFileExtension(file.filePath) ||
    (file.formatStatus === 'supported' &&
      (file.mediaKind === null || file.mediaKind !== classifiedKind)) ||
    (file.formatStatus === 'unsupported' && (file.mediaKind !== null || classifiedKind !== null)) ||
    ![file.device, file.inode, file.links, file.size].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) ||
    !Number.isFinite(file.modifiedTimeMs)
  ) {
    throw new Error(`Inventory file contains unsafe metadata: ${String(file.filePath)}`);
  }
}

function isSupportedInventoryFile(file: InventoryMediaFile): file is SupportedInventoryMediaFile {
  return file.formatStatus === 'supported';
}

function unsupportedWarning(file: InventoryMediaFile): string {
  const format = file.extension === '' ? 'no file extension' : file.extension;
  return `Needs Review: unsupported or unrecognized file format (${format}). Source left unchanged.`;
}

function safeAdd(total: number, value: number, label: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) throw new Error(`${label} exceeds the safe integer range`);
  return next;
}

function conflictKey(targetPath: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(targetPath);
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renamedTarget(targetPath: string, sequence: number): string {
  const parsed = path.parse(targetPath);
  return path.join(parsed.dir, `${parsed.name}_${sequence}${parsed.ext}`);
}

function operationId(file: InventoryMediaFile, targetPath: string): string {
  return createHash('sha256')
    .update(`${file.device}:${file.inode}\0${file.filePath}\0${targetPath}`)
    .digest('hex');
}

function evidenceSource(candidate: DateCandidateInput | undefined): DateEvidenceDTO['source'] {
  if (candidate === undefined) return DateEvidenceSource.UNRESOLVED;
  if (candidate.sourceKind === 'filename') return DateEvidenceSource.FILENAME;
  if (candidate.semantic === 'filesystem-birth') return DateEvidenceSource.FILESYSTEM_BIRTH;
  return DateEvidenceSource.EMBEDDED;
}

function confidenceValue(resolution: DateResolutionRecord): number {
  switch (resolution.confidence) {
    case 'high':
      return 1;
    case 'medium':
      return 0.7;
    case 'low':
      return 0.4;
    case 'none':
      return 0;
  }
}

function dateEvidence(resolution: DateResolutionRecord): DateEvidenceDTO {
  const candidate = resolution.candidates.find(
    (entry) => entry.id === resolution.selectedCandidateId
  );
  return {
    value: resolution.selectedValue?.instantUtc ?? resolution.selectedValue?.localIso ?? null,
    source: evidenceSource(candidate),
    ...(candidate === undefined ? {} : { field: candidate.tag }),
    confidence: confidenceValue(resolution),
    warnings: [...resolution.reasonCodes, ...(candidate?.resolutionIssues ?? [])],
  };
}

function payloadFor(
  file: SupportedInventoryMediaFile,
  roots: ValidatedProcessingRoots,
  resolution: DateResolutionRecord,
  contentSha256: string,
  destinationSnapshot: DestinationSnapshot
): PlannedMediaPayload {
  return {
    destinationRoot: roots.destinationPath,
    validatedRoots: {
      sourcePaths: [...roots.sourcePaths],
      destinationPath: roots.destinationPath,
      sourceIdentities: roots.sourceIdentities.map((identity) => ({ ...identity })),
      destinationIdentity: { ...roots.destinationIdentity },
    },
    sourceIdentity: {
      device: file.device,
      inode: file.inode,
      links: file.links,
      size: file.size,
    },
    modifiedTimeMs: file.modifiedTimeMs,
    mediaKind: file.mediaKind,
    contentSha256,
    destinationSnapshot,
    dateResolution: resolution,
  };
}

export class MediaPreviewPlanner implements PreviewPlannerPort {
  private readonly inventory: MediaInventoryPort;
  private readonly roots: ProcessingRootValidationPort;
  private readonly metadata: MetadataCollectionPort;
  private readonly destination: DestinationProbePort;
  private readonly sourceContent: SourceContentProbePort;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly maxCollisionAttempts: number;
  private readonly planner = new MediaPlanner();

  constructor(dependencies: MediaPreviewPlannerDependencies) {
    this.inventory = dependencies.inventory;
    this.roots = dependencies.roots ?? new ProcessingRootValidator();
    this.metadata = dependencies.metadata;
    this.destination = dependencies.destination;
    this.sourceContent = dependencies.sourceContent ?? new FilesystemSourceContentProbe();
    this.now = dependencies.now ?? (() => Date.now());
    this.platform = dependencies.platform ?? process.platform;
    this.maxCollisionAttempts = dependencies.maxCollisionAttempts ?? 10_000;
    if (!Number.isSafeInteger(this.maxCollisionAttempts) || this.maxCollisionAttempts <= 0) {
      throw new Error('maxCollisionAttempts must be a positive safe integer');
    }
  }

  static createDefault(
    metadata: MetadataCandidateCollector,
    inventory: MediaInventory = new MediaInventory()
  ): MediaPreviewPlanner {
    return new MediaPreviewPlanner({
      inventory,
      metadata,
      destination: new FilesystemDestinationProbe(),
    });
  }

  async plan(
    request: Readonly<PreviewPlanningRequest>,
    signal?: AbortSignal,
    reportProgress?: PreviewProgressReporter
  ): Promise<PreviewPlan> {
    throwIfAborted(signal);
    const roots = await this.roots.validate(request.sourcePaths, request.destinationPath, signal);
    if (request.validatedRoots !== undefined) {
      assertProcessingRootIdentitiesUnchanged(request.validatedRoots, roots);
    }
    throwIfAborted(signal);
    const files = (await this.inventory.inventory(roots.sourcePaths, signal)).map((file) => ({
      ...file,
    }));
    files.forEach(validateInventoryFile);
    files.sort(
      (left, right) =>
        comparePaths(left.filePath, right.filePath) ||
        left.device - right.device ||
        left.inode - right.inode
    );
    let totalBytes = 0;
    for (const file of files) totalBytes = safeAdd(totalBytes, file.size, 'Preview total bytes');
    const evaluationTimeUtc = new Date(this.now()).toISOString();
    const reserved = new Set<string>();
    const rows: Array<PreviewRowDTO & { destinationSnapshot?: DestinationSnapshot }> = [];
    const operations: PlannedOperation[] = [];
    const decisionRecords: PreviewDecisionRecord[] = [];
    let renamedFiles = 0;
    let skippedFiles = 0;
    let unresolvedDates = 0;

    const publishProgress = async (
      filesProcessed: number,
      phase: ProcessingPhase,
      currentFile?: string
    ): Promise<void> => {
      if (!reportProgress) return;
      const totalFiles = files.length;
      await reportProgress({
        phase,
        filesProcessed,
        totalFiles,
        percentage: totalFiles === 0 ? 100 : (filesProcessed / totalFiles) * 100,
        ...(currentFile === undefined ? {} : { currentFile }),
      });
      throwIfAborted(signal);
    };

    await publishProgress(
      0,
      files.length === 0 ? ProcessingPhase.ORGANIZATION : ProcessingPhase.METADATA,
      files[0]?.filePath
    );

    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex];
      throwIfAborted(signal);
      if (!isSupportedInventoryFile(file)) {
        const warning = unsupportedWarning(file);
        skippedFiles += 1;
        unresolvedDates += 1;
        rows.push({
          sourcePath: file.filePath,
          targetPath: null,
          operation: 'skip',
          conflictPolicy: request.options.conflictPolicy,
          dateEvidence: {
            value: null,
            source: DateEvidenceSource.UNRESOLVED,
            confidence: 0,
            warnings: [warning],
          },
          fingerprint: {
            size: file.size,
            modifiedAt: new Date(file.modifiedTimeMs).toISOString(),
          },
          warnings: [warning],
        });
        await publishProgress(
          fileIndex + 1,
          fileIndex + 1 === files.length ? ProcessingPhase.ORGANIZATION : ProcessingPhase.METADATA,
          files[fileIndex + 1]?.filePath
        );
        continue;
      }
      const fileId = `${file.device}:${file.inode}`;
      const sourceSnapshot = await this.sourceContent.capture(file, signal);
      const contentSha256 = sourceSnapshot.sha256;
      let metadata: MetadataCollectionResult | undefined;
      const boundaryErrors: unknown[] = [];
      try {
        if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
          throw new Error(`Source content probe returned an invalid SHA-256: ${file.filePath}`);
        }
        metadata = await this.metadata.collectDetailed({
          fileId,
          filePath: file.filePath,
          verifiedExtractionPath: sourceSnapshot.verifiedExtractionPath,
          expectedContentSha256: contentSha256,
          expectedContentBytes: file.size,
          filesystemBirthTimeUtc: sourceSnapshot.filesystemBirthTimeUtc,
          mediaKind: file.mediaKind,
          signal,
        });
      } catch (error) {
        boundaryErrors.push(error);
      }
      try {
        await sourceSnapshot.release();
      } catch (error) {
        boundaryErrors.push(error);
      }
      if (boundaryErrors.length > 1) {
        throw new CombinedPreviewError(
          boundaryErrors,
          `Metadata extraction and verified snapshot release both failed: ${file.filePath}`
        );
      }
      if (boundaryErrors.length === 1) throw boundaryErrors[0];
      if (metadata === undefined) {
        throw new Error(`Metadata extraction completed without a result: ${file.filePath}`);
      }
      const resolution = resolveDateCandidates({
        fileId,
        mediaKind: file.mediaKind,
        evaluationTimeUtc,
        candidates: metadata.candidates,
      });
      const planned = this.planner.planForPreview({
        sourcePath: file.filePath,
        destinationRoot: roots.destinationPath,
        mediaKind: file.mediaKind,
        resolution,
        operation: request.options.operation,
        conflictPolicy: request.options.conflictPolicy,
        folderStructure: request.options.folderStructure,
      });
      if (planned.needsReview) unresolvedDates += 1;

      const originalTarget = planned.targetPath;
      let targetPath = originalTarget;
      const inspectTarget = async (candidatePath: string): Promise<DestinationSnapshot> => {
        throwIfAborted(signal);
        if (reserved.has(conflictKey(candidatePath, this.platform))) {
          return { path: candidatePath, occupied: true, source: 'preview-reservation' };
        }
        const snapshot = JSON.parse(
          JSON.stringify(await this.destination.inspect(candidatePath))
        ) as DestinationSnapshot;
        throwIfAborted(signal);
        if (
          snapshot.path !== candidatePath ||
          typeof snapshot.occupied !== 'boolean' ||
          snapshot.source !== 'filesystem' ||
          (snapshot.occupied && snapshot.identity === undefined)
        ) {
          throw new Error(`Destination probe returned an invalid snapshot: ${candidatePath}`);
        }
        return {
          ...snapshot,
          ...(snapshot.identity ? { identity: { ...snapshot.identity } } : {}),
        };
      };
      let destinationSnapshot = await inspectTarget(targetPath);
      let occupied = destinationSnapshot.occupied;
      let renamed = false;
      if (occupied && request.options.conflictPolicy === ConflictPolicy.RENAME) {
        let sequence = 1;
        do {
          if (sequence > this.maxCollisionAttempts) {
            throw new Error(
              `Target remained occupied after ${this.maxCollisionAttempts} collision attempts`
            );
          }
          throwIfAborted(signal);
          targetPath = renamedTarget(originalTarget, sequence);
          sequence += 1;
          destinationSnapshot = await inspectTarget(targetPath);
          occupied = destinationSnapshot.occupied;
        } while (occupied);
        renamed = true;
        renamedFiles += 1;
      }

      const skip = occupied && request.options.conflictPolicy === ConflictPolicy.SKIP;
      if (skip) skippedFiles += 1;
      else reserved.add(conflictKey(targetPath, this.platform));

      const evidence = dateEvidence(resolution);
      const warnings = [
        ...metadata.warnings,
        ...evidence.warnings,
        ...(planned.needsReview ? ['Creation date requires review'] : []),
        ...(skip ? ['Target already exists'] : []),
        ...(renamed ? ['Target renamed to avoid a conflict'] : []),
      ];
      const rowIndex = rows.length;
      rows.push({
        sourcePath: file.filePath,
        targetPath,
        operation: skip ? 'skip' : request.options.operation,
        conflictPolicy: request.options.conflictPolicy,
        dateEvidence: { ...evidence, warnings: [...new Set(warnings)] },
        fingerprint: {
          size: file.size,
          modifiedAt: new Date(file.modifiedTimeMs).toISOString(),
          hash: contentSha256,
        },
        destinationSnapshot,
        warnings: [...new Set(warnings)],
      });
      decisionRecords.push({ rowIndex, sourcePath: file.filePath, resolution });

      if (!skip) {
        operations.push({
          id: operationId(file, targetPath),
          sourcePath: file.filePath,
          targetPath,
          bytes: file.size,
          payload: payloadFor(
            file,
            roots,
            resolution,
            contentSha256,
            destinationSnapshot
          ) as unknown as PlannedOperation['payload'],
        });
      }
      await publishProgress(
        fileIndex + 1,
        fileIndex + 1 === files.length ? ProcessingPhase.ORGANIZATION : ProcessingPhase.METADATA,
        files[fileIndex + 1]?.filePath
      );
    }

    const operation = request.options.operation;
    return {
      summary: {
        totalFiles: files.length,
        copyFiles: operation === OperationMode.COPY ? operations.length : 0,
        moveFiles: operation === OperationMode.MOVE ? operations.length : 0,
        skippedFiles,
        renamedFiles,
        overwrittenFiles: 0,
        unresolvedDates,
        totalBytes,
      },
      rows,
      operations,
      decisionRecords,
    };
  }
}
