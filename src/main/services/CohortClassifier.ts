import { createHash } from 'crypto';

import {
  AuditDecision,
  AuditInputRecord,
  EligibilityDecision,
  NormalizationAuditPolicy,
} from '../../shared/types/audit';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export class CohortClassifier {
  readonly policyDigest: string;
  readonly transformDigest: string;

  constructor(policy: Readonly<NormalizationAuditPolicy>) {
    this.transformDigest = digest({
      transformVersion: policy.transformVersion,
      normalizedCreationTags: sortedUnique(policy.normalizedCreationTags),
      protectedTemporalTags: sortedUnique(policy.protectedTemporalTags),
    });
    this.policyDigest = digest({
      policyVersion: policy.policyVersion,
      transformDigest: this.transformDigest,
    });
  }

  classify(
    record: Readonly<AuditInputRecord>,
    eligibility: Readonly<EligibilityDecision>
  ): AuditDecision {
    const cohortDimensions = {
      policyDigest: this.policyDigest,
      transformDigest: this.transformDigest,
      disposition: eligibility.disposition,
      mediaKind: record.mediaKind,
      extension: record.extension.toLowerCase(),
      deviceFamily: record.deviceFamily ?? 'unknown',
      resolutionPolicyVersion: record.resolution.policyVersion,
      confidence: record.resolution.confidence,
      status: record.resolution.status,
      selectedSourceKind: eligibility.selectedSourceKind ?? 'none',
      selectedSourceFamily: eligibility.selectedSourceFamily ?? 'none',
      selectedTag: eligibility.selectedTag ?? 'none',
      reasonCodes: sortedUnique(eligibility.reasonCodes),
    };
    return {
      recordId: record.recordId,
      sourcePath: record.sourcePath,
      outputPath: record.outputPath,
      mediaKind: record.mediaKind,
      extension: record.extension.toLowerCase(),
      ...(record.deviceFamily === undefined ? {} : { deviceFamily: record.deviceFamily }),
      confidence: record.resolution.confidence,
      resolutionStatus: record.resolution.status,
      resolutionPolicyVersion: record.resolution.policyVersion,
      ...eligibility,
      reasonCodes: sortedUnique(eligibility.reasonCodes),
      cohortKey: digest(cohortDimensions),
      policyDigest: this.policyDigest,
      transformDigest: this.transformDigest,
      ...(record.resolution.selectedValue === undefined
        ? {}
        : { selectedValue: { ...record.resolution.selectedValue } }),
      ...(record.resolution.selectedCandidateId === undefined
        ? {}
        : {
            selectedRawValue: record.resolution.candidates.find(
              (candidate) => candidate.id === record.resolution.selectedCandidateId
            )?.rawValue,
          }),
      sourceTagValues: Object.fromEntries(
        record.resolution.candidates.map((candidate) => [candidate.tag, candidate.rawValue])
      ),
    };
  }
}
