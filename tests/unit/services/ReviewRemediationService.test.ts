import { createHash } from 'crypto';
import { mkdtemp, readFile, realpath, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { resolveDateCandidates } from '../../../src/main/core/date';
import type { DateResolutionRecord, ParsedDateValue } from '../../../src/main/core/date';
import { ReviewRemediationService } from '../../../src/main/services/ReviewRemediationService';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  ProcessingEventKind,
} from '../../../src/shared/types/processing';
import type { ReviewOverrideRecord } from '../../../src/shared/types/review';

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
    conflictPolicy: ConflictPolicy.RENAME,
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
          conflictPolicy: ConflictPolicy.RENAME,
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
  const service = new ReviewRemediationService({
    history,
    audit,
    overrides,
    coreFactory: async () => core,
    now: () => new Date('2026-09-22T00:00:02.000Z'),
  });
  return {
    service,
    root,
    currentPath,
    sourcePath,
    destination,
    overrides,
    execute,
    audit,
    history,
  };
}

describe('ReviewRemediationService', () => {
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
        listJobs: async () => [
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
        ],
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
      const make = () =>
        new ReviewRemediationService({
          history,
          audit,
          overrides: new Overrides(),
          outputBinding,
          coreFactory: async () => ({ execute: jest.fn(), close: async () => undefined }),
          now: () => new Date('2026-09-22T00:00:02.000Z'),
        });
      const service = make();
      const first = await service.list({ limit: 25 });
      expect(first.items).toHaveLength(25);
      expect(outputBinding).toHaveBeenCalledTimes(25);
      const second = await service.list({ limit: 25, cursor: first.nextCursor });
      expect(second.items).toHaveLength(25);
      expect(
        new Set([...first.items, ...second.items].map((item) => item.reviewId))
      ).toHaveProperty('size', 50);
      expect(outputBinding).toHaveBeenCalledTimes(50);

      outputBinding.mockClear();
      const exact = await make().get(first.items[0].reviewId);
      expect(exact?.reviewId).toBe(first.items[0].reviewId);
      expect(outputBinding).toHaveBeenCalledTimes(1);
      expect(audit.reviewInput).toHaveBeenCalledTimes(1);
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

  it('rejects stale revisions, identities, tokens, and collisions before mutation', async () => {
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
    ).rejects.toThrow('collision');
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
