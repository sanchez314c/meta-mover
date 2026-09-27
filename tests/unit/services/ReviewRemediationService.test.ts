import { createHash } from 'crypto';
import { mkdtemp, readFile, realpath, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { resolveDateCandidates } from '../../../src/main/core/date';
import type { DateResolutionRecord, ParsedDateValue } from '../../../src/main/core/date';
import { MediaPlanner } from '../../../src/main/core/planning/MediaPlanner';
import { ReviewRemediationService } from '../../../src/main/services/ReviewRemediationService';
import { ReviewOverrideStore } from '../../../src/main/services/ReviewOverrideStore';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  ProcessingEventKind,
} from '../../../src/shared/types/processing';
import {
  isReviewOverrideRecord,
  type ReviewOutputBinding,
  type ReviewOverrideRecord,
} from '../../../src/shared/types/review';

const candidateValue: ParsedDateValue = {
  localIso: '2024-05-06T07:08:09',
  zoneBasis: 'floating-local',
  precision: 'second',
};

function unresolved(fileId = 'record-0'): DateResolutionRecord {
  return resolveDateCandidates({
    fileId,
    mediaKind: 'image',
    evaluationTimeUtc: '2026-09-22T00:00:00.000Z',
    candidates: [
      {
        id: 'weak',
        fileId,
        mediaKind: 'image',
        semantic: 'filename-claim',
        sourceKind: 'filename',
        sourceFamily: 'filename-date-only',
        tag: 'filename:weak.jpg',
        rawValue: '2024-05-06',
        value: { localIso: '2024-05-06', zoneBasis: 'date-only', precision: 'date' },
      },
    ],
  });
}

function selectable(fileId = 'record-0'): DateResolutionRecord {
  return {
    ...unresolved(fileId),
    status: 'review-required',
    confidence: 'low',
    selectedCandidateId: undefined,
    selectedGroupId: undefined,
    selectedGroupScore: undefined,
    selectedValue: undefined,
    reasonCodes: ['REVIEW_REQUIRED_LOW_CONFIDENCE'],
    candidates: [
      {
        id: 'candidate-1',
        fileId,
        mediaKind: 'image',
        semantic: 'capture',
        sourceKind: 'embedded-exif',
        sourceFamily: 'exif',
        tag: 'ExifIFD:DateTimeOriginal',
        rawValue: '2024:05:06 07:08:09',
        value: candidateValue,
        eligibility: 'eligible',
        score: { base: 100, modifiers: [], semanticCap: 100, final: 100 },
        resolutionIssues: [],
      },
    ],
  };
}

class Overrides {
  records: ReviewOverrideRecord[] = [];
  async list() {
    return this.records.slice();
  }
  async get(id: string) {
    return this.records.filter((r) => r.reviewId === id).at(-1) ?? null;
  }
  async append(record: ReviewOverrideRecord) {
    this.records.push(record);
    return record;
  }
}

async function fixture(
  options: {
    terminal?: 'completed' | 'partial' | 'cancelled';
    resolution?: DateResolutionRecord;
    conflictPolicy?: ConflictPolicy;
    outputBinding?: (filePath: string) => Promise<ReviewOutputBinding>;
    planner?: MediaPlanner;
  } = {}
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-service-'));
  const destination = path.join(root, 'output');
  const currentPath = path.join(
    destination,
    'Photos',
    '_Needs Review',
    'No Usable Date',
    'photo.jpg'
  );
  await import('fs/promises').then((fs) =>
    fs.mkdir(path.dirname(currentPath), { recursive: true })
  );
  await writeFile(currentPath, 'original bytes');
  const sourcePath = path.join(root, 'source', 'photo.jpg');
  const row = {
    sourcePath,
    targetPath: currentPath,
    operation: OperationMode.MOVE,
    conflictPolicy: options.conflictPolicy ?? ConflictPolicy.RENAME,
    dateEvidence: { value: null, source: 'none', confidence: 0, warnings: [] },
    fingerprint: { size: 14, modifiedAt: '2026-09-22T00:00:00.000Z' },
    warnings: [],
  } as const;
  const terminal = options.terminal ?? 'completed';
  const event =
    terminal === 'completed'
      ? {
          kind: ProcessingEventKind.JOB_COMPLETED,
          payload: {
            statistics: {
              totalFiles: 1,
              processedFiles: 1,
              skippedFiles: 0,
              failedFiles: 0,
              totalBytes: 14,
              processedBytes: 14,
              durationMs: 1,
            },
          },
        }
      : terminal === 'partial'
        ? {
            kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
            payload: {
              statistics: {
                totalFiles: 2,
                processedFiles: 1,
                skippedFiles: 0,
                failedFiles: 1,
                totalBytes: 28,
                processedBytes: 14,
                durationMs: 1,
              },
              fileFailures: [{ sourcePath, error: 'failed' }],
              fileOutcomes: [
                {
                  sourcePath,
                  destinationPath: currentPath,
                  state: 'failed',
                  plannedBytes: 14,
                  committedBytes: 0,
                  sourceRetained: true,
                  error: 'failed',
                },
              ],
            },
          }
        : {
            kind: ProcessingEventKind.JOB_CANCELLED,
            payload: {
              filesProcessed: 1,
              statistics: {
                totalFiles: 1,
                processedFiles: 1,
                skippedFiles: 0,
                failedFiles: 0,
                cancelledFiles: 0,
                unattemptedFiles: 0,
                totalBytes: 14,
                processedBytes: 14,
                committedResidueBytes: 0,
                durationMs: 1,
              },
              fileFailures: [],
              fileOutcomes: [
                {
                  sourcePath,
                  destinationPath: currentPath,
                  state: 'completed',
                  plannedBytes: 14,
                  committedBytes: 14,
                  sourceRetained: false,
                },
              ],
            },
          };
  const history = {
    listJobs: async () => [
      {
        jobId: '11111111-1111-4111-8111-111111111111',
        previewId: 'preview-1',
        createdAt: '2026-09-22T00:00:00.000Z',
        sourcePaths: [path.dirname(sourcePath)],
        destinationPath: destination,
        effectiveOptions: {
          operation: OperationMode.MOVE,
          conflictPolicy: options.conflictPolicy ?? ConflictPolicy.RENAME,
          folderStructure: FolderStructure.YEAR_MONTH,
          appendScreenshotSuffix: false,
          workerCount: 1,
          verifyIntegrity: true,
          writeMetadataDates: false,
        },
        previewSummary: {
          totalFiles: 1,
          copyFiles: 0,
          moveFiles: 1,
          skippedFiles: 0,
          renamedFiles: 0,
          overwrittenFiles: 0,
          unresolvedDates: 1,
          totalBytes: 14,
        },
        previewRows: [row],
        status: 'completed',
        lastSequence: 4,
        terminalEventKind: event.kind,
        events: [
          {
            ...event,
            jobId: '11111111-1111-4111-8111-111111111111',
            sequence: 4,
            emittedAt: '2026-09-22T00:00:01.000Z',
          },
        ],
      },
    ],
  };
  const auditResolution = options.resolution ?? selectable();
  const reviewRecord = {
    revision: 'audit-rev-1',
    input: {
      recordId: 'record-0',
      sourcePath,
      outputPath: currentPath,
      mediaKind: 'image' as const,
      resolution: auditResolution,
    },
  };
  const audit = {
    reviewPage: jest.fn(async () => ({
      revision: reviewRecord.revision,
      items: [reviewRecord.input],
    })),
    reviewInput: jest.fn(async ({ outputPath }: { outputPath: string }) =>
      outputPath === currentPath
        ? {
            revision: 'audit-rev-1',
            input: {
              recordId: 'record-0',
              sourcePath,
              outputPath: currentPath,
              mediaKind: 'image',
              extension: '.jpg',
              resolution: auditResolution,
            },
          }
        : null
    ),
  };
  const overrides = new Overrides();
  const execute = jest.fn(async (request: any) => {
    await import('fs/promises').then((fs) =>
      fs.mkdir(path.dirname(request.expectedDestinationPath), { recursive: true })
    );
    await import('fs/promises').then((fs) =>
      fs.rename(request.sourcePath, request.expectedDestinationPath)
    );
    return {
      operationId: request.operationId,
      sourcePath: request.sourcePath,
      destinationPath: request.expectedDestinationPath,
      status: 'moved',
      committed: true,
      sourceRetained: false,
      hash: createHash('sha256').update('original bytes').digest('hex'),
      bytes: 14,
    };
  });
  const core = { execute, close: jest.fn(async () => undefined) };
  const coreFactory = jest.fn(async () => core);
  const service = new ReviewRemediationService({
    history,
    audit,
    overrides,
    coreFactory,
    now: () => new Date('2026-09-22T00:00:02.000Z'),
    ...(options.outputBinding ? { outputBinding: options.outputBinding } : {}),
    ...(options.planner ? { planner: options.planner } : {}),
  });
  return {
    service,
    root,
    currentPath,
    sourcePath,
    destination,
    overrides,
    execute,
    core,
    coreFactory,
    audit,
    history,
  };
}

describe('ReviewRemediationService', () => {
  it('preflights six AI candidates with one bound history and output read, excluding midnight', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      ...selectable().candidates[0],
      id: `candidate-${index}`,
      value:
        index === 5
          ? { ...candidateValue, localIso: '2024-05-06T00:00:00' }
          : {
              ...candidateValue,
              localIso: `2024-05-06T07:08:${String(index + 10).padStart(2, '0')}`,
            },
    }));
    const outputBinding = jest.fn(async (filePath: string): Promise<ReviewOutputBinding> => {
      const info = await stat(filePath, { bigint: true });
      return {
        path: filePath,
        device: Number(info.dev),
        inode: Number(info.ino),
        size: Number(info.size),
        modifiedTimeMs: Number(info.mtimeNs) / 1_000_000,
        mtimeNs: info.mtimeNs.toString(),
        sha256: createHash('sha256').update('original bytes').digest('hex'),
      };
    });
    const value = await fixture({
      resolution: { ...selectable(), candidates },
      outputBinding,
    });
    const item = (await value.service.list({ limit: 10 })).items[0];
    outputBinding.mockClear();
    const history = jest.spyOn(value.history, 'listJobs');
    const result = await value.service.preflightAIEstimateCandidates({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      candidates: candidates.map((candidate) => ({
        candidateId: candidate.id,
        value: candidate.value,
      })),
    });
    expect(result).toEqual(candidates.slice(0, 5).map((candidate) => candidate.id));
    expect(history).toHaveBeenCalledTimes(1);
    expect(outputBinding).toHaveBeenCalledTimes(1);
    expect(value.audit.reviewInput).toHaveBeenCalledTimes(1);
  });

  it('stops AI preflight between candidates when cancelled', async () => {
    const controller = new AbortController();
    class AbortingPlanner extends MediaPlanner {
      override planForExecution(request: Parameters<MediaPlanner['planForExecution']>[0]) {
        controller.abort();
        return super.planForExecution(request);
      }
    }
    const candidates = Array.from({ length: 2 }, (_, index) => ({
      ...selectable().candidates[0],
      id: `candidate-${index}`,
    }));
    const value = await fixture({
      resolution: { ...selectable(), candidates },
      planner: new AbortingPlanner(),
    });
    const item = (await value.service.list({ limit: 10 })).items[0];
    await expect(
      value.service.preflightAIEstimateCandidates({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        candidates: candidates.map((candidate) => ({
          candidateId: candidate.id,
          value: candidate.value,
        })),
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('excludes occupied targets under SKIP without moving the review file', async () => {
    const value = await fixture({ conflictPolicy: ConflictPolicy.SKIP });
    const item = (await value.service.list({ limit: 10 })).items[0];
    const target = path.join(value.destination, 'Photos', '2024', '05', '2024-05-06_07-08-09.jpg');
    await import('fs/promises').then((fs) => fs.mkdir(path.dirname(target), { recursive: true }));
    await writeFile(target, 'occupied');
    const accepted = await value.service.preflightAIEstimateCandidates({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      candidates: [{ candidateId: 'candidate-1', value: candidateValue }],
    });
    expect(accepted).toEqual([]);
    expect(value.execute).not.toHaveBeenCalled();
    await expect(readFile(item.currentPath, 'utf8')).resolves.toBe('original bytes');
  });
  it('reuses one transaction core through a batch lease and closes it after completion', async () => {
    const value = await fixture();
    const item = (await value.service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision, action };
    const plan = await value.service.dryRun(request);
    value.execute.mockResolvedValueOnce({
      operationId: 'failed',
      status: 'failed',
      committed: false,
      sourceRetained: true,
      error: 'precommit',
    });
    await value.service.withTransactionSession(async () => {
      expect((await value.service.apply({ ...request, planToken: plan.planToken })).status).toBe(
        'failed'
      );
      expect(value.core.close).not.toHaveBeenCalled();
      expect((await value.service.apply({ ...request, planToken: plan.planToken })).status).toBe(
        'resolved'
      );
      expect(value.core.close).not.toHaveBeenCalled();
    });
    expect(value.coreFactory).toHaveBeenCalledTimes(1);
    expect(value.core.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a manual apply from outside an active batch lease before journal mutation', async () => {
    const value = await fixture();
    const item = (await value.service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision, action };
    const plan = await value.service.dryRun(request);
    let trigger!: () => void;
    const gate = new Promise<void>((resolve) => {
      trigger = resolve;
    });
    const external = gate.then(() =>
      value.service.apply({ ...request, planToken: plan.planToken })
    );
    await value.service.withTransactionSession(async () => {
      trigger();
      await expect(external).rejects.toThrow('busy');
      expect(value.overrides.records).toHaveLength(0);
      expect(value.coreFactory).not.toHaveBeenCalled();
    });
  });

  it('closes the leased core when a batch aborts and closes ordinary apply after one move', async () => {
    const value = await fixture();
    const item = (await value.service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision, action };
    const plan = await value.service.dryRun(request);
    value.execute.mockResolvedValueOnce({
      operationId: 'failed',
      status: 'failed',
      committed: false,
      sourceRetained: true,
      error: 'precommit',
    });
    await expect(
      value.service.withTransactionSession(async () => {
        await value.service.apply({ ...request, planToken: plan.planToken });
        throw new Error('batch aborted');
      })
    ).rejects.toThrow('batch aborted');
    expect(value.core.close).toHaveBeenCalledTimes(1);
    await value.service.apply({ ...request, planToken: plan.planToken });
    expect(value.coreFactory).toHaveBeenCalledTimes(2);
    expect(value.core.close).toHaveBeenCalledTimes(2);
  });

  it('waits for an in-flight move before closing a cancelled batch core', async () => {
    const value = await fixture();
    const item = (await value.service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision, action };
    const plan = await value.service.dryRun(request);
    const normalExecute = value.execute.getMockImplementation()!;
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    value.execute.mockImplementationOnce(async (operation) => {
      entered();
      await gate;
      return normalExecute(operation);
    });
    let move!: Promise<unknown>;
    const session = value.service.withTransactionSession(async () => {
      move = value.service.apply({ ...request, planToken: plan.planToken });
      await started;
      throw new Error('cancelled batch');
    });
    await started;
    expect(value.core.close).not.toHaveBeenCalled();
    const cancellation = expect(session).rejects.toThrow('cancelled batch');
    finish();
    await move;
    await cancellation;
    expect(value.core.close).toHaveBeenCalledTimes(1);
  });
  it('persists service review IDs through the real override store for automatic retry and keep', async () => {
    const automatic = await fixture({
      resolution: { ...selectable(), status: 'unresolved', confidence: 'none', candidates: [] },
    });
    const automaticStore = await ReviewOverrideStore.open(
      path.join(automatic.root, 'private', 'overrides.jsonl')
    );
    try {
      const service = new ReviewRemediationService({
        history: automatic.history,
        audit: automatic.audit,
        overrides: automaticStore,
        coreFactory: async () => ({ execute: automatic.execute, close: async () => undefined }),
        metadataCollector: {
          collectDetailed: async () => ({
            candidates: [
              {
                id: 'fresh-capture',
                fileId: 'record-0',
                mediaKind: 'image',
                semantic: 'capture',
                sourceKind: 'embedded-exif',
                sourceFamily: 'exif',
                tag: 'ExifIFD:DateTimeOriginal',
                rawValue: '2024:05:06 07:08:09',
                value: candidateValue,
              },
            ],
            warnings: [],
          }),
        },
        now: () => new Date('2026-09-22T00:00:02.000Z'),
      });
      const item = (await service.list({ limit: 10 })).items[0];
      const plan = await service.automaticRetryDryRun({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
      });
      const result = await service.automaticRetryApply({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        planToken: plan.planToken,
      });
      expect(result.status).toBe('resolved');
      expect((await automaticStore.get(item.reviewId))?.result.status).toBe('resolved');
    } finally {
      await automaticStore.close();
    }
    const kept = await fixture();
    const keepStore = await ReviewOverrideStore.open(
      path.join(kept.root, 'private', 'overrides.jsonl')
    );
    try {
      const service = new ReviewRemediationService({
        history: kept.history,
        audit: kept.audit,
        overrides: keepStore,
        coreFactory: async () => ({ execute: kept.execute, close: async () => undefined }),
        now: () => new Date('2026-09-22T00:00:02.000Z'),
      });
      const item = (await service.list({ limit: 10 })).items[0];
      const action = { type: 'keep' as const };
      const plan = await service.dryRun({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action,
      });
      const result = await service.apply({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action,
        planToken: plan.planToken,
      });
      expect(result.status).toBe('kept');
      expect((await keepStore.get(item.reviewId))?.result.status).toBe('kept');
    } finally {
      await keepStore.close();
    }
  });
  it('automatically retries metadata and moves only a newly resolved result with audit evidence', async () => {
    const value = await fixture({
      resolution: { ...selectable(), status: 'unresolved', confidence: 'none', candidates: [] },
    });
    const item = (await value.service.list({ limit: 10 })).items[0];
    const metadataCollector = {
      collectDetailed: jest.fn(async () => ({
        candidates: [
          {
            id: 'fresh-capture',
            fileId: 'record-0',
            mediaKind: 'image' as const,
            semantic: 'capture' as const,
            sourceKind: 'embedded-exif' as const,
            sourceFamily: 'exif',
            tag: 'ExifIFD:DateTimeOriginal',
            rawValue: '2024:05:06 07:08:09',
            value: candidateValue,
          },
        ],
        warnings: [],
      })),
    };
    const service = value.service.withMetadataCollector(metadataCollector);
    const occupied = path.join(
      value.destination,
      'Photos',
      '2024',
      '05',
      '2024-05-06_07-08-09.jpg'
    );
    await import('fs/promises').then((fs) => fs.mkdir(path.dirname(occupied), { recursive: true }));
    await writeFile(occupied, 'other image');
    const plan = await service.automaticRetryDryRun({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
    });
    expect(plan.targetPath).toBe(occupied.replace(/\.jpg$/, '_01.jpg'));
    expect(plan.collision).toBe(false);
    expect(plan.refreshedEvidence?.resolution.status).toBe('resolved');
    expect(value.execute).not.toHaveBeenCalled();
    const result = await service.automaticRetryApply({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      planToken: plan.planToken,
    });
    expect(result.status).toBe('resolved');
    expect(result.evidenceRevision).toBe(plan.refreshedEvidence?.revision);
    await expect(readFile(occupied, 'utf8')).resolves.toBe('other image');
    expect(value.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        collisionMode: 'exact-no-clobber',
        expectedSha256: item.output.sha256,
      })
    );
    expect(value.overrides.records).toHaveLength(2);
    expect(
      value.overrides.records.every((record) => record.action.type === 'automatic-retry')
    ).toBe(true);
    expect(value.overrides.records.at(-1)?.result).toMatchObject({
      status: 'resolved',
      refreshedEvidence: { revision: plan.refreshedEvidence?.revision },
    });
    expect(value.overrides.records.every(isReviewOverrideRecord)).toBe(true);
    const reopened = new ReviewRemediationService({
      history: value.history,
      audit: value.audit,
      overrides: value.overrides,
      coreFactory: async () => {
        throw new Error('reopen must not move again');
      },
      now: () => new Date('2026-09-22T00:00:03.000Z'),
    });
    const reopenedItem = await reopened.get(item.reviewId);
    expect(reopenedItem?.status).toBe('resolved');
    expect(reopenedItem?.evidence.revision).toBe(plan.refreshedEvidence?.revision);
    expect(reopenedItem?.evidence.resolution.selectedValue).toEqual(candidateValue);
  });

  it('keeps unresolved automatic retries pending and records refreshed evidence without moving', async () => {
    const value = await fixture();
    const item = (await value.service.list({ limit: 10 })).items[0];
    const service = value.service.withMetadataCollector({
      collectDetailed: jest.fn(async () => ({ candidates: [], warnings: [] })),
    });
    const plan = await service.automaticRetryDryRun({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
    });
    expect(plan.targetPath).toBeNull();
    const result = await service.automaticRetryApply({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      planToken: plan.planToken,
    });
    expect(result.status).toBe('pending');
    expect(result.evidenceRevision).toBe(plan.refreshedEvidence?.revision);
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.overrides.records).toHaveLength(1);
    expect(value.overrides.records[0].action.type).toBe('automatic-retry');
    expect(value.overrides.records[0].result.status).toBe('pending');
  });

  it('reconciles an interrupted automatic retry with its refreshed resolution intact', async () => {
    const value = await fixture({
      resolution: { ...selectable(), status: 'unresolved', confidence: 'none', candidates: [] },
    });
    const item = (await value.service.list({ limit: 10 })).items[0];
    const service = value.service.withMetadataCollector({
      collectDetailed: jest.fn(async () => ({
        candidates: [
          {
            id: 'fresh-capture',
            fileId: 'record-0',
            mediaKind: 'image' as const,
            semantic: 'capture' as const,
            sourceKind: 'embedded-exif' as const,
            sourceFamily: 'exif',
            tag: 'ExifIFD:DateTimeOriginal',
            rawValue: '2024:05:06 07:08:09',
            value: candidateValue,
          },
        ],
        warnings: [],
      })),
    });
    const plan = await service.automaticRetryDryRun({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
    });
    const originalAppend = value.overrides.append.bind(value.overrides);
    let calls = 0;
    jest.spyOn(value.overrides, 'append').mockImplementation(async (record) => {
      calls += 1;
      if (calls === 2) throw new Error('disk full');
      return originalAppend(record);
    });
    await expect(
      service.automaticRetryApply({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        planToken: plan.planToken,
      })
    ).rejects.toThrow('transaction committed');
    expect(value.overrides.records[0].result).toMatchObject({
      status: 'reconciling',
      refreshedEvidence: { revision: plan.refreshedEvidence?.revision },
    });
    jest.restoreAllMocks();
    const reopened = new ReviewRemediationService({
      history: value.history,
      audit: value.audit,
      overrides: value.overrides,
      coreFactory: async () => {
        throw new Error('recovery must not move again');
      },
      now: () => new Date('2026-09-22T00:00:03.000Z'),
    });
    const recovered = await reopened.get(item.reviewId);
    expect(recovered?.status).toBe('resolved');
    expect(recovered?.evidence.revision).toBe(plan.refreshedEvidence?.revision);
    expect(recovered?.evidence.resolution.selectedValue).toEqual(candidateValue);
  });
  it('binds an AI estimate to evidence and file hash and records distinct provenance through apply', async () => {
    const { service, currentPath, execute, overrides } = await fixture();
    const item = (await service.list({ limit: 10 })).items[0];
    const action = {
      type: 'ai-estimate' as const,
      candidateId: 'candidate-1',
      value: candidateValue,
      provenance: {
        model: 'glm-5.3',
        promptVersion: 'review-v1',
        evidenceRevision: item.evidence.revision,
        fileSha256: item.output.sha256,
        rationale: 'Embedded capture date has the strongest support.',
      },
    };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision, action };
    await expect(
      service.dryRun({
        ...request,
        action: { ...action, provenance: { ...action.provenance, fileSha256: '0'.repeat(64) } },
      })
    ).rejects.toThrow('file hash');
    await expect(
      service.dryRun({
        ...request,
        action: { ...action, provenance: { ...action.provenance, evidenceRevision: 'stale' } },
      })
    ).rejects.toThrow('evidence revision');
    await expect(
      service.dryRun({ ...request, action: { ...action, candidateId: 'missing' } })
    ).rejects.toThrow('candidate');
    await expect(
      service.dryRun({
        ...request,
        action: { ...action, provenance: { ...action.provenance, apiKey: 'secret' } } as any,
      })
    ).rejects.toThrow('invalid');
    await expect(
      service.dryRun({ ...request, action: { ...action, candidateId: undefined } as any })
    ).rejects.toThrow('invalid');
    await expect(
      service.dryRun({
        ...request,
        action: { ...action, value: { ...candidateValue, localIso: '2023-05-06T07:08:09' } },
      })
    ).rejects.toThrow('candidate');
    expect(execute).not.toHaveBeenCalled();
    const plan = await service.dryRun(request);
    expect(plan.targetPath).toContain('2024-05-06_07-08-09.jpg');
    const result = await service.apply({ ...request, planToken: plan.planToken });
    expect(result.status).toBe('resolved');
    expect(overrides.records).toHaveLength(2);
    expect(overrides.records.at(-1)?.action).toEqual(action);
    expect(overrides.records.at(-1)?.action.type).toBe('ai-estimate');
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: currentPath, collisionMode: 'exact-no-clobber' })
    );
  });

  it('rejects an AI estimate without an eligible stored date candidate', async () => {
    const { service } = await fixture({
      resolution: { ...selectable(), status: 'unresolved', confidence: 'none', candidates: [] },
    });
    const item = (await service.list({ limit: 10 })).items[0];
    const provenance = {
      model: 'glm-5.3',
      promptVersion: 'review-v1',
      evidenceRevision: item.evidence.revision,
      fileSha256: item.output.sha256,
      rationale: 'The image content indicates this calendar date.',
    };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision };
    await expect(
      service.dryRun({
        ...request,
        action: {
          type: 'ai-estimate',
          candidateId: 'missing',
          value: { localIso: '2024-05-06', zoneBasis: 'date-only', precision: 'date' },
          provenance,
        },
      })
    ).rejects.toThrow('candidate');
  });
  it('pages 7,391 descriptors before binding at most the returned 25 and exact get binds one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'meta-mover-review-bounded-'));
    try {
      const destination = await realpath(root);
      const resolution = selectable();
      const rows = Array.from({ length: 7_391 }, (_, index) => ({
        sourcePath: path.join(destination, 'source', `${index}.jpg`),
        targetPath: path.join(destination, 'Photos', '_Needs Review', `${index}.jpg`),
        operation: OperationMode.MOVE,
        conflictPolicy: ConflictPolicy.RENAME,
        dateEvidence: { value: null, source: 'none' as const, confidence: 0, warnings: [] },
        fingerprint: { size: 14, modifiedAt: '2026-09-22T00:00:00.000Z' },
        warnings: [],
      }));
      const inputs = rows.map((row, index) => ({
        recordId: `row-${String(index).padStart(16, '0')}`,
        sourcePath: row.sourcePath,
        outputPath: row.targetPath,
        mediaKind: 'image' as const,
        resolution,
      }));
      const history = {
        listJobs: jest.fn(async () => [
          {
            jobId: '33333333-3333-4333-8333-333333333333',
            previewId: 'preview-scale',
            destinationPath: destination,
            effectiveOptions: {
              operation: OperationMode.MOVE,
              conflictPolicy: ConflictPolicy.RENAME,
              folderStructure: FolderStructure.YEAR_MONTH,
              appendScreenshotSuffix: false,
            },
            previewRows: rows,
            events: [
              {
                kind: ProcessingEventKind.JOB_COMPLETED,
                jobId: '33333333-3333-4333-8333-333333333333',
                sequence: 2,
                emittedAt: '2026-09-22T00:00:01.000Z',
                payload: {
                  statistics: {
                    totalFiles: rows.length,
                    processedFiles: rows.length,
                    skippedFiles: 0,
                    failedFiles: 0,
                    totalBytes: rows.length * 14,
                    processedBytes: rows.length * 14,
                    durationMs: 1,
                  },
                },
              },
            ],
          },
        ]),
      };
      const audit = {
        reviewPage: jest.fn(async ({ cursor, limit }: { cursor?: string; limit: number }) => {
          const offset = Number(cursor ?? 0);
          const items = inputs.slice(offset, offset + limit);
          const next = offset + items.length;
          return {
            revision: 'scale-revision',
            items,
            ...(next < inputs.length ? { nextCursor: String(next) } : {}),
          };
        }),
        reviewInput: jest.fn(
          async ({ sourcePath, outputPath }: { sourcePath: string; outputPath: string }) => {
            const input = inputs.find(
              (entry) => entry.sourcePath === sourcePath && entry.outputPath === outputPath
            );
            return input ? { revision: 'scale-revision', input } : null;
          }
        ),
      };
      const outputBinding = jest.fn(async (filePath: string) => ({
        path: filePath,
        device: 1,
        inode: Number(path.basename(filePath, '.jpg')) + 1,
        size: 14,
        modifiedTimeMs: 1,
        mtimeNs: '1000000',
        sha256: 'a'.repeat(64),
      }));
      const overrides = new Overrides();
      const make = () =>
        new ReviewRemediationService({
          history,
          audit,
          overrides,
          outputBinding,
          coreFactory: async () => ({ execute: jest.fn(), close: async () => undefined }),
          now: () => new Date('2026-09-22T00:00:02.000Z'),
        });
      const service = make();
      await service.withTransactionSession(async () => {
        const first = await service.list({ limit: 25 });
        expect(first.items).toHaveLength(25);
        expect(outputBinding).toHaveBeenCalledTimes(25);
        const second = await service.list({ limit: 25, cursor: first.nextCursor });
        expect(second.items).toHaveLength(25);
        expect(new Set([...first.items, ...second.items].map((item) => item.reviewId)).size).toBe(
          50
        );
        expect(outputBinding).toHaveBeenCalledTimes(50);
        expect(history.listJobs).toHaveBeenCalledTimes(1);
        audit.reviewInput.mockClear();
        const request = {
          reviewId: first.items[0].reviewId,
          evidenceRevision: first.items[0].evidence.revision,
          action: { type: 'select-candidate' as const, candidateId: 'candidate-1' },
        };
        await service.dryRun(request);
        await service.get(request.reviewId);
        expect(history.listJobs).toHaveBeenCalledTimes(1);
        expect(audit.reviewInput).toHaveBeenCalledTimes(2);
        const selected = first.items[0];
        outputBinding.mockResolvedValueOnce({
          ...selected.output,
          sha256: 'b'.repeat(64),
        });
        expect((await service.get(selected.reviewId))?.status).toBe('stale');
        expect(history.listJobs).toHaveBeenCalledTimes(1);
        overrides.records.push({
          schemaVersion: 1,
          eventId: 'fresh-override',
          reviewId: selected.reviewId,
          sequence: 1,
          recordedAt: '2026-09-22T00:00:03.000Z',
          jobId: selected.jobId,
          previewId: selected.previewId,
          rowIndex: selected.rowIndex,
          output: selected.output,
          evidenceRevision: selected.evidence.revision,
          action: { type: 'keep' },
          result: { status: 'kept', currentPath: selected.currentPath },
        });
        expect((await service.get(selected.reviewId))?.status).toBe('kept');
        expect(audit.reviewInput).toHaveBeenCalledTimes(4);
        expect(history.listJobs).toHaveBeenCalledTimes(1);
        const pending = await service.list({ statuses: ['pending'], limit: 25 });
        expect(pending.items).toHaveLength(25);
        expect(pending.items.some((item) => item.reviewId === selected.reviewId)).toBe(false);
        const pendingNext = await service.list({
          statuses: ['pending'],
          limit: 25,
          cursor: pending.nextCursor,
        });
        expect(pendingNext.items).toHaveLength(25);
        expect(history.listJobs).toHaveBeenCalledTimes(2);
        expect(await service.get('review-unknown')).toBeNull();
        expect(history.listJobs).toHaveBeenCalledTimes(3);
      });
      expect(
        (await service.get((await service.list({ limit: 1 })).items[0].reviewId))?.status
      ).toBe('kept');
      expect(history.listJobs.mock.calls.length).toBeGreaterThan(2);
      outputBinding.mockClear();
      audit.reviewInput.mockClear();
      const first = await service.list({ limit: 2 });
      outputBinding.mockClear();
      const exact = await make().get(first.items[1].reviewId);
      expect(exact?.reviewId).toBe(first.items[1].reviewId);
      expect(outputBinding).toHaveBeenCalledTimes(1);
      expect(audit.reviewInput).toHaveBeenCalledTimes(1);
      const paged = make();
      await paged.withTransactionSession(async () => {
        const pageA = await paged.list({ limit: 1 });
        const pageB = await paged.list({ limit: 1, cursor: pageA.nextCursor });
        const pageC = await paged.list({ limit: 1, cursor: pageB.nextCursor });
        const removed = pageB.items[0];
        const inputIndex = inputs.findIndex(
          (input) => input.sourcePath === removed.originalSourcePath
        );
        expect(inputIndex).toBeGreaterThanOrEqual(0);
        inputs.splice(inputIndex, 1);
        const missing = await paged.list({ limit: 1, cursor: pageA.nextCursor });
        expect(missing.items).toEqual([]);
        const next = await paged.list({ limit: 1, cursor: missing.nextCursor });
        expect(next.items.map((item) => item.reviewId)).toEqual([pageC.items[0].reviewId]);
      });
    } finally {
      await import('fs/promises').then((fs) => fs.rm(root, { recursive: true, force: true }));
    }
  });

  it('queues only proven committed review output paths and never the stale MOVE source', async () => {
    const completed = await fixture();
    const page = await completed.service.list({ limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      currentPath: completed.currentPath,
      originalSourcePath: completed.sourcePath,
      status: 'pending',
    });
    expect(completed.audit.reviewPage).toHaveBeenCalledWith({ previewId: 'preview-1', limit: 100 });
    expect(completed.audit.reviewInput).not.toHaveBeenCalled();
    await expect(
      completed.service.list({ statuses: ['pending', 'failed'], limit: 10 })
    ).resolves.toMatchObject({ items: [expect.objectContaining({ status: 'pending' })] });
    await expect(
      completed.service.list({ statuses: ['kept', 'resolved'], limit: 10 })
    ).resolves.toEqual({ items: [] });

    const partial = await fixture({ terminal: 'partial' });
    await expect(partial.service.list({ limit: 10 })).resolves.toEqual({ items: [] });
    const partialJob = (await partial.history.listJobs())[0];
    const partialTerminal = partialJob.events.at(-1)! as any;
    partialTerminal.payload.fileOutcomes[0] = {
      sourcePath: partial.sourcePath,
      destinationPath: partial.currentPath,
      state: 'completed',
      plannedBytes: 14,
      committedBytes: 14,
      sourceRetained: false,
    };
    await expect(partial.service.list({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ currentPath: partial.currentPath })],
    });
    partialTerminal.payload.fileOutcomes[0].state = 'destination-committed-source-retained';
    partialTerminal.payload.fileOutcomes[0].sourceRetained = true;
    await expect(partial.service.list({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ currentPath: partial.currentPath })],
    });
    const cancelled = await fixture({ terminal: 'cancelled' });
    await expect(cancelled.service.list({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ currentPath: cancelled.currentPath })],
    });
  });

  it('lists and gets items with a content-hash and native-identity output binding', async () => {
    const { service, currentPath } = await fixture();
    const item = (await service.list({ limit: 10 })).items[0];
    await expect(service.get(item.reviewId)).resolves.toEqual(item);
    expect(item.output.path).toBe(currentPath);
    expect(item.output.sha256).toBe(createHash('sha256').update('original bytes').digest('hex'));
    expect(item.output.mtimeNs).toMatch(/^\d+$/);
  });

  it('surfaces content drift as stale during list/get and rejects multi-linked output', async () => {
    const stale = await fixture();
    const original = (await stale.service.list({ limit: 10 })).items[0];
    await writeFile(stale.currentPath, 'changed bytes');
    await expect(stale.service.list({ limit: 10 })).resolves.toMatchObject({
      items: [expect.objectContaining({ reviewId: original.reviewId, status: 'stale' })],
    });
    await expect(stale.service.get(original.reviewId)).resolves.toMatchObject({ status: 'stale' });

    const linked = await fixture();
    await import('fs/promises').then((fs) =>
      fs.link(linked.currentPath, `${linked.currentPath}.link`)
    );
    await expect(linked.service.list({ limit: 10 })).rejects.toThrow('regular file');
  });

  it('rejects persisted overrides whose immutable job/row/output binding is corrupt', async () => {
    const value = await fixture();
    const item = (await value.service.list({ limit: 10 })).items[0];
    value.overrides.records.push({
      schemaVersion: 1,
      eventId: 'event-1',
      reviewId: item.reviewId,
      sequence: 1,
      recordedAt: '2026-09-22T00:00:02.000Z',
      jobId: '22222222-2222-4222-8222-222222222222',
      previewId: item.previewId,
      rowIndex: item.rowIndex,
      output: item.output,
      evidenceRevision: item.evidence.revision,
      action: { type: 'keep' },
      result: { status: 'kept', currentPath: item.currentPath },
    });
    await expect(value.service.list({ limit: 10 })).rejects.toThrow('override binding');
  });

  it('produces a deterministic write-free dry run for candidate, manual, and keep actions', async () => {
    const { service, currentPath } = await fixture();
    const item = (await service.list({ limit: 10 })).items[0];
    const before = await stat(currentPath);
    const request = {
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      action: { type: 'select-candidate' as const, candidateId: 'candidate-1' },
    };
    const first = await service.dryRun(request);
    const second = await service.dryRun(request);
    expect(second).toEqual(first);
    expect(first.targetPath).toBe(
      path.join(
        path.dirname(path.dirname(path.dirname(path.dirname(currentPath)))),
        'Photos',
        '2024',
        '05',
        '2024-05-06_07-08-09.jpg'
      )
    );
    expect((await stat(currentPath)).ino).toBe(before.ino);
    await expect(
      service.dryRun({ ...request, action: { type: 'manual-date', value: candidateValue } })
    ).resolves.toMatchObject({ targetPath: expect.stringContaining('2024-05-06_07-08-09.jpg') });
    await expect(service.dryRun({ ...request, action: { type: 'keep' } })).resolves.toMatchObject({
      targetPath: null,
      collision: false,
    });
  });

  it('does not let a manual date relabel an EMPTY_FILE review item as a valid photo', async () => {
    const value = await fixture({
      resolution: { ...selectable(), reasonCodes: ['EMPTY_FILE'] },
    });
    const item = (await value.service.list({ limit: 10 })).items[0];
    await expect(
      value.service.dryRun({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action: { type: 'manual-date', value: candidateValue },
      })
    ).rejects.toThrow(/empty file cannot be assigned a date/i);
    await expect(
      value.service.dryRun({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action: { type: 'retry-metadata' },
      })
    ).rejects.toThrow(/empty file cannot be assigned a date/i);
    expect(value.execute).not.toHaveBeenCalled();
  });

  it('applies an exact-no-clobber move once and persists a resolved outcome', async () => {
    const { service, currentPath, execute, overrides } = await fixture();
    const item = (await service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const plan = await service.dryRun({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      action,
    });
    const result = await service.apply({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      action,
      planToken: plan.planToken,
    });
    expect(result.status).toBe('resolved');
    expect(result.resolvedPath).toBe(plan.targetPath);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: currentPath,
        expectedDestinationPath: plan.targetPath,
        collisionMode: 'exact-no-clobber',
        mode: 'move',
        expectedSha256: item.output.sha256,
      })
    );
    expect(overrides.records.at(-1)?.result.status).toBe('resolved');
    await expect(readFile(plan.targetPath!, 'utf8')).resolves.toBe('original bytes');
  });

  it('rejects stale revisions, identities, tokens, and destination races before mutation', async () => {
    const { service, currentPath, execute } = await fixture();
    const item = (await service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const plan = await service.dryRun({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      action,
    });
    await expect(
      service.dryRun({ reviewId: item.reviewId, evidenceRevision: 'stale', action })
    ).rejects.toThrow('revision');
    await expect(
      service.apply({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action,
        planToken: 'wrong',
      })
    ).rejects.toThrow('token');
    await import('fs/promises').then((fs) =>
      fs.mkdir(path.dirname(plan.targetPath!), { recursive: true })
    );
    await writeFile(plan.targetPath!, 'collision');
    await expect(
      service.apply({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action,
        planToken: plan.planToken,
      })
    ).rejects.toThrow('token');
    expect(execute).not.toHaveBeenCalled();
    await import('fs/promises').then((fs) => fs.unlink(plan.targetPath!));
    await writeFile(currentPath, 'changed bytes');
    await expect(
      service.apply({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action,
        planToken: plan.planToken,
      })
    ).rejects.toThrow('identity');
  });

  it('allocates normal _01/_02 suffixes for occupied review targets and keeps exact no-clobber', async () => {
    const value = await fixture();
    const item = (await value.service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision, action };
    const base = (await value.service.dryRun(request)).targetPath!;
    await import('fs/promises').then((fs) => fs.mkdir(path.dirname(base), { recursive: true }));
    await writeFile(base, 'base occupant');
    await writeFile(base.replace(/\.jpg$/, '_01.jpg'), 'first occupant');
    const plan = await value.service.dryRun(request);
    expect(plan.targetPath).toBe(base.replace(/\.jpg$/, '_02.jpg'));
    expect(plan.collision).toBe(false);
    expect((await value.service.dryRun(request)).planToken).toBe(plan.planToken);
    const result = await value.service.apply({ ...request, planToken: plan.planToken });
    expect(result.status).toBe('resolved');
    expect(result.resolvedPath).toBe(plan.targetPath);
    await expect(readFile(base, 'utf8')).resolves.toBe('base occupant');
    await expect(readFile(base.replace(/\.jpg$/, '_01.jpg'), 'utf8')).resolves.toBe(
      'first occupant'
    );
    expect(value.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDestinationPath: plan.targetPath,
        collisionMode: 'exact-no-clobber',
      })
    );
  });

  it('honors SKIP review policy when target already exists', async () => {
    const value = await fixture({ conflictPolicy: ConflictPolicy.SKIP });
    const item = (await value.service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const request = { reviewId: item.reviewId, evidenceRevision: item.evidence.revision, action };
    const base = (await value.service.dryRun(request)).targetPath!;
    await import('fs/promises').then((fs) => fs.mkdir(path.dirname(base), { recursive: true }));
    await writeFile(base, 'existing');
    const plan = await value.service.dryRun(request);
    expect(plan.targetPath).toBe(base);
    expect(plan.collision).toBe(true);
    await expect(value.service.apply({ ...request, planToken: plan.planToken })).rejects.toThrow(
      'collision'
    );
    expect(value.execute).not.toHaveBeenCalled();
    await expect(readFile(item.currentPath, 'utf8')).resolves.toBe('original bytes');
  });

  it('keeps in place, retries metadata, and records precommit failures', async () => {
    const kept = await fixture();
    const keptItem = (await kept.service.list({ limit: 10 })).items[0];
    const keep = { type: 'keep' as const };
    const keepPlan = await kept.service.dryRun({
      reviewId: keptItem.reviewId,
      evidenceRevision: keptItem.evidence.revision,
      action: keep,
    });
    await expect(
      kept.service.apply({
        reviewId: keptItem.reviewId,
        evidenceRevision: keptItem.evidence.revision,
        action: keep,
        planToken: keepPlan.planToken,
      })
    ).resolves.toMatchObject({ status: 'kept', currentPath: kept.currentPath });

    const retry = await fixture();
    const retryItem = (await retry.service.list({ limit: 10 })).items[0];
    const metadataCollector = {
      collectDetailed: jest.fn(async () => ({ candidates: [], warnings: ['fresh read'] })),
    };
    const retryService = retry.service.withMetadataCollector(metadataCollector);
    const retryAction = { type: 'retry-metadata' as const };
    const retryPlan = await retryService.dryRun({
      reviewId: retryItem.reviewId,
      evidenceRevision: retryItem.evidence.revision,
      action: retryAction,
    });
    await expect(
      retryService.apply({
        reviewId: retryItem.reviewId,
        evidenceRevision: retryItem.evidence.revision,
        action: retryAction,
        planToken: retryPlan.planToken,
      })
    ).resolves.toMatchObject({ status: 'pending', currentPath: retry.currentPath });
    expect(metadataCollector.collectDetailed).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: retry.currentPath,
        expectedContentSha256: retryItem.output.sha256,
        expectedContentBytes: retryItem.output.size,
      })
    );

    const failed = await fixture();
    const failedItem = (await failed.service.list({ limit: 10 })).items[0];
    const failedAction = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const failedPlan = await failed.service.dryRun({
      reviewId: failedItem.reviewId,
      evidenceRevision: failedItem.evidence.revision,
      action: failedAction,
    });
    failed.execute.mockResolvedValueOnce({
      operationId: 'x',
      sourcePath: failed.currentPath,
      status: 'failed',
      committed: false,
      sourceRetained: true,
      error: 'injected precommit failure',
    });
    await expect(
      failed.service.apply({
        reviewId: failedItem.reviewId,
        evidenceRevision: failedItem.evidence.revision,
        action: failedAction,
        planToken: failedPlan.planToken,
      })
    ).resolves.toMatchObject({ status: 'failed', currentPath: failed.currentPath });
    expect(failed.overrides.records.at(-1)?.result).toMatchObject({
      status: 'failed',
      error: 'injected precommit failure',
    });

    const crashed = await fixture();
    const crashedItem = (await crashed.service.list({ limit: 10 })).items[0];
    const crashedPlan = await crashed.service.dryRun({
      reviewId: crashedItem.reviewId,
      evidenceRevision: crashedItem.evidence.revision,
      action: failedAction,
    });
    crashed.execute.mockRejectedValueOnce(new Error('injected transaction crash'));
    await expect(
      crashed.service.apply({
        reviewId: crashedItem.reviewId,
        evidenceRevision: crashedItem.evidence.revision,
        action: failedAction,
        planToken: crashedPlan.planToken,
      })
    ).resolves.toMatchObject({ status: 'failed', currentPath: crashed.currentPath });
    expect(crashed.overrides.records.at(-1)?.result).toMatchObject({
      status: 'failed',
      error: 'injected transaction crash',
    });
  });

  it('requires an exact successful receipt and never rewrites postcommit persistence failure as precommit failure', async () => {
    const mismatched = await fixture();
    const item = (await mismatched.service.list({ limit: 10 })).items[0];
    const action = { type: 'select-candidate' as const, candidateId: 'candidate-1' };
    const plan = await mismatched.service.dryRun({
      reviewId: item.reviewId,
      evidenceRevision: item.evidence.revision,
      action,
    });
    mismatched.execute.mockResolvedValueOnce({
      operationId: 'wrong-operation',
      sourcePath: item.currentPath,
      destinationPath: plan.targetPath,
      status: 'moved',
      committed: true,
      sourceRetained: false,
      hash: item.output.sha256,
      bytes: item.output.size,
      error: 'receipt mismatch',
    });
    await expect(
      mismatched.service.apply({
        reviewId: item.reviewId,
        evidenceRevision: item.evidence.revision,
        action,
        planToken: plan.planToken,
      })
    ).rejects.toThrow('transaction committed');
    expect(mismatched.overrides.records).toHaveLength(1);
    expect(mismatched.overrides.records[0].result.status).toBe('reconciling');

    const durableFailure = await fixture();
    const durableItem = (await durableFailure.service.list({ limit: 10 })).items[0];
    const durablePlan = await durableFailure.service.dryRun({
      reviewId: durableItem.reviewId,
      evidenceRevision: durableItem.evidence.revision,
      action,
    });
    const originalAppend = durableFailure.overrides.append.bind(durableFailure.overrides);
    let appendCount = 0;
    const append = jest
      .spyOn(durableFailure.overrides, 'append')
      .mockImplementation(async (record) => {
        appendCount += 1;
        if (appendCount === 2) throw new Error('disk full');
        return originalAppend(record);
      });
    await expect(
      durableFailure.service.apply({
        reviewId: durableItem.reviewId,
        evidenceRevision: durableItem.evidence.revision,
        action,
        planToken: durablePlan.planToken,
      })
    ).rejects.toThrow('transaction committed');
    expect(append).toHaveBeenCalledTimes(2);
    await expect(readFile(durablePlan.targetPath!, 'utf8')).resolves.toBe('original bytes');
    append.mockRestore();
    const restarted = new ReviewRemediationService({
      history: durableFailure.history,
      audit: durableFailure.audit,
      overrides: durableFailure.overrides,
      coreFactory: async () => {
        throw new Error('recovery must not execute a second transaction');
      },
      now: () => new Date('2026-09-22T00:00:03.000Z'),
    });
    await expect(restarted.list({ limit: 10 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          status: 'resolved',
          currentPath: durablePlan.targetPath,
        }),
      ],
    });
    expect(durableFailure.overrides.records.at(-1)?.result.status).toBe('resolved');
  });
});
