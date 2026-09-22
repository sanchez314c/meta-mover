import {
  ReviewAction,
  ReviewApplyRequestDTO,
  ReviewDryRunRequestDTO,
  ReviewItemDTO,
  ReviewOverrideRecord,
  isReviewApplyRequestDTO,
  isReviewApplyResultDTO,
  isReviewDryRunDTO,
  isReviewDryRunRequestDTO,
  isReviewItemDTO,
  isReviewListRequestDTO,
  isReviewOverrideRecord,
  isReviewPageDTO,
} from '../../../src/shared/types/review';

const value = {
  localIso: '2020-01-02T03:04:05',
  zoneBasis: 'floating-local' as const,
  precision: 'second' as const,
};

const resolution = {
  policyVersion: 'date-resolution/1' as const,
  fileId: 'file-1',
  mediaKind: 'image' as const,
  target: 'capture-time' as const,
  evaluationTimeUtc: '2026-09-22T12:00:00.000Z',
  status: 'unresolved' as const,
  confidence: 'none' as const,
  contenderIds: [],
  rejected: [],
  reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
  candidates: [],
};

const output = {
  path: '/destination/Photos/_Needs Review/No Usable Date/photo.jpg',
  device: 42,
  inode: 84,
  size: 1024,
  modifiedTimeMs: 1_795_000_000_000,
  mtimeNs: '1795000000000000000',
  sha256: 'a'.repeat(64),
};

const evidence = { revision: 'evidence-1', resolution, collectedAt: '2026-09-22T12:00:00.000Z' };

const item: ReviewItemDTO = {
  reviewId: 'review-1',
  jobId: 'job-1',
  previewId: 'preview-1',
  rowIndex: 0,
  originalSourcePath: '/source/photo.jpg',
  currentPath: output.path,
  destinationRoot: '/destination',
  mediaKind: 'image',
  status: 'pending',
  reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
  warnings: ['Creation date requires review'],
  evidence,
  output,
  screenshotDetected: false,
  updatedAt: '2026-09-22T12:00:00.000Z',
};

describe('review queue shared contract', () => {
  it('accepts exact list, dry-run, and apply request shapes', () => {
    expect(isReviewListRequestDTO({ status: 'pending', limit: 100, cursor: 'next' })).toBe(true);
    expect(
      isReviewListRequestDTO({ statuses: ['pending', 'failed'], limit: 100, cursor: 'next' })
    ).toBe(true);
    expect(isReviewListRequestDTO({ status: 'pending', statuses: ['failed'], limit: 100 })).toBe(
      false
    );
    expect(isReviewListRequestDTO({ statuses: [], limit: 100 })).toBe(false);
    expect(isReviewListRequestDTO({ statuses: ['pending', 'pending'], limit: 100 })).toBe(false);
    const action: ReviewAction = { type: 'manual-date', value };
    const dryRun: ReviewDryRunRequestDTO = {
      reviewId: 'review-1',
      evidenceRevision: 'evidence-1',
      action,
    };
    const apply: ReviewApplyRequestDTO = { ...dryRun, planToken: 'plan-1' };
    expect(isReviewDryRunRequestDTO(dryRun)).toBe(true);
    expect(isReviewApplyRequestDTO(apply)).toBe(true);
    expect(JSON.parse(JSON.stringify(apply))).toEqual(apply);
  });

  it('accepts all action variants and rejects unknown or non-exact variants', () => {
    for (const action of [
      { type: 'select-candidate', candidateId: 'candidate-1' },
      { type: 'manual-date', value },
      { type: 'keep' },
      { type: 'retry-metadata' },
    ]) {
      expect(
        isReviewDryRunRequestDTO({ reviewId: 'review-1', evidenceRevision: 'rev-1', action })
      ).toBe(true);
    }
    expect(
      isReviewDryRunRequestDTO({
        reviewId: 'review-1',
        evidenceRevision: 'rev-1',
        action: { type: 'keep', extra: true },
      })
    ).toBe(false);
    expect(
      isReviewDryRunRequestDTO({
        reviewId: 'review-1',
        evidenceRevision: 'rev-1',
        action: { type: 'delete' },
      })
    ).toBe(false);
  });

  it('enforces exact keys, paging bounds, safe integers, hashes, and bounded strings', () => {
    expect(isReviewListRequestDTO({ limit: 0 })).toBe(false);
    expect(isReviewListRequestDTO({ limit: 101 })).toBe(false);
    expect(isReviewListRequestDTO({ limit: 10, extra: true })).toBe(false);
    expect(isReviewItemDTO({ ...item, rowIndex: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    expect(isReviewItemDTO({ ...item, output: { ...output, sha256: 'x'.repeat(64) } })).toBe(false);
    expect(isReviewItemDTO({ ...item, reviewId: 'x'.repeat(513) })).toBe(false);
    expect(isReviewItemDTO({ ...item, unexpected: true })).toBe(false);
  });

  it('validates the complete review item and rejects malformed nested evidence', () => {
    expect(isReviewItemDTO(item)).toBe(true);
    expect(isReviewPageDTO({ items: [item], nextCursor: 'next' })).toBe(true);
    expect(isReviewPageDTO({ items: [item], unexpected: true })).toBe(false);
    expect(
      isReviewItemDTO({
        ...item,
        evidence: {
          ...evidence,
          resolution: { ...resolution, policyVersion: 'date-resolution/2' },
        },
      })
    ).toBe(false);
    expect(isReviewItemDTO({ ...item, evidence: { ...evidence, collectedAt: 'not-a-date' } })).toBe(
      false
    );
    expect(isReviewItemDTO({ ...item, output: { ...output, mtimeNs: '-1' } })).toBe(false);
  });

  it('strictly validates dry-run and apply result payloads', () => {
    const action: ReviewAction = { type: 'keep' };
    expect(
      isReviewDryRunDTO({
        planToken: 'plan-1',
        action,
        currentPath: output.path,
        targetPath: null,
        collision: false,
        warnings: [],
      })
    ).toBe(true);
    expect(
      isReviewDryRunDTO({
        planToken: 'plan-1',
        action,
        currentPath: output.path,
        targetPath: null,
        collision: false,
        warnings: [],
        extra: true,
      })
    ).toBe(false);
    expect(
      isReviewApplyResultDTO({
        reviewId: 'review-1',
        status: 'resolved',
        currentPath: output.path,
        resolvedPath: '/destination/Photos/2020/photo.jpg',
        evidenceRevision: 'evidence-1',
      })
    ).toBe(true);
    expect(
      isReviewApplyResultDTO({
        reviewId: 'review-1',
        status: 'unknown',
        currentPath: output.path,
        evidenceRevision: 'evidence-1',
      })
    ).toBe(false);
  });

  it('validates every override result variant and rejects stale or ambiguous records', () => {
    const base = {
      schemaVersion: 1 as const,
      eventId: 'event-1',
      reviewId: 'review-1',
      sequence: 1,
      recordedAt: '2026-09-22T12:01:00.000Z',
      jobId: 'job-1',
      previewId: 'preview-1',
      rowIndex: 0,
      output,
      evidenceRevision: 'evidence-1',
      action: { type: 'keep' } as const,
    };
    const results: ReviewOverrideRecord['result'][] = [
      { status: 'kept', currentPath: output.path },
      {
        status: 'resolved',
        previousPath: output.path,
        resolvedPath: '/destination/Photos/2020/photo.jpg',
        transactionId: 'tx-1',
      },
      { status: 'pending', currentPath: output.path, refreshedEvidence: evidence },
      { status: 'failed', currentPath: output.path, error: 'metadata read failed' },
    ];
    for (const result of results) expect(isReviewOverrideRecord({ ...base, result })).toBe(true);
    expect(
      isReviewOverrideRecord({
        ...base,
        result: { status: 'kept', currentPath: output.path, error: 'impossible' },
      })
    ).toBe(false);
    expect(isReviewOverrideRecord({ ...base, schemaVersion: 2, result: results[0] })).toBe(false);
    expect(isReviewOverrideRecord({ ...base, sequence: -1, result: results[0] })).toBe(false);
  });
});
