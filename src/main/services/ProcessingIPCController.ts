import { AppConfig, AppConfigStore, AppConfigUpdate } from './AppConfigStore';
import {
  CoordinatorPreviewRequest,
  ProcessingCoordinator,
  ProcessingCoordinatorError,
} from './ProcessingCoordinator';
import { BundledRuntimeHealth } from '../tools/BundledRuntimeHealth';
import {
  CancelProcessingRequestDTO,
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  ProcessingEvent,
  ProcessingOptionsDTO,
  ProcessingResponseDTO,
  PreviewResultDTO,
  StartProcessingRequestDTO,
  StartProcessingResultDTO,
} from '../../shared/types/processing';

export const PROCESSING_IPC_CHANNELS = Object.freeze([
  'processing:preview',
  'processing:start',
  'processing:cancel',
  'processing:health',
  'processing:history',
  'config:get',
  'config:update',
  'config:reset',
] as const);

type ProcessingIpcChannel = (typeof PROCESSING_IPC_CHANNELS)[number];

export interface IpcRegistrarPort {
  handle(
    channel: string,
    handler: (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>
  ): void;
  removeHandler(channel: string): void;
}

export interface ProcessingCoordinatorPort {
  createPreview(request: CoordinatorPreviewRequest): Promise<Readonly<PreviewResultDTO>>;
  startProcessing(request: StartProcessingRequestDTO): Promise<Readonly<StartProcessingResultDTO>>;
  cancelProcessing(jobId: string, reason?: string): Promise<void>;
  subscribe(listener: (event: Readonly<ProcessingEvent>) => void): () => void;
}

export interface RuntimeHealthPort {
  getHealth(): Promise<unknown>;
}

export interface HistoryListPort {
  listJobs(limit?: number): Promise<unknown>;
}

export interface ConfigIpcPort {
  getAll(): AppConfig | unknown;
  update(update: AppConfigUpdate): Promise<AppConfig | unknown>;
  reset(): Promise<AppConfig | unknown>;
}

export interface ProcessingIPCDependencies {
  ipc: IpcRegistrarPort;
  coordinator: ProcessingCoordinatorPort;
  health: RuntimeHealthPort;
  history: HistoryListPort;
  config: ConfigIpcPort;
  publishEvent(event: Readonly<ProcessingEvent>): void;
}

class IPCValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IPCValidationError';
  }
}

export class ProcessingIPCCleanupError extends Error {
  public readonly errors: readonly unknown[];

  constructor(message: string, errors: readonly unknown[]) {
    super(message);
    this.name = 'ProcessingIPCCleanupError';
    this.errors = [...errors];
  }
}

function dataRecord(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IPCValidationError('Request must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new IPCValidationError('Request must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      !allowedKeys.includes(key) ||
      !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')
    ) {
      throw new IPCValidationError(`Unknown or unsafe request field: ${String(key)}`);
    }
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  );
}

function parseOptions(value: unknown): ProcessingOptionsDTO {
  const options = dataRecord(value, [
    'operation',
    'conflictPolicy',
    'folderStructure',
    'appendScreenshotSuffix',
    'workerCount',
    'verifyIntegrity',
    'writeMetadataDates',
  ]);
  if (
    !Object.values(OperationMode).includes(options.operation as OperationMode) ||
    !Object.values(ConflictPolicy).includes(options.conflictPolicy as ConflictPolicy) ||
    !Object.values(FolderStructure).includes(options.folderStructure as FolderStructure) ||
    typeof options.appendScreenshotSuffix !== 'boolean' ||
    !Number.isSafeInteger(options.workerCount) ||
    (options.workerCount as number) < 1 ||
    (options.workerCount as number) > 10 ||
    options.verifyIntegrity !== true ||
    options.writeMetadataDates !== false
  ) {
    throw new IPCValidationError('Processing options are invalid');
  }
  return options as unknown as ProcessingOptionsDTO;
}

function parsePreview(value: unknown): CoordinatorPreviewRequest {
  const request = dataRecord(value, ['sourcePaths', 'destinationPath', 'options']);
  if (
    !Array.isArray(request.sourcePaths) ||
    request.sourcePaths.length === 0 ||
    request.sourcePaths.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    typeof request.destinationPath !== 'string' ||
    request.destinationPath.length === 0
  ) {
    throw new IPCValidationError('Preview paths are invalid');
  }
  return {
    sourcePaths: [...request.sourcePaths] as string[],
    destinationPath: request.destinationPath,
    options: parseOptions(request.options),
  };
}

function parseStart(value: unknown): StartProcessingRequestDTO {
  const request = dataRecord(value, ['previewId', 'acknowledgeDestructiveOperation']);
  if (
    typeof request.previewId !== 'string' ||
    request.previewId.length === 0 ||
    typeof request.acknowledgeDestructiveOperation !== 'boolean'
  ) {
    throw new IPCValidationError('Start request is invalid');
  }
  return {
    previewId: request.previewId,
    acknowledgeDestructiveOperation: request.acknowledgeDestructiveOperation,
  };
}

function parseCancel(value: unknown): CancelProcessingRequestDTO {
  const request = dataRecord(value, ['jobId', 'reason']);
  if (
    typeof request.jobId !== 'string' ||
    request.jobId.length === 0 ||
    request.jobId.length > 128 ||
    (request.reason !== undefined &&
      (typeof request.reason !== 'string' || request.reason.length > 500))
  ) {
    throw new IPCValidationError('Cancel request is invalid');
  }
  return {
    jobId: request.jobId,
    ...(request.reason === undefined ? {} : { reason: request.reason as string }),
  };
}

function parseHistoryLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 200) {
    throw new IPCValidationError('History limit must be an integer from 1 through 200');
  }
  return value as number;
}

function responseError(error: unknown): ProcessingResponseDTO<never> {
  if (error instanceof ProcessingCoordinatorError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        recoverable: !['INVALID_CONFIGURATION', 'INVALID_EVENT_TRANSITION'].includes(error.code),
        ...(error.details.length === 0 ? {} : { details: error.details.join('; ') }),
      },
    };
  }
  if (error instanceof IPCValidationError) {
    return {
      success: false,
      error: { code: 'INVALID_IPC_REQUEST', message: error.message, recoverable: true },
    };
  }
  return {
    success: false,
    error: {
      code: 'APPLICATION_ERROR',
      message: error instanceof Error ? error.message : 'Application operation failed',
      recoverable: false,
    },
  };
}

export class ProcessingIPCController {
  private unsubscribe?: () => void;
  private registered = false;
  private accepting = false;
  private readonly ownedChannels = new Set<ProcessingIpcChannel>();

  constructor(private readonly dependencies: ProcessingIPCDependencies) {}

  register(): void {
    if (this.registered || this.ownedChannels.size > 0 || this.unsubscribe) {
      throw new Error('Processing IPC controller is already registered');
    }
    try {
      this.handle('processing:preview', async (value) => {
        const request = parsePreview(value);
        return {
          success: true,
          data: await this.dependencies.coordinator.createPreview(request),
        };
      });
      this.handle('processing:start', async (value) => ({
        success: true,
        data: await this.dependencies.coordinator.startProcessing(parseStart(value)),
      }));
      this.handle('processing:cancel', async (value) => {
        const request = parseCancel(value);
        await this.dependencies.coordinator.cancelProcessing(request.jobId, request.reason);
        return { success: true };
      });
      this.handle('processing:health', async () => ({
        success: true,
        data: await this.dependencies.health.getHealth(),
      }));
      this.handle('processing:history', async (value) => ({
        success: true,
        data: await this.dependencies.history.listJobs(parseHistoryLimit(value)),
      }));
      this.handle('config:get', async () => ({
        success: true,
        data: this.dependencies.config.getAll(),
      }));
      this.handle('config:update', async (value) => ({
        success: true,
        data: await this.dependencies.config.update(
          dataRecord(value, [
            'theme',
            'windowBounds',
            'processing',
            'organization',
          ]) as AppConfigUpdate
        ),
      }));
      this.handle('config:reset', async () => ({
        success: true,
        data: await this.dependencies.config.reset(),
      }));
      const unsubscribe = this.dependencies.coordinator.subscribe((event) => {
        if (this.accepting) this.dependencies.publishEvent(event);
      });
      if (typeof unsubscribe !== 'function') {
        throw new Error('Processing event subscription did not return a cleanup function');
      }
      this.unsubscribe = unsubscribe;
      this.registered = true;
      this.accepting = true;
    } catch (error) {
      this.accepting = false;
      this.registered = false;
      const cleanupFailures = this.removeOwnedHandlers();
      if (cleanupFailures.length > 0) {
        throw new ProcessingIPCCleanupError(
          `Processing IPC registration rollback failed: ${[error, ...cleanupFailures]
            .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
            .join('; ')}`,
          [error, ...cleanupFailures]
        );
      }
      throw error;
    }
  }

  dispose(): void {
    if (!this.registered && this.ownedChannels.size === 0 && !this.unsubscribe) return;
    this.accepting = false;
    this.registered = false;
    const failures: unknown[] = [];
    const unsubscribe = this.unsubscribe;
    if (unsubscribe) {
      try {
        unsubscribe();
        this.unsubscribe = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    failures.push(...this.removeOwnedHandlers());
    if (failures.length > 0) {
      throw new ProcessingIPCCleanupError(
        `Processing IPC cleanup failed: ${failures
          .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
          .join('; ')}`,
        failures
      );
    }
  }

  private handle(
    channel: ProcessingIpcChannel,
    operation: (...args: unknown[]) => Promise<ProcessingResponseDTO<unknown>>
  ): void {
    this.dependencies.ipc.handle(channel, async (_event, ...args) => {
      try {
        if (!this.accepting) throw new Error('Processing IPC controller is not accepting requests');
        return await operation(...args);
      } catch (error) {
        return responseError(error);
      }
    });
    this.ownedChannels.add(channel);
  }

  private removeOwnedHandlers(): unknown[] {
    const failures: unknown[] = [];
    for (const channel of [...this.ownedChannels]) {
      try {
        this.dependencies.ipc.removeHandler(channel);
        this.ownedChannels.delete(channel);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}

export type DefaultProcessingIPCDependencies = {
  coordinator: ProcessingCoordinator;
  health: BundledRuntimeHealth;
  config: AppConfigStore;
};
