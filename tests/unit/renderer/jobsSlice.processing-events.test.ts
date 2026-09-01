import reducer, {
  applyProcessingEvent,
  setActiveJob,
} from '../../../src/renderer/store/slices/jobsSlice';
import type { ProcessingEvent, ProcessingOptionsDTO } from '../../../src/shared/types/processing';

const options: ProcessingOptionsDTO = {
  operation: 'copy',
  conflictPolicy: 'rename',
  folderStructure: 'year/month',
  workerCount: 4,
  verifyIntegrity: true,
  writeMetadataDates: false,
};

function queued(jobId: string, sequence = 1): ProcessingEvent {
  return {
    kind: 'job-queued',
    jobId,
    sequence,
    emittedAt: `2026-08-29T20:00:0${sequence}.000Z`,
    payload: { previewId: `preview-${jobId}`, effectiveOptions: options },
  };
}

describe('jobsSlice processing event reduction', () => {
  it('tracks preview discovery, exact progress, and cancellation independently from jobs', () => {
    let state = reducer(
      undefined,
      applyProcessingEvent({
        kind: 'preview-started',
        jobId: 'preview-job',
        sequence: 1,
        emittedAt: '2026-08-31T20:00:00.000Z',
        payload: { sourceCount: 2, destinationPath: '/destination' },
      })
    );
    expect(state.previewBuild).toMatchObject({
      jobId: 'preview-job',
      status: 'previewing',
      phase: 'discovery',
      filesProcessed: 0,
      totalFiles: 0,
    });
    expect(state.isProcessing).toBe(true);

    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'preview-started',
        jobId: 'overlapping-preview',
        sequence: 1,
        emittedAt: '2026-08-31T20:00:00.500Z',
        payload: { sourceCount: 1, destinationPath: '/other-destination' },
      })
    );
    expect(state.previewBuild?.jobId).toBe('preview-job');

    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'preview-progress',
        jobId: 'preview-job',
        sequence: 2,
        emittedAt: '2026-08-31T20:00:01.000Z',
        payload: {
          phase: 'metadata',
          filesProcessed: 3,
          totalFiles: 10,
          percentage: 30,
          currentFile: '/source/current.jpg',
        },
      })
    );
    expect(state.previewBuild).toMatchObject({
      status: 'previewing',
      phase: 'metadata',
      filesProcessed: 3,
      totalFiles: 10,
      percentage: 30,
      currentFile: '/source/current.jpg',
      lastSequence: 2,
    });

    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'preview-progress',
        jobId: 'preview-job',
        sequence: 2,
        emittedAt: '2026-08-31T20:00:01.500Z',
        payload: {
          phase: 'metadata',
          filesProcessed: 9,
          totalFiles: 10,
          percentage: 90,
          currentFile: '/source/stale.jpg',
        },
      })
    );
    expect(state.previewBuild).toMatchObject({
      filesProcessed: 3,
      percentage: 30,
      currentFile: '/source/current.jpg',
      lastSequence: 2,
    });

    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-failed',
        jobId: 'preview-job',
        sequence: 3,
        emittedAt: '2026-08-31T20:00:02.000Z',
        payload: {
          error: {
            code: 'PREVIEW_CANCELLED',
            message: 'Preview analysis stopped',
            recoverable: true,
          },
        },
      })
    );
    expect(state.previewBuild?.status).toBe('cancelled');
    expect(state.isProcessing).toBe(false);
    expect(state.jobs).toEqual([]);
  });

  it('keeps another admitted job active when an overlapping job completes', () => {
    let state = reducer(undefined, applyProcessingEvent(queued('job-a')));
    state = reducer(state, applyProcessingEvent(queued('job-b')));
    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-completed',
        jobId: 'job-a',
        sequence: 2,
        emittedAt: '2026-08-29T20:00:03.000Z',
        payload: {
          statistics: {
            totalFiles: 2,
            processedFiles: 2,
            skippedFiles: 0,
            failedFiles: 0,
            totalBytes: 10,
            processedBytes: 10,
            durationMs: 100,
          },
        },
      })
    );

    expect(state.jobs.find((job) => job.id === 'job-a')?.status).toBe('completed');
    expect(state.activeJobId).toBe('job-b');
    expect(state.isProcessing).toBe(true);

    state = reducer(state, setActiveJob(null));
    expect(state.activeJobId).toBe('job-b');
    expect(state.isProcessing).toBe(true);
  });

  it('preserves cancelling state and rejects duplicate or stale events by sequence', () => {
    let state = reducer(undefined, applyProcessingEvent(queued('job-a')));
    state = reducer(state, applyProcessingEvent(queued('job-a')));
    expect(state.jobs).toHaveLength(1);

    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-cancelling',
        jobId: 'job-a',
        sequence: 3,
        emittedAt: '2026-08-29T20:00:03.000Z',
        payload: { reason: 'User requested cancellation' },
      })
    );
    expect(state.jobs[0].status).toBe('cancelling');

    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-progress',
        jobId: 'job-a',
        sequence: 2,
        emittedAt: '2026-08-29T20:00:02.000Z',
        payload: {
          phase: 'organization',
          filesProcessed: 1,
          totalFiles: 9,
          percentage: 11,
        },
      })
    );
    expect(state.jobs[0].status).toBe('cancelling');
    expect(state.jobs[0].progress).toBe(0);
    expect(state.jobs[0].lastSequence).toBe(3);
  });

  it('never regresses cancelling or terminal jobs when a later progress event arrives', () => {
    let state = reducer(undefined, applyProcessingEvent(queued('job-a')));
    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-cancelling',
        jobId: 'job-a',
        sequence: 2,
        emittedAt: '2026-08-29T20:00:02.000Z',
        payload: {},
      })
    );
    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-progress',
        jobId: 'job-a',
        sequence: 3,
        emittedAt: '2026-08-29T20:00:03.000Z',
        payload: {
          phase: 'cleanup',
          filesProcessed: 4,
          totalFiles: 5,
          percentage: 80,
        },
      })
    );
    expect(state.jobs[0].status).toBe('cancelling');
    expect(state.jobs[0].progress).toBe(80);

    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-cancelled',
        jobId: 'job-a',
        sequence: 4,
        emittedAt: '2026-08-29T20:00:04.000Z',
        payload: {
          filesProcessed: 0,
          statistics: {
            totalFiles: 5,
            processedFiles: 0,
            skippedFiles: 0,
            failedFiles: 0,
            cancelledFiles: 1,
            unattemptedFiles: 4,
            totalBytes: 40,
            processedBytes: 0,
            committedResidueBytes: 0,
            durationMs: 100,
          },
          fileFailures: [],
          fileOutcomes: [
            {
              sourcePath: '/source/a.jpg',
              destinationPath: '/destination/a.jpg',
              state: 'destination-committed-source-retained',
              plannedBytes: 0,
              committedBytes: 0,
              sourceRetained: true,
              error: 'cancelled after commit',
            },
            ...Array.from({ length: 4 }, (_, index) => ({
              sourcePath: `/source/${index + 1}.jpg`,
              destinationPath: `/destination/${index + 1}.jpg`,
              state: 'not-attempted' as const,
              plannedBytes: 10,
              committedBytes: 0,
              sourceRetained: true,
              error: 'not attempted',
            })),
          ],
        },
      })
    );
    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-progress',
        jobId: 'job-a',
        sequence: 5,
        emittedAt: '2026-08-29T20:00:05.000Z',
        payload: {
          phase: 'cleanup',
          filesProcessed: 5,
          totalFiles: 5,
          percentage: 100,
        },
      })
    );
    expect(state.jobs[0].status).toBe('cancelled');
    expect(state.jobs[0]).toMatchObject({
      filesProcessed: 0,
      totalFiles: 5,
      cancelledFiles: 1,
      unattemptedFiles: 4,
      committedResidueBytes: 0,
      cancellationOutcomes: expect.arrayContaining([
        expect.objectContaining({
          state: 'destination-committed-source-retained',
          sourcePath: '/source/a.jpg',
          destinationPath: '/destination/a.jpg',
          plannedBytes: 0,
          committedBytes: 0,
        }),
      ]),
    });
    expect(state.isProcessing).toBe(false);
  });

  it('stores a partial terminal outcome without inflating successful file counts', () => {
    let state = reducer(undefined, applyProcessingEvent(queued('job-partial')));
    state = reducer(
      state,
      applyProcessingEvent({
        kind: 'job-partially-completed',
        jobId: 'job-partial',
        sequence: 2,
        emittedAt: '2026-08-29T20:00:02.000Z',
        payload: {
          statistics: {
            totalFiles: 3,
            processedFiles: 2,
            skippedFiles: 0,
            failedFiles: 1,
            totalBytes: 30,
            processedBytes: 20,
            durationMs: 100,
          },
          fileFailures: [{ sourcePath: '/source/b.jpg', error: 'permission denied' }],
        },
      })
    );

    expect(state.jobs[0]).toMatchObject({
      status: 'partial',
      progress: 100 * (2 / 3),
      filesProcessed: 2,
      totalFiles: 3,
      skippedFiles: 0,
      failedFiles: 1,
      fileFailures: [{ sourcePath: '/source/b.jpg', error: 'permission denied' }],
    });
    expect(state.isProcessing).toBe(false);
  });
});
