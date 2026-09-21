import { randomUUID } from 'crypto';

import { AuditSampler } from './AuditSampler';
import { CohortClassifier } from './CohortClassifier';
import { NormalizationEligibility } from './NormalizationEligibility';
import {
  AuditDecision,
  AuditInputRecord,
  AuditPage,
  AuditPageRequest,
  AuditSampleRequest,
  AuditSampleResult,
  NormalizationAuditPolicy,
} from '../../shared/types/audit';

export interface NormalizationAuditServiceDependencies {
  policy: Readonly<NormalizationAuditPolicy>;
  /** Returns records strictly after the supplied stable record ID for keyset paging. */
  source: (afterRecordId?: string) => AsyncIterable<AuditInputRecord>;
  currentRevision: () => Promise<string>;
}

interface AuditCursorState {
  revision: string;
  afterRecordId: string;
  policyDigest: string;
}

const MAX_CURSOR_STATES = 1_024;

export class NormalizationAuditService {
  private readonly eligibility: NormalizationEligibility;
  private readonly cohorts: CohortClassifier;
  private readonly sampler = new AuditSampler();
  private readonly cursors = new Map<string, AuditCursorState>();

  constructor(private readonly dependencies: NormalizationAuditServiceDependencies) {
    this.eligibility = new NormalizationEligibility(dependencies.policy);
    this.cohorts = new CohortClassifier(dependencies.policy);
  }

  private async *decisions(afterRecordId?: string): AsyncIterable<AuditDecision> {
    for await (const record of this.dependencies.source(afterRecordId)) {
      yield this.cohorts.classify(record, this.eligibility.classify(record));
    }
  }

  classify(record: Readonly<AuditInputRecord>): AuditDecision {
    return this.cohorts.classify(record, this.eligibility.classify(record));
  }

  private createCursor(state: AuditCursorState): string {
    const cursor = randomUUID();
    this.cursors.set(cursor, state);
    if (this.cursors.size > MAX_CURSOR_STATES) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (oldest !== undefined) this.cursors.delete(oldest);
    }
    return cursor;
  }

  async page(request: Readonly<AuditPageRequest>): Promise<AuditPage> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new RangeError('audit page limit must be between 1 and 100');
    }
    const revision = await this.dependencies.currentRevision();
    if (!revision) throw new Error('audit revision must be non-empty');
    const cursor = request.cursor === undefined ? undefined : this.cursors.get(request.cursor);
    if (request.cursor !== undefined && cursor === undefined) {
      throw new TypeError('audit cursor is invalid or expired');
    }
    if (cursor !== undefined && cursor.revision !== revision) {
      throw new Error('audit revision is stale; restart paging');
    }
    if (cursor !== undefined && cursor.policyDigest !== this.cohorts.policyDigest) {
      throw new Error('audit policy changed; restart paging');
    }
    const items: AuditDecision[] = [];
    let hasMore = false;
    for await (const decision of this.decisions(cursor?.afterRecordId)) {
      if (items.length === request.limit) {
        hasMore = true;
        break;
      }
      items.push(decision);
    }
    const endingRevision = await this.dependencies.currentRevision();
    if (endingRevision !== revision) throw new Error('audit revision changed during paging');
    return {
      revision,
      items,
      ...(hasMore && items.length > 0
        ? {
            nextCursor: this.createCursor({
              revision,
              afterRecordId: items[items.length - 1].recordId,
              policyDigest: this.cohorts.policyDigest,
            }),
          }
        : {}),
    };
  }

  async sample(request: Readonly<AuditSampleRequest>): Promise<AuditSampleResult> {
    const revision = await this.dependencies.currentRevision();
    if (!revision) throw new Error('audit revision must be non-empty');
    const items = await this.sampler.sample(this.decisions(), request);
    const endingRevision = await this.dependencies.currentRevision();
    if (endingRevision !== revision) throw new Error('audit revision changed during sampling');
    return { revision, items };
  }
}
