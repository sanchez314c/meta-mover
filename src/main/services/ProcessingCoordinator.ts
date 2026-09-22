import { randomUUID } from 'crypto';
import { JobStateMachine, isTerminalJobStatus } from '../core/JobStateMachine';
import type { DateResolutionRecord } from '../core/date';
import {
  assertValidatedProcessingRoots,
  ValidatedProcessingRoots,
} from '../security/ProcessingRoots';
import {
  AuditPreparationProgressDTO,
  ConflictPolicy,
  CancellationFileState,
  FolderStructure,
  OperationMode,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingFileFailureDTO,
  ProcessingCancellationFileOutcomeDTO,
  ProcessingCancellationStatisticsDTO,
  ProcessingOptionsDTO,
  ProcessingPhase,
  ProcessingStatisticsDTO,
  PreviewProgressDTO,
  PreviewRequestDTO,
  PreviewResultDTO,
  PreviewRowDTO,
  PreviewSummaryDTO,
  StartProcessingRequestDTO,
  StartProcessingResultDTO,
  TerminalProcessingEvent,
} from '../../shared/types/processing';

export type CoordinatorJsonValue =
  | string
  | number
  | boolean
  | null
  | CoordinatorJsonValue[]
  | { [key: string]: CoordinatorJsonValue };

export interface CoordinatorPreviewRequest {
  sourcePaths: string[];
  destinationPath: string;
  options?: Partial<ProcessingOptionsDTO>;
  validatedRoots?: ValidatedProcessingRoots;
}

export interface PreviewPlanningRequest extends PreviewRequestDTO {
  validatedRoots?: ValidatedProcessingRoots;
}

export interface PlannedOperation {
  id: string;
  sourcePath: string;
  targetPath: string;
  bytes: number;
  payload?: CoordinatorJsonValue;
}

export interface PreviewPlan {
  summary: PreviewSummaryDTO;
  rows?: PreviewRowDTO[];
  operations: readonly PlannedOperation[];
  decisionRecords?: readonly PreviewDecisionRecord[];
}

export interface PreviewDecisionRecord {
  rowIndex: number;
  sourcePath: string;
  resolution: DateResolutionRecord;
}

export interface PreviewOperationAuditRecord {
  operationIndex: number;
  operationId: string;
  sourcePath: string;
  targetPath: string;
  bytes: number;
  decisionRowIndex: number;
}

export interface PreviewAuditRecord {
  jobId: string;
  previewId: string;
  decisionRecords: PreviewDecisionRecord[];
  operationRecords: PreviewOperationAuditRecord[];
}

export interface PreparedPreview {
  result: Readonly<PreviewResultDTO>;
  operations: readonly Readonly<PlannedOperation>[];
  /** Complete private rows; renderer transport remains bounded. */
  allRows?: readonly Readonly<PreviewRowDTO>[];
  audit: Readonly<PreviewAuditRecord>;
}

export interface PreviewPlannerPort {
  plan(
    request: Readonly<PreviewPlanningRequest>,
    signal?: AbortSignal,
    reportProgress?: (progress: Readonly<PreviewProgressDTO>) => Promise<void> | void
  ): Promise<PreviewPlan>;
}

export interface PreviewRevalidationResult {
  sourceFingerprintMatches: boolean;
  configMatches: boolean;
  reasons: string[];
}

export interface PreviewRevalidatorPort {
  revalidate(preview: Readonly<PreparedPreview>): Promise<PreviewRevalidationResult>;
}

export type OperationOutcome = 'committed' | 'skipped' | 'failed' | 'cancelled';

export interface OperationLedgerEntry {
  operationId: string;
  outcome: OperationOutcome;
  bytes: number;
  error?: string;
  cancellationState?:
    | typeof CancellationFileState.CANCELLED_BEFORE_COMMIT
    | typeof CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED;
  sourceRetained?: boolean;
  destinationCommitted?: boolean;
}

export interface OperationExecutionContext {
  jobId: string;
  previewId: string;
  mode: ProcessingOptionsDTO['operation'];
  writeMetadataDates: boolean;
  signal: AbortSignal;
  /**
   * Optional channel for durable authorization work (evidence verification,
   * audit index construction) that precedes a file transaction. Executors
   * forward it so long preparation phases stay visible and cancellable.
   */
  reportStageProgress?: (progress: Readonly<AuditPreparationProgressDTO>) => Promise<void> | void;
}

export interface OperationExecutorPort {
  /**
   * Implementations must settle promptly after `signal` aborts. The coordinator
   * stops new admission immediately but cannot preempt an already-running Promise.
   */
  execute(
    operation: Readonly<PlannedOperation>,
    context: Readonly<OperationExecutionContext>
  ): Promise<OperationLedgerEntry>;
}

export interface StartRejectionRecord {
  jobId: string;
  previewId: string;
  code: CoordinatorErrorCode;
  reasons: string[];
  rejectedAt: string;
}

export interface LedgerHistoryRecord {
  jobId: string;
  previewId: string;
  entry: Readonly<OperationLedgerEntry>;
}

export interface CoordinatorHistoryPort {
  recordPreview?(
    preview: Readonly<PreviewResultDTO>,
    audit?: Readonly<PreviewAuditRecord>
  ): Promise<void> | void;
  recordEvent?(event: Readonly<ProcessingEvent>): Promise<void> | void;
  recordLedgerEntry?(record: Readonly<LedgerHistoryRecord>): Promise<void> | void;
  recordStartRejection?(record: Readonly<StartRejectionRecord>): Promise<void> | void;
  recordTerminal?(event: Readonly<TerminalProcessingEvent>): Promise<void> | void;
}

export interface CoordinatorClock {
  now(): number;
}

export type CoordinatorIdGenerator = (kind: 'job' | 'preview') => string;

export interface ProcessingCoordinatorDependencies {
  planner: PreviewPlannerPort;
  revalidator: PreviewRevalidatorPort;
  executor: OperationExecutorPort;
  history?: CoordinatorHistoryPort;
  previewTtlMs: number;
  maxWorkerConcurrency: number;
  defaultOptions?: Partial<ProcessingOptionsDTO>;
  clock?: CoordinatorClock;
  idGenerator?: CoordinatorIdGenerator;
  onHookError?: (error: unknown) => void;
}

export const CoordinatorErrorCode = {
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_PLAN: 'INVALID_PLAN',
  PREVIEW_NOT_FOUND: 'PREVIEW_NOT_FOUND',
  PREVIEW_EXPIRED: 'PREVIEW_EXPIRED',
  PREVIEW_CONSUMED: 'PREVIEW_CONSUMED',
  PREVIEW_DRIFT: 'PREVIEW_DRIFT',
  PREVIEW_ALREADY_ACTIVE: 'PREVIEW_ALREADY_ACTIVE',
  PREVIEW_CANCELLED: 'PREVIEW_CANCELLED',
  PREVIEW_FINALIZING: 'PREVIEW_FINALIZING',
  REVALIDATION_FAILED: 'REVALIDATION_FAILED',
  MOVE_ACK_REQUIRED: 'MOVE_ACK_REQUIRED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  INVALID_EVENT_TRANSITION: 'INVALID_EVENT_TRANSITION',
  HISTORY_PERSISTENCE_FAILED: 'HISTORY_PERSISTENCE_FAILED',
  COORDINATOR_SHUTDOWN: 'COORDINATOR_SHUTDOWN',
} as const;

export type CoordinatorErrorCode = (typeof CoordinatorErrorCode)[keyof typeof CoordinatorErrorCode];

export class ProcessingCoordinatorError extends Error {
  public readonly code: CoordinatorErrorCode;
  public readonly details: readonly string[];

  constructor(code: CoordinatorErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'ProcessingCoordinatorError';
    this.code = code;
    this.details = [...details];
  }
}

interface EventContext {
  readonly jobId: string;
  readonly machine: JobStateMachine;
  nextSequence: number;
  historyReady: boolean;
  eventQueue: Promise<void>;
}

interface PreviewEntry extends EventContext {
  readonly previewId: string;
  readonly expiresAtMs: number;
  readonly prepared: Readonly<PreparedPreview>;
  starting: boolean;
  consumed: boolean;
}

interface ActivePreview extends EventContext {
  readonly controller: AbortController;
  cancellable: boolean;
}

interface ActiveJob extends EventContext {
  readonly previewId: string;
  readonly prepared: Readonly<PreparedPreview>;
  readonly controller: AbortController;
  readonly ledger: OperationLedgerEntry[];
  readonly startedAtMs: number;
  readonly totalBytes: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  processedBytes: number;
  settledFiles: number;
  lastProgressPersistedAtMs?: number;
  readonly terminalPromise: Promise<TerminalProcessingEvent>;
  readonly resolveTerminal: (event: TerminalProcessingEvent) => void;
  readonly rejectTerminal: (error: unknown) => void;
  terminalEmitted: boolean;
  cancellationPromise?: Promise<void>;
  cancelReason?: string;
}

type TerminalEventDescriptor = {
  [K in TerminalProcessingEvent['kind']]: {
    kind: K;
    payload: Extract<TerminalProcessingEvent, { kind: K }>['payload'];
  };
}[TerminalProcessingEvent['kind']];

const BUILTIN_DEFAULT_OPTIONS: ProcessingOptionsDTO = {
  operation: OperationMode.COPY,
  conflictPolicy: ConflictPolicy.RENAME,
  folderStructure: FolderStructure.YEAR_MONTH,
  appendScreenshotSuffix: false,
  workerCount: 1,
  verifyIntegrity: true,
  writeMetadataDates: false,
};

const PROGRESS_PERSIST_INTERVAL_MS = 1_000;
const MAX_PUBLIC_PREVIEW_ROWS = 500;

function operationBindingKey(sourcePath: string, targetPath: string, bytes: number): string {
  return `${sourcePath.length}:${sourcePath}${targetPath.length}:${targetPath}${bytes}`;
}

function publicPreviewRow(row: PreviewRowDTO): PreviewRowDTO {
  return {
    sourcePath: row.sourcePath,
    targetPath: row.targetPath,
    operation: row.operation,
    conflictPolicy: row.conflictPolicy,
    dateEvidence: {
      value: row.dateEvidence.value,
      source: row.dateEvidence.source,
      ...(row.dateEvidence.field === undefined ? {} : { field: row.dateEvidence.field }),
      confidence: row.dateEvidence.confidence,
      warnings: [...row.dateEvidence.warnings],
    },
    fingerprint: {
      size: row.fingerprint.size,
      modifiedAt: row.fingerprint.modifiedAt,
      ...(row.fingerprint.hash === undefined ? {} : { hash: row.fingerprint.hash }),
    },
    warnings: [...row.warnings],
  };
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
  }
  return value;
}

function snapshotSerializable<T>(
  value: T,
  label: string,
  errorCode: CoordinatorErrorCode = CoordinatorErrorCode.INVALID_PLAN
): T {
  const ancestors = new WeakSet<object>();

  const snapshot = (candidate: unknown, path: string): CoordinatorJsonValue => {
    if (candidate === null) return null;
    switch (typeof candidate) {
      case 'string':
      case 'boolean':
        return candidate;
      case 'number':
        if (Number.isFinite(candidate)) return candidate;
        break;
      case 'object': {
        if (ancestors.has(candidate)) break;
        const prototype = Object.getPrototypeOf(candidate);
        if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
          break;
        }

        ancestors.add(candidate);
        try {
          const descriptors = Object.getOwnPropertyDescriptors(candidate);
          if (Array.isArray(candidate)) {
            const length = descriptors.length?.value;
            if (!Number.isSafeInteger(length) || length < 0) break;
            const result: CoordinatorJsonValue[] = [];
            for (let index = 0; index < length; index += 1) {
              const descriptor = descriptors[String(index)];
              if (descriptor === undefined) break;
              if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                throw new ProcessingCoordinatorError(
                  errorCode,
                  `${path}[${index}] must be a data property`
                );
              }
              result.push(snapshot(descriptor.value, `${path}[${index}]`));
            }
            if (result.length === length) return result;
            break;
          }

          const result: { [key: string]: CoordinatorJsonValue } = {};
          for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key !== 'string') {
              throw new ProcessingCoordinatorError(errorCode, `${path} cannot contain symbol keys`);
            }
            const descriptor = descriptors[key];
            if (!descriptor.enumerable) {
              throw new ProcessingCoordinatorError(
                errorCode,
                `${path}.${key} must be an enumerable data property`
              );
            }
            if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
              throw new ProcessingCoordinatorError(
                errorCode,
                `${path}.${key} must be a data property`
              );
            }
            result[key] = snapshot(descriptor.value, `${path}.${key}`);
          }
          return result;
        } finally {
          ancestors.delete(candidate);
        }
      }
    }

    throw new ProcessingCoordinatorError(errorCode, `${path} must be JSON-serializable`);
  };

  return snapshot(value, label) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class ProcessingCoordinator {
  private readonly planner: PreviewPlannerPort;
  private readonly revalidator: PreviewRevalidatorPort;
  private readonly executor: OperationExecutorPort;
  private readonly history?: CoordinatorHistoryPort;
  private readonly previewTtlMs: number;
  private readonly maxWorkerConcurrency: number;
  private readonly defaultOptions: ProcessingOptionsDTO;
  private readonly clock: CoordinatorClock;
  private readonly idGenerator: CoordinatorIdGenerator;
  private readonly onHookError?: (error: unknown) => void;
  private readonly previews = new Map<string, PreviewEntry>();
  private readonly activePreviews = new Map<string, ActivePreview>();
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly reservedIds = new Set<string>();
  private readonly listeners = new Set<(event: Readonly<ProcessingEvent>) => void>();
  private readonly admissions = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(dependencies: ProcessingCoordinatorDependencies) {
    if (!Number.isSafeInteger(dependencies.previewTtlMs) || dependencies.previewTtlMs <= 0) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'previewTtlMs must be a positive safe integer'
      );
    }
    if (
      !Number.isSafeInteger(dependencies.maxWorkerConcurrency) ||
      dependencies.maxWorkerConcurrency <= 0
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'maxWorkerConcurrency must be a positive safe integer'
      );
    }

    this.planner = dependencies.planner;
    this.revalidator = dependencies.revalidator;
    this.executor = dependencies.executor;
    this.history = dependencies.history;
    this.previewTtlMs = dependencies.previewTtlMs;
    this.maxWorkerConcurrency = dependencies.maxWorkerConcurrency;
    this.clock = dependencies.clock ?? { now: () => Date.now() };
    this.idGenerator = dependencies.idGenerator ?? (() => randomUUID());
    this.onHookError = dependencies.onHookError;
    const defaultOptionOverrides = snapshotSerializable(
      dependencies.defaultOptions ?? {},
      'default options',
      CoordinatorErrorCode.INVALID_CONFIGURATION
    );
    this.defaultOptions = this.normalizeOptions({
      ...BUILTIN_DEFAULT_OPTIONS,
      ...defaultOptionOverrides,
    });
  }

  public subscribe(listener: (event: Readonly<ProcessingEvent>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public createPreview(request: CoordinatorPreviewRequest): Promise<Readonly<PreviewResultDTO>> {
    return this.admit(() => this.createPreviewInternal(request));
  }

  private async createPreviewInternal(
    request: CoordinatorPreviewRequest
  ): Promise<Readonly<PreviewResultDTO>> {
    const requestSnapshot = snapshotSerializable(
      request,
      'preview request',
      CoordinatorErrorCode.INVALID_REQUEST
    );
    this.validatePreviewRequest(requestSnapshot);
    const optionOverrides = snapshotSerializable(
      requestSnapshot.options ?? {},
      'preview options',
      CoordinatorErrorCode.INVALID_CONFIGURATION
    );
    const effectiveOptions = this.normalizeOptions({
      ...this.defaultOptions,
      ...optionOverrides,
    });
    const normalizedRequest: PreviewRequestDTO = {
      sourcePaths: [...requestSnapshot.sourcePaths],
      destinationPath: requestSnapshot.destinationPath,
      options: { ...effectiveOptions },
    };
    const plannerRequest: PreviewPlanningRequest = {
      ...normalizedRequest,
      ...(requestSnapshot.validatedRoots === undefined
        ? {}
        : { validatedRoots: requestSnapshot.validatedRoots }),
    };
    if (this.activePreviews.size > 0) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.PREVIEW_ALREADY_ACTIVE,
        'Another preview analysis is already active'
      );
    }
    const jobId = this.generateUniqueId('job');
    let previewId: string;
    try {
      previewId = this.generateUniqueId('preview');
    } catch (error) {
      this.reservedIds.delete(jobId);
      throw error;
    }
    const context: ActivePreview = {
      jobId,
      machine: new JobStateMachine(jobId),
      nextSequence: 1,
      historyReady: false,
      eventQueue: Promise.resolve(),
      controller: new AbortController(),
      cancellable: true,
    };
    this.activePreviews.set(jobId, context);

    try {
      await this.publish(context, ProcessingEventKind.PREVIEW_STARTED, {
        sourceCount: normalizedRequest.sourcePaths.length,
        destinationPath: normalizedRequest.destinationPath,
      });

      let previousProgress: PreviewProgressDTO | undefined;
      let plan: PreviewPlan;
      try {
        plan = snapshotSerializable(
          await this.planner.plan(
            freezeDeep(snapshotSerializable(plannerRequest, 'request')),
            context.controller.signal,
            async (reportedProgress) => {
              const progress = snapshotSerializable(
                reportedProgress,
                'preview progress'
              ) as PreviewProgressDTO;
              this.validatePreviewProgress(progress, previousProgress);
              previousProgress = { ...progress };
              await this.publish(context, ProcessingEventKind.PREVIEW_PROGRESS, progress);
            }
          ),
          'preview plan'
        );
        if (context.controller.signal.aborted) {
          throw this.previewCancelledError(context.controller.signal.reason);
        }
        this.validatePlan(plan, effectiveOptions);
        this.validateCompletedPreviewProgress(previousProgress, plan.summary.totalFiles);
        context.cancellable = false;
      } catch (error) {
        const cancelled = context.controller.signal.aborted || isAbortError(error);
        const failure = cancelled
          ? this.previewCancelledError(context.controller.signal.reason)
          : error instanceof ProcessingCoordinatorError
            ? error
            : new ProcessingCoordinatorError(
                CoordinatorErrorCode.INVALID_PLAN,
                errorMessage(error)
              );
        await this.publish(context, ProcessingEventKind.JOB_FAILED, {
          error: {
            code: failure.code,
            message: failure.message,
            recoverable: true,
          },
        });
        throw failure;
      }

      const createdAtMs = this.now();
      const expiresAtMs = createdAtMs + this.previewTtlMs;
      const result: PreviewResultDTO = {
        jobId,
        previewId,
        createdAt: this.toISOString(createdAtMs),
        expiresAt: this.toISOString(expiresAtMs),
        request: normalizedRequest,
        effectiveOptions: { ...effectiveOptions },
        summary: { ...plan.summary },
        ...(plan.rows === undefined
          ? {}
          : { rows: plan.rows.slice(0, MAX_PUBLIC_PREVIEW_ROWS).map(publicPreviewRow) }),
      };
      const decisionByOperation = new Map<string, PreviewDecisionRecord>();
      for (const record of plan.decisionRecords ?? []) {
        const row = plan.rows?.[record.rowIndex];
        if (row?.targetPath !== null && row?.targetPath !== undefined) {
          decisionByOperation.set(
            operationBindingKey(record.sourcePath, row.targetPath, row.fingerprint.size),
            record
          );
        }
      }
      const prepared = freezeDeep<PreparedPreview>({
        result,
        operations: plan.operations,
        ...(plan.rows === undefined ? {} : { allRows: plan.rows }),
        audit: {
          jobId,
          previewId,
          decisionRecords: plan.decisionRecords === undefined ? [] : [...plan.decisionRecords],
          operationRecords: plan.operations.flatMap((operation, operationIndex) => {
            const decision = decisionByOperation.get(
              operationBindingKey(operation.sourcePath, operation.targetPath, operation.bytes)
            );
            return decision === undefined
              ? []
              : [
                  {
                    operationIndex,
                    operationId: operation.id,
                    sourcePath: operation.sourcePath,
                    targetPath: operation.targetPath,
                    bytes: operation.bytes,
                    decisionRowIndex: decision.rowIndex,
                  },
                ];
          }),
        },
      });
      const entry: PreviewEntry = {
        jobId: context.jobId,
        machine: context.machine,
        nextSequence: context.nextSequence,
        historyReady: context.historyReady,
        eventQueue: context.eventQueue,
        previewId,
        expiresAtMs,
        prepared,
        starting: false,
        consumed: false,
      };

      await this.persistHistory('preview creation', () =>
        this.history?.recordPreview?.(
          prepared.allRows === undefined
            ? prepared.result
            : { ...prepared.result, rows: prepared.allRows.map(publicPreviewRow) },
          prepared.audit
        )
      );
      entry.historyReady = true;
      await this.publish(entry, ProcessingEventKind.PREVIEW_READY, {
        previewId,
        summary: prepared.result.summary,
      });
      this.previews.set(previewId, entry);
      return prepared.result;
    } finally {
      this.activePreviews.delete(jobId);
    }
  }

  public startProcessing(
    request: StartProcessingRequestDTO
  ): Promise<Readonly<StartProcessingResultDTO>> {
    return this.admit(() => this.startProcessingInternal(request));
  }

  private async startProcessingInternal(
    request: StartProcessingRequestDTO
  ): Promise<Readonly<StartProcessingResultDTO>> {
    const requestSnapshot = snapshotSerializable(
      request,
      'start request',
      CoordinatorErrorCode.INVALID_REQUEST
    );
    this.validateStartRequest(requestSnapshot);
    const entry = this.previews.get(requestSnapshot.previewId);
    if (entry === undefined) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.PREVIEW_NOT_FOUND,
        'previewId does not identify an available preview'
      );
    }
    if (entry.consumed || entry.starting) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.PREVIEW_CONSUMED,
        'preview has already been consumed'
      );
    }
    if (this.now() >= entry.expiresAtMs) {
      await this.rejectStart(entry, CoordinatorErrorCode.PREVIEW_EXPIRED, ['preview expired']);
    }
    if (
      entry.prepared.result.effectiveOptions.operation === OperationMode.MOVE &&
      requestSnapshot.acknowledgeDestructiveOperation !== true
    ) {
      await this.rejectStart(entry, CoordinatorErrorCode.MOVE_ACK_REQUIRED, [
        'move requires explicit acknowledgement',
      ]);
    }

    entry.starting = true;
    let revalidation: PreviewRevalidationResult;
    try {
      revalidation = snapshotSerializable(
        await this.revalidator.revalidate(entry.prepared),
        'revalidation result'
      );
      if (
        typeof revalidation !== 'object' ||
        revalidation === null ||
        typeof revalidation.sourceFingerprintMatches !== 'boolean' ||
        typeof revalidation.configMatches !== 'boolean' ||
        !Array.isArray(revalidation.reasons) ||
        revalidation.reasons.some((reason) => typeof reason !== 'string')
      ) {
        throw new ProcessingCoordinatorError(
          CoordinatorErrorCode.REVALIDATION_FAILED,
          'revalidator returned an invalid result'
        );
      }
    } catch (error) {
      entry.starting = false;
      return this.rejectStart(entry, CoordinatorErrorCode.REVALIDATION_FAILED, [
        errorMessage(error),
      ]);
    }

    let revalidatedAtMs: number;
    try {
      revalidatedAtMs = this.now();
    } catch (error) {
      entry.starting = false;
      throw error;
    }
    if (revalidatedAtMs >= entry.expiresAtMs) {
      entry.starting = false;
      await this.rejectStart(entry, CoordinatorErrorCode.PREVIEW_EXPIRED, [
        'preview expired during revalidation',
      ]);
    }
    if (revalidation.sourceFingerprintMatches !== true || revalidation.configMatches !== true) {
      entry.starting = false;
      entry.consumed = true;
      await this.rejectStart(entry, CoordinatorErrorCode.PREVIEW_DRIFT, [...revalidation.reasons]);
    }

    let acceptedAtMs: number;
    let startedAtMs: number;
    let queuedAtMs: number;
    try {
      acceptedAtMs = this.now();
      startedAtMs = this.now();
      queuedAtMs = this.now();
    } catch (error) {
      entry.starting = false;
      throw error;
    }
    const acceptedAt = this.toISOString(acceptedAtMs);
    let resolveTerminal!: (event: TerminalProcessingEvent) => void;
    let rejectTerminal!: (error: unknown) => void;
    const terminalPromise = new Promise<TerminalProcessingEvent>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    void terminalPromise.catch(() => undefined);
    const activeJob: ActiveJob = {
      jobId: entry.jobId,
      previewId: entry.previewId,
      machine: entry.machine,
      nextSequence: entry.nextSequence,
      historyReady: entry.historyReady,
      eventQueue: entry.eventQueue,
      prepared: entry.prepared,
      controller: new AbortController(),
      ledger: [],
      startedAtMs,
      totalBytes: entry.prepared.operations.reduce(
        (total, operation) => total + operation.bytes,
        0
      ),
      processedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      processedBytes: 0,
      settledFiles: 0,
      terminalPromise,
      resolveTerminal,
      rejectTerminal,
      terminalEmitted: false,
    };
    try {
      await this.publish(
        activeJob,
        ProcessingEventKind.JOB_QUEUED,
        {
          previewId: activeJob.previewId,
          effectiveOptions: activeJob.prepared.result.effectiveOptions,
        },
        queuedAtMs
      );
    } catch (error) {
      entry.starting = false;
      throw error;
    }
    entry.starting = false;
    entry.consumed = true;
    this.activeJobs.set(activeJob.jobId, activeJob);
    void this.runJob(activeJob);

    return freezeDeep({
      jobId: activeJob.jobId,
      previewId: activeJob.previewId,
      acceptedAt,
      effectiveOptions: { ...activeJob.prepared.result.effectiveOptions },
    });
  }

  public async cancelProcessing(jobId: string, reason?: string): Promise<void> {
    const preview = this.activePreviews.get(jobId);
    if (preview) {
      if (!preview.cancellable) {
        throw new ProcessingCoordinatorError(
          CoordinatorErrorCode.PREVIEW_FINALIZING,
          'Preview analysis is already finalizing'
        );
      }
      if (!preview.controller.signal.aborted) {
        preview.controller.abort(reason ?? 'Preview analysis stopped');
      }
      return;
    }
    const job = this.activeJobs.get(jobId);
    if (job === undefined) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.JOB_NOT_FOUND,
        'jobId does not identify an active or completed job'
      );
    }
    if (job.terminalEmitted || isTerminalJobStatus(job.machine.snapshot().status)) return;
    if (job.cancellationPromise) return job.cancellationPromise;

    job.cancelReason = reason;
    job.controller.abort(reason);
    job.cancellationPromise = this.publish(job, ProcessingEventKind.JOB_CANCELLING, {
      ...(reason === undefined ? {} : { reason }),
    }).then(() => undefined);
    return job.cancellationPromise;
  }

  public async waitForTerminal(jobId: string): Promise<TerminalProcessingEvent> {
    const job = this.activeJobs.get(jobId);
    if (job === undefined) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.JOB_NOT_FOUND,
        'jobId does not identify an active or completed job'
      );
    }
    return job.terminalPromise;
  }

  public shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    for (const preview of this.activePreviews.values()) {
      if (preview.cancellable && !preview.controller.signal.aborted) {
        preview.controller.abort('application shutdown');
      }
    }
    const cancelActiveJobs = (): Promise<PromiseSettledResult<void>[]> =>
      Promise.allSettled(
        [...this.activeJobs.values()].map((job) =>
          job.terminalEmitted || isTerminalJobStatus(job.machine.snapshot().status)
            ? Promise.resolve()
            : this.cancelProcessing(job.jobId, 'application shutdown')
        )
      );

    const initialCancellation = cancelActiveJobs();
    while (this.admissions.size > 0) {
      await Promise.allSettled([...this.admissions]);
    }
    await initialCancellation;
    await cancelActiveJobs();
    const activeJobs = [...this.activeJobs.values()];
    await Promise.allSettled(activeJobs.map((job) => job.terminalPromise));
    await Promise.allSettled([
      ...[...this.previews.values()].map((entry) => entry.eventQueue),
      ...activeJobs.map((job) => job.eventQueue),
    ]);
    this.listeners.clear();
  }

  private admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) {
      return Promise.reject(
        new ProcessingCoordinatorError(
          CoordinatorErrorCode.COORDINATOR_SHUTDOWN,
          'processing coordinator is shutting down'
        )
      );
    }
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      result = Promise.reject(error);
    }
    this.admissions.add(result);
    void result.then(
      () => this.admissions.delete(result),
      () => this.admissions.delete(result)
    );
    return result;
  }

  private async runJob(job: ActiveJob): Promise<void> {
    let workerFailure: unknown;
    let hasWorkerFailure = false;
    try {
      await this.publish(job, ProcessingEventKind.JOB_STARTED, {
        phase: ProcessingPhase.ORGANIZATION,
      });
      let nextOperationIndex = 0;
      const operationCount = job.prepared.operations.length;
      const workerCount = Math.min(
        job.prepared.result.effectiveOptions.workerCount,
        operationCount
      );
      // Authorization evidence for the first eligible file can take minutes at
      // corpus scale. Publish it as ephemeral job progress so the run stays
      // visibly active instead of appearing frozen between file counters.
      let lastStageProgressAtMs = -Infinity;
      const reportStageProgress = async (
        reported: Readonly<AuditPreparationProgressDTO>
      ): Promise<void> => {
        if (job.controller.signal.aborted) return;
        const progressAtMs = this.now();
        if (progressAtMs - lastStageProgressAtMs < 250) return;
        lastStageProgressAtMs = progressAtMs;
        const preparation = snapshotSerializable(
          reported,
          'stage progress'
        ) as AuditPreparationProgressDTO;
        await this.publish(
          job,
          ProcessingEventKind.JOB_PROGRESS,
          {
            phase: ProcessingPhase.ORGANIZATION,
            filesProcessed: job.processedFiles,
            totalFiles: operationCount,
            percentage: operationCount === 0 ? 100 : (job.processedFiles / operationCount) * 100,
            preparation,
          },
          progressAtMs,
          false
        );
      };

      const worker = async (): Promise<void> => {
        try {
          while (!job.controller.signal.aborted && !hasWorkerFailure) {
            if (nextOperationIndex >= operationCount) return;
            const operation = job.prepared.operations[nextOperationIndex];
            nextOperationIndex += 1;

            let ledgerEntry: OperationLedgerEntry;
            try {
              ledgerEntry = this.normalizeLedgerEntry(
                operation,
                job.prepared.result.effectiveOptions.operation,
                await this.executor.execute(operation, {
                  jobId: job.jobId,
                  previewId: job.previewId,
                  mode: job.prepared.result.effectiveOptions.operation,
                  writeMetadataDates: job.prepared.result.effectiveOptions.writeMetadataDates,
                  signal: job.controller.signal,
                  reportStageProgress,
                })
              );
            } catch (error) {
              if (job.controller.signal.aborted || isAbortError(error)) {
                ledgerEntry = {
                  operationId: operation.id,
                  outcome: 'cancelled',
                  bytes: 0,
                  cancellationState: CancellationFileState.CANCELLED_BEFORE_COMMIT,
                  sourceRetained: true,
                  destinationCommitted: false,
                  error: errorMessage(error),
                };
              } else {
                ledgerEntry = {
                  operationId: operation.id,
                  outcome: 'failed',
                  bytes: 0,
                  error: errorMessage(error),
                };
              }
            }

            const immutableEntry = freezeDeep(snapshotSerializable(ledgerEntry, 'ledger entry'));
            // Execution has already settled and may have mutated the filesystem. Keep that
            // outcome in memory before attempting the fallible audit append so a persistence
            // outage cannot erase committed work from the terminal truth.
            job.ledger.push(immutableEntry);
            job.settledFiles += 1;
            switch (immutableEntry.outcome) {
              case 'committed':
                job.processedFiles += 1;
                job.processedBytes += immutableEntry.bytes;
                break;
              case 'skipped':
                job.skippedFiles += 1;
                break;
              case 'failed':
                job.failedFiles += 1;
                break;
              case 'cancelled':
                break;
            }
            await this.persistHistory('ledger entry', () =>
              this.history?.recordLedgerEntry?.(
                freezeDeep({
                  jobId: job.jobId,
                  previewId: job.previewId,
                  entry: immutableEntry,
                })
              )
            );

            if (!job.controller.signal.aborted && !hasWorkerFailure) {
              const progressAtMs = this.now();
              const durationMs = Math.max(0, progressAtMs - job.startedAtMs);
              const throughput = durationMs === 0 ? 0 : job.processedBytes / (durationMs / 1_000);
              const remainingBytes = Math.max(0, job.totalBytes - job.processedBytes);
              const persistProgress =
                job.lastProgressPersistedAtMs === undefined ||
                job.settledFiles === operationCount ||
                progressAtMs - job.lastProgressPersistedAtMs >= PROGRESS_PERSIST_INTERVAL_MS;
              if (persistProgress) job.lastProgressPersistedAtMs = progressAtMs;
              await this.publish(
                job,
                ProcessingEventKind.JOB_PROGRESS,
                {
                  phase: ProcessingPhase.ORGANIZATION,
                  filesProcessed: job.processedFiles,
                  totalFiles: operationCount,
                  percentage:
                    operationCount === 0 ? 100 : (job.processedFiles / operationCount) * 100,
                  currentFile: operation.sourcePath,
                  bytesProcessed: job.processedBytes,
                  totalBytes: job.totalBytes,
                  throughput,
                  ...(remainingBytes === 0
                    ? { eta: 0 }
                    : throughput > 0
                      ? { eta: remainingBytes / throughput }
                      : {}),
                },
                progressAtMs,
                persistProgress
              );
            }
          }
        } catch (error) {
          if (!hasWorkerFailure) {
            hasWorkerFailure = true;
            workerFailure = error;
          }
          throw error;
        }
      };

      await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
      if (hasWorkerFailure) throw workerFailure;
      if (job.controller.signal.aborted) {
        await this.emitTerminalOnce(job, {
          kind: ProcessingEventKind.JOB_CANCELLED,
          payload: this.cancellationPayloadFromLedger(job),
        });
        return;
      }

      const statistics = this.statisticsFromLedger(job);
      const fileFailures = this.fileFailuresFromLedger(job);
      if (fileFailures.length === 0) {
        await this.emitTerminalOnce(job, {
          kind: ProcessingEventKind.JOB_COMPLETED,
          payload: { statistics },
        });
      } else if (statistics.failedFiles === statistics.totalFiles) {
        const noun = statistics.failedFiles === 1 ? 'file operation' : 'file operations';
        await this.emitTerminalOnce(job, {
          kind: ProcessingEventKind.JOB_FAILED,
          payload: {
            error: {
              code: 'FILE_OPERATIONS_FAILED',
              message: `All ${statistics.failedFiles} ${noun} failed`,
              recoverable: true,
            },
            statistics,
            fileFailures,
          },
        });
      } else {
        const fileOutcomes = this.cancellationPayloadFromLedger(job).fileOutcomes;
        await this.emitTerminalOnce(job, {
          kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
          payload: { statistics, fileFailures, fileOutcomes },
        });
      }
    } catch (error) {
      if (job.terminalEmitted) return;
      if (job.controller.signal.aborted && !hasWorkerFailure) {
        await this.emitTerminalOnce(job, {
          kind: ProcessingEventKind.JOB_CANCELLED,
          payload: this.cancellationPayloadFromLedger(job),
        }).catch(() => undefined);
        return;
      }
      const failureMessage = errorMessage(error);
      const statistics = this.statisticsFromLedger(job, true);
      const fileFailures = this.fileFailuresFromLedger(
        job,
        `Not processed because coordinator stopped after: ${failureMessage}`
      );
      await this.emitTerminalOnce(job, {
        kind: ProcessingEventKind.JOB_FAILED,
        payload: {
          error: {
            code: error instanceof ProcessingCoordinatorError ? error.code : 'COORDINATOR_FAILURE',
            message: failureMessage,
            recoverable: false,
          },
          statistics,
          fileFailures,
        },
      }).catch(() => undefined);
    }
  }

  private statisticsFromLedger(
    job: ActiveJob,
    countUnrecordedAsFailed: boolean = false
  ): ProcessingStatisticsDTO {
    const unrecordedCount = countUnrecordedAsFailed
      ? job.prepared.operations.length - job.settledFiles
      : 0;
    return {
      totalFiles: job.prepared.operations.length,
      processedFiles: job.processedFiles,
      skippedFiles: job.skippedFiles,
      failedFiles: job.failedFiles + unrecordedCount,
      totalBytes: job.totalBytes,
      processedBytes: job.processedBytes,
      durationMs: Math.max(0, this.now() - job.startedAtMs),
    };
  }

  private fileFailuresFromLedger(
    job: ActiveJob,
    unrecordedFailure?: string
  ): ProcessingFileFailureDTO[] {
    const sourcePathByOperationId = new Map(
      job.prepared.operations.map((operation) => [operation.id, operation.sourcePath])
    );
    const failures = job.ledger
      .filter((entry) => entry.outcome === 'failed')
      .map((entry) => ({
        sourcePath: sourcePathByOperationId.get(entry.operationId) ?? entry.operationId,
        error: entry.error?.trim() || 'Operation failed without an error message',
      }));
    if (unrecordedFailure === undefined) return failures;

    const recordedOperationIds = new Set(job.ledger.map((entry) => entry.operationId));
    return [
      ...failures,
      ...job.prepared.operations
        .filter((operation) => !recordedOperationIds.has(operation.id))
        .map((operation) => ({
          sourcePath: operation.sourcePath,
          error: unrecordedFailure,
        })),
    ];
  }

  private normalizeLedgerEntry(
    operation: Readonly<PlannedOperation>,
    mode: OperationMode,
    entry: OperationLedgerEntry
  ): OperationLedgerEntry {
    const snapshot = snapshotSerializable(entry, 'executor ledger entry');
    const {
      operationId,
      outcome,
      bytes,
      error,
      cancellationState,
      sourceRetained,
      destinationCommitted,
    } = snapshot;
    const isCancelled = outcome === 'cancelled';
    if (
      operationId !== operation.id ||
      !['committed', 'skipped', 'failed', 'cancelled'].includes(outcome) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > operation.bytes ||
      (outcome === 'committed' && bytes !== operation.bytes) ||
      (outcome === 'skipped' && bytes !== 0) ||
      (error !== undefined && (typeof error !== 'string' || error.trim().length === 0)) ||
      (isCancelled &&
        (![
          CancellationFileState.CANCELLED_BEFORE_COMMIT,
          CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED,
        ].includes(cancellationState as never) ||
          sourceRetained !== true ||
          typeof destinationCommitted !== 'boolean' ||
          (cancellationState === CancellationFileState.CANCELLED_BEFORE_COMMIT && bytes !== 0) ||
          (cancellationState === CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED &&
            bytes !== operation.bytes) ||
          (cancellationState === CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED &&
            mode !== OperationMode.MOVE) ||
          (destinationCommitted &&
            cancellationState !== CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED) ||
          (!destinationCommitted &&
            cancellationState !== CancellationFileState.CANCELLED_BEFORE_COMMIT))) ||
      (!isCancelled && cancellationState !== undefined) ||
      (outcome === 'failed' &&
        ((sourceRetained === undefined) !== (destinationCommitted === undefined) ||
          (sourceRetained !== undefined && typeof sourceRetained !== 'boolean') ||
          (destinationCommitted !== undefined && typeof destinationCommitted !== 'boolean') ||
          (destinationCommitted === false && bytes !== 0))) ||
      (!isCancelled &&
        outcome !== 'failed' &&
        (sourceRetained !== undefined || destinationCommitted !== undefined))
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_PLAN,
        `executor returned an invalid ledger entry for ${operation.id}`
      );
    }
    const normalizedError =
      outcome === 'failed'
        ? error === undefined
          ? 'Operation failed without an error message'
          : error.trim()
        : error;
    return {
      operationId,
      outcome,
      bytes,
      ...(normalizedError === undefined ? {} : { error: normalizedError }),
      ...(isCancelled
        ? { cancellationState, sourceRetained, destinationCommitted }
        : outcome === 'failed' && sourceRetained !== undefined
          ? { sourceRetained, destinationCommitted }
          : {}),
    };
  }

  private cancellationPayloadFromLedger(job: ActiveJob): {
    reason?: string;
    filesProcessed: number;
    statistics: ProcessingCancellationStatisticsDTO;
    fileFailures: ProcessingFileFailureDTO[];
    fileOutcomes: ProcessingCancellationFileOutcomeDTO[];
  } {
    const ledgerByOperationId = new Map(job.ledger.map((entry) => [entry.operationId, entry]));
    const isMove = job.prepared.result.effectiveOptions.operation === OperationMode.MOVE;
    const outcomeForOperation = (
      operation: Readonly<PlannedOperation>,
      sourcePath: string,
      destinationPath: string,
      plannedBytes: number
    ): ProcessingCancellationFileOutcomeDTO => {
      const entry = ledgerByOperationId.get(operation.id);
      if (entry === undefined) {
        return {
          sourcePath,
          destinationPath,
          state: CancellationFileState.NOT_ATTEMPTED,
          plannedBytes,
          committedBytes: 0,
          sourceRetained: true,
          error: 'Not attempted because the job was cancelled',
        };
      }

      const base = {
        sourcePath,
        destinationPath,
        plannedBytes,
        committedBytes: entry.bytes,
      };
      if (entry.outcome === 'committed') {
        return {
          ...base,
          state: CancellationFileState.COMPLETED,
          sourceRetained: !isMove,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        };
      }
      if (entry.outcome === 'skipped') {
        return {
          ...base,
          state: CancellationFileState.SKIPPED,
          sourceRetained: true,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        };
      }
      if (entry.outcome === 'cancelled') {
        return {
          ...base,
          state: entry.cancellationState!,
          sourceRetained: entry.sourceRetained!,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        };
      }
      if (
        entry.outcome === 'failed' &&
        isMove &&
        entry.destinationCommitted === true &&
        entry.sourceRetained === true &&
        entry.bytes === plannedBytes
      ) {
        return {
          ...base,
          state: CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED,
          sourceRetained: true,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        };
      }
      return {
        ...base,
        state: CancellationFileState.FAILED,
        sourceRetained: entry.sourceRetained ?? true,
        error: entry.error?.trim() || 'Operation failed without an error message',
      };
    };
    const operationsByRowIndex = new Map(
      job.prepared.audit.operationRecords.map((record) => [
        record.decisionRowIndex,
        job.prepared.operations[record.operationIndex],
      ])
    );
    const fileOutcomes: ProcessingCancellationFileOutcomeDTO[] =
      job.prepared.allRows === undefined
        ? job.prepared.operations.map((operation) =>
            outcomeForOperation(
              operation,
              operation.sourcePath,
              operation.targetPath,
              operation.bytes
            )
          )
        : job.prepared.allRows.map((row, rowIndex) => {
            if (row.operation === 'skip') {
              return {
                sourcePath: row.sourcePath,
                destinationPath: row.targetPath,
                state: CancellationFileState.SKIPPED,
                plannedBytes: row.fingerprint.size,
                committedBytes: 0,
                sourceRetained: true,
              };
            }
            const operation =
              operationsByRowIndex.get(rowIndex) ??
              job.prepared.operations.find(
                (candidate) =>
                  candidate.sourcePath === row.sourcePath &&
                  candidate.targetPath === row.targetPath &&
                  candidate.bytes === row.fingerprint.size
              );
            if (operation === undefined || row.targetPath === null) {
              throw new ProcessingCoordinatorError(
                CoordinatorErrorCode.INVALID_PLAN,
                `cancelled terminal cannot bind preview row ${rowIndex} to an operation`
              );
            }
            return outcomeForOperation(
              operation,
              row.sourcePath,
              row.targetPath,
              row.fingerprint.size
            );
          });
    const completed = fileOutcomes.filter(
      (outcome) => outcome.state === CancellationFileState.COMPLETED
    );
    const skipped = fileOutcomes.filter(
      (outcome) => outcome.state === CancellationFileState.SKIPPED
    );
    const failed = fileOutcomes.filter((outcome) => outcome.state === CancellationFileState.FAILED);
    const cancelled = fileOutcomes.filter((outcome) =>
      [
        CancellationFileState.CANCELLED_BEFORE_COMMIT,
        CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED,
      ].includes(outcome.state as never)
    );
    const unattempted = fileOutcomes.filter(
      (outcome) => outcome.state === CancellationFileState.NOT_ATTEMPTED
    );
    const statistics: ProcessingCancellationStatisticsDTO = {
      totalFiles: fileOutcomes.length,
      processedFiles: completed.length,
      skippedFiles: skipped.length,
      failedFiles: failed.length,
      cancelledFiles: cancelled.length,
      unattemptedFiles: unattempted.length,
      totalBytes: fileOutcomes.reduce((total, outcome) => total + outcome.plannedBytes, 0),
      processedBytes: completed.reduce((total, outcome) => total + outcome.committedBytes, 0),
      committedResidueBytes: fileOutcomes
        .filter((outcome) => outcome.state !== CancellationFileState.COMPLETED)
        .reduce((total, outcome) => total + outcome.committedBytes, 0),
      durationMs: Math.max(0, this.now() - job.startedAtMs),
    };
    return {
      ...(job.cancelReason === undefined ? {} : { reason: job.cancelReason }),
      filesProcessed: statistics.processedFiles,
      statistics,
      fileFailures: failed.map((outcome) => ({
        sourcePath: outcome.sourcePath,
        error: outcome.error!,
      })),
      fileOutcomes,
    };
  }

  private async emitTerminalOnce(
    job: ActiveJob,
    descriptor: TerminalEventDescriptor
  ): Promise<void> {
    if (job.terminalEmitted) return;
    job.terminalEmitted = true;
    try {
      let event: TerminalProcessingEvent;
      switch (descriptor.kind) {
        case ProcessingEventKind.JOB_COMPLETED:
          event = await this.publish(job, descriptor.kind, descriptor.payload);
          break;
        case ProcessingEventKind.JOB_PARTIALLY_COMPLETED:
          event = await this.publish(job, descriptor.kind, descriptor.payload);
          break;
        case ProcessingEventKind.JOB_FAILED:
          event = await this.publish(job, descriptor.kind, descriptor.payload);
          break;
        case ProcessingEventKind.JOB_CANCELLED:
          event = await this.publish(job, descriptor.kind, descriptor.payload);
          break;
      }
      await this.persistHistory('terminal record', () => this.history?.recordTerminal?.(event));
      job.resolveTerminal(event);
    } catch (error) {
      job.rejectTerminal(error);
      throw error;
    }
  }

  private publish<K extends ProcessingEvent['kind']>(
    context: EventContext,
    kind: K,
    payload: Extract<ProcessingEvent, { kind: K }>['payload'],
    emittedAtMs: number = this.now(),
    persistEvent: boolean = true
  ): Promise<Extract<ProcessingEvent, { kind: K }>> {
    const operation = context.eventQueue.then(async () => {
      const event = freezeDeep({
        kind,
        jobId: context.jobId,
        sequence: context.nextSequence,
        emittedAt: this.toISOString(emittedAtMs),
        payload,
      }) as unknown as Extract<ProcessingEvent, { kind: K }>;
      this.assertEventTransition(context, event);
      if (
        context.historyReady &&
        kind !== ProcessingEventKind.PREVIEW_STARTED &&
        kind !== ProcessingEventKind.PREVIEW_READY &&
        persistEvent
      ) {
        await this.persistHistory(`event ${kind}`, () => this.history?.recordEvent?.(event));
      }
      const acceptance = context.machine.accept(event);
      if (!acceptance.accepted) {
        throw new ProcessingCoordinatorError(
          CoordinatorErrorCode.INVALID_EVENT_TRANSITION,
          `event ${kind} was rejected: ${acceptance.reason}`
        );
      }
      context.nextSequence += 1;
      for (const listener of this.listeners) this.invokeObserver(() => listener(event));
      return event;
    });
    context.eventQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private assertEventTransition(context: EventContext, event: ProcessingEvent): void {
    const preflight = context.machine.canAccept(event);
    if (!preflight.accepted) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_EVENT_TRANSITION,
        `event ${event.kind} was rejected: ${preflight.reason}`
      );
    }
  }

  private async rejectStart(
    entry: PreviewEntry,
    code: CoordinatorErrorCode,
    reasons: string[]
  ): Promise<never> {
    await this.persistHistory('start rejection', () =>
      this.history?.recordStartRejection?.(
        freezeDeep({
          jobId: entry.jobId,
          previewId: entry.previewId,
          code,
          reasons: [...reasons],
          rejectedAt: this.toISOString(this.now()),
        })
      )
    );
    throw new ProcessingCoordinatorError(code, reasons.join('; '), reasons);
  }

  private normalizeOptions(options: ProcessingOptionsDTO): ProcessingOptionsDTO {
    const allowedKeys = new Set<keyof ProcessingOptionsDTO>([
      'operation',
      'conflictPolicy',
      'folderStructure',
      'appendScreenshotSuffix',
      'workerCount',
      'verifyIntegrity',
      'writeMetadataDates',
    ]);
    if (Object.keys(options).some((key) => !allowedKeys.has(key as keyof ProcessingOptionsDTO))) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'processing options contain an unknown key'
      );
    }
    if (!Object.values(OperationMode).includes(options.operation)) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'operation must be copy or move'
      );
    }
    if (!Object.values(ConflictPolicy).includes(options.conflictPolicy)) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'conflictPolicy must be skip or rename'
      );
    }
    if (!Object.values(FolderStructure).includes(options.folderStructure)) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'folderStructure is invalid'
      );
    }
    if (typeof options.appendScreenshotSuffix !== 'boolean') {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'appendScreenshotSuffix must be boolean'
      );
    }
    if (!Number.isFinite(options.workerCount)) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'workerCount must be finite'
      );
    }
    if (options.verifyIntegrity !== true) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'verifyIntegrity must remain enabled'
      );
    }
    if (typeof options.writeMetadataDates !== 'boolean') {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'writeMetadataDates must be boolean'
      );
    }
    return {
      ...options,
      workerCount: Math.max(
        1,
        Math.min(this.maxWorkerConcurrency, Math.floor(options.workerCount))
      ),
    };
  }

  private validatePreviewRequest(request: CoordinatorPreviewRequest): void {
    if (
      !Array.isArray(request.sourcePaths) ||
      request.sourcePaths.length === 0 ||
      request.sourcePaths.some((path) => typeof path !== 'string' || path.length === 0) ||
      typeof request.destinationPath !== 'string' ||
      request.destinationPath.length === 0
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_REQUEST,
        'preview requires source paths and a destination path'
      );
    }
    if (request.validatedRoots !== undefined) {
      try {
        assertValidatedProcessingRoots(request.validatedRoots);
      } catch (error) {
        throw new ProcessingCoordinatorError(
          CoordinatorErrorCode.INVALID_REQUEST,
          errorMessage(error)
        );
      }
      if (
        request.destinationPath !== request.validatedRoots.destinationPath ||
        request.sourcePaths.length !== request.validatedRoots.sourcePaths.length ||
        request.sourcePaths.some(
          (sourcePath, index) => sourcePath !== request.validatedRoots?.sourcePaths[index]
        )
      ) {
        throw new ProcessingCoordinatorError(
          CoordinatorErrorCode.INVALID_REQUEST,
          'preview paths disagree with their validated root identities'
        );
      }
    }
  }

  private validateStartRequest(request: StartProcessingRequestDTO): void {
    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request) ||
      Object.keys(request).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(request, 'previewId') ||
      !Object.prototype.hasOwnProperty.call(request, 'acknowledgeDestructiveOperation') ||
      typeof request.previewId !== 'string' ||
      request.previewId.length === 0 ||
      typeof request.acknowledgeDestructiveOperation !== 'boolean'
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_REQUEST,
        'start request requires a previewId and explicit acknowledgement boolean'
      );
    }
  }

  private validatePlan(plan: PreviewPlan, effectiveOptions: ProcessingOptionsDTO): void {
    if (
      typeof plan !== 'object' ||
      plan === null ||
      !Array.isArray(plan.operations) ||
      typeof plan.summary !== 'object' ||
      plan.summary === null ||
      (plan.rows !== undefined && !Array.isArray(plan.rows))
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_PLAN,
        'planner returned a non-serializable plan'
      );
    }

    const summaryCounts = [
      plan.summary.totalFiles,
      plan.summary.copyFiles,
      plan.summary.moveFiles,
      plan.summary.skippedFiles,
      plan.summary.renamedFiles,
      plan.summary.overwrittenFiles,
      plan.summary.unresolvedDates,
      plan.summary.totalBytes,
    ];
    if (summaryCounts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_PLAN,
        'planner returned an invalid summary'
      );
    }

    if (plan.rows?.some((row) => !this.isValidPreviewRow(row))) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_PLAN,
        'planner returned an invalid preview row'
      );
    }

    if (plan.decisionRecords !== undefined) {
      const rowIndexes = new Set<number>();
      for (const record of plan.decisionRecords) {
        if (
          !Number.isSafeInteger(record.rowIndex) ||
          record.rowIndex < 0 ||
          record.rowIndex >= (plan.rows?.length ?? 0) ||
          rowIndexes.has(record.rowIndex) ||
          typeof record.sourcePath !== 'string' ||
          record.sourcePath.length === 0 ||
          plan.rows?.[record.rowIndex]?.sourcePath !== record.sourcePath ||
          typeof record.resolution !== 'object' ||
          record.resolution === null
        ) {
          throw new ProcessingCoordinatorError(
            CoordinatorErrorCode.INVALID_PLAN,
            'planner returned invalid or mismatched date decision evidence'
          );
        }
        rowIndexes.add(record.rowIndex);
      }
    }

    const ids = new Set<string>();
    let totalOperationBytes = 0;
    for (const operation of plan.operations) {
      if (
        typeof operation.id !== 'string' ||
        operation.id.length === 0 ||
        ids.has(operation.id) ||
        typeof operation.sourcePath !== 'string' ||
        operation.sourcePath.length === 0 ||
        typeof operation.targetPath !== 'string' ||
        operation.targetPath.length === 0 ||
        !Number.isSafeInteger(operation.bytes) ||
        operation.bytes < 0
      ) {
        throw new ProcessingCoordinatorError(
          CoordinatorErrorCode.INVALID_PLAN,
          'planner returned an invalid operation'
        );
      }
      ids.add(operation.id);
      totalOperationBytes += operation.bytes;
      if (!Number.isSafeInteger(totalOperationBytes)) {
        throw new ProcessingCoordinatorError(
          CoordinatorErrorCode.INVALID_PLAN,
          'planner operation bytes exceed the safe aggregate range'
        );
      }
    }

    const canonical =
      plan.rows === undefined
        ? {
            totalFiles: plan.operations.length,
            copyFiles:
              effectiveOptions.operation === OperationMode.COPY ? plan.operations.length : 0,
            moveFiles:
              effectiveOptions.operation === OperationMode.MOVE ? plan.operations.length : 0,
            skippedFiles: 0,
            totalBytes: totalOperationBytes,
          }
        : {
            totalFiles: plan.rows.length,
            copyFiles: plan.rows.filter((row) => row.operation === OperationMode.COPY).length,
            moveFiles: plan.rows.filter((row) => row.operation === OperationMode.MOVE).length,
            skippedFiles: plan.rows.filter((row) => row.operation === 'skip').length,
            totalBytes: plan.rows.reduce((total, row) => total + row.fingerprint.size, 0),
          };
    const executableFiles = canonical.copyFiles + canonical.moveFiles;
    if (
      plan.operations.length !== executableFiles ||
      plan.summary.totalFiles !== canonical.totalFiles ||
      plan.summary.copyFiles !== canonical.copyFiles ||
      plan.summary.moveFiles !== canonical.moveFiles ||
      plan.summary.skippedFiles !== canonical.skippedFiles ||
      plan.summary.totalBytes !== canonical.totalBytes
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_PLAN,
        'planner summary does not match its canonical rows and operations'
      );
    }
  }

  private validatePreviewProgress(
    progress: PreviewProgressDTO,
    previous?: PreviewProgressDTO
  ): void {
    const allowedPhases = new Set<ProcessingPhase>([
      ProcessingPhase.METADATA,
      ProcessingPhase.ORGANIZATION,
    ]);
    const expectedPercentage =
      progress.totalFiles === 0 ? 100 : (progress.filesProcessed / progress.totalFiles) * 100;
    if (
      typeof progress !== 'object' ||
      progress === null ||
      !allowedPhases.has(progress.phase) ||
      !Number.isSafeInteger(progress.filesProcessed) ||
      progress.filesProcessed < 0 ||
      !Number.isSafeInteger(progress.totalFiles) ||
      progress.totalFiles < 0 ||
      progress.filesProcessed > progress.totalFiles ||
      !Number.isFinite(progress.percentage) ||
      Math.abs(progress.percentage - expectedPercentage) > Number.EPSILON ||
      (progress.currentFile !== undefined &&
        (typeof progress.currentFile !== 'string' || progress.currentFile.length === 0)) ||
      (progress.totalFiles > 0 &&
        progress.filesProcessed < progress.totalFiles &&
        progress.currentFile === undefined) ||
      (progress.filesProcessed === progress.totalFiles && progress.currentFile !== undefined) ||
      (previous === undefined &&
        !(
          (progress.totalFiles === 0 &&
            progress.phase === ProcessingPhase.ORGANIZATION &&
            progress.filesProcessed === 0) ||
          (progress.totalFiles > 0 &&
            progress.phase === ProcessingPhase.METADATA &&
            progress.filesProcessed === 0)
        )) ||
      (previous !== undefined &&
        (progress.totalFiles !== previous.totalFiles ||
          progress.filesProcessed !== previous.filesProcessed + 1 ||
          previous.phase === ProcessingPhase.ORGANIZATION)) ||
      (progress.phase === ProcessingPhase.METADATA &&
        progress.filesProcessed >= progress.totalFiles) ||
      (progress.phase === ProcessingPhase.ORGANIZATION &&
        progress.filesProcessed !== progress.totalFiles)
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_PLAN,
        'planner returned invalid or regressive preview progress'
      );
    }
  }

  private validateCompletedPreviewProgress(
    progress: PreviewProgressDTO | undefined,
    summaryTotalFiles: number
  ): void {
    if (progress === undefined) return;
    if (
      progress.phase !== ProcessingPhase.ORGANIZATION ||
      progress.filesProcessed !== progress.totalFiles ||
      progress.totalFiles !== summaryTotalFiles ||
      progress.percentage !== 100 ||
      progress.currentFile !== undefined
    ) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_PLAN,
        'planner progress did not complete or match the preview summary'
      );
    }
  }

  private previewCancelledError(reason: unknown): ProcessingCoordinatorError {
    const detail = typeof reason === 'string' && reason.trim() ? reason.trim() : undefined;
    return new ProcessingCoordinatorError(
      CoordinatorErrorCode.PREVIEW_CANCELLED,
      'Preview analysis stopped',
      detail === undefined ? [] : [detail]
    );
  }

  private isValidPreviewRow(row: PreviewRowDTO): boolean {
    if (typeof row !== 'object' || row === null) return false;
    if (typeof row.sourcePath !== 'string' || row.sourcePath.length === 0) return false;
    if (row.targetPath !== null && typeof row.targetPath !== 'string') return false;
    if (row.operation !== 'skip' && row.targetPath === null) return false;
    if (![OperationMode.COPY, OperationMode.MOVE, 'skip'].includes(row.operation)) return false;
    if (!Object.values(ConflictPolicy).includes(row.conflictPolicy)) return false;
    if (
      !Array.isArray(row.warnings) ||
      row.warnings.some((warning) => typeof warning !== 'string')
    ) {
      return false;
    }

    const evidence = row.dateEvidence;
    if (
      typeof evidence !== 'object' ||
      evidence === null ||
      (evidence.value !== null && typeof evidence.value !== 'string') ||
      typeof evidence.source !== 'string' ||
      !Number.isFinite(evidence.confidence) ||
      evidence.confidence < 0 ||
      evidence.confidence > 1 ||
      !Array.isArray(evidence.warnings) ||
      evidence.warnings.some((warning) => typeof warning !== 'string')
    ) {
      return false;
    }

    const fingerprint = row.fingerprint;
    return (
      typeof fingerprint === 'object' &&
      fingerprint !== null &&
      Number.isSafeInteger(fingerprint.size) &&
      fingerprint.size >= 0 &&
      typeof fingerprint.modifiedAt === 'string' &&
      (fingerprint.hash === undefined || typeof fingerprint.hash === 'string')
    );
  }

  private generateUniqueId(kind: 'job' | 'preview'): string {
    const id = this.idGenerator(kind);
    const collides =
      typeof id !== 'string' ||
      id.length === 0 ||
      this.reservedIds.has(id) ||
      this.previews.has(id) ||
      this.activeJobs.has(id) ||
      [...this.previews.values()].some((entry) => entry.jobId === id || entry.previewId === id);
    if (collides) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        `${kind} id generator returned an invalid or duplicate id`
      );
    }
    this.reservedIds.add(id);
    return id;
  }

  private now(): number {
    const value = this.clock.now();
    if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'clock returned a time outside the ECMAScript Date range'
      );
    }
    return value;
  }

  private toISOString(value: number): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.INVALID_CONFIGURATION,
        'timestamp is outside the ECMAScript Date range'
      );
    }
    return date.toISOString();
  }

  private async persistHistory(
    label: string,
    callback: () => Promise<void> | void | undefined
  ): Promise<void> {
    try {
      await callback();
    } catch (error) {
      throw new ProcessingCoordinatorError(
        CoordinatorErrorCode.HISTORY_PERSISTENCE_FAILED,
        `${label} persistence failed: ${errorMessage(error)}`
      );
    }
  }

  private invokeObserver(callback: () => unknown): void {
    try {
      const result = callback();
      if (result instanceof Promise) {
        void result.catch((error) => this.reportObserverError(error));
      }
    } catch (error) {
      this.reportObserverError(error);
    }
  }

  private reportObserverError(error: unknown): void {
    try {
      this.onHookError?.(error);
    } catch {
      // Observer failures cannot participate in processing state transitions.
    }
  }
}
