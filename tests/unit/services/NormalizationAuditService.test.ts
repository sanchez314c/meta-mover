import { DateResolutionRecord, ScoredDateCandidate } from '../../../src/main/core/date';
import { AuditSampler } from '../../../src/main/services/AuditSampler';
import { CohortClassifier } from '../../../src/main/services/CohortClassifier';
import { NormalizationAuditService } from '../../../src/main/services/NormalizationAuditService';
import { NormalizationEligibility } from '../../../src/main/services/NormalizationEligibility';
import {
  AuditDisposition,
  AuditInputRecord,
  NormalizationAuditPolicy,
} from '../../../src/shared/types/audit';

const policy: NormalizationAuditPolicy = {
  policyVersion: 'normalization-audit/1',
  transformVersion: 'metadata-normalization/1',
  normalizedCreationTags: ['EXIF:CreateDate', 'EXIF:DateTimeOriginal'],
  protectedTemporalTags: ['EXIF:GPSDateStamp', 'QuickTime:TimeCode'],
};

function candidate(id: string, overrides: Partial<ScoredDateCandidate> = {}): ScoredDateCandidate {
  return {
    id,
    fileId: 'file-1',
    mediaKind: 'image',
    semantic: 'capture',
    sourceKind: 'embedded-exif',
    sourceFamily: 'EXIF',
    tag: 'EXIF:DateTimeOriginal',
    rawValue: '2020:01:02 03:04:05',
    value: {
      localIso: '2020-01-02T03:04:05',
      zoneBasis: 'floating-local',
      precision: 'second',
    },
    eligibility: 'eligible',
    score: { base: 95, modifiers: [], semanticCap: 100, final: 95 },
    resolutionIssues: [],
    ...overrides,
  };
}

function resolution(overrides: Partial<DateResolutionRecord> = {}): DateResolutionRecord {
  const selected = candidate('selected');
  return {
    policyVersion: 'date-resolution/1',
    fileId: 'file-1',
    mediaKind: 'image',
    target: 'capture-time',
    evaluationTimeUtc: '2026-09-08T00:00:00.000Z',
    status: 'resolved',
    confidence: 'high',
    selectedCandidateId: selected.id,
    selectedGroupId: 'group-1',
    selectedGroupScore: 98,
    selectedValue: { ...selected.value },
    contenderIds: [selected.id, 'corroborator'],
    rejected: [],
    reasonCodes: ['INDEPENDENT_CORROBORATION', 'RESOLVED_HIGH_CONFIDENCE'],
    candidates: [
      selected,
      candidate('corroborator', {
        sourceKind: 'embedded-xmp',
        sourceFamily: 'XMP',
        tag: 'XMP:DateCreated',
        score: { base: 88, modifiers: [], semanticCap: 100, final: 88 },
      }),
    ],
    ...overrides,
  };
}

function record(id: string, overrides: Partial<AuditInputRecord> = {}): AuditInputRecord {
  return {
    recordId: id,
    sourcePath: `/source/${id}.jpg`,
    outputPath: `/output/${id}.jpg`,
    mediaKind: 'image',
    extension: '.jpg',
    deviceFamily: 'camera-a',
    resolution: resolution(),
    ...overrides,
  };
}

describe('normalization audit core', () => {
  it('authorizes only corroborated, conflict-free high-confidence embedded originals', () => {
    const eligibility = new NormalizationEligibility(policy);
    expect(eligibility.classify(record('safe')).disposition).toBe(AuditDisposition.AUTO_NORMALIZE);

    const risky: Array<[AuditInputRecord, string]> = [
      [record('medium', { resolution: resolution({ confidence: 'medium' }) }), 'medium'],
      [
        record('filename', {
          resolution: resolution({
            candidates: [
              candidate('selected', { sourceKind: 'filename', semantic: 'filename-claim' }),
            ],
            contenderIds: ['selected'],
          }),
        }),
        'filename',
      ],
      [
        record('conflict', {
          resolution: resolution({ reasonCodes: ['STRONG_CONFLICT'] }),
        }),
        'conflict',
      ],
    ];

    for (const [input, expectedReason] of risky) {
      const decision = eligibility.classify(input);
      expect(decision.disposition).toBe(AuditDisposition.MANUAL_REVIEW);
      expect(decision.reasonCodes.join(' ').toLowerCase()).toContain(expectedReason);
    }
  });

  it.each([
    {
      name: 'ineligible selected candidate',
      resolution: resolution({
        candidates: [
          candidate('selected', { eligibility: 'invalid' }),
          candidate('corroborator', { sourceKind: 'embedded-xmp', sourceFamily: 'XMP' }),
        ],
      }),
    },
    {
      name: 'missing contender',
      resolution: resolution({ contenderIds: ['selected', 'missing'] }),
    },
    {
      name: 'same-family corroborator',
      resolution: resolution({
        candidates: [candidate('selected'), candidate('corroborator')],
      }),
    },
    {
      name: 'selected value mismatch',
      resolution: resolution({
        selectedValue: {
          localIso: '1999-01-01T00:00:00',
          zoneBasis: 'floating-local',
          precision: 'second',
        },
      }),
    },
  ])('fails closed instead of auto-normalizing $name', ({ resolution: unsafeResolution }) => {
    const result = new NormalizationEligibility(policy).classify(
      record('corrupt', { resolution: unsafeResolution })
    );
    expect(result.disposition).toBe(AuditDisposition.MANUAL_REVIEW);
    expect(result.reasonCodes).toContain('INCONSISTENT_RESOLUTION_REQUIRES_REVIEW');
  });

  it('quarantines unresolved rows, skips unsupported rows, and cohort-gates safe-looking rows without corroboration', () => {
    const eligibility = new NormalizationEligibility(policy);
    expect(
      eligibility.classify(
        record('unresolved', { resolution: resolution({ status: 'unresolved' }) })
      ).disposition
    ).toBe(AuditDisposition.QUARANTINE_UNRESOLVED);
    expect(eligibility.classify(record('unsupported', { supported: false })).disposition).toBe(
      AuditDisposition.SKIP_UNSUPPORTED
    );
    expect(
      eligibility.classify(
        record('cohort', {
          resolution: resolution({
            reasonCodes: ['RESOLVED_HIGH_CONFIDENCE'],
            contenderIds: ['selected'],
            candidates: [candidate('selected')],
          }),
        })
      ).disposition
    ).toBe(AuditDisposition.NORMALIZE_AFTER_COHORT_APPROVAL);
  });

  it('makes cohort keys deterministic and binds them to policy and transform digests', () => {
    const first = new CohortClassifier(policy);
    const reordered = new CohortClassifier({
      ...policy,
      normalizedCreationTags: [...policy.normalizedCreationTags].reverse(),
    });
    const changed = new CohortClassifier({
      ...policy,
      transformVersion: 'metadata-normalization/2',
    });
    const decision = new NormalizationEligibility(policy).classify(record('same'));

    expect(first.classify(record('same'), decision)).toEqual(
      reordered.classify(record('same'), decision)
    );
    expect(first.classify(record('same'), decision).cohortKey).not.toBe(
      changed.classify(record('same'), decision).cohortKey
    );
  });

  it('produces a reproducible stratified sample and always includes risky rows', async () => {
    const eligibility = new NormalizationEligibility(policy);
    const classifier = new CohortClassifier(policy);
    const rows = Array.from({ length: 30 }, (_, index) => record(`safe-${index}`));
    rows.push(record('medium', { resolution: resolution({ confidence: 'medium' }) }));
    rows.push(
      record('filename', {
        resolution: resolution({
          candidates: [
            candidate('selected', { sourceKind: 'filename', semantic: 'filename-claim' }),
          ],
          contenderIds: ['selected'],
        }),
      })
    );
    const decisions = rows.map((row) => classifier.classify(row, eligibility.classify(row)));

    const first = await new AuditSampler().sample(decisions, { seed: 'fixed', targetSize: 8 });
    const second = await new AuditSampler().sample(decisions, { seed: 'fixed', targetSize: 8 });

    expect(first.map((row) => row.recordId)).toEqual(second.map((row) => row.recordId));
    expect(first.map((row) => row.recordId)).toEqual(
      expect.arrayContaining(['medium', 'filename'])
    );
    expect(first).toHaveLength(8);
  });

  it('represents minority cohorts before adding duplicate controls from a dominant cohort', async () => {
    const eligibility = new NormalizationEligibility(policy);
    const classifier = new CohortClassifier(policy);
    const dominant = Array.from({ length: 100 }, (_, index) => record(`dominant-${index}`)).map(
      (row) => classifier.classify(row, eligibility.classify(row))
    );
    const minorityRow = record('minority', { extension: '.heic' });
    const minority = classifier.classify(minorityRow, eligibility.classify(minorityRow));

    const sample = await new AuditSampler().sample([...dominant, minority], {
      seed: 'cohort-coverage',
      targetSize: 2,
    });

    expect(new Set(sample.map((row) => row.cohortKey))).toEqual(
      new Set([dominant[0].cohortKey, minority.cohortKey])
    );
  });

  it('keeps distinct risky patterns represented when one review cohort dominates', async () => {
    const eligibility = new NormalizationEligibility(policy);
    const classifier = new CohortClassifier(policy);
    const medium = Array.from({ length: 100 }, (_, index) =>
      record(`medium-dominant-${index}`, { resolution: resolution({ confidence: 'medium' }) })
    ).map((row) => classifier.classify(row, eligibility.classify(row)));
    const filenameRow = record('filename-minority', {
      resolution: resolution({
        candidates: [candidate('selected', { sourceKind: 'filename', semantic: 'filename-claim' })],
        contenderIds: ['selected'],
      }),
    });
    const filename = classifier.classify(filenameRow, eligibility.classify(filenameRow));

    const sample = await new AuditSampler().sample([...medium, filename], {
      seed: 'risk-strata',
      targetSize: 2,
    });

    expect(new Set(sample.map((row) => row.cohortKey))).toEqual(
      new Set([medium[0].cohortKey, filename.cohortKey])
    );
  });

  it('rejects a sample too small to represent every mandatory risk stratum', async () => {
    const eligibility = new NormalizationEligibility(policy);
    const classifier = new CohortClassifier(policy);
    const risky = [
      record('medium-risk', { resolution: resolution({ confidence: 'medium' }) }),
      record('unresolved-risk', { resolution: resolution({ status: 'unresolved' }) }),
      record('cohort-risk', {
        resolution: resolution({
          reasonCodes: ['RESOLVED_HIGH_CONFIDENCE'],
          contenderIds: ['selected'],
          candidates: [candidate('selected')],
        }),
      }),
    ].map((row) => classifier.classify(row, eligibility.classify(row)));

    await expect(
      new AuditSampler().sample(risky, { seed: 'undersized', targetSize: 2 })
    ).rejects.toThrow(/mandatory risk strata/i);
  });
});

describe('NormalizationAuditService', () => {
  function source(rows: readonly AuditInputRecord[]) {
    return async function* (afterRecordId?: string): AsyncIterable<AuditInputRecord> {
      const start =
        afterRecordId === undefined
          ? 0
          : rows.findIndex((row) => row.recordId === afterRecordId) + 1;
      for (let index = start; index < rows.length; index += 1) {
        yield rows[index];
      }
    };
  }

  it('streams bounded cursor pages and rejects cursors after a revision change', async () => {
    let revision = 'revision-1';
    const rows = Array.from({ length: 235 }, (_, index) =>
      record(`file-${index.toString().padStart(3, '0')}`)
    );
    const service = new NormalizationAuditService({
      policy,
      source: source(rows),
      currentRevision: async () => revision,
    });

    const first = await service.page({ limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeDefined();
    const second = await service.page({ limit: 100, cursor: first.nextCursor });
    expect(second.items).toHaveLength(100);
    expect(new Set([...first.items, ...second.items].map((item) => item.recordId)).size).toBe(200);

    revision = 'revision-2';
    await expect(service.page({ limit: 100, cursor: first.nextCursor })).rejects.toThrow(
      /revision.*stale/i
    );
    await expect(service.page({ limit: 100, cursor: 'forged-cursor' })).rejects.toThrow(/invalid/i);
  });

  it('caps pages at 100 and consumes only enough of the async source for the requested page', async () => {
    let yielded = 0;
    const service = new NormalizationAuditService({
      policy,
      source: async function* (afterRecordId?: string) {
        const start = afterRecordId === undefined ? 0 : Number(afterRecordId.split('-').at(-1)) + 1;
        for (let index = start; index < 1_000_000; index += 1) {
          yielded += 1;
          yield record(`large-${index.toString().padStart(7, '0')}`);
        }
      },
      currentRevision: async () => 'large-revision',
    });

    await expect(service.page({ limit: 101 })).rejects.toThrow(/100/);
    const page = await service.page({ limit: 25 });
    expect(page.items).toHaveLength(25);
    expect(yielded).toBeLessThanOrEqual(26);
    yielded = 0;
    const next = await service.page({ limit: 25, cursor: page.nextCursor });
    expect(next.items[0].recordId).toBe('large-0000025');
    expect(yielded).toBeLessThanOrEqual(26);
  });

  it('returns a bounded deterministic sample without materializing the entire source', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => record(`sample-${index}`));
    const service = new NormalizationAuditService({
      policy,
      source: source(rows),
      currentRevision: async () => 'sample-revision',
    });

    const first = await service.sample({ seed: 'audit-seed', targetSize: 20 });
    const second = await service.sample({ seed: 'audit-seed', targetSize: 20 });
    expect(first.revision).toBe('sample-revision');
    expect(first.items).toHaveLength(20);
    expect(first.items.map((item) => item.recordId)).toEqual(
      second.items.map((item) => item.recordId)
    );
  });
});
