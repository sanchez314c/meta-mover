import { JobStateMachine, JobStatus } from '../../../src/main/core/JobStateMachine';
import {
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingPhase,
} from '../../../src/shared/types/processing';

describe('JobStateMachine transition preflight', () => {
  it('checks an event without mutating state, then permits the same event to be accepted', () => {
    const jobId = '9d54e950-f226-4df5-8838-39895197634e';
    const machine = new JobStateMachine(jobId);
    const previewStarted: ProcessingEvent = {
      kind: ProcessingEventKind.PREVIEW_STARTED,
      jobId,
      sequence: 1,
      emittedAt: '2026-08-29T12:00:00.000Z',
      payload: { sourceCount: 1, destinationPath: '/destination' },
    };

    expect(machine.canAccept(previewStarted)).toMatchObject({ accepted: true });
    expect(machine.snapshot()).toMatchObject({ status: JobStatus.DRAFT, lastSequence: 0 });
    expect(machine.accept(previewStarted)).toMatchObject({ accepted: true });

    const invalidProgress: ProcessingEvent = {
      kind: ProcessingEventKind.JOB_PROGRESS,
      jobId,
      sequence: 2,
      emittedAt: '2026-08-29T12:00:01.000Z',
      payload: {
        phase: ProcessingPhase.ORGANIZATION,
        filesProcessed: 0,
        totalFiles: 1,
        percentage: 0,
      },
    };
    expect(machine.canAccept(invalidProgress)).toMatchObject({
      accepted: false,
      reason: 'invalid-transition',
    });
    expect(machine.snapshot()).toMatchObject({
      status: JobStatus.PREVIEWING,
      lastSequence: 1,
    });
  });
});
