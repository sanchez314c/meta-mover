import {
  ConflictPolicy,
  DependencyHealthDTO,
  FolderStructure,
  OperationMode,
  PreviewRequestDTO,
  PreviewResultDTO,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingOptionsDTO,
  StartProcessingRequestDTO,
  isSerializableProcessingValue,
} from '../../../src/shared/types/processing';
import { JobStateMachine, JobStatus } from '../../../src/main/core/JobStateMachine';

const options: ProcessingOptionsDTO = {
  operation: OperationMode.COPY,
  conflictPolicy: ConflictPolicy.RENAME,
  folderStructure: FolderStructure.YEAR_MONTH,
  workerCount: 4,
  verifyIntegrity: true,
  appendScreenshotSuffix: false,
  writeMetadataDates: false,
};

const event = <K extends ProcessingEvent['kind']>(
  kind: K,
  sequence: number,
  payload: Extract<ProcessingEvent, { kind: K }>['payload'],
  jobId = 'job-123'
): Extract<ProcessingEvent, { kind: K }> =>
  ({
    kind,
    jobId,
    sequence,
    emittedAt: '2026-08-29T12:00:00.000Z',
    payload,
  }) as Extract<ProcessingEvent, { kind: K }>;

describe('canonical processing contract', () => {
  it('uses truthful copy/move and conflict policy values', () => {
    expect(Object.values(OperationMode)).toEqual(['copy', 'move']);
    expect(Object.values(ConflictPolicy)).toEqual(['skip', 'rename']);
    expect(Object.values(FolderStructure)).toEqual(['year/month', 'year-month', 'flat']);
  });

  it('binds start capability to an immutable preview identifier', () => {
    const request: PreviewRequestDTO = {
      sourcePaths: ['/media/source'],
      destinationPath: '/media/destination',
      options,
    };
    const preview: PreviewResultDTO = {
      jobId: 'job-123',
      previewId: 'preview-123',
      createdAt: '2026-08-29T12:00:00.000Z',
      request,
      effectiveOptions: options,
      summary: {
        totalFiles: 2,
        copyFiles: 2,
        moveFiles: 0,
        skippedFiles: 0,
        renamedFiles: 1,
        overwrittenFiles: 0,
        unresolvedDates: 0,
        totalBytes: 42,
      },
    };
    const start: StartProcessingRequestDTO = {
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    };

    expect(start).toEqual({
      previewId: 'preview-123',
      acknowledgeDestructiveOperation: false,
    });
    expect(isSerializableProcessingValue(preview)).toBe(true);
  });

  it('reports only capabilities backed by the ExifTool runtime', () => {
    const health: DependencyHealthDTO = {
      checkedAt: '2026-08-29T12:00:00.000Z',
      ready: true,
      capabilities: {
        preview: { available: true, blockers: [] },
        start: { available: true, blockers: [] },
        metadataWriteback: { available: false, blockers: ['exiftool is unavailable'] },
      },
      dependencies: [
        {
          name: 'exiftool',
          available: true,
          source: 'bundled',
          requiredFor: ['preview', 'start'],
          version: '13.59',
        },
      ],
    };

    expect(health.ready).toBe(true);
    expect(health.capabilities).not.toHaveProperty('corruptionDetection');
    expect(health.dependencies.map((dependency) => dependency.name)).toEqual(['exiftool']);
    expect(isSerializableProcessingValue(health)).toBe(true);
  });

  it('rejects functions, Dates, undefined, and non-finite numbers as DTO values', () => {
    expect(isSerializableProcessingValue({ ok: ['value', 1, true, null] })).toBe(true);
    expect(isSerializableProcessingValue({ bad: new Date() })).toBe(false);
    expect(isSerializableProcessingValue({ bad: undefined })).toBe(false);
    expect(isSerializableProcessingValue({ bad: () => undefined })).toBe(false);
    expect(isSerializableProcessingValue({ bad: Number.NaN })).toBe(false);
  });
});

describe('JobStateMachine', () => {
  function advanceToProcessing(machine: JobStateMachine): void {
    expect(
      machine.accept(
        event(ProcessingEventKind.PREVIEW_STARTED, 1, {
          sourceCount: 1,
          destinationPath: '/media/destination',
        })
      ).accepted
    ).toBe(true);
    expect(
      machine.accept(
        event(ProcessingEventKind.PREVIEW_READY, 2, {
          previewId: 'preview-123',
          summary: {
            totalFiles: 2,
            copyFiles: 2,
            moveFiles: 0,
            skippedFiles: 0,
            renamedFiles: 0,
            overwrittenFiles: 0,
            unresolvedDates: 0,
            totalBytes: 42,
          },
        })
      ).accepted
    ).toBe(true);
    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_QUEUED, 3, {
          previewId: 'preview-123',
          effectiveOptions: options,
        })
      ).accepted
    ).toBe(true);
    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_STARTED, 4, {
          phase: 'discovery',
        })
      ).accepted
    ).toBe(true);
  }

  it('accepts the preview-to-start lifecycle and monotonic progress', () => {
    const machine = new JobStateMachine('job-123');
    advanceToProcessing(machine);

    const progress = machine.accept(
      event(ProcessingEventKind.JOB_PROGRESS, 5, {
        phase: 'metadata',
        filesProcessed: 1,
        totalFiles: 2,
        percentage: 50,
        currentFile: '/media/source/a.jpg',
      })
    );

    expect(progress.accepted).toBe(true);
    expect(progress.snapshot).toMatchObject({
      status: JobStatus.PROCESSING,
      lastSequence: 5,
      terminalEventKind: null,
    });
  });

  it('rejects stale and wrong-job events without advancing state', () => {
    const machine = new JobStateMachine('job-123');
    advanceToProcessing(machine);

    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_PROGRESS, 4, {
          phase: 'metadata',
          filesProcessed: 1,
          totalFiles: 2,
          percentage: 50,
        })
      )
    ).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    expect(
      machine.accept(
        event(
          ProcessingEventKind.JOB_PROGRESS,
          5,
          { phase: 'metadata', filesProcessed: 1, totalFiles: 2, percentage: 50 },
          'another-job'
        )
      )
    ).toMatchObject({ accepted: false, reason: 'job-id-mismatch' });
    expect(machine.snapshot()).toMatchObject({ lastSequence: 4, status: JobStatus.PROCESSING });
  });

  it('allows exactly one terminal transition', () => {
    const machine = new JobStateMachine('job-123');
    advanceToProcessing(machine);

    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_COMPLETED, 5, {
          statistics: {
            totalFiles: 2,
            processedFiles: 2,
            skippedFiles: 0,
            failedFiles: 0,
            totalBytes: 42,
            processedBytes: 42,
            durationMs: 100,
          },
        })
      ).accepted
    ).toBe(true);

    const secondTerminal = machine.accept(
      event(ProcessingEventKind.JOB_FAILED, 6, {
        error: { code: 'LATE_FAILURE', message: 'too late', recoverable: false },
      })
    );

    expect(secondTerminal).toMatchObject({ accepted: false, reason: 'already-terminal' });
    expect(machine.snapshot()).toMatchObject({
      status: JobStatus.COMPLETED,
      terminalEventKind: ProcessingEventKind.JOB_COMPLETED,
      lastSequence: 5,
    });
  });

  it('models a mixed execution result as a terminal partial outcome', () => {
    const machine = new JobStateMachine('job-123');
    advanceToProcessing(machine);

    const partial = machine.accept(
      event(ProcessingEventKind.JOB_PARTIALLY_COMPLETED, 5, {
        statistics: {
          totalFiles: 2,
          processedFiles: 1,
          skippedFiles: 0,
          failedFiles: 1,
          totalBytes: 42,
          processedBytes: 20,
          durationMs: 100,
        },
        fileFailures: [{ sourcePath: '/media/source/b.jpg', error: 'copy failed' }],
      })
    );

    expect(partial).toMatchObject({
      accepted: true,
      snapshot: {
        status: JobStatus.PARTIAL,
        terminalEventKind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      },
    });
    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_COMPLETED, 6, {
          statistics: {
            totalFiles: 2,
            processedFiles: 2,
            skippedFiles: 0,
            failedFiles: 0,
            totalBytes: 42,
            processedBytes: 42,
            durationMs: 110,
          },
        })
      )
    ).toMatchObject({ accepted: false, reason: 'already-terminal' });
  });

  it('models cancellation as processing to cancelling to cancelled', () => {
    const machine = new JobStateMachine('job-123');
    advanceToProcessing(machine);

    expect(
      machine.accept(event(ProcessingEventKind.JOB_CANCELLING, 5, { reason: 'user-requested' }))
        .snapshot.status
    ).toBe(JobStatus.CANCELLING);
    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_CANCELLED, 6, {
          reason: 'user-requested',
          filesProcessed: 0,
          statistics: {
            totalFiles: 2,
            processedFiles: 0,
            skippedFiles: 0,
            failedFiles: 0,
            cancelledFiles: 1,
            unattemptedFiles: 1,
            totalBytes: 42,
            processedBytes: 0,
            committedResidueBytes: 21,
            durationMs: 100,
          },
          fileFailures: [],
          fileOutcomes: [
            {
              sourcePath: '/media/source/a.jpg',
              destinationPath: '/media/destination/a.jpg',
              state: 'destination-committed-source-retained',
              plannedBytes: 21,
              committedBytes: 21,
              sourceRetained: true,
              error: 'cancelled after commit',
            },
            {
              sourcePath: '/media/source/b.jpg',
              destinationPath: '/media/destination/b.jpg',
              state: 'not-attempted',
              plannedBytes: 21,
              committedBytes: 0,
              sourceRetained: true,
              error: 'not attempted',
            },
          ],
        })
      ).snapshot.status
    ).toBe(JobStatus.CANCELLED);

    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_COMPLETED, 7, {
          statistics: {
            totalFiles: 2,
            processedFiles: 2,
            skippedFiles: 0,
            failedFiles: 0,
            totalBytes: 42,
            processedBytes: 42,
            durationMs: 100,
          },
        })
      )
    ).toMatchObject({ accepted: false, reason: 'already-terminal' });
  });

  it('rejects invalid event sequences and lifecycle jumps', () => {
    const machine = new JobStateMachine('job-123');

    expect(
      machine.accept(
        event(ProcessingEventKind.JOB_COMPLETED, 1, {
          statistics: {
            totalFiles: 0,
            processedFiles: 0,
            skippedFiles: 0,
            failedFiles: 0,
            totalBytes: 0,
            processedBytes: 0,
            durationMs: 0,
          },
        })
      )
    ).toMatchObject({ accepted: false, reason: 'invalid-transition' });
    expect(
      machine.accept(
        event(ProcessingEventKind.PREVIEW_STARTED, 0, {
          sourceCount: 1,
          destinationPath: '/media/destination',
        })
      )
    ).toMatchObject({ accepted: false, reason: 'invalid-sequence' });
  });
});
