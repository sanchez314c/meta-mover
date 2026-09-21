import { ScoredDateCandidate } from '../core/date';
import {
  AuditDisposition,
  AuditInputRecord,
  EligibilityDecision,
  NormalizationAuditPolicy,
} from '../../shared/types/audit';

const CONFLICT_MARKERS = ['CONFLICT', 'AMBIGUOUS'];
const PLACEHOLDER_MARKERS = ['PLACEHOLDER', 'EPOCH', 'FUTURE'];
const EXPORT_MARKERS = ['EXPORT', 'TRANSCODE'];

function includesMarker(values: readonly string[], markers: readonly string[]): boolean {
  return values.some((value) => markers.some((marker) => value.toUpperCase().includes(marker)));
}

function selectedCandidate(record: Readonly<AuditInputRecord>): ScoredDateCandidate | undefined {
  const selectedId = record.resolution.selectedCandidateId;
  return selectedId === undefined
    ? undefined
    : record.resolution.candidates.find((candidate) => candidate.id === selectedId);
}

function selectionDetails(candidate: ScoredDateCandidate | undefined) {
  return candidate === undefined
    ? {}
    : {
        selectedSourceKind: candidate.sourceKind,
        selectedSourceFamily: candidate.sourceFamily,
        selectedTag: candidate.tag,
      };
}

function sameSelectedValue(
  selected: Readonly<ScoredDateCandidate>,
  resolution: Readonly<AuditInputRecord['resolution']>
): boolean {
  return JSON.stringify(selected.value) === JSON.stringify(resolution.selectedValue);
}

function resolutionIsInternallyConsistent(
  record: Readonly<AuditInputRecord>,
  selected: ScoredDateCandidate
): boolean {
  const resolution = record.resolution;
  if (
    selected.eligibility !== 'eligible' ||
    selected.fileId !== resolution.fileId ||
    !sameSelectedValue(selected, resolution) ||
    !resolution.contenderIds.includes(selected.id)
  ) {
    return false;
  }
  const contenders = resolution.contenderIds.map((id) =>
    resolution.candidates.find((candidate) => candidate.id === id)
  );
  if (
    contenders.some(
      (candidate) =>
        candidate === undefined ||
        candidate.eligibility !== 'eligible' ||
        candidate.fileId !== resolution.fileId ||
        !sameSelectedValue(candidate, resolution)
    )
  ) {
    return false;
  }
  return true;
}

function hasIndependentCorroborator(
  record: Readonly<AuditInputRecord>,
  selected: ScoredDateCandidate
): boolean {
  return record.resolution.contenderIds.some((id) => {
    const candidate = record.resolution.candidates.find((entry) => entry.id === id);
    return (
      candidate !== undefined &&
      candidate.id !== selected.id &&
      candidate.sourceKind !== selected.sourceKind &&
      candidate.sourceFamily !== selected.sourceFamily
    );
  });
}

export class NormalizationEligibility {
  constructor(private readonly policy: Readonly<NormalizationAuditPolicy>) {
    if (!policy.policyVersion || !policy.transformVersion) {
      throw new TypeError('normalization audit policy versions must be non-empty');
    }
  }

  classify(record: Readonly<AuditInputRecord>): EligibilityDecision {
    if (record.supported === false) {
      return { disposition: AuditDisposition.SKIP_UNSUPPORTED, reasonCodes: ['UNSUPPORTED_FILE'] };
    }

    const resolution = record.resolution;
    const selected = selectedCandidate(record);
    const details = selectionDetails(selected);
    if (
      resolution.status === 'unresolved' ||
      resolution.status === 'ambiguous' ||
      resolution.selectedValue === undefined ||
      selected === undefined
    ) {
      return {
        disposition: AuditDisposition.QUARANTINE_UNRESOLVED,
        reasonCodes: ['UNRESOLVED_OR_AMBIGUOUS_DATE', ...resolution.reasonCodes].sort(),
        ...details,
      };
    }

    if (!resolutionIsInternallyConsistent(record, selected)) {
      return {
        disposition: AuditDisposition.MANUAL_REVIEW,
        reasonCodes: ['INCONSISTENT_RESOLUTION_REQUIRES_REVIEW'],
        ...details,
      };
    }

    const allIssues = [
      ...resolution.reasonCodes,
      ...(selected.issues ?? []),
      ...selected.resolutionIssues,
    ];
    if (resolution.confidence !== 'high') {
      return {
        disposition: AuditDisposition.MANUAL_REVIEW,
        reasonCodes: [`${resolution.confidence.toUpperCase()}_CONFIDENCE_REQUIRES_REVIEW`],
        ...details,
      };
    }
    if (selected.sourceKind === 'filename') {
      return {
        disposition: AuditDisposition.MANUAL_REVIEW,
        reasonCodes: ['FILENAME_SELECTION_REQUIRES_REVIEW'],
        ...details,
      };
    }
    const independentlyCorroborated = hasIndependentCorroborator(record, selected);
    if (
      resolution.reasonCodes.includes('INDEPENDENT_CORROBORATION') &&
      !independentlyCorroborated
    ) {
      return {
        disposition: AuditDisposition.MANUAL_REVIEW,
        reasonCodes: ['INCONSISTENT_RESOLUTION_REQUIRES_REVIEW'],
        ...details,
      };
    }
    if (includesMarker(allIssues, CONFLICT_MARKERS)) {
      return {
        disposition: AuditDisposition.MANUAL_REVIEW,
        reasonCodes: ['CONFLICT_REQUIRES_REVIEW'],
        ...details,
      };
    }
    if (includesMarker(allIssues, PLACEHOLDER_MARKERS)) {
      return {
        disposition: AuditDisposition.MANUAL_REVIEW,
        reasonCodes: ['PLACEHOLDER_DATE_REQUIRES_REVIEW'],
        ...details,
      };
    }
    if (includesMarker(allIssues, EXPORT_MARKERS)) {
      return {
        disposition: AuditDisposition.MANUAL_REVIEW,
        reasonCodes: ['EXPORT_OR_TRANSCODE_REQUIRES_REVIEW'],
        ...details,
      };
    }

    const embeddedOriginal =
      [
        'embedded-exif',
        'embedded-xmp',
        'embedded-iptc',
        'container-format',
        'container-stream',
        'audio-tag',
      ].includes(selected.sourceKind) &&
      ['capture', 'recording', 'content-created'].includes(selected.semantic);
    if (!embeddedOriginal) {
      return {
        disposition: AuditDisposition.NORMALIZE_AFTER_COHORT_APPROVAL,
        reasonCodes: ['NON_ORIGINAL_SOURCE_REQUIRES_COHORT_APPROVAL'],
        ...details,
      };
    }

    if (
      !resolution.reasonCodes.includes('INDEPENDENT_CORROBORATION') ||
      !independentlyCorroborated
    ) {
      return {
        disposition: AuditDisposition.NORMALIZE_AFTER_COHORT_APPROVAL,
        reasonCodes: ['UNCORROBORATED_HIGH_CONFIDENCE_REQUIRES_COHORT_APPROVAL'],
        ...details,
      };
    }

    return {
      disposition: AuditDisposition.AUTO_NORMALIZE,
      reasonCodes: ['SAFE_HIGH_CONFIDENCE_EMBEDDED_ORIGINAL'],
      ...details,
    };
  }
}
