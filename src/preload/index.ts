import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // System
  getSystemInfo: () => ipcRenderer.invoke('system:info'),

  // Dialog / File Selection
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  selectFiles: () => ipcRenderer.invoke('dialog:openFiles'),

  // Processing
  startProcessing: (options: unknown) => ipcRenderer.invoke('processing:start', options),
  pauseProcessing: (jobId: string) => ipcRenderer.invoke('processing:pause', jobId),
  resumeProcessing: (jobId: string) => ipcRenderer.invoke('processing:resume', jobId),
  cancelProcessing: (jobId: string) => ipcRenderer.invoke('processing:cancel', jobId),
  checkDependencies: () => ipcRenderer.invoke('system:checkDependencies'),

  // Processing event listeners — each call replaces the previous listener
  // (removeAllListeners first) so navigating back and forth does not stack handlers.
  onProgress: (callback: (progress: unknown) => void) => {
    ipcRenderer.removeAllListeners('processing:progress');
    ipcRenderer.on('processing:progress', (_, progress) => callback(progress));
  },
  onProcessingComplete: (callback: (data: unknown) => void) => {
    ipcRenderer.removeAllListeners('processing:complete');
    ipcRenderer.on('processing:complete', (_, data) => callback(data));
  },
  onProcessingError: (callback: (error: unknown) => void) => {
    ipcRenderer.removeAllListeners('processing:error');
    ipcRenderer.on('processing:error', (_, error) => callback(error));
  },
  removeProcessingListeners: () => {
    ipcRenderer.removeAllListeners('processing:progress');
    ipcRenderer.removeAllListeners('processing:complete');
    ipcRenderer.removeAllListeners('processing:error');
  },

  // Config
  getConfig: (key?: string) => ipcRenderer.invoke('config:get', key),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke('config:set', key, value),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  // Database
  getJobs: (limit?: number) => ipcRenderer.invoke('db:getJobs', limit),
  getJob: (id: number) => ipcRenderer.invoke('db:getJob', id),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),

  // External URL opener
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // System paths
  openPath: (filePath: string) => ipcRenderer.invoke('system:openPath', filePath),
  getPath: (name: string) => ipcRenderer.invoke('system:getPath', name),
});
