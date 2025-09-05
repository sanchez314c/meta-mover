export interface ElectronAPI {
  // System
  getSystemInfo: () => Promise<Record<string, unknown>>;

  // Dialog / File Selection
  selectDirectory: () => Promise<string | null>;
  selectFiles: () => Promise<string[] | null>;

  // Processing
  startProcessing: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  pauseProcessing: (jobId: string) => Promise<void>;
  resumeProcessing: (jobId: string) => Promise<void>;
  cancelProcessing: (jobId: string) => Promise<void>;
  checkDependencies: () => Promise<Record<string, unknown>>;

  // Processing event listeners
  onProgress: (callback: (progress: Record<string, unknown>) => void) => void;
  onProcessingComplete: (callback: (data: Record<string, unknown>) => void) => void;
  onProcessingError: (callback: (error: Record<string, unknown>) => void) => void;
  removeProcessingListeners: () => void;

  // Config
  getConfig: (key?: string) => Promise<Record<string, unknown>>;
  setConfig: (key: string, value: unknown) => Promise<void>;
  resetConfig: () => Promise<void>;

  // Database
  getJobs: (limit?: number) => Promise<Record<string, unknown>[]>;
  getJob: (id: number) => Promise<Record<string, unknown> | null>;

  // Window controls
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;

  // External
  openExternal: (url: string) => Promise<void>;

  // System paths
  openPath: (filePath: string) => Promise<void>;
  getPath: (name: string) => Promise<string>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
