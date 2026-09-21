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
import type { AuditDecision, AuditPage, AuditSampleResult } from '../shared/types/audit';

export interface ElectronAPI {
  getSystemInfo: () => Promise<Record<string, unknown>>;
  selectDirectory: () => Promise<string | null>;
  gatherTestRun: (request: {
    sourcePath: string;
    destinationPath: string;
    fileCount: number;
  }) => Promise<
    ProcessingResponseDTO<{
      temporarySourcePath: string;
      copiedFiles: number;
      scannedFiles: number;
    }>
  >;
  discardTestRun: (temporarySourcePath: string) => Promise<ProcessingResponseDTO<void>>;
  cancelTestRun: () => Promise<ProcessingResponseDTO<void>>;
  onTestRunProgress: (
    callback: (event: import('../main/services/TestRunCorpusBuilder').TestRunProgress) => void
  ) => () => void;
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
  getNormalizationAuditSummary: (request: {
    previewId: string;
  }) => Promise<ProcessingResponseDTO<unknown>>;
  getNormalizationAuditCohorts: (request: {
    previewId: string;
    limit: number;
    cursor?: string;
  }) => Promise<ProcessingResponseDTO<unknown>>;
  getNormalizationAuditSample: (request: {
    previewId: string;
    seed: string;
    targetSize: number;
  }) => Promise<ProcessingResponseDTO<AuditSampleResult>>;
  getNormalizationAuditRows: (request: {
    previewId: string;
    limit: number;
    cursor?: string;
  }) => Promise<ProcessingResponseDTO<AuditPage>>;
  getNormalizationAuditDecision: (request: {
    previewId: string;
    recordId: string;
  }) => Promise<ProcessingResponseDTO<AuditDecision | null>>;
  approveNormalizationAuditCohort: (request: {
    previewId: string;
    revision: string;
    cohortKey: string;
    approved: boolean;
  }) => Promise<ProcessingResponseDTO<unknown>>;
  dryRunNormalizationAudit: (request: {
    previewId: string;
    revision: string;
    limit: number;
    cursor?: string;
  }) => Promise<ProcessingResponseDTO<AuditPage>>;
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
