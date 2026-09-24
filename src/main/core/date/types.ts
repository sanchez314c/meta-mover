export type MediaKind = 'image' | 'raw' | 'video' | 'audio' | 'document' | 'art';

export type ResolutionTarget = 'capture-time' | 'recording-time' | 'content-created-time';

export type DateSemantic =
  | 'capture'
  | 'recording'
  | 'content-created'
  | 'digitized'
  | 'container-created'
  | 'metadata-modified'
  | 'filename-claim'
  | 'sidecar-claim'
  | 'filesystem-birth'
  | 'filesystem-modified'
  | 'filesystem-changed';

export type SourceKind =
  | 'embedded-exif'
  | 'embedded-xmp'
  | 'embedded-iptc'
  | 'container-format'
  | 'container-stream'
  | 'audio-tag'
  | 'sidecar'
  | 'filename'
  | 'filesystem'
  | 'user-override';

export type ZoneBasis =
  | 'explicit-offset'
  | 'spec-defined-utc'
  | 'gps-inferred'
  | 'device-zone-inferred'
  | 'floating-local'
  | 'date-only';

export type DatePrecision =
  | 'date'
  | 'minute'
  | 'second'
  | 'millisecond'
  | 'microsecond'
  | 'nanosecond';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ParsedDateValue {
  localIso: string;
  instantUtc?: string;
  offsetMinutes?: number;
  zoneIana?: string;
  zoneBasis: ZoneBasis;
  precision: DatePrecision;
  fractionalDigits?: string;
}

export interface DateCandidateInput {
  id: string;
  fileId: string;
  mediaKind: MediaKind;
  semantic: DateSemantic;
  sourceKind: SourceKind;
  sourceFamily: string;
  tag: string;
  rawValue: JsonValue;
  value: ParsedDateValue;
  issues?: string[];
}

export type CandidateEligibility = 'eligible' | 'corroboration-only' | 'forbidden' | 'invalid';

export interface ScoreModifier {
  code: string;
  delta: number;
}

export interface CandidateScore {
  base: number;
  modifiers: ScoreModifier[];
  semanticCap: number;
  final: number;
}

export interface ScoredDateCandidate extends DateCandidateInput {
  eligibility: CandidateEligibility;
  score: CandidateScore;
  resolutionIssues: string[];
}

export interface ResolveDateRequest {
  fileId: string;
  mediaKind: MediaKind;
  evaluationTimeUtc: string;
  candidates: DateCandidateInput[];
}

export type ResolutionStatus = 'resolved' | 'review-required' | 'ambiguous' | 'unresolved';
export type ResolutionConfidence = 'high' | 'medium' | 'low' | 'none';

export interface DateResolutionRecord {
  policyVersion: 'date-resolution/1' | 'date-resolution/2';
  fileId: string;
  mediaKind: MediaKind;
  target: ResolutionTarget;
  evaluationTimeUtc: string;
  status: ResolutionStatus;
  confidence: ResolutionConfidence;
  selectedCandidateId?: string;
  selectedGroupId?: string;
  selectedGroupScore?: number;
  selectedValue?: ParsedDateValue;
  contenderIds: string[];
  rejected: Array<{ candidateId: string; reasons: string[] }>;
  reasonCodes: string[];
  candidates: ScoredDateCandidate[];
}
