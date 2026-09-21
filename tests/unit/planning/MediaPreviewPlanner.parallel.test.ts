import { InventoryMediaFile } from '../../../src/main/core/inventory/MediaInventory';
import { MediaPreviewPlanner } from '../../../src/main/services/MediaPreviewPlanner';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  PreviewRequestDTO,
} from '../../../src/shared/types/processing';

const files: InventoryMediaFile[] = Array.from({ length: 6 }, (_, index) => ({
  filePath: `/source/${String(index).padStart(2, '0')}.jpg`,
  formatStatus: 'supported',
  extension: '.jpg',
  mediaKind: 'image',
  device: 7,
  inode: 100 + index,
  links: 1,
  size: 10,
  modifiedTimeMs: Date.parse('2026-08-29T12:00:00.000Z'),
}));

const request: PreviewRequestDTO = {
  sourcePaths: ['/source'],
  destinationPath: '/destination',
  options: {
    operation: OperationMode.COPY,
    conflictPolicy: ConflictPolicy.RENAME,
    folderStructure: FolderStructure.FLAT,
    appendScreenshotSuffix: false,
    workerCount: 2,
    verifyIntegrity: true,
    writeMetadataDates: false,
  },
};

describe('MediaPreviewPlanner parallel analysis', () => {
  it('parallelizes expensive file analysis but reserves destination names in stable path order', async () => {
    let active = 0;
    let peak = 0;
    const completionOrder: string[] = [];
    const progress = jest.fn();
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => [...files].reverse() },
      roots: {
        validate: async () => ({
          sourcePaths: ['/source'],
          destinationPath: '/destination',
          sourceIdentities: [{ path: '/source', device: 1, inode: 1 }],
          destinationIdentity: { path: '/destination', device: 2, inode: 2 },
        }),
      },
      sourceContent: {
        capture: async (file) => ({
          seekableExtractionPath: file.filePath,
          filesystemBirthTimeUtc: '2024-01-02T03:04:05.000Z',
          release: async () => undefined,
        }),
      },
      metadata: {
        collectDetailed: async ({ fileId, filePath }) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, (3 - (pathIndex(filePath) % 3)) * 10));
          completionOrder.push(filePath);
          active -= 1;
          return {
            candidates: [
              {
                id: `${fileId}:embedded`,
                fileId,
                mediaKind: 'image',
                semantic: 'capture',
                sourceKind: 'embedded-exif',
                sourceFamily: 'exif',
                tag: 'EXIF:DateTimeOriginal',
                rawValue: '2024:01:02 03:04:05',
                value: {
                  localIso: '2024-01-02T03:04:05',
                  zoneBasis: 'floating-local',
                  precision: 'second',
                },
              },
            ],
            warnings: [],
          };
        },
      },
      destination: {
        inspect: async (targetPath) => ({
          path: targetPath,
          occupied: false,
          source: 'filesystem',
        }),
      },
      analysisResources: {
        maxConcurrency: 3,
        availableParallelism: () => 20,
        readCpuTimes: lowCpuTimes,
        sampleIntervalMs: 1,
        wait: async () => undefined,
      },
      now: () => Date.parse('2026-08-29T13:00:00.000Z'),
    });

    const plan = await planner.plan(request, undefined, progress);

    expect(peak).toBe(3);
    expect(completionOrder).not.toEqual(files.map((file) => file.filePath));
    expect(plan.rows?.map((row) => row.sourcePath)).toEqual(files.map((file) => file.filePath));
    expect(plan.rows?.map((row) => row.targetPath)).toEqual([
      '/destination/Photos/2024-01-02_03-04-05.jpg',
      '/destination/Photos/2024-01-02_03-04-05_1.jpg',
      '/destination/Photos/2024-01-02_03-04-05_2.jpg',
      '/destination/Photos/2024-01-02_03-04-05_3.jpg',
      '/destination/Photos/2024-01-02_03-04-05_4.jpg',
      '/destination/Photos/2024-01-02_03-04-05_5.jpg',
    ]);
    expect(progress.mock.calls.map(([event]) => event.filesProcessed)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it('does not serialize metadata reads merely because media files are large', async () => {
    let active = 0;
    let peak = 0;
    const planner = new MediaPreviewPlanner({
      inventory: {
        inventory: async () => files.slice(0, 3).map((file) => ({ ...file, size: 60 })),
      },
      roots: {
        validate: async () => ({
          sourcePaths: ['/source'],
          destinationPath: '/destination',
          sourceIdentities: [{ path: '/source', device: 1, inode: 1 }],
          destinationIdentity: { path: '/destination', device: 2, inode: 2 },
        }),
      },
      sourceContent: {
        capture: async (file) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            seekableExtractionPath: file.filePath,
            filesystemBirthTimeUtc: null,
            release: async () => {
              active -= 1;
            },
          };
        },
      },
      metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
      destination: {
        inspect: async (targetPath) => ({
          path: targetPath,
          occupied: false,
          source: 'filesystem',
        }),
      },
      analysisResources: {
        maxConcurrency: 3,
        availableParallelism: () => 20,
        readCpuTimes: lowCpuTimes,
        sampleIntervalMs: 1,
        wait: async () => undefined,
      },
    });

    await planner.plan(request);

    expect(peak).toBe(3);
  });

  it('accepts media larger than available temporary storage because preview creates no copies', async () => {
    const capture = jest.fn(async (file: Readonly<InventoryMediaFile>) => ({
      seekableExtractionPath: file.filePath,
      filesystemBirthTimeUtc: null,
      release: async () => undefined,
    }));
    const planner = new MediaPreviewPlanner({
      inventory: { inventory: async () => [{ ...files[0], size: 101 }] },
      roots: {
        validate: async () => ({
          sourcePaths: ['/source'],
          destinationPath: '/destination',
          sourceIdentities: [{ path: '/source', device: 1, inode: 1 }],
          destinationIdentity: { path: '/destination', device: 2, inode: 2 },
        }),
      },
      sourceContent: { capture },
      metadata: { collectDetailed: async () => ({ candidates: [], warnings: [] }) },
      destination: {
        inspect: async (targetPath) => ({
          path: targetPath,
          occupied: false,
          source: 'filesystem',
        }),
      },
    });

    await expect(planner.plan(request)).resolves.toMatchObject({
      summary: { totalFiles: 1 },
    });
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

function pathIndex(filePath: string): number {
  return Number(filePath.slice('/source/'.length, '/source/00'.length));
}

const lowCpuTimes = (() => {
  let total = 0;
  return () => {
    total += 100;
    return { idle: total, total };
  };
})();
