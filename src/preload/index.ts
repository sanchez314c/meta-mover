import { contextBridge, ipcRenderer } from 'electron';

import type { AppConfigUpdate } from '../main/services/AppConfigStore';
import type {
  CancelProcessingRequestDTO,
  PreviewRequestDTO,
  ProcessingEvent,
  StartProcessingRequestDTO,
} from '../shared/types/processing';

const electronAPI = {
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),

  previewProcessing: (request: PreviewRequestDTO) =>
    ipcRenderer.invoke('processing:preview', request),
  startProcessing: (request: StartProcessingRequestDTO) =>
    ipcRenderer.invoke('processing:start', request),
  cancelProcessing: (request: CancelProcessingRequestDTO) =>
    ipcRenderer.invoke('processing:cancel', request),
  getProcessingHealth: () => ipcRenderer.invoke('processing:health'),
  getJobHistory: (limit?: number) => ipcRenderer.invoke('processing:history', limit),
  onProcessingEvent: (callback: (event: ProcessingEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ProcessingEvent) => callback(event);
    ipcRenderer.on('processing:event', listener);
    return () => ipcRenderer.removeListener('processing:event', listener);
  },

  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (update: AppConfigUpdate) => ipcRenderer.invoke('config:update', update),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openPath: (filePath: string) => ipcRenderer.invoke('system:openPath', filePath),
  getPath: (name: string) => ipcRenderer.invoke('system:getPath', name),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
