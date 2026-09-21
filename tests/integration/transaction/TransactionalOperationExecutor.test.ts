import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { hashFile } from '../../../src/main/core/transaction';
import { PlannedOperation } from '../../../src/main/services/ProcessingCoordinator';
import { TransactionalOperationExecutor } from '../../../src/main/services/TransactionalOperationExecutor';
import { OperationMode } from '../../../src/shared/types/processing';
import {
  developmentBrokerLaunchTrustPolicy,
  NativeFilesystemHelperClient,
} from '../../../src/main/native/NativeFilesystemHelperClient';
import { NativeTransactionFilesystem } from '../../../src/main/core/transaction/NativeTransactionFilesystem';

jest.setTimeout(120_000);

describe('TransactionalOperationExecutor integration', () => {
  let root: string;
  let sourceRoot: string;
  let destinationRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-executor-integration-'));
    sourceRoot = path.join(root, 'source');
    destinationRoot = path.join(root, 'destination');
    await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot)]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function operation(targetPath: string): Promise<PlannedOperation> {
    const sourcePath = path.join(sourceRoot, 'photo.jpg');
    await writeFile(sourcePath, 'executor-ground-truth');
    const [stats, sourceRootStats, destinationRootStats] = await Promise.all([
      lstat(sourcePath),
      lstat(sourceRoot),
      lstat(destinationRoot),
    ]);
    return {
      id: 'planner-operation-real',
      sourcePath,
      targetPath,
      bytes: stats.size,
      payload: {
        destinationRoot,
        validatedRoots: {
          sourcePaths: [sourceRoot],
          destinationPath: destinationRoot,
          sourceIdentities: [
            { path: sourceRoot, device: sourceRootStats.dev, inode: sourceRootStats.ino },
          ],
          destinationIdentity: {
            path: destinationRoot,
            device: destinationRootStats.dev,
            inode: destinationRootStats.ino,
          },
        },
        sourceIdentity: {
          device: stats.dev,
          inode: stats.ino,
          links: stats.nlink,
          size: stats.size,
        },
        modifiedTimeMs: stats.mtimeMs,
        contentSha256: await hashFile(sourcePath),
        destinationSnapshot: {
          path: targetPath,
          occupied: false,
          source: 'filesystem',
        },
      },
    };
  }

  function context() {
    return {
      jobId: 'job-real',
      previewId: 'preview-real',
      mode: OperationMode.COPY,
      signal: new AbortController().signal,
    };
  }

  function nativeExecutor(): TransactionalOperationExecutor {
    return new TransactionalOperationExecutor({
      nativeFilesystemFactory: async ({ destinationRoot, controlRoot, sourceRoots }) => {
        const client = await NativeFilesystemHelperClient.open({
          resourcesRoot: path.resolve('.build-tools'),
          launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
          isPackaged: false,
          roots: NativeTransactionFilesystem.rootBindings(
            destinationRoot,
            controlRoot,
            sourceRoots
          ),
        });
        return new NativeTransactionFilesystem(client, destinationRoot, controlRoot, sourceRoots);
      },
    });
  }

  it('executes a nested exact plan with caller identity and hash evidence', async () => {
    const targetPath = path.join(destinationRoot, '2024', '05', 'photo.jpg');
    const planned = await operation(targetPath);
    const executor = nativeExecutor();
    try {
      const entry = await executor.execute(planned, context());

      expect(entry).toEqual({
        operationId: planned.id,
        outcome: 'committed',
        bytes: planned.bytes,
      });
      expect(await readFile(targetPath, 'utf8')).toBe('executor-ground-truth');
    } finally {
      await executor.close();
      await executor.close();
    }
  });

  it('preserves a stale-preview winner and returns failed without allocating another name', async () => {
    const targetPath = path.join(destinationRoot, 'target.jpg');
    const planned = await operation(targetPath);
    await writeFile(targetPath, 'external-winner');
    const executor = nativeExecutor();
    try {
      const entry = await executor.execute(planned, context());

      expect(entry).toMatchObject({
        operationId: planned.id,
        outcome: 'failed',
        bytes: 0,
        error: expect.stringMatching(/exact preview target/i),
      });
      expect(await readFile(targetPath, 'utf8')).toBe('external-winner');
      expect(await readFile(planned.sourcePath, 'utf8')).toBe('executor-ground-truth');
    } finally {
      await executor.close();
    }
  });

  it('moves a file on the same filesystem via rename fast path with committed outcome', async () => {
    const targetPath = path.join(destinationRoot, 'rename-move.jpg');
    const planned = await operation(targetPath);
    // Remove contentSha256 to enable the fast path: the normal preview
    // payload sets contentSha256 from hashFile, but a real preview-only
    // payload omits it so the fast path engages.
    delete (planned.payload as Record<string, unknown>).contentSha256;
    const executor = nativeExecutor();
    try {
      const entry = await executor.execute(planned, {
        ...context(),
        mode: OperationMode.MOVE,
      });

      expect(entry).toMatchObject({
        operationId: planned.id,
        outcome: 'committed',
        bytes: planned.bytes,
      });
      // Destination exists
      expect(await readFile(targetPath, 'utf8')).toBe('executor-ground-truth');
      // Source should be gone
      await expect(lstat(planned.sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await executor.close();
    }
  });

  it('deterministically binds 100 concurrent source identities into one new nested directory', async () => {
    const planned = await Promise.all(
      Array.from({ length: 100 }, async (_, index): Promise<PlannedOperation> => {
        const sourcePath = path.join(sourceRoot, `photo-${index}.jpg`);
        const content = `identity-content-${index}`;
        const targetPath = path.join(destinationRoot, '2024', '05', `photo-${index}.jpg`);
        await writeFile(sourcePath, content);
        const [stats, sourceRootStats, destinationRootStats] = await Promise.all([
          lstat(sourcePath),
          lstat(sourceRoot),
          lstat(destinationRoot),
        ]);
        return {
          id: `planner-operation-${index}`,
          sourcePath,
          targetPath,
          bytes: stats.size,
          payload: {
            destinationRoot,
            validatedRoots: {
              sourcePaths: [sourceRoot],
              destinationPath: destinationRoot,
              sourceIdentities: [
                { path: sourceRoot, device: sourceRootStats.dev, inode: sourceRootStats.ino },
              ],
              destinationIdentity: {
                path: destinationRoot,
                device: destinationRootStats.dev,
                inode: destinationRootStats.ino,
              },
            },
            sourceIdentity: {
              device: stats.dev,
              inode: stats.ino,
              links: stats.nlink,
              size: stats.size,
            },
            modifiedTimeMs: stats.mtimeMs,
            contentSha256: await hashFile(sourcePath),
            destinationSnapshot: {
              path: targetPath,
              occupied: false,
              source: 'filesystem',
            },
          },
        };
      })
    );
    const executor = nativeExecutor();
    try {
      const entries = await Promise.all(planned.map((entry) => executor.execute(entry, context())));

      expect(entries.filter((entry) => entry.outcome !== 'committed')).toEqual([]);
      expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(100);
      const outputs = await Promise.all(planned.map((entry) => readFile(entry.targetPath, 'utf8')));
      expect(new Set(outputs).size).toBe(100);
    } finally {
      await executor.close();
    }
  });
});
