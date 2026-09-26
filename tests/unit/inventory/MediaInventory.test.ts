import type { Dirent } from 'fs';
import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  MediaInventory,
  MediaInventoryError,
} from '../../../src/main/core/inventory/MediaInventory';
import {
  ALL_SUPPORTED_FORMATS,
  SUPPORTED_MEDIA_FORMATS,
  classifyMediaExtension,
} from '../../../src/shared/constants';

describe('MediaInventory', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-inventory-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds supported media recursively, classifies it, and returns stable canonical paths', async () => {
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    await writeFile(path.join(root, 'PHOTO.JPEG'), 'image');
    await writeFile(path.join(nested, 'clip.MOV'), 'video');
    await writeFile(path.join(nested, 'recording.wav'), 'audio');
    await writeFile(path.join(nested, 'scan.pdf'), 'document');
    await writeFile(path.join(root, 'ignore.txt'), 'text');

    const files = await new MediaInventory().inventory([root]);

    expect(
      files
        .filter((file) => file.formatStatus === 'supported')
        .map(({ filePath, mediaKind }) => [path.relative(root, filePath), mediaKind])
    ).toEqual([
      ['PHOTO.JPEG', 'image'],
      [path.join('nested', 'clip.MOV'), 'video'],
      [path.join('nested', 'recording.wav'), 'audio'],
      [path.join('nested', 'scan.pdf'), 'document'],
    ]);
    expect(files.every((file) => file.size > 0 && file.device > 0 && file.inode > 0)).toBe(true);
  });

  it('reports every unsupported regular file instead of silently omitting it', async () => {
    await writeFile(path.join(root, 'unknown.MEDIA'), 'unknown bytes');
    await writeFile(path.join(root, 'extensionless'), 'unknown bytes');

    const files = await new MediaInventory().inventory([root]);

    expect(
      files.map(({ filePath, formatStatus, mediaKind, extension }) => ({
        file: path.basename(filePath),
        formatStatus,
        mediaKind,
        extension,
      }))
    ).toEqual([
      {
        file: 'extensionless',
        formatStatus: 'unsupported',
        mediaKind: null,
        extension: '',
      },
      {
        file: 'unknown.MEDIA',
        formatStatus: 'unsupported',
        mediaKind: null,
        extension: '.media',
      },
    ]);
  });

  it('uses one duplicate-free supported-format registry for classification and reporting', () => {
    const classified = Object.entries(SUPPORTED_MEDIA_FORMATS).flatMap(([kind, extensions]) =>
      extensions.map((extension) => [extension, kind])
    );

    expect(new Set(ALL_SUPPORTED_FORMATS).size).toBe(ALL_SUPPORTED_FORMATS.length);
    expect(classified).toHaveLength(ALL_SUPPORTED_FORMATS.length);
    for (const [extension, kind] of classified) {
      expect(classifyMediaExtension(`FILE${extension.toUpperCase()}`)).toBe(kind);
    }
    expect(classifyMediaExtension('FILE.not-supported')).toBeNull();
  });

  it('does not traverse or accept symbolic links', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'meta-mover-inventory-outside-'));
    try {
      await writeFile(path.join(outside, 'private.jpg'), 'private');
      await symlink(outside, path.join(root, 'escape'));
      await symlink(path.join(outside, 'private.jpg'), path.join(root, 'linked.jpg'));

      await expect(new MediaInventory().inventory([root])).rejects.toMatchObject({
        code: 'SYMLINK_REJECTED',
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects hard-linked media because path identity is ambiguous', async () => {
    const original = path.join(root, 'original.jpg');
    await writeFile(original, 'same inode');
    await link(original, path.join(root, 'alias.jpg'));

    await expect(new MediaInventory().inventory([root])).rejects.toMatchObject({
      code: 'HARD_LINK_REJECTED',
    });
  });

  it('deduplicates overlapping source roots by canonical filesystem identity', async () => {
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    await writeFile(path.join(nested, 'only.jpg'), 'one');

    const files = await new MediaInventory().inventory([root, nested]);

    expect(files).toHaveLength(1);
    expect(files[0].filePath).toBe(path.join(nested, 'only.jpg'));
  });

  it('fails the inventory instead of silently swallowing unreadable directory errors', async () => {
    const inventory = new MediaInventory({
      readDirectory: async () => {
        const error = new Error('denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      },
    });

    await expect(inventory.inventory([root])).rejects.toBeInstanceOf(MediaInventoryError);
    await expect(inventory.inventory([root])).rejects.toMatchObject({
      code: 'DIRECTORY_UNREADABLE',
    });
  });

  it('rejects missing, non-absolute, and non-directory source roots', async () => {
    const file = path.join(root, 'photo.jpg');
    await writeFile(file, 'image');

    await expect(new MediaInventory().inventory(['relative'])).rejects.toMatchObject({
      code: 'SOURCE_PATH_INVALID',
    });
    await expect(
      new MediaInventory().inventory([path.join(root, 'missing')])
    ).rejects.toMatchObject({
      code: 'SOURCE_UNREADABLE',
    });
    await expect(new MediaInventory().inventory([file])).rejects.toMatchObject({
      code: 'SOURCE_NOT_DIRECTORY',
    });
    await expect(new MediaInventory().inventory([])).rejects.toMatchObject({
      code: 'SOURCE_PATH_INVALID',
    });
  });

  it('rejects injected directory entries that escape the canonical source root', async () => {
    const outsidePath = path.join(path.dirname(root), `${path.basename(root)}-outside.jpg`);
    await writeFile(outsidePath, 'outside');
    try {
      const inventory = new MediaInventory({
        readDirectory: async () => [
          { name: path.join('..', path.basename(outsidePath)) } as unknown as Dirent,
        ],
      });

      await expect(inventory.inventory([root])).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_SOURCE',
      });
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  it('rejects unsafe filesystem numbers before they reach planning arithmetic', async () => {
    const filePath = path.join(root, 'unsafe.jpg');
    await writeFile(filePath, 'bytes');
    const inventory = new MediaInventory({
      inspectPath: async (candidatePath) => {
        const stats = await lstat(candidatePath);
        if (candidatePath !== filePath) return stats;
        return new Proxy(stats, {
          get(target, property, receiver) {
            if (property === 'size') return Number.MAX_SAFE_INTEGER + 1;
            return Reflect.get(target, property, receiver);
          },
        });
      },
    });

    await expect(inventory.inventory([root])).rejects.toMatchObject({
      code: 'FILE_METADATA_INVALID',
    });
  });

  it('rejects canonical path escape and identity changes reported by filesystem boundaries', async () => {
    const filePath = path.join(root, 'photo.jpg');
    const outsidePath = path.join(path.dirname(root), `${path.basename(root)}-canonical.jpg`);
    await writeFile(filePath, 'inside');
    await writeFile(outsidePath, 'outside');
    try {
      const escaping = new MediaInventory({
        resolvePath: async (candidatePath) =>
          candidatePath === filePath ? outsidePath : candidatePath,
      });
      await expect(escaping.inventory([root])).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_SOURCE',
      });

      let fileInspections = 0;
      const changed = new MediaInventory({
        inspectPath: async (candidatePath) => {
          const stats = await lstat(candidatePath);
          if (candidatePath !== filePath) return stats;
          fileInspections += 1;
          if (fileInspections === 1) return stats;
          return new Proxy(stats, {
            get(target, property, receiver) {
              if (property === 'ino') return stats.ino + 1;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      });
      await expect(changed.inventory([root])).rejects.toMatchObject({
        code: 'PATH_IDENTITY_CHANGED',
      });
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  it('wraps entry inspection failures instead of silently dropping files', async () => {
    const filePath = path.join(root, 'photo.jpg');
    await writeFile(filePath, 'inside');
    const inventory = new MediaInventory({
      inspectPath: async (candidatePath) => {
        if (candidatePath === filePath) {
          const error = new Error('vanished') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return lstat(candidatePath);
      },
    });

    await expect(inventory.inventory([root])).rejects.toMatchObject({ code: 'FILE_UNREADABLE' });
  });

  it('continues past child EIO entries and reports their exact paths', async () => {
    const good = path.join(root, 'good.jpg');
    const bad = path.join(root, 'bad.jpg');
    await writeFile(good, 'good');
    await writeFile(bad, 'bad');
    const skipped: Array<{ filePath: string; code: string }> = [];
    const inventory = new MediaInventory({
      inspectPath: async (candidatePath) => {
        if (candidatePath === bad) {
          const error = new Error('I/O failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return lstat(candidatePath);
      },
    });

    const files = await inventory.inventory([root], undefined, (entry) => skipped.push(entry));
    expect(files.map((file) => file.filePath)).toEqual([good]);
    expect(skipped).toEqual([{ filePath: bad, code: 'EIO' }]);
    await expect(inventory.inventory([root])).rejects.toMatchObject({
      code: 'FILE_UNREADABLE',
      filePath: bad,
    });
  });

  it('continues past child directory EIO and keeps root EIO fatal', async () => {
    const good = path.join(root, 'good.jpg');
    const bad = path.join(root, 'bad-directory');
    await writeFile(good, 'good');
    await mkdir(bad);
    const skipped: Array<{ filePath: string; code: string }> = [];
    const inventory = new MediaInventory({
      readDirectory: async (candidatePath) => {
        if (candidatePath === bad) {
          const error = new Error('I/O failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return (await import('fs/promises')).readdir(candidatePath, { withFileTypes: true });
      },
    });

    const files = await inventory.inventory([root], undefined, (entry) => skipped.push(entry));
    expect(files.map((file) => file.filePath)).toEqual([good]);
    expect(skipped).toEqual([{ filePath: bad, code: 'EIO' }]);

    const rootFailure = new MediaInventory({
      readDirectory: async () => {
        const error = new Error('I/O failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    });
    await expect(
      rootFailure.inventory([root], undefined, (entry) => skipped.push(entry))
    ).rejects.toMatchObject({ code: 'DIRECTORY_UNREADABLE', filePath: root });
    expect(skipped).toEqual([{ filePath: bad, code: 'EIO' }]);
  });

  it('reports a child EIO once when overlapping roots encounter it twice', async () => {
    const nested = path.join(root, 'nested');
    const bad = path.join(nested, 'broken');
    await mkdir(nested);
    await mkdir(bad);
    const skipped: string[] = [];
    const inventory = new MediaInventory({
      inspectPath: async (candidatePath) => {
        if (candidatePath === bad) {
          const error = new Error('I/O failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return lstat(candidatePath);
      },
    });

    expect(
      await inventory.inventory([root, nested], undefined, (entry) => skipped.push(entry.filePath))
    ).toEqual([]);
    expect(skipped).toEqual([bad]);
  });

  it('stops discovery when the preview signal is aborted during a directory read', async () => {
    const controller = new AbortController();
    let inspections = 0;
    const inventory = new MediaInventory({
      readDirectory: async () => {
        controller.abort('Stopped by user');
        return [];
      },
      inspectPath: async (candidatePath) => {
        inspections += 1;
        return lstat(candidatePath);
      },
    });

    await expect(inventory.inventory([root], controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Stopped by user',
    });
    expect(inspections).toBe(2);
  });
});
