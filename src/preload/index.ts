import { contextBridge, ipcRenderer } from 'electron';

import type { AppConfigUpdate } from '../main/services/AppConfigStore';
import type {
  CancelProcessingRequestDTO,
  PreviewRequestDTO,
  ProcessingEvent,
  StartProcessingRequestDTO,
} from '../shared/types/processing';
import type {
  ReviewApplyRequestDTO,
  ReviewDryRunRequestDTO,
  ReviewGetRequestDTO,
  ReviewListRequestDTO,
} from '../shared/types/review';

const electronAPI = {
  getSystemInfo: () => ipcRenderer.invoke('system:info'),
  selectDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  gatherTestRun: (request: { sourcePath: string; destinationPath: string; fileCount: number }) =>
    ipcRenderer.invoke('test-run:gather', request),
  discardTestRun: (temporarySourcePath: string) =>
    ipcRenderer.invoke('test-run:discard', temporarySourcePath),
  cancelTestRun: () => ipcRenderer.invoke('test-run:cancel'),
  onTestRunProgress: (callback: (event: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on('test-run:progress', listener);
    return () => ipcRenderer.removeListener('test-run:progress', listener);
  },

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
  getNormalizationAuditSummary: (request: unknown) =>
    ipcRenderer.invoke('normalization-audit:summary', request),
  getNormalizationAuditCohorts: (request: unknown) =>
    ipcRenderer.invoke('normalization-audit:cohorts', request),
  getNormalizationAuditSample: (request: unknown) =>
    ipcRenderer.invoke('normalization-audit:sample', request),
  getNormalizationAuditRows: (request: unknown) =>
    ipcRenderer.invoke('normalization-audit:rows', request),
  getNormalizationAuditDecision: (request: unknown) =>
    ipcRenderer.invoke('normalization-audit:decision', request),
  approveNormalizationAuditCohort: (request: unknown) =>
    ipcRenderer.invoke('normalization-audit:approve', request),
  dryRunNormalizationAudit: (request: unknown) =>
    ipcRenderer.invoke('normalization-audit:dry-run', request),
  reviewList: (request: ReviewListRequestDTO) => ipcRenderer.invoke('review:list', request),
  reviewGet: (request: ReviewGetRequestDTO) => ipcRenderer.invoke('review:get', request),
  reviewDryRun: (request: ReviewDryRunRequestDTO) => ipcRenderer.invoke('review:dry-run', request),
  reviewApply: (request: ReviewApplyRequestDTO) => ipcRenderer.invoke('review:apply', request),

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
