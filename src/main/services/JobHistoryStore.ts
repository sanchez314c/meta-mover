import { randomUUID } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';
import { FileHandle } from 'fs/promises';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import { JobStateMachine, JobStatus } from '../core/JobStateMachine';
import {
  ConflictPolicy,
  CancellationFileState,
  DateEvidenceSource,
  FolderStructure,
  OperationMode,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingOptionsDTO,
  ProcessingPhase,
  PreviewRowDTO,
  PreviewSummaryDTO,
  isSerializableProcessingValue,
} from '../../shared/types/processing';

const SCHEMA_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

const ACTIVE_STATUSES = new Set<JobStatus>([
  JobStatus.PREVIEWING,
  JobStatus.QUEUED,
  JobStatus.PROCESSING,
  JobStatus.CANCELLING,
]);

const PROCESSING_OPTION_KEYS = [
  'operation',
  'conflictPolicy',
  'folderStructure',
  'workerCount',
  'verifyIntegrity',
  'writeMetadataDates',
] as const;

const LEGACY_PROCESSING_OPTION_KEYS = [...PROCESSING_OPTION_KEYS, 'corruptionDetection'] as const;

const PREVIEW_SUMMARY_KEYS = [
  'totalFiles',
  'copyFiles',
  'moveFiles',
  'skippedFiles',
  'renamedFiles',
  'overwrittenFiles',
  'unresolvedDates',
  'totalBytes',
] as const;

export interface CreateHistoryJobInput {
  jobId: string;
  createdAt: string;
  previewId: string;
  sourcePaths: string[];
  destinationPath: string;
  effectiveOptions: ProcessingOptionsDTO;
  previewSummary: PreviewSummaryDTO;
  previewRows: PreviewRowDTO[];
}

export interface HistoryJobSnapshot {
  readonly jobId: string;
  readonly previewId: string;
  readonly createdAt: string;
  readonly sourcePaths: readonly string[];
  readonly destinationPath: string;
  readonly effectiveOptions: Readonly<ProcessingOptionsDTO>;
  readonly previewSummary: Readonly<PreviewSummaryDTO>;
  readonly previewRows?: readonly Readonly<PreviewRowDTO>[];
  readonly status: JobStatus;
  readonly lastSequence: number;
  readonly terminalEventKind: ProcessingEvent['kind'] | null;
  readonly events: readonly Readonly<ProcessingEvent>[];
}

export type JobHistoryStoreErrorCode =
  | 'NOT_INITIALIZED'
  | 'INVALID_INPUT'
  | 'INVALID_JOB_ID'
  | 'JOB_NOT_FOUND'
  | 'EVENT_REJECTED'
  | 'IMMUTABLE_FIELD_MISMATCH'
  | 'CORRUPT_HISTORY'
  | 'UNSAFE_HISTORY_PATH'
  | 'STORE_LOCKED'
  | 'STORE_CLOSED'
  | 'STORE_POISONED';

export class JobHistoryStoreError extends Error {
  public readonly code: JobHistoryStoreErrorCode;
  public readonly reason?: string;
  public readonly line?: number;

  public constructor(
    code: JobHistoryStoreErrorCode,
    message: string,
    details: { reason?: string; line?: number } = {}
  ) {
    super(message);
    this.name = 'JobHistoryStoreError';
    this.code = code;
    this.reason = details.reason;
    this.line = details.line;
  }
}

type JobCreationRecord = Omit<CreateHistoryJobInput, 'previewRows'> & {
  previewRows?: PreviewRowDTO[];
};

interface PersistedCreationRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  recordType: 'job-created';
  creation: JobCreationRecord;
}

interface PersistedEventRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  recordType: 'event-appended';
  event: ProcessingEvent;
}

type PersistedRecord = PersistedCreationRecord | PersistedEventRecord;

interface JobEntry {
  creation: JobCreationRecord;
  events: ProcessingEvent[];
  machine: JobStateMachine;
}

interface FileIdentity {
  device: number;
  inode: number;
}

interface LockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockObservation {
  disposition: 'live' | 'stale' | 'invalid';
  identity: FileIdentity;
  token?: string;
}

export interface JobHistoryStoreTestHooks {
  beforeStaleLockRemoval?: () => Promise<void>;
  onReclaimerContended?: () => void;
  beforeHistorySync?: () => Promise<void>;
  afterLockLinked?: (targetPath: string) => Promise<void>;
  onDirectorySynced?: (directoryPath: string) => void;
  onHistoryPermissionSynced?: () => void;
  beforeReadOwnershipCheck?: (operation: 'get' | 'list') => Promise<void>;
  beforeOwnedLockQuarantine?: (targetPath: string) => Promise<void>;
  afterLockPathObserved?: (targetPath: string) => Promise<void>;
}

export interface JobHistoryStoreOptions {
  now?: () => Date;
  warning?: (message: string) => void;
  /** Deterministic fault barriers for storage validation tests. */
  testHooks?: JobHistoryStoreTestHooks;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => typeof key === 'string' && allowed.has(key))
  );
}

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

const EXPLICIT_DATE_EVIDENCE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE_EVIDENCE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/;

function hasValidCalendarParts(
  yearText: string,
  monthText: string,
  dayText: string,
  hourText?: string,
  minuteText?: string,
  secondText?: string
): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = hourText === undefined ? 0 : Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function isDateEvidenceValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const explicit = EXPLICIT_DATE_EVIDENCE_PATTERN.exec(value);
  if (explicit) {
    const [, year, month, day, hour, minute, second, zone] = explicit;
    const offsetValid =
      zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59);
    return (
      offsetValid &&
      hasValidCalendarParts(year, month, day, hour, minute, second) &&
      Number.isFinite(Date.parse(value))
    );
  }
  const local = LOCAL_DATE_EVIDENCE_PATTERN.exec(value);
  return (
    local !== null && hasValidCalendarParts(...(local.slice(1, 7) as [string, string, string]))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFiniteRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function isProcessingOptions(value: unknown): value is ProcessingOptionsDTO {
  if (!isPlainObject(value) || !hasExactKeys(value, PROCESSING_OPTION_KEYS)) return false;
  return (
    Object.values(OperationMode).includes(value.operation as OperationMode) &&
    Object.values(ConflictPolicy).includes(value.conflictPolicy as ConflictPolicy) &&
    Object.values(FolderStructure).includes(value.folderStructure as FolderStructure) &&
    Number.isSafeInteger(value.workerCount) &&
    (value.workerCount as number) >= 1 &&
    (value.workerCount as number) <= 10 &&
    typeof value.verifyIntegrity === 'boolean' &&
    typeof value.writeMetadataDates === 'boolean'
  );
}

function isPreviewSummary(value: unknown): value is PreviewSummaryDTO {
  if (!isPlainObject(value) || !hasExactKeys(value, PREVIEW_SUMMARY_KEYS)) return false;
  return PREVIEW_SUMMARY_KEYS.every((key) => isNonNegativeInteger(value[key]));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPreviewRow(value: unknown): value is PreviewRowDTO {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      'sourcePath',
      'targetPath',
      'operation',
      'conflictPolicy',
      'dateEvidence',
      'fingerprint',
      'warnings',
    ]) ||
    !isNonEmptyString(value.sourcePath) ||
    (value.targetPath !== null && !isNonEmptyString(value.targetPath)) ||
    (value.operation !== 'skip' && value.targetPath === null) ||
    ![...Object.values(OperationMode), 'skip'].includes(
      value.operation as OperationMode | 'skip'
    ) ||
    !Object.values(ConflictPolicy).includes(value.conflictPolicy as ConflictPolicy) ||
    !isStringArray(value.warnings)
  ) {
    return false;
  }
  const dateEvidence = value.dateEvidence;
  const fingerprint = value.fingerprint;
  return (
    isPlainObject(dateEvidence) &&
    hasExactKeys(dateEvidence, ['value', 'source', 'confidence', 'warnings'], ['field']) &&
    (dateEvidence.value === null || isDateEvidenceValue(dateEvidence.value)) &&
    Object.values(DateEvidenceSource).includes(dateEvidence.source as DateEvidenceSource) &&
    (dateEvidence.field === undefined || isNonEmptyString(dateEvidence.field)) &&
    isFiniteRange(dateEvidence.confidence, 0, 1) &&
    isStringArray(dateEvidence.warnings) &&
    isPlainObject(fingerprint) &&
    hasExactKeys(fingerprint, ['size', 'modifiedAt'], ['hash']) &&
    isNonNegativeInteger(fingerprint.size) &&
    isIsoTimestamp(fingerprint.modifiedAt) &&
    (fingerprint.hash === undefined || isNonEmptyString(fingerprint.hash))
  );
}

function previewRowsConserveSummary(rows: PreviewRowDTO[], summary: PreviewSummaryDTO): boolean {
  return (
    rows.length === summary.totalFiles &&
    rows.filter((row) => row.operation === OperationMode.COPY).length === summary.copyFiles &&
    rows.filter((row) => row.operation === OperationMode.MOVE).length === summary.moveFiles &&
    rows.filter((row) => row.operation === 'skip').length === summary.skippedFiles &&
    rows.reduce((total, row) => total + row.fingerprint.size, 0) === summary.totalBytes
  );
}

function isStatistics(value: unknown): boolean {
  const keys = [
    'totalFiles',
    'processedFiles',
    'skippedFiles',
    'failedFiles',
    'totalBytes',
    'processedBytes',
    'durationMs',
  ];
  if (
    !(
      isPlainObject(value) &&
      hasExactKeys(value, keys) &&
      keys.every((key) => isNonNegativeInteger(value[key]))
    )
  )
    return false;
  const statistics = value as Record<string, number>;
  return (
    statistics.processedFiles + statistics.skippedFiles + statistics.failedFiles ===
      statistics.totalFiles && statistics.processedBytes <= statistics.totalBytes
  );
}

function isFileFailures(value: unknown, allowEmpty = false): boolean {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(
      (failure) =>
        isPlainObject(failure) &&
        hasExactKeys(failure, ['sourcePath', 'error']) &&
        isNonEmptyString(failure.sourcePath) &&
        isNonEmptyString(failure.error)
    )
  );
}

function isCancellationStatistics(value: unknown): boolean {
  const keys = [
    'totalFiles',
    'processedFiles',
    'skippedFiles',
    'failedFiles',
    'cancelledFiles',
    'unattemptedFiles',
    'totalBytes',
    'processedBytes',
    'committedResidueBytes',
    'durationMs',
  ];
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, keys) ||
    !keys.every((key) => isNonNegativeInteger(value[key]))
  ) {
    return false;
  }
  const statistics = value as Record<string, number>;
  return (
    statistics.processedFiles +
      statistics.skippedFiles +
      statistics.failedFiles +
      statistics.cancelledFiles +
      statistics.unattemptedFiles ===
      statistics.totalFiles &&
    statistics.processedBytes + statistics.committedResidueBytes <= statistics.totalBytes
  );
}

function isCancellationOutcomes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((outcome) => {
      if (
        !isPlainObject(outcome) ||
        !hasExactKeys(
          outcome,
          [
            'sourcePath',
            'destinationPath',
            'state',
            'plannedBytes',
            'committedBytes',
            'sourceRetained',
          ],
          ['error']
        ) ||
        !isNonEmptyString(outcome.sourcePath) ||
        (outcome.destinationPath !== null && !isNonEmptyString(outcome.destinationPath)) ||
        !Object.values(CancellationFileState).includes(outcome.state as CancellationFileState) ||
        !isNonNegativeInteger(outcome.plannedBytes) ||
        !isNonNegativeInteger(outcome.committedBytes) ||
        (outcome.committedBytes as number) > (outcome.plannedBytes as number) ||
        typeof outcome.sourceRetained !== 'boolean' ||
        (outcome.error !== undefined && !isNonEmptyString(outcome.error))
      ) {
        return false;
      }
      if (
        [
          CancellationFileState.SKIPPED,
          CancellationFileState.CANCELLED_BEFORE_COMMIT,
          CancellationFileState.NOT_ATTEMPTED,
        ].includes(outcome.state as never) &&
        outcome.committedBytes !== 0
      ) {
        return false;
      }
      return (
        ![
          CancellationFileState.SKIPPED,
          CancellationFileState.CANCELLED_BEFORE_COMMIT,
          CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED,
          CancellationFileState.NOT_ATTEMPTED,
        ].includes(outcome.state as never) || outcome.sourceRetained === true
      );
    })
  );
}

function isProcessingError(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasExactKeys(value, ['code', 'message', 'recoverable'], ['details']) &&
    isNonEmptyString(value.code) &&
    isNonEmptyString(value.message) &&
    typeof value.recoverable === 'boolean' &&
    (value.details === undefined || typeof value.details === 'string')
  );
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function isValidEventPayload(kind: ProcessingEvent['kind'], payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  switch (kind) {
    case ProcessingEventKind.PREVIEW_STARTED:
      return (
        hasExactKeys(payload, ['sourceCount', 'destinationPath']) &&
        isNonNegativeInteger(payload.sourceCount) &&
        isNonEmptyString(payload.destinationPath)
      );
    case ProcessingEventKind.PREVIEW_READY:
      return (
        hasExactKeys(payload, ['previewId', 'summary']) &&
        isNonEmptyString(payload.previewId) &&
        isPreviewSummary(payload.summary)
      );
    case ProcessingEventKind.JOB_QUEUED:
      return (
        hasExactKeys(payload, ['previewId', 'effectiveOptions']) &&
        isNonEmptyString(payload.previewId) &&
        isProcessingOptions(payload.effectiveOptions)
      );
    case ProcessingEventKind.JOB_STARTED:
      return (
        hasExactKeys(payload, ['phase']) &&
        Object.values(ProcessingPhase).includes(payload.phase as ProcessingPhase)
      );
    case ProcessingEventKind.JOB_PROGRESS:
      return (
        hasExactKeys(
          payload,
          ['phase', 'filesProcessed', 'totalFiles', 'percentage'],
          ['currentFile']
        ) &&
        Object.values(ProcessingPhase).includes(payload.phase as ProcessingPhase) &&
        isNonNegativeInteger(payload.filesProcessed) &&
        isNonNegativeInteger(payload.totalFiles) &&
        isFiniteRange(payload.percentage, 0, 100) &&
        hasOptionalString(payload, 'currentFile')
      );
    case ProcessingEventKind.JOB_CANCELLING:
      return hasExactKeys(payload, [], ['reason']) && hasOptionalString(payload, 'reason');
    case ProcessingEventKind.JOB_COMPLETED:
      return (
        hasExactKeys(payload, ['statistics']) &&
        isStatistics(payload.statistics) &&
        (payload.statistics as Record<string, unknown>).failedFiles === 0
      );
    case ProcessingEventKind.JOB_PARTIALLY_COMPLETED:
      return (
        hasExactKeys(payload, ['statistics', 'fileFailures']) &&
        isStatistics(payload.statistics) &&
        isFileFailures(payload.fileFailures) &&
        (payload.statistics as Record<string, number>).failedFiles ===
          (payload.fileFailures as unknown[]).length &&
        (payload.statistics as Record<string, number>).failedFiles <
          (payload.statistics as Record<string, number>).totalFiles
      );
    case ProcessingEventKind.JOB_FAILED:
      if (
        !hasExactKeys(payload, ['error'], ['statistics', 'fileFailures']) ||
        !isProcessingError(payload.error)
      )
        return false;
      if (payload.statistics === undefined && payload.fileFailures === undefined) return true;
      return (
        isStatistics(payload.statistics) &&
        isFileFailures(payload.fileFailures) &&
        (payload.statistics as Record<string, number>).failedFiles ===
          (payload.fileFailures as unknown[]).length &&
        (payload.statistics as Record<string, number>).failedFiles ===
          (payload.statistics as Record<string, number>).totalFiles
      );
    case ProcessingEventKind.JOB_CANCELLED:
      if (
        !hasExactKeys(
          payload,
          ['filesProcessed', 'statistics', 'fileFailures', 'fileOutcomes'],
          ['reason']
        ) ||
        !isNonNegativeInteger(payload.filesProcessed) ||
        !hasOptionalString(payload, 'reason') ||
        !isCancellationStatistics(payload.statistics) ||
        !isFileFailures(payload.fileFailures, true) ||
        !isCancellationOutcomes(payload.fileOutcomes)
      ) {
        return false;
      }
      {
        const statistics = payload.statistics as Record<string, number>;
        const outcomes = payload.fileOutcomes as Array<Record<string, unknown>>;
        const count = (state: string): number =>
          outcomes.filter((outcome) => outcome.state === state).length;
        const committedResidueBytes = outcomes
          .filter((outcome) => outcome.state !== CancellationFileState.COMPLETED)
          .reduce((total, outcome) => total + (outcome.committedBytes as number), 0);
        const totalBytes = outcomes.reduce(
          (total, outcome) => total + (outcome.plannedBytes as number),
          0
        );
        const processedBytes = outcomes
          .filter((outcome) => outcome.state === CancellationFileState.COMPLETED)
          .reduce((total, outcome) => total + (outcome.committedBytes as number), 0);
        const failedOutcomes = outcomes.filter(
          (outcome) => outcome.state === CancellationFileState.FAILED
        );
        const failures = payload.fileFailures as Array<Record<string, unknown>>;
        return (
          payload.filesProcessed === statistics.processedFiles &&
          outcomes.length === statistics.totalFiles &&
          count(CancellationFileState.COMPLETED) === statistics.processedFiles &&
          count(CancellationFileState.SKIPPED) === statistics.skippedFiles &&
          count(CancellationFileState.FAILED) === statistics.failedFiles &&
          count(CancellationFileState.CANCELLED_BEFORE_COMMIT) +
            count(CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED) ===
            statistics.cancelledFiles &&
          count(CancellationFileState.NOT_ATTEMPTED) === statistics.unattemptedFiles &&
          failures.length === statistics.failedFiles &&
          failures.every(
            (failure, index) =>
              failure.sourcePath === failedOutcomes[index]?.sourcePath &&
              failure.error === failedOutcomes[index]?.error
          ) &&
          totalBytes === statistics.totalBytes &&
          processedBytes === statistics.processedBytes &&
          committedResidueBytes === statistics.committedResidueBytes
        );
      }
  }
}

function isProcessingEvent(value: unknown): value is ProcessingEvent {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ['kind', 'jobId', 'sequence', 'emittedAt', 'payload']) ||
    !Object.values(ProcessingEventKind).includes(value.kind as ProcessingEvent['kind'])
  ) {
    return false;
  }
  return (
    isUuid(value.jobId) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    isIsoTimestamp(value.emittedAt) &&
    isValidEventPayload(value.kind as ProcessingEvent['kind'], value.payload) &&
    isSerializableProcessingValue(value)
  );
}

function validateCreationShape(
  value: unknown,
  persisted: boolean
): JobCreationRecord | CreateHistoryJobInput {
  const required = [
    'jobId',
    'createdAt',
    'previewId',
    'sourcePaths',
    'destinationPath',
    'effectiveOptions',
    'previewSummary',
  ];
  const code: JobHistoryStoreErrorCode = persisted ? 'CORRUPT_HISTORY' : 'INVALID_INPUT';
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, required, ['previewRows']) ||
    !isSerializableProcessingValue(value)
  ) {
    throw new JobHistoryStoreError(code, 'Invalid job creation record');
  }
  if (
    !isUuid(value.jobId) ||
    !isIsoTimestamp(value.createdAt) ||
    !isNonEmptyString(value.previewId) ||
    !isNonEmptyString(value.destinationPath) ||
    !Array.isArray(value.sourcePaths) ||
    value.sourcePaths.length === 0 ||
    value.sourcePaths.some((item) => !isNonEmptyString(item)) ||
    !isProcessingOptions(value.effectiveOptions) ||
    !isPreviewSummary(value.previewSummary) ||
    (!persisted && !Array.isArray(value.previewRows)) ||
    (value.previewRows !== undefined &&
      (!Array.isArray(value.previewRows) ||
        !value.previewRows.every(isPreviewRow) ||
        !previewRowsConserveSummary(
          value.previewRows as PreviewRowDTO[],
          value.previewSummary as PreviewSummaryDTO
        )))
  ) {
    throw new JobHistoryStoreError(code, 'Malformed job creation record');
  }
  return cloneSerializable(value as unknown as JobCreationRecord | CreateHistoryJobInput);
}

function migrateLegacyOptions(value: unknown): { value: unknown; migrated: boolean } {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, LEGACY_PROCESSING_OPTION_KEYS) ||
    typeof value.corruptionDetection !== 'boolean'
  ) {
    return { value, migrated: false };
  }
  const { corruptionDetection: _retired, ...current } = value;
  return { value: current, migrated: true };
}

function migrateLegacyCreation(value: unknown): { value: unknown; migrated: boolean } {
  if (!isPlainObject(value)) return { value, migrated: false };
  const options = migrateLegacyOptions(value.effectiveOptions);
  if (!options.migrated) return { value, migrated: false };
  return { value: { ...value, effectiveOptions: options.value }, migrated: true };
}

function migrateLegacyEvent(value: unknown): { value: unknown; migrated: boolean } {
  if (
    !isPlainObject(value) ||
    value.kind !== ProcessingEventKind.JOB_QUEUED ||
    !isPlainObject(value.payload)
  ) {
    return { value, migrated: false };
  }
  const options = migrateLegacyOptions(value.payload.effectiveOptions);
  if (!options.migrated) return { value, migrated: false };
  return {
    value: {
      ...value,
      payload: { ...value.payload, effectiveOptions: options.value },
    },
    migrated: true,
  };
}

interface ParsedPersistedRecord {
  record: PersistedRecord;
  migrationWarning?: string;
}

function parsePersistedRecord(value: unknown): ParsedPersistedRecord {
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.recordType !== 'string'
  ) {
    throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Unsupported history record');
  }
  if (value.recordType === 'job-created') {
    if (!hasExactKeys(value, ['schemaVersion', 'recordType', 'creation'])) {
      throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Unknown creation envelope field');
    }
    const creation = migrateLegacyCreation(value.creation);
    return {
      record: {
        schemaVersion: SCHEMA_VERSION,
        recordType: 'job-created',
        creation: validateCreationShape(creation.value, true) as JobCreationRecord,
      },
      ...(creation.migrated
        ? {
            migrationWarning:
              'Migrated legacy history processing options by dropping corruptionDetection',
          }
        : {}),
    };
  }
  if (value.recordType === 'event-appended') {
    const event = migrateLegacyEvent(value.event);
    if (
      !hasExactKeys(value, ['schemaVersion', 'recordType', 'event']) ||
      !isProcessingEvent(event.value)
    ) {
      throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Malformed persisted event');
    }
    return {
      record: {
        schemaVersion: SCHEMA_VERSION,
        recordType: 'event-appended',
        event: cloneSerializable(event.value as ProcessingEvent),
      },
      ...(event.migrated
        ? {
            migrationWarning:
              'Migrated legacy history event options by dropping corruptionDetection',
          }
        : {}),
    };
  }
  throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Unknown history record type');
}

function seedMachine(creation: JobCreationRecord): JobStateMachine {
  const machine = new JobStateMachine(creation.jobId);
  const previewStarted: ProcessingEvent = {
    kind: ProcessingEventKind.PREVIEW_STARTED,
    jobId: creation.jobId,
    sequence: 1,
    emittedAt: creation.createdAt,
    payload: {
      sourceCount: creation.sourcePaths.length,
      destinationPath: creation.destinationPath,
    },
  };
  const previewReady: ProcessingEvent = {
    kind: ProcessingEventKind.PREVIEW_READY,
    jobId: creation.jobId,
    sequence: 2,
    emittedAt: creation.createdAt,
    payload: { previewId: creation.previewId, summary: cloneSerializable(creation.previewSummary) },
  };
  if (!machine.accept(previewStarted).accepted || !machine.accept(previewReady).accepted) {
    throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Unable to seed persisted job state');
  }
  return machine;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

export class JobHistoryStore {
  private readonly historyPath: string;
  private readonly lockPath: string;
  private readonly reclaimerPath: string;
  private readonly now: () => Date;
  private readonly warning: (message: string) => void;
  private readonly testHooks: JobHistoryStoreTestHooks;
  private readonly jobs = new Map<string, JobEntry>();
  private initialized = false;
  private closing = false;
  private closed = false;
  private poisoned = false;
  private initializationPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private historyHandle: FileHandle | null = null;
  private historyIdentity: FileIdentity | null = null;
  private lockHandle: FileHandle | null = null;
  private lockIdentity: FileIdentity | null = null;
  private lockToken: string | null = null;

  public constructor(historyPath: string, options: JobHistoryStoreOptions = {}) {
    if (!path.isAbsolute(historyPath)) {
      throw new JobHistoryStoreError('INVALID_INPUT', 'History path must be absolute');
    }
    this.historyPath = path.normalize(historyPath);
    this.lockPath = `${this.historyPath}.lock`;
    this.reclaimerPath = `${this.lockPath}.reclaim`;
    this.now = options.now ?? (() => new Date());
    this.warning = options.warning ?? (() => undefined);
    this.testHooks = options.testHooks ?? {};
  }

  public async initialize(): Promise<void> {
    if (this.closing || this.closed) {
      throw new JobHistoryStoreError('STORE_CLOSED', 'Job history store is closed');
    }
    if (this.initialized) return;
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = this.initializeOnce();
    try {
      await this.initializationPromise;
    } finally {
      if (!this.initialized) this.initializationPromise = null;
    }
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.closePromise = this.closeOnce();
    return this.closePromise;
  }

  public async createJob(input: CreateHistoryJobInput): Promise<HistoryJobSnapshot> {
    return this.enqueueWrite(async () => {
      this.requireWritable();
      const validated = validateCreationShape(input, false) as CreateHistoryJobInput;
      if (this.jobs.has(validated.jobId)) {
        throw new JobHistoryStoreError('INVALID_INPUT', 'jobId already exists');
      }
      const creation: JobCreationRecord = {
        jobId: validated.jobId,
        createdAt: validated.createdAt,
        previewId: validated.previewId,
        sourcePaths: cloneSerializable(validated.sourcePaths),
        destinationPath: validated.destinationPath,
        effectiveOptions: cloneSerializable(validated.effectiveOptions),
        previewSummary: cloneSerializable(validated.previewSummary),
        previewRows: cloneSerializable(validated.previewRows),
      };
      const entry: JobEntry = { creation, events: [], machine: seedMachine(creation) };
      await this.appendRecord({
        schemaVersion: SCHEMA_VERSION,
        recordType: 'job-created',
        creation,
      });
      this.jobs.set(creation.jobId, entry);
      return this.snapshot(entry);
    });
  }

  public async appendEvent(jobId: string, event: ProcessingEvent): Promise<HistoryJobSnapshot> {
    return this.enqueueWrite(async () => {
      this.requireWritable();
      this.requireUuid(jobId);
      const entry = this.jobs.get(jobId);
      if (!entry) throw new JobHistoryStoreError('JOB_NOT_FOUND', `Unknown job: ${jobId}`);
      if (!isProcessingEvent(event)) {
        throw new JobHistoryStoreError('INVALID_INPUT', 'Event does not match its runtime schema');
      }
      const clonedEvent = cloneSerializable(event);
      await this.assertOwnershipIdentity();
      const lastEvent = entry.events[entry.events.length - 1];
      if (
        lastEvent &&
        lastEvent.sequence === clonedEvent.sequence &&
        isDeepStrictEqual(lastEvent, clonedEvent)
      ) {
        return this.snapshot(entry);
      }
      this.enforceImmutableEventFields(entry, clonedEvent);
      const candidateMachine = this.replay(entry);
      const acceptance = candidateMachine.accept(clonedEvent);
      if (!acceptance.accepted) {
        throw new JobHistoryStoreError('EVENT_REJECTED', 'Event rejected by job state machine', {
          reason: acceptance.reason,
        });
      }
      await this.appendRecord({
        schemaVersion: SCHEMA_VERSION,
        recordType: 'event-appended',
        event: clonedEvent,
      });
      entry.events.push(clonedEvent);
      entry.machine = candidateMachine;
      return this.snapshot(entry);
    });
  }

  public getJob(jobId: string): Promise<HistoryJobSnapshot | null> {
    return this.admitOperation(async () => {
      this.requireReadable();
      await this.testHooks.beforeReadOwnershipCheck?.('get');
      await this.assertOwnershipIdentity();
      this.requireUuid(jobId);
      const entry = this.jobs.get(jobId);
      return entry ? this.snapshot(entry) : null;
    });
  }

  public listJobs(): Promise<readonly HistoryJobSnapshot[]> {
    return this.admitOperation(async () => {
      this.requireReadable();
      await this.testHooks.beforeReadOwnershipCheck?.('list');
      await this.assertOwnershipIdentity();
      return deepFreeze(Array.from(this.jobs.values(), (entry) => this.snapshot(entry)));
    });
  }

  private async initializeOnce(): Promise<void> {
    await this.prepareSafeParent();
    try {
      await this.acquireLock();
      await this.openHistoryFile();
      this.jobs.clear();
      await this.loadHistory();
      await this.recoverInterruptedJobs();
      this.initialized = true;
    } catch (error) {
      this.jobs.clear();
      if (this.historyHandle) await this.historyHandle.close().catch(() => undefined);
      this.historyHandle = null;
      this.historyIdentity = null;
      await this.releaseLock().catch(() => undefined);
      throw error;
    }
  }

  private async closeOnce(): Promise<void> {
    await this.initializationPromise?.catch(() => undefined);
    await Promise.allSettled(Array.from(this.inFlightOperations));
    await this.writeQueue;
    let closeError: unknown;
    if (this.historyHandle) {
      try {
        await this.historyHandle.close();
      } catch (error) {
        closeError = error;
      }
      this.historyHandle = null;
      this.historyIdentity = null;
    }
    try {
      await this.releaseLock();
    } catch (error) {
      closeError ??= error;
    }
    this.initialized = false;
    this.closed = true;
    if (closeError) throw closeError;
  }

  private async prepareSafeParent(): Promise<void> {
    const parent = path.dirname(this.historyPath);
    const filesystemRoot = path.parse(parent).root;
    const components = parent.slice(filesystemRoot.length).split(path.sep).filter(Boolean);
    let current = filesystemRoot;
    let parentWasCreated = false;

    for (const component of components) {
      current = path.join(current, component);
      let stats;
      try {
        stats = await fs.lstat(current);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        try {
          await fs.mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
          parentWasCreated = current === parent;
          await this.syncDirectory(path.dirname(current));
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
        stats = await fs.lstat(current);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new JobHistoryStoreError(
          'UNSAFE_HISTORY_PATH',
          'History ancestors must be real directories'
        );
      }
    }

    const [realParent, parentStats] = await Promise.all([fs.realpath(parent), fs.lstat(parent)]);
    const currentUser = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      realParent !== parent ||
      parentStats.isSymbolicLink() ||
      !parentStats.isDirectory() ||
      (parentStats.mode & 0o022) !== 0 ||
      (currentUser !== null && parentStats.uid !== currentUser)
    ) {
      throw new JobHistoryStoreError(
        'UNSAFE_HISTORY_PATH',
        'History parent must be a private real directory'
      );
    }
    if (parentWasCreated && (parentStats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new JobHistoryStoreError(
        'UNSAFE_HISTORY_PATH',
        'New history parent does not have private permissions'
      );
    }
  }

  private async acquireLock(): Promise<void> {
    const reclaimer = await this.acquireReclaimer();
    try {
      const observation = await this.inspectLock(this.lockPath);
      if (observation?.disposition === 'live') {
        throw new JobHistoryStoreError('STORE_LOCKED', 'Another JobHistoryStore owns this history');
      }
      if (observation) {
        await this.testHooks.beforeStaleLockRemoval?.();
        const confirmed = await this.inspectLock(this.lockPath);
        if (!confirmed || !this.sameObservation(observation, confirmed)) {
          throw new JobHistoryStoreError('STORE_LOCKED', 'History lock changed during reclamation');
        }
        if (confirmed.disposition === 'live') {
          throw new JobHistoryStoreError(
            'STORE_LOCKED',
            'Another JobHistoryStore owns this history'
          );
        }
        await this.removeObservedLock(this.lockPath, confirmed);
      }

      const published = await this.publishLock(this.lockPath);
      if (!published) {
        throw new JobHistoryStoreError('STORE_LOCKED', 'History lock publication lost');
      }
      this.lockHandle = published.handle;
      this.lockIdentity = published.identity;
      this.lockToken = published.token;
    } finally {
      await this.releaseOwnedPath(
        this.reclaimerPath,
        reclaimer.handle,
        reclaimer.identity,
        reclaimer.token
      );
    }
  }

  private async acquireReclaimer(): Promise<{
    handle: FileHandle;
    identity: FileIdentity;
    token: string;
  }> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const published = await this.publishLock(this.reclaimerPath);
      if (published) return published;

      this.testHooks.onReclaimerContended?.();
      const observation = await this.inspectLock(this.reclaimerPath);
      if (observation && observation.disposition !== 'live') {
        await this.removeObservedLock(this.reclaimerPath, observation);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new JobHistoryStoreError('STORE_LOCKED', 'History reclaimer is busy');
  }

  private async publishLock(
    targetPath: string
  ): Promise<{ handle: FileHandle; identity: FileIdentity; token: string } | null> {
    const candidatePath = `${targetPath}.candidate-${randomUUID()}`;
    const lock: LockRecord = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const candidate = await fs.open(
      candidatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | NO_FOLLOW,
      PRIVATE_FILE_MODE
    );
    let candidateIdentity: FileIdentity | null = null;
    let candidateOpen = true;
    let candidatePresent = true;
    let linked = false;
    let publishedHandle: FileHandle | null = null;
    try {
      await candidate.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
      await candidate.sync();
      const stats = await candidate.stat();
      candidateIdentity = { device: stats.dev, inode: stats.ino };
      try {
        await fs.link(candidatePath, targetPath);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') return null;
        throw error;
      }
      linked = true;
      await this.testHooks.afterLockLinked?.(targetPath);
      await candidate.close();
      candidateOpen = false;
      await fs.unlink(candidatePath);
      candidatePresent = false;

      await this.syncDirectory(path.dirname(targetPath));
      publishedHandle = await fs.open(targetPath, constants.O_RDWR | NO_FOLLOW);
      const [held, visible] = await Promise.all([publishedHandle.stat(), fs.lstat(targetPath)]);
      if (
        !held.isFile() ||
        held.nlink !== 1 ||
        visible.isSymbolicLink() ||
        held.dev !== candidateIdentity.device ||
        held.ino !== candidateIdentity.inode ||
        visible.dev !== candidateIdentity.device ||
        visible.ino !== candidateIdentity.inode
      ) {
        throw new JobHistoryStoreError('UNSAFE_HISTORY_PATH', 'Published lock identity changed');
      }
      return { handle: publishedHandle, identity: candidateIdentity, token: lock.token };
    } catch (error) {
      if (publishedHandle) await publishedHandle.close().catch(() => undefined);
      if (linked && candidateIdentity) {
        try {
          await this.removePublishedLock(targetPath, candidateIdentity, lock.token);
        } catch (cleanupError) {
          throw cleanupError;
        }
      }
      throw error;
    } finally {
      if (candidateOpen) await candidate.close().catch(() => undefined);
      if (candidatePresent) {
        await fs.unlink(candidatePath).catch((error: unknown) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
    }
  }

  private async removePublishedLock(
    targetPath: string,
    identity: FileIdentity,
    token: string
  ): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await fs.open(targetPath, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    try {
      await this.quarantineOwnedLock(targetPath, handle, identity, token);
    } finally {
      await handle.close();
    }
  }

  private async quarantineOwnedLock(
    targetPath: string,
    handle: FileHandle,
    identity: FileIdentity,
    token?: string
  ): Promise<void> {
    await this.assertOwnedLock(handle, targetPath, identity, token);
    await this.testHooks.beforeOwnedLockQuarantine?.(targetPath);
    const quarantinePath = `${targetPath}.quarantine-${randomUUID()}`;
    await fs.rename(targetPath, quarantinePath);
    let quarantinePresent = true;
    try {
      await this.assertOwnedLock(handle, quarantinePath, identity, token);
      await fs.unlink(quarantinePath);
      quarantinePresent = false;
      await this.syncDirectory(path.dirname(targetPath));
    } catch (error) {
      if (quarantinePresent) {
        await this.restoreQuarantinedLock(quarantinePath, targetPath).catch(() => undefined);
      }
      throw error;
    }
  }

  private async assertOwnedLock(
    handle: FileHandle,
    visiblePath: string,
    identity: FileIdentity,
    token?: string
  ): Promise<void> {
    const [held, visible] = await Promise.all([handle.stat(), fs.lstat(visiblePath)]);
    const record = token === undefined ? null : await this.readLockRecord(handle);
    if (
      !held.isFile() ||
      visible.isSymbolicLink() ||
      !visible.isFile() ||
      held.dev !== identity.device ||
      held.ino !== identity.inode ||
      visible.dev !== identity.device ||
      visible.ino !== identity.inode ||
      (token !== undefined && record?.token !== token)
    ) {
      throw new JobHistoryStoreError('STORE_LOCKED', 'Lock ownership changed before removal');
    }
  }

  private async readLockRecord(handle: FileHandle): Promise<LockRecord> {
    const stats = await handle.stat();
    if (stats.size <= 0 || stats.size > 4096) {
      throw new JobHistoryStoreError('STORE_LOCKED', 'Lock record size is invalid');
    }
    const contents = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(contents, 0, contents.length, 0);
    let value: unknown;
    try {
      value = JSON.parse(contents.subarray(0, bytesRead).toString('utf8')) as unknown;
    } catch {
      throw new JobHistoryStoreError('STORE_LOCKED', 'Lock record is invalid');
    }
    if (
      !isPlainObject(value) ||
      !hasExactKeys(value, ['pid', 'token', 'createdAt']) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      !isUuid(value.token) ||
      !isIsoTimestamp(value.createdAt)
    ) {
      throw new JobHistoryStoreError('STORE_LOCKED', 'Lock record is invalid');
    }
    return value as unknown as LockRecord;
  }

  private async restoreQuarantinedLock(quarantinePath: string, targetPath: string): Promise<void> {
    try {
      await fs.lstat(targetPath);
      return;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    await fs.rename(quarantinePath, targetPath);
    await this.syncDirectory(path.dirname(targetPath));
  }

  private async inspectLock(targetPath: string): Promise<LockObservation | null> {
    let visible;
    try {
      visible = await fs.lstat(targetPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    if (visible.isSymbolicLink() || !visible.isFile() || visible.nlink !== 1) {
      throw new JobHistoryStoreError('UNSAFE_HISTORY_PATH', 'Unsafe existing lock file');
    }
    await this.testHooks.afterLockPathObserved?.(targetPath);
    const identity = { device: visible.dev, inode: visible.ino };
    let handle: FileHandle;
    try {
      handle = await fs.open(targetPath, constants.O_RDONLY | NO_FOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    try {
      const held = await handle.stat();
      if (held.dev !== identity.device || held.ino !== identity.inode) {
        return { disposition: 'invalid', identity };
      }
      let value: unknown;
      try {
        value = JSON.parse(await handle.readFile('utf8')) as unknown;
      } catch {
        return { disposition: 'invalid', identity };
      }
      if (
        !isPlainObject(value) ||
        !hasExactKeys(value, ['pid', 'token', 'createdAt']) ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        !isUuid(value.token) ||
        !isIsoTimestamp(value.createdAt)
      ) {
        return { disposition: 'invalid', identity };
      }
      try {
        process.kill(value.pid as number, 0);
        return { disposition: 'live', identity, token: value.token };
      } catch (error) {
        return {
          disposition: errorCode(error) === 'ESRCH' ? 'stale' : 'live',
          identity,
          token: value.token,
        };
      }
    } finally {
      await handle.close();
    }
  }

  private sameObservation(first: LockObservation, second: LockObservation): boolean {
    return (
      first.identity.device === second.identity.device &&
      first.identity.inode === second.identity.inode &&
      first.token === second.token &&
      first.disposition === second.disposition
    );
  }

  private async removeObservedLock(
    targetPath: string,
    observation: LockObservation
  ): Promise<void> {
    const current = await this.inspectLock(targetPath);
    if (!current || !this.sameObservation(observation, current)) {
      throw new JobHistoryStoreError('STORE_LOCKED', 'Lock changed before removal');
    }
    const handle = await fs.open(targetPath, constants.O_RDONLY | NO_FOLLOW);
    try {
      await this.quarantineOwnedLock(targetPath, handle, observation.identity, observation.token);
    } finally {
      await handle.close();
    }
  }

  private async releaseOwnedPath(
    targetPath: string,
    handle: FileHandle,
    identity: FileIdentity,
    token: string
  ): Promise<void> {
    try {
      await this.quarantineOwnedLock(targetPath, handle, identity, token);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    } finally {
      await handle.close();
    }
  }

  private async releaseLock(): Promise<void> {
    const handle = this.lockHandle;
    const identity = this.lockIdentity;
    const token = this.lockToken;
    this.lockHandle = null;
    this.lockIdentity = null;
    this.lockToken = null;
    if (handle && identity && token) {
      await this.releaseOwnedPath(this.lockPath, handle, identity, token);
    } else if (handle) {
      await handle.close();
    }
  }

  private async openHistoryFile(): Promise<void> {
    let existed = false;
    try {
      const before = await fs.lstat(this.historyPath);
      existed = true;
      if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
        throw new JobHistoryStoreError(
          'UNSAFE_HISTORY_PATH',
          'History path must be one regular unlinked file'
        );
      }
    } catch (error) {
      if (error instanceof JobHistoryStoreError) throw error;
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    let handle: FileHandle;
    try {
      handle = await fs.open(
        this.historyPath,
        constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | NO_FOLLOW,
        PRIVATE_FILE_MODE
      );
    } catch (error) {
      throw new JobHistoryStoreError(
        'UNSAFE_HISTORY_PATH',
        `History file cannot be opened safely: ${errorCode(error) ?? 'unknown'}`
      );
    }
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      await handle.close();
      throw new JobHistoryStoreError(
        'UNSAFE_HISTORY_PATH',
        'History file must be regular and single-linked'
      );
    }
    this.historyHandle = handle;
    this.historyIdentity = { device: stats.dev, inode: stats.ino };
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    this.testHooks.onHistoryPermissionSynced?.();
    if (!existed) {
      await this.syncParentDirectory();
      await this.assertOwnershipIdentity();
    }
  }

  private async syncParentDirectory(): Promise<void> {
    await this.syncDirectory(path.dirname(this.historyPath));
  }

  private async syncDirectory(directoryPath: string): Promise<void> {
    const directory = await fs.open(directoryPath, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.testHooks.onDirectorySynced?.(directoryPath);
  }

  private requireReadable(): void {
    if (this.closed) {
      throw new JobHistoryStoreError('STORE_CLOSED', 'Job history store is closed');
    }
    if (!this.initialized) {
      throw new JobHistoryStoreError('NOT_INITIALIZED', 'Job history store is not initialized');
    }
  }

  private requireWritable(): void {
    if (this.closed) {
      throw new JobHistoryStoreError('STORE_CLOSED', 'Job history store is closed');
    }
    if (!this.initialized) {
      throw new JobHistoryStoreError('NOT_INITIALIZED', 'Job history store is not initialized');
    }
    if (this.poisoned) {
      throw new JobHistoryStoreError('STORE_POISONED', 'History state requires a disk replay');
    }
  }

  private requireUuid(jobId: string): void {
    if (!isUuid(jobId)) {
      throw new JobHistoryStoreError('INVALID_JOB_ID', 'jobId must be a UUID');
    }
  }

  private timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new JobHistoryStoreError('INVALID_INPUT', 'Clock returned an invalid Date');
    }
    return date.toISOString();
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    return this.admitOperation(() => {
      const result = this.writeQueue.then(operation);
      this.writeQueue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    });
  }

  private admitOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(
        new JobHistoryStoreError('STORE_CLOSED', 'Job history store is closed')
      );
    }
    const result = Promise.resolve().then(operation);
    this.inFlightOperations.add(result);
    void result.then(
      () => this.inFlightOperations.delete(result),
      () => this.inFlightOperations.delete(result)
    );
    return result;
  }

  private async assertFileIdentity(): Promise<FileHandle> {
    const handle = this.historyHandle;
    const identity = this.historyIdentity;
    if (!handle || !identity) {
      throw new JobHistoryStoreError('NOT_INITIALIZED', 'History file is not open');
    }
    const [held, visible] = await Promise.all([handle.stat(), fs.lstat(this.historyPath)]);
    if (
      !held.isFile() ||
      held.nlink !== 1 ||
      visible.isSymbolicLink() ||
      !visible.isFile() ||
      visible.nlink !== 1 ||
      held.dev !== identity.device ||
      held.ino !== identity.inode ||
      visible.dev !== identity.device ||
      visible.ino !== identity.inode
    ) {
      this.poisoned = true;
      throw new JobHistoryStoreError('UNSAFE_HISTORY_PATH', 'History file identity changed');
    }
    return handle;
  }

  private async assertOwnershipIdentity(): Promise<FileHandle> {
    const historyHandle = await this.assertFileIdentity();
    const lockHandle = this.lockHandle;
    const lockIdentity = this.lockIdentity;
    if (!lockHandle || !lockIdentity) {
      this.poisoned = true;
      throw new JobHistoryStoreError('STORE_LOCKED', 'History ownership lock is missing');
    }
    const [held, visible] = await Promise.all([lockHandle.stat(), fs.lstat(this.lockPath)]);
    if (
      !held.isFile() ||
      held.nlink !== 1 ||
      visible.isSymbolicLink() ||
      !visible.isFile() ||
      visible.nlink !== 1 ||
      held.dev !== lockIdentity.device ||
      held.ino !== lockIdentity.inode ||
      visible.dev !== lockIdentity.device ||
      visible.ino !== lockIdentity.inode
    ) {
      this.poisoned = true;
      throw new JobHistoryStoreError('STORE_LOCKED', 'History ownership lock identity changed');
    }
    return historyHandle;
  }

  private async appendRecord(record: PersistedRecord): Promise<void> {
    const handle = await this.assertOwnershipIdentity();
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const startSize = (await handle.stat()).size;
    try {
      await handle.writeFile(line);
      await this.testHooks.beforeHistorySync?.();
      await handle.sync();
    } catch (error) {
      try {
        await this.reconcileAmbiguousAppend(handle, startSize, line);
      } catch {
        this.poisoned = true;
        throw new JobHistoryStoreError(
          'STORE_POISONED',
          `Ambiguous history append: ${errorCode(error) ?? 'I/O failure'}`
        );
      }
    }
    await this.assertOwnershipIdentity();
  }

  private async reconcileAmbiguousAppend(
    handle: FileHandle,
    startSize: number,
    line: Buffer
  ): Promise<void> {
    const stats = await handle.stat();
    if (stats.size < startSize || stats.size > startSize + line.length) {
      throw new JobHistoryStoreError('STORE_POISONED', 'Unexpected append size');
    }
    const appendedLength = stats.size - startSize;
    const appended = Buffer.alloc(appendedLength);
    if (appendedLength > 0) {
      await handle.read(appended, 0, appendedLength, startSize);
    }
    if (!line.subarray(0, appendedLength).equals(appended)) {
      throw new JobHistoryStoreError('STORE_POISONED', 'Unexpected append bytes');
    }
    if (appendedLength !== line.length) {
      await handle.truncate(startSize);
      await handle.sync();
      await handle.writeFile(line);
    }
    await handle.sync();
  }

  private replay(entry: JobEntry): JobStateMachine {
    const machine = seedMachine(entry.creation);
    for (const event of entry.events) {
      const acceptance = machine.accept(event);
      if (!acceptance.accepted) {
        throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Persisted event replay failed', {
          reason: acceptance.reason,
        });
      }
    }
    return machine;
  }

  private snapshot(entry: JobEntry): HistoryJobSnapshot {
    const state = entry.machine.snapshot();
    return deepFreeze(
      cloneSerializable({
        ...entry.creation,
        status: state.status,
        lastSequence: state.lastSequence,
        terminalEventKind: state.terminalEventKind,
        events: entry.events,
      })
    );
  }

  private enforceImmutableEventFields(entry: JobEntry, event: ProcessingEvent): void {
    if (event.kind === ProcessingEventKind.JOB_QUEUED) {
      if (
        event.payload.previewId !== entry.creation.previewId ||
        !isDeepStrictEqual(event.payload.effectiveOptions, entry.creation.effectiveOptions)
      ) {
        throw new JobHistoryStoreError(
          'IMMUTABLE_FIELD_MISMATCH',
          'Queued data must match job creation'
        );
      }
      return;
    }
    if (event.kind !== ProcessingEventKind.JOB_CANCELLED || !entry.creation.previewRows) return;
    const rows = entry.creation.previewRows;
    const outcomes = event.payload.fileOutcomes;
    const matchesPreview =
      outcomes.length === rows.length &&
      rows.every((row, index) => {
        const outcome = outcomes[index];
        const executableStateMatches =
          row.operation === 'skip' ||
          (outcome.state === CancellationFileState.COMPLETED
            ? outcome.committedBytes === outcome.plannedBytes &&
              outcome.sourceRetained === (row.operation !== OperationMode.MOVE)
            : outcome.state === CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED
              ? row.operation === OperationMode.MOVE &&
                outcome.committedBytes === outcome.plannedBytes &&
                outcome.sourceRetained
              : true);
        return (
          outcome.sourcePath === row.sourcePath &&
          outcome.destinationPath === row.targetPath &&
          outcome.plannedBytes === row.fingerprint.size &&
          executableStateMatches &&
          (row.operation !== 'skip' ||
            (outcome.state === CancellationFileState.SKIPPED &&
              outcome.committedBytes === 0 &&
              outcome.sourceRetained))
        );
      });
    if (!matchesPreview) {
      throw new JobHistoryStoreError(
        'IMMUTABLE_FIELD_MISMATCH',
        'Cancelled outcomes must match every immutable preview row'
      );
    }
  }

  private async readHistoryBytes(): Promise<Buffer> {
    const handle = await this.assertFileIdentity();
    const size = (await handle.stat()).size;
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(content, offset, size - offset, offset);
      if (result.bytesRead === 0) {
        throw new JobHistoryStoreError('CORRUPT_HISTORY', 'History read ended early');
      }
      offset += result.bytesRead;
    }
    return content;
  }

  private async loadHistory(): Promise<void> {
    const content = await this.readHistoryBytes();
    if (content.length === 0) return;
    const finalNewline = content.lastIndexOf(0x0a);
    if (finalNewline === 0) this.corrupt(1, 'Empty interior history line');
    const completeBytes = finalNewline >= 0 ? content.subarray(0, finalNewline) : Buffer.alloc(0);
    const tailBytes = content.subarray(finalNewline + 1);
    let lineNumber = 0;
    if (completeBytes.length > 0) {
      for (const line of completeBytes.toString('utf8').split('\n')) {
        lineNumber += 1;
        if (!line) this.corrupt(lineNumber, 'Empty interior history line');
        this.applyPersistedRecord(this.parseJsonLine(line, lineNumber), lineNumber);
      }
    }
    if (tailBytes.length === 0) return;
    lineNumber += 1;
    let parsedTail: unknown;
    try {
      parsedTail = JSON.parse(tailBytes.toString('utf8'));
    } catch {
      const handle = await this.assertFileIdentity();
      await handle.truncate(finalNewline < 0 ? 0 : finalNewline + 1);
      await handle.sync();
      await this.assertOwnershipIdentity();
      return;
    }
    this.applyPersistedRecord(parsedTail, lineNumber);
    const handle = await this.assertFileIdentity();
    await handle.writeFile('\n', 'utf8');
    await handle.sync();
    await this.assertOwnershipIdentity();
  }

  private parseJsonLine(line: string, lineNumber: number): unknown {
    try {
      return JSON.parse(line);
    } catch {
      this.corrupt(lineNumber, 'Malformed interior history record');
    }
  }

  private applyPersistedRecord(value: unknown, lineNumber: number): void {
    let parsed: ParsedPersistedRecord;
    try {
      parsed = parsePersistedRecord(value);
    } catch (error) {
      if (error instanceof JobHistoryStoreError) this.corrupt(lineNumber, error.message);
      throw error;
    }
    const { record } = parsed;
    if (record.recordType === 'job-created') {
      if (this.jobs.has(record.creation.jobId)) {
        this.corrupt(lineNumber, 'Duplicate job creation record');
      }
      this.jobs.set(record.creation.jobId, {
        creation: record.creation,
        events: [],
        machine: seedMachine(record.creation),
      });
      this.emitMigrationWarning(parsed.migrationWarning);
      return;
    }
    const entry = this.jobs.get(record.event.jobId);
    if (!entry) this.corrupt(lineNumber, 'Event precedes its job creation record');
    try {
      this.enforceImmutableEventFields(entry, record.event);
      const acceptance = entry.machine.accept(record.event);
      if (!acceptance.accepted) {
        this.corrupt(lineNumber, `Rejected persisted event: ${acceptance.reason}`);
      }
    } catch (error) {
      if (error instanceof JobHistoryStoreError) this.corrupt(lineNumber, error.message);
      throw error;
    }
    entry.events.push(record.event);
    this.emitMigrationWarning(parsed.migrationWarning);
  }

  private emitMigrationWarning(message: string | undefined): void {
    if (message === undefined) return;
    try {
      this.warning(message);
    } catch {
      // An informational observer cannot corrupt successfully decoded history.
    }
  }

  private corrupt(line: number, message: string): never {
    throw new JobHistoryStoreError('CORRUPT_HISTORY', message, { line });
  }

  private async recoverInterruptedJobs(): Promise<void> {
    for (const entry of this.jobs.values()) {
      const state = entry.machine.snapshot();
      if (!ACTIVE_STATUSES.has(state.status)) continue;
      if (state.lastSequence >= Number.MAX_SAFE_INTEGER) {
        throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Cannot append interruption event');
      }
      const interruption: ProcessingEvent = {
        kind: ProcessingEventKind.JOB_FAILED,
        jobId: entry.creation.jobId,
        sequence: state.lastSequence + 1,
        emittedAt: this.timestamp(),
        payload: {
          error: {
            code: 'INTERRUPTED',
            message: 'Job interrupted by application restart',
            recoverable: true,
          },
        },
      };
      const candidateMachine = this.replay(entry);
      const acceptance = candidateMachine.accept(interruption);
      if (!acceptance.accepted) {
        throw new JobHistoryStoreError('CORRUPT_HISTORY', 'Interruption event was rejected', {
          reason: acceptance.reason,
        });
      }
      await this.appendRecord({
        schemaVersion: SCHEMA_VERSION,
        recordType: 'event-appended',
        event: interruption,
      });
      entry.events.push(interruption);
      entry.machine = candidateMachine;
    }
  }
}
