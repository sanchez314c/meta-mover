import { createHash } from 'crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { createProductionReviewCoreFactory } from '../../../src/main/runtime/ProductionApplicationRuntime';
import { developmentBrokerLaunchTrustPolicy } from '../../../src/main/native/NativeFilesystemHelperClient';

describe('production review native transaction core', () => {
  it('moves a review file through the staged native helper with exact no-clobber', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'meta-review-native-')));
    const currentPath = path.join(root, 'Photos', '_Needs Review', 'No Usable Date', 'photo.jpg');
    await mkdir(path.dirname(currentPath), { recursive: true });
    await writeFile(currentPath, 'review image bytes');
    const targetPath = path.join(root, 'Photos', '2024', 'photo.jpg');
    const hash = createHash('sha256').update('review image bytes').digest('hex');
    const factory = createProductionReviewCoreFactory({
      resourcesRoot: path.resolve('.build-tools'),
      platform: process.platform,
      architecture: process.arch,
      isPackaged: false,
      launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
    });
    const core = await factory(root);
    try {
      const source = await stat(currentPath);
      const result = await core.execute({
        operationId: 'review-native-real-helper',
        sourcePath: currentPath,
        targetFilename: path.relative(root, targetPath),
        expectedDestinationPath: targetPath,
        collisionMode: 'exact-no-clobber',
        expectedSourceIdentity: {
          device: source.dev,
          inode: source.ino,
          links: source.nlink,
          size: source.size,
          modifiedTimeMs: source.mtimeMs,
        },
        expectedSha256: hash,
        mode: 'move',
      });
      expect(result.status).toBe('moved');
      expect(result.committed).toBe(true);
      expect(result.sourceRetained).toBe(false);
      await expect(readFile(targetPath, 'utf8')).resolves.toBe('review image bytes');
    } finally {
      try {
        await core.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
