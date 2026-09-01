import { createHash } from 'crypto';
import { chmod, lstat, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { PreparedPreview } from '../../../src/main/services/ProcessingCoordinator';
import { MediaPreviewRevalidator } from '../../../src/main/services/MediaPreviewRevalidator';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
} from '../../../src/shared/types/processing';

describe('MediaPreviewRevalidator', () => {
  let root: string;
  let sourcePath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-revalidate-'));
    sourcePath = path.join(root, 'photo.jpg');
    await writeFile(sourcePath, 'photo bytes');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function prepared(overrides: Record<string, unknown> = {}): Promise<PreparedPreview> {
    const stats = await lstat(sourcePath);
    const contentSha256 = createHash('sha256').update('photo bytes').digest('hex');
    return {
      result: {
        jobId: 'job-1',
        previewId: 'preview-1',
        createdAt: '2026-08-29T12:00:00.000Z',
        request: {
          sourcePaths: [root],
          destinationPath: root,
          options: {
            operation: OperationMode.COPY,
            conflictPolicy: ConflictPolicy.RENAME,
            folderStructure: FolderStructure.YEAR_MONTH,
            workerCount: 1,
            verifyIntegrity: true,
            appendScreenshotSuffix: false,
            writeMetadataDates: false,
          },
        },
        effectiveOptions: {
          operation: OperationMode.COPY,
          conflictPolicy: ConflictPolicy.RENAME,
          folderStructure: FolderStructure.YEAR_MONTH,
          workerCount: 1,
          verifyIntegrity: true,
          appendScreenshotSuffix: false,
          writeMetadataDates: false,
        },
        summary: {
          totalFiles: 1,
          copyFiles: 1,
          moveFiles: 0,
          skippedFiles: 0,
          renamedFiles: 0,
          overwrittenFiles: 0,
          unresolvedDates: 0,
          totalBytes: stats.size,
        },
      },
      operations: [
        {
          id: 'operation-1',
          sourcePath,
          targetPath: path.join(root, 'target.jpg'),
          bytes: stats.size,
          payload: {
            sourceIdentity: {
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
            },
            modifiedTimeMs: stats.mtimeMs,
            mediaKind: 'image',
            contentSha256,
            destinationSnapshot: {
              path: path.join(root, 'target.jpg'),
              occupied: false,
              source: 'filesystem',
            },
            dateResolution: {
              policyVersion: 'date-resolution/1',
              fileId: `${stats.dev}:${stats.ino}`,
              mediaKind: 'image',
              target: 'capture-time',
              evaluationTimeUtc: '2026-08-29T12:00:00.000Z',
              status: 'unresolved',
              confidence: 'none',
              contenderIds: [],
              rejected: [],
              reasonCodes: ['no-eligible-candidates'],
              candidates: [],
            },
            ...overrides,
          },
        },
      ],
    };
  }

  it('accepts unchanged regular sources when the bundled runtime is ready', async () => {
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });

    await expect(revalidator.revalidate(await prepared())).resolves.toEqual({
      sourceFingerprintMatches: true,
      configMatches: true,
      reasons: [],
    });
  });

  it('detects size, identity, link-count, and modified-time drift', async () => {
    const original = await prepared();
    await writeFile(sourcePath, 'changed bytes and size');
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });

    const result = await revalidator.revalidate(original);

    expect(result.sourceFingerprintMatches).toBe(false);
    expect(result.reasons).toContain(`Source changed after preview: ${sourcePath}`);
  });

  it('detects same-size content replacement even when mtime is restored', async () => {
    await writeFile(sourcePath, 'AAAA');
    const original = await prepared({
      contentSha256: createHash('sha256').update('AAAA').digest('hex'),
    });
    const originalMtime = (original.operations[0].payload as Record<string, unknown>)
      .modifiedTimeMs as number;
    await writeFile(sourcePath, 'BBBB');
    await utimes(sourcePath, originalMtime / 1000, originalMtime / 1000);
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });

    const result = await revalidator.revalidate(original);

    expect(result.sourceFingerprintMatches).toBe(false);
    expect(result.reasons).toContain(`Source content changed after preview: ${sourcePath}`);
  });

  it('rejects unreadable sources and newly occupied destinations', async () => {
    const original = await prepared();
    await chmod(sourcePath, 0o000);
    await writeFile(path.join(root, 'target.jpg'), 'occupied');
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });

    const result = await revalidator.revalidate(original);

    expect(result.sourceFingerprintMatches).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Source (?:is not readable|cannot be revalidated)/),
        expect.stringContaining('Destination changed after preview'),
      ])
    );
  });

  it('fails closed on malformed payloads and missing files', async () => {
    const malformed = await prepared({ sourceIdentity: null });
    const missing = await prepared();
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });

    expect((await revalidator.revalidate(malformed)).sourceFingerprintMatches).toBe(false);
    await rm(sourcePath);
    expect((await revalidator.revalidate(missing)).reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('Source cannot be revalidated')])
    );
  });

  it('rejects execution when bundled runtime health has changed', async () => {
    const revalidator = new MediaPreviewRevalidator({
      runtime: {
        check: async () => ({ ready: false, reasons: ['Bundled ExifTool is unavailable'] }),
      },
    });

    await expect(revalidator.revalidate(await prepared())).resolves.toMatchObject({
      sourceFingerprintMatches: true,
      configMatches: false,
      reasons: ['Bundled ExifTool is unavailable'],
    });
  });

  it('fails closed when runtime readiness returns a malformed DTO', async () => {
    const revalidator = new MediaPreviewRevalidator({
      runtime: {
        check: async () =>
          ({ ready: true, reasons: null }) as unknown as { ready: boolean; reasons: string[] },
      },
    });

    await expect(revalidator.revalidate(await prepared())).resolves.toMatchObject({
      sourceFingerprintMatches: true,
      configMatches: false,
      reasons: [expect.stringContaining('health check failed')],
    });
  });

  it('fails closed on accessor-bearing preview payloads without invoking getters', async () => {
    const original = await prepared();
    let reads = 0;
    const hostilePayload = Object.defineProperty({}, 'sourceIdentity', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('getter executed');
      },
    });
    const hostile: PreparedPreview = {
      ...original,
      operations: [{ ...original.operations[0], payload: hostilePayload }],
    };
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });

    await expect(revalidator.revalidate(hostile)).resolves.toMatchObject({
      sourceFingerprintMatches: false,
      configMatches: true,
      reasons: [expect.stringContaining('fingerprint is invalid')],
    });
    expect(reads).toBe(0);
  });

  it.each([
    { contentSha256: 'not-a-hash' },
    { modifiedTimeMs: -1 },
    { sourceIdentity: { device: -1, inode: 1, links: 1, size: 1 } },
    { destinationSnapshot: { path: '/wrong', occupied: true } },
    {
      destinationSnapshot: {
        path: '/wrong',
        occupied: true,
        identity: { device: 1, inode: 2, links: 1, type: 'socket' },
      },
    },
  ])('fails closed on malformed fingerprint fragment %#', async (fragment) => {
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });
    await expect(revalidator.revalidate(await prepared(fragment))).resolves.toMatchObject({
      sourceFingerprintMatches: false,
    });
  });

  it('accepts an unchanged occupied destination identity', async () => {
    const targetPath = path.join(root, 'target.jpg');
    await writeFile(targetPath, 'existing');
    const target = await lstat(targetPath);
    const original = await prepared({
      destinationSnapshot: {
        path: targetPath,
        occupied: true,
        identity: {
          device: target.dev,
          inode: target.ino,
          links: target.nlink,
          type: 'file',
        },
      },
    });
    const revalidator = new MediaPreviewRevalidator({
      runtime: { check: async () => ({ ready: true, reasons: [] }) },
    });

    await expect(revalidator.revalidate(original)).resolves.toMatchObject({
      sourceFingerprintMatches: true,
      configMatches: true,
    });
  });

  it('fails closed when the runtime check throws', async () => {
    const revalidator = new MediaPreviewRevalidator({
      runtime: {
        check: async () => {
          throw new Error('runtime offline');
        },
      },
    });

    await expect(revalidator.revalidate(await prepared())).resolves.toMatchObject({
      configMatches: false,
      reasons: [expect.stringContaining('runtime offline')],
    });
  });
});
