import type { AppConfig, AppConfigUpdate } from '../services/AppConfigStore';
import type {
  CoordinatorHistoryPort,
  OperationExecutorPort,
  PreviewPlannerPort,
  PreviewRevalidatorPort,
} from '../services/ProcessingCoordinator';
import type { MetadataCollectionPort } from '../services/MediaPreviewPlanner';
import type { RuntimeReadinessPort } from '../services/MediaPreviewRevalidator';
import type {
  ConfigIpcPort,
  HistoryListPort,
  ProcessingCoordinatorPort,
  RuntimeHealthPort,
} from '../services/ProcessingIPCController';

type MaybePromise<T> = T | Promise<T>;

export interface ApplicationConfigPort extends ConfigIpcPort {
  getAll(): AppConfig;
  update(update: AppConfigUpdate): Promise<AppConfig>;
  reset(): Promise<AppConfig>;
  close(): Promise<void>;
}

export interface ApplicationHistoryPort {
  coordinator: CoordinatorHistoryPort;
  list: HistoryListPort;
  close(): Promise<void>;
}

/** Owns all per-job evidence manifests created during the process lifetime. */
export interface ApplicationEvidencePort extends CoordinatorHistoryPort {
  shutdown(): Promise<void>;
}

/** Owns the packaged one-shot metadata reader. */
export interface ApplicationMetadataPort extends MetadataCollectionPort {
  close(): Promise<void>;
}

export interface ApplicationRuntimeHealthPort extends RuntimeHealthPort, RuntimeReadinessPort {}

export interface ApplicationTransactionPort extends OperationExecutorPort {
  close(): Promise<void>;
}

export interface ApplicationCoordinatorPort extends ProcessingCoordinatorPort {
  /** Stops admission, settles active atomic operations, and drains history/evidence writes. */
  shutdown(): Promise<void>;
}

export interface ApplicationIpcPort {
  register(): MaybePromise<void>;
  dispose(): MaybePromise<void>;
}

export interface ApplicationRuntimeComponents {
  config: ApplicationConfigPort;
  history: ApplicationHistoryPort;
  evidence: ApplicationEvidencePort;
  runtime: ApplicationRuntimeHealthPort;
  metadata: ApplicationMetadataPort;
  planner: PreviewPlannerPort;
  revalidator: PreviewRevalidatorPort;
  transaction: ApplicationTransactionPort;
  coordinator: ApplicationCoordinatorPort;
  ipc: ApplicationIpcPort;
}

export interface ApplicationRuntimeFactories {
  openConfig(): Promise<ApplicationConfigPort>;
  openHistory(): Promise<ApplicationHistoryPort>;
  openEvidence(): Promise<ApplicationEvidencePort>;
  verifyRuntime(): Promise<ApplicationRuntimeHealthPort>;
  openMetadata(context: {
    runtime: ApplicationRuntimeHealthPort;
  }): Promise<ApplicationMetadataPort>;
  createPlanner(context: { metadata: ApplicationMetadataPort }): MaybePromise<PreviewPlannerPort>;
  createRevalidator(context: {
    runtime: ApplicationRuntimeHealthPort;
  }): MaybePromise<PreviewRevalidatorPort>;
  openTransaction(): Promise<ApplicationTransactionPort>;
  createCoordinator(context: {
    config: ApplicationConfigPort;
    history: CoordinatorHistoryPort;
    runtime: ApplicationRuntimeHealthPort;
    planner: PreviewPlannerPort;
    revalidator: PreviewRevalidatorPort;
    transaction: ApplicationTransactionPort;
  }): MaybePromise<ApplicationCoordinatorPort>;
  createIpc(context: {
    config: ApplicationConfigPort;
    history: HistoryListPort;
    runtime: ApplicationRuntimeHealthPort;
    coordinator: ApplicationCoordinatorPort;
  }): MaybePromise<ApplicationIpcPort>;
}

export interface ApplicationRuntimeFailure {
  step: string;
  error: unknown;
}

export interface CoordinatorHistoryFanoutFailure {
  sink: 'history' | 'evidence';
  error: unknown;
}

export class CoordinatorHistoryFanoutError extends Error {
  constructor(
    public readonly operation: keyof CoordinatorHistoryPort,
    public readonly failures: readonly CoordinatorHistoryFanoutFailure[]
  ) {
    super(
      `Coordinator persistence ${operation} failed at: ${failures
        .map((failure) => failure.sink)
        .join(', ')}`
    );
    this.name = 'CoordinatorHistoryFanoutError';
  }
}

export class ApplicationRuntimeStartupError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly rollbackFailures: readonly ApplicationRuntimeFailure[]
  ) {
    super(`Application runtime startup failed: ${errorMessage(cause)}`);
    this.name = 'ApplicationRuntimeStartupError';
  }
}

export class ApplicationRuntimeShutdownError extends Error {
  constructor(public readonly failures: readonly ApplicationRuntimeFailure[]) {
    super(
      `Application runtime shutdown failed at: ${failures.map((failure) => failure.step).join(', ')}`
    );
    this.name = 'ApplicationRuntimeShutdownError';
  }
}

interface CleanupStep {
  name: string;
  order: number;
  run(): MaybePromise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCleanup(steps: readonly CleanupStep[]): Promise<ApplicationRuntimeFailure[]> {
  const failures: ApplicationRuntimeFailure[] = [];
  for (const step of [...steps].sort((left, right) => left.order - right.order)) {
    try {
      await step.run();
    } catch (error) {
      failures.push({ step: step.name, error });
    }
  }
  return failures;
}

interface CoordinatorHistoryHook {
  sink: CoordinatorHistoryFanoutFailure['sink'];
  run(): MaybePromise<void> | undefined;
}

async function runHooks(
  operation: keyof CoordinatorHistoryPort,
  hooks: readonly CoordinatorHistoryHook[]
): Promise<void> {
  const results = await Promise.allSettled(hooks.map(async (hook) => hook.run()));
  const failures = results.flatMap((result, index): CoordinatorHistoryFanoutFailure[] =>
    result.status === 'rejected' ? [{ sink: hooks[index].sink, error: result.reason }] : []
  );
  if (failures.length > 0) throw new CoordinatorHistoryFanoutError(operation, failures);
}

function composeCoordinatorHistory(
  history: CoordinatorHistoryPort,
  evidence: CoordinatorHistoryPort
): CoordinatorHistoryPort {
  const composed: CoordinatorHistoryPort = {
    recordPreview: (preview, audit) =>
      runHooks('recordPreview', [
        // The full candidate record can contain raw embedded metadata. Keep it
        // inside the private evidence sink; ordinary job history receives only
        // the reduced transport-safe preview DTO.
        { sink: 'history', run: () => history.recordPreview?.(preview) },
        { sink: 'evidence', run: () => evidence.recordPreview?.(preview, audit) },
      ]),
    recordEvent: (event) =>
      runHooks('recordEvent', [
        { sink: 'history', run: () => history.recordEvent?.(event) },
        { sink: 'evidence', run: () => evidence.recordEvent?.(event) },
      ]),
    recordLedgerEntry: (record) =>
      runHooks('recordLedgerEntry', [
        { sink: 'history', run: () => history.recordLedgerEntry?.(record) },
        { sink: 'evidence', run: () => evidence.recordLedgerEntry?.(record) },
      ]),
    recordStartRejection: (record) =>
      runHooks('recordStartRejection', [
        { sink: 'history', run: () => history.recordStartRejection?.(record) },
        { sink: 'evidence', run: () => evidence.recordStartRejection?.(record) },
      ]),
    recordTerminal: (event) =>
      runHooks('recordTerminal', [
        { sink: 'history', run: () => history.recordTerminal?.(event) },
        { sink: 'evidence', run: () => evidence.recordTerminal?.(event) },
      ]),
  };
  return Object.freeze(composed);
}

/**
 * Owns the process-wide canonical processing graph. Construction remains
 * dependency-injected so the Electron entry point is only responsible for OS
 * paths and concrete adapter selection, while lifecycle order is fixed here.
 */
export class ApplicationRuntime {
  private shutdownPromise?: Promise<void>;

  private constructor(
    public readonly components: Readonly<ApplicationRuntimeComponents>,
    private readonly cleanupSteps: readonly CleanupStep[]
  ) {}

  static async create(factories: ApplicationRuntimeFactories): Promise<ApplicationRuntime> {
    const cleanup: CleanupStep[] = [];
    try {
      const config = await factories.openConfig();
      cleanup.push({ name: 'config', order: 70, run: () => config.close() });

      const history = await factories.openHistory();
      cleanup.push({ name: 'history', order: 60, run: () => history.close() });

      const evidence = await factories.openEvidence();
      cleanup.push({ name: 'evidence', order: 40, run: () => evidence.shutdown() });

      const runtime = await factories.verifyRuntime();
      const metadata = await factories.openMetadata({ runtime });
      cleanup.push({ name: 'metadata', order: 50, run: () => metadata.close() });

      const planner = await factories.createPlanner({ metadata });
      const revalidator = await factories.createRevalidator({ runtime });
      const transaction = await factories.openTransaction();
      cleanup.push({ name: 'transaction', order: 30, run: () => transaction.close() });

      const coordinatorHistory = composeCoordinatorHistory(history.coordinator, evidence);
      const coordinator = await factories.createCoordinator({
        config,
        history: coordinatorHistory,
        runtime,
        planner,
        revalidator,
        transaction,
      });
      cleanup.push({ name: 'coordinator', order: 20, run: () => coordinator.shutdown() });

      const ipc = await factories.createIpc({
        config,
        history: history.list,
        runtime,
        coordinator,
      });
      cleanup.push({ name: 'ipc', order: 10, run: () => ipc.dispose() });

      await ipc.register();
      return new ApplicationRuntime(
        Object.freeze({
          config,
          history,
          evidence,
          runtime,
          metadata,
          planner,
          revalidator,
          transaction,
          coordinator,
          ipc,
        }),
        cleanup
      );
    } catch (error) {
      const rollbackFailures = await runCleanup(cleanup);
      throw new ApplicationRuntimeStartupError(error, rollbackFailures);
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    const failures = await runCleanup(this.cleanupSteps);
    if (failures.length > 0) throw new ApplicationRuntimeShutdownError(failures);
  }
}
