import { createHash } from 'crypto';
import { constants } from 'fs';
import { mkdir, open } from 'fs/promises';
import * as path from 'path';

import {
  CanonicalJsonValue,
  EvidenceManifest,
  canonicalJson,
  canonicalize,
  validatePrivateDirectory,
} from '../core/evidence/EvidenceManifest';
import type {
  CoordinatorHistoryPort,
  LedgerHistoryRecord,
  PreviewAuditRecord,
  StartRejectionRecord,
} from './ProcessingCoordinator';
import {
  ConflictPolicy,
  DateEvidenceSource,
  FolderStructure,
  OperationMode,
  ProcessingEventKind,
  isValidDateEvidenceValue,
} from '../../shared/types/processing';
import type { PreviewResultDTO, TerminalProcessingEvent } from '../../shared/types/processing';

export interface CoordinatorEvidenceAdapterOptions {
  evidenceRoot: string;
  policyVersion: string;
}

export type CoordinatorEvidenceAdapterErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'UNKNOWN_JOB'
  | 'DUPLICATE_PREVIEW'
  | 'ADAPTER_SHUTDOWN'
  | 'SHUTDOWN_FAILED';

export class CoordinatorEvidenceAdapterError extends Error {
  constructor(
    public readonly code: CoordinatorEvidenceAdapterErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CoordinatorEvidenceAdapterError';
  }
}

interface EvidenceJobState {
  readonly jobId: string;
  readonly previewId: string;
  readonly manifestPath: string;
  readonly ready: Promise<EvidenceManifest>;
  readonly previewSnapshot: Record<string, CanonicalJsonValue>;
  readonly operationsById: Map<string, Record<string, CanonicalJsonValue>>;
  readonly ledgerByOperationId: Map<string, Record<string, CanonicalJsonValue>>;
  terminalPromise?: Promise<void>;
  terminalCanonical?: string;
}

const MEDIA_KINDS = ['image', 'raw', 'video', 'audio', 'document', 'art'] as const;
const RESOLUTION_STATUSES = ['resolved', 'review-required', 'ambiguous', 'unresolved'] as const;
const RESOLUTION_CONFIDENCES = ['high', 'medium', 'low', 'none'] as const;
const DATE_SEMANTICS = [
  'capture',
  'recording',
  'content-created',
  'digitized',
  'container-created',
  'metadata-modified',
  'filename-claim',
  'sidecar-claim',
  'filesystem-birth',
  'filesystem-modified',
  'filesystem-changed',
] as const;
const SOURCE_KINDS = [
  'embedded-exif',
  'embedded-xmp',
  'embedded-iptc',
  'container-format',
  'container-stream',
  'audio-tag',
  'sidecar',
  'filename',
  'filesystem',
  'user-override',
] as const;

function requireFiniteNumber(value: CanonicalJsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    invalidSchema(`${label} must be finite`);
  return value;
}

function validateParsedDate(value: CanonicalJsonValue | undefined, label: string): void {
  const parsed = requireObject(value, label);
  assertKeys(
    parsed,
    [
      'localIso',
      'instantUtc',
      'offsetMinutes',
      'zoneIana',
      'zoneBasis',
      'precision',
      'fractionalDigits',
    ],
    ['localIso', 'zoneBasis', 'precision'],
    label
  );
  requireString(parsed, 'localIso', label);
  if (parsed.instantUtc !== undefined) requireInstant(parsed.instantUtc, `${label}.instantUtc`);
  if (parsed.offsetMinutes !== undefined)
    requireFiniteNumber(parsed.offsetMinutes, `${label}.offsetMinutes`);
  if (parsed.zoneIana !== undefined && typeof parsed.zoneIana !== 'string')
    invalidSchema(`${label}.zoneIana must be a string`);
  if (
    ![
      'explicit-offset',
      'spec-defined-utc',
      'gps-inferred',
      'device-zone-inferred',
      'floating-local',
      'date-only',
    ].includes(parsed.zoneBasis as string)
  )
    invalidSchema(`${label}.zoneBasis is invalid`);
  if (
    !['date', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond'].includes(
      parsed.precision as string
    )
  )
    invalidSchema(`${label}.precision is invalid`);
  if (
    parsed.fractionalDigits !== undefined &&
    (typeof parsed.fractionalDigits !== 'string' || !/^\d{1,9}$/.test(parsed.fractionalDigits))
  )
    invalidSchema(`${label}.fractionalDigits is invalid`);
  const floating = parsed.zoneBasis === 'floating-local' || parsed.zoneBasis === 'date-only';
  if (floating && parsed.instantUtc !== undefined)
    invalidSchema(`${label}.instantUtc is invalid for floating or date-only evidence`);
  if (!floating && parsed.instantUtc === undefined)
    invalidSchema(`${label}.instantUtc is required for anchored evidence`);
}

function validateCandidate(
  value: CanonicalJsonValue | undefined,
  label: string,
  fileId: string
): void {
  const candidate = requireObject(value, label);
  assertKeys(
    candidate,
    [
      'id',
      'fileId',
      'mediaKind',
      'semantic',
      'sourceKind',
      'sourceFamily',
      'tag',
      'rawValue',
      'value',
      'issues',
      'eligibility',
      'score',
      'resolutionIssues',
    ],
    [
      'id',
      'fileId',
      'mediaKind',
      'semantic',
      'sourceKind',
      'sourceFamily',
      'tag',
      'rawValue',
      'value',
      'eligibility',
      'score',
      'resolutionIssues',
    ],
    label
  );
  requireString(candidate, 'id', label);
  if (requireString(candidate, 'fileId', label) !== fileId)
    invalidSchema(`${label}.fileId does not match resolution`);
  if (!MEDIA_KINDS.includes(candidate.mediaKind as never))
    invalidSchema(`${label}.mediaKind is invalid`);
  if (!DATE_SEMANTICS.includes(candidate.semantic as never))
    invalidSchema(`${label}.semantic is invalid`);
  if (!SOURCE_KINDS.includes(candidate.sourceKind as never))
    invalidSchema(`${label}.sourceKind is invalid`);
  requireString(candidate, 'sourceFamily', label);
  requireString(candidate, 'tag', label);
  validateParsedDate(candidate.value, `${label}.value`);
  if (candidate.issues !== undefined) requireStringArray(candidate.issues, `${label}.issues`);
  if (
    !['eligible', 'corroboration-only', 'forbidden', 'invalid'].includes(
      candidate.eligibility as string
    )
  )
    invalidSchema(`${label}.eligibility is invalid`);
  const score = requireObject(candidate.score, `${label}.score`);
  assertKeys(
    score,
    ['base', 'modifiers', 'semanticCap', 'final'],
    ['base', 'modifiers', 'semanticCap', 'final'],
    `${label}.score`
  );
  requireFiniteNumber(score.base, `${label}.score.base`);
  requireFiniteNumber(score.semanticCap, `${label}.score.semanticCap`);
  requireFiniteNumber(score.final, `${label}.score.final`);
  if (!Array.isArray(score.modifiers)) invalidSchema(`${label}.score.modifiers must be an array`);
  score.modifiers.forEach((modifier, index) => {
    const item = requireObject(modifier, `${label}.score.modifiers[${index}]`);
    assertKeys(item, ['code', 'delta'], ['code', 'delta'], `${label}.score.modifiers[${index}]`);
    requireString(item, 'code', `${label}.score.modifiers[${index}]`);
    requireFiniteNumber(item.delta, `${label}.score.modifiers[${index}].delta`);
  });
  requireStringArray(candidate.resolutionIssues, `${label}.resolutionIssues`);
}

function validateResolution(value: CanonicalJsonValue | undefined, label: string): void {
  const resolution = requireObject(value, label);
  assertKeys(
    resolution,
    [
      'policyVersion',
      'fileId',
      'mediaKind',
      'target',
      'evaluationTimeUtc',
      'status',
      'confidence',
      'selectedCandidateId',
      'selectedGroupId',
      'selectedGroupScore',
      'selectedValue',
      'contenderIds',
      'rejected',
      'reasonCodes',
      'candidates',
    ],
    [
      'policyVersion',
      'fileId',
      'mediaKind',
      'target',
      'evaluationTimeUtc',
      'status',
      'confidence',
      'contenderIds',
      'rejected',
      'reasonCodes',
      'candidates',
    ],
    label
  );
  if (resolution.policyVersion !== 'date-resolution/1')
    invalidSchema(`${label}.policyVersion is invalid`);
  const fileId = requireString(resolution, 'fileId', label);
  if (!MEDIA_KINDS.includes(resolution.mediaKind as never))
    invalidSchema(`${label}.mediaKind is invalid`);
  if (
    !['capture-time', 'recording-time', 'content-created-time'].includes(
      resolution.target as string
    )
  )
    invalidSchema(`${label}.target is invalid`);
  requireInstant(resolution.evaluationTimeUtc, `${label}.evaluationTimeUtc`);
  if (!RESOLUTION_STATUSES.includes(resolution.status as never))
    invalidSchema(`${label}.status is invalid`);
  if (!RESOLUTION_CONFIDENCES.includes(resolution.confidence as never))
    invalidSchema(`${label}.confidence is invalid`);
  for (const key of ['selectedCandidateId', 'selectedGroupId'] as const)
    if (resolution[key] !== undefined && typeof resolution[key] !== 'string')
      invalidSchema(`${label}.${key} must be a string`);
  if (resolution.selectedGroupScore !== undefined)
    requireFiniteNumber(resolution.selectedGroupScore, `${label}.selectedGroupScore`);
  if (resolution.selectedValue !== undefined)
    validateParsedDate(resolution.selectedValue, `${label}.selectedValue`);
  const contenderIds = requireStringArray(resolution.contenderIds, `${label}.contenderIds`);
  requireStringArray(resolution.reasonCodes, `${label}.reasonCodes`);
  if (!Array.isArray(resolution.rejected)) invalidSchema(`${label}.rejected must be an array`);
  resolution.rejected.forEach((rejected, index) => {
    const item = requireObject(rejected, `${label}.rejected[${index}]`);
    assertKeys(
      item,
      ['candidateId', 'reasons'],
      ['candidateId', 'reasons'],
      `${label}.rejected[${index}]`
    );
    requireString(item, 'candidateId', `${label}.rejected[${index}]`);
    requireStringArray(item.reasons, `${label}.rejected[${index}].reasons`);
  });
  if (!Array.isArray(resolution.candidates)) invalidSchema(`${label}.candidates must be an array`);
  const candidateIds = new Set<string>();
  const candidatesById = new Map<string, Record<string, CanonicalJsonValue>>();
  resolution.candidates.forEach((candidate, index) => {
    validateCandidate(candidate, `${label}.candidates[${index}]`, fileId);
    const candidateRecord = requireObject(candidate, `${label}.candidates[${index}]`);
    if (candidateRecord.mediaKind !== resolution.mediaKind)
      invalidSchema(`${label}.candidate mediaKind does not match resolution`);
    const id = requireString(candidateRecord, 'id', `${label}.candidates[${index}]`);
    if (candidateIds.has(id)) invalidSchema(`${label}.candidates contains duplicate IDs`);
    candidateIds.add(id);
    candidatesById.set(id, candidateRecord);
  });
  if (
    resolution.selectedCandidateId !== undefined &&
    !candidateIds.has(resolution.selectedCandidateId as string)
  )
    invalidSchema(`${label}.selectedCandidateId is unknown`);
  if (contenderIds.some((id) => !candidateIds.has(id)))
    invalidSchema(`${label}.contenderIds contains an unknown candidate`);
  const selected =
    resolution.selectedCandidateId === undefined
      ? undefined
      : candidatesById.get(resolution.selectedCandidateId as string);
  const selectionFields = [
    selected,
    resolution.selectedGroupId,
    resolution.selectedGroupScore,
    resolution.selectedValue,
  ];
  const hasSelection = selectionFields.every((field) => field !== undefined);
  if (selectionFields.some((field) => field !== undefined) && !hasSelection)
    invalidSchema(`${label} selection fields must be all present or absent`);
  if (
    resolution.status === 'resolved' &&
    (!hasSelection || !['high', 'medium'].includes(resolution.confidence as string))
  )
    invalidSchema(`${label} resolved status requires a high or medium confidence selection`);
  if (resolution.status === 'review-required' && (!hasSelection || resolution.confidence !== 'low'))
    invalidSchema(`${label} review-required status requires a low confidence selection`);
  if (resolution.status === 'ambiguous' && (hasSelection || resolution.confidence !== 'none'))
    invalidSchema(`${label} ambiguous status cannot contain a selection`);
  if (resolution.status === 'unresolved' && (hasSelection || resolution.confidence !== 'none'))
    invalidSchema(`${label} unresolved status cannot contain a selection`);
  if (
    selected !== undefined &&
    resolution.selectedValue !== undefined &&
    canonicalJson(selected.value) !== canonicalJson(resolution.selectedValue)
  )
    invalidSchema(`${label}.selectedValue does not match selected candidate`);
}

function validateAudit(
  snapshot: Record<string, CanonicalJsonValue>,
  preview: Record<string, CanonicalJsonValue>
): void {
  assertKeys(
    snapshot,
    ['jobId', 'previewId', 'decisionRecords', 'operationRecords'],
    ['jobId', 'previewId', 'decisionRecords', 'operationRecords'],
    'preview audit'
  );
  if (snapshot.jobId !== preview.jobId || snapshot.previewId !== preview.previewId)
    invalidSchema('preview audit identity does not match preview');
  if (!Array.isArray(snapshot.decisionRecords) || !Array.isArray(snapshot.operationRecords))
    invalidSchema('preview audit records must be arrays');
  const rows = preview.rows as CanonicalJsonValue[];
  const decisions = new Map<number, string>();
  let previousDecisionRowIndex = -1;
  snapshot.decisionRecords.forEach((record, index) => {
    const item = requireObject(record, `preview audit.decisionRecords[${index}]`);
    assertKeys(
      item,
      ['rowIndex', 'sourcePath', 'resolution'],
      ['rowIndex', 'sourcePath', 'resolution'],
      `preview audit.decisionRecords[${index}]`
    );
    const rowIndex = requireNonnegativeInteger(
      item,
      'rowIndex',
      `preview audit.decisionRecords[${index}]`
    );
    const sourcePath = requireString(item, 'sourcePath', `preview audit.decisionRecords[${index}]`);
    if (
      rowIndex <= previousDecisionRowIndex ||
      decisions.has(rowIndex) ||
      rowIndex >= rows.length ||
      requireObject(rows[rowIndex], `preview.rows[${rowIndex}]`).sourcePath !== sourcePath
    )
      invalidSchema('preview audit decision row mapping or order is invalid');
    validateResolution(item.resolution, `preview audit.decisionRecords[${index}].resolution`);
    const row = requireObject(rows[rowIndex], `preview.rows[${rowIndex}]`);
    const publicEvidence = requireObject(
      row.dateEvidence,
      `preview.rows[${rowIndex}].dateEvidence`
    );
    const resolution = requireObject(
      item.resolution,
      `preview audit.decisionRecords[${index}].resolution`
    );
    const selectedCandidate = (resolution.candidates as CanonicalJsonValue[])
      .map((candidate) => requireObject(candidate, 'date candidate'))
      .find((candidate) => candidate.id === resolution.selectedCandidateId);
    const selectedValue =
      resolution.selectedValue === undefined
        ? undefined
        : requireObject(resolution.selectedValue, 'selected date value');
    const expectedValue = selectedValue?.instantUtc ?? selectedValue?.localIso ?? null;
    const expectedConfidence =
      resolution.confidence === 'high'
        ? 1
        : resolution.confidence === 'medium'
          ? 0.7
          : resolution.confidence === 'low'
            ? 0.4
            : 0;
    const expectedSource =
      selectedCandidate === undefined
        ? DateEvidenceSource.UNRESOLVED
        : selectedCandidate.sourceKind === 'filename'
          ? DateEvidenceSource.FILENAME
          : selectedCandidate.semantic === 'filesystem-birth'
            ? DateEvidenceSource.FILESYSTEM_BIRTH
            : DateEvidenceSource.EMBEDDED;
    if (
      publicEvidence.value !== expectedValue ||
      publicEvidence.confidence !== expectedConfidence ||
      publicEvidence.source !== expectedSource ||
      (selectedCandidate !== undefined && publicEvidence.field !== selectedCandidate.tag) ||
      (selectedCandidate === undefined && publicEvidence.field !== undefined)
    )
      invalidSchema('preview audit resolution disagrees with public date evidence');
    decisions.set(rowIndex, sourcePath);
    previousDecisionRowIndex = rowIndex;
  });
  const operationIds = new Set<string>();
  const operationRowIndexes = new Set<number>();
  snapshot.operationRecords.forEach((record, index) => {
    const item = requireObject(record, `preview audit.operationRecords[${index}]`);
    assertKeys(
      item,
      ['operationIndex', 'operationId', 'sourcePath', 'targetPath', 'bytes', 'decisionRowIndex'],
      ['operationIndex', 'operationId', 'sourcePath', 'targetPath', 'bytes', 'decisionRowIndex'],
      `preview audit.operationRecords[${index}]`
    );
    if (
      requireNonnegativeInteger(
        item,
        'operationIndex',
        `preview audit.operationRecords[${index}]`
      ) !== index
    )
      invalidSchema('preview audit operation indexes must be contiguous');
    const operationId = requireString(
      item,
      'operationId',
      `preview audit.operationRecords[${index}]`
    );
    const sourcePath = requireString(
      item,
      'sourcePath',
      `preview audit.operationRecords[${index}]`
    );
    requireString(item, 'targetPath', `preview audit.operationRecords[${index}]`);
    requireNonnegativeInteger(item, 'bytes', `preview audit.operationRecords[${index}]`);
    const decisionRowIndex = requireNonnegativeInteger(
      item,
      'decisionRowIndex',
      `preview audit.operationRecords[${index}]`
    );
    if (
      operationIds.has(operationId) ||
      operationRowIndexes.has(decisionRowIndex) ||
      decisions.get(decisionRowIndex) !== sourcePath
    )
      invalidSchema('preview audit operation mapping is invalid');
    const row = requireObject(rows[decisionRowIndex], `preview.rows[${decisionRowIndex}]`);
    if (
      row.targetPath !== item.targetPath ||
      requireObject(row.fingerprint, `preview.rows[${decisionRowIndex}].fingerprint`).size !==
        item.bytes
    )
      invalidSchema('preview audit operation disagrees with preview row');
    operationIds.add(operationId);
    operationRowIndexes.add(decisionRowIndex);
  });
  const executableRows = rows.filter(
    (row) => requireObject(row, 'preview row').operation !== 'skip'
  ).length;
  if (snapshot.operationRecords.length !== executableRows)
    invalidSchema('preview audit does not map every executable row');
  const supportedRowIndexes = rows.flatMap((row, index) =>
    requireObject(row, `preview.rows[${index}]`).targetPath === null ? [] : [index]
  );
  if (
    decisions.size !== supportedRowIndexes.length ||
    supportedRowIndexes.some((index) => !decisions.has(index))
  )
    invalidSchema('preview audit does not contain every supported row decision');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareEvidenceRoot(evidenceRoot: string): Promise<string> {
  if (typeof evidenceRoot !== 'string' || !path.isAbsolute(evidenceRoot)) {
    throw new CoordinatorEvidenceAdapterError(
      'INVALID_CONFIGURATION',
      'Evidence root must be absolute'
    );
  }
  const normalized = path.normalize(evidenceRoot);
  let created = false;
  try {
    await mkdir(normalized, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  if (created) {
    await syncDirectory(path.dirname(normalized));
  }
  await validatePrivateDirectory(normalized);
  await syncDirectory(normalized);
  return normalized;
}

function snapshotRecord(value: unknown, label: string): Record<string, CanonicalJsonValue> {
  const snapshot = canonicalize(value);
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new CoordinatorEvidenceAdapterError(
      'INVALID_CONFIGURATION',
      `${label} must be a canonical object`
    );
  }
  return snapshot;
}

function requireString(
  record: Record<string, CanonicalJsonValue>,
  key: string,
  label: string
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CoordinatorEvidenceAdapterError(
      'INVALID_CONFIGURATION',
      `${label}.${key} must be a non-empty string`
    );
  }
  return value;
}

function invalidSchema(message: string): never {
  throw new CoordinatorEvidenceAdapterError('INVALID_CONFIGURATION', message);
}

function requireObject(value: CanonicalJsonValue | undefined, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidSchema(`${label} must be an object`);
  }
  return value;
}

function assertKeys(
  record: Record<string, CanonicalJsonValue>,
  allowed: readonly string[],
  required: readonly string[],
  label: string
): void {
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !(key in record))) {
    invalidSchema(`${label} has missing or unknown fields`);
  }
}

function requireStringArray(value: CanonicalJsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    invalidSchema(`${label} must be an array of strings`);
  }
  return value as string[];
}

function requireNonnegativeInteger(
  record: Record<string, CanonicalJsonValue>,
  key: string,
  label: string
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidSchema(`${label}.${key} must be a non-negative safe integer`);
  }
  return value as number;
}

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function requireInstant(value: CanonicalJsonValue | undefined, label: string): string {
  if (
    typeof value !== 'string' ||
    !INSTANT_PATTERN.test(value) ||
    !isValidDateEvidenceValue(value)
  ) {
    invalidSchema(`${label} must be a valid timestamp with an explicit timezone`);
  }
  return value;
}

function requireDateEvidenceValue(value: CanonicalJsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !isValidDateEvidenceValue(value))
    invalidSchema(`${label} must be an explicit instant or local ISO date value`);
  return value;
}

function validateOptions(value: CanonicalJsonValue | undefined, label: string): void {
  const options = requireObject(value, label);
  assertKeys(
    options,
    [
      'operation',
      'conflictPolicy',
      'folderStructure',
      'workerCount',
      'verifyIntegrity',
      'writeMetadataDates',
    ],
    [
      'operation',
      'conflictPolicy',
      'folderStructure',
      'workerCount',
      'verifyIntegrity',
      'writeMetadataDates',
    ],
    label
  );
  if (!Object.values(OperationMode).includes(options.operation as OperationMode))
    invalidSchema(`${label}.operation is invalid`);
  if (!Object.values(ConflictPolicy).includes(options.conflictPolicy as ConflictPolicy))
    invalidSchema(`${label}.conflictPolicy is invalid`);
  if (!Object.values(FolderStructure).includes(options.folderStructure as FolderStructure))
    invalidSchema(`${label}.folderStructure is invalid`);
  if (!Number.isSafeInteger(options.workerCount) || (options.workerCount as number) <= 0)
    invalidSchema(`${label}.workerCount must be a positive safe integer`);
  if (typeof options.verifyIntegrity !== 'boolean')
    invalidSchema(`${label}.verifyIntegrity must be boolean`);
  if (typeof options.writeMetadataDates !== 'boolean')
    invalidSchema(`${label}.writeMetadataDates must be boolean`);
}

function validatePreview(snapshot: Record<string, CanonicalJsonValue>): {
  jobId: string;
  previewId: string;
} {
  assertKeys(
    snapshot,
    [
      'jobId',
      'previewId',
      'createdAt',
      'expiresAt',
      'request',
      'effectiveOptions',
      'summary',
      'rows',
      'nextPageToken',
    ],
    ['jobId', 'previewId', 'createdAt', 'request', 'effectiveOptions', 'summary', 'rows'],
    'preview'
  );
  const jobId = requireString(snapshot, 'jobId', 'preview');
  const previewId = requireString(snapshot, 'previewId', 'preview');
  requireInstant(snapshot.createdAt, 'preview.createdAt');
  if (snapshot.expiresAt !== undefined) requireInstant(snapshot.expiresAt, 'preview.expiresAt');
  if (snapshot.nextPageToken !== undefined)
    invalidSchema('preview is incomplete while nextPageToken is present');

  const request = requireObject(snapshot.request, 'preview.request');
  assertKeys(
    request,
    ['sourcePaths', 'destinationPath', 'options'],
    ['sourcePaths', 'destinationPath', 'options'],
    'preview.request'
  );
  const sourcePaths = requireStringArray(request.sourcePaths, 'preview.request.sourcePaths');
  if (sourcePaths.length === 0 || sourcePaths.some((sourcePath) => sourcePath.length === 0))
    invalidSchema('preview.request.sourcePaths must contain non-empty strings');
  requireString(request, 'destinationPath', 'preview.request');
  validateOptions(request.options, 'preview.request.options');
  validateOptions(snapshot.effectiveOptions, 'preview.effectiveOptions');

  const rows = snapshot.rows;
  if (!Array.isArray(rows)) invalidSchema('preview.rows must contain the complete preview rows');
  let copyFiles = 0;
  let moveFiles = 0;
  let skippedFiles = 0;
  let unresolvedDates = 0;
  let totalBytes = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const label = `preview.rows[${index}]`;
    const row = requireObject(rows[index], label);
    assertKeys(
      row,
      [
        'sourcePath',
        'targetPath',
        'operation',
        'conflictPolicy',
        'dateEvidence',
        'fingerprint',
        'warnings',
      ],
      [
        'sourcePath',
        'targetPath',
        'operation',
        'conflictPolicy',
        'dateEvidence',
        'fingerprint',
        'warnings',
      ],
      label
    );
    requireString(row, 'sourcePath', label);
    if (row.operation === OperationMode.COPY) copyFiles += 1;
    else if (row.operation === OperationMode.MOVE) moveFiles += 1;
    else if (row.operation === 'skip') skippedFiles += 1;
    else invalidSchema(`${label}.operation is invalid`);
    if (row.operation === 'skip') {
      if (
        row.targetPath !== null &&
        (typeof row.targetPath !== 'string' || row.targetPath.length === 0)
      )
        invalidSchema(`${label}.targetPath must be null or a non-empty string for skipped rows`);
    } else if (typeof row.targetPath !== 'string' || row.targetPath.length === 0) {
      invalidSchema(`${label}.targetPath must be a non-empty string`);
    }
    if (!Object.values(ConflictPolicy).includes(row.conflictPolicy as ConflictPolicy))
      invalidSchema(`${label}.conflictPolicy is invalid`);
    const rowWarnings = requireStringArray(row.warnings, `${label}.warnings`);
    if (rowWarnings.includes('Creation date requires review')) unresolvedDates += 1;

    const dateEvidence = requireObject(row.dateEvidence, `${label}.dateEvidence`);
    assertKeys(
      dateEvidence,
      ['value', 'source', 'field', 'confidence', 'warnings'],
      ['value', 'source', 'confidence', 'warnings'],
      `${label}.dateEvidence`
    );
    if (!Object.values(DateEvidenceSource).includes(dateEvidence.source as DateEvidenceSource))
      invalidSchema(`${label}.dateEvidence.source is invalid`);
    if (dateEvidence.source === DateEvidenceSource.UNRESOLVED) {
      if (dateEvidence.value !== null)
        invalidSchema(`${label}.dateEvidence.value must be null when unresolved`);
    } else {
      requireDateEvidenceValue(dateEvidence.value, `${label}.dateEvidence.value`);
    }
    if (dateEvidence.field !== undefined && typeof dateEvidence.field !== 'string')
      invalidSchema(`${label}.dateEvidence.field must be a string`);
    if (
      typeof dateEvidence.confidence !== 'number' ||
      dateEvidence.confidence < 0 ||
      dateEvidence.confidence > 1
    )
      invalidSchema(`${label}.dateEvidence.confidence must be between 0 and 1`);
    requireStringArray(dateEvidence.warnings, `${label}.dateEvidence.warnings`);

    const fingerprint = requireObject(row.fingerprint, `${label}.fingerprint`);
    assertKeys(
      fingerprint,
      ['size', 'modifiedAt', 'hash'],
      ['size', 'modifiedAt'],
      `${label}.fingerprint`
    );
    const size = requireNonnegativeInteger(fingerprint, 'size', `${label}.fingerprint`);
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes))
      invalidSchema('preview row bytes exceed safe integer range');
    requireInstant(fingerprint.modifiedAt, `${label}.fingerprint.modifiedAt`);
    if (
      fingerprint.hash !== undefined &&
      (typeof fingerprint.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint.hash))
    )
      invalidSchema(`${label}.fingerprint.hash must be SHA-256 hex`);
  }

  const summary = requireObject(snapshot.summary, 'preview.summary');
  const summaryKeys = [
    'totalFiles',
    'copyFiles',
    'moveFiles',
    'skippedFiles',
    'renamedFiles',
    'overwrittenFiles',
    'unresolvedDates',
    'totalBytes',
  ] as const;
  assertKeys(summary, summaryKeys, summaryKeys, 'preview.summary');
  const values = Object.fromEntries(
    summaryKeys.map((key) => [key, requireNonnegativeInteger(summary, key, 'preview.summary')])
  ) as Record<(typeof summaryKeys)[number], number>;
  if (
    values.totalFiles !== rows.length ||
    values.copyFiles !== copyFiles ||
    values.moveFiles !== moveFiles ||
    values.skippedFiles !== skippedFiles ||
    values.unresolvedDates !== unresolvedDates ||
    values.totalBytes !== totalBytes
  ) {
    invalidSchema('preview.summary does not conserve the complete preview rows');
  }
  return { jobId, previewId };
}

const COORDINATOR_ERROR_CODES = new Set([
  'INVALID_CONFIGURATION',
  'INVALID_REQUEST',
  'INVALID_PLAN',
  'PREVIEW_NOT_FOUND',
  'PREVIEW_EXPIRED',
  'PREVIEW_CONSUMED',
  'PREVIEW_DRIFT',
  'REVALIDATION_FAILED',
  'MOVE_ACK_REQUIRED',
  'JOB_NOT_FOUND',
  'INVALID_EVENT_TRANSITION',
  'HISTORY_PERSISTENCE_FAILED',
  'COORDINATOR_SHUTDOWN',
]);

function validateLedger(snapshot: Record<string, CanonicalJsonValue>): {
  jobId: string;
  previewId: string;
} {
  assertKeys(
    snapshot,
    ['jobId', 'previewId', 'entry'],
    ['jobId', 'previewId', 'entry'],
    'ledger record'
  );
  const jobId = requireString(snapshot, 'jobId', 'ledger record');
  const previewId = requireString(snapshot, 'previewId', 'ledger record');
  const entry = requireObject(snapshot.entry, 'ledger record.entry');
  assertKeys(
    entry,
    [
      'operationId',
      'outcome',
      'bytes',
      'error',
      'cancellationState',
      'sourceRetained',
      'destinationCommitted',
    ],
    ['operationId', 'outcome', 'bytes'],
    'ledger record.entry'
  );
  requireString(entry, 'operationId', 'ledger record.entry');
  if (!['committed', 'skipped', 'failed', 'cancelled'].includes(entry.outcome as string))
    invalidSchema('ledger record.entry.outcome is invalid');
  const bytes = requireNonnegativeInteger(entry, 'bytes', 'ledger record.entry');
  if (entry.outcome === 'skipped' && bytes !== 0)
    invalidSchema('skipped ledger record cannot contain committed bytes');
  if (
    entry.error !== undefined &&
    (typeof entry.error !== 'string' || entry.error.trim().length === 0)
  ) {
    invalidSchema('ledger record.entry.error must be a non-empty string when present');
  }
  if (
    entry.outcome === 'failed' &&
    (typeof entry.error !== 'string' || entry.error.trim().length === 0)
  ) {
    invalidSchema('failed ledger record must contain a non-empty error');
  }
  if (entry.outcome === 'cancelled') {
    if (
      !['cancelled-before-commit', 'destination-committed-source-retained'].includes(
        entry.cancellationState as string
      ) ||
      entry.sourceRetained !== true ||
      typeof entry.destinationCommitted !== 'boolean' ||
      (entry.cancellationState === 'cancelled-before-commit' && bytes !== 0) ||
      (entry.destinationCommitted &&
        entry.cancellationState !== 'destination-committed-source-retained') ||
      (!entry.destinationCommitted && entry.cancellationState !== 'cancelled-before-commit')
    ) {
      invalidSchema('cancelled ledger record does not conserve committed residue');
    }
  } else {
    if (entry.cancellationState !== undefined)
      invalidSchema('non-cancelled ledger record cannot contain a cancellation state');
    if (entry.outcome === 'failed') {
      if (
        (entry.sourceRetained === undefined) !== (entry.destinationCommitted === undefined) ||
        (entry.sourceRetained !== undefined && typeof entry.sourceRetained !== 'boolean') ||
        (entry.destinationCommitted !== undefined &&
          typeof entry.destinationCommitted !== 'boolean') ||
        (entry.destinationCommitted === false && bytes !== 0)
      ) {
        invalidSchema('failed ledger record contains inconsistent mutation fields');
      }
    } else if (entry.sourceRetained !== undefined || entry.destinationCommitted !== undefined) {
      invalidSchema('successful ledger record cannot contain failure mutation fields');
    }
  }
  return { jobId, previewId };
}

function validateStartRejection(snapshot: Record<string, CanonicalJsonValue>): {
  jobId: string;
  previewId: string;
} {
  assertKeys(
    snapshot,
    ['jobId', 'previewId', 'code', 'reasons', 'rejectedAt'],
    ['jobId', 'previewId', 'code', 'reasons', 'rejectedAt'],
    'start rejection'
  );
  const jobId = requireString(snapshot, 'jobId', 'start rejection');
  const previewId = requireString(snapshot, 'previewId', 'start rejection');
  if (typeof snapshot.code !== 'string' || !COORDINATOR_ERROR_CODES.has(snapshot.code))
    invalidSchema('start rejection.code is invalid');
  requireStringArray(snapshot.reasons, 'start rejection.reasons');
  requireInstant(snapshot.rejectedAt, 'start rejection.rejectedAt');
  return { jobId, previewId };
}

function validateStatistics(value: CanonicalJsonValue | undefined, label: string) {
  const statistics = requireObject(value, label);
  const keys = [
    'totalFiles',
    'processedFiles',
    'skippedFiles',
    'failedFiles',
    'totalBytes',
    'processedBytes',
    'durationMs',
  ];
  assertKeys(statistics, keys, keys, label);
  const totalFiles = requireNonnegativeInteger(statistics, 'totalFiles', label);
  const processedFiles = requireNonnegativeInteger(statistics, 'processedFiles', label);
  const skippedFiles = requireNonnegativeInteger(statistics, 'skippedFiles', label);
  const failedFiles = requireNonnegativeInteger(statistics, 'failedFiles', label);
  const totalBytes = requireNonnegativeInteger(statistics, 'totalBytes', label);
  const processedBytes = requireNonnegativeInteger(statistics, 'processedBytes', label);
  requireNonnegativeInteger(statistics, 'durationMs', label);
  if (processedFiles + skippedFiles + failedFiles !== totalFiles || processedBytes > totalBytes) {
    invalidSchema(`${label} does not conserve file or byte counts`);
  }
  return { totalFiles, processedFiles, skippedFiles, failedFiles, totalBytes, processedBytes };
}

function validateFileFailures(
  value: CanonicalJsonValue | undefined,
  label: string,
  allowEmpty: boolean = false
) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalidSchema(`${label} must be ${allowEmpty ? 'an array' : 'a non-empty array'}`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const failure = requireObject(value[index], `${label}[${index}]`);
    assertKeys(failure, ['sourcePath', 'error'], ['sourcePath', 'error'], `${label}[${index}]`);
    requireString(failure, 'sourcePath', `${label}[${index}]`);
    requireString(failure, 'error', `${label}[${index}]`);
  }
  return value;
}

function validateCancellationStatistics(value: CanonicalJsonValue | undefined, label: string) {
  const statistics = requireObject(value, label);
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
  assertKeys(statistics, keys, keys, label);
  const values = Object.fromEntries(
    keys.map((key) => [key, requireNonnegativeInteger(statistics, key, label)])
  ) as Record<string, number>;
  if (
    values.processedFiles +
      values.skippedFiles +
      values.failedFiles +
      values.cancelledFiles +
      values.unattemptedFiles !==
      values.totalFiles ||
    values.processedBytes + values.committedResidueBytes > values.totalBytes
  ) {
    invalidSchema(`${label} does not conserve cancelled file or byte counts`);
  }
  return values;
}

function validateCancellationOutcomes(value: CanonicalJsonValue | undefined, label: string) {
  if (!Array.isArray(value)) invalidSchema(`${label} must be an array`);
  return value.map((outcome, index) => {
    const item = requireObject(outcome, `${label}[${index}]`);
    assertKeys(
      item,
      [
        'sourcePath',
        'destinationPath',
        'state',
        'plannedBytes',
        'committedBytes',
        'sourceRetained',
        'error',
      ],
      [
        'sourcePath',
        'destinationPath',
        'state',
        'plannedBytes',
        'committedBytes',
        'sourceRetained',
      ],
      `${label}[${index}]`
    );
    requireString(item, 'sourcePath', `${label}[${index}]`);
    if (item.destinationPath !== null && typeof item.destinationPath !== 'string')
      invalidSchema(`${label}[${index}].destinationPath must be a string or null`);
    const states = [
      'completed',
      'skipped',
      'failed',
      'cancelled-before-commit',
      'destination-committed-source-retained',
      'not-attempted',
    ];
    if (!states.includes(item.state as string))
      invalidSchema(`${label}[${index}].state is invalid`);
    const plannedBytes = requireNonnegativeInteger(item, 'plannedBytes', `${label}[${index}]`);
    const committedBytes = requireNonnegativeInteger(item, 'committedBytes', `${label}[${index}]`);
    if (committedBytes > plannedBytes)
      invalidSchema(`${label}[${index}].committedBytes exceeds plannedBytes`);
    if (typeof item.sourceRetained !== 'boolean')
      invalidSchema(`${label}[${index}].sourceRetained must be boolean`);
    if (item.error !== undefined && typeof item.error !== 'string')
      invalidSchema(`${label}[${index}].error must be a string`);
    if (
      ['skipped', 'cancelled-before-commit', 'not-attempted'].includes(item.state as string) &&
      committedBytes !== 0
    ) {
      invalidSchema(`${label}[${index}] has impossible committed residue`);
    }
    if (
      [
        'cancelled-before-commit',
        'destination-committed-source-retained',
        'not-attempted',
      ].includes(item.state as string) &&
      item.sourceRetained !== true
    ) {
      invalidSchema(`${label}[${index}] must report the retained source`);
    }
    return item;
  });
}

function validateTerminal(snapshot: Record<string, CanonicalJsonValue>): string {
  assertKeys(
    snapshot,
    ['kind', 'jobId', 'sequence', 'emittedAt', 'payload'],
    ['kind', 'jobId', 'sequence', 'emittedAt', 'payload'],
    'terminal event'
  );
  const jobId = requireString(snapshot, 'jobId', 'terminal event');
  if (
    ![
      ProcessingEventKind.JOB_COMPLETED,
      ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      ProcessingEventKind.JOB_FAILED,
      ProcessingEventKind.JOB_CANCELLED,
    ].includes(snapshot.kind as never)
  )
    invalidSchema('terminal event.kind is not terminal');
  if (!Number.isSafeInteger(snapshot.sequence) || (snapshot.sequence as number) <= 0)
    invalidSchema('terminal event.sequence must be a positive safe integer');
  requireInstant(snapshot.emittedAt, 'terminal event.emittedAt');
  const payload = requireObject(snapshot.payload, 'terminal event.payload');
  if (snapshot.kind === ProcessingEventKind.JOB_COMPLETED) {
    assertKeys(payload, ['statistics'], ['statistics'], 'terminal event.payload');
    const statistics = validateStatistics(payload.statistics, 'terminal event.payload.statistics');
    if (statistics.failedFiles !== 0)
      invalidSchema('completed terminal event cannot contain failed files');
  } else if (snapshot.kind === ProcessingEventKind.JOB_PARTIALLY_COMPLETED) {
    assertKeys(
      payload,
      ['statistics', 'fileFailures'],
      ['statistics', 'fileFailures'],
      'terminal event.payload'
    );
    const statistics = validateStatistics(payload.statistics, 'terminal event.payload.statistics');
    const failures = validateFileFailures(
      payload.fileFailures,
      'terminal event.payload.fileFailures'
    );
    if (
      statistics.failedFiles !== failures.length ||
      statistics.failedFiles >= statistics.totalFiles
    )
      invalidSchema('partial terminal event failure counts are inconsistent');
  } else if (snapshot.kind === ProcessingEventKind.JOB_FAILED) {
    assertKeys(
      payload,
      ['error', 'statistics', 'fileFailures'],
      ['error'],
      'terminal event.payload'
    );
    const error = requireObject(payload.error, 'terminal event.payload.error');
    assertKeys(
      error,
      ['code', 'message', 'recoverable', 'details'],
      ['code', 'message', 'recoverable'],
      'terminal event.payload.error'
    );
    requireString(error, 'code', 'terminal event.payload.error');
    requireString(error, 'message', 'terminal event.payload.error');
    if (typeof error.recoverable !== 'boolean')
      invalidSchema('terminal event.payload.error.recoverable must be boolean');
    if (error.details !== undefined && typeof error.details !== 'string')
      invalidSchema('terminal event.payload.error.details must be a string');
    const requiresAllFileDetails = error.code === 'FILE_OPERATIONS_FAILED';
    if (
      requiresAllFileDetails &&
      (payload.statistics === undefined || payload.fileFailures === undefined)
    ) {
      invalidSchema(
        'FILE_OPERATIONS_FAILED requires statistics and fileFailures for every planned file'
      );
    }
    if (payload.statistics !== undefined || payload.fileFailures !== undefined) {
      if (payload.statistics === undefined || payload.fileFailures === undefined)
        invalidSchema('failed terminal file details must include statistics and fileFailures');
      const statistics = validateStatistics(
        payload.statistics,
        'terminal event.payload.statistics'
      );
      const failures = validateFileFailures(
        payload.fileFailures,
        'terminal event.payload.fileFailures',
        !requiresAllFileDetails
      );
      if (
        statistics.failedFiles !== failures.length ||
        (requiresAllFileDetails && statistics.failedFiles !== statistics.totalFiles)
      )
        invalidSchema('failed terminal event failure counts are inconsistent');
    }
  } else {
    assertKeys(
      payload,
      ['reason', 'filesProcessed', 'statistics', 'fileFailures', 'fileOutcomes'],
      ['filesProcessed', 'statistics', 'fileFailures', 'fileOutcomes'],
      'terminal event.payload'
    );
    const filesProcessed = requireNonnegativeInteger(
      payload,
      'filesProcessed',
      'terminal event.payload'
    );
    if (payload.reason !== undefined && typeof payload.reason !== 'string')
      invalidSchema('terminal event.payload.reason must be a string');
    const statistics = validateCancellationStatistics(
      payload.statistics,
      'terminal event.payload.statistics'
    );
    const failures = validateFileFailures(
      payload.fileFailures,
      'terminal event.payload.fileFailures',
      true
    ) as Record<string, CanonicalJsonValue>[];
    const outcomes = validateCancellationOutcomes(
      payload.fileOutcomes,
      'terminal event.payload.fileOutcomes'
    );
    const count = (state: string): number =>
      outcomes.filter((outcome) => outcome.state === state).length;
    const residueBytes = outcomes
      .filter((outcome) => outcome.state !== 'completed')
      .reduce((total, outcome) => total + (outcome.committedBytes as number), 0);
    const plannedBytes = outcomes.reduce(
      (total, outcome) => total + (outcome.plannedBytes as number),
      0
    );
    const processedBytes = outcomes
      .filter((outcome) => outcome.state === 'completed')
      .reduce((total, outcome) => total + (outcome.committedBytes as number), 0);
    const failedOutcomes = outcomes.filter((outcome) => outcome.state === 'failed');
    const failuresMatch = failures.every(
      (failure, index) =>
        failure.sourcePath === failedOutcomes[index]?.sourcePath &&
        failure.error === failedOutcomes[index]?.error
    );
    if (
      filesProcessed !== statistics.processedFiles ||
      outcomes.length !== statistics.totalFiles ||
      count('completed') !== statistics.processedFiles ||
      count('skipped') !== statistics.skippedFiles ||
      count('failed') !== statistics.failedFiles ||
      count('cancelled-before-commit') + count('destination-committed-source-retained') !==
        statistics.cancelledFiles ||
      count('not-attempted') !== statistics.unattemptedFiles ||
      failures.length !== statistics.failedFiles ||
      !failuresMatch ||
      plannedBytes !== statistics.totalBytes ||
      processedBytes !== statistics.processedBytes ||
      residueBytes !== statistics.committedResidueBytes
    ) {
      invalidSchema('cancelled terminal outcome and residue counts are inconsistent');
    }
  }
  return jobId;
}

function validateCancellationBinding(
  state: EvidenceJobState,
  terminal: Record<string, CanonicalJsonValue>
): void {
  if (terminal.kind !== ProcessingEventKind.JOB_CANCELLED) return;
  const payload = requireObject(terminal.payload, 'terminal event.payload');
  const outcomes = payload.fileOutcomes as Record<string, CanonicalJsonValue>[];
  const rows = state.previewSnapshot.rows as Record<string, CanonicalJsonValue>[];
  if (outcomes.length !== rows.length)
    invalidSchema('cancelled terminal outcomes do not cover every immutable preview row');

  const operationByRowIndex = new Map<number, Record<string, CanonicalJsonValue>>();
  for (const operation of state.operationsById.values()) {
    operationByRowIndex.set(operation.decisionRowIndex as number, operation);
  }

  rows.forEach((row, index) => {
    const outcome = outcomes[index];
    const fingerprint = requireObject(row.fingerprint, `preview.rows[${index}].fingerprint`);
    if (
      outcome.sourcePath !== row.sourcePath ||
      outcome.destinationPath !== row.targetPath ||
      outcome.plannedBytes !== fingerprint.size
    ) {
      invalidSchema(
        `cancelled terminal outcome ${index} disagrees with immutable preview path or bytes`
      );
    }
    if (row.operation === 'skip') {
      if (
        outcome.state !== 'skipped' ||
        outcome.committedBytes !== 0 ||
        outcome.sourceRetained !== true ||
        outcome.error !== undefined
      ) {
        invalidSchema(`cancelled terminal outcome ${index} contradicts skipped preview row`);
      }
      return;
    }

    const operation = operationByRowIndex.get(index);
    if (!operation) invalidSchema(`cancelled terminal outcome ${index} has no planned operation`);
    const ledger = state.ledgerByOperationId.get(operation.operationId as string);
    if (!ledger) {
      if (
        outcome.state !== 'not-attempted' ||
        outcome.committedBytes !== 0 ||
        outcome.sourceRetained !== true ||
        outcome.error !== 'Not attempted because the job was cancelled'
      ) {
        invalidSchema(`cancelled terminal outcome ${index} contradicts absent operation ledger`);
      }
      return;
    }

    const expectedState =
      ledger.outcome === 'committed'
        ? 'completed'
        : ledger.outcome === 'skipped'
          ? 'skipped'
          : ledger.outcome === 'failed'
            ? 'failed'
            : ledger.cancellationState;
    const expectedRetained =
      ledger.outcome === 'committed'
        ? row.operation !== OperationMode.MOVE
        : ledger.outcome === 'failed' || ledger.outcome === 'cancelled'
          ? (ledger.sourceRetained ?? true)
          : true;
    if (
      outcome.state !== expectedState ||
      outcome.committedBytes !== ledger.bytes ||
      outcome.sourceRetained !== expectedRetained ||
      outcome.error !== ledger.error
    ) {
      invalidSchema(`cancelled terminal outcome ${index} disagrees with operation ledger`);
    }
  });
}

export class CoordinatorEvidenceAdapter implements CoordinatorHistoryPort {
  private readonly jobs = new Map<string, EvidenceJobState>();
  private readonly admitted = new Set<Promise<unknown>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private admittedFailureCount = 0;

  private constructor(
    private readonly evidenceRoot: string,
    private readonly policyVersion: string
  ) {}

  static async create(
    options: CoordinatorEvidenceAdapterOptions
  ): Promise<CoordinatorEvidenceAdapter> {
    const snapshot = snapshotRecord(options, 'evidence options');
    const evidenceRoot = await prepareEvidenceRoot(
      requireString(snapshot, 'evidenceRoot', 'evidence options')
    );
    const policyVersion = requireString(snapshot, 'policyVersion', 'evidence options');
    return new CoordinatorEvidenceAdapter(evidenceRoot, policyVersion);
  }

  manifestPathForJob(jobId: string): string {
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw new CoordinatorEvidenceAdapterError(
        'INVALID_CONFIGURATION',
        'jobId must be a non-empty string'
      );
    }
    const fileId = createHash('sha256').update(jobId).digest('hex');
    return path.join(this.evidenceRoot, `${fileId}.evidence.jsonl`);
  }

  recordPreview(
    preview: Readonly<PreviewResultDTO>,
    audit?: Readonly<PreviewAuditRecord>
  ): Promise<void> {
    return this.admit(() => {
      const snapshot = snapshotRecord(preview, 'preview');
      const { jobId, previewId } = validatePreview(snapshot);
      const auditSnapshot =
        audit === undefined ? undefined : snapshotRecord(audit, 'preview audit');
      if (auditSnapshot === undefined) invalidSchema('preview audit is required');
      validateAudit(auditSnapshot, snapshot);
      if (this.jobs.has(jobId)) {
        throw new CoordinatorEvidenceAdapterError(
          'DUPLICATE_PREVIEW',
          `Evidence manifest already exists for job ${jobId}`
        );
      }
      const manifestPath = this.manifestPathForJob(jobId);
      const operationsById = new Map<string, Record<string, CanonicalJsonValue>>();
      for (const value of auditSnapshot.operationRecords as CanonicalJsonValue[]) {
        const operation = requireObject(value, 'preview audit operation');
        operationsById.set(operation.operationId as string, operation);
      }
      const ready = EvidenceManifest.create(manifestPath, jobId, this.policyVersion).then(
        async (manifest) => {
          const { rows, ...previewHeader } = snapshot;
          await manifest.append('preview-recorded', {
            preview: previewHeader,
            rowCount: (rows as CanonicalJsonValue[]).length,
          });
          for (let rowIndex = 0; rowIndex < (rows as CanonicalJsonValue[]).length; rowIndex += 1) {
            await manifest.append('file-observed', {
              previewId,
              rowIndex,
              row: (rows as CanonicalJsonValue[])[rowIndex],
            });
          }
          {
            const decisions = auditSnapshot.decisionRecords as CanonicalJsonValue[];
            for (const decisionValue of decisions) {
              const decision = requireObject(decisionValue, 'preview audit decision');
              const resolution = requireObject(
                decision.resolution,
                'preview audit decision.resolution'
              );
              const candidates = resolution.candidates as CanonicalJsonValue[];
              for (
                let candidateIndex = 0;
                candidateIndex < candidates.length;
                candidateIndex += 1
              ) {
                await manifest.append('candidate-observed', {
                  previewId,
                  rowIndex: decision.rowIndex,
                  candidateIndex,
                  sourcePath: decision.sourcePath,
                  candidate: candidates[candidateIndex],
                });
              }
              await manifest.append('resolution-decided', {
                previewId,
                rowIndex: decision.rowIndex,
                sourcePath: decision.sourcePath,
                resolution: decision.resolution,
              });
            }
            for (const operation of auditSnapshot.operationRecords as CanonicalJsonValue[]) {
              await manifest.append('operation-planned', { previewId, operation });
            }
          }
          return manifest;
        }
      );
      this.jobs.set(jobId, {
        jobId,
        previewId,
        manifestPath,
        ready,
        previewSnapshot: snapshot,
        operationsById,
        ledgerByOperationId: new Map(),
      });
      return ready.then(() => undefined);
    });
  }

  recordLedgerEntry(record: Readonly<LedgerHistoryRecord>): Promise<void> {
    return this.admit(async () => {
      const snapshot = snapshotRecord(record, 'ledger record');
      const { jobId, previewId } = validateLedger(snapshot);
      const entry = requireObject(snapshot.entry, 'ledger record.entry');
      const state = this.requireJob(jobId);
      if (previewId !== state.previewId)
        invalidSchema('ledger record.previewId does not match preview');
      const operationId = entry.operationId as string;
      const operation = state.operationsById.get(operationId);
      if (!operation) invalidSchema('ledger record.entry.operationId is not in the preview audit');
      const previewRow = (state.previewSnapshot.rows as Record<string, CanonicalJsonValue>[])[
        operation.decisionRowIndex as number
      ];
      if ((entry.bytes as number) > (operation.bytes as number))
        invalidSchema('ledger record.entry.bytes exceeds planned operation bytes');
      if (entry.outcome === 'committed' && entry.bytes !== operation.bytes)
        invalidSchema('committed ledger bytes must equal planned operation bytes');
      if (
        entry.cancellationState === 'destination-committed-source-retained' &&
        entry.bytes !== operation.bytes
      ) {
        invalidSchema('destination-committed ledger bytes must equal planned operation bytes');
      }
      if (
        entry.cancellationState === 'destination-committed-source-retained' &&
        previewRow.operation !== OperationMode.MOVE
      ) {
        invalidSchema('destination-committed-source-retained is valid only for Move operations');
      }
      if (state.ledgerByOperationId.has(operationId))
        invalidSchema('ledger record.entry.operationId was already recorded');
      const outcome = entry.outcome;
      const kind =
        outcome === 'committed'
          ? 'operation-committed'
          : outcome === 'skipped'
            ? 'operation-skipped'
            : outcome === 'failed'
              ? 'operation-failed'
              : outcome === 'cancelled'
                ? 'operation-cancelled'
                : null;
      if (kind === null) {
        throw new CoordinatorEvidenceAdapterError(
          'INVALID_CONFIGURATION',
          'ledger outcome is invalid'
        );
      }
      const manifest = await state.ready;
      await manifest.append(kind, { ledger: snapshot });
      state.ledgerByOperationId.set(operationId, entry);
    });
  }

  recordStartRejection(record: Readonly<StartRejectionRecord>): Promise<void> {
    return this.admit(async () => {
      const snapshot = snapshotRecord(record, 'start rejection');
      const { jobId, previewId } = validateStartRejection(snapshot);
      const state = this.requireJob(jobId);
      if (previewId !== state.previewId)
        invalidSchema('start rejection.previewId does not match preview');
      const manifest = await state.ready;
      await manifest.append('start-rejected', { rejection: snapshot });
    });
  }

  recordTerminal(event: Readonly<TerminalProcessingEvent>): Promise<void> {
    return this.admit(() => {
      const snapshot = snapshotRecord(event, 'terminal event');
      const jobId = validateTerminal(snapshot);
      const state = this.requireJob(jobId);
      validateCancellationBinding(state, snapshot);
      const terminalCanonical = canonicalJson(snapshot);
      if (state.terminalPromise) {
        if (state.terminalCanonical !== terminalCanonical) {
          invalidSchema('terminal event conflicts with the terminal already admitted for this job');
        }
      } else {
        state.terminalCanonical = terminalCanonical;
        state.terminalPromise = state.ready
          .then((manifest) => manifest.close({ terminal: snapshot }))
          .then(() => undefined);
      }
      return state.terminalPromise as Promise<void>;
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    await Promise.allSettled([...this.admitted]);
    const closing = [...this.jobs.values()].map((state) => {
      if (!state.terminalPromise) {
        state.terminalPromise = state.ready
          .then((manifest) =>
            manifest.close({
              shutdown: {
                reason: 'adapter-shutdown',
                jobId: state.jobId,
              },
            })
          )
          .then(() => undefined);
      }
      return state.terminalPromise;
    });
    const results = await Promise.allSettled(closing);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length > 0 || this.admittedFailureCount > 0) {
      throw new CoordinatorEvidenceAdapterError(
        'SHUTDOWN_FAILED',
        `Evidence shutdown failed: ${this.admittedFailureCount} admitted hook(s), ${failures.length} manifest(s)`
      );
    }
  }

  private requireJob(jobId: string): EvidenceJobState {
    const state = this.jobs.get(jobId);
    if (!state) {
      throw new CoordinatorEvidenceAdapterError(
        'UNKNOWN_JOB',
        `No evidence manifest exists for job ${jobId}; record the preview first`
      );
    }
    return state;
  }

  private admit<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.shuttingDown) {
      return Promise.reject(
        new CoordinatorEvidenceAdapterError('ADAPTER_SHUTDOWN', 'Evidence adapter is shutting down')
      );
    }
    let result: Promise<T>;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(error);
    }
    return this.track(result);
  }

  private track<T>(result: Promise<T>): Promise<T> {
    this.admitted.add(result);
    void result.then(
      () => this.admitted.delete(result),
      () => {
        this.admittedFailureCount += 1;
        this.admitted.delete(result);
      }
    );
    return result;
  }
}
