import { lstat, mkdtemp, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { TestRunCorpusBuilder } from '../../../src/main/services/TestRunCorpusBuilder';

describe('TestRunCorpusBuilder', () => {
  it('copies an exact bounded random corpus without changing sources', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-test-run-'));
    const source = path.join(root, 'source');
    const temporaryRoot = path.join(root, 'temporary');
    await mkdir(path.join(source, 'nested'), { recursive: true });
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(source, 'nested', `${index}.jpg`), `source-${index}`);
    }
    const builder = new TestRunCorpusBuilder(temporaryRoot, () => 0);

    const result = await builder.gather({ sourcePath: source, fileCount: 15 });

    expect(result.copiedFiles).toBe(15);
    expect(result.scannedFiles).toBe(20);
    expect(result.temporarySourcePath.startsWith(`${temporaryRoot}${path.sep}`)).toBe(true);
    const copied = await builder.listRegularFiles(result.temporarySourcePath);
    expect(copied).toHaveLength(15);
    expect(await readFile(path.join(source, 'nested', '0.jpg'), 'utf8')).toBe('source-0');
  });

  it('rejects an undersized source instead of claiming a complete corpus', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-test-run-small-'));
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'only.jpg'), 'one');

    await expect(
      new TestRunCorpusBuilder(path.join(root, 'temporary')).gather({
        sourcePath: source,
        fileCount: 2,
      })
    ).rejects.toThrow(/contains 1 regular file/i);
  });

  it('does not recursively resample existing test-run corpus directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-test-run-exclude-'));
    const source = path.join(root, 'source');
    await mkdir(path.join(source, 'META-Mover-Test-Run-old'), { recursive: true });
    await writeFile(path.join(source, 'original.jpg'), 'original');
    await writeFile(path.join(source, 'META-Mover-Test-Run-old', 'copy.jpg'), 'copy');

    const result = await new TestRunCorpusBuilder(path.join(root, 'temporary')).gather({
      sourcePath: source,
      fileCount: 1,
    });

    expect(result.scannedFiles).toBe(1);
    expect(await readFile(path.join(result.temporarySourcePath, 'original.jpg'), 'utf8')).toBe(
      'original'
    );
  });

  it('refuses cleanup of a correctly shaped directory it did not create', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-test-run-owned-'));
    const forged = path.join(root, 'temporary', 'run-forged', 'source');
    await mkdir(forged, { recursive: true });

    await expect(
      new TestRunCorpusBuilder(path.join(root, 'temporary')).discard(forged)
    ).rejects.toThrow(/not owned/i);
    expect(await lstat(forged)).toBeDefined();
  });

  it('settles workers and removes incomplete staging after cancellation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-test-run-cancel-'));
    const source = path.join(root, 'source');
    const temporaryRoot = path.join(root, 'temporary');
    await mkdir(source);
    for (let index = 0; index < 100; index += 1)
      await writeFile(path.join(source, `${index}.jpg`), Buffer.alloc(4096, index));
    const builder = new TestRunCorpusBuilder(temporaryRoot);

    await expect(
      builder.gather({ sourcePath: source, fileCount: 100 }, (progress) => {
        if (progress.phase === 'copying') builder.cancel();
      })
    ).rejects.toThrow(/cancelled/i);

    expect(await readdir(temporaryRoot)).toEqual([]);
  });
});
