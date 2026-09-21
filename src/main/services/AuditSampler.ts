import { createHash } from 'crypto';

import { AuditDecision, AuditDisposition, AuditSampleRequest } from '../../shared/types/audit';

function score(seed: string, row: Readonly<AuditDecision>): string {
  return createHash('sha256').update(`${seed}\0${row.cohortKey}\0${row.recordId}`).digest('hex');
}

function riskRank(disposition: AuditDisposition): number {
  switch (disposition) {
    case AuditDisposition.MANUAL_REVIEW:
      return 0;
    case AuditDisposition.QUARANTINE_UNRESOLVED:
      return 1;
    case AuditDisposition.NORMALIZE_AFTER_COHORT_APPROVAL:
      return 2;
    case AuditDisposition.AUTO_NORMALIZE:
      return 3;
    case AuditDisposition.SKIP_UNSUPPORTED:
      return 4;
  }
}

interface RankedDecision {
  row: AuditDecision;
  rank: number;
  score: string;
}

function compare(left: RankedDecision, right: RankedDecision): number {
  return (
    left.rank - right.rank ||
    left.score.localeCompare(right.score) ||
    left.row.recordId.localeCompare(right.row.recordId)
  );
}

export class AuditSampler {
  async sample(
    source: Iterable<AuditDecision> | AsyncIterable<AuditDecision>,
    request: Readonly<AuditSampleRequest>
  ): Promise<AuditDecision[]> {
    if (
      !request.seed ||
      !Number.isSafeInteger(request.targetSize) ||
      request.targetSize < 1 ||
      request.targetSize > 100
    ) {
      throw new RangeError('sample seed is required and targetSize must be between 1 and 100');
    }
    const risky: RankedDecision[] = [];
    const general: RankedDecision[] = [];
    const cohortRepresentatives = new Map<string, RankedDecision>();
    const mandatoryRiskStrata = new Map<string, RankedDecision>();
    for await (const row of source) {
      const ranked = { row, rank: riskRank(row.disposition), score: score(request.seed, row) };
      general.push(ranked);
      general.sort(compare);
      if (general.length > request.targetSize) general.pop();

      if (ranked.rank < riskRank(AuditDisposition.AUTO_NORMALIZE)) {
        risky.push(ranked);
        risky.sort(compare);
        if (risky.length > request.targetSize) risky.pop();
        const stratumKey = `${row.disposition}:${[...row.reasonCodes].sort().join(',')}`;
        const stratumRepresentative = mandatoryRiskStrata.get(stratumKey);
        if (stratumRepresentative === undefined || compare(ranked, stratumRepresentative) < 0) {
          mandatoryRiskStrata.set(stratumKey, ranked);
        }
        if (mandatoryRiskStrata.size > request.targetSize) {
          throw new RangeError(
            'sample targetSize is too small to represent all mandatory risk strata'
          );
        }
      }

      const existing = cohortRepresentatives.get(row.cohortKey);
      if (existing === undefined || compare(ranked, existing) < 0) {
        cohortRepresentatives.set(row.cohortKey, ranked);
      }
      if (cohortRepresentatives.size > request.targetSize) {
        const worst = [...cohortRepresentatives.values()].sort(compare).pop();
        if (worst !== undefined) cohortRepresentatives.delete(worst.row.cohortKey);
      }
    }

    const selected = new Map<string, RankedDecision>();
    const addUntilFull = (entries: readonly RankedDecision[]): void => {
      for (const entry of entries) {
        if (selected.size === request.targetSize) break;
        selected.set(entry.row.recordId, entry);
      }
    };
    addUntilFull([...mandatoryRiskStrata.values()].sort(compare));
    addUntilFull([...cohortRepresentatives.values()].sort(compare));
    addUntilFull(risky.sort(compare));
    addUntilFull(general.sort(compare));
    return [...selected.values()].sort(compare).map(({ row }) => row);
  }
}
