import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  ProcessingCancellationFileOutcomeDTO,
  ProcessingEvent,
  ProcessingFileFailureDTO,
} from '../../../shared/types/processing';

export interface Job {
  id: string;
  type: string;
  status:
    | 'pending'
    | 'processing'
    | 'cancelling'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelled';
  progress: number;
  filesProcessed: number;
  totalFiles: number;
  skippedFiles?: number;
  failedFiles?: number;
  cancelledFiles?: number;
  unattemptedFiles?: number;
  committedResidueBytes?: number;
  fileFailures?: ProcessingFileFailureDTO[];
  cancellationOutcomes?: ProcessingCancellationFileOutcomeDTO[];
  startTime: string;
  endTime?: string;
  error?: string;
  lastSequence?: number;
}

export interface JobsState {
  jobs: Job[];
  activeJobId: string | null;
  isProcessing: boolean;
  previewBuild: PreviewBuild | null;
}

export interface PreviewBuild {
  jobId: string;
  status: 'previewing' | 'ready' | 'failed' | 'cancelled';
  phase: 'discovery' | 'metadata' | 'organization';
  filesProcessed: number;
  totalFiles: number;
  percentage: number;
  currentFile?: string;
  error?: string;
  lastSequence: number;
}

const initialState: JobsState = {
  jobs: [],
  activeJobId: null,
  isProcessing: false,
  previewBuild: null,
};

function isActiveStatus(status: Job['status']): boolean {
  return status === 'pending' || status === 'processing' || status === 'cancelling';
}

function refreshActivity(state: JobsState): void {
  const activeJobs = state.jobs.filter((job) => isActiveStatus(job.status));
  state.isProcessing = activeJobs.length > 0 || state.previewBuild?.status === 'previewing';
  if (!state.activeJobId || !activeJobs.some((job) => job.id === state.activeJobId)) {
    state.activeJobId = activeJobs[0]?.id ?? null;
  }
}

const jobsSlice = createSlice({
  name: 'jobs',
  initialState,
  reducers: {
    addJob: (state, action: PayloadAction<Job>) => {
      const index = state.jobs.findIndex((job) => job.id === action.payload.id);
      if (index === -1) state.jobs.unshift(action.payload);
      else state.jobs[index] = { ...state.jobs[index], ...action.payload };
      refreshActivity(state);
    },
    updateJob: (state, action: PayloadAction<Partial<Job> & { id: string }>) => {
      const index = state.jobs.findIndex((job) => job.id === action.payload.id);
      if (index !== -1) {
        state.jobs[index] = { ...state.jobs[index], ...action.payload };
      }
      refreshActivity(state);
    },
    removeJob: (state, action: PayloadAction<string>) => {
      state.jobs = state.jobs.filter((job) => job.id !== action.payload);
      refreshActivity(state);
    },
    setActiveJob: (state, action: PayloadAction<string | null>) => {
      state.activeJobId = action.payload;
      refreshActivity(state);
    },
    clearCompletedJobs: (state) => {
      state.jobs = state.jobs.filter(
        (job) => job.status !== 'completed' && job.status !== 'partial' && job.status !== 'failed'
      );
      refreshActivity(state);
    },
    clearPreviewBuild: (state) => {
      state.previewBuild = null;
      refreshActivity(state);
    },
    applyProcessingEvent: (state, action: PayloadAction<ProcessingEvent>) => {
      const event = action.payload;
      if (event.kind === 'preview-started') {
        if (
          state.previewBuild?.status === 'previewing' &&
          state.previewBuild.jobId !== event.jobId
        ) {
          return;
        }
        if (
          state.previewBuild?.jobId === event.jobId &&
          event.sequence <= state.previewBuild.lastSequence
        ) {
          return;
        }
        state.previewBuild = {
          jobId: event.jobId,
          status: 'previewing',
          phase: 'discovery',
          filesProcessed: 0,
          totalFiles: 0,
          percentage: 0,
          lastSequence: event.sequence,
        };
        refreshActivity(state);
        return;
      }
      if (event.kind === 'preview-progress') {
        const preview = state.previewBuild;
        if (
          !preview ||
          preview.jobId !== event.jobId ||
          preview.status !== 'previewing' ||
          event.sequence <= preview.lastSequence
        ) {
          return;
        }
        state.previewBuild = {
          jobId: event.jobId,
          status: 'previewing',
          phase: event.payload.phase as PreviewBuild['phase'],
          filesProcessed: event.payload.filesProcessed,
          totalFiles: event.payload.totalFiles,
          percentage: event.payload.percentage,
          ...(event.payload.currentFile === undefined
            ? {}
            : { currentFile: event.payload.currentFile }),
          lastSequence: event.sequence,
        };
        refreshActivity(state);
        return;
      }
      if (event.kind === 'preview-ready') {
        if (
          state.previewBuild?.jobId === event.jobId &&
          event.sequence > state.previewBuild.lastSequence
        ) {
          state.previewBuild = {
            ...state.previewBuild,
            status: 'ready',
            phase: 'organization',
            filesProcessed: event.payload.summary.totalFiles,
            totalFiles: event.payload.summary.totalFiles,
            percentage: 100,
            currentFile: undefined,
            lastSequence: event.sequence,
          };
          refreshActivity(state);
        }
        return;
      }
      if (
        event.kind === 'job-failed' &&
        state.previewBuild?.jobId === event.jobId &&
        state.previewBuild.status === 'previewing'
      ) {
        if (event.sequence <= state.previewBuild.lastSequence) return;
        state.previewBuild = {
          ...state.previewBuild,
          status: event.payload.error.code === 'PREVIEW_CANCELLED' ? 'cancelled' : 'failed',
          error: event.payload.error.message,
          currentFile: undefined,
          lastSequence: event.sequence,
        };
        refreshActivity(state);
        return;
      }

      const existingIndex = state.jobs.findIndex((job) => job.id === event.jobId);
      if (event.kind === 'job-queued') {
        if (existingIndex !== -1) return;
        state.jobs.unshift({
          id: event.jobId,
          type: event.payload.effectiveOptions.operation,
          status: 'pending',
          progress: 0,
          filesProcessed: 0,
          totalFiles: 0,
          startTime: event.emittedAt,
          lastSequence: event.sequence,
        });
        state.activeJobId = event.jobId;
        refreshActivity(state);
        return;
      }

      if (existingIndex === -1) return;
      const job = state.jobs[existingIndex];
      if (job.lastSequence !== undefined && event.sequence <= job.lastSequence) return;
      if (!isActiveStatus(job.status)) return;
      job.lastSequence = event.sequence;

      switch (event.kind) {
        case 'job-started':
          if (job.status !== 'cancelling') job.status = 'processing';
          break;
        case 'job-progress':
          if (job.status !== 'cancelling') job.status = 'processing';
          job.progress = event.payload.percentage;
          job.filesProcessed = event.payload.filesProcessed;
          job.totalFiles = event.payload.totalFiles;
          break;
        case 'job-cancelling':
          job.status = 'cancelling';
          break;
        case 'job-completed':
          job.status = 'completed';
          job.filesProcessed = event.payload.statistics.processedFiles;
          job.totalFiles = event.payload.statistics.totalFiles;
          job.failedFiles = 0;
          job.skippedFiles = event.payload.statistics.skippedFiles;
          job.fileFailures = [];
          job.progress = job.totalFiles === 0 ? 100 : (job.filesProcessed / job.totalFiles) * 100;
          job.endTime = event.emittedAt;
          break;
        case 'job-partially-completed':
          job.status = 'partial';
          job.filesProcessed = event.payload.statistics.processedFiles;
          job.totalFiles = event.payload.statistics.totalFiles;
          job.failedFiles = event.payload.statistics.failedFiles;
          job.skippedFiles = event.payload.statistics.skippedFiles;
          job.fileFailures = event.payload.fileFailures.map((failure) => ({ ...failure }));
          job.progress = job.totalFiles === 0 ? 100 : (job.filesProcessed / job.totalFiles) * 100;
          job.endTime = event.emittedAt;
          break;
        case 'job-failed':
          job.status = 'failed';
          job.error = event.payload.error.message;
          if (event.payload.statistics) {
            job.filesProcessed = event.payload.statistics.processedFiles;
            job.totalFiles = event.payload.statistics.totalFiles;
            job.failedFiles = event.payload.statistics.failedFiles;
            job.skippedFiles = event.payload.statistics.skippedFiles;
            job.progress = job.totalFiles === 0 ? 100 : (job.filesProcessed / job.totalFiles) * 100;
          }
          if (event.payload.fileFailures) {
            job.fileFailures = event.payload.fileFailures.map((failure) => ({ ...failure }));
          }
          job.endTime = event.emittedAt;
          break;
        case 'job-cancelled':
          job.status = 'cancelled';
          job.filesProcessed = event.payload.statistics.processedFiles;
          job.totalFiles = event.payload.statistics.totalFiles;
          job.skippedFiles = event.payload.statistics.skippedFiles;
          job.failedFiles = event.payload.statistics.failedFiles;
          job.cancelledFiles = event.payload.statistics.cancelledFiles;
          job.unattemptedFiles = event.payload.statistics.unattemptedFiles;
          job.committedResidueBytes = event.payload.statistics.committedResidueBytes;
          job.fileFailures = event.payload.fileFailures.map((failure) => ({ ...failure }));
          job.cancellationOutcomes = event.payload.fileOutcomes.map((outcome) => ({ ...outcome }));
          job.progress = job.totalFiles === 0 ? 100 : (job.filesProcessed / job.totalFiles) * 100;
          job.endTime = event.emittedAt;
          break;
      }
      refreshActivity(state);
    },
  },
});

export const {
  addJob,
  updateJob,
  removeJob,
  setActiveJob,
  clearCompletedJobs,
  clearPreviewBuild,
  applyProcessingEvent,
} = jobsSlice.actions;

export default jobsSlice.reducer;
