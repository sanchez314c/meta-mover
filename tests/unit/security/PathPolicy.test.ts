import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  PathPolicyError,
  inspectInventoryFile,
  isPathWithinRoot,
  resolveDirectoryRoot,
  resolveRootPair,
  rootsOverlap,
  validateAbsolutePath,
} from '../../../src/main/security/PathPolicy';

describe('PathPolicy', () => {
  let sandbox: string;
  let source: string;
  let destination: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-path-policy-'));
    source = path.join(sandbox, 'source');
    destination = path.join(sandbox, 'destination');
    await Promise.all([fs.mkdir(source), fs.mkdir(destination)]);
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('requires absolute paths and rejects every Unicode C0, DEL, and C1 control character', () => {
    expect(() => validateAbsolutePath('relative/media', 'sourcePath')).toThrow(
      expect.objectContaining({ code: 'PATH_NOT_ABSOLUTE' })
    );

    const controlCodePoints = [
      ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
      ...Array.from({ length: 33 }, (_, offset) => offset + 0x7f),
    ];
    for (const codePoint of controlCodePoints) {
      const control = String.fromCodePoint(codePoint);
      expect(() => validateAbsolutePath(`/tmp/media${control}file`, 'sourcePath')).toThrow(
        expect.objectContaining({ code: 'PATH_CONTROL_CHARACTER' })
      );
    }
  });

  it('realpaths an existing directory root and rejects files and symlinked roots', async () => {
    const root = await resolveDirectoryRoot(source, 'sourcePath');
    expect(root.realPath).toBe(await fs.realpath(source));

    const filePath = path.join(sandbox, 'not-a-directory.jpg');
    await fs.writeFile(filePath, 'data');
    await expect(resolveDirectoryRoot(filePath, 'sourcePath')).rejects.toMatchObject({
      code: 'ROOT_NOT_DIRECTORY',
    });

    const linkPath = path.join(sandbox, 'source-link');
    await fs.symlink(source, linkPath, 'dir');
    await expect(resolveDirectoryRoot(linkPath, 'sourcePath')).rejects.toMatchObject({
      code: 'ROOT_SYMBOLIC_LINK',
    });
    await expect(
      resolveDirectoryRoot(`${linkPath}${path.sep}`, 'sourcePath')
    ).rejects.toMatchObject({
      code: 'ROOT_SYMBOLIC_LINK',
    });
  });

  it('preserves AbortError when cancellation arrives during root resolution', async () => {
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 3;
      },
      reason: 'Stopped during root analysis',
    } as AbortSignal;

    await expect(resolveDirectoryRoot(source, 'sourcePath', signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Stopped during root analysis',
    });
  });

  it('rejects same and nested roots in both directions but accepts prefix siblings', async () => {
    await expect(resolveRootPair(source, source)).rejects.toMatchObject({
      code: 'ROOTS_OVERLAP',
    });

    const sourceChild = path.join(source, 'child');
    await fs.mkdir(sourceChild);
    await expect(resolveRootPair(source, sourceChild)).rejects.toMatchObject({
      code: 'ROOTS_OVERLAP',
    });
    await expect(resolveRootPair(sourceChild, source)).rejects.toMatchObject({
      code: 'ROOTS_OVERLAP',
    });

    const prefixSibling = path.join(sandbox, 'source-copy');
    await fs.mkdir(prefixSibling);
    await expect(resolveRootPair(source, prefixSibling)).resolves.toMatchObject({
      source: { realPath: await fs.realpath(source) },
      destination: { realPath: await fs.realpath(prefixSibling) },
    });

    expect(
      rootsOverlap(
        { inputPath: '/mount/a', realPath: '/mount/a', device: 1, inode: 2 },
        { inputPath: '/mount/b', realPath: '/mount/b', device: 1, inode: 2 }
      )
    ).toBe(true);
  });

  it('uses realpaths and path components when checking containment', async () => {
    const sourceRoot = await resolveDirectoryRoot(source, 'sourcePath');
    const inside = path.join(sourceRoot.realPath, 'album', 'photo.jpg');
    const prefixSibling = `${sourceRoot.realPath}-copy/photo.jpg`;

    expect(isPathWithinRoot(sourceRoot.realPath, inside)).toBe(true);
    expect(isPathWithinRoot(sourceRoot.realPath, prefixSibling)).toBe(false);

    const realParent = path.join(sandbox, 'real-parent');
    const realSource = path.join(realParent, 'source');
    const realChild = path.join(realSource, 'child');
    await fs.mkdir(realChild, { recursive: true });
    const parentAlias = path.join(sandbox, 'parent-alias');
    await fs.symlink(realParent, parentAlias, 'dir');

    await expect(
      resolveRootPair(path.join(parentAlias, 'source'), realChild)
    ).rejects.toMatchObject({ code: 'ROOTS_OVERLAP' });
  });

  it('accepts only contained, non-linked regular files for inventory', async () => {
    const regularFile = path.join(source, 'photo.jpg');
    await fs.writeFile(regularFile, 'photo');
    const sourceRoot = await resolveDirectoryRoot(source, 'sourcePath');

    await expect(inspectInventoryFile(regularFile, sourceRoot)).resolves.toMatchObject({
      path: await fs.realpath(regularFile),
      size: 5,
      links: 1,
    });

    const outsideFile = path.join(destination, 'outside.jpg');
    await fs.writeFile(outsideFile, 'outside');
    await expect(inspectInventoryFile(outsideFile, sourceRoot)).rejects.toMatchObject({
      code: 'FILE_OUTSIDE_SOURCE',
    });

    const fileLink = path.join(source, 'linked.jpg');
    await fs.symlink(outsideFile, fileLink, 'file');
    await expect(inspectInventoryFile(fileLink, sourceRoot)).rejects.toMatchObject({
      code: 'FILE_SYMBOLIC_LINK',
    });

    const directory = path.join(source, 'album');
    await fs.mkdir(directory);
    await expect(inspectInventoryFile(directory, sourceRoot)).rejects.toMatchObject({
      code: 'FILE_NOT_REGULAR',
    });
  });

  it('rejects hard-linked files because later metadata writes would mutate every link', async () => {
    const original = path.join(source, 'original.jpg');
    const hardLink = path.join(source, 'hard-link.jpg');
    await fs.writeFile(original, 'same inode');
    await fs.link(original, hardLink);
    const sourceRoot = await resolveDirectoryRoot(source, 'sourcePath');

    await expect(inspectInventoryFile(original, sourceRoot)).rejects.toMatchObject({
      code: 'FILE_HARD_LINKED',
    });
  });

  it('rejects files crossing the source filesystem device boundary', async () => {
    const regularFile = path.join(source, 'photo.jpg');
    await fs.writeFile(regularFile, 'photo');
    const sourceRoot = await resolveDirectoryRoot(source, 'sourcePath');

    await expect(
      inspectInventoryFile(regularFile, { ...sourceRoot, device: sourceRoot.device + 1 })
    ).rejects.toMatchObject({ code: 'FILE_CROSS_DEVICE' });
  });
});
