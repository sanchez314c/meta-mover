import { createHash } from 'crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { DateCandidateInput } from '../../../src/main/core/date';
import { InventoryMediaFile } from '../../../src/main/core/inventory/MediaInventory';
import {
  FilesystemSourceContentProbe,
  MediaPreviewPlanner,
  PlannedMediaPayload,
} from '../../../src/main/services/MediaPreviewPlanner';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  PreviewRequestDTO,
} from '../../../src/shared/types/processing';

const request = (overrides: Partial<PreviewRequestDTO> = {}): PreviewRequestDTO => ({
  sourcePaths: ['/source'],
  destinationPath: '/destination',
  options: {
    operation: OperationMode.COPY,
    conflictPolicy: ConflictPolicy.RENAME,
    folderStructure: FolderStructure.YEAR_MONTH,
    workerCount: 2,
    verifyIntegrity: true,
    appendScreenshotSuffix: false,
    writeMetadataDates: false,
  },
  ...overrides,
});

const inventoryFile = (overrides: Partial<InventoryMediaFile> = {}): InventoryMediaFile => ({
  filePath: '/source/photo.jpg',
  formatStatus: 'supported',
  extension: '.jpg',
  mediaKind: 'image',
  device: 7,
  inode: 11,
  links: 1,
  size: 123,
  modifiedTimeMs: Date.parse('2026-08-29T12:00:00.000Z'),
  ...overrides,
});

const embeddedCandidate = (fileId = '7:11'): DateCandidateInput => ({
  id: `${fileId}:embedded`,
  fileId,
  mediaKind: 'image',
  semantic: 'capture',
  sourceKind: 'embedded-exif',
  sourceFamily: 'exif',
  tag: 'EXIF:DateTimeOriginal',
  rawValue: '2024:03:04 05:06:07-05:00',
  value: {
    localIso: '2024-03-04T05:06:07',
    instantUtc: '2024-03-04T10:06:07.000Z',
    offsetMinutes: -300,
    zoneBasis: 'explicit-offset',
    precision: 'second',
  },
});

const roots = {
  validate: async (sourcePaths: readonly string[], destinationPath: string) => ({
    sourcePaths: [...sourcePaths],
    destinationPath,
    sourceIdentities: sourcePaths.map((rootPath, index) => ({
      path: rootPath,
      device: 1,
      inode: index + 1,
    })),
    destinationIdentity: { path: destinationPath, device: 2, inode: 1 },
  }),
};

const digest = 'a'.repeat(64);
const sourceContent = {
  capture: async (file: Readonly<InventoryMediaFile>) => ({
    sha256: digest,
    verifiedExtractionPath: file.filePath,
    filesystemBirthTimeUtc: null,
    release: async () => undefined,
  }),
};
const availableDestination = {
  inspect: async (targetPath: string) => ({
    path: targetPath,
    occupied: false as const,
    source: 'filesystem' as const,
  }),
};

const occupiedDestination = (targetPath: string) => ({
  path: targetPath,
  occupied: true as const,
  source: 'filesystem' as const,
  identity: { device: 9, inode: 10, links: 1, type: 'file' as const },
});

describe('MediaPreviewPlanner', () => {
  it('uses resolved metadata, reserves deterministic rename targets, and emits executable payloads', async () => {
    const files = [
      inventoryFile(),
      inventoryFile({ filePath: '/source/photo-copy.jpg', inode: 12, size: 456 }),
    ];
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => files },
      roots,
      metadata: {
        collectDetailed: async ({ fileId }) => ({
          candidates: [embeddedCandidate(fileId)],
          warnings: [],
        }),
      },
      destination: {
        inspect: async (targetPath) =>
          targetPath.endsWith('2024-03-04_05-06-07.jpg')
            ? occupiedDestination(targetPath)
            : availableDestination.inspect(targetPath),
      },
      sourceContent,
      now: () => Date.parse('2026-08-29T13:00:00.000Z'),
      platform: 'linux',
    });

    const plan = await planner.plan(request());

    expect(plan.summary).toEqual({
      totalFiles: 2,
      copyFiles: 2,
      moveFiles: 0,
      skippedFiles: 0,
      renamedFiles: 2,
      overwrittenFiles: 0,
      unresolvedDates: 0,
      totalBytes: 579,
    });
    expect(plan.rows?.map((row) => row.targetPath)).toEqual([
      path.join('/destination', '2024', '03', '2024-03-04_05-06-07_1.jpg'),
      path.join('/destination', '2024', '03', '2024-03-04_05-06-07_2.jpg'),
    ]);
    expect(plan.rows?.[0].dateEvidence).toMatchObject({
      source: 'embedded',
      field: 'EXIF:DateTimeOriginal',
      confidence: 1,
      value: '2024-03-04T10:06:07.000Z',
    });
    expect(plan.operations).toHaveLength(2);
    expect(plan.decisionRecords).toHaveLength(2);
    expect(
      plan.decisionRecords?.find((record) => record.sourcePath === '/source/photo.jpg')
    ).toMatchObject({
      rowIndex: 1,
      sourcePath: '/source/photo.jpg',
      resolution: {
        policyVersion: 'date-resolution/1',
        fileId: '7:11',
        candidates: [expect.objectContaining({ rawValue: '2024:03:04 05:06:07-05:00' })],
      },
    });
    const firstPayload = plan.operations.find((entry) => entry.sourcePath === '/source/photo.jpg')
      ?.payload as PlannedMediaPayload;
    expect(firstPayload).toMatchObject({
      destinationRoot: '/destination',
      sourceIdentity: { device: 7, inode: 11, links: 1, size: 123 },
      validatedRoots: {
        sourceIdentities: [{ path: '/source', device: 1, inode: 1 }],
        destinationIdentity: { path: '/destination', device: 2, inode: 1 },
      },
      modifiedTimeMs: Date.parse('2026-08-29T12:00:00.000Z'),
      mediaKind: 'image',
      contentSha256: digest,
      destinationSnapshot: { occupied: false, source: 'filesystem' },
    });
    expect(plan.rows?.every((row) => row.fingerprint.hash === digest)).toBe(true);
  });

  it('carries screenshot evidence into the reviewed target before collision allocation', async () => {
    const planner = new MediaPreviewPlanner({
      inventory: {
        inventory: async () => [
          inventoryFile({ filePath: '/source/IMG_0042.PNG', extension: '.png' }),
        ],
      },
      roots,
      metadata: {
        collectDetailed: async ({ fileId }) => ({
          candidates: [embeddedCandidate(fileId)],
          warnings: [],
          screenshotEvidence: { source: 'metadata', field: 'EXIF:UserComment' },
        }),
      },
      destination: availableDestination,
      sourceContent,
      now: () => Date.parse('2026-08-29T13:00:00.000Z'),
    });

    const plan = await planner.plan(
      request({
        options: { ...request().options, appendScreenshotSuffix: true },
      })
    );

    expect(plan.rows?.[0].targetPath).toBe(
      path.join('/destination', '2024', '03', '2024-03-04_05-06-07-screen-shot.PNG')
    );
    expect(plan.operations[0]?.targetPath).toBe(plan.rows?.[0].targetPath);
    expect(plan.rows?.[0].warnings).toContain(
      'Screenshot detected from metadata evidence (EXIF:UserComment); target filename includes -screen-shot'
    );
  });

  it('reports exact preview progress and the next file without advancing before completion', async () => {
    const files = [
      inventoryFile({ filePath: '/source/b.jpg', inode: 12 }),
      inventoryFile({ filePath: '/source/a.jpg', inode: 11 }),
    ];
    const progress = jest.fn();
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => files },
      roots,
      metadata: {
        collectDetailed: async ({ fileId }) => ({
          candidates: [embeddedCandidate(fileId)],
          warnings: [],
        }),
      },
      destination: availableDestination,
      sourceContent,
      now: () => Date.parse('2026-08-29T13:00:00.000Z'),
    });

    await planner.plan(request(), undefined, progress);

    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      {
        phase: 'metadata',
        filesProcessed: 0,
        totalFiles: 2,
        percentage: 0,
        currentFile: '/source/a.jpg',
      },
      {
        phase: 'metadata',
        filesProcessed: 1,
        totalFiles: 2,
        percentage: 50,
        currentFile: '/source/b.jpg',
      },
      {
        phase: 'organization',
        filesProcessed: 2,
        totalFiles: 2,
        percentage: 100,
      },
    ]);
  });

  it('routes unresolved dates to review without inventing a date', async () => {
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => [inventoryFile()] },
      roots,
      metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
      destination: availableDestination,
      sourceContent,
      now: () => Date.parse('2026-08-29T13:00:00.000Z'),
    });

    const plan = await planner.plan(request());

    expect(plan.summary.unresolvedDates).toBe(1);
    expect(plan.rows?.[0]).toMatchObject({
      targetPath: path.join('/destination', '_Needs Review', 'photo.jpg'),
      dateEvidence: { value: null, source: 'unresolved', confidence: 0 },
    });
    expect(plan.rows?.[0].warnings).toContain('Creation date requires review');
  });

  it('reports unsupported files as explicit non-mutating Needs Review rows', async () => {
    const metadata = jest.fn();
    const capture = jest.fn();
    const inspect = jest.fn();
    const progress = jest.fn();
    const planner = new MediaPreviewPlanner({
      inventory: {
        inventory: async () => [
          inventoryFile({
            filePath: '/source/unknown.media',
            formatStatus: 'unsupported',
            extension: '.media',
            mediaKind: null,
          }),
        ],
      },
      roots,
      metadata: { collectDetailed: metadata },
      destination: { inspect },
      sourceContent: { capture },
    });

    const plan = await planner.plan(request(), undefined, progress);

    expect(plan.operations).toEqual([]);
    expect(plan.summary).toMatchObject({
      totalFiles: 1,
      copyFiles: 0,
      moveFiles: 0,
      skippedFiles: 1,
      unresolvedDates: 1,
      totalBytes: 123,
    });
    expect(plan.rows?.[0]).toMatchObject({
      sourcePath: '/source/unknown.media',
      targetPath: null,
      operation: 'skip',
      dateEvidence: { value: null, source: 'unresolved', confidence: 0 },
      warnings: [
        'Needs Review: unsupported or unrecognized file format (.media). Source left unchanged.',
      ],
    });
    expect(metadata).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      {
        phase: 'metadata',
        filesProcessed: 0,
        totalFiles: 1,
        percentage: 0,
        currentFile: '/source/unknown.media',
      },
      {
        phase: 'organization',
        filesProcessed: 1,
        totalFiles: 1,
        percentage: 100,
      },
    ]);
  });

  it('surfaces metadata read warnings and skips occupied targets under skip policy', async () => {
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => [inventoryFile()] },
      roots,
      metadata: {
        collectDetailed: async ({ fileId }) => ({
          candidates: [embeddedCandidate(fileId)],
          warnings: ['Metadata read failed: malformed container'],
        }),
      },
      destination: { inspect: async (targetPath) => occupiedDestination(targetPath) },
      sourceContent,
      now: () => Date.parse('2026-08-29T13:00:00.000Z'),
    });

    const plan = await planner.plan(
      request({ options: { ...request().options, conflictPolicy: ConflictPolicy.SKIP } })
    );

    expect(plan.operations).toEqual([]);
    expect(plan.summary).toMatchObject({ skippedFiles: 1, copyFiles: 0, renamedFiles: 0 });
    expect(plan.rows?.[0]).toMatchObject({
      operation: 'skip',
      destinationSnapshot: {
        occupied: true,
        identity: { device: 9, inode: 10, links: 1, type: 'file' },
      },
    });
    expect(plan.rows?.[0].warnings).toEqual(
      expect.arrayContaining(['Metadata read failed: malformed container', 'Target already exists'])
    );
  });

  it('treats targets reserved earlier in the same preview as conflicts', async () => {
    const files = [inventoryFile(), inventoryFile({ filePath: '/source/again.jpg', inode: 12 })];
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => files },
      roots,
      metadata: {
        collectDetailed: async ({ fileId }) => ({
          candidates: [embeddedCandidate(fileId)],
          warnings: [],
        }),
      },
      destination: availableDestination,
      sourceContent,
      now: () => Date.parse('2026-08-29T13:00:00.000Z'),
    });

    const plan = await planner.plan(request());

    expect(plan.rows?.map((row) => row.targetPath)).toEqual([
      path.join('/destination', '2024', '03', '2024-03-04_05-06-07.jpg'),
      path.join('/destination', '2024', '03', '2024-03-04_05-06-07_1.jpg'),
    ]);
    expect(plan.summary.renamedFiles).toBe(1);
  });

  it('sorts inventory before deterministic collision allocation', async () => {
    const first = inventoryFile({ filePath: '/source/a.jpg', inode: 11 });
    const second = inventoryFile({ filePath: '/source/b.jpg', inode: 12 });
    const build = (files: InventoryMediaFile[]) =>
      new MediaPreviewPlanner({
        inventory: { inventory: async () => files },
        roots,
        metadata: {
          collectDetailed: async ({ fileId }) => ({
            candidates: [embeddedCandidate(fileId)],
            warnings: [],
          }),
        },
        destination: availableDestination,
        sourceContent,
        now: () => Date.parse('2026-08-29T13:00:00.000Z'),
      });

    const forward = await build([first, second]).plan(request());
    const reverse = await build([second, first]).plan(request());
    const targets = (plan: Awaited<ReturnType<MediaPreviewPlanner['plan']>>) =>
      plan.operations.map(({ sourcePath, targetPath }) => [sourcePath, targetPath]);

    expect(targets(reverse)).toEqual(targets(forward));
  });

  it('rejects inventory arithmetic that exceeds the safe integer range', async () => {
    const planner = new MediaPreviewPlanner({
      inventory: {
        inventory: async () => [
          inventoryFile({ filePath: '/source/a.jpg', inode: 11, size: Number.MAX_SAFE_INTEGER }),
          inventoryFile({ filePath: '/source/b.jpg', inode: 12, size: Number.MAX_SAFE_INTEGER }),
        ],
      },
      roots,
      metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
      destination: availableDestination,
      sourceContent,
    });

    await expect(planner.plan(request())).rejects.toThrow(/safe integer|total bytes/i);
  });

  it('rejects a root identity replacement before inventory begins', async () => {
    const inventory = jest.fn(async () => []);
    const validatedRoots = {
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      sourceIdentities: [{ path: '/source', device: 7, inode: 11 }],
      destinationIdentity: { path: '/destination', device: 8, inode: 12 },
    };
    const planner = new MediaPreviewPlanner({
      inventory: { inventory },
      roots: {
        validate: async () => ({
          ...validatedRoots,
          sourceIdentities: [{ path: '/source', device: 7, inode: 99 }],
        }),
      },
      metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
      destination: availableDestination,
      sourceContent,
    });

    await expect(
      planner.plan({ ...request(), validatedRoots } as PreviewRequestDTO & {
        validatedRoots: typeof validatedRoots;
      })
    ).rejects.toThrow(/root identity changed/i);
    expect(inventory).not.toHaveBeenCalled();
  });

  it('supports cooperative cancellation during collision probing', async () => {
    const controller = new AbortController();
    let probes = 0;
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => [inventoryFile()] },
      roots,
      metadata: {
        collectDetailed: async ({ fileId }) => ({
          candidates: [embeddedCandidate(fileId)],
          warnings: [],
        }),
      },
      destination: {
        inspect: async (targetPath) => {
          probes += 1;
          controller.abort('operator cancelled preview');
          return occupiedDestination(targetPath);
        },
      },
      sourceContent,
    });

    await expect(planner.plan(request(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(probes).toBe(1);
  });

  it('bounds collision suffix probing with an explicit failure', async () => {
    let probes = 0;
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => [inventoryFile()] },
      roots,
      metadata: {
        collectDetailed: async ({ fileId }) => ({
          candidates: [embeddedCandidate(fileId)],
          warnings: [],
        }),
      },
      destination: {
        inspect: async (targetPath) => {
          probes += 1;
          return occupiedDestination(targetPath);
        },
      },
      sourceContent,
      maxCollisionAttempts: 3,
    });

    await expect(planner.plan(request())).rejects.toThrow(/collision attempts/i);
    expect(probes).toBe(4);
  });

  it('streams a no-follow source digest and records source and destination snapshots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-planner-digest-'));
    try {
      const filePath = path.join(root, 'photo.jpg');
      await writeFile(filePath, 'ground-truth-bytes');
      const stats = await lstat(filePath);
      const expectedHash = createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex');
      const planner = new MediaPreviewPlanner({
        inventory: {
          inventory: async () => [
            inventoryFile({
              filePath,
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
              modifiedTimeMs: stats.mtimeMs,
            }),
          ],
        },
        roots,
        metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
        destination: availableDestination,
        now: () => Date.parse('2026-08-29T13:00:00.000Z'),
      });

      const plan = await planner.plan(request());

      expect(plan.rows?.[0].fingerprint.hash).toBe(expectedHash);
      expect(plan.operations[0].payload as PlannedMediaPayload).toMatchObject({
        contentSha256: expectedHash,
        destinationSnapshot: {
          occupied: false,
          path: expect.any(String),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds metadata to the hashed inventoried bytes across source pathname swap and restoration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-planner-bound-metadata-'));
    try {
      const filePath = path.join(root, 'photo.jpg');
      const displacedPath = path.join(root, 'inventoried-photo.jpg');
      const inventoriedBytes = 'inventoried-ground-truth-bytes';
      const replacementBytes = 'concurrent-path-replacement';
      await writeFile(filePath, inventoriedBytes);
      const stats = await lstat(filePath);
      const expectedHash = createHash('sha256').update(inventoriedBytes).digest('hex');
      let extractionPath = '';
      const planner = new MediaPreviewPlanner({
        inventory: {
          inventory: async () => [
            inventoryFile({
              filePath,
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
              modifiedTimeMs: stats.mtimeMs,
            }),
          ],
        },
        roots,
        metadata: {
          collectDetailed: async (metadataRequest) => {
            extractionPath = metadataRequest.verifiedExtractionPath;
            expect(metadataRequest.expectedContentSha256).toBe(expectedHash);
            expect(metadataRequest.expectedContentBytes).toBe(stats.size);
            expect((await lstat(extractionPath)).mode & 0o222).toBe(0);
            expect((await lstat(path.dirname(extractionPath))).mode & 0o222).toBe(0);
            await rename(filePath, displacedPath);
            await writeFile(filePath, replacementBytes);
            try {
              const extractedBytes = await readFile(extractionPath, 'utf8');
              return {
                candidates: [
                  extractedBytes === inventoriedBytes
                    ? embeddedCandidate(`${stats.dev}:${stats.ino}`)
                    : {
                        ...embeddedCandidate(`${stats.dev}:${stats.ino}`),
                        rawValue: '2035:01:02 03:04:05Z',
                        value: {
                          localIso: '2035-01-02T03:04:05',
                          instantUtc: '2035-01-02T03:04:05.000Z',
                          offsetMinutes: 0,
                          zoneBasis: 'explicit-offset',
                          precision: 'second',
                        },
                      },
                ],
                warnings: [],
              };
            } finally {
              await rm(filePath, { force: true });
              await rename(displacedPath, filePath);
            }
          },
        },
        destination: availableDestination,
        now: () => Date.parse('2026-08-29T13:00:00.000Z'),
      });

      const plan = await planner.plan(request());

      expect(extractionPath).not.toBe(filePath);
      expect(plan.rows?.[0]).toMatchObject({
        targetPath: path.join('/destination', '2024', '03', '2024-03-04_05-06-07.jpg'),
        fingerprint: { hash: expectedHash },
      });
      expect(await readFile(filePath, 'utf8')).toBe(inventoriedBytes);
      await expect(lstat(extractionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(path.dirname(extractionPath))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases the private metadata snapshot when extraction fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-planner-metadata-failure-'));
    try {
      const filePath = path.join(root, 'photo.jpg');
      await writeFile(filePath, 'inventoried-ground-truth-bytes');
      const stats = await lstat(filePath);
      let extractionPath = '';
      const planner = new MediaPreviewPlanner({
        inventory: {
          inventory: async () => [
            inventoryFile({
              filePath,
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
              modifiedTimeMs: stats.mtimeMs,
            }),
          ],
        },
        roots,
        metadata: {
          collectDetailed: async (metadataRequest) => {
            extractionPath = metadataRequest.verifiedExtractionPath;
            throw new Error('deterministic metadata failure');
          },
        },
        destination: availableDestination,
      });

      await expect(planner.plan(request())).rejects.toThrow('deterministic metadata failure');
      await expect(lstat(extractionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(filePath, 'utf8')).toBe('inventoried-ground-truth-bytes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries unfinished snapshot cleanup phases after capture and cleanup both fail', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-planner-capture-cleanup-'));
    const chmodMock = jest.fn(chmod);
    const rmdirMock = jest.fn(rmdir);
    let snapshotDirectory = '';
    try {
      const filePath = path.join(root, 'photo.jpg');
      await writeFile(filePath, 'inventoried-ground-truth-bytes');
      const stats = await lstat(filePath);
      chmodMock.mockImplementationOnce(async () => {
        throw new Error('snapshot protection failed');
      });
      rmdirMock.mockImplementationOnce(async (directoryPath) => {
        snapshotDirectory = directoryPath.toString();
        const error = new Error('transient directory removal failure') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      });
      const planner = new MediaPreviewPlanner({
        inventory: {
          inventory: async () => [
            inventoryFile({
              filePath,
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
              modifiedTimeMs: stats.mtimeMs,
            }),
          ],
        },
        roots,
        metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
        destination: availableDestination,
        sourceContent: new FilesystemSourceContentProbe({
          chmod: chmodMock,
          rmdir: rmdirMock,
          unlink,
        }),
      });

      await expect(planner.plan(request())).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [
          expect.objectContaining({ message: 'snapshot protection failed' }),
          expect.objectContaining({ message: 'transient directory removal failure' }),
        ],
      });
      expect(rmdirMock).toHaveBeenCalledTimes(2);
      await expect(lstat(snapshotDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates cancellation during metadata extraction and removes the snapshot boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-planner-metadata-abort-'));
    try {
      const filePath = path.join(root, 'photo.jpg');
      await writeFile(filePath, 'inventoried-ground-truth-bytes');
      const stats = await lstat(filePath);
      const controller = new AbortController();
      let extractionPath = '';
      const planner = new MediaPreviewPlanner({
        inventory: {
          inventory: async () => [
            inventoryFile({
              filePath,
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
              modifiedTimeMs: stats.mtimeMs,
            }),
          ],
        },
        roots,
        metadata: {
          collectDetailed: async (metadataRequest) => {
            extractionPath = metadataRequest.verifiedExtractionPath;
            return await new Promise((_, reject) => {
              metadataRequest.signal?.addEventListener(
                'abort',
                () => {
                  const error = new Error('metadata cancelled');
                  error.name = 'AbortError';
                  reject(error);
                },
                { once: true }
              );
              controller.abort('operator cancelled');
            });
          },
        },
        destination: availableDestination,
      });

      await expect(planner.plan(request(), controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await expect(lstat(extractionPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(path.dirname(extractionPath))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves simultaneous metadata and snapshot-release failures', async () => {
    const releaseError = new Error('snapshot cleanup failed');
    const release = jest.fn(async () => {
      throw releaseError;
    });
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => [inventoryFile()] },
      roots,
      metadata: {
        collectDetailed: async () => {
          throw new Error('metadata extraction failed');
        },
      },
      destination: availableDestination,
      sourceContent: {
        capture: async () => ({
          sha256: digest,
          verifiedExtractionPath: '/private/snapshot.jpg',
          filesystemBirthTimeUtc: null,
          release,
        }),
      },
    });

    await expect(planner.plan(request())).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ message: 'metadata extraction failed' }), releaseError],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses to hash a symbolic-link source through the default content probe', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-planner-no-follow-'));
    try {
      const targetPath = path.join(root, 'target.jpg');
      const linkPath = path.join(root, 'link.jpg');
      await writeFile(targetPath, 'bytes');
      await symlink(targetPath, linkPath);
      const stats = await lstat(linkPath);
      const planner = new MediaPreviewPlanner({
        inventory: {
          inventory: async () => [
            inventoryFile({
              filePath: linkPath,
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
              modifiedTimeMs: stats.mtimeMs,
            }),
          ],
        },
        roots,
        metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
        destination: availableDestination,
      });

      await expect(planner.plan(request())).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
