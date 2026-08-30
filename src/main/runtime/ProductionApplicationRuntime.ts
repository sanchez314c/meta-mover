import path from 'path';

import { MetadataCandidateCollector } from '../core/metadata/MetadataCandidateCollector';
import { NativeTransactionFilesystem } from '../core/transaction/NativeTransactionFilesystem';
import {
  BrokerLaunchTrustPolicy,
  developmentBrokerLaunchTrustPolicy,
  LinuxImmutableBrokerLaunchTrustPolicy,
  NativeFilesystemHelperClient,
} from '../native/NativeFilesystemHelperClient';
import { nativePackageBrokerLaunchTrustPolicy } from '../native/NativePackageTrustPolicies';
import { AppConfigStore } from '../services/AppConfigStore';
import { CoordinatorEvidenceAdapter } from '../services/CoordinatorEvidenceAdapter';
import { CoordinatorJobHistoryAdapter } from '../services/CoordinatorJobHistoryAdapter';
import { JobHistoryStore } from '../services/JobHistoryStore';
import { MediaPreviewPlanner } from '../services/MediaPreviewPlanner';
import { MediaPreviewRevalidator } from '../services/MediaPreviewRevalidator';
import { ProcessingCoordinator } from '../services/ProcessingCoordinator';
import {
  IpcRegistrarPort,
  ProcessingIPCController,
  ProcessingIPCDependencies,
} from '../services/ProcessingIPCController';
import { TransactionalOperationExecutor } from '../services/TransactionalOperationExecutor';
import { BundledExifToolAdapter } from '../tools/BundledExifToolAdapter';
import { BundledRuntimeHealth } from '../tools/BundledRuntimeHealth';
import {
  ApplicationConfigPort,
  ApplicationCoordinatorPort,
  ApplicationEvidencePort,
  ApplicationHistoryPort,
  ApplicationIpcPort,
  ApplicationMetadataPort,
  ApplicationRuntime,
  ApplicationRuntimeHealthPort,
  ApplicationTransactionPort,
} from './ApplicationRuntime';
import type {
  CoordinatorHistoryPort,
  PreviewPlannerPort,
  PreviewRevalidatorPort,
} from '../services/ProcessingCoordinator';
import type { ProcessingEvent, ProcessingOptionsDTO } from '../../shared/types/processing';

const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_WORKER_CONCURRENCY = 10;

export interface ProductionRuntimeOptions {
  resourcesRoot: string;
  configPath: string;
  historyPath: string;
  evidenceRoot: string;
  evidencePolicyVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  isPackaged: boolean;
  launchTrustPolicy?: BrokerLaunchTrustPolicy;
  ipc: IpcRegistrarPort;
  publishEvent(event: Readonly<ProcessingEvent>): void;
  previewTtlMs?: number;
  maxWorkerConcurrency?: number;
}

export interface ProductionRuntimeContext {
  resourcesRoot: string;
  platform: NodeJS.Platform;
  architecture: string;
  isPackaged: boolean;
  launchTrustPolicy: BrokerLaunchTrustPolicy;
}

export interface ProductionCoordinatorContext {
  config: ApplicationConfigPort;
  history: CoordinatorHistoryPort;
  runtime: ApplicationRuntimeHealthPort;
  planner: PreviewPlannerPort;
  revalidator: PreviewRevalidatorPort;
  transaction: ApplicationTransactionPort;
  previewTtlMs: number;
  maxWorkerConcurrency: number;
  defaultOptions: ProcessingOptionsDTO;
}

export interface ProductionRuntimeBindings {
  openConfig(configPath: string): Promise<ApplicationConfigPort>;
  openHistory(historyPath: string): Promise<ApplicationHistoryPort>;
  openEvidence(options: {
    evidenceRoot: string;
    policyVersion: string;
  }): Promise<ApplicationEvidencePort>;
  verifyRuntime(context: ProductionRuntimeContext): Promise<ApplicationRuntimeHealthPort>;
  openMetadata(
    context: ProductionRuntimeContext & { runtime: ApplicationRuntimeHealthPort }
  ): Promise<ApplicationMetadataPort>;
  createPlanner(metadata: ApplicationMetadataPort): PreviewPlannerPort;
  createRevalidator(runtime: ApplicationRuntimeHealthPort): PreviewRevalidatorPort;
  openTransaction(context: ProductionRuntimeContext): Promise<ApplicationTransactionPort>;
  createCoordinator(context: ProductionCoordinatorContext): ApplicationCoordinatorPort;
  createIpc(dependencies: ProcessingIPCDependencies): ApplicationIpcPort;
}

function canonicalAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be canonical and absolute`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

export function resolveProductionLaunchTrustPolicy(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  injected?: BrokerLaunchTrustPolicy
): BrokerLaunchTrustPolicy {
  if (injected) {
    if (injected.attestedPlatform !== 'development-any' && injected.attestedPlatform !== platform) {
      throw new Error('Broker trust policy attests a different platform');
    }
    if (isPackaged && injected.mode !== 'production') {
      throw new Error('Packaged runtime rejects a development broker trust policy');
    }
    return injected;
  }
  if (!isPackaged) return developmentBrokerLaunchTrustPolicy();
  if (platform === 'linux') return new LinuxImmutableBrokerLaunchTrustPolicy();
  return nativePackageBrokerLaunchTrustPolicy(platform);
}

const DEFAULT_BINDINGS: ProductionRuntimeBindings = {
  openConfig: (configPath) => AppConfigStore.open(configPath),
  openHistory: async (historyPath) => {
    const store = new JobHistoryStore(historyPath);
    await store.initialize();
    const adapter = new CoordinatorJobHistoryAdapter(store);
    return { coordinator: adapter, list: adapter, close: () => store.close() };
  },
  openEvidence: (options) => CoordinatorEvidenceAdapter.create(options),
  verifyRuntime: async (context) => {
    const runtime = new BundledRuntimeHealth(
      context.resourcesRoot,
      context.platform,
      context.architecture,
      () => Date.now(),
      {
        launchTrustPolicy: context.launchTrustPolicy,
        isPackaged: context.isPackaged,
      }
    );
    await runtime.verified();
    return runtime;
  },
  openMetadata: async (context) => {
    const adapter = await BundledExifToolAdapter.createPackaged(
      context.resourcesRoot,
      context.platform,
      undefined,
      {
        architecture: context.architecture,
        isPackaged: context.isPackaged,
        launchTrustPolicy: context.launchTrustPolicy,
      }
    );
    return new MetadataCandidateCollector(adapter);
  },
  createPlanner: (metadata) =>
    MediaPreviewPlanner.createDefault(metadata as MetadataCandidateCollector),
  createRevalidator: (runtime) => new MediaPreviewRevalidator({ runtime }),
  openTransaction: async (context) =>
    new TransactionalOperationExecutor({
      nativeFilesystemFactory: async ({ destinationRoot, controlRoot, sourceRoots }) => {
        const roots = NativeTransactionFilesystem.rootBindings(
          destinationRoot,
          controlRoot,
          sourceRoots
        );
        const client = await NativeFilesystemHelperClient.open({
          resourcesRoot: context.resourcesRoot,
          roots,
          platform: context.platform,
          architecture: context.architecture,
          launchTrustPolicy: context.launchTrustPolicy,
          isPackaged: context.isPackaged,
        });
        return new NativeTransactionFilesystem(client, destinationRoot, controlRoot, sourceRoots);
      },
    }),
  createCoordinator: (context) =>
    new ProcessingCoordinator({
      planner: context.planner,
      revalidator: context.revalidator,
      executor: context.transaction,
      history: context.history,
      previewTtlMs: context.previewTtlMs,
      maxWorkerConcurrency: context.maxWorkerConcurrency,
      defaultOptions: context.defaultOptions,
    }),
  createIpc: (dependencies) => new ProcessingIPCController(dependencies),
};

export async function createProductionApplicationRuntime(
  options: Readonly<ProductionRuntimeOptions>,
  bindings: ProductionRuntimeBindings = DEFAULT_BINDINGS
): Promise<ApplicationRuntime> {
  const resourcesRoot = canonicalAbsolute(options.resourcesRoot, 'resourcesRoot');
  const configPath = canonicalAbsolute(options.configPath, 'configPath');
  const historyPath = canonicalAbsolute(options.historyPath, 'historyPath');
  const evidenceRoot = canonicalAbsolute(options.evidenceRoot, 'evidenceRoot');
  if (!options.evidencePolicyVersion) throw new Error('evidencePolicyVersion must not be empty');
  const previewTtlMs = positiveSafeInteger(
    options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS,
    'previewTtlMs'
  );
  const maxWorkerConcurrency = positiveSafeInteger(
    options.maxWorkerConcurrency ?? DEFAULT_MAX_WORKER_CONCURRENCY,
    'maxWorkerConcurrency'
  );
  const launchTrustPolicy = resolveProductionLaunchTrustPolicy(
    options.platform,
    options.isPackaged,
    options.launchTrustPolicy
  );
  const runtimeContext: ProductionRuntimeContext = {
    resourcesRoot,
    platform: options.platform,
    architecture: options.architecture,
    isPackaged: options.isPackaged,
    launchTrustPolicy,
  };

  return ApplicationRuntime.create({
    openConfig: () => bindings.openConfig(configPath),
    openHistory: () => bindings.openHistory(historyPath),
    openEvidence: () =>
      bindings.openEvidence({
        evidenceRoot,
        policyVersion: options.evidencePolicyVersion,
      }),
    verifyRuntime: () => bindings.verifyRuntime(runtimeContext),
    openMetadata: ({ runtime }) => bindings.openMetadata({ ...runtimeContext, runtime }),
    createPlanner: ({ metadata }) => bindings.createPlanner(metadata),
    createRevalidator: ({ runtime }) => bindings.createRevalidator(runtime),
    openTransaction: () => bindings.openTransaction(runtimeContext),
    createCoordinator: ({ config, history, runtime, planner, revalidator, transaction }) => {
      const current = config.getAll();
      return bindings.createCoordinator({
        config,
        history,
        runtime,
        planner,
        revalidator,
        transaction,
        previewTtlMs,
        maxWorkerConcurrency,
        defaultOptions: {
          operation: current.processing.operation,
          conflictPolicy: current.organization.conflictPolicy,
          folderStructure: current.organization.folderStructure,
          workerCount: current.processing.workerCount,
          verifyIntegrity: true,
          writeMetadataDates: false,
        },
      });
    },
    createIpc: ({ config, history, runtime, coordinator }) =>
      bindings.createIpc({
        ipc: options.ipc,
        config,
        history,
        health: runtime,
        coordinator,
        publishEvent: options.publishEvent,
      }),
  });
}
