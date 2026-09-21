import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ProcessingSettings {
  maxConcurrentJobs: number;
  enableGPU: boolean;
  preserveOriginals: boolean;
  defaultOutputPath: string;
}

interface OrganizationSettings {
  dateFormat: string;
  folderStructure: 'year/month' | 'year' | 'year-month' | 'flat';
  conflictResolution: 'skip' | 'rename' | 'overwrite';
}

export interface SettingsState {
  theme: 'light' | 'dark' | 'system';
  language: string;
  processing: ProcessingSettings;
  organization: OrganizationSettings;
}

const initialState: SettingsState = {
  theme: 'system',
  language: 'en',
  processing: {
    maxConcurrentJobs: 4,
    enableGPU: false,
    preserveOriginals: true,
    defaultOutputPath: '',
  },
  organization: {
    dateFormat: 'YYYY/MM/DD',
    folderStructure: 'year/month',
    conflictResolution: 'rename',
  },
};

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setTheme: (state, action: PayloadAction<'light' | 'dark' | 'system'>) => {
      state.theme = action.payload;
    },
    setLanguage: (state, action: PayloadAction<string>) => {
      state.language = action.payload;
    },
    updateProcessingSettings: (state, action: PayloadAction<Partial<ProcessingSettings>>) => {
      state.processing = { ...state.processing, ...action.payload };
    },
    updateOrganizationSettings: (state, action: PayloadAction<Partial<OrganizationSettings>>) => {
      state.organization = { ...state.organization, ...action.payload };
    },
    resetSettings: () => initialState,
  },
});

export const {
  setTheme,
  setLanguage,
  updateProcessingSettings,
  updateOrganizationSettings,
  resetSettings,
} = settingsSlice.actions;

export default settingsSlice.reducer;
