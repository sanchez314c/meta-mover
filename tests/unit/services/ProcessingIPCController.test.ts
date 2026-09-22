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

const validReviewItem = {
  reviewId: 'review-1',
  jobId: 'job-1',
  previewId: 'preview-1',
  rowIndex: 0,
  originalSourcePath: '/source/photo.jpg',
  currentPath: '/destination/Photos/_Needs Review/photo.jpg',
  destinationRoot: '/destination',
  mediaKind: 'image' as const,
  status: 'pending' as const,
  reasonCodes: ['STRONG_CONFLICT'],
  warnings: [],
  evidence: {
    revision: 'revision-1',
    collectedAt: '2026-09-22T12:00:00.000Z',
    resolution: {
      policyVersion: 'date-resolution/1' as const,
      fileId: 'file-1',
      mediaKind: 'image' as const,
      target: 'capture-time' as const,
      evaluationTimeUtc: '2026-09-22T12:00:00.000Z',
      status: 'unresolved' as const,
      confidence: 'none' as const,
      contenderIds: [],
      rejected: [],
      reasonCodes: ['STRONG_CONFLICT'],
      candidates: [],
    },
  },
  output: {
    path: '/destination/Photos/_Needs Review/photo.jpg',
    device: 1,
    inode: 2,
    size: 3,
    modifiedTimeMs: 4,
    mtimeNs: '4000000',
    sha256: 'a'.repeat(64),
  },
  screenshotDetected: false,
  updatedAt: '2026-09-22T12:00:00.000Z',
};

function harness(
  options: {
    autoRegister?: boolean;
    subscribe?: ProcessingIPCDependencies['coordinator']['subscribe'];
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
    audit: {
      summary: jest.fn().mockResolvedValue({ revision: 'rev-1', total: 1 }),
      cohorts: jest.fn().mockResolvedValue({ revision: 'rev-1', items: [] }),
      sample: jest.fn().mockResolvedValue({ revision: 'rev-1', items: [] }),
      rows: jest.fn().mockResolvedValue({ revision: 'rev-1', items: [] }),
      decision: jest.fn().mockResolvedValue({ recordId: 'record-1' }),
      approve: jest.fn().mockResolvedValue({ revision: 'rev-1', approved: true }),
      dryRun: jest.fn().mockResolvedValue({ revision: 'rev-1', items: [] }),
    },
    review: {
      list: jest.fn().mockResolvedValue({ items: [validReviewItem] }),
      get: jest.fn().mockResolvedValue(validReviewItem),
      dryRun: jest.fn().mockResolvedValue({
        planToken: 'plan-1',
        action: { type: 'keep' },
        currentPath: validReviewItem.currentPath,
        targetPath: null,
        collision: false,
        warnings: [],
      }),
      apply: jest.fn().mockResolvedValue({
        reviewId: 'review-1',
        status: 'kept',
        currentPath: validReviewItem.currentPath,
        evidenceRevision: 'revision-1',
      }),
    },
    publishEvent: (event) => published.push(event),
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
    appendScreenshotSuffix: false,
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

  it('registers the complete normalization-audit surface and forwards strict requests', async () => {
    const test = harness();
    const dataset = { previewId: 'preview-1' };

    await expect(test.invoke('normalization-audit:summary', dataset)).resolves.toMatchObject({
      success: true,
    });
    await expect(
      test.invoke('normalization-audit:cohorts', { ...dataset, limit: 50 })
    ).resolves.toMatchObject({ success: true });
    await expect(
      test.invoke('normalization-audit:sample', { ...dataset, seed: 'seed', targetSize: 25 })
    ).resolves.toMatchObject({ success: true });
    await expect(
      test.invoke('normalization-audit:rows', { ...dataset, limit: 100 })
    ).resolves.toMatchObject({ success: true });
    await expect(
      test.invoke('normalization-audit:decision', { ...dataset, recordId: 'record-1' })
    ).resolves.toMatchObject({ success: true });
    await expect(
      test.invoke('normalization-audit:approve', {
        ...dataset,
        revision: 'rev-1',
        cohortKey: 'cohort-1',
        approved: true,
      })
    ).resolves.toMatchObject({ success: true });
    await expect(
      test.invoke('normalization-audit:dry-run', { ...dataset, revision: 'rev-1', limit: 100 })
    ).resolves.toMatchObject({ success: true });

    expect(test.dependencies.audit.rows).toHaveBeenCalledWith({
      previewId: 'preview-1',
      limit: 100,
    });
  });

  it('registers the review surface and rejects malformed requests before service calls', async () => {
    const test = harness();
    const list = { status: 'pending', limit: 25 };
    const get = { reviewId: 'review-1' };
    const dryRun = {
      reviewId: 'review-1',
      evidenceRevision: 'revision-1',
      action: { type: 'keep' },
    };
    const apply = { ...dryRun, planToken: 'plan-1' };

    await expect(test.invoke('review:list', list)).resolves.toMatchObject({ success: true });
    await expect(test.invoke('review:get', get)).resolves.toMatchObject({ success: true });
    await expect(test.invoke('review:dry-run', dryRun)).resolves.toMatchObject({ success: true });
    await expect(test.invoke('review:apply', apply)).resolves.toMatchObject({ success: true });
    expect(test.dependencies.review.list).toHaveBeenCalledWith(list);
    expect(test.dependencies.review.get).toHaveBeenCalledWith('review-1');
    expect(test.dependencies.review.dryRun).toHaveBeenCalledWith(dryRun);
    expect(test.dependencies.review.apply).toHaveBeenCalledWith(apply);

    await expect(
      test.invoke('review:apply', { ...apply, sourcePath: '/untrusted' })
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_IPC_REQUEST' } });
    expect(test.dependencies.review.apply).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed review service responses before returning them to the renderer', async () => {
    const test = harness();
    (test.dependencies.review.list as jest.Mock).mockResolvedValueOnce({ items: [{ bad: true }] });
    (test.dependencies.review.get as jest.Mock).mockResolvedValueOnce({ reviewId: 'partial' });
    (test.dependencies.review.dryRun as jest.Mock).mockResolvedValueOnce({ planToken: 'partial' });
    (test.dependencies.review.apply as jest.Mock).mockResolvedValueOnce({ status: 'resolved' });

    await expect(test.invoke('review:list', { limit: 25 })).resolves.toMatchObject({
      success: false,
      error: { code: 'APPLICATION_ERROR' },
    });
    await expect(test.invoke('review:get', { reviewId: 'review-1' })).resolves.toMatchObject({
      success: false,
      error: { code: 'APPLICATION_ERROR' },
    });
    await expect(
      test.invoke('review:dry-run', {
        reviewId: 'review-1',
        evidenceRevision: 'revision-1',
        action: { type: 'keep' },
      })
    ).resolves.toMatchObject({ success: false, error: { code: 'APPLICATION_ERROR' } });
    await expect(
      test.invoke('review:apply', {
        reviewId: 'review-1',
        evidenceRevision: 'revision-1',
        action: { type: 'keep' },
        planToken: 'plan-1',
      })
    ).resolves.toMatchObject({ success: false, error: { code: 'APPLICATION_ERROR' } });
  });

  it('rejects unsafe audit requests and page sizes above 100 before reaching the service', async () => {
    const test = harness();
    await expect(
      test.invoke('normalization-audit:rows', { previewId: 'preview-1', limit: 101 })
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_IPC_REQUEST' } });
    await expect(
      test.invoke('normalization-audit:sample', { previewId: 'preview-1', seed: '', targetSize: 1 })
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_IPC_REQUEST' } });
    await expect(
      test.invoke('normalization-audit:summary', { previewId: 'preview-1', extra: true })
    ).resolves.toMatchObject({ success: false, error: { code: 'INVALID_IPC_REQUEST' } });
    expect(test.dependencies.audit.rows).not.toHaveBeenCalled();
    expect(test.dependencies.audit.sample).not.toHaveBeenCalled();
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

  it('accepts and forwards opt-in metadata date normalization', async () => {
    const test = harness();
    const request = previewRequest();
    request.options.writeMetadataDates = true;

    await expect(test.invoke('processing:preview', request)).resolves.toMatchObject({
      success: true,
    });
    expect(test.dependencies.coordinator.createPreview).toHaveBeenCalledWith(request);
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

  it('admits parsed paths before asynchronous root analysis begins', async () => {
    const test = harness();

    await expect(test.invoke('processing:preview', previewRequest())).resolves.toMatchObject({
      success: true,
    });
    expect(test.dependencies.coordinator.createPreview).toHaveBeenCalledWith(previewRequest());
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
    expect(test.handlers.size).toBe(19);
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

  it('maps unexpected dependency failures without throwing transport errors', async () => {
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
