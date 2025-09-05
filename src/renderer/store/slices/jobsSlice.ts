import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface Job {
  id: string;
  type: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  filesProcessed: number;
  totalFiles: number;
  startTime: string;
  endTime?: string;
  error?: string;
}

export interface JobsState {
  jobs: Job[];
  activeJobId: string | null;
  isProcessing: boolean;
}

const initialState: JobsState = {
  jobs: [],
  activeJobId: null,
  isProcessing: false,
};

const jobsSlice = createSlice({
  name: 'jobs',
  initialState,
  reducers: {
    addJob: (state, action: PayloadAction<Job>) => {
      state.jobs.unshift(action.payload);
    },
    updateJob: (state, action: PayloadAction<Partial<Job> & { id: string }>) => {
      const index = state.jobs.findIndex((job) => job.id === action.payload.id);
      if (index !== -1) {
        state.jobs[index] = { ...state.jobs[index], ...action.payload };
      }
    },
    removeJob: (state, action: PayloadAction<string>) => {
      state.jobs = state.jobs.filter((job) => job.id !== action.payload);
    },
    setActiveJob: (state, action: PayloadAction<string | null>) => {
      state.activeJobId = action.payload;
      state.isProcessing = action.payload !== null;
    },
    clearCompletedJobs: (state) => {
      state.jobs = state.jobs.filter(
        (job) => job.status !== 'completed' && job.status !== 'failed'
      );
    },
  },
});

export const { addJob, updateJob, removeJob, setActiveJob, clearCompletedJobs } = jobsSlice.actions;

export default jobsSlice.reducer;
