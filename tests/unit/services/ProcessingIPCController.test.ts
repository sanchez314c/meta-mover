import {
  ProcessingIPCCleanupError,
  ProcessingIPCController,
  ProcessingIPCDependencies,
} from '../../../src/main/services/ProcessingIPCController';
import { ProcessingCoordinatorError } from '../../../src/main/services/ProcessingCoordinator';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  ProcessingEventKind,
} from '../../../src/shared/types/processing';

function harness(
  options: {
    autoRegister?: boolean;
    subscribe?: ProcessingIPCDependencies['coordinator']['subscribe'];
    roots?: ProcessingIPCDependencies['roots'];
  } = {}
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const published: unknown[] = [];
  let eventListener: ((event: unknown) => void) | undefined;
  const dependencies: ProcessingIPCDependencies = {
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
    coordinator: {
      createPreview: jest.fn().mockResolvedValue({ previewId: 'preview-1' }),
      startProcessing: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
      cancelProcessing: jest.fn().mockResolvedValue(undefined),
      subscribe:
        options.subscribe ??
        ((listener) => {
          eventListener = (event) => listener(event as Parameters<typeof listener>[0]);
          return () => {
            eventListener = undefined;
          };
        }),
    },
    health: { getHealth: jest.fn().mockResolvedValue({ ready: true }) },
    history: { listJobs: jest.fn().mockResolvedValue([{ jobId: 'job-1' }]) },
    config: {
      getAll: jest.fn().mockReturnValue({ version: 2 }),
      update: jest.fn().mockResolvedValue({ version: 2, theme: 'dark' }),
      reset: jest.fn().mockResolvedValue({ version: 2, theme: 'system' }),
    },
    publishEvent: (event) => published.push(event),
    roots: options.roots ?? {
      validate: async (sourcePaths, destinationPath) => ({
        sourcePaths: [...sourcePaths],
        destinationPath,
        sourceIdentities: sourcePaths.map((rootPath, index) => ({
          path: rootPath,
          device: 1,
          inode: index + 1,
        })),
        destinationIdentity: { path: destinationPath, device: 2, inode: 1 },
      }),
    },
  };
  const controller = new ProcessingIPCController(dependencies);
  if (options.autoRegister !== false) controller.register();
  const invoke = (channel: string, value?: unknown) => handlers.get(channel)?.({}, value);
  return {
    controller,
    dependencies,
    handlers,
    invoke,
    published,
    emit: (event: unknown) => eventListener?.(event),
  };
}

const previewRequest = () => ({
  sourcePaths: ['/source'],
  destinationPath: '/destination',
  options: {
    operation: OperationMode.COPY,
    conflictPolicy: ConflictPolicy.RENAME,
    folderStructure: FolderStructure.YEAR_MONTH,
    workerCount: 4,
    verifyIntegrity: true,
    writeMetadataDates: false,
  },
});

describe('ProcessingIPCController', () => {
  it('registers one typed preview/start/cancel/health/history/config surface', async () => {
    const test = harness();

    await expect(test.invoke('processing:preview', previewRequest())).resolves.toMatchObject({
      success: true,
      data: { previewId: 'preview-1' },
    });
    await expect(
      test.invoke('processing:start', {
        previewId: 'preview-1',
        acknowledgeDestructiveOperation: false,
      })
    ).resolves.toMatchObject({ success: true, data: { jobId: 'job-1' } });
    await expect(
      test.invoke('processing:cancel', { jobId: 'job-1', reason: 'User requested cancellation' })
    ).resolves.toEqual({ success: true });
    await expect(test.invoke('processing:health')).resolves.toMatchObject({
      success: true,
      data: { ready: true },
    });
    await expect(test.invoke('processing:history', 20)).resolves.toMatchObject({
      success: true,
      data: [{ jobId: 'job-1' }],
    });
    await expect(test.invoke('config:get')).resolves.toEqual({
      success: true,
      data: { version: 2 },
    });
    await expect(test.invoke('config:update', { theme: 'dark' })).resolves.toMatchObject({
      success: true,
      data: { theme: 'dark' },
    });
    await expect(test.invoke('config:reset')).resolves.toMatchObject({
      success: true,
      data: { theme: 'system' },
    });
  });

  it('rejects malformed and unknown IPC fields before calling the coordinator', async () => {
    const test = harness();

    const invalid = previewRequest() as Record<string, unknown>;
    invalid.overwrite = true;
    await expect(test.invoke('processing:preview', invalid)).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_IPC_REQUEST' },
    });
    await expect(
      test.invoke('processing:start', {
        previewId: 'preview-1',
        acknowledgeDestructiveOperation: 'yes',
      })
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_IPC_REQUEST' } });
    await expect(test.invoke('processing:history', 10_000)).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_IPC_REQUEST' },
    });
    expect(test.dependencies.coordinator.createPreview).not.toHaveBeenCalled();
  });

  it.each([false, true, undefined])(
    'rejects a live corruptionDetection field with value %p',
    async (legacyValue) => {
      const test = harness();
      const request = previewRequest() as ReturnType<typeof previewRequest> & {
        options: ReturnType<typeof previewRequest>['options'] & {
          corruptionDetection?: unknown;
        };
      };
      request.options.corruptionDetection = legacyValue;

      await expect(test.invoke('processing:preview', request)).resolves.toMatchObject({
        success: false,
        error: { code: 'INVALID_IPC_REQUEST' },
      });
      expect(test.dependencies.coordinator.createPreview).not.toHaveBeenCalled();
    }
  );

  it('forwards current processing options without manufacturing retired fields', async () => {
    const test = harness();
    const request = previewRequest();

    await expect(test.invoke('processing:preview', request)).resolves.toMatchObject({
      success: true,
    });
    const forwarded = (test.dependencies.coordinator.createPreview as jest.Mock).mock.calls[0][0];
    expect(forwarded.options).toEqual(request.options);
    expect(forwarded.options).not.toHaveProperty('corruptionDetection');
  });

  it('maps coordinator failures without leaking stacks or foreign error objects', async () => {
    const test = harness();
    (test.dependencies.coordinator.createPreview as jest.Mock).mockRejectedValue(
      new ProcessingCoordinatorError('PREVIEW_DRIFT', 'source changed', ['/source/photo.jpg'])
    );

    await expect(test.invoke('processing:preview', previewRequest())).resolves.toEqual({
      success: false,
      error: {
        code: 'PREVIEW_DRIFT',
        message: 'source changed',
        recoverable: true,
        details: '/source/photo.jpg',
      },
    });
  });

  it('publishes the canonical event channel and unregisters every owned handler', () => {
    const test = harness();
    const event = {
      kind: ProcessingEventKind.JOB_STARTED,
      jobId: 'job-1',
      sequence: 3,
      emittedAt: '2026-08-29T12:00:00.000Z',
      payload: { phase: 'organization' },
    };

    test.emit(event);
    expect(test.published).toEqual([event]);
    test.controller.dispose();
    expect(test.handlers.size).toBe(0);
    test.emit(event);
    expect(test.published).toEqual([event]);
  });

  it('canonicalizes preview roots through the security validator before coordination', async () => {
    const validatedRoots = {
      sourcePaths: ['/canonical/source'],
      destinationPath: '/canonical/destination',
      sourceIdentities: [{ path: '/canonical/source', device: 7, inode: 11 }],
      destinationIdentity: { path: '/canonical/destination', device: 8, inode: 12 },
    };
    const validate = jest.fn().mockResolvedValue(validatedRoots);
    const test = harness({ roots: { validate } });

    await expect(test.invoke('processing:preview', previewRequest())).resolves.toMatchObject({
      success: true,
    });
    expect(validate).toHaveBeenCalledWith(['/source'], '/destination');
    expect(test.dependencies.coordinator.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaths: ['/canonical/source'],
        destinationPath: '/canonical/destination',
        validatedRoots,
      })
    );
  });

  it('uses the strict filesystem root validator when no override is injected', async () => {
    const test = harness();
    test.controller.dispose();
    delete test.dependencies.roots;
    const controller = new ProcessingIPCController(test.dependencies);
    controller.register();

    await expect(
      test.invoke('processing:preview', {
        ...previewRequest(),
        sourcePaths: ['relative/source'],
        destinationPath: 'relative/destination',
      })
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_IPC_REQUEST' },
    });
    expect(test.dependencies.coordinator.createPreview).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('rolls back every handler when registration fails and allows a clean retry', () => {
    let fail = true;
    const test = harness({
      autoRegister: false,
      subscribe: () => {
        if (fail) throw new Error('subscribe failed');
        return () => undefined;
      },
    });

    expect(() => test.controller.register()).toThrow('subscribe failed');
    expect(test.handlers.size).toBe(0);
    fail = false;
    expect(() => test.controller.register()).not.toThrow();
    expect(test.handlers.size).toBe(8);
  });

  it('gates a wrapper leaked by failed registration rollback', async () => {
    let failRemoval = true;
    const test = harness({
      autoRegister: false,
      subscribe: () => {
        throw new Error('subscribe failed');
      },
    });
    const removeHandler = test.dependencies.ipc.removeHandler.bind(test.dependencies.ipc);
    test.dependencies.ipc.removeHandler = (channel) => {
      if (channel === 'processing:start' && failRemoval) {
        throw new Error('rollback removal failed');
      }
      removeHandler(channel);
    };

    expect(() => test.controller.register()).toThrow(ProcessingIPCCleanupError);
    expect(test.handlers.has('processing:start')).toBe(true);
    await expect(
      test.invoke('processing:start', {
        previewId: 'preview-1',
        acknowledgeDestructiveOperation: false,
      })
    ).resolves.toMatchObject({ success: false });
    expect(test.dependencies.coordinator.startProcessing).not.toHaveBeenCalled();

    failRemoval = false;
    expect(() => test.controller.dispose()).not.toThrow();
    expect(test.handlers.size).toBe(0);
  });

  it('removes all handlers even when unsubscribe fails and can finish cleanup on retry', () => {
    let fail = true;
    const test = harness({
      subscribe: () => () => {
        if (fail) throw new Error('unsubscribe failed');
      },
    });

    expect(() => test.controller.dispose()).toThrow('unsubscribe failed');
    expect(test.handlers.size).toBe(0);
    fail = false;
    expect(() => test.controller.dispose()).not.toThrow();
  });

  it('gates leaked wrappers and aggregates every cleanup failure during disposal', async () => {
    let failUnsubscribe = true;
    let failRemoval = true;
    const test = harness({
      subscribe: () => () => {
        if (failUnsubscribe) throw new Error('event cleanup failed');
      },
    });
    const removeHandler = test.dependencies.ipc.removeHandler.bind(test.dependencies.ipc);
    test.dependencies.ipc.removeHandler = (channel) => {
      if (channel === 'processing:start' && failRemoval) {
        throw new Error('handler cleanup failed');
      }
      removeHandler(channel);
    };

    let failure: unknown;
    try {
      test.controller.dispose();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProcessingIPCCleanupError);
    expect((failure as ProcessingIPCCleanupError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'event cleanup failed' }),
        expect.objectContaining({ message: 'handler cleanup failed' }),
      ])
    );
    expect(test.handlers.has('processing:start')).toBe(true);
    await expect(
      test.invoke('processing:start', {
        previewId: 'preview-1',
        acknowledgeDestructiveOperation: false,
      })
    ).resolves.toMatchObject({ success: false });
    expect(test.dependencies.coordinator.startProcessing).not.toHaveBeenCalled();

    failUnsubscribe = false;
    failRemoval = false;
    expect(() => test.controller.dispose()).not.toThrow();
    expect(test.handlers.size).toBe(0);
  });

  it('validates cancel, option, and default history boundaries', async () => {
    const test = harness();

    await expect(
      test.invoke('processing:cancel', { jobId: '', reason: 'x' })
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_IPC_REQUEST' },
    });
    await expect(
      test.invoke('processing:preview', {
        ...previewRequest(),
        options: { ...previewRequest().options, workerCount: 11 },
      })
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_IPC_REQUEST' } });
    await expect(test.invoke('processing:history')).resolves.toMatchObject({ success: true });
    expect(test.dependencies.history.listJobs).toHaveBeenCalledWith(50);
  });

  it('maps root validation and unexpected dependency failures without throwing transport errors', async () => {
    const invalidRoots = harness({
      roots: { validate: async () => Promise.reject(new Error('roots overlap')) },
    });
    await expect(
      invalidRoots.invoke('processing:preview', previewRequest())
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_IPC_REQUEST', message: 'roots overlap' },
    });

    const applicationFailure = harness();
    (applicationFailure.dependencies.health.getHealth as jest.Mock).mockRejectedValue(
      new Error('health unavailable')
    );
    await expect(applicationFailure.invoke('processing:health')).resolves.toMatchObject({
      success: false,
      error: { code: 'APPLICATION_ERROR', recoverable: false },
    });
  });

  it('rejects double registration and makes successful disposal idempotent', () => {
    const test = harness();
    expect(() => test.controller.register()).toThrow(/already registered/i);
    expect(() => test.controller.dispose()).not.toThrow();
    expect(() => test.controller.dispose()).not.toThrow();
  });
});
