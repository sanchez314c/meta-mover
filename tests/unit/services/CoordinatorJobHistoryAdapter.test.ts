import { JobStatus } from '../../../src/main/core/JobStateMachine';
import {
  CoordinatorJobHistoryAdapter,
  JobHistoryPersistencePort,
} from '../../../src/main/services/CoordinatorJobHistoryAdapter';
import { HistoryJobSnapshot } from '../../../src/main/services/JobHistoryStore';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingPhase,
  PreviewResultDTO,
} from '../../../src/shared/types/processing';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const PREVIEW_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-08-29T12:00:00.000Z';
const options = {
  operation: OperationMode.COPY,
  conflictPolicy: ConflictPolicy.RENAME,
  folderStructure: FolderStructure.YEAR_MONTH,
  workerCount: 2,
  verifyIntegrity: true as const,
  appendScreenshotSuffix: false,
  writeMetadataDates: false as const,
};
const summary = {
  totalFiles: 3,
  copyFiles: 3,
  moveFiles: 0,
  skippedFiles: 0,
  renamedFiles: 0,
  overwrittenFiles: 0,
  unresolvedDates: 0,
  totalBytes: 30,
};

function preview(): PreviewResultDTO {
  return {
    jobId: JOB_ID,
    previewId: PREVIEW_ID,
    createdAt: CREATED_AT,
    expiresAt: '2026-08-29T12:01:00.000Z',
    request: {
      sourcePaths: ['/source/a', '/source/b'],
      destinationPath: '/destination',
      options,
    },
    effectiveOptions: options,
    summary,
    rows: ['/source/a', '/source/b', '/source/c'].map((sourcePath, index) => ({
      sourcePath,
      targetPath: `/destination/${String.fromCharCode(97 + index)}`,
      operation: OperationMode.COPY,
      conflictPolicy: ConflictPolicy.RENAME,
      dateEvidence: {
        value: '2024-01-01T00:00:00.000Z',
        source: 'embedded' as const,
        confidence: 1,
        warnings: [],
      },
      fingerprint: {
        size: 10,
        modifiedAt: '2026-08-29T11:59:00.000Z',
      },
      warnings: [],
    })),
  };
}

function snapshot(
  status: HistoryJobSnapshot['status'],
  events: ProcessingEvent[] = []
): HistoryJobSnapshot {
  return {
    jobId: JOB_ID,
    previewId: PREVIEW_ID,
    createdAt: CREATED_AT,
    sourcePaths: ['/source/a', '/source/b'],
    destinationPath: '/destination',
    effectiveOptions: options,
    previewSummary: summary,
    status,
    lastSequence: events.at(-1)?.sequence ?? 2,
    terminalEventKind: events.at(-1)?.kind ?? null,
    events,
  };
}

function persistence(initial: HistoryJobSnapshot[] = []): jest.Mocked<JobHistoryPersistencePort> {
  return {
    createJob: jest.fn(async () => snapshot(JobStatus.PREVIEW_READY)),
    appendEvent: jest.fn(async () => snapshot(JobStatus.QUEUED)),
    listJobs: jest.fn(async () => initial),
  };
}

describe('CoordinatorJobHistoryAdapter', () => {
  it('persists partial inventory issues and returns them in terminal history', async () => {
    const store = persistence([
      {
        ...snapshot(JobStatus.COMPLETED),
        inventoryIssues: [{ filePath: '/source/a/2019', code: 'EIO' }],
      },
    ]);
    const adapter = new CoordinatorJobHistoryAdapter(store);
    const prepared = preview();
    prepared.inventoryIssues = [{ filePath: '/source/a/2019', code: 'EIO' }];
    await adapter.recordPreview(prepared);
    expect(store.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        inventoryIssues: [{ filePath: '/source/a/2019', code: 'EIO' }],
      })
    );
    expect((await adapter.listJobs())[0].inventoryIssues).toEqual([
      { filePath: '/source/a/2019', code: 'EIO' },
    ]);
  });
  it('persists preview identity and immutable request data exactly', async () => {
    const store = persistence();
    const adapter = new CoordinatorJobHistoryAdapter(store);

    await adapter.recordPreview(preview());

    expect(store.createJob).toHaveBeenCalledWith({
      jobId: JOB_ID,
      createdAt: CREATED_AT,
      previewId: PREVIEW_ID,
      sourcePaths: ['/source/a', '/source/b'],
      destinationPath: '/destination',
      effectiveOptions: options,
      previewSummary: summary,
      previewRows: preview().rows,
    });
  });

  it('appends each canonical event once and exposes no duplicate terminal or unsupported hooks', async () => {
    const store = persistence();
    const adapter = new CoordinatorJobHistoryAdapter(store);
    const terminal: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_COMPLETED,
      jobId: JOB_ID,
      sequence: 5,
      emittedAt: '2026-08-29T12:00:05.000Z',
      payload: {
        statistics: {
          totalFiles: 3,
          processedFiles: 3,
          skippedFiles: 0,
          failedFiles: 0,
          totalBytes: 20,
          processedBytes: 30,
          durationMs: 5_000,
        },
      },
    };

    await adapter.recordEvent(terminal);

    expect(store.appendEvent).toHaveBeenCalledTimes(1);
    expect(store.appendEvent).toHaveBeenCalledWith(JOB_ID, terminal);
    expect((adapter as unknown as Record<string, unknown>).recordTerminal).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).recordLedgerEntry).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).recordStartRejection).toBeUndefined();
  });

  it('maps preview-ready truthfully instead of claiming the job is queued', async () => {
    const adapter = new CoordinatorJobHistoryAdapter(
      persistence([snapshot(JobStatus.PREVIEW_READY)])
    );

    await expect(adapter.listJobs()).resolves.toEqual([
      expect.objectContaining({
        jobId: JOB_ID,
        status: 'preview-ready',
        progress: { filesProcessed: 0, totalFiles: 3, percentage: 0 },
      }),
    ]);
  });

  it('derives processing progress, timestamps, terminal statistics, and newest-first limits', async () => {
    const started: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_STARTED,
      jobId: JOB_ID,
      sequence: 4,
      emittedAt: '2026-08-29T12:00:02.000Z',
      payload: { phase: ProcessingPhase.ORGANIZATION },
    };
    const progress: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_PROGRESS,
      jobId: JOB_ID,
      sequence: 5,
      emittedAt: '2026-08-29T12:00:03.000Z',
      payload: {
        phase: ProcessingPhase.ORGANIZATION,
        filesProcessed: 2,
        totalFiles: 3,
        percentage: 66.666,
      },
    };
    const completed: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_COMPLETED,
      jobId: JOB_ID,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:05.000Z',
      payload: {
        statistics: {
          totalFiles: 3,
          processedFiles: 2,
          skippedFiles: 1,
          failedFiles: 0,
          totalBytes: 30,
          processedBytes: 20,
          durationMs: 3_000,
        },
      },
    };
    const older = snapshot(JobStatus.PREVIEW_READY);
    const newer = {
      ...snapshot(JobStatus.COMPLETED, [started, progress, completed]),
      jobId: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-08-29T13:00:00.000Z',
    };
    const adapter = new CoordinatorJobHistoryAdapter(persistence([older, newer]));

    const jobs = await adapter.listJobs(1);

    expect(jobs).toEqual([
      expect.objectContaining({
        jobId: newer.jobId,
        status: 'completed',
        startedAt: started.emittedAt,
        completedAt: completed.emittedAt,
        progress: { filesProcessed: 2, totalFiles: 3, percentage: 100 * (2 / 3) },
        statistics: completed.payload.statistics,
      }),
    ]);
  });

  it('persists mixed outcomes as partial with success counts and failed paths', async () => {
    const partial: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      jobId: JOB_ID,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:05.000Z',
      payload: {
        statistics: {
          totalFiles: 3,
          processedFiles: 2,
          skippedFiles: 0,
          failedFiles: 1,
          totalBytes: 30,
          processedBytes: 20,
          durationMs: 3_000,
        },
        fileFailures: [{ sourcePath: '/source/b', error: 'permission denied' }],
      },
    };
    const adapter = new CoordinatorJobHistoryAdapter(
      persistence([snapshot(JobStatus.PARTIAL, [partial])])
    );

    await expect(adapter.listJobs()).resolves.toEqual([
      expect.objectContaining({
        status: 'partial',
        completedAt: partial.emittedAt,
        progress: { filesProcessed: 2, totalFiles: 3, percentage: 100 * (2 / 3) },
        statistics: partial.payload.statistics,
        fileFailures: partial.payload.fileFailures,
      }),
    ]);
  });

  it('maps all-file failures with zero successes and terminal failure details', async () => {
    const failed: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_FAILED,
      jobId: JOB_ID,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:05.000Z',
      payload: {
        error: {
          code: 'FILE_OPERATIONS_FAILED',
          message: 'All 3 file operations failed',
          recoverable: true,
        },
        statistics: {
          totalFiles: 3,
          processedFiles: 0,
          skippedFiles: 0,
          failedFiles: 3,
          totalBytes: 30,
          processedBytes: 0,
          durationMs: 3_000,
        },
        fileFailures: [
          { sourcePath: '/source/a', error: 'denied' },
          { sourcePath: '/source/b', error: 'denied' },
          { sourcePath: '/source/c', error: 'denied' },
        ],
      },
    };
    const adapter = new CoordinatorJobHistoryAdapter(
      persistence([snapshot(JobStatus.FAILED, [failed])])
    );

    await expect(adapter.listJobs()).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        progress: { filesProcessed: 0, totalFiles: 3, percentage: 0 },
        statistics: failed.payload.statistics,
        error: failed.payload.error,
        fileFailures: failed.payload.fileFailures,
      }),
    ]);
  });

  it('uses cancellation terminal counts instead of stale progress', async () => {
    const progress: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_PROGRESS,
      jobId: JOB_ID,
      sequence: 5,
      emittedAt: '2026-08-29T12:00:03.000Z',
      payload: {
        phase: ProcessingPhase.ORGANIZATION,
        filesProcessed: 2,
        totalFiles: 3,
        percentage: 66.666,
      },
    };
    const cancelled: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_CANCELLED,
      jobId: JOB_ID,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:04.000Z',
      payload: {
        filesProcessed: 0,
        reason: 'shutdown',
        statistics: {
          totalFiles: 3,
          processedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          cancelledFiles: 1,
          unattemptedFiles: 2,
          totalBytes: 30,
          processedBytes: 0,
          committedResidueBytes: 0,
          durationMs: 1_000,
        },
        fileFailures: [],
        fileOutcomes: [
          {
            sourcePath: '/source/a',
            destinationPath: '/destination/a',
            state: 'destination-committed-source-retained',
            plannedBytes: 0,
            committedBytes: 0,
            sourceRetained: true,
            error: 'cancelled after commit',
          },
          {
            sourcePath: '/source/b',
            destinationPath: '/destination/b',
            state: 'not-attempted',
            plannedBytes: 10,
            committedBytes: 0,
            sourceRetained: true,
            error: 'not attempted',
          },
          {
            sourcePath: '/source/c',
            destinationPath: '/destination/c',
            state: 'not-attempted',
            plannedBytes: 10,
            committedBytes: 0,
            sourceRetained: true,
            error: 'not attempted',
          },
        ],
      },
    };
    const adapter = new CoordinatorJobHistoryAdapter(
      persistence([snapshot(JobStatus.CANCELLED, [progress, cancelled])])
    );

    const [job] = await adapter.listJobs();
    expect(job).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        completedAt: cancelled.emittedAt,
        progress: expect.objectContaining({ filesProcessed: 0, totalFiles: 3 }),
        statistics: cancelled.payload.statistics,
        cancellationOutcomes: cancelled.payload.fileOutcomes,
      })
    );
    expect(job.progress.percentage).toBe(0);
  });

  it('maps failed history errors and rejects impossible non-durable draft states', async () => {
    const failed: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_FAILED,
      jobId: JOB_ID,
      sequence: 3,
      emittedAt: '2026-08-29T12:00:01.000Z',
      payload: {
        error: { code: 'INTERRUPTED', message: 'restart', recoverable: true },
      },
    };
    const failedAdapter = new CoordinatorJobHistoryAdapter(
      persistence([snapshot(JobStatus.FAILED, [failed])])
    );
    const draftAdapter = new CoordinatorJobHistoryAdapter(persistence([snapshot(JobStatus.DRAFT)]));

    await expect(failedAdapter.listJobs()).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        completedAt: failed.emittedAt,
        error: failed.payload.error,
      }),
    ]);
    await expect(draftAdapter.listJobs()).rejects.toThrow(/unsupported persisted status/i);
  });
});
