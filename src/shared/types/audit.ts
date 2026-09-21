import type { DateResolutionRecord, MediaKind, ParsedDateValue } from '../../main/core/date/types';

export const AuditDisposition = {
  AUTO_NORMALIZE: 'auto-normalize',
  NORMALIZE_AFTER_COHORT_APPROVAL: 'normalize-after-cohort-approval',
  MANUAL_REVIEW: 'manual-review',
  QUARANTINE_UNRESOLVED: 'quarantine-unresolved',
  SKIP_UNSUPPORTED: 'skip-unsupported',
} as const;

export type AuditDisposition = (typeof AuditDisposition)[keyof typeof AuditDisposition];

export interface NormalizationAuditPolicy {
  policyVersion: string;
  transformVersion: string;
  normalizedCreationTags: string[];
  protectedTemporalTags: string[];
}

export interface AuditInputRecord {
  recordId: string;
  operationId?: string;
  sourcePath: string;
  outputPath: string;
  mediaKind: MediaKind;
  extension: string;
  deviceFamily?: string;
  supported?: boolean;
  resolution: DateResolutionRecord;
}

export interface EligibilityDecision {
  disposition: AuditDisposition;
  reasonCodes: string[];
  selectedSourceKind?: string;
  selectedSourceFamily?: string;
  selectedTag?: string;
}

export interface AuditDecision extends EligibilityDecision {
  recordId: string;
  sourcePath: string;
  outputPath: string;
  mediaKind: MediaKind;
  extension: string;
  deviceFamily?: string;
  confidence: DateResolutionRecord['confidence'];
  resolutionStatus: DateResolutionRecord['status'];
  resolutionPolicyVersion: string;
  cohortKey: string;
  policyDigest: string;
  transformDigest: string;
  selectedValue?: ParsedDateValue;
  selectedRawValue?: unknown;
  sourceTagValues?: Record<string, unknown>;
}

export interface AuditMetadataChange {
  tag: string;
  before: unknown;
  after: string;
}

export interface AuditDryRunItem extends AuditDecision {
  metadataChanges: AuditMetadataChange[];
}

export interface AuditDryRunPage extends Omit<AuditPage, 'items'> {
  items: AuditDryRunItem[];
}

export interface AuditPageRequest {
  limit: number;
  cursor?: string;
}

export interface AuditPage {
  revision: string;
  items: AuditDecision[];
  nextCursor?: string;
}

export interface AuditSampleRequest {
  seed: string;
  targetSize: number;
}

export interface AuditSampleResult {
  revision: string;
  items: AuditDecision[];
}
