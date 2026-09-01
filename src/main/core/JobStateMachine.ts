import {
  ProcessingEvent,
  ProcessingEventKind,
  TerminalProcessingEventKind,
} from '../../shared/types/processing';

export const JobStatus = {
  DRAFT: 'draft',
  PREVIEWING: 'previewing',
  PREVIEW_READY: 'preview-ready',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  CANCELLING: 'cancelling',
  COMPLETED: 'completed',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export type EventRejectionReason =
  | 'job-id-mismatch'
  | 'invalid-sequence'
  | 'stale-sequence'
  | 'already-terminal'
  | 'invalid-transition';

export interface JobStateSnapshot {
  jobId: string;
  status: JobStatus;
  lastSequence: number;
  lastEventKind: ProcessingEvent['kind'] | null;
  terminalEventKind: TerminalProcessingEventKind | null;
}

export type EventAcceptance =
  | { accepted: true; snapshot: JobStateSnapshot }
  | { accepted: false; reason: EventRejectionReason; snapshot: JobStateSnapshot };

const TERMINAL_STATUSES = new Set<JobStatus>([
  JobStatus.COMPLETED,
  JobStatus.PARTIAL,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
]);

const TERMINAL_EVENTS = new Set<ProcessingEvent['kind']>([
  ProcessingEventKind.JOB_COMPLETED,
  ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
  ProcessingEventKind.JOB_FAILED,
  ProcessingEventKind.JOB_CANCELLED,
]);

const TRANSITIONS: Record<JobStatus, ReadonlySet<JobStatus>> = {
  [JobStatus.DRAFT]: new Set([JobStatus.PREVIEWING]),
  [JobStatus.PREVIEWING]: new Set([JobStatus.PREVIEW_READY, JobStatus.FAILED, JobStatus.CANCELLED]),
  [JobStatus.PREVIEW_READY]: new Set([JobStatus.QUEUED, JobStatus.CANCELLING, JobStatus.CANCELLED]),
  [JobStatus.QUEUED]: new Set([
    JobStatus.PROCESSING,
    JobStatus.CANCELLING,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.PROCESSING]: new Set([
    JobStatus.CANCELLING,
    JobStatus.COMPLETED,
    JobStatus.PARTIAL,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
  ]),
  [JobStatus.CANCELLING]: new Set([JobStatus.FAILED, JobStatus.CANCELLED]),
  [JobStatus.COMPLETED]: new Set(),
  [JobStatus.PARTIAL]: new Set(),
  [JobStatus.FAILED]: new Set(),
  [JobStatus.CANCELLED]: new Set(),
};

function statusForEvent(event: ProcessingEvent): JobStatus | null {
  switch (event.kind) {
    case ProcessingEventKind.PREVIEW_STARTED:
      return JobStatus.PREVIEWING;
    case ProcessingEventKind.PREVIEW_PROGRESS:
      return null;
    case ProcessingEventKind.PREVIEW_READY:
      return JobStatus.PREVIEW_READY;
    case ProcessingEventKind.JOB_QUEUED:
      return JobStatus.QUEUED;
    case ProcessingEventKind.JOB_STARTED:
      return JobStatus.PROCESSING;
    case ProcessingEventKind.JOB_PROGRESS:
      return null;
    case ProcessingEventKind.JOB_CANCELLING:
      return JobStatus.CANCELLING;
    case ProcessingEventKind.JOB_COMPLETED:
      return JobStatus.COMPLETED;
    case ProcessingEventKind.JOB_PARTIALLY_COMPLETED:
      return JobStatus.PARTIAL;
    case ProcessingEventKind.JOB_FAILED:
      return JobStatus.FAILED;
    case ProcessingEventKind.JOB_CANCELLED:
      return JobStatus.CANCELLED;
  }
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Deterministic reducer for processing events. Rejected events never mutate
 * the snapshot, which makes replay, persistence, and renderer reconciliation
 * use the same rules.
 */
export class JobStateMachine {
  private readonly jobId: string;
  private status: JobStatus = JobStatus.DRAFT;
  private lastSequence = 0;
  private lastEventKind: ProcessingEvent['kind'] | null = null;
  private terminalEventKind: TerminalProcessingEventKind | null = null;

  constructor(jobId: string) {
    if (!jobId.trim()) {
      throw new Error('jobId must be a non-empty string');
    }
    this.jobId = jobId;
  }

  public snapshot(): JobStateSnapshot {
    return {
      jobId: this.jobId,
      status: this.status,
      lastSequence: this.lastSequence,
      lastEventKind: this.lastEventKind,
      terminalEventKind: this.terminalEventKind,
    };
  }

  public canAccept(event: ProcessingEvent): EventAcceptance {
    return this.evaluate(event, false);
  }

  public accept(event: ProcessingEvent): EventAcceptance {
    return this.evaluate(event, true);
  }

  private evaluate(event: ProcessingEvent, commit: boolean): EventAcceptance {
    if (event.jobId !== this.jobId) {
      return this.reject('job-id-mismatch');
    }

    if (!Number.isSafeInteger(event.sequence) || event.sequence <= 0) {
      return this.reject('invalid-sequence');
    }

    if (isTerminalJobStatus(this.status)) {
      return this.reject('already-terminal');
    }

    if (event.sequence <= this.lastSequence) {
      return this.reject('stale-sequence');
    }

    const nextStatus = statusForEvent(event);

    if (nextStatus === null) {
      const progressStatus =
        event.kind === ProcessingEventKind.PREVIEW_PROGRESS
          ? JobStatus.PREVIEWING
          : JobStatus.PROCESSING;
      if (this.status !== progressStatus) {
        return this.reject('invalid-transition');
      }
    } else if (!TRANSITIONS[this.status].has(nextStatus)) {
      return this.reject('invalid-transition');
    }

    const candidateStatus = nextStatus ?? this.status;
    const candidateTerminalEventKind = TERMINAL_EVENTS.has(event.kind)
      ? (event.kind as TerminalProcessingEventKind)
      : this.terminalEventKind;
    const candidateSnapshot: JobStateSnapshot = {
      jobId: this.jobId,
      status: candidateStatus,
      lastSequence: event.sequence,
      lastEventKind: event.kind,
      terminalEventKind: candidateTerminalEventKind,
    };

    if (commit) {
      this.status = candidateStatus;
      this.lastSequence = candidateSnapshot.lastSequence;
      this.lastEventKind = candidateSnapshot.lastEventKind;
      this.terminalEventKind = candidateTerminalEventKind;
    }

    return { accepted: true, snapshot: candidateSnapshot };
  }

  private reject(reason: EventRejectionReason): EventAcceptance {
    return { accepted: false, reason, snapshot: this.snapshot() };
  }
}
