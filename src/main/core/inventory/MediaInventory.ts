import { Dirent, Stats } from 'fs';
import { lstat, readdir, realpath } from 'fs/promises';
import path from 'path';

import { classifyMediaExtension, normalizedFileExtension } from '../../../shared/constants';
import { MediaKind } from '../date';

export type MediaInventoryErrorCode =
  | 'SOURCE_PATH_INVALID'
  | 'SOURCE_UNREADABLE'
  | 'SOURCE_NOT_DIRECTORY'
  | 'SYMLINK_REJECTED'
  | 'HARD_LINK_REJECTED'
  | 'DIRECTORY_UNREADABLE'
  | 'FILE_UNREADABLE'
  | 'PATH_IDENTITY_CHANGED'
  | 'PATH_OUTSIDE_SOURCE'
  | 'FILE_METADATA_INVALID';

export class MediaInventoryError extends Error {
  constructor(
    public readonly code: MediaInventoryErrorCode,
    public readonly filePath: string,
    message: string
  ) {
    super(message);
    this.name = 'MediaInventoryError';
  }
}

interface InventoryMediaFileBase {
  filePath: string;
  extension: string;
  device: number;
  inode: number;
  links: number;
  size: number;
  modifiedTimeMs: number;
}

export interface SupportedInventoryMediaFile extends InventoryMediaFileBase {
  formatStatus: 'supported';
  mediaKind: MediaKind;
}

export interface UnsupportedInventoryMediaFile extends InventoryMediaFileBase {
  formatStatus: 'unsupported';
  mediaKind: null;
}

export type InventoryMediaFile = SupportedInventoryMediaFile | UnsupportedInventoryMediaFile;

interface InventoryDependencies {
  readDirectory(directoryPath: string): Promise<Dirent[]>;
  inspectPath(filePath: string): Promise<Stats>;
  resolvePath(filePath: string): Promise<string>;
}

const DEFAULT_DEPENDENCIES: InventoryDependencies = {
  readDirectory: (directoryPath) => readdir(directoryPath, { withFileTypes: true }),
  inspectPath: lstat,
  resolvePath: realpath,
};

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validEntryName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/]/.test(name) &&
    !/\p{Cc}/u.test(name)
  );
}

function validFileStats(stats: Stats): boolean {
  return (
    [stats.dev, stats.ino, stats.nlink, stats.size].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) &&
    Number.isFinite(stats.mtimeMs) &&
    stats.mtimeMs >= 0
  );
}

export class MediaInventory {
  private readonly dependencies: InventoryDependencies;

  constructor(dependencies: Partial<InventoryDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  async inventory(sourcePaths: readonly string[]): Promise<InventoryMediaFile[]> {
    if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
      throw new MediaInventoryError(
        'SOURCE_PATH_INVALID',
        '',
        'At least one source path is required'
      );
    }

    const files = new Map<string, InventoryMediaFile>();
    const roots: string[] = [];
    for (const sourcePath of sourcePaths) {
      roots.push(await this.resolveRoot(sourcePath));
    }
    roots.sort(comparePaths);

    for (const root of roots) await this.scan(root, root, files);
    return [...files.values()].sort((left, right) => comparePaths(left.filePath, right.filePath));
  }

  private async resolveRoot(sourcePath: string): Promise<string> {
    if (
      typeof sourcePath !== 'string' ||
      !path.isAbsolute(sourcePath) ||
      /\p{Cc}/u.test(sourcePath)
    ) {
      throw new MediaInventoryError(
        'SOURCE_PATH_INVALID',
        String(sourcePath),
        'Source paths must be absolute strings without control characters'
      );
    }

    let stats;
    try {
      stats = await this.dependencies.inspectPath(sourcePath);
    } catch (error) {
      throw new MediaInventoryError(
        'SOURCE_UNREADABLE',
        sourcePath,
        `Source cannot be inspected${errorCode(error) ? ` (${errorCode(error)})` : ''}`
      );
    }
    if (stats.isSymbolicLink()) {
      throw new MediaInventoryError(
        'SYMLINK_REJECTED',
        sourcePath,
        'Source root is a symbolic link'
      );
    }
    if (!stats.isDirectory()) {
      throw new MediaInventoryError(
        'SOURCE_NOT_DIRECTORY',
        sourcePath,
        'Source must be a directory'
      );
    }

    const canonical = await this.dependencies.resolvePath(sourcePath);
    const canonicalStats = await this.dependencies.inspectPath(canonical);
    if (canonicalStats.dev !== stats.dev || canonicalStats.ino !== stats.ino) {
      throw new MediaInventoryError(
        'PATH_IDENTITY_CHANGED',
        sourcePath,
        'Source root identity changed during validation'
      );
    }
    return canonical;
  }

  private async scan(
    rootPath: string,
    directoryPath: string,
    files: Map<string, InventoryMediaFile>
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await this.dependencies.readDirectory(directoryPath);
    } catch (error) {
      throw new MediaInventoryError(
        'DIRECTORY_UNREADABLE',
        directoryPath,
        `Directory cannot be read${errorCode(error) ? ` (${errorCode(error)})` : ''}`
      );
    }
    entries.sort((left, right) => comparePaths(left.name, right.name));

    for (const entry of entries) {
      if (!validEntryName(entry.name)) {
        throw new MediaInventoryError(
          'PATH_OUTSIDE_SOURCE',
          String(entry.name),
          'Inventory entry name is not a canonical basename'
        );
      }
      const entryPath = path.join(directoryPath, entry.name);
      let stats;
      try {
        stats = await this.dependencies.inspectPath(entryPath);
      } catch (error) {
        throw new MediaInventoryError(
          'FILE_UNREADABLE',
          entryPath,
          `Inventory entry cannot be inspected${errorCode(error) ? ` (${errorCode(error)})` : ''}`
        );
      }
      if (stats.isSymbolicLink()) {
        throw new MediaInventoryError(
          'SYMLINK_REJECTED',
          entryPath,
          'Symbolic links are not accepted'
        );
      }
      if (stats.isDirectory()) {
        await this.scan(rootPath, entryPath, files);
        continue;
      }
      if (!stats.isFile()) continue;

      if (!validFileStats(stats)) {
        throw new MediaInventoryError(
          'FILE_METADATA_INVALID',
          entryPath,
          'Media filesystem metadata contains unsafe numeric values'
        );
      }

      if (stats.nlink !== 1) {
        throw new MediaInventoryError(
          'HARD_LINK_REJECTED',
          entryPath,
          'Hard-linked media is rejected because path identity is ambiguous'
        );
      }
      const canonical = await this.dependencies.resolvePath(entryPath);
      if (!isWithin(rootPath, canonical)) {
        throw new MediaInventoryError(
          'PATH_OUTSIDE_SOURCE',
          entryPath,
          'Media resolves outside the canonical source root'
        );
      }
      const canonicalStats = await this.dependencies.inspectPath(canonical);
      if (canonicalStats.dev !== stats.dev || canonicalStats.ino !== stats.ino) {
        throw new MediaInventoryError(
          'PATH_IDENTITY_CHANGED',
          entryPath,
          'Media identity changed during inventory'
        );
      }
      const identity = `${stats.dev}:${stats.ino}`;
      if (files.has(identity)) continue;
      const mediaKind = classifyMediaExtension(entryPath) as MediaKind | null;
      const inventoryIdentity = {
        filePath: canonical,
        extension: normalizedFileExtension(entryPath),
        device: stats.dev,
        inode: stats.ino,
        links: stats.nlink,
        size: stats.size,
        modifiedTimeMs: stats.mtimeMs,
      };
      files.set(
        identity,
        mediaKind === null
          ? { ...inventoryIdentity, formatStatus: 'unsupported', mediaKind: null }
          : { ...inventoryIdentity, formatStatus: 'supported', mediaKind }
      );
    }
  }
}
