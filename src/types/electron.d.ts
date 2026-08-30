import type { AppConfig, AppConfigUpdate } from '../main/services/AppConfigStore';
import type {
  CancelProcessingRequestDTO,
  DependencyHealthDTO,
  JobHistoryDTO,
  PreviewRequestDTO,
  PreviewResultDTO,
  ProcessingEvent,
  ProcessingResponseDTO,
  StartProcessingRequestDTO,
  StartProcessingResultDTO,
} from '../shared/types/processing';

export interface ElectronAPI {
  getSystemInfo: () => Promise<Record<string, unknown>>;
  selectDirectory: () => Promise<string | null>;
  previewProcessing: (
    request: PreviewRequestDTO
  ) => Promise<ProcessingResponseDTO<PreviewResultDTO>>;
  startProcessing: (
    request: StartProcessingRequestDTO
  ) => Promise<ProcessingResponseDTO<StartProcessingResultDTO>>;
  cancelProcessing: (request: CancelProcessingRequestDTO) => Promise<ProcessingResponseDTO<void>>;
  getProcessingHealth: () => Promise<ProcessingResponseDTO<DependencyHealthDTO>>;
  getJobHistory: (limit?: number) => Promise<ProcessingResponseDTO<JobHistoryDTO[]>>;
  onProcessingEvent: (callback: (event: ProcessingEvent) => void) => () => void;
  getConfig: () => Promise<ProcessingResponseDTO<AppConfig>>;
  updateConfig: (update: AppConfigUpdate) => Promise<ProcessingResponseDTO<AppConfig>>;
  resetConfig: () => Promise<ProcessingResponseDTO<AppConfig>>;
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openPath: (filePath: string) => Promise<ProcessingResponseDTO<void>>;
  getPath: (name: string) => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
