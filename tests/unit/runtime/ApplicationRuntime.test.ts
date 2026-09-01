import {
  ApplicationRuntime,
  ApplicationRuntimeShutdownError,
  ApplicationRuntimeStartupError,
  ApplicationRuntimeFactories,
  CoordinatorHistoryFanoutError,
} from '../../../src/main/runtime/ApplicationRuntime';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
} from '../../../src/shared/types/processing';

function configuration() {
  return {
    version: 3 as const,
    theme: 'system' as const,
    processing: {
      workerCount: 4,
      operation: OperationMode.COPY,
      verifyIntegrity: true as const,
    },
    organization: {
      folderStructure: FolderStructure.YEAR_MONTH,
      conflictPolicy: ConflictPolicy.RENAME,
      appendScreenshotSuffix: false,
    },
  };
}

function factories(
  events: string[],
  options: {
    failAt?: 'history' | 'runtime' | 'planner' | 'ipc-register';
    failCleanupAt?: readonly ('ipc' | 'transaction' | 'evidence' | 'history')[];
    exerciseHistoryFanout?: boolean;
    historyPreview?: () => Promise<void>;
    evidencePreview?: () => Promise<void>;
  } = {}
): ApplicationRuntimeFactories {
  const config = {
    getAll: () => configuration(),
    update: async () => configuration(),
    reset: async () => configuration(),
    close: async () => {
      events.push('config.close');
    },
  };
  const historyAdapter = {
    listJobs: async () => [],
    recordPreview: async (_preview: unknown, privateAudit?: unknown) => {
      expect(privateAudit).toBeUndefined();
      events.push('history.preview');
      await options.historyPreview?.();
    },
    recordEvent: async () => {
      events.push('history.event');
    },
  };
  const history = {
    coordinator: historyAdapter,
    list: historyAdapter,
    close: async () => {
      events.push('history.close');
      if (options.failCleanupAt?.includes('history')) throw new Error('history close failed');
    },
  };
  const evidence = {
    recordPreview: async (_preview: unknown, privateAudit?: unknown) => {
      if (options.exerciseHistoryFanout) expect(privateAudit).toEqual({ private: true });
      events.push('evidence.preview');
      await options.evidencePreview?.();
    },
    recordLedgerEntry: async () => {
      events.push('evidence.ledger');
    },
    recordStartRejection: async () => {
      events.push('evidence.rejection');
    },
    recordTerminal: async () => {
      events.push('evidence.terminal');
    },
    shutdown: async () => {
      events.push('evidence.shutdown');
      if (options.failCleanupAt?.includes('evidence')) throw new Error('evidence shutdown failed');
    },
  };
  const runtime = {
    getHealth: async () => ({ ready: true }),
    check: async () => ({ ready: true, reasons: [] }),
  };
  const metadata = {
    collectDetailed: async () => ({ candidates: [], warnings: [] }),
    close: async () => {
      events.push('metadata.close');
    },
  };
  const planner = {
    plan: async () => {
      throw new Error('not exercised by composition tests');
    },
  };
  const revalidator = {
    revalidate: async () => ({
      sourceFingerprintMatches: true,
      configMatches: true,
      reasons: [],
    }),
  };
  const transaction = {
    execute: async () => {
      throw new Error('not exercised by composition tests');
    },
    close: async () => {
      events.push('transaction.close');
      if (options.failCleanupAt?.includes('transaction')) {
        throw new Error('transaction close failed');
      }
    },
  };
  const coordinator = {
    createPreview: async () => {
      throw new Error('not exercised by composition tests');
    },
    startProcessing: async () => {
      throw new Error('not exercised by composition tests');
    },
    cancelProcessing: async () => undefined,
    subscribe: () => () => undefined,
    shutdown: async () => {
      events.push('coordinator.shutdown');
    },
  };
  const ipc = {
    register: () => {
      events.push('ipc.register');
      if (options.failAt === 'ipc-register') throw new Error('IPC registration failed');
    },
    dispose: () => {
      events.push('ipc.dispose');
      if (options.failCleanupAt?.includes('ipc')) throw new Error('IPC dispose failed');
    },
  };

  return {
    openConfig: async () => {
      events.push('config.open');
      return config;
    },
    openHistory: async () => {
      events.push('history.open');
      if (options.failAt === 'history') throw new Error('history open failed');
      return history;
    },
    openEvidence: async () => {
      events.push('evidence.open');
      return evidence;
    },
    verifyRuntime: async () => {
      events.push('runtime.verify');
      if (options.failAt === 'runtime') throw new Error('runtime verification failed');
      return runtime;
    },
    openMetadata: async ({ runtime: received }) => {
      expect(received).toBe(runtime);
      events.push('metadata.open');
      return metadata;
    },
    createPlanner: ({ metadata: received }) => {
      expect(received).toBe(metadata);
      events.push('planner.create');
      if (options.failAt === 'planner') throw new Error('planner creation failed');
      return planner;
    },
    createRevalidator: ({ runtime: received }) => {
      expect(received).toBe(runtime);
      events.push('revalidator.create');
      return revalidator;
    },
    openTransaction: async () => {
      events.push('transaction.open');
      return transaction;
    },
    createCoordinator: async ({
      planner: receivedPlanner,
      revalidator: receivedRevalidator,
      transaction: receivedTransaction,
      history: receivedHistory,
      config: receivedConfig,
    }) => {
      expect(receivedPlanner).toBe(planner);
      expect(receivedRevalidator).toBe(revalidator);
      expect(receivedTransaction).toBe(transaction);
      expect(receivedHistory).not.toBe(historyAdapter);
      if (options.exerciseHistoryFanout) {
        await receivedHistory.recordPreview?.({} as never, { private: true } as never);
        await receivedHistory.recordEvent?.({} as never);
        await receivedHistory.recordLedgerEntry?.({} as never);
        await receivedHistory.recordStartRejection?.({} as never);
        await receivedHistory.recordTerminal?.({} as never);
      }
      expect(receivedConfig).toBe(config);
      events.push('coordinator.create');
      return coordinator;
    },
    createIpc: ({ coordinator: receivedCoordinator, history: receivedHistory }) => {
      expect(receivedCoordinator).toBe(coordinator);
      expect(receivedHistory).toBe(historyAdapter);
      events.push('ipc.create');
      return ipc;
    },
  };
}

describe('ApplicationRuntime', () => {
  it('constructs the canonical graph in dependency order and registers IPC last', async () => {
    const events: string[] = [];

    const runtime = await ApplicationRuntime.create(factories(events));

    expect(runtime.components.planner).toBeDefined();
    expect(events).toEqual([
      'config.open',
      'history.open',
      'evidence.open',
      'runtime.verify',
      'metadata.open',
      'planner.create',
      'revalidator.create',
      'transaction.open',
      'coordinator.create',
      'ipc.create',
      'ipc.register',
    ]);
  });

  it('fans coordinator persistence hooks out to durable history and evidence', async () => {
    const events: string[] = [];

    await ApplicationRuntime.create(factories(events, { exerciseHistoryFanout: true }));

    expect(events).toEqual(
      expect.arrayContaining([
        'history.preview',
        'evidence.preview',
        'history.event',
        'evidence.ledger',
        'evidence.rejection',
        'evidence.terminal',
      ])
    );
  });

  it('waits for a delayed evidence hook before reporting a history failure', async () => {
    const events: string[] = [];
    let releaseEvidence!: () => void;
    const evidenceGate = new Promise<void>((resolve) => {
      releaseEvidence = resolve;
    });
    let evidenceStarted!: () => void;
    const evidenceStart = new Promise<void>((resolve) => {
      evidenceStarted = resolve;
    });
    const historyError = new Error('history preview failed');
    const creating = ApplicationRuntime.create(
      factories(events, {
        exerciseHistoryFanout: true,
        historyPreview: async () => {
          throw historyError;
        },
        evidencePreview: async () => {
          evidenceStarted();
          await evidenceGate;
          events.push('evidence.preview.settled');
        },
      })
    );

    await evidenceStart;
    const stateBeforeRelease = await Promise.race([
      creating.then(
        () => 'resolved' as const,
        () => 'rejected' as const
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ]);
    expect(stateBeforeRelease).toBe('pending');
    releaseEvidence();
    const startupError = await creating.catch((error: unknown) => error);

    expect(events).toContain('evidence.preview.settled');
    expect(startupError).toBeInstanceOf(ApplicationRuntimeStartupError);
    expect((startupError as ApplicationRuntimeStartupError).cause).toMatchObject({
      failures: [{ sink: 'history', error: historyError }],
    });
  });

  it('preserves both labeled persistence failures', async () => {
    const historyError = new Error('history preview failed');
    const evidenceError = new Error('evidence preview failed');

    const startupError = await ApplicationRuntime.create(
      factories([], {
        exerciseHistoryFanout: true,
        historyPreview: async () => {
          throw historyError;
        },
        evidencePreview: async () => {
          throw evidenceError;
        },
      })
    ).catch((error: unknown) => error);

    const cause = (startupError as ApplicationRuntimeStartupError).cause;
    expect(cause).toBeInstanceOf(CoordinatorHistoryFanoutError);
    expect((cause as CoordinatorHistoryFanoutError).failures).toEqual([
      { sink: 'history', error: historyError },
      { sink: 'evidence', error: evidenceError },
    ]);
  });

  it('closes each acquired resource when a middle factory fails', async () => {
    const events: string[] = [];

    await expect(
      ApplicationRuntime.create(factories(events, { failAt: 'planner' }))
    ).rejects.toBeInstanceOf(ApplicationRuntimeStartupError);
    expect(events.slice(-4)).toEqual([
      'evidence.shutdown',
      'metadata.close',
      'history.close',
      'config.close',
    ]);
  });

  it('rolls back acquired components in reverse order after startup failure', async () => {
    const events: string[] = [];

    await expect(
      ApplicationRuntime.create(factories(events, { failAt: 'ipc-register' }))
    ).rejects.toBeInstanceOf(ApplicationRuntimeStartupError);
    expect(events.slice(-7)).toEqual([
      'ipc.dispose',
      'coordinator.shutdown',
      'transaction.close',
      'evidence.shutdown',
      'metadata.close',
      'history.close',
      'config.close',
    ]);
  });

  it('reports every startup rollback failure in cleanup order with the original cause', async () => {
    const startupError = await ApplicationRuntime.create(
      factories([], {
        failAt: 'ipc-register',
        failCleanupAt: ['ipc', 'transaction', 'history'],
      })
    ).catch((error: unknown) => error);

    expect(startupError).toBeInstanceOf(ApplicationRuntimeStartupError);
    expect((startupError as ApplicationRuntimeStartupError).cause).toMatchObject({
      message: 'IPC registration failed',
    });
    expect((startupError as ApplicationRuntimeStartupError).rollbackFailures).toMatchObject([
      { step: 'ipc', error: { message: 'IPC dispose failed' } },
      { step: 'transaction', error: { message: 'transaction close failed' } },
      { step: 'history', error: { message: 'history close failed' } },
    ]);
  });

  it('shuts down once in the required data-safe order', async () => {
    const events: string[] = [];
    const runtime = await ApplicationRuntime.create(factories(events));
    events.length = 0;

    const first = runtime.shutdown();
    const second = runtime.shutdown();
    await Promise.all([first, second]);

    expect(events).toEqual([
      'ipc.dispose',
      'coordinator.shutdown',
      'transaction.close',
      'evidence.shutdown',
      'metadata.close',
      'history.close',
      'config.close',
    ]);
  });

  it('attempts every shutdown step and returns the same rejected shutdown promise', async () => {
    const events: string[] = [];
    const runtime = await ApplicationRuntime.create(
      factories(events, { failCleanupAt: ['transaction', 'history'] })
    );
    events.length = 0;

    const first = runtime.shutdown();
    const second = runtime.shutdown();
    expect(second).toBe(first);
    const shutdownError = await first.catch((error: unknown) => error);

    expect(shutdownError).toBeInstanceOf(ApplicationRuntimeShutdownError);
    expect((shutdownError as ApplicationRuntimeShutdownError).failures).toMatchObject([
      { step: 'transaction', error: { message: 'transaction close failed' } },
      { step: 'history', error: { message: 'history close failed' } },
    ]);
    expect(events).toContain('config.close');
    expect(events).toContain('history.close');
  });
});
