/**
 * App State Slice - Global application state management
 */

import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';

interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion: string;
  appVersion: string;
  cpuCount: number;
  totalMemory: number;
  freeMemory: number;
}

export interface AppState {
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;
  systemInfo: SystemInfo | null;
  activeJobs: number;
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
  lastActivity: string | null;
  sidebarCollapsed: boolean;
}

const initialState: AppState = {
  isInitialized: false,
  isLoading: false,
  error: null,
  systemInfo: null,
  activeJobs: 0,
  connectionStatus: 'connected',
  lastActivity: null,
  sidebarCollapsed: false,
};

// Async thunks
export const initializeApp = createAsyncThunk('app/initialize', async (_, { rejectWithValue }) => {
  try {
    // Get system info via IPC
    const systemInfo = await window.electronAPI?.getSystemInfo();

    return { systemInfo };
  } catch (error) {
    return rejectWithValue(error instanceof Error ? error.message : 'Initialization failed');
  }
});

const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },

    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },

    clearError: (state) => {
      state.error = null;
    },

    setActiveJobsCount: (state, action: PayloadAction<number>) => {
      state.activeJobs = action.payload;
    },

    setConnectionStatus: (
      state,
      action: PayloadAction<'connected' | 'disconnected' | 'reconnecting'>
    ) => {
      state.connectionStatus = action.payload;
    },

    updateLastActivity: (state) => {
      state.lastActivity = new Date().toISOString();
    },

    toggleSidebar: (state) => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },

    setSidebarCollapsed: (state, action: PayloadAction<boolean>) => {
      state.sidebarCollapsed = action.payload;
    },
  },

  extraReducers: (builder) => {
    // Initialize app
    builder
      .addCase(initializeApp.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(initializeApp.fulfilled, (state, action) => {
        state.isLoading = false;
        state.isInitialized = true;
        state.systemInfo = (action.payload.systemInfo as unknown as SystemInfo) ?? null;
        state.connectionStatus = 'connected';
        state.lastActivity = new Date().toISOString();
      })
      .addCase(initializeApp.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload as string;
        state.connectionStatus = 'disconnected';
      });
  },
});

export const {
  setLoading,
  setError,
  clearError,
  setActiveJobsCount,
  setConnectionStatus,
  updateLastActivity,
  toggleSidebar,
  setSidebarCollapsed,
} = appSlice.actions;

export default appSlice;
