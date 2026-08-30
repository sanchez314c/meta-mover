/**
 * Canonical, transport-safe processing contract shared by Electron's main,
 * preload, and renderer processes.
 *
 * DTO fields deliberately use strings and finite numbers rather than Date,
 * Error, Map, Set, or class instances so Electron IPC and persisted history
 * share the same representation.
 */

export const OperationMode = {
  COPY: 'copy',
  MOVE: 'move',
} as const;

export type OperationMode = (typeof OperationMode)[keyof typeof OperationMode];

export const ConflictPolicy = {
  SKIP: 'skip',
  RENAME: 'rename',
} as const;

export type ConflictPolicy = (typeof ConflictPolicy)[keyof typeof ConflictPolicy];

export const FolderStructure = {
  YEAR_MONTH: 'year/month',
  YEAR_MONTH_FLAT: 'year-month',
  FLAT: 'flat',
} as const;

export type FolderStructure = (typeof FolderStructure)[keyof typeof FolderStructure];

export const ProcessingPhase = {
  DISCOVERY: 'discovery',
  METADATA: 'metadata',
  ORGANIZATION: 'organization',
  VERIFICATION: 'verification',
  CLEANUP: 'cleanup',
} as const;

export type ProcessingPhase = (typeof ProcessingPhase)[keyof typeof ProcessingPhase];

export interface ProcessingOptionsDTO {
  operation: OperationMode;
  conflictPolicy: ConflictPolicy;
  folderStructure: FolderStructure;
  workerCount: number;
  verifyIntegrity: boolean;
  writeMetadataDates: boolean;
}

export interface PreviewRequestDTO {
  sourcePaths: string[];
  destinationPath: string;
  options: ProcessingOptionsDTO;
}

export interface FileFingerprintDTO {
  size: number;
  modifiedAt: string;
  hash?: string;
}

export const DateEvidenceSource = {
  EMBEDDED: 'embedded',
  FILENAME: 'filename',
  FILESYSTEM_BIRTH: 'filesystem-birth',
  FILESYSTEM_MODIFIED: 'filesystem-modified',
  UNRESOLVED: 'unresolved',
} as const;

export type DateEvidenceSource = (typeof DateEvidenceSource)[keyof typeof DateEvidenceSource];

export interface DateEvidenceDTO {
  value: string | null;
  source: DateEvidenceSource;
  field?: string;
  confidence: number;
  warnings: string[];
}

const DATE_EVIDENCE_EXPLICIT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DATE_EVIDENCE_LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/;

function validDateEvidenceParts(parts: readonly string[]): boolean {
  const [yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = hourText === undefined ? 0 : Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

export function isValidDateEvidenceValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const explicit = DATE_EVIDENCE_EXPLICIT_PATTERN.exec(value);
  if (explicit) {
    const zone = explicit[7];
    return (
      (zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59)) &&
      validDateEvidenceParts(explicit.slice(1, 7)) &&
      Number.isFinite(Date.parse(value))
    );
  }
  const local = DATE_EVIDENCE_LOCAL_PATTERN.exec(value);
  return local !== null && validDateEvidenceParts(local.slice(1, 7));
}

export interface PreviewRowDTO {
  sourcePath: string;
  targetPath: string | null;
  operation: OperationMode | 'skip';
  conflictPolicy: ConflictPolicy;
  dateEvidence: DateEvidenceDTO;
  fingerprint: FileFingerprintDTO;
  warnings: string[];
}

export interface PreviewSummaryDTO {
  totalFiles: number;
  copyFiles: number;
  moveFiles: number;
  skippedFiles: number;
  renamedFiles: number;
  overwrittenFiles: number;
  unresolvedDates: number;
  totalBytes: number;
}

export interface PreviewResultDTO {
  jobId: string;
  previewId: string;
  createdAt: string;
  expiresAt?: string;
  request: PreviewRequestDTO;
  effectiveOptions: ProcessingOptionsDTO;
  summary: PreviewSummaryDTO;
  rows?: PreviewRowDTO[];
  nextPageToken?: string;
}

export interface StartProcessingRequestDTO {
  previewId: string;
  acknowledgeDestructiveOperation: boolean;
}

export interface StartProcessingResultDTO {
  jobId: string;
  previewId: string;
  acceptedAt: string;
  effectiveOptions: ProcessingOptionsDTO;
}

export interface CancelProcessingRequestDTO {
  jobId: string;
  reason?: string;
}

export type ProcessingCapabilityName = 'preview' | 'start' | 'metadataWriteback';

export interface CapabilityHealthDTO {
  available: boolean;
  blockers: string[];
}

export interface DependencyStatusDTO {
  name: 'exiftool' | 'fs-helper';
  available: boolean;
  source: 'bundled' | 'system';
  requiredFor: ProcessingCapabilityName[];
  version?: string;
  error?: string;
}

export interface DependencyHealthDTO {
  checkedAt: string;
  ready: boolean;
  capabilities: Record<ProcessingCapabilityName, CapabilityHealthDTO>;
  dependencies: DependencyStatusDTO[];
}

export interface ProcessingStatisticsDTO {
  totalFiles: number;
  processedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: number;
  processedBytes: number;
  durationMs: number;
}

export interface ProcessingErrorDTO {
  code: string;
  message: string;
  recoverable: boolean;
  details?: string;
}

export interface ProcessingFileFailureDTO {
  sourcePath: string;
  error: string;
}

export const CancellationFileState = {
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  CANCELLED_BEFORE_COMMIT: 'cancelled-before-commit',
  DESTINATION_COMMITTED_SOURCE_RETAINED: 'destination-committed-source-retained',
  NOT_ATTEMPTED: 'not-attempted',
} as const;

export type CancellationFileState =
  (typeof CancellationFileState)[keyof typeof CancellationFileState];

export interface ProcessingCancellationFileOutcomeDTO {
  sourcePath: string;
  destinationPath: string | null;
  state: CancellationFileState;
  plannedBytes: number;
  committedBytes: number;
  sourceRetained: boolean;
  error?: string;
}

export interface ProcessingCancellationStatisticsDTO extends ProcessingStatisticsDTO {
  cancelledFiles: number;
  unattemptedFiles: number;
  committedResidueBytes: number;
}

export const ProcessingEventKind = {
  PREVIEW_STARTED: 'preview-started',
  PREVIEW_READY: 'preview-ready',
  JOB_QUEUED: 'job-queued',
  JOB_STARTED: 'job-started',
  JOB_PROGRESS: 'job-progress',
  JOB_CANCELLING: 'job-cancelling',
  JOB_COMPLETED: 'job-completed',
  JOB_PARTIALLY_COMPLETED: 'job-partially-completed',
  JOB_FAILED: 'job-failed',
  JOB_CANCELLED: 'job-cancelled',
} as const;

export type ProcessingEventKind = (typeof ProcessingEventKind)[keyof typeof ProcessingEventKind];

interface ProcessingEventBase<K extends ProcessingEventKind, P> {
  kind: K;
  jobId: string;
  /** Strictly increasing per job. The first accepted event uses sequence 1. */
  sequence: number;
  emittedAt: string;
  payload: P;
}

export type PreviewStartedEvent = ProcessingEventBase<
  typeof ProcessingEventKind.PREVIEW_STARTED,
  { sourceCount: number; destinationPath: string }
>;

export type PreviewReadyEvent = ProcessingEventBase<
  typeof ProcessingEventKind.PREVIEW_READY,
  { previewId: string; summary: PreviewSummaryDTO }
>;

export type JobQueuedEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_QUEUED,
  { previewId: string; effectiveOptions: ProcessingOptionsDTO }
>;

export type JobStartedEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_STARTED,
  { phase: ProcessingPhase }
>;

export type JobProgressEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_PROGRESS,
  {
    phase: ProcessingPhase;
    filesProcessed: number;
    totalFiles: number;
    percentage: number;
    currentFile?: string;
  }
>;

export type JobCancellingEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_CANCELLING,
  { reason?: string }
>;

export type JobCompletedEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_COMPLETED,
  { statistics: ProcessingStatisticsDTO }
>;

export type JobPartiallyCompletedEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
  { statistics: ProcessingStatisticsDTO; fileFailures: ProcessingFileFailureDTO[] }
>;

export type JobFailedEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_FAILED,
  {
    error: ProcessingErrorDTO;
    statistics?: ProcessingStatisticsDTO;
    fileFailures?: ProcessingFileFailureDTO[];
  }
>;

export type JobCancelledEvent = ProcessingEventBase<
  typeof ProcessingEventKind.JOB_CANCELLED,
  {
    reason?: string;
    filesProcessed: number;
    statistics: ProcessingCancellationStatisticsDTO;
    fileFailures: ProcessingFileFailureDTO[];
    fileOutcomes: ProcessingCancellationFileOutcomeDTO[];
  }
>;

export type ProcessingEvent =
  | PreviewStartedEvent
  | PreviewReadyEvent
  | JobQueuedEvent
  | JobStartedEvent
  | JobProgressEvent
  | JobCancellingEvent
  | JobCompletedEvent
  | JobPartiallyCompletedEvent
  | JobFailedEvent
  | JobCancelledEvent;

export type TerminalProcessingEvent =
  | JobCompletedEvent
  | JobPartiallyCompletedEvent
  | JobFailedEvent
  | JobCancelledEvent;

export type TerminalProcessingEventKind = TerminalProcessingEvent['kind'];

export interface JobHistoryDTO {
  jobId: string;
  previewId: string;
  status:
    | 'preview-ready'
    | 'queued'
    | 'processing'
    | 'cancelling'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled';
  sourcePaths: string[];
  destinationPath: string;
  effectiveOptions: ProcessingOptionsDTO;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress: {
    filesProcessed: number;
    totalFiles: number;
    percentage: number;
  };
  statistics?: ProcessingStatisticsDTO | ProcessingCancellationStatisticsDTO;
  fileFailures?: ProcessingFileFailureDTO[];
  cancellationOutcomes?: ProcessingCancellationFileOutcomeDTO[];
  error?: ProcessingErrorDTO;
}

export interface ProcessingResponseDTO<T> {
  success: boolean;
  data?: T;
  error?: ProcessingErrorDTO;
}

/**
 * Runtime guard for the transport rule shared by IPC and persistence. It is
 * intentionally stricter than JSON.stringify, which silently drops undefined
 * values and object functions.
 */
export function isSerializableProcessingValue(value: unknown): boolean {
  const ancestors = new WeakSet<object>();

  const visit = (candidate: unknown): boolean => {
    if (candidate === null) return true;

    switch (typeof candidate) {
      case 'string':
      case 'boolean':
        return true;
      case 'number':
        return Number.isFinite(candidate);
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        return false;
      case 'object': {
        const objectValue = candidate as object;
        if (ancestors.has(objectValue)) return false;
        ancestors.add(objectValue);

        if (Array.isArray(candidate)) {
          const serializable = candidate.every(visit);
          ancestors.delete(objectValue);
          return serializable;
        }

        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null) {
          ancestors.delete(objectValue);
          return false;
        }

        const serializable = Object.values(candidate as Record<string, unknown>).every(visit);
        ancestors.delete(objectValue);
        return serializable;
      }
      default:
        return false;
    }
  };

  return visit(value);
}
