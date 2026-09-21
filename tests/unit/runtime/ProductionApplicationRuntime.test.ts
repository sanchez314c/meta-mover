import path from 'path';

import {
  createProductionApplicationRuntime,
  ProductionRuntimeBindings,
} from '../../../src/main/runtime/ProductionApplicationRuntime';
import {
  BrokerLaunchTrustPolicy,
  developmentBrokerLaunchTrustPolicy,
} from '../../../src/main/native/NativeFilesystemHelperClient';
import {
  OperationMode,
  ConflictPolicy,
  FolderStructure,
} from '../../../src/shared/types/processing';

function port<T extends object>(value: T): T {
  return value;
}

describe('ProductionApplicationRuntime', () => {
  function harness() {
    const policy = developmentBrokerLaunchTrustPolicy();
    const config = port({
      getAll: jest.fn().mockReturnValue({
        version: 3,
        theme: 'system',
        processing: {
          workerCount: 6,
          operation: OperationMode.COPY,
          verifyIntegrity: true,
          writeMetadataDates: true,
        },
        organization: {
          conflictPolicy: ConflictPolicy.RENAME,
          folderStructure: FolderStructure.YEAR_MONTH,
          appendScreenshotSuffix: false,
        },
      }),
      update: jest.fn(),
      reset: jest.fn(),
      close: jest.fn(),
    });
    const historyCoordinator = {};
    const historyList = { listJobs: jest.fn() };
    const history = { coordinator: historyCoordinator, list: historyList, close: jest.fn() };
    const evidence = { shutdown: jest.fn() };
    const audit = {
      summary: jest.fn(),
      cohorts: jest.fn(),
      sample: jest.fn(),
      rows: jest.fn(),
      decision: jest.fn(),
      approve: jest.fn(),
      dryRun: jest.fn(),
      authorizeNormalization: jest.fn(),
      close: jest.fn(),
    };
    const runtime = { verified: jest.fn(), getHealth: jest.fn(), check: jest.fn() };
    const metadata = { collectDetailed: jest.fn(), close: jest.fn() };
    const planner = { plan: jest.fn() };
    const revalidator = { revalidate: jest.fn() };
    const transaction = { execute: jest.fn(), close: jest.fn() };
    const coordinator = {
      createPreview: jest.fn(),
      startProcessing: jest.fn(),
      cancelProcessing: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => undefined),
      shutdown: jest.fn(),
    };
    const ipc = { register: jest.fn(), dispose: jest.fn() };
    const bindings: ProductionRuntimeBindings = {
      openConfig: jest.fn().mockResolvedValue(config),
      openHistory: jest.fn().mockResolvedValue(history),
      openEvidence: jest.fn().mockResolvedValue(evidence),
      openAudit: jest.fn().mockResolvedValue(audit),
      verifyRuntime: jest.fn().mockResolvedValue(runtime),
      openMetadata: jest.fn().mockResolvedValue(metadata),
      createPlanner: jest.fn().mockReturnValue(planner),
      createRevalidator: jest.fn().mockReturnValue(revalidator),
      openTransaction: jest.fn().mockResolvedValue(transaction),
      createCoordinator: jest.fn().mockReturnValue(coordinator),
      createIpc: jest.fn().mockReturnValue(ipc),
    };
    return {
      policy,
      config,
      history,
      evidence,
      audit,
      runtime,
      metadata,
      planner,
      revalidator,
      transaction,
      coordinator,
      ipc,
      bindings,
    };
  }

  it('composes every canonical owner with one launch trust policy and configured defaults', async () => {
    const test = harness();
    const publishEvent = jest.fn();
    const ipcRegistrar = { handle: jest.fn(), removeHandler: jest.fn() };
    const root = path.resolve('/tmp/meta-mover-production-runtime');

    const application = await createProductionApplicationRuntime(
      {
        resourcesRoot: path.join(root, 'resources'),
        configPath: path.join(root, 'config.json'),
        historyPath: path.join(root, 'history.jsonl'),
        evidenceRoot: path.join(root, 'evidence'),
        evidencePolicyVersion: 'date-resolution/1',
        platform: 'linux',
        architecture: 'x64',
        isPackaged: false,
        launchTrustPolicy: test.policy,
        ipc: ipcRegistrar,
        publishEvent,
      },
      test.bindings
    );

    expect(test.bindings.openConfig).toHaveBeenCalledWith(path.join(root, 'config.json'));
    expect(test.bindings.openHistory).toHaveBeenCalledWith(path.join(root, 'history.jsonl'));
    expect(test.bindings.openEvidence).toHaveBeenCalledWith({
      evidenceRoot: path.join(root, 'evidence'),
      policyVersion: 'date-resolution/1',
    });
    expect(test.bindings.openAudit).toHaveBeenCalledWith(path.join(root, 'evidence'));
    expect(test.bindings.verifyRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        resourcesRoot: path.join(root, 'resources'),
        platform: 'linux',
        architecture: 'x64',
        isPackaged: false,
        launchTrustPolicy: test.policy,
      })
    );
    expect(test.bindings.openMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ launchTrustPolicy: test.policy, runtime: test.runtime })
    );
    expect(test.bindings.openTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ launchTrustPolicy: test.policy }),
      test.audit
    );
    expect(test.bindings.createCoordinator).toHaveBeenCalledWith(
      expect.objectContaining({
        config: test.config,
        history: expect.any(Object),
        runtime: test.runtime,
        planner: test.planner,
        revalidator: test.revalidator,
        transaction: test.transaction,
        previewTtlMs: 24 * 60 * 60 * 1000,
        maxWorkerConcurrency: 10,
        defaultOptions: {
          operation: OperationMode.COPY,
          conflictPolicy: ConflictPolicy.RENAME,
          folderStructure: FolderStructure.YEAR_MONTH,
          workerCount: 6,
          verifyIntegrity: true,
          appendScreenshotSuffix: false,
          writeMetadataDates: true,
        },
      })
    );
    expect(test.bindings.createIpc).toHaveBeenCalledWith({
      ipc: ipcRegistrar,
      config: test.config,
      history: test.history.list,
      health: test.runtime,
      coordinator: test.coordinator,
      audit: test.audit,
      publishEvent,
    });
    expect(test.ipc.register).toHaveBeenCalledTimes(1);

    await application.shutdown();
  });

  it.each(['darwin', 'win32'] as const)(
    'selects the built-in production attestor for packaged %s before opening owners',
    async (platform) => {
      const test = harness();
      const options = {
        resourcesRoot: '/Applications/META Mover.app/Contents/Resources',
        configPath: '/tmp/meta-mover/config.json',
        historyPath: '/tmp/meta-mover/history.jsonl',
        evidenceRoot: '/tmp/meta-mover/evidence',
        evidencePolicyVersion: 'date-resolution/1',
        platform,
        architecture: 'arm64',
        isPackaged: true,
        ipc: { handle: jest.fn(), removeHandler: jest.fn() },
        publishEvent: jest.fn(),
      };

      const application = await createProductionApplicationRuntime(options, test.bindings);
      expect(test.bindings.verifyRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          launchTrustPolicy: expect.objectContaining({
            mode: 'production',
            attestedPlatform: platform,
          }),
        })
      );
      await application.shutdown();
    }
  );

  it('selects the built-in production attestor for packaged Linux before opening owners', async () => {
    const test = harness();
    const root = '/opt/meta-mover';
    const application = await createProductionApplicationRuntime(
      {
        resourcesRoot: path.join(root, 'resources'),
        configPath: path.join(root, 'state', 'config.json'),
        historyPath: path.join(root, 'state', 'history.jsonl'),
        evidenceRoot: path.join(root, 'state', 'evidence'),
        evidencePolicyVersion: 'date-resolution/1',
        platform: 'linux',
        architecture: 'x64',
        isPackaged: true,
        ipc: { handle: jest.fn(), removeHandler: jest.fn() },
        publishEvent: jest.fn(),
      },
      test.bindings
    );

    expect(test.bindings.verifyRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        launchTrustPolicy: expect.objectContaining({
          mode: 'production',
          attestedPlatform: 'linux',
        }),
      })
    );
    await application.shutdown();
  });

  it('rejects non-absolute ownership paths and packaged development policies before startup', async () => {
    const test = harness();
    const base = {
      resourcesRoot: '/opt/meta-mover/resources',
      configPath: '/tmp/meta-mover/config.json',
      historyPath: '/tmp/meta-mover/history.jsonl',
      evidenceRoot: '/tmp/meta-mover/evidence',
      evidencePolicyVersion: 'date-resolution/1',
      platform: 'linux' as const,
      architecture: 'x64',
      isPackaged: true,
      ipc: { handle: jest.fn(), removeHandler: jest.fn() },
      publishEvent: jest.fn(),
    };

    await expect(
      createProductionApplicationRuntime({ ...base, configPath: 'relative.json' }, test.bindings)
    ).rejects.toThrow(/absolute/i);
    await expect(
      createProductionApplicationRuntime(
        {
          ...base,
          launchTrustPolicy: developmentBrokerLaunchTrustPolicy() as BrokerLaunchTrustPolicy,
        },
        test.bindings
      )
    ).rejects.toThrow(/development/i);
    await expect(
      createProductionApplicationRuntime(
        {
          ...base,
          launchTrustPolicy: {
            mode: 'production',
            attestedPlatform: 'darwin',
            acquire: jest.fn(),
          },
        },
        test.bindings
      )
    ).rejects.toThrow(/different platform/i);
    await expect(
      createProductionApplicationRuntime({ ...base, previewTtlMs: 0 }, test.bindings)
    ).rejects.toThrow(/positive safe integer/i);
    expect(test.bindings.openConfig).not.toHaveBeenCalled();
  });
});
