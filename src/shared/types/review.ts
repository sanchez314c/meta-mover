import type { DateResolutionRecord, MediaKind, ParsedDateValue } from '../../main/core/date/types';

export type ReviewStatus = 'pending' | 'kept' | 'resolved' | 'stale' | 'failed';

export interface ReviewOutputBinding {
  path: string;
  device: number;
  inode: number;
  size: number;
  modifiedTimeMs: number;
  mtimeNs: string;
  sha256: string;
}

export interface ReviewEvidenceSnapshot {
  revision: string;
  resolution: DateResolutionRecord;
  collectedAt: string;
}

export interface ReviewItemDTO {
  reviewId: string;
  jobId: string;
  previewId: string;
  rowIndex: number;
  originalSourcePath: string;
  currentPath: string;
  destinationRoot: string;
  mediaKind: MediaKind;
  status: ReviewStatus;
  reasonCodes: string[];
  warnings: string[];
  evidence: ReviewEvidenceSnapshot;
  output: ReviewOutputBinding;
  screenshotDetected: boolean;
  lastError?: string;
  resolvedPath?: string;
  updatedAt: string;
}

export type ReviewAction =
  | { type: 'select-candidate'; candidateId: string }
  | { type: 'manual-date'; value: ParsedDateValue }
  | { type: 'keep' }
  | { type: 'retry-metadata' };

export interface ReviewListRequestDTO {
  status?: ReviewStatus;
  statuses?: ReviewStatus[];
  limit: number;
  cursor?: string;
}

export interface ReviewPageDTO {
  items: ReviewItemDTO[];
  nextCursor?: string;
}

export interface ReviewGetRequestDTO {
  reviewId: string;
}

export interface ReviewDryRunRequestDTO {
  reviewId: string;
  evidenceRevision: string;
  action: ReviewAction;
}

export interface ReviewDryRunDTO {
  planToken: string;
  action: ReviewAction;
  currentPath: string;
  targetPath: string | null;
  collision: boolean;
  warnings: string[];
  refreshedEvidence?: ReviewEvidenceSnapshot;
}

export interface ReviewApplyRequestDTO extends ReviewDryRunRequestDTO {
  planToken: string;
}

export interface ReviewApplyResultDTO {
  reviewId: string;
  status: ReviewStatus;
  currentPath: string;
  resolvedPath?: string;
  evidenceRevision: string;
}

export type ReviewOverrideResult =
  | { status: 'kept'; currentPath: string }
  | { status: 'resolved'; previousPath: string; resolvedPath: string; transactionId: string }
  | { status: 'pending'; currentPath: string; refreshedEvidence: ReviewEvidenceSnapshot }
  | { status: 'reconciling'; currentPath: string; targetPath: string; transactionId: string }
  | { status: 'failed'; currentPath: string; error: string };

export interface ReviewOverrideRecord {
  schemaVersion: 1;
  eventId: string;
  reviewId: string;
  sequence: number;
  recordedAt: string;
  jobId: string;
  previewId: string;
  rowIndex: number;
  output: ReviewOutputBinding;
  evidenceRevision: string;
  action: ReviewAction;
  result: ReviewOverrideResult;
}

const SHORT_MAX = 512;
const PATH_MAX = 4096;
const STATUSES: readonly ReviewStatus[] = ['pending', 'kept', 'resolved', 'stale', 'failed'];
const MEDIA_KINDS: readonly MediaKind[] = ['image', 'raw', 'video', 'audio', 'document', 'art'];
const ZONE_BASES = [
  'explicit-offset',
  'spec-defined-utc',
  'gps-inferred',
  'device-zone-inferred',
  'floating-local',
  'date-only',
];
const PRECISIONS = ['date', 'minute', 'second', 'millisecond', 'microsecond', 'nanosecond'];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function text(value: unknown, max = SHORT_MAX): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every((entry) => text(entry));
}

function safeNatural(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function finiteNatural(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function iso(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

function json(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return object(value) && Object.values(value).every(json);
}

function isParsedDateValue(value: unknown): value is ParsedDateValue {
  if (
    !object(value) ||
    !exact(
      value,
      ['localIso', 'zoneBasis', 'precision'],
      ['instantUtc', 'offsetMinutes', 'zoneIana', 'fractionalDigits']
    )
  )
    return false;
  return (
    text(value.localIso) &&
    ZONE_BASES.includes(value.zoneBasis as string) &&
    PRECISIONS.includes(value.precision as string) &&
    (value.instantUtc === undefined || iso(value.instantUtc)) &&
    (value.offsetMinutes === undefined ||
      (Number.isInteger(value.offsetMinutes) && Math.abs(value.offsetMinutes as number) <= 840)) &&
    (value.zoneIana === undefined || text(value.zoneIana)) &&
    (value.fractionalDigits === undefined ||
      (typeof value.fractionalDigits === 'string' && /^\d{1,9}$/.test(value.fractionalDigits)))
  );
}

function isScoredDateCandidate(value: unknown): boolean {
  if (
    !object(value) ||
    !exact(
      value,
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
      ['issues']
    ) ||
    !object(value.score) ||
    !exact(value.score, ['base', 'modifiers', 'semanticCap', 'final'])
  )
    return false;
  return (
    text(value.id) &&
    text(value.fileId) &&
    MEDIA_KINDS.includes(value.mediaKind as MediaKind) &&
    [
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
    ].includes(value.semantic as string) &&
    [
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
    ].includes(value.sourceKind as string) &&
    text(value.sourceFamily) &&
    text(value.tag) &&
    json(value.rawValue) &&
    isParsedDateValue(value.value) &&
    ['eligible', 'corroboration-only', 'forbidden', 'invalid'].includes(
      value.eligibility as string
    ) &&
    typeof value.score.base === 'number' &&
    Number.isFinite(value.score.base) &&
    typeof value.score.semanticCap === 'number' &&
    Number.isFinite(value.score.semanticCap) &&
    typeof value.score.final === 'number' &&
    Number.isFinite(value.score.final) &&
    Array.isArray(value.score.modifiers) &&
    value.score.modifiers.every(
      (modifier) =>
        object(modifier) &&
        exact(modifier, ['code', 'delta']) &&
        text(modifier.code) &&
        typeof modifier.delta === 'number' &&
        Number.isFinite(modifier.delta)
    ) &&
    texts(value.resolutionIssues) &&
    (value.issues === undefined || texts(value.issues))
  );
}

function isDateResolutionRecord(value: unknown): value is DateResolutionRecord {
  if (
    !object(value) ||
    !exact(
      value,
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
      ['selectedCandidateId', 'selectedGroupId', 'selectedGroupScore', 'selectedValue']
    )
  )
    return false;
  return (
    value.policyVersion === 'date-resolution/1' &&
    text(value.fileId) &&
    MEDIA_KINDS.includes(value.mediaKind as MediaKind) &&
    ['capture-time', 'recording-time', 'content-created-time'].includes(value.target as string) &&
    iso(value.evaluationTimeUtc) &&
    ['resolved', 'review-required', 'ambiguous', 'unresolved'].includes(value.status as string) &&
    ['high', 'medium', 'low', 'none'].includes(value.confidence as string) &&
    texts(value.contenderIds) &&
    texts(value.reasonCodes) &&
    Array.isArray(value.rejected) &&
    value.rejected.every(
      (entry) =>
        object(entry) &&
        exact(entry, ['candidateId', 'reasons']) &&
        text(entry.candidateId) &&
        texts(entry.reasons)
    ) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isScoredDateCandidate) &&
    (value.selectedCandidateId === undefined || text(value.selectedCandidateId)) &&
    (value.selectedGroupId === undefined || text(value.selectedGroupId)) &&
    (value.selectedGroupScore === undefined ||
      (typeof value.selectedGroupScore === 'number' &&
        Number.isFinite(value.selectedGroupScore))) &&
    (value.selectedValue === undefined || isParsedDateValue(value.selectedValue))
  );
}

export function isReviewOutputBinding(value: unknown): value is ReviewOutputBinding {
  return (
    object(value) &&
    exact(value, ['path', 'device', 'inode', 'size', 'modifiedTimeMs', 'mtimeNs', 'sha256']) &&
    text(value.path, PATH_MAX) &&
    safeNatural(value.device) &&
    safeNatural(value.inode) &&
    safeNatural(value.size) &&
    finiteNatural(value.modifiedTimeMs) &&
    typeof value.mtimeNs === 'string' &&
    /^\d+$/.test(value.mtimeNs) &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

export function isReviewEvidenceSnapshot(value: unknown): value is ReviewEvidenceSnapshot {
  return (
    object(value) &&
    exact(value, ['revision', 'resolution', 'collectedAt']) &&
    text(value.revision) &&
    isDateResolutionRecord(value.resolution) &&
    iso(value.collectedAt)
  );
}

export function isReviewAction(value: unknown): value is ReviewAction {
  if (!object(value) || typeof value.type !== 'string') return false;
  if (value.type === 'select-candidate')
    return exact(value, ['type', 'candidateId']) && text(value.candidateId);
  if (value.type === 'manual-date')
    return exact(value, ['type', 'value']) && isParsedDateValue(value.value);
  return (value.type === 'keep' || value.type === 'retry-metadata') && exact(value, ['type']);
}

export function isReviewListRequestDTO(value: unknown): value is ReviewListRequestDTO {
  return (
    object(value) &&
    exact(value, ['limit'], ['status', 'statuses', 'cursor']) &&
    Number.isSafeInteger(value.limit) &&
    (value.limit as number) >= 1 &&
    (value.limit as number) <= 100 &&
    (value.status === undefined || STATUSES.includes(value.status as ReviewStatus)) &&
    (value.statuses === undefined ||
      (Array.isArray(value.statuses) &&
        value.statuses.length >= 1 &&
        value.statuses.length <= STATUSES.length &&
        value.statuses.every((status) => STATUSES.includes(status as ReviewStatus)) &&
        new Set(value.statuses).size === value.statuses.length)) &&
    !(value.status !== undefined && value.statuses !== undefined) &&
    (value.cursor === undefined || text(value.cursor))
  );
}

export function isReviewGetRequestDTO(value: unknown): value is ReviewGetRequestDTO {
  return object(value) && exact(value, ['reviewId']) && text(value.reviewId);
}

export function isReviewDryRunRequestDTO(value: unknown): value is ReviewDryRunRequestDTO {
  return (
    object(value) &&
    exact(value, ['reviewId', 'evidenceRevision', 'action']) &&
    text(value.reviewId) &&
    text(value.evidenceRevision) &&
    isReviewAction(value.action)
  );
}

export function isReviewApplyRequestDTO(value: unknown): value is ReviewApplyRequestDTO {
  return (
    object(value) &&
    exact(value, ['reviewId', 'evidenceRevision', 'action', 'planToken']) &&
    text(value.reviewId) &&
    text(value.evidenceRevision) &&
    text(value.planToken) &&
    isReviewAction(value.action)
  );
}

export function isReviewItemDTO(value: unknown): value is ReviewItemDTO {
  if (
    !object(value) ||
    !exact(
      value,
      [
        'reviewId',
        'jobId',
        'previewId',
        'rowIndex',
        'originalSourcePath',
        'currentPath',
        'destinationRoot',
        'mediaKind',
        'status',
        'reasonCodes',
        'warnings',
        'evidence',
        'output',
        'screenshotDetected',
        'updatedAt',
      ],
      ['lastError', 'resolvedPath']
    )
  )
    return false;
  return (
    text(value.reviewId) &&
    text(value.jobId) &&
    text(value.previewId) &&
    safeNatural(value.rowIndex) &&
    text(value.originalSourcePath, PATH_MAX) &&
    text(value.currentPath, PATH_MAX) &&
    text(value.destinationRoot, PATH_MAX) &&
    MEDIA_KINDS.includes(value.mediaKind as MediaKind) &&
    STATUSES.includes(value.status as ReviewStatus) &&
    texts(value.reasonCodes) &&
    texts(value.warnings) &&
    isReviewEvidenceSnapshot(value.evidence) &&
    isReviewOutputBinding(value.output) &&
    typeof value.screenshotDetected === 'boolean' &&
    iso(value.updatedAt) &&
    (value.lastError === undefined || text(value.lastError, PATH_MAX)) &&
    (value.resolvedPath === undefined || text(value.resolvedPath, PATH_MAX))
  );
}

export function isReviewPageDTO(value: unknown): value is ReviewPageDTO {
  return (
    object(value) &&
    exact(value, ['items'], ['nextCursor']) &&
    Array.isArray(value.items) &&
    value.items.length <= 100 &&
    value.items.every(isReviewItemDTO) &&
    (value.nextCursor === undefined || text(value.nextCursor))
  );
}

export function isReviewDryRunDTO(value: unknown): value is ReviewDryRunDTO {
  return (
    object(value) &&
    exact(
      value,
      ['planToken', 'action', 'currentPath', 'targetPath', 'collision', 'warnings'],
      ['refreshedEvidence']
    ) &&
    text(value.planToken) &&
    isReviewAction(value.action) &&
    text(value.currentPath, PATH_MAX) &&
    (value.targetPath === null || text(value.targetPath, PATH_MAX)) &&
    typeof value.collision === 'boolean' &&
    texts(value.warnings) &&
    (value.refreshedEvidence === undefined || isReviewEvidenceSnapshot(value.refreshedEvidence))
  );
}

export function isReviewApplyResultDTO(value: unknown): value is ReviewApplyResultDTO {
  return (
    object(value) &&
    exact(value, ['reviewId', 'status', 'currentPath', 'evidenceRevision'], ['resolvedPath']) &&
    text(value.reviewId) &&
    STATUSES.includes(value.status as ReviewStatus) &&
    text(value.currentPath, PATH_MAX) &&
    text(value.evidenceRevision) &&
    (value.resolvedPath === undefined || text(value.resolvedPath, PATH_MAX))
  );
}

function isReviewOverrideResult(value: unknown): value is ReviewOverrideResult {
  if (!object(value)) return false;
  if (value.status === 'kept')
    return exact(value, ['status', 'currentPath']) && text(value.currentPath, PATH_MAX);
  if (value.status === 'resolved')
    return (
      exact(value, ['status', 'previousPath', 'resolvedPath', 'transactionId']) &&
      text(value.previousPath, PATH_MAX) &&
      text(value.resolvedPath, PATH_MAX) &&
      text(value.transactionId)
    );
  if (value.status === 'pending')
    return (
      exact(value, ['status', 'currentPath', 'refreshedEvidence']) &&
      text(value.currentPath, PATH_MAX) &&
      isReviewEvidenceSnapshot(value.refreshedEvidence)
    );
  if (value.status === 'reconciling')
    return (
      exact(value, ['status', 'currentPath', 'targetPath', 'transactionId']) &&
      text(value.currentPath, PATH_MAX) &&
      text(value.targetPath, PATH_MAX) &&
      text(value.transactionId)
    );
  return (
    value.status === 'failed' &&
    exact(value, ['status', 'currentPath', 'error']) &&
    text(value.currentPath, PATH_MAX) &&
    text(value.error, PATH_MAX)
  );
}

export function isReviewOverrideRecord(value: unknown): value is ReviewOverrideRecord {
  return (
    object(value) &&
    exact(value, [
      'schemaVersion',
      'eventId',
      'reviewId',
      'sequence',
      'recordedAt',
      'jobId',
      'previewId',
      'rowIndex',
      'output',
      'evidenceRevision',
      'action',
      'result',
    ]) &&
    value.schemaVersion === 1 &&
    text(value.eventId) &&
    text(value.reviewId) &&
    safeNatural(value.sequence) &&
    iso(value.recordedAt) &&
    text(value.jobId) &&
    text(value.previewId) &&
    safeNatural(value.rowIndex) &&
    isReviewOutputBinding(value.output) &&
    text(value.evidenceRevision) &&
    isReviewAction(value.action) &&
    isReviewOverrideResult(value.result)
  );
}
