import {
  CancellationFileState,
  OperationMode,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingOptionsDTO,
  PreviewSummaryDTO,
  StartProcessingRequestDTO,
  isSerializableProcessingValue,
} from '../../../src/shared/types/processing';
import {
  CoordinatorErrorCode,
  CoordinatorHistoryPort,
  OperationLedgerEntry,
  OperationExecutorPort,
  PlannedOperation,
  PreviewPlannerPort,
  PreviewRevalidationResult,
  ProcessingCoordinator,
} from '../../../src/main/services/ProcessingCoordinator';

const summaryFor = (
  operations: readonly PlannedOperation[],
  mode: OperationMode = OperationMode.COPY
): PreviewSummaryDTO => ({
  totalFiles: operations.length,
  copyFiles: mode === OperationMode.COPY ? operations.length : 0,
  moveFiles: mode === OperationMode.MOVE ? operations.length : 0,
  skippedFiles: 0,
  renamedFiles: 0,
  overwrittenFiles: 0,
  unresolvedDates: 0,
  totalBytes: operations.reduce((total, operation) => total + operation.bytes, 0),
});

const operations = (count: number): PlannedOperation[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `operation-${index}`,
    sourcePath: `/source/${index}.jpg`,
    targetPath: `/destination/${index}.jpg`,
    bytes: (index + 1) * 10,
  }));

function plannerFor(plannedOperations: readonly PlannedOperation[]): PreviewPlannerPort {
  return {
    plan: jest.fn(async (request) => ({
      operations: plannedOperations,
      summary: summaryFor(plannedOperations, request.options.operation),
    })),
  };
}

const successfulExecutor: OperationExecutorPort = {
  execute: jest.fn(async (operation) => ({
    operationId: operation.id,
    outcome: 'committed' as const,
    bytes: operation.bytes,
  })),
};

const matchingRevalidator = {
  revalidate: jest.fn(async () => ({
    sourceFingerprintMatches: true,
    configMatches: true,
    reasons: [],
  })),
};

const partialOptions: Partial<ProcessingOptionsDTO> = {
  workerCount: 99,
};

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new RangeError('condition was not reached');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('ProcessingCoordinator preview contract', () => {
  it('bounds renderer preview rows while retaining the complete executable plan', async () => {
    const plannedOperations = operations(750);
    const rows = plannedOperations.map((operation) => ({
      sourcePath: operation.sourcePath,
      targetPath: operation.targetPath,
      operation: OperationMode.COPY,
      conflictPolicy: 'rename' as const,
      dateEvidence: {
        value: '2020-01-01T00:00:00Z',
        source: 'embedded' as const,
        confidence: 1,
        warnings: [],
      },
      fingerprint: {
        size: operation.bytes,
        modifiedAt: '2020-01-01T00:00:00.000Z',
      },
      warnings: [],
    }));
    const execute = jest.fn(async (operation: Readonly<PlannedOperation>) => ({
      operationId: operation.id,
      outcome: 'committed' as const,
      bytes: operation.bytes,
    }));
    const recordPreview = jest.fn(async () => undefined);
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async () => ({
          operations: plannedOperations,
          rows,
          summary: summaryFor(plannedOperations),
        })),
      },
      revalidator: matchingRevalidator,
      executor: { execute },
      history: { recordPreview },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 4,
    });

    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    expect(preview.rows).toHaveLength(500);
    expect(preview.summary.totalFiles).toBe(750);
    expect(recordPreview.mock.calls[0][0].rows).toHaveLength(750);

    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await coordinator.waitForTerminal(accepted.jobId);
    expect(execute).toHaveBeenCalledTimes(750);
  });

  it('publishes validated planner progress in sequence before preview-ready', async () => {
    const plannedOperations = operations(2);
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async (_request, _signal, reportProgress) => {
          await reportProgress?.({
            phase: 'metadata',
            filesProcessed: 0,
            totalFiles: 2,
            percentage: 0,
            currentFile: '/source/a.jpg',
          });
          await reportProgress?.({
            phase: 'metadata',
            filesProcessed: 1,
            totalFiles: 2,
            percentage: 50,
            currentFile: '/source/b.jpg',
          });
          await reportProgress?.({
            phase: 'organization',
            filesProcessed: 2,
            totalFiles: 2,
            percentage: 100,
          });
          return { operations: plannedOperations, summary: summaryFor(plannedOperations) };
        }),
      },
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));

    await coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' });

    expect(events.map((event) => event.kind)).toEqual([
      ProcessingEventKind.PREVIEW_STARTED,
      ProcessingEventKind.PREVIEW_PROGRESS,
      ProcessingEventKind.PREVIEW_PROGRESS,
      ProcessingEventKind.PREVIEW_PROGRESS,
      ProcessingEventKind.PREVIEW_READY,
    ]);
    expect(events[2]).toMatchObject({
      sequence: 3,
      payload: {
        filesProcessed: 1,
        totalFiles: 2,
        percentage: 50,
        currentFile: '/source/b.jpg',
      },
    });
  });

  it('rejects incomplete progress telemetry instead of publishing preview-ready', async () => {
    const plannedOperations = operations(2);
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async (_request, _signal, reportProgress) => {
          await reportProgress?.({
            phase: 'metadata',
            filesProcessed: 0,
            totalFiles: 2,
            percentage: 0,
            currentFile: '/source/a.jpg',
          });
          await reportProgress?.({
            phase: 'metadata',
            filesProcessed: 1,
            totalFiles: 2,
            percentage: 50,
            currentFile: '/source/b.jpg',
          });
          return { operations: plannedOperations, summary: summaryFor(plannedOperations) };
        }),
      },
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));

    await expect(
      coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_PLAN });
    expect(events.some((event) => event.kind === ProcessingEventKind.PREVIEW_READY)).toBe(false);
  });

  it('aborts an active preview by job id and reports cancellation without mutating files', async () => {
    const planner: PreviewPlannerPort = {
      plan: jest.fn(
        async (_request, signal) =>
          await new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('operator stopped preview');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          })
      ),
    };
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
      idGenerator: (kind) => `${kind}-cancel-preview`,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const pending = coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    await waitUntil(() => events.some((event) => event.kind === 'preview-started'));

    await coordinator.cancelProcessing('job-cancel-preview', 'Stopped by user');

    await expect(pending).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_CANCELLED });
    expect(events.map((event) => event.kind)).toEqual([
      ProcessingEventKind.PREVIEW_STARTED,
      ProcessingEventKind.JOB_FAILED,
    ]);
    expect(events[1]).toMatchObject({
      payload: { error: { code: CoordinatorErrorCode.PREVIEW_CANCELLED, recoverable: true } },
    });
  });

  it('rejects overlapping preview analysis instead of creating untrackable jobs', async () => {
    const planner: PreviewPlannerPort = {
      plan: jest.fn(
        async (_request, signal) =>
          await new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('stopped');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          })
      ),
    };
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
      idGenerator: (kind) => `${kind}-active`,
    });
    const first = coordinator.createPreview({
      sourcePaths: ['/source/first'],
      destinationPath: '/destination',
    });
    await waitUntil(() => (planner.plan as jest.Mock).mock.calls.length === 1);

    await expect(
      coordinator.createPreview({
        sourcePaths: ['/source/second'],
        destinationPath: '/destination',
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_ALREADY_ACTIVE });
    expect(planner.plan).toHaveBeenCalledTimes(1);

    await coordinator.cancelProcessing('job-active', 'test cleanup');
    await expect(first).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_CANCELLED });
  });

  it('fails closed when planner progress omits the current unfinished file', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async (_request, _signal, reportProgress) => {
          await reportProgress?.({
            phase: 'metadata',
            filesProcessed: 0,
            totalFiles: 2,
            percentage: 0,
          });
          return { operations: [], summary: summaryFor([]) };
        }),
      },
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });

    await expect(
      coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_PLAN });
  });

  it('preserves validated root identities into the planner request', async () => {
    const planner = plannerFor([]);
    const validatedRoots = {
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      sourceIdentities: [{ path: '/source', device: 7, inode: 11 }],
      destinationIdentity: { path: '/destination', device: 8, inode: 12 },
    };
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });

    await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      validatedRoots,
    } as Parameters<ProcessingCoordinator['createPreview']>[0] & {
      validatedRoots: typeof validatedRoots;
    });

    expect(planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ validatedRoots }),
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it('generates raw UUID job and preview identifiers by default', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });

    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(preview.jobId).toMatch(uuid);
    expect(preview.previewId).toMatch(uuid);
  });

  it('does not return a preview until its creation record is durable', async () => {
    const persisted = deferred<void>();
    const recordPreview = jest.fn(() => persisted.promise);
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: { recordPreview },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    let settled = false;

    const pending = coordinator
      .createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
      .finally(() => {
        settled = true;
      });
    await waitUntil(() => recordPreview.mock.calls.length === 1);

    expect(settled).toBe(false);
    persisted.resolve();
    await expect(pending).resolves.toMatchObject({ summary: summaryFor([]) });
  });

  it('rejects cancellation after preview analysis enters durable finalization', async () => {
    const persisted = deferred<void>();
    const recordPreview = jest.fn(() => persisted.promise);
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: { recordPreview },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
      idGenerator: (kind) => `${kind}-finalizing`,
    });
    const pending = coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    await waitUntil(() => recordPreview.mock.calls.length === 1);

    await expect(
      coordinator.cancelProcessing('job-finalizing', 'Stopped by user')
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_FINALIZING });

    persisted.resolve();
    await expect(pending).resolves.toMatchObject({ previewId: 'preview-finalizing' });
  });

  it('fails closed when preview creation persistence rejects', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: {
        recordPreview: jest.fn(async () => {
          throw new Error('preview append failed');
        }),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });

    await expect(
      coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.HISTORY_PERSISTENCE_FAILED });
  });

  it('publishes and persists only the exact public row DTO when a planner carries private evidence', async () => {
    const operation = operations(1)[0];
    const recordPreview = jest.fn();
    const resolution = {
      policyVersion: 'date-resolution/1' as const,
      fileId: '7:11',
      mediaKind: 'image' as const,
      target: 'capture-time' as const,
      evaluationTimeUtc: '2026-08-29T12:00:00.000Z',
      status: 'resolved' as const,
      confidence: 'high' as const,
      selectedCandidateId: 'candidate-1',
      selectedValue: {
        localIso: '2024-01-02T03:04:05',
        instantUtc: '2024-01-02T03:04:05.000Z',
        offsetMinutes: 0,
        zoneBasis: 'explicit-offset' as const,
        precision: 'second' as const,
      },
      contenderIds: ['candidate-1'],
      rejected: [],
      reasonCodes: [],
      candidates: [
        {
          id: 'candidate-1',
          fileId: '7:11',
          mediaKind: 'image' as const,
          semantic: 'capture' as const,
          sourceKind: 'embedded-exif' as const,
          sourceFamily: 'exif',
          tag: 'EXIF:DateTimeOriginal',
          rawValue: '2024:01:02 03:04:05+00:00',
          value: {
            localIso: '2024-01-02T03:04:05',
            instantUtc: '2024-01-02T03:04:05.000Z',
            offsetMinutes: 0,
            zoneBasis: 'explicit-offset' as const,
            precision: 'second' as const,
          },
          eligibility: 'eligible' as const,
          score: { base: 95, modifiers: [], semanticCap: 100, final: 95 },
          resolutionIssues: [],
        },
      ],
    };
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async () => ({
          operations: [operation],
          summary: summaryFor([operation]),
          rows: [
            {
              sourcePath: operation.sourcePath,
              targetPath: operation.targetPath,
              operation: OperationMode.COPY,
              conflictPolicy: 'rename' as const,
              dateEvidence: {
                value: '2024-01-02T03:04:05.000Z',
                source: 'embedded' as const,
                confidence: 1,
                warnings: [],
              },
              fingerprint: {
                size: operation.bytes,
                modifiedAt: '2026-08-29T12:00:00.000Z',
                hash: 'a'.repeat(64),
              },
              warnings: [],
              destinationSnapshot: {
                path: operation.targetPath,
                occupied: false,
                source: 'filesystem',
              },
            },
          ],
          decisionRecords: [{ rowIndex: 0, sourcePath: operation.sourcePath, resolution }],
        })),
      },
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: { recordPreview },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });

    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });

    expect(preview.rows?.[0]).toEqual({
      sourcePath: operation.sourcePath,
      targetPath: operation.targetPath,
      operation: OperationMode.COPY,
      conflictPolicy: 'rename',
      dateEvidence: {
        value: '2024-01-02T03:04:05.000Z',
        source: 'embedded',
        confidence: 1,
        warnings: [],
      },
      fingerprint: {
        size: operation.bytes,
        modifiedAt: '2026-08-29T12:00:00.000Z',
        hash: 'a'.repeat(64),
      },
      warnings: [],
    });
    expect(recordPreview).toHaveBeenCalledWith(preview, {
      jobId: preview.jobId,
      previewId: preview.previewId,
      decisionRecords: [{ rowIndex: 0, sourcePath: operation.sourcePath, resolution }],
      operationRecords: [
        {
          operationIndex: 0,
          operationId: operation.id,
          sourcePath: operation.sourcePath,
          targetPath: operation.targetPath,
          bytes: operation.bytes,
          decisionRowIndex: 0,
        },
      ],
    });
  });

  it('isolates synchronous and asynchronous listener failures and supports unsubscribe', async () => {
    const onHookError = jest.fn();
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
      onHookError,
    });
    const unsubscribeThrowing = coordinator.subscribe(() => {
      throw new Error('listener failed');
    });
    const unsubscribeRejecting = coordinator.subscribe((() =>
      Promise.reject(new Error('async listener failed'))) as unknown as (
      event: Readonly<ProcessingEvent>
    ) => void);

    await expect(
      coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
    ).resolves.toBeDefined();
    await waitUntil(() => onHookError.mock.calls.length === 4);
    unsubscribeThrowing();
    unsubscribeRejecting();

    expect(onHookError).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['disabled integrity verification', { verifyIntegrity: false }],
    ['retired corruption detection false', { corruptionDetection: false } as never],
    ['retired corruption detection true', { corruptionDetection: true } as never],
    ['non-boolean corruption detection', { corruptionDetection: 1 } as never],
    ['unknown option', { unrecognizedOption: true } as Partial<ProcessingOptionsDTO>],
  ])('rejects unsupported or malformed %s options', async (_label, options) => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });

    await expect(
      coordinator.createPreview({
        sourcePaths: ['/source'],
        destinationPath: '/destination',
        options,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_CONFIGURATION });
  });

  it('accepts opt-in metadata date normalization and passes it to execution', async () => {
    const execute = jest.fn(async (operation: PlannedOperation) => ({
      operationId: operation.id,
      outcome: 'committed' as const,
      bytes: operation.bytes,
    }));
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([operations(1)[0]]),
      revalidator: matchingRevalidator,
      executor: { execute },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { writeMetadataDates: true },
    });

    await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await coordinator.waitForTerminal(preview.jobId);

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ writeMetadataDates: true })
    );
  });

  it.each([false, true, undefined])(
    'rejects a non-enumerable corruptionDetection=%p option',
    async (legacyValue) => {
      const hiddenOptions = Object.defineProperty({}, 'corruptionDetection', {
        configurable: true,
        enumerable: false,
        value: legacyValue,
      }) as Partial<ProcessingOptionsDTO>;
      const coordinator = new ProcessingCoordinator({
        planner: plannerFor([]),
        revalidator: matchingRevalidator,
        executor: successfulExecutor,
        previewTtlMs: 60_000,
        maxWorkerConcurrency: 1,
      });

      await expect(
        coordinator.createPreview({
          sourcePaths: ['/source'],
          destinationPath: '/destination',
          options: hiddenOptions,
        })
      ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_REQUEST });
    }
  );

  it('rejects getter-bearing options without invoking the accessor', async () => {
    let workerCountReads = 0;
    const options = Object.defineProperty({}, 'workerCount', {
      enumerable: true,
      get: () => {
        workerCountReads += 1;
        return 2;
      },
    }) as Partial<ProcessingOptionsDTO>;
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 2,
    });

    await expect(
      coordinator.createPreview({
        sourcePaths: ['/source'],
        destinationPath: '/destination',
        options,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_REQUEST });
    expect(workerCountReads).toBe(0);
  });

  it('creates an immutable expiring preview, defaults to copy, and clamps concurrency', async () => {
    let now = Date.parse('2026-08-29T12:00:00.000Z');
    const plannedOperations = operations(2);
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 1_000,
      maxWorkerConcurrency: 3,
      clock: { now: () => now },
      idGenerator: (kind) => `${kind}-fixed`,
    });

    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: partialOptions,
    });

    expect(preview).toMatchObject({
      jobId: 'job-fixed',
      previewId: 'preview-fixed',
      createdAt: '2026-08-29T12:00:00.000Z',
      expiresAt: '2026-08-29T12:00:01.000Z',
      effectiveOptions: { operation: OperationMode.COPY, workerCount: 3 },
    });
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.request)).toBe(true);
    expect(Object.isFrozen(preview.effectiveOptions)).toBe(true);
    expect(isSerializableProcessingValue(preview)).toBe(true);

    now += 1_000;
    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_EXPIRED });
    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_EXPIRED });
  });

  it.each([
    ['source fingerprint', false, true],
    ['configuration', true, false],
  ])('rejects %s drift before admitting work', async (_label, sourceMatches, configMatches) => {
    const executor: OperationExecutorPort = { execute: jest.fn() };
    const recordStartRejection = jest.fn();
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: {
        revalidate: jest.fn(async () => ({
          sourceFingerprintMatches: sourceMatches,
          configMatches,
          reasons: ['drift detected'],
        })),
      },
      executor,
      history: { recordStartRejection },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 2,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_DRIFT });

    expect(executor.execute).not.toHaveBeenCalled();
    expect(recordStartRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        previewId: preview.previewId,
        code: CoordinatorErrorCode.PREVIEW_DRIFT,
      })
    );
  });

  it('requires explicit acknowledgement before a move preview can start', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 2,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { operation: OperationMode.MOVE },
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.MOVE_ACK_REQUIRED });

    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: true,
    });
    const terminal = await coordinator.waitForTerminal(accepted.jobId);
    expect(terminal.kind).toBe(ProcessingEventKind.JOB_COMPLETED);
  });

  it('rejects malformed revalidation output through the typed boundary', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: {
        revalidate: jest.fn(async () => undefined as unknown as PreviewRevalidationResult),
      },
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.REVALIDATION_FAILED });
  });

  it('rejects getter-bearing revalidation output without invoking the accessor', async () => {
    let sourceReads = 0;
    const revalidation = {
      get sourceFingerprintMatches(): boolean {
        sourceReads += 1;
        return true;
      },
      configMatches: true,
      reasons: [],
    } as PreviewRevalidationResult;
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: { revalidate: jest.fn(async () => revalidation) },
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.REVALIDATION_FAILED });
    expect(sourceReads).toBe(0);
  });

  it('keeps a preview retryable when an invalid Date-range clock blocks admission', async () => {
    const validTime = Date.parse('2026-08-29T12:00:00.000Z');
    let clockReads = 0;
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
      clock: {
        now: () => {
          clockReads += 1;
          return clockReads === 8 ? 9e15 : validTime;
        },
      },
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_CONFIGURATION });

    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_COMPLETED,
    });
  });

  it('reserves a preview while revalidation is in flight', async () => {
    const gate = deferred<PreviewRevalidationResult>();
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: { revalidate: jest.fn(() => gate.promise) },
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const firstStart = coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_CONSUMED });

    gate.resolve({ sourceFingerprintMatches: true, configMatches: true, reasons: [] });
    const accepted = await firstStart;
    expect((await coordinator.waitForTerminal(accepted.jobId)).kind).toBe(
      ProcessingEventKind.JOB_COMPLETED
    );
  });

  it('rejects a preview that expires while it is being revalidated', async () => {
    let now = 1_000;
    const executor: OperationExecutorPort = { execute: jest.fn() };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: {
        revalidate: jest.fn(async () => {
          now += 1_000;
          return { sourceFingerprintMatches: true, configMatches: true, reasons: [] };
        }),
      },
      executor,
      previewTtlMs: 1_000,
      maxWorkerConcurrency: 1,
      clock: { now: () => now },
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_EXPIRED });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('emits a controlled preview failure for malformed planner rows', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async () => ({
          operations: [],
          summary: summaryFor([]),
          rows: {} as unknown as [],
        })),
      },
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));

    await expect(
      coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_PLAN });
    expect(events.map((event) => event.kind)).toEqual([
      ProcessingEventKind.PREVIEW_STARTED,
      ProcessingEventKind.JOB_FAILED,
    ]);
  });

  it('rejects an executable preview row with a null target', async () => {
    const planned = operations(1);
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async () => ({
          operations: planned,
          summary: summaryFor(planned, OperationMode.MOVE),
          rows: [
            {
              sourcePath: planned[0].sourcePath,
              targetPath: null,
              operation: OperationMode.MOVE,
              conflictPolicy: 'rename' as const,
              dateEvidence: {
                value: '2024-01-01T00:00:00Z',
                source: 'embedded' as const,
                confidence: 1,
                warnings: [],
              },
              fingerprint: {
                size: planned[0].bytes,
                modifiedAt: '2026-08-29T12:00:00.000Z',
              },
              warnings: [],
            },
          ],
        })),
      },
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });

    await expect(
      coordinator.createPreview({
        sourcePaths: ['/source'],
        destinationPath: '/destination',
        options: { operation: OperationMode.MOVE },
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_PLAN });
  });

  it('rejects a planner summary that contradicts its canonical operations', async () => {
    const plannedOperations = operations(1);
    const coordinator = new ProcessingCoordinator({
      planner: {
        plan: jest.fn(async () => ({
          operations: plannedOperations,
          summary: {
            ...summaryFor(plannedOperations),
            totalFiles: 0,
            copyFiles: 0,
            totalBytes: 999,
          },
        })),
      },
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));

    await expect(
      coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_PLAN });
    expect(events.map((event) => event.kind)).toEqual([
      ProcessingEventKind.PREVIEW_STARTED,
      ProcessingEventKind.JOB_FAILED,
    ]);
  });

  it('rejects a jobId and previewId collision before planning', async () => {
    const planner = plannerFor([]);
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
      idGenerator: () => 'same-id',
    });

    await expect(
      coordinator.createPreview({ sourcePaths: ['/source'], destinationPath: '/destination' })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_CONFIGURATION });
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('rejects overlapping analysis before generated ids can be reused', async () => {
    const gate = deferred<{
      operations: readonly PlannedOperation[];
      summary: PreviewSummaryDTO;
    }>();
    const planner: PreviewPlannerPort = { plan: jest.fn(() => gate.promise) };
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
      idGenerator: (kind) => `${kind}-reserved`,
    });
    const first = coordinator.createPreview({
      sourcePaths: ['/source/first'],
      destinationPath: '/destination',
    });
    await waitUntil(() => (planner.plan as jest.Mock).mock.calls.length === 1);
    const second = coordinator.createPreview({
      sourcePaths: ['/source/second'],
      destinationPath: '/destination',
    });
    gate.resolve({ operations: [], summary: summaryFor([]) });

    await expect(second).rejects.toMatchObject({
      code: CoordinatorErrorCode.PREVIEW_ALREADY_ACTIVE,
    });
    await expect(first).resolves.toMatchObject({
      jobId: 'job-reserved',
      previewId: 'preview-reserved',
    });
  });
});

describe('ProcessingCoordinator execution contract', () => {
  it('preflights an invalid transition before durable event history sees it', async () => {
    const recordEvent = jest.fn();
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: { recordEvent },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await coordinator.waitForTerminal(accepted.jobId);
    const internal = coordinator as unknown as {
      activeJobs: Map<string, unknown>;
      publish(
        context: unknown,
        kind: ProcessingEventKind,
        payload: unknown
      ): Promise<ProcessingEvent>;
    };
    const activeJob = internal.activeJobs.get(accepted.jobId);
    const durableEventCount = recordEvent.mock.calls.length;

    await expect(
      internal.publish(activeJob, ProcessingEventKind.JOB_PROGRESS, {
        phase: 'organization',
        filesProcessed: 0,
        totalFiles: 0,
        percentage: 100,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.INVALID_EVENT_TRANSITION });
    expect(recordEvent).toHaveBeenCalledTimes(durableEventCount);
  });

  it('fails closed before execution when queued-event persistence rejects, then permits retry', async () => {
    let rejectQueued = true;
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => ({
        operationId: operation.id,
        outcome: 'committed' as const,
        bytes: operation.bytes,
      })),
    };
    const history: CoordinatorHistoryPort = {
      recordEvent: jest.fn(async (event) => {
        if (rejectQueued && event.kind === ProcessingEventKind.JOB_QUEUED) {
          throw new Error('durable append failed');
        }
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor,
      history,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.HISTORY_PERSISTENCE_FAILED });
    expect(executor.execute).not.toHaveBeenCalled();

    rejectQueued = false;
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await expect(coordinator.waitForTerminal(accepted.jobId)).resolves.toMatchObject({
      kind: ProcessingEventKind.JOB_COMPLETED,
    });
  });

  it('awaits ledger durability before admitting the next operation', async () => {
    const firstLedgerPersisted = deferred<void>();
    const recordLedgerEntry = jest
      .fn<Promise<void> | void, []>()
      .mockImplementationOnce(() => firstLedgerPersisted.promise)
      .mockImplementation(() => undefined);
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => ({
        operationId: operation.id,
        outcome: 'committed' as const,
        bytes: operation.bytes,
      })),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(2)),
      revalidator: matchingRevalidator,
      executor,
      history: { recordLedgerEntry },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await waitUntil(() => recordLedgerEntry.mock.calls.length === 1);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    firstLedgerPersisted.resolve();
    await coordinator.waitForTerminal(accepted.jobId);
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('preserves a committed mutation in terminal history and evidence when its ledger append fails', async () => {
    const plannedOperations = operations(1);
    const recordEvent = jest.fn();
    const recordTerminal = jest.fn();
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: {
        recordEvent,
        recordLedgerEntry: jest.fn(async () => {
          throw new Error('evidence ledger append failed');
        }),
        recordTerminal,
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    const terminal = await coordinator.waitForTerminal(accepted.jobId);

    expect(terminal).toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        error: {
          code: CoordinatorErrorCode.HISTORY_PERSISTENCE_FAILED,
          message: 'ledger entry persistence failed: evidence ledger append failed',
          recoverable: false,
        },
        statistics: {
          totalFiles: 1,
          processedFiles: 1,
          skippedFiles: 0,
          failedFiles: 0,
          totalBytes: 10,
          processedBytes: 10,
        },
        fileFailures: [],
      },
    });
    expect(recordEvent).toHaveBeenLastCalledWith(terminal);
    expect(recordTerminal).toHaveBeenCalledWith(terminal);
  });

  it('marks every unadmitted path failed after post-mutation ledger persistence stops the job', async () => {
    const plannedOperations = operations(3);
    const recordTerminal = jest.fn();
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: {
        recordLedgerEntry: jest.fn(async () => {
          throw new Error('ledger unavailable');
        }),
        recordTerminal,
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    const terminal = await coordinator.waitForTerminal(accepted.jobId);

    expect(successfulExecutor.execute).toHaveBeenCalledTimes(1);
    expect(terminal).toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        statistics: {
          totalFiles: 3,
          processedFiles: 1,
          skippedFiles: 0,
          failedFiles: 2,
          totalBytes: 60,
          processedBytes: 10,
        },
        fileFailures: [
          {
            sourcePath: '/source/1.jpg',
            error: expect.stringMatching(/not processed.*ledger entry persistence failed/i),
          },
          {
            sourcePath: '/source/2.jpg',
            error: expect.stringMatching(/not processed.*ledger entry persistence failed/i),
          },
        ],
      },
    });
    expect(recordTerminal).toHaveBeenCalledWith(terminal);
  });

  it('retains mixed committed, skipped, and failed outcomes when the final ledger append rejects', async () => {
    const plannedOperations = operations(4);
    const outcomes = ['committed', 'skipped', 'failed', 'committed'] as const;
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => {
        const index = Number(operation.id.split('-')[1]);
        return {
          operationId: operation.id,
          outcome: outcomes[index],
          bytes: outcomes[index] === 'committed' ? operation.bytes : 0,
          ...(outcomes[index] === 'failed' ? { error: 'source unreadable' } : {}),
        };
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor,
      history: {
        recordLedgerEntry: jest.fn(async (record) => {
          if (record.entry.operationId === 'operation-3') {
            throw new Error('final evidence append failed');
          }
        }),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        statistics: {
          totalFiles: 4,
          processedFiles: 2,
          skippedFiles: 1,
          failedFiles: 1,
          totalBytes: 100,
          processedBytes: 50,
        },
        fileFailures: [{ sourcePath: '/source/2.jpg', error: 'source unreadable' }],
      },
    });
  });

  it('retains every settled in-flight mutation and fails only never-admitted paths', async () => {
    const plannedOperations = operations(4);
    const secondOperationGate = deferred<void>();
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => {
        if (operation.id === 'operation-1') await secondOperationGate.promise;
        return {
          operationId: operation.id,
          outcome: 'committed' as const,
          bytes: operation.bytes,
        };
      }),
    };
    const recordLedgerEntry = jest.fn(async (record: { entry: { operationId: string } }) => {
      if (record.entry.operationId === 'operation-0') {
        throw new Error('first ledger append failed');
      }
    });
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor,
      history: { recordLedgerEntry },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 2,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { workerCount: 2 },
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await waitUntil(() => recordLedgerEntry.mock.calls.length === 1);

    expect(executor.execute).toHaveBeenCalledTimes(2);
    secondOperationGate.resolve();

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        error: {
          code: CoordinatorErrorCode.HISTORY_PERSISTENCE_FAILED,
          message: 'ledger entry persistence failed: first ledger append failed',
        },
        statistics: {
          totalFiles: 4,
          processedFiles: 2,
          skippedFiles: 0,
          failedFiles: 2,
          totalBytes: 100,
          processedBytes: 30,
        },
        fileFailures: [
          { sourcePath: '/source/2.jpg', error: expect.stringMatching(/not processed/i) },
          { sourcePath: '/source/3.jpg', error: expect.stringMatching(/not processed/i) },
        ],
      },
    });
    expect(recordLedgerEntry).toHaveBeenCalledTimes(2);
  });

  it('bounds workers, sequences events through the state machine, and derives statistics from the ledger', async () => {
    const plannedOperations = operations(5);
    let active = 0;
    let maximumActive = 0;
    const outcomes = ['committed', 'skipped', 'failed', 'committed', 'committed'] as const;
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        const index = Number(operation.id.split('-')[1]);
        return {
          operationId: operation.id,
          outcome: outcomes[index],
          bytes: outcomes[index] === 'skipped' ? 0 : operation.bytes,
          ...(outcomes[index] === 'failed' ? { error: 'synthetic failure' } : {}),
        };
      }),
    };
    const history: CoordinatorHistoryPort = {
      recordPreview: jest.fn(),
      recordEvent: jest.fn(),
      recordLedgerEntry: jest.fn(),
      recordTerminal: jest.fn(),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor,
      history,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 2,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { workerCount: 20 },
    });

    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    const terminal = await coordinator.waitForTerminal(accepted.jobId);

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: events.length }, (_, index) => index + 1)
    );
    expect(
      events.filter(
        (event) =>
          event.kind.startsWith('job-') &&
          ['job-completed', 'job-partially-completed', 'job-failed', 'job-cancelled'].includes(
            event.kind
          )
      )
    ).toHaveLength(1);
    expect(terminal).toMatchObject({
      kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      payload: {
        statistics: {
          totalFiles: 5,
          processedFiles: 3,
          skippedFiles: 1,
          failedFiles: 1,
          totalBytes: 150,
          processedBytes: 100,
        },
        fileFailures: [
          {
            sourcePath: '/source/2.jpg',
            error: 'synthetic failure',
          },
        ],
      },
    });
    const finalProgress = events
      .filter(
        (event): event is Extract<ProcessingEvent, { kind: 'job-progress' }> =>
          event.kind === ProcessingEventKind.JOB_PROGRESS
      )
      .at(-1);
    expect(finalProgress?.payload).toMatchObject({
      filesProcessed: 3,
      totalFiles: 5,
      percentage: 60,
    });
    expect(history.recordLedgerEntry).toHaveBeenCalledTimes(5);
    expect(history.recordTerminal).toHaveBeenCalledTimes(1);
    expect(isSerializableProcessingValue(accepted)).toBe(true);
    expect(events.every(isSerializableProcessingValue)).toBe(true);
  });

  it('reports byte throughput live while persisting only bounded progress checkpoints', async () => {
    const plannedOperations = operations(12);
    const recordEvent = jest.fn();
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: { recordEvent },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const liveEvents: ProcessingEvent[] = [];
    coordinator.subscribe((event) => liveEvents.push(event));
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await coordinator.waitForTerminal(accepted.jobId);

    const liveProgress = liveEvents.filter(
      (event): event is Extract<ProcessingEvent, { kind: 'job-progress' }> =>
        event.kind === ProcessingEventKind.JOB_PROGRESS
    );
    const persistedProgress = recordEvent.mock.calls
      .map(([event]) => event as ProcessingEvent)
      .filter((event) => event.kind === ProcessingEventKind.JOB_PROGRESS);

    expect(liveProgress).toHaveLength(12);
    expect(persistedProgress.length).toBeLessThan(liveProgress.length);
    expect(persistedProgress.at(-1)?.sequence).toBe(liveProgress.at(-1)?.sequence);
    expect(liveProgress.at(-1)?.payload).toMatchObject({
      bytesProcessed: 780,
      totalBytes: 780,
      throughput: expect.any(Number),
      eta: 0,
    });
  });

  it('cancels cooperatively, stops new admission, and emits exactly one terminal event', async () => {
    const plannedOperations = operations(6);
    let admitted = 0;
    const executor: OperationExecutorPort = {
      execute: jest.fn((_operation, context) => {
        admitted += 1;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              const abortError = new Error('aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            },
            { once: true }
          );
        });
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 2,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { workerCount: 2 },
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await waitUntil(() => admitted === 2);

    await coordinator.cancelProcessing(accepted.jobId, 'operator requested');
    const terminal = await coordinator.waitForTerminal(accepted.jobId);
    await coordinator.cancelProcessing(accepted.jobId, 'late duplicate');

    expect(admitted).toBe(2);
    expect(terminal).toMatchObject({
      kind: ProcessingEventKind.JOB_CANCELLED,
      payload: { reason: 'operator requested', filesProcessed: 0 },
    });
    expect(
      events.filter((event) =>
        [
          ProcessingEventKind.JOB_COMPLETED,
          ProcessingEventKind.JOB_FAILED,
          ProcessingEventKind.JOB_CANCELLED,
        ].includes(event.kind as typeof ProcessingEventKind.JOB_COMPLETED)
      )
    ).toHaveLength(1);
    expect(events.map((event) => event.kind)).toContain(ProcessingEventKind.JOB_CANCELLING);
  });

  it('persists a nonempty failed-operation error before publishing a cancellation terminal', async () => {
    const recordLedgerEntry = jest.fn();
    const coordinatorRef: { current?: ProcessingCoordinator } = {};
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation, context) => {
        await coordinatorRef.current!.cancelProcessing(
          context.jobId,
          'cancel after failed operation'
        );
        return {
          operationId: operation.id,
          outcome: 'failed' as const,
          bytes: 0,
        };
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(2)),
      revalidator: matchingRevalidator,
      executor,
      history: { recordLedgerEntry },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    coordinatorRef.current = coordinator;
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    const terminal = await coordinator.waitForTerminal(accepted.jobId);

    expect(recordLedgerEntry).toHaveBeenCalledWith({
      jobId: accepted.jobId,
      previewId: preview.previewId,
      entry: {
        operationId: 'operation-0',
        outcome: 'failed',
        bytes: 0,
        error: 'Operation failed without an error message',
      },
    });
    expect(terminal).toMatchObject({
      kind: ProcessingEventKind.JOB_CANCELLED,
      payload: {
        statistics: { failedFiles: 1, unattemptedFiles: 1 },
        fileFailures: [
          {
            sourcePath: '/source/0.jpg',
            error: 'Operation failed without an error message',
          },
        ],
        fileOutcomes: [
          {
            sourcePath: '/source/0.jpg',
            state: 'failed',
            error: 'Operation failed without an error message',
          },
          { sourcePath: '/source/1.jpg', state: 'not-attempted' },
        ],
      },
    });
  });

  it.each(['committed', 'skipped', 'cancelled'] as const)(
    'rejects a blank optional error from a %s executor ledger',
    async (outcome) => {
      const recordLedgerEntry = jest.fn();
      const executor: OperationExecutorPort = {
        execute: jest.fn(async (operation): Promise<OperationLedgerEntry> => {
          if (outcome === 'committed') {
            return {
              operationId: operation.id,
              outcome,
              bytes: operation.bytes,
              error: '   ',
            };
          }
          if (outcome === 'skipped') {
            return { operationId: operation.id, outcome, bytes: 0, error: '   ' };
          }
          return {
            operationId: operation.id,
            outcome,
            bytes: 0,
            cancellationState: 'cancelled-before-commit',
            sourceRetained: true,
            destinationCommitted: false,
            error: '   ',
          };
        }),
      };
      const coordinator = new ProcessingCoordinator({
        planner: plannerFor(operations(1)),
        revalidator: matchingRevalidator,
        executor,
        history: { recordLedgerEntry },
        previewTtlMs: 60_000,
        maxWorkerConcurrency: 1,
      });
      const preview = await coordinator.createPreview({
        sourcePaths: ['/source'],
        destinationPath: '/destination',
      });
      const accepted = await coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      });

      const terminal = await coordinator.waitForTerminal(accepted.jobId);

      const persistedEntry = recordLedgerEntry.mock.calls[0]?.[0].entry as OperationLedgerEntry;
      expect(persistedEntry).toMatchObject({
        operationId: 'operation-0',
        outcome: 'failed',
        bytes: 0,
        error: expect.stringMatching(/invalid ledger entry/i),
      });
      expect(terminal).toMatchObject({
        kind: ProcessingEventKind.JOB_FAILED,
        payload: {
          fileFailures: [
            { sourcePath: '/source/0.jpg', error: expect.stringMatching(/invalid ledger entry/i) },
          ],
        },
      });
    }
  );

  it('treats concurrent duplicate cancellation requests as idempotent', async () => {
    let admitted = 0;
    const executor: OperationExecutorPort = {
      execute: jest.fn((_operation, context) => {
        admitted += 1;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              const abortError = new Error('aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            },
            { once: true }
          );
        });
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(2)),
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await waitUntil(() => admitted === 1);

    const cancellations = await Promise.allSettled([
      coordinator.cancelProcessing(accepted.jobId, 'first request'),
      coordinator.cancelProcessing(accepted.jobId, 'duplicate request'),
    ]);
    const terminal = await coordinator.waitForTerminal(accepted.jobId);

    expect(cancellations.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(terminal.kind).toBe(ProcessingEventKind.JOB_CANCELLED);
    expect(
      events.filter((event) => event.kind === ProcessingEventKind.JOB_CANCELLING)
    ).toHaveLength(1);
    expect(
      events.filter((event) =>
        [
          ProcessingEventKind.JOB_COMPLETED,
          ProcessingEventKind.JOB_FAILED,
          ProcessingEventKind.JOB_CANCELLED,
        ].includes(event.kind as typeof ProcessingEventKind.JOB_COMPLETED)
      )
    ).toHaveLength(1);
  });

  it('consumes a preview exactly once', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.PREVIEW_CONSUMED });
  });

  it('conserves committed Move residue and every unattempted input in cancellation truth', async () => {
    const gate = deferred<void>();
    let admitted = 0;
    const plannedOperations = operations(3);
    const rows = [
      ...plannedOperations.map((operation) => ({
        sourcePath: operation.sourcePath,
        targetPath: operation.targetPath,
        operation: OperationMode.MOVE,
        conflictPolicy: 'rename' as const,
        dateEvidence: {
          value: '2024-01-01T00:00:00.000Z',
          source: 'embedded' as const,
          confidence: 1,
          warnings: [],
        },
        fingerprint: {
          size: operation.bytes,
          modifiedAt: '2026-08-29T12:00:00.000Z',
        },
        warnings: [],
      })),
      {
        sourcePath: '/source/conflict.jpg',
        targetPath: '/destination/conflict.jpg',
        operation: 'skip' as const,
        conflictPolicy: 'skip' as const,
        dateEvidence: {
          value: '2024-01-01T00:00:00.000Z',
          source: 'embedded' as const,
          confidence: 1,
          warnings: [],
        },
        fingerprint: { size: 40, modifiedAt: '2026-08-29T12:00:00.000Z' },
        warnings: ['Target already exists'],
      },
      {
        sourcePath: '/source/unsupported.bin',
        targetPath: null,
        operation: 'skip' as const,
        conflictPolicy: 'rename' as const,
        dateEvidence: {
          value: null,
          source: 'unresolved' as const,
          confidence: 0,
          warnings: ['Needs Review'],
        },
        fingerprint: { size: 50, modifiedAt: '2026-08-29T12:00:00.000Z' },
        warnings: ['Needs Review'],
      },
    ];
    const planner: PreviewPlannerPort = {
      plan: jest.fn(async () => ({
        operations: plannedOperations,
        rows,
        summary: {
          totalFiles: 5,
          copyFiles: 0,
          moveFiles: 3,
          skippedFiles: 2,
          renamedFiles: 0,
          overwrittenFiles: 0,
          unresolvedDates: 1,
          totalBytes: 150,
        },
      })),
    };
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => {
        admitted += 1;
        await gate.promise;
        return {
          operationId: operation.id,
          outcome: 'cancelled' as const,
          bytes: operation.bytes,
          cancellationState: 'destination-committed-source-retained' as const,
          sourceRetained: true,
          destinationCommitted: true,
          error: 'operator cancelled after destination commit',
        };
      }),
    };
    const history: CoordinatorHistoryPort = { recordLedgerEntry: jest.fn() };
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor,
      history,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { operation: OperationMode.MOVE },
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: true,
    });
    await waitUntil(() => admitted === 1);
    await coordinator.cancelProcessing(accepted.jobId, 'cancel after admission');
    gate.resolve();

    const terminal = await coordinator.waitForTerminal(accepted.jobId);
    expect(admitted).toBe(1);
    expect(terminal).toEqual({
      kind: ProcessingEventKind.JOB_CANCELLED,
      jobId: accepted.jobId,
      sequence: expect.any(Number),
      emittedAt: expect.any(String),
      payload: {
        reason: 'cancel after admission',
        filesProcessed: 0,
        statistics: {
          totalFiles: 5,
          processedFiles: 0,
          skippedFiles: 2,
          failedFiles: 0,
          cancelledFiles: 1,
          unattemptedFiles: 2,
          totalBytes: 150,
          processedBytes: 0,
          committedResidueBytes: 10,
          durationMs: expect.any(Number),
        },
        fileFailures: [],
        fileOutcomes: [
          {
            sourcePath: '/source/0.jpg',
            destinationPath: '/destination/0.jpg',
            state: 'destination-committed-source-retained',
            plannedBytes: 10,
            committedBytes: 10,
            sourceRetained: true,
            error: 'operator cancelled after destination commit',
          },
          {
            sourcePath: '/source/1.jpg',
            destinationPath: '/destination/1.jpg',
            state: 'not-attempted',
            plannedBytes: 20,
            committedBytes: 0,
            sourceRetained: true,
            error: 'Not attempted because the job was cancelled',
          },
          {
            sourcePath: '/source/2.jpg',
            destinationPath: '/destination/2.jpg',
            state: 'not-attempted',
            plannedBytes: 30,
            committedBytes: 0,
            sourceRetained: true,
            error: 'Not attempted because the job was cancelled',
          },
          {
            sourcePath: '/source/conflict.jpg',
            destinationPath: '/destination/conflict.jpg',
            state: 'skipped',
            plannedBytes: 40,
            committedBytes: 0,
            sourceRetained: true,
          },
          {
            sourcePath: '/source/unsupported.bin',
            destinationPath: null,
            state: 'skipped',
            plannedBytes: 50,
            committedBytes: 0,
            sourceRetained: true,
          },
        ],
      },
    });
    expect(history.recordLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          outcome: 'cancelled',
          bytes: 10,
          destinationCommitted: true,
          sourceRetained: true,
        }),
      })
    );
    expect(
      events.filter((event) =>
        [
          ProcessingEventKind.JOB_COMPLETED,
          ProcessingEventKind.JOB_FAILED,
          ProcessingEventKind.JOB_CANCELLED,
        ].includes(event.kind as typeof ProcessingEventKind.JOB_COMPLETED)
      )
    ).toHaveLength(1);
  });

  it('keeps zero-byte post-commit Move cancellation explicit in coordinator truth', async () => {
    const gate = deferred<void>();
    let admitted = false;
    const zeroByte = {
      ...operations(1)[0],
      bytes: 0,
    };
    const executor: OperationExecutorPort = {
      execute: jest.fn(async () => {
        admitted = true;
        await gate.promise;
        return {
          operationId: zeroByte.id,
          outcome: 'cancelled' as const,
          bytes: 0,
          cancellationState: 'destination-committed-source-retained' as const,
          sourceRetained: true,
          destinationCommitted: true,
          error: 'cancelled after zero-byte destination commit',
        };
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([zeroByte]),
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { operation: OperationMode.MOVE },
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: true,
    });
    await waitUntil(() => admitted);
    await coordinator.cancelProcessing(accepted.jobId, 'operator requested');
    gate.resolve();

    await expect(coordinator.waitForTerminal(accepted.jobId)).resolves.toMatchObject({
      kind: ProcessingEventKind.JOB_CANCELLED,
      payload: {
        statistics: {
          totalFiles: 1,
          processedFiles: 0,
          cancelledFiles: 1,
          totalBytes: 0,
          processedBytes: 0,
          committedResidueBytes: 0,
        },
        fileOutcomes: [
          {
            sourcePath: zeroByte.sourcePath,
            destinationPath: zeroByte.targetPath,
            state: 'destination-committed-source-retained',
            plannedBytes: 0,
            committedBytes: 0,
            sourceRetained: true,
          },
        ],
      },
    });
  });

  it('completes an empty immutable plan with zero ledger-derived statistics', async () => {
    const executor: OperationExecutorPort = { execute: jest.fn() };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 2,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_COMPLETED,
      payload: {
        statistics: {
          totalFiles: 0,
          processedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          totalBytes: 0,
          processedBytes: 0,
        },
      },
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('converts inflated committed bytes into a failed ledger entry', async () => {
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => ({
        operationId: operation.id,
        outcome: 'committed' as const,
        bytes: operation.bytes + 999,
      })),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        error: {
          code: 'FILE_OPERATIONS_FAILED',
          message: 'All 1 file operation failed',
        },
        statistics: {
          totalBytes: 10,
          processedBytes: 0,
          processedFiles: 0,
          failedFiles: 1,
        },
        fileFailures: [
          {
            sourcePath: '/source/0.jpg',
            error: expect.stringMatching(/invalid ledger entry/i),
          },
        ],
      },
    });
  });

  it('rejects partial-byte destination-committed Move residue', async () => {
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => ({
        operationId: operation.id,
        outcome: 'cancelled' as const,
        bytes: operation.bytes - 1,
        cancellationState: 'destination-committed-source-retained' as const,
        sourceRetained: true,
        destinationCommitted: true,
        error: 'partial destination commit claim',
      })),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { operation: OperationMode.MOVE },
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: true,
    });

    await expect(coordinator.waitForTerminal(accepted.jobId)).resolves.toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        fileFailures: [
          {
            sourcePath: '/source/0.jpg',
            error: expect.stringMatching(/invalid ledger entry/i),
          },
        ],
      },
    });
  });

  it('rejects destination-committed-source-retained for Copy execution', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor: {
        execute: jest.fn(async (operation) => ({
          operationId: operation.id,
          outcome: 'cancelled' as const,
          bytes: operation.bytes,
          cancellationState: 'destination-committed-source-retained' as const,
          sourceRetained: true,
          destinationCommitted: true,
          error: 'invalid Copy residue claim',
        })),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { operation: OperationMode.COPY },
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    await expect(coordinator.waitForTerminal(accepted.jobId)).resolves.toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        fileFailures: [
          { sourcePath: '/source/0.jpg', error: expect.stringMatching(/invalid ledger entry/i) },
        ],
      },
    });
  });

  it('rejects a partial-byte committed executor outcome', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor: {
        execute: jest.fn(async (operation) => ({
          operationId: operation.id,
          outcome: 'committed' as const,
          bytes: operation.bytes - 1,
        })),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    await expect(coordinator.waitForTerminal(accepted.jobId)).resolves.toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        fileFailures: [
          { sourcePath: '/source/0.jpg', error: expect.stringMatching(/invalid ledger entry/i) },
        ],
      },
    });
  });

  it('rejects a skipped executor outcome with committed bytes', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor: {
        execute: jest.fn(async (operation) => ({
          operationId: operation.id,
          outcome: 'skipped' as const,
          bytes: operation.bytes,
        })),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    await expect(coordinator.waitForTerminal(accepted.jobId)).resolves.toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        fileFailures: [
          { sourcePath: '/source/0.jpg', error: expect.stringMatching(/invalid ledger entry/i) },
        ],
      },
    });
  });

  it('reports an all-file execution failure with zero successes and every failed path', async () => {
    const plannedOperations = operations(2);
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor: {
        execute: jest.fn(async (operation) => ({
          operationId: operation.id,
          outcome: 'failed' as const,
          bytes: 0,
          error: `cannot copy ${operation.id}`,
        })),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        error: {
          code: 'FILE_OPERATIONS_FAILED',
          message: 'All 2 file operations failed',
          recoverable: true,
        },
        statistics: {
          totalFiles: 2,
          processedFiles: 0,
          failedFiles: 2,
          processedBytes: 0,
        },
        fileFailures: [
          { sourcePath: '/source/0.jpg', error: 'cannot copy operation-0' },
          { sourcePath: '/source/1.jpg', error: 'cannot copy operation-1' },
        ],
      },
    });
  });

  it('reports skipped plus failed work as partial without inventing a success or error text', async () => {
    const plannedOperations = operations(2);
    plannedOperations[1].sourcePath = '/source/雪 image.jpg';
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor: {
        execute: jest.fn(async (operation) => ({
          operationId: operation.id,
          outcome: operation.id === 'operation-0' ? ('skipped' as const) : ('failed' as const),
          bytes: 0,
        })),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      payload: {
        statistics: {
          totalFiles: 2,
          processedFiles: 0,
          skippedFiles: 1,
          failedFiles: 1,
        },
        fileFailures: [
          {
            sourcePath: '/source/雪 image.jpg',
            error: 'Operation failed without an error message',
          },
        ],
      },
    });
  });

  it('preserves committed MOVE residue in partial per-row outcomes', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(2)),
      revalidator: matchingRevalidator,
      executor: {
        execute: jest.fn(async (operation) =>
          operation.id === 'operation-0'
            ? { operationId: operation.id, outcome: 'committed' as const, bytes: operation.bytes }
            : {
                operationId: operation.id,
                outcome: 'failed' as const,
                bytes: operation.bytes,
                sourceRetained: true,
                destinationCommitted: true,
                error: 'source delete failed after destination commit',
              }
        ),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options: { operation: OperationMode.MOVE },
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: true,
    });

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      payload: {
        fileOutcomes: [
          { state: CancellationFileState.COMPLETED },
          {
            sourcePath: '/source/1.jpg',
            destinationPath: '/destination/1.jpg',
            state: CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED,
            committedBytes: 20,
            sourceRetained: true,
          },
        ],
      },
    });
  });

  it('rejects getter-bearing executor output without invoking the accessor', async () => {
    let bytesReads = 0;
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation) => {
        const result = {
          operationId: operation.id,
          outcome: 'committed' as const,
          get bytes(): number {
            bytesReads += 1;
            return operation.bytes;
          },
        };
        return result;
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });

    expect(await coordinator.waitForTerminal(accepted.jobId)).toMatchObject({
      kind: ProcessingEventKind.JOB_FAILED,
      payload: {
        statistics: {
          totalBytes: 10,
          processedBytes: 0,
          processedFiles: 0,
          failedFiles: 1,
        },
      },
    });
    expect(bytesReads).toBe(0);
  });

  it('blocks new admissions synchronously and drains active terminal event queues on shutdown', async () => {
    const cancellationPersisted = deferred<void>();
    let admitted = 0;
    const executor: OperationExecutorPort = {
      execute: jest.fn((_operation, context) => {
        admitted += 1;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              const abortError = new Error('aborted by shutdown');
              abortError.name = 'AbortError';
              reject(abortError);
            },
            { once: true }
          );
        });
      }),
    };
    const history: CoordinatorHistoryPort = {
      recordEvent: jest.fn((event) =>
        event.kind === ProcessingEventKind.JOB_CANCELLING
          ? cancellationPersisted.promise
          : undefined
      ),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(2)),
      revalidator: matchingRevalidator,
      executor,
      history,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await waitUntil(() => admitted === 1);

    const shutdown = coordinator.shutdown();
    expect(coordinator.shutdown()).toBe(shutdown);
    await expect(
      coordinator.createPreview({ sourcePaths: ['/other'], destinationPath: '/destination' })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.COORDINATOR_SHUTDOWN });
    await expect(
      coordinator.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: false,
      })
    ).rejects.toMatchObject({ code: CoordinatorErrorCode.COORDINATOR_SHUTDOWN });

    let settled = false;
    void shutdown.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    cancellationPersisted.resolve();
    await expect(shutdown).resolves.toBeUndefined();
    await expect(coordinator.waitForTerminal(accepted.jobId)).resolves.toMatchObject({
      kind: ProcessingEventKind.JOB_CANCELLED,
    });
  });

  it('aborts an admitted preview before shutdown completes', async () => {
    const planGate = deferred<{ operations: PlannedOperation[]; summary: PreviewSummaryDTO }>();
    const planner: PreviewPlannerPort = { plan: jest.fn(() => planGate.promise) };
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const pendingPreview = coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    await waitUntil(() => (planner.plan as jest.Mock).mock.calls.length === 1);

    const shutdown = coordinator.shutdown();
    let settled = false;
    void shutdown.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    planGate.resolve({ operations: [], summary: summaryFor([]) });
    await expect(pendingPreview).rejects.toMatchObject({
      code: CoordinatorErrorCode.PREVIEW_CANCELLED,
    });
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('aborts active execution before waiting for a blocked preview admission', async () => {
    const blockedPlan = deferred<{ operations: PlannedOperation[]; summary: PreviewSummaryDTO }>();
    const planner: PreviewPlannerPort = {
      plan: jest
        .fn()
        .mockResolvedValueOnce({ operations: operations(1), summary: summaryFor(operations(1)) })
        .mockImplementationOnce(() => blockedPlan.promise),
    };
    let abortObserved = false;
    const executor: OperationExecutorPort = {
      execute: jest.fn(
        (_operation, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              'abort',
              () => {
                abortObserved = true;
                const abortError = new Error('aborted by shutdown');
                abortError.name = 'AbortError';
                reject(abortError);
              },
              { once: true }
            );
          })
      ),
    };
    const coordinator = new ProcessingCoordinator({
      planner,
      revalidator: matchingRevalidator,
      executor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const firstPreview = await coordinator.createPreview({
      sourcePaths: ['/source/first'],
      destinationPath: '/destination',
    });
    await coordinator.startProcessing({
      previewId: firstPreview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    await waitUntil(() => (executor.execute as jest.Mock).mock.calls.length === 1);
    const pendingPreview = coordinator.createPreview({
      sourcePaths: ['/source/blocked'],
      destinationPath: '/destination',
    });
    await waitUntil(() => (planner.plan as jest.Mock).mock.calls.length === 2);

    const shutdown = coordinator.shutdown();
    await waitUntil(() => abortObserved);

    blockedPlan.resolve({ operations: [], summary: summaryFor([]) });
    await expect(pendingPreview).rejects.toMatchObject({
      code: CoordinatorErrorCode.PREVIEW_CANCELLED,
    });
    await expect(shutdown).resolves.toBeUndefined();
  });

  it('rejects getter-bearing start requests without invoking the accessor', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor([]),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    let reads = 0;
    const request = Object.defineProperty({ acknowledgeDestructiveOperation: false }, 'previewId', {
      enumerable: true,
      get: () => {
        reads += 1;
        return preview.previewId;
      },
    }) as StartProcessingRequestDTO;

    await expect(coordinator.startProcessing(request)).rejects.toMatchObject({
      code: CoordinatorErrorCode.INVALID_REQUEST,
    });
    expect(reads).toBe(0);
  });

  it('surfaces terminal persistence failure without deadlocking terminal wait', async () => {
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(operations(1)),
      revalidator: matchingRevalidator,
      executor: successfulExecutor,
      history: {
        recordTerminal: jest.fn(async () => {
          throw new RangeError('history terminal failure');
        }),
      },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50));

    const result = await Promise.race([
      coordinator.waitForTerminal(accepted.jobId).catch((error: unknown) => error),
      timeout,
    ]);
    expect(result).not.toBe('timeout');
    expect(result).toMatchObject({ code: CoordinatorErrorCode.HISTORY_PERSISTENCE_FAILED });
  });
});

describe('ProcessingCoordinator audit preparation progress', () => {
  it('surfaces authorization stage progress as ephemeral job progress', async () => {
    const plannedOperations = operations(2);
    const recordEvent = jest.fn(async () => undefined);
    const executor: OperationExecutorPort = {
      execute: jest.fn(async (operation, context) => {
        if (operation.id === 'operation-0') {
          await context.reportStageProgress?.({
            stage: 'Verifying preview evidence',
            completed: 5,
            total: 10,
            unit: 'records',
          });
          // A second report inside the throttle window must not publish again.
          await context.reportStageProgress?.({
            stage: 'Verifying preview evidence',
            completed: 10,
            total: 10,
            unit: 'records',
          });
        }
        return { operationId: operation.id, outcome: 'committed' as const, bytes: operation.bytes };
      }),
    };
    const coordinator = new ProcessingCoordinator({
      planner: plannerFor(plannedOperations),
      revalidator: matchingRevalidator,
      executor,
      history: { recordEvent },
      previewTtlMs: 60_000,
      maxWorkerConcurrency: 1,
    });
    const events: ProcessingEvent[] = [];
    coordinator.subscribe((event) => events.push(event));

    const preview = await coordinator.createPreview({
      sourcePaths: ['/source'],
      destinationPath: '/destination',
    });
    const accepted = await coordinator.startProcessing({
      previewId: preview.previewId,
      acknowledgeDestructiveOperation: false,
    });
    const terminal = await coordinator.waitForTerminal(accepted.jobId);
    expect(terminal.kind).toBe(ProcessingEventKind.JOB_COMPLETED);

    const stageEvents = events.filter(
      (event) =>
        event.kind === ProcessingEventKind.JOB_PROGRESS &&
        (event.payload as { preparation?: unknown }).preparation !== undefined
    );
    expect(stageEvents).toHaveLength(1);
    expect(stageEvents[0].payload).toMatchObject({
      phase: 'organization',
      filesProcessed: 0,
      totalFiles: 2,
      percentage: 0,
      preparation: {
        stage: 'Verifying preview evidence',
        completed: 5,
        total: 10,
        unit: 'records',
      },
    });
    expect(
      recordEvent.mock.calls.some(
        ([event]) =>
          event.kind === ProcessingEventKind.JOB_PROGRESS &&
          (event.payload as { preparation?: unknown }).preparation !== undefined
      )
    ).toBe(false);
  });
});
