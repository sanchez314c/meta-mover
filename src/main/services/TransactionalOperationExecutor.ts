import { lstat, realpath } from 'fs/promises';
import path from 'path';

import {
  ExpectedSourceIdentity,
  TransactionRequest,
  TransactionResult,
  TransactionalFileCore,
} from '../core/transaction';
import {
  OperationExecutionContext,
  OperationExecutorPort,
  OperationLedgerEntry,
  PlannedOperation,
} from './ProcessingCoordinator';
import {
  assertValidatedProcessingRoots,
  ProcessingRootIdentity,
  ValidatedProcessingRoots,
} from '../security/ProcessingRoots';
import { OperationMode } from '../../shared/types/processing';
import { AuditPreparationProgressDTO, CancellationFileState } from '../../shared/types/processing';
import { NativeTransactionFilesystem } from '../core/transaction/NativeTransactionFilesystem';
import type { ParsedDateValue } from '../core/date';
import type { DateResolutionRecord } from '../core/date';
import type { MetadataDateWriterPort } from '../core/metadata/MetadataDateWriter';

export interface TransactionCorePort {
  execute(request: TransactionRequest): Promise<TransactionResult>;
  close(): Promise<void>;
}

export interface TransactionalOperationExecutorOptions {
  coreFactory?: (canonicalDestinationRoot: string) => Promise<TransactionCorePort>;
  nativeFilesystemFactory?: (context: {
    destinationRoot: string;
    controlRoot: string;
    sourceRoots: readonly string[];
  }) => Promise<NativeTransactionFilesystem>;
  metadataWriter?: MetadataDateWriterPort;
  normalizationAuthorization?: NormalizationAuthorizationPort;
}

export interface NormalizationAuthorizationPort {
  authorizeNormalization(
    request: Readonly<{
      previewId: string;
      recordId: string;
      sourcePath: string;
      outputPath: string;
      resolution: DateResolutionRecord;
      /** Aborts durable audit preparation so cancellation settles promptly. */
      signal?: AbortSignal;
      /** Surfaces audit preparation progress (verification, index construction). */
      reportProgress?: (progress: Readonly<AuditPreparationProgressDTO>) => Promise<void> | void;
    }>
  ): Promise<boolean>;
}

interface CachedCore {
  sourceRootFingerprint: string;
  promise: Promise<TransactionCorePort>;
}

interface ExecutorPayload {
  destinationRoot: string;
  validatedRoots: ValidatedProcessingRoots;
  sourceIdentity: ExpectedSourceIdentity;
  modifiedTimeMs: number;
  contentSha256?: string;
  selectedDate?: ParsedDateValue;
  dateResolution?: DateResolutionRecord;
  destinationSnapshot: {
    path: string;
    occupied: boolean;
    source: 'filesystem' | 'preview-reservation';
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseSelectedDate(value: unknown): ParsedDateValue | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Transaction payload contains an invalid date decision');
  if (value.status !== 'resolved') return undefined;
  if (!isRecord(value.selectedValue)) {
    throw new Error('Transaction payload contains an invalid selected creation date');
  }
  const selected = value.selectedValue;
  if (
    typeof selected.localIso !== 'string' ||
    ![
      'explicit-offset',
      'spec-defined-utc',
      'gps-inferred',
      'device-zone-inferred',
      'floating-local',
      'date-only',
    ].includes(String(selected.zoneBasis)) ||
    !['date', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond'].includes(
      String(selected.precision)
    ) ||
    (selected.instantUtc !== undefined && typeof selected.instantUtc !== 'string') ||
    (selected.offsetMinutes !== undefined &&
      (!Number.isInteger(selected.offsetMinutes) ||
        Math.abs(selected.offsetMinutes as number) > 840)) ||
    (selected.zoneIana !== undefined && typeof selected.zoneIana !== 'string') ||
    (selected.fractionalDigits !== undefined &&
      (typeof selected.fractionalDigits !== 'string' ||
        !/^\d{1,9}$/.test(selected.fractionalDigits)))
  ) {
    throw new Error('Transaction payload contains an invalid selected creation date');
  }
  return {
    localIso: selected.localIso,
    ...(selected.instantUtc === undefined ? {} : { instantUtc: selected.instantUtc }),
    ...(selected.offsetMinutes === undefined
      ? {}
      : { offsetMinutes: selected.offsetMinutes as number }),
    ...(selected.zoneIana === undefined ? {} : { zoneIana: selected.zoneIana }),
    zoneBasis: selected.zoneBasis as ParsedDateValue['zoneBasis'],
    precision: selected.precision as ParsedDateValue['precision'],
    ...(selected.fractionalDigits === undefined
      ? {}
      : { fractionalDigits: selected.fractionalDigits }),
  };
}

function parsePayload(value: unknown): ExecutorPayload {
  if (!isRecord(value)) throw new Error('Transaction payload must be a plain object');
  const identity = value.sourceIdentity;
  const snapshot = value.destinationSnapshot;
  assertValidatedProcessingRoots(value.validatedRoots);
  if (
    typeof value.destinationRoot !== 'string' ||
    !path.isAbsolute(value.destinationRoot) ||
    value.destinationRoot !== value.validatedRoots.destinationPath ||
    !isRecord(identity) ||
    !safeNonnegativeInteger(identity.device) ||
    !safeNonnegativeInteger(identity.inode) ||
    !safeNonnegativeInteger(identity.links) ||
    !safeNonnegativeInteger(identity.size) ||
    typeof value.modifiedTimeMs !== 'number' ||
    !Number.isFinite(value.modifiedTimeMs) ||
    value.modifiedTimeMs < 0 ||
    (value.contentSha256 !== undefined &&
      (typeof value.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentSha256))) ||
    !isRecord(snapshot) ||
    typeof snapshot.path !== 'string' ||
    typeof snapshot.occupied !== 'boolean' ||
    !['filesystem', 'preview-reservation'].includes(String(snapshot.source))
  ) {
    throw new Error('Transaction payload contains invalid preview evidence');
  }
  const selectedDate = parseSelectedDate(value.dateResolution);
  return {
    destinationRoot: value.destinationRoot,
    validatedRoots: {
      sourcePaths: [...value.validatedRoots.sourcePaths],
      destinationPath: value.validatedRoots.destinationPath,
      sourceIdentities: value.validatedRoots.sourceIdentities.map((entry) => ({ ...entry })),
      destinationIdentity: { ...value.validatedRoots.destinationIdentity },
    },
    sourceIdentity: {
      device: identity.device,
      inode: identity.inode,
      links: identity.links,
      size: identity.size,
      modifiedTimeMs: value.modifiedTimeMs,
    },
    modifiedTimeMs: value.modifiedTimeMs,
    ...(value.contentSha256 === undefined ? {} : { contentSha256: value.contentSha256 }),
    ...(selectedDate === undefined ? {} : { selectedDate }),
    ...(selectedDate === undefined
      ? {}
      : { dateResolution: value.dateResolution as unknown as DateResolutionRecord }),
    destinationSnapshot: {
      path: snapshot.path,
      occupied: snapshot.occupied,
      source: snapshot.source as ExecutorPayload['destinationSnapshot']['source'],
    },
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export class TransactionalOperationExecutor implements OperationExecutorPort {
  private readonly coreFactory: (canonicalDestinationRoot: string) => Promise<TransactionCorePort>;
  private readonly nativeFilesystemFactory?: TransactionalOperationExecutorOptions['nativeFilesystemFactory'];
  private readonly usesCustomCoreFactory: boolean;
  private readonly metadataWriter?: MetadataDateWriterPort;
  private readonly normalizationAuthorization?: NormalizationAuthorizationPort;
  private readonly cores = new Map<string, CachedCore>();
  private readonly inFlight = new Set<Promise<OperationLedgerEntry>>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(options: TransactionalOperationExecutorOptions = {}) {
    this.usesCustomCoreFactory = options.coreFactory !== undefined;
    this.nativeFilesystemFactory = options.nativeFilesystemFactory;
    this.metadataWriter = options.metadataWriter;
    this.normalizationAuthorization = options.normalizationAuthorization;
    this.coreFactory =
      options.coreFactory ?? ((destinationRoot) => TransactionalFileCore.create(destinationRoot));
  }

  execute(
    operation: Readonly<PlannedOperation>,
    context: Readonly<OperationExecutionContext>
  ): Promise<OperationLedgerEntry> {
    if (this.closing) return Promise.reject(new Error('Transaction executor is closing'));
    const execution = this.executeBound(operation, context);
    this.inFlight.add(execution);
    void execution.then(
      () => this.inFlight.delete(execution),
      () => this.inFlight.delete(execution)
    );
    return execution;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.inFlight]);
      const cores = await Promise.all([...this.cores.values()].map((entry) => entry.promise));
      await Promise.all([
        ...cores.map((core) => core.close()),
        ...(this.metadataWriter === undefined ? [] : [this.metadataWriter.close()]),
      ]);
    })();
    return this.closePromise;
  }

  private async executeBound(
    operation: Readonly<PlannedOperation>,
    context: Readonly<OperationExecutionContext>
  ): Promise<OperationLedgerEntry> {
    if (context.signal.aborted) throw abortError('Transaction cancelled before admission');
    const payload = parsePayload(operation.payload);
    this.validateOperation(operation, payload, context);
    const normalizeMetadata =
      context.writeMetadataDates &&
      payload.selectedDate !== undefined &&
      payload.selectedDate.precision !== 'date' &&
      payload.selectedDate.zoneBasis !== 'date-only' &&
      payload.dateResolution !== undefined &&
      this.metadataWriter !== undefined &&
      this.normalizationAuthorization !== undefined &&
      (await this.normalizationAuthorization.authorizeNormalization({
        previewId: context.previewId,
        recordId: operation.id,
        sourcePath: operation.sourcePath,
        outputPath: operation.targetPath,
        resolution: payload.dateResolution,
        signal: context.signal,
        ...(context.reportStageProgress === undefined
          ? {}
          : { reportProgress: context.reportStageProgress }),
      }));
    const canonicalRoot = await this.revalidateRootBindings(operation.sourcePath, payload);
    const relativeTarget = path.relative(canonicalRoot, path.resolve(operation.targetPath));
    if (
      !relativeTarget ||
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget) ||
      relativeTarget.split(path.sep)[0].toLocaleLowerCase('en-US') === '.meta-mover'
    ) {
      throw new Error('Planned target must remain inside the destination data root');
    }
    if (path.join(canonicalRoot, relativeTarget) !== operation.targetPath) {
      throw new Error('Planned target must be canonical and normalized');
    }

    const core = await this.coreFor(
      canonicalRoot,
      payload.validatedRoots.sourceIdentities.map((identity) => identity.path)
    );
    const result = await core.execute({
      operationId: operation.id,
      sourcePath: operation.sourcePath,
      targetFilename: relativeTarget,
      expectedDestinationPath: operation.targetPath,
      collisionMode: 'exact-no-clobber',
      expectedSourceIdentity: payload.sourceIdentity,
      expectedSha256: payload.contentSha256,
      mode: context.mode === OperationMode.MOVE ? 'move' : 'copy',
      signal: context.signal,
      ...(normalizeMetadata
        ? {
            transformStaging: async ({
              stagingPath,
              signal,
            }: {
              stagingPath: string;
              signal?: AbortSignal;
            }) => {
              const receipt = await this.metadataWriter!.normalizeDateMetadata({
                filePath: stagingPath,
                selectedDate: payload.selectedDate!,
                signal,
              });
              if (receipt?.verified !== true) {
                throw new Error('metadata normalization did not return a verified receipt');
              }
              return {
                family: receipt.family,
                idempotent: receipt.idempotent,
                verified: receipt.verified,
                normalizedTags: [...receipt.normalizedTags],
              };
            },
          }
        : {}),
    });
    return this.mapResult(operation, payload, result, context.mode, normalizeMetadata);
  }

  private validateOperation(
    operation: Readonly<PlannedOperation>,
    payload: ExecutorPayload,
    context: Readonly<OperationExecutionContext>
  ): void {
    if (
      typeof operation.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(operation.id) ||
      typeof operation.sourcePath !== 'string' ||
      !path.isAbsolute(operation.sourcePath) ||
      path.resolve(operation.sourcePath) !== operation.sourcePath ||
      typeof operation.targetPath !== 'string' ||
      !path.isAbsolute(operation.targetPath) ||
      !safeNonnegativeInteger(operation.bytes) ||
      operation.bytes !== payload.sourceIdentity.size ||
      payload.destinationSnapshot.path !== operation.targetPath ||
      payload.destinationSnapshot.occupied ||
      ![OperationMode.COPY, OperationMode.MOVE].includes(context.mode)
    ) {
      throw new Error('Planned transaction operation is inconsistent with its preview evidence');
    }
  }

  private async revalidateRootBindings(
    sourcePath: string,
    payload: ExecutorPayload
  ): Promise<string> {
    const canonicalDestination = await this.revalidateRootIdentity(
      payload.validatedRoots.destinationIdentity
    );
    if (
      canonicalDestination !== payload.destinationRoot ||
      payload.validatedRoots.destinationPath !== payload.destinationRoot
    ) {
      throw new Error('Destination root identity no longer matches preview evidence');
    }

    const canonicalSources = await Promise.all(
      payload.validatedRoots.sourceIdentities.map((identity) =>
        this.revalidateRootIdentity(identity)
      )
    );
    const admitted = canonicalSources.some((sourceRoot) => {
      const relative = path.relative(sourceRoot, sourcePath);
      return (
        relative.length > 0 &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    });
    if (!admitted) {
      throw new Error('Source path is outside the validated source root identities');
    }
    return canonicalDestination;
  }

  private async revalidateRootIdentity(identity: ProcessingRootIdentity): Promise<string> {
    const expectedPath = path.resolve(identity.path);
    if (identity.path !== expectedPath) {
      throw new Error('Processing root identity path is not canonical');
    }
    const before = await lstat(identity.path, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error('Processing root identity is not a non-symlink directory');
    }
    const canonical = await realpath(identity.path);
    const after = await lstat(identity.path, { bigint: true });
    if (
      canonical !== expectedPath ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      Number(after.dev) !== identity.device ||
      Number(after.ino) !== identity.inode
    ) {
      throw new Error('Processing root identity changed after preview validation');
    }
    return canonical;
  }

  private async coreFor(
    canonicalRoot: string,
    sourceRoots: readonly string[]
  ): Promise<TransactionCorePort> {
    const normalizedSourceRoots = [...sourceRoots].sort();
    const sourceRootFingerprint = JSON.stringify(normalizedSourceRoots);
    const cached = this.cores.get(canonicalRoot);
    if (cached) {
      if (cached.sourceRootFingerprint !== sourceRootFingerprint) {
        throw new Error('Destination transaction core is bound to a different source-root set');
      }
      return cached.promise;
    }
    if (!this.usesCustomCoreFactory && !this.nativeFilesystemFactory) {
      throw new Error('Native filesystem helper factory is required for transaction execution');
    }
    const created = (
      this.usesCustomCoreFactory
        ? this.coreFactory(canonicalRoot)
        : TransactionalFileCore.create(canonicalRoot, {
            nativeFilesystemFactory: (_destinationRoot, controlRoot) =>
              this.nativeFilesystemFactory!({
                destinationRoot: canonicalRoot,
                controlRoot,
                sourceRoots: normalizedSourceRoots,
              }),
          })
    ).catch((error) => {
      if (this.cores.get(canonicalRoot)?.promise === created) this.cores.delete(canonicalRoot);
      throw error;
    });
    this.cores.set(canonicalRoot, { sourceRootFingerprint, promise: created });
    return created;
  }

  private mapResult(
    operation: Readonly<PlannedOperation>,
    payload: ExecutorPayload,
    result: TransactionResult,
    mode: OperationMode,
    transformed = false
  ): OperationLedgerEntry {
    if (
      result.operationId !== operation.id ||
      (!transformed &&
        payload.contentSha256 !== undefined &&
        result.hash !== undefined &&
        result.hash !== payload.contentSha256) ||
      (!transformed && result.bytes !== undefined && result.bytes !== operation.bytes) ||
      (result.committed && result.destinationPath !== operation.targetPath)
    ) {
      throw new Error('Transaction core returned a result that diverges from the preview plan');
    }
    if (result.status === 'duplicate') {
      return { operationId: operation.id, outcome: 'skipped', bytes: 0 };
    }
    if (result.status === 'cancelled' && !result.committed) {
      return {
        operationId: operation.id,
        outcome: 'cancelled',
        bytes: 0,
        cancellationState: CancellationFileState.CANCELLED_BEFORE_COMMIT,
        sourceRetained: true,
        destinationCommitted: false,
        error: result.error ?? 'Transaction cancelled before commit',
      };
    }
    if (
      result.status === 'cancelled' &&
      result.committed &&
      mode === OperationMode.MOVE &&
      result.sourceRetained
    ) {
      return {
        operationId: operation.id,
        outcome: 'cancelled',
        bytes: operation.bytes,
        cancellationState: CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED,
        sourceRetained: true,
        destinationCommitted: true,
        error: result.error ?? 'Move cancelled after destination commit; source retained',
      };
    }
    if (
      result.committed &&
      !(
        mode === OperationMode.MOVE &&
        (result.sourceRetained || !['moved', 'duplicate'].includes(result.status))
      )
    ) {
      return {
        operationId: operation.id,
        outcome: 'committed',
        bytes: operation.bytes,
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    }
    if (result.committed) {
      return {
        operationId: operation.id,
        outcome: 'failed',
        bytes: operation.bytes,
        sourceRetained: result.sourceRetained,
        destinationCommitted: true,
        error: result.error ?? 'Move committed bytes but did not complete source transfer',
      };
    }
    return {
      operationId: operation.id,
      outcome: 'failed',
      bytes: 0,
      sourceRetained: result.sourceRetained,
      destinationCommitted: false,
      error: result.error ?? 'Transaction failed before commit',
    };
  }
}
