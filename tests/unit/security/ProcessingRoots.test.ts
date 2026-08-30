import { lstat, mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { ProcessingRootValidator } from '../../../src/main/security/ProcessingRoots';

describe('ProcessingRootValidator', () => {
  let root: string;
  let source: string;
  let destination: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-roots-'));
    source = path.join(root, 'source');
    destination = path.join(root, 'destination');
    await mkdir(source);
    await mkdir(destination);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns canonical roots and deduplicates repeated source identities', async () => {
    const sourceStats = await lstat(source);
    const destinationStats = await lstat(destination);

    await expect(
      new ProcessingRootValidator().validate([source, source], destination)
    ).resolves.toEqual({
      sourcePaths: [source],
      destinationPath: destination,
      sourceIdentities: [{ path: source, device: sourceStats.dev, inode: sourceStats.ino }],
      destinationIdentity: {
        path: destination,
        device: destinationStats.dev,
        inode: destinationStats.ino,
      },
    });
  });

  it('rejects a destination inside a source or a source inside the destination', async () => {
    const nestedDestination = path.join(source, 'output');
    await mkdir(nestedDestination);
    await expect(
      new ProcessingRootValidator().validate([source], nestedDestination)
    ).rejects.toMatchObject({ code: 'ROOTS_OVERLAP' });

    const nestedSource = path.join(destination, 'input');
    await mkdir(nestedSource);
    await expect(
      new ProcessingRootValidator().validate([nestedSource], destination)
    ).rejects.toMatchObject({ code: 'ROOTS_OVERLAP' });
  });

  it('rejects empty source lists and changing destination identities', async () => {
    await expect(new ProcessingRootValidator().validate([], destination)).rejects.toThrow(
      /source/i
    );
  });
});
