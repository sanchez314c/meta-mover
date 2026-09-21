import { lstat, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  TransactionCorePort,
  TransactionalOperationExecutor,
} from '../../../src/main/services/TransactionalOperationExecutor';
import { PlannedOperation } from '../../../src/main/services/ProcessingCoordinator';
import { OperationMode } from '../../../src/shared/types/processing';
import { TransactionRequest, TransactionResult } from '../../../src/main/core/transaction';
import type { MetadataDateWriterPort } from '../../../src/main/core/metadata/MetadataDateWriter';
import type { NormalizationAuthorizationPort } from '../../../src/main/services/TransactionalOperationExecutor';

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
}

describe('TransactionalOperationExecutor', () => {
  let root: string;
  let destinationRoot: string;
  let sourcePath: string;
  let rootIdentity: { path: string; device: number; inode: number };
  let destinationIdentity: { path: string; device: number; inode: number };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-executor-unit-'));
    destinationRoot = path.join(root, 'destination');
    sourcePath = path.join(root, 'source.jpg');
    await mkdir(destinationRoot);
    const [rootStats, destinationStats] = await Promise.all([lstat(root), lstat(destinationRoot)]);
    rootIdentity = { path: root, device: rootStats.dev, inode: rootStats.ino };
    destinationIdentity = {
      path: destinationRoot,
      device: destinationStats.dev,
      inode: destinationStats.ino,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function operation(overrides: Partial<PlannedOperation> = {}): PlannedOperation {
    const targetPath =
      overrides.targetPath ?? path.join(destinationRoot, '2024', '05', 'photo.jpg');
    return {
      id: 'operation-001',
      sourcePath,
      targetPath,
      bytes: 12,
      payload: {
        destinationRoot,
        validatedRoots: {
          sourcePaths: [root],
          destinationPath: destinationRoot,
          sourceIdentities: [rootIdentity],
          destinationIdentity,
        },
        sourceIdentity: { device: 1, inode: 2, links: 1, size: 12 },
        modifiedTimeMs: 1234,
        contentSha256: 'a'.repeat(64),
        destinationSnapshot: {
          path: targetPath,
          occupied: false,
          source: 'filesystem',
        },
      },
      ...overrides,
      targetPath,
    };
  }

  function result(overrides: Partial<TransactionResult> = {}): TransactionResult {
    return {
      operationId: 'operation-001',
      sourcePath,
      destinationPath: path.join(destinationRoot, '2024', '05', 'photo.jpg'),
      status: 'copied',
      committed: true,
      sourceRetained: true,
      hash: 'a'.repeat(64),
      bytes: 12,
      ...overrides,
    };
  }

  function context(mode = OperationMode.COPY) {
    return {
      jobId: 'job-1',
      previewId: 'preview-1',
      mode,
      writeMetadataDates: false,
      signal: new AbortController().signal,
    };
  }

  function resolvedDatePayload(): Record<string, unknown> {
    return {
      mediaKind: 'image',
      dateResolution: {
        policyVersion: 'date-resolution/1',
        fileId: '1:2',
        mediaKind: 'image',
        target: 'capture-time',
        evaluationTimeUtc: '2026-08-29T12:00:00.000Z',
        status: 'resolved',
        confidence: 'high',
        selectedCandidateId: 'candidate-1',
        selectedGroupId: 'group-1',
        selectedGroupScore: 95,
        selectedValue: {
          localIso: '2024-03-04T05:06:07',
          instantUtc: '2024-03-04T10:06:07.000Z',
          offsetMinutes: -300,
          zoneBasis: 'explicit-offset',
          precision: 'second',
        },
        contenderIds: [],
        rejected: [],
        reasonCodes: [],
        candidates: [],
      },
    };
  }

  function normalizationReceipt() {
    return {
      family: 'jpeg' as const,
      idempotent: false,
      verified: true as const,
      before: {},
      after: {},
      normalizedTags: ['ExifIFD:DateTimeOriginal'],
    };
  }

  it('serializes and caches one core per canonical destination root', async () => {
    let factoryCalls = 0;
    let releaseFactory!: () => void;
    const factoryBarrier = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const core: TransactionCorePort = {
      execute: jest.fn(async (request) =>
        result({
          operationId: request.operationId,
          destinationPath: request.expectedDestinationPath,
        })
      ),
      close: jest.fn(async () => undefined),
    };
    const executor = new TransactionalOperationExecutor({
      coreFactory: async () => {
        factoryCalls += 1;
        await factoryBarrier;
        return core;
      },
    });

    const first = executor.execute(operation(), context());
    const second = executor.execute(
      operation({ id: 'operation-002', targetPath: path.join(destinationRoot, 'other.jpg') }),
      context()
    );
    await waitUntil(() => factoryCalls === 1);
    expect(factoryCalls).toBe(1);
    releaseFactory();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(core.execute).toHaveBeenCalledTimes(2);
    await executor.close();
  });

  it('rejects a changed source-root capability set for an already cached destination core', async () => {
    const core: TransactionCorePort = {
      execute: jest.fn(async (request) =>
        result({
          operationId: request.operationId,
          destinationPath: request.expectedDestinationPath,
        })
      ),
      close: jest.fn(async () => undefined),
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });
    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      outcome: 'committed',
    });

    const additionalRoot = path.join(root, 'additional-source-root');
    await mkdir(additionalRoot);
    const additionalStats = await lstat(additionalRoot);
    const planned = operation({ id: 'operation-with-expanded-roots' });
    const payload = planned.payload as Record<string, unknown>;
    const validatedRoots = payload.validatedRoots as Record<string, unknown>;
    const expanded = {
      ...planned,
      payload: {
        ...payload,
        validatedRoots: {
          ...validatedRoots,
          sourcePaths: [root, additionalRoot],
          sourceIdentities: [
            rootIdentity,
            {
              path: additionalRoot,
              device: additionalStats.dev,
              inode: additionalStats.ino,
            },
          ],
        },
      },
    };

    await expect(executor.execute(expanded, context())).rejects.toThrow(
      /different source-root set/i
    );
    expect(core.execute).toHaveBeenCalledTimes(1);
    await executor.close();
    expect(core.close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed non-object payloads before native admission', async () => {
    const executor = new TransactionalOperationExecutor({
      coreFactory: jest.fn<Promise<TransactionCorePort>, [string]>(),
    });
    const invalid = { ...operation(), payload: null } as unknown as PlannedOperation;

    await expect(executor.execute(invalid, context())).rejects.toThrow(/plain object/i);
    await executor.close();
  });

  it('rejects a signal already cancelled before parsing or native admission', async () => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute(operation(), { ...context(), signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('requires a native helper factory when constructed with production defaults', async () => {
    const executor = new TransactionalOperationExecutor();

    await expect(executor.execute(operation(), context())).rejects.toThrow(
      /native filesystem helper factory/i
    );
    await executor.close();
  });

  it('defers the first whole-file hash until approved transaction execution', async () => {
    const core: TransactionCorePort = {
      execute: jest.fn(async (request) =>
        result({
          operationId: request.operationId,
          destinationPath: request.expectedDestinationPath,
          hash: 'b'.repeat(64),
        })
      ),
      close: async () => undefined,
    };
    const planned = operation();
    delete (planned.payload as Record<string, unknown>).contentSha256;
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(planned, context())).resolves.toMatchObject({
      outcome: 'committed',
    });
    expect(core.execute).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSha256: undefined })
    );
    await executor.close();
  });

  it('normalizes private staging before the transaction publishes when enabled and resolved', async () => {
    const stagingPath = path.join(destinationRoot, '.meta-mover', 'staging', 'operation-001.part');
    const core: TransactionCorePort = {
      execute: async (request) => {
        await request.transformStaging?.({ stagingPath, signal: request.signal });
        return result();
      },
      close: async () => undefined,
    };
    const metadataWriter: MetadataDateWriterPort = {
      normalizeDateMetadata: jest.fn(async () => normalizationReceipt()),
      close: jest.fn(async () => undefined),
    };
    const planned = operation();
    planned.payload = {
      ...(planned.payload as Record<string, unknown>),
      ...resolvedDatePayload(),
    };
    const executor = new TransactionalOperationExecutor({
      coreFactory: async () => core,
      metadataWriter,
      normalizationAuthorization: {
        authorizeNormalization: jest.fn(async () => true),
      },
    });

    await expect(
      executor.execute(planned, { ...context(), writeMetadataDates: true })
    ).resolves.toMatchObject({ outcome: 'committed', bytes: 12 });
    expect(metadataWriter.normalizeDateMetadata).toHaveBeenCalledWith({
      filePath: stagingPath,
      selectedDate: expect.objectContaining({ localIso: '2024-03-04T05:06:07' }),
      signal: expect.any(AbortSignal),
    });
    await executor.close();
    expect(metadataWriter.close).toHaveBeenCalledTimes(1);
  });

  it('copies without metadata mutation when the immutable audit does not authorize the row', async () => {
    const core: TransactionCorePort = {
      execute: jest.fn(async (request) => result({ operationId: request.operationId })),
      close: async () => undefined,
    };
    const metadataWriter: MetadataDateWriterPort = {
      normalizeDateMetadata: jest.fn(async () => normalizationReceipt()),
      close: async () => undefined,
    };
    const normalizationAuthorization: NormalizationAuthorizationPort = {
      authorizeNormalization: jest.fn(async () => false),
    };
    const planned = operation();
    planned.payload = { ...(planned.payload as Record<string, unknown>), ...resolvedDatePayload() };
    const executor = new TransactionalOperationExecutor({
      coreFactory: async () => core,
      metadataWriter,
      normalizationAuthorization,
    });

    await expect(
      executor.execute(planned, { ...context(), writeMetadataDates: true })
    ).resolves.toMatchObject({ outcome: 'committed' });
    expect(normalizationAuthorization.authorizeNormalization).toHaveBeenCalledWith(
      expect.objectContaining({
        previewId: 'preview-1',
        sourcePath,
        outputPath: planned.targetPath,
      })
    );
    expect(metadataWriter.normalizeDateMetadata).not.toHaveBeenCalled();
    await executor.close();
  });

  it('forwards the job signal and stage progress channel into audit authorization', async () => {
    const core: TransactionCorePort = {
      execute: jest.fn(async (request) =>
        result({
          operationId: request.operationId,
          destinationPath: request.expectedDestinationPath,
        })
      ),
      close: async () => undefined,
    };
    const authorizeNormalization = jest.fn(async () => true);
    const executor = new TransactionalOperationExecutor({
      coreFactory: async () => core,
      metadataWriter: {
        normalizeDateMetadata: jest.fn(async () => normalizationReceipt()),
        close: jest.fn(async () => undefined),
      },
      normalizationAuthorization: { authorizeNormalization },
    });
    const planned = operation();
    planned.payload = {
      ...(planned.payload as Record<string, unknown>),
      ...resolvedDatePayload(),
    };
    const controller = new AbortController();
    const reportStageProgress = jest.fn(async () => undefined);

    await executor.execute(planned, {
      ...context(),
      writeMetadataDates: true,
      signal: controller.signal,
      reportStageProgress,
    });

    expect(authorizeNormalization).toHaveBeenCalledTimes(1);
    const request = authorizeNormalization.mock.calls[0][0] as Record<string, unknown>;
    expect(request.signal).toBe(controller.signal);
    expect(request.reportProgress).toBe(reportStageProgress);
    await executor.close();
  });

  it('leaves destination metadata untouched when normalization is disabled or unresolved', async () => {
    const core: TransactionCorePort = {
      execute: async (request) =>
        result({
          operationId: request.operationId,
          destinationPath: request.expectedDestinationPath,
        }),
      close: async () => undefined,
    };
    const metadataWriter: MetadataDateWriterPort = {
      normalizeDateMetadata: jest.fn(async () => normalizationReceipt()),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({
      coreFactory: async () => core,
      metadataWriter,
      normalizationAuthorization: { authorizeNormalization: async () => true },
    });

    await executor.execute(operation(), { ...context(), writeMetadataDates: true });
    const resolved = operation({ id: 'operation-002' });
    resolved.payload = {
      ...(resolved.payload as Record<string, unknown>),
      ...resolvedDatePayload(),
    };
    await executor.execute(resolved, context());

    expect(metadataWriter.normalizeDateMetadata).not.toHaveBeenCalled();
    await executor.close();
  });

  it('lets the transaction fail closed before publication when staging normalization fails', async () => {
    const core: TransactionCorePort = {
      execute: async (request) => {
        try {
          await request.transformStaging?.({
            stagingPath: path.join(destinationRoot, '.meta-mover', 'staging', 'operation-001.part'),
            signal: request.signal,
          });
        } catch (error) {
          return result({
            status: 'failed',
            committed: false,
            sourceRetained: true,
            destinationPath: undefined,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw new Error('expected transformer failure');
      },
      close: async () => undefined,
    };
    const metadataWriter: MetadataDateWriterPort = {
      normalizeDateMetadata: async () => {
        throw new Error('ExifTool write failed');
      },
      close: async () => undefined,
    };
    const planned = operation();
    planned.payload = {
      ...(planned.payload as Record<string, unknown>),
      ...resolvedDatePayload(),
    };
    const executor = new TransactionalOperationExecutor({
      coreFactory: async () => core,
      metadataWriter,
      normalizationAuthorization: { authorizeNormalization: async () => true },
    });

    await expect(
      executor.execute(planned, { ...context(OperationMode.MOVE), writeMetadataDates: true })
    ).resolves.toEqual({
      operationId: 'operation-001',
      outcome: 'failed',
      bytes: 0,
      sourceRetained: true,
      destinationCommitted: false,
      error: 'ExifTool write failed',
    });
    await executor.close();
  });

  it.each([
    ['outside target', () => operation({ targetPath: path.join(root, 'outside.jpg') })],
    [
      'control target',
      () => operation({ targetPath: path.join(destinationRoot, '.meta-mover', 'bad.jpg') }),
    ],
    [
      'snapshot mismatch',
      () => {
        const planned = operation();
        return {
          ...planned,
          payload: {
            ...(planned.payload as Record<string, unknown>),
            destinationSnapshot: {
              path: path.join(destinationRoot, 'different.jpg'),
              occupied: false,
              source: 'filesystem',
            },
          },
        };
      },
    ],
  ])('rejects an invalid %s before opening a core', async (_label, buildOperation) => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(buildOperation(), context())).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it.each([
    ['relative destination root', { destinationRoot: 'relative-destination' }],
    ['negative source device', { sourceIdentity: { device: -1, inode: 2, links: 1, size: 12 } }],
    ['non-finite modified time', { modifiedTimeMs: Number.NaN }],
    ['uppercase content hash', { contentSha256: 'A'.repeat(64) }],
    [
      'unknown snapshot source',
      {
        destinationSnapshot: {
          path: '/invalid-snapshot-source',
          occupied: false,
          source: 'unknown',
        },
      },
    ],
  ])('rejects payload evidence with %s', async (_label, payloadOverride) => {
    const planned = operation();
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        {
          ...planned,
          payload: { ...(planned.payload as Record<string, unknown>), ...payloadOverride },
        },
        context()
      )
    ).rejects.toThrow(/invalid preview evidence/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a resolved decision that omits its selected creation date', async () => {
    const planned = operation();
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });
    planned.payload = {
      ...(planned.payload as Record<string, unknown>),
      dateResolution: { status: 'resolved' },
    };

    await expect(executor.execute(planned, context())).rejects.toThrow(
      /invalid selected creation date/i
    );
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it.each([
    [
      'destination root identity drift',
      () => {
        const planned = operation();
        const payload = planned.payload as Record<string, unknown>;
        const validatedRoots = payload.validatedRoots as Record<string, unknown>;
        return {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              destinationIdentity: { ...destinationIdentity, inode: destinationIdentity.inode + 1 },
            },
          },
        };
      },
    ],
    [
      'source root identity drift',
      () => {
        const planned = operation();
        const payload = planned.payload as Record<string, unknown>;
        const validatedRoots = payload.validatedRoots as Record<string, unknown>;
        return {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              sourceIdentities: [{ ...rootIdentity, device: rootIdentity.device + 1 }],
            },
          },
        };
      },
    ],
  ])('rejects %s before transaction-core admission', async (_label, buildOperation) => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(buildOperation(), context())).rejects.toThrow(/root identity/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a source outside every validated source root before core admission', async () => {
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        operation({ sourcePath: path.join(path.dirname(root), 'outside.jpg') }),
        context()
      )
    ).rejects.toThrow(/outside.*source root/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a noncanonical validated root identity path before core admission', async () => {
    const planned = operation();
    const payload = planned.payload as Record<string, unknown>;
    const validatedRoots = payload.validatedRoots as Record<string, unknown>;
    const noncanonicalRoot = `${root}${path.sep}.`;
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              sourcePaths: [noncanonicalRoot],
              sourceIdentities: [{ ...rootIdentity, path: noncanonicalRoot }],
            },
          },
        },
        context()
      )
    ).rejects.toThrow(/not canonical/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a non-normalized exact target before core admission', async () => {
    const rawTarget = `${destinationRoot}${path.sep}2024${path.sep}..${path.sep}photo.jpg`;
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(operation({ targetPath: rawTarget }), context())).rejects.toThrow(
      /canonical and normalized/i
    );
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('rejects a validated source root identity that is not a directory', async () => {
    await writeFile(sourcePath, 'not-a-root-directory');
    const stats = await lstat(sourcePath);
    const planned = operation();
    const payload = planned.payload as Record<string, unknown>;
    const validatedRoots = payload.validatedRoots as Record<string, unknown>;
    const factory = jest.fn<Promise<TransactionCorePort>, [string]>();
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(
      executor.execute(
        {
          ...planned,
          payload: {
            ...payload,
            validatedRoots: {
              ...validatedRoots,
              sourcePaths: [sourcePath],
              sourceIdentities: [{ path: sourcePath, device: stats.dev, inode: stats.ino }],
            },
          },
        },
        context()
      )
    ).rejects.toThrow(/non-symlink directory/i);
    expect(factory).not.toHaveBeenCalled();
    await executor.close();
  });

  it('evicts a rejected core creation so a later admission can retry', async () => {
    const core: TransactionCorePort = {
      execute: async () => result(),
      close: async () => undefined,
    };
    let attempt = 0;
    const factory = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('core creation failed');
      return core;
    });
    const executor = new TransactionalOperationExecutor({ coreFactory: factory });

    await expect(executor.execute(operation(), context())).rejects.toThrow(/creation failed/i);
    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      outcome: 'committed',
    });
    expect(factory).toHaveBeenCalledTimes(2);
    await executor.close();
  });

  it.each([
    ['copied', true, 'committed', 12],
    ['moved', true, 'committed', 12],
    ['duplicate', true, 'skipped', 0],
    ['cancelled', true, 'committed', 12],
    ['failed', true, 'committed', 12],
    ['failed', false, 'failed', 0],
  ] as const)('maps %s committed=%s to %s', async (status, committed, outcome, bytes) => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status,
          committed,
          ...(status === 'failed' ? { error: 'post-commit verification failed' } : {}),
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      operationId: 'operation-001',
      outcome,
      bytes,
    });
    await executor.close();
  });

  it('returns an exact source-retained outcome for precommit cancellation', async () => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({ status: 'cancelled', committed: false, destinationPath: undefined }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context())).resolves.toEqual({
      operationId: 'operation-001',
      outcome: 'cancelled',
      bytes: 0,
      cancellationState: 'cancelled-before-commit',
      sourceRetained: true,
      destinationCommitted: false,
      error: 'Transaction cancelled before commit',
    });
    await executor.close();
  });

  it('reports a committed cancelled Move as destination residue with the source retained', async () => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status: 'cancelled',
          committed: true,
          sourceRetained: true,
          error: 'operator cancelled after destination commit',
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context(OperationMode.MOVE))).resolves.toEqual({
      operationId: 'operation-001',
      outcome: 'cancelled',
      bytes: 12,
      cancellationState: 'destination-committed-source-retained',
      sourceRetained: true,
      destinationCommitted: true,
      error: 'operator cancelled after destination commit',
    });
    await executor.close();
  });

  it('preserves a zero-byte post-commit Move cancellation as committed destination residue', async () => {
    const planned = operation({ bytes: 0 });
    planned.payload = {
      ...(planned.payload as Record<string, unknown>),
      sourceIdentity: { device: 1, inode: 2, links: 1, size: 0 },
    };
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status: 'cancelled',
          committed: true,
          sourceRetained: true,
          bytes: 0,
          error: 'cancelled after zero-byte destination commit',
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(planned, context(OperationMode.MOVE))).resolves.toMatchObject({
      outcome: 'cancelled',
      bytes: 0,
      cancellationState: 'destination-committed-source-retained',
      destinationCommitted: true,
      sourceRetained: true,
    });
    await executor.close();
  });

  it('does not report a failed partial Move with retained source as successful', async () => {
    const core: TransactionCorePort = {
      execute: async () =>
        result({
          status: 'failed',
          committed: true,
          sourceRetained: true,
          error: 'move did not reach its requested terminal state',
        }),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context(OperationMode.MOVE))).resolves.toEqual({
      operationId: 'operation-001',
      outcome: 'failed',
      bytes: 12,
      sourceRetained: true,
      destinationCommitted: true,
      error: 'move did not reach its requested terminal state',
    });
    await executor.close();
  });

  it('uses deterministic fallback errors for incomplete failed core results', async () => {
    const core: TransactionCorePort = {
      execute: jest
        .fn<Promise<TransactionResult>, [TransactionRequest]>()
        .mockResolvedValueOnce(
          result({ status: 'failed', committed: true, sourceRetained: true, error: undefined })
        )
        .mockResolvedValueOnce(
          result({
            status: 'failed',
            committed: false,
            destinationPath: undefined,
            error: undefined,
          })
        ),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context(OperationMode.MOVE))).resolves.toMatchObject(
      {
        outcome: 'failed',
        error: 'Move committed bytes but did not complete source transfer',
      }
    );
    await expect(executor.execute(operation(), context())).resolves.toMatchObject({
      outcome: 'failed',
      error: 'Transaction failed before commit',
    });
    await executor.close();
  });

  it.each([
    ['operation ID', { operationId: 'different-operation' }],
    ['content hash', { hash: 'b'.repeat(64) }],
    ['byte count', { bytes: 13 }],
    ['committed destination', { destinationPath: path.join(tmpdir(), 'wrong-destination.jpg') }],
  ])('rejects a core result that diverges in %s', async (_label, resultOverride) => {
    const core: TransactionCorePort = {
      execute: async () => result(resultOverride),
      close: async () => undefined,
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });

    await expect(executor.execute(operation(), context())).rejects.toThrow(/diverges/i);
    await executor.close();
  });

  it('waits for admitted work and closes cached cores exactly once', async () => {
    let releaseExecution!: () => void;
    const executionBarrier = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const core: TransactionCorePort = {
      execute: jest.fn(async () => {
        await executionBarrier;
        return result();
      }),
      close: jest.fn(async () => undefined),
    };
    const executor = new TransactionalOperationExecutor({ coreFactory: async () => core });
    const execution = executor.execute(operation(), context());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstClose = executor.close();
    const secondClose = executor.close();
    expect(core.close).not.toHaveBeenCalled();
    await expect(executor.execute(operation(), context())).rejects.toThrow(/closed|closing/i);
    releaseExecution();

    await execution;
    await Promise.all([firstClose, secondClose]);
    expect(core.close).toHaveBeenCalledTimes(1);
  });
});
