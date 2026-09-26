import { JobStatus } from '../core/JobStateMachine';
import { CreateHistoryJobInput, HistoryJobSnapshot } from './JobHistoryStore';
import { CoordinatorHistoryPort } from './ProcessingCoordinator';
import { HistoryListPort } from './ProcessingIPCController';
import {
  JobHistoryDTO,
  ProcessingErrorDTO,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingStatisticsDTO,
  PreviewResultDTO,
} from '../../shared/types/processing';

export interface JobHistoryPersistencePort {
  createJob(input: CreateHistoryJobInput): Promise<HistoryJobSnapshot>;
  appendEvent(jobId: string, event: ProcessingEvent): Promise<HistoryJobSnapshot>;
  listJobs(): Promise<readonly HistoryJobSnapshot[]>;
}

type DurableJobStatus = JobHistoryDTO['status'];

function statusFor(snapshot: HistoryJobSnapshot): DurableJobStatus {
  switch (snapshot.status) {
    case JobStatus.PREVIEW_READY:
      return 'preview-ready';
    case JobStatus.QUEUED:
      return 'queued';
    case JobStatus.PROCESSING:
      return 'processing';
    case JobStatus.CANCELLING:
      return 'cancelling';
    case JobStatus.COMPLETED:
      return 'completed';
    case JobStatus.PARTIAL:
      return 'partial';
    case JobStatus.FAILED:
      return 'failed';
    case JobStatus.CANCELLED:
      return 'cancelled';
    case JobStatus.DRAFT:
    case JobStatus.PREVIEWING:
      throw new Error(`Unsupported persisted status: ${snapshot.status}`);
  }
}

function latestEvent<K extends ProcessingEvent['kind']>(
  events: readonly Readonly<ProcessingEvent>[],
  kind: K
): Readonly<Extract<ProcessingEvent, { kind: K }>> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === kind) {
      return event as Readonly<Extract<ProcessingEvent, { kind: K }>>;
    }
  }
  return undefined;
}

function mapSnapshot(snapshot: HistoryJobSnapshot): JobHistoryDTO {
  const started = latestEvent(snapshot.events, ProcessingEventKind.JOB_STARTED);
  const progress = latestEvent(snapshot.events, ProcessingEventKind.JOB_PROGRESS);
  const completed = latestEvent(snapshot.events, ProcessingEventKind.JOB_COMPLETED);
  const partial = latestEvent(snapshot.events, ProcessingEventKind.JOB_PARTIALLY_COMPLETED);
  const failed = latestEvent(snapshot.events, ProcessingEventKind.JOB_FAILED);
  const cancelled = latestEvent(snapshot.events, ProcessingEventKind.JOB_CANCELLED);
  const terminal = completed ?? partial ?? failed ?? cancelled;
  const statistics =
    completed?.payload.statistics ??
    partial?.payload.statistics ??
    failed?.payload.statistics ??
    cancelled?.payload.statistics;
  const fileFailures =
    partial?.payload.fileFailures ??
    failed?.payload.fileFailures ??
    cancelled?.payload.fileFailures;
  let totalFiles = progress?.payload.totalFiles ?? snapshot.previewSummary.totalFiles;
  let filesProcessed = progress?.payload.filesProcessed ?? 0;
  let percentage = progress?.payload.percentage ?? (totalFiles === 0 ? 100 : 0);
  if (statistics) {
    totalFiles = statistics.totalFiles;
    filesProcessed = statistics.processedFiles;
    percentage = totalFiles === 0 ? 100 : (filesProcessed / totalFiles) * 100;
  }

  return {
    jobId: snapshot.jobId,
    previewId: snapshot.previewId,
    ...(snapshot.inventoryIssues === undefined
      ? {}
      : { inventoryIssues: snapshot.inventoryIssues.map((issue) => ({ ...issue })) }),
    status: statusFor(snapshot),
    sourcePaths: [...snapshot.sourcePaths],
    destinationPath: snapshot.destinationPath,
    effectiveOptions: { ...snapshot.effectiveOptions },
    createdAt: snapshot.createdAt,
    ...(started === undefined ? {} : { startedAt: started.emittedAt }),
    ...(terminal === undefined ? {} : { completedAt: terminal.emittedAt }),
    progress: { filesProcessed, totalFiles, percentage },
    ...(statistics === undefined
      ? {}
      : { statistics: { ...statistics } as ProcessingStatisticsDTO }),
    ...(fileFailures === undefined
      ? {}
      : { fileFailures: fileFailures.map((failure) => ({ ...failure })) }),
    ...(cancelled === undefined
      ? {}
      : {
          cancellationOutcomes: cancelled.payload.fileOutcomes.map((outcome) => ({ ...outcome })),
        }),
    ...(failed === undefined ? {} : { error: { ...failed.payload.error } as ProcessingErrorDTO }),
  };
}

/**
 * The sole bridge between coordinator hooks, durable append-only history, and
 * renderer-safe history DTOs. Terminal events are persisted by recordEvent;
 * no second terminal hook is exposed.
 */
export class CoordinatorJobHistoryAdapter implements CoordinatorHistoryPort, HistoryListPort {
  public constructor(private readonly persistence: JobHistoryPersistencePort) {}

  public async recordPreview(preview: Readonly<PreviewResultDTO>): Promise<void> {
    await this.persistence.createJob({
      jobId: preview.jobId,
      createdAt: preview.createdAt,
      previewId: preview.previewId,
      sourcePaths: [...preview.request.sourcePaths],
      destinationPath: preview.request.destinationPath,
      effectiveOptions: { ...preview.effectiveOptions },
      previewSummary: { ...preview.summary },
      ...(preview.inventoryIssues === undefined
        ? {}
        : { inventoryIssues: preview.inventoryIssues.map((issue) => ({ ...issue })) }),
      previewRows: (preview.rows ?? []).map((row) => ({
        ...row,
        dateEvidence: { ...row.dateEvidence, warnings: [...row.dateEvidence.warnings] },
        fingerprint: { ...row.fingerprint },
        warnings: [...row.warnings],
      })),
    });
  }

  public async recordEvent(event: Readonly<ProcessingEvent>): Promise<void> {
    await this.persistence.appendEvent(event.jobId, event as ProcessingEvent);
  }

  public async listJobs(limit: number = 50): Promise<JobHistoryDTO[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError('History limit must be an integer from 1 through 200');
    }
    const snapshots = await this.persistence.listJobs();
    return [...snapshots]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(mapSnapshot);
  }
}
