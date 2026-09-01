import * as fs from 'fs/promises';
import * as path from 'path';

export type PathPolicyErrorCode =
  | 'PATH_INVALID_TYPE'
  | 'PATH_EMPTY'
  | 'PATH_CONTROL_CHARACTER'
  | 'PATH_NOT_ABSOLUTE'
  | 'ROOT_NOT_FOUND'
  | 'ROOT_UNREADABLE'
  | 'ROOT_SYMBOLIC_LINK'
  | 'ROOT_NOT_DIRECTORY'
  | 'ROOT_IDENTITY_CHANGED'
  | 'ROOTS_OVERLAP'
  | 'FILE_NOT_FOUND'
  | 'FILE_UNREADABLE'
  | 'FILE_SYMBOLIC_LINK'
  | 'FILE_NOT_REGULAR'
  | 'FILE_HARD_LINKED'
  | 'FILE_CROSS_DEVICE'
  | 'FILE_OUTSIDE_SOURCE'
  | 'FILE_IDENTITY_CHANGED';

export class PathPolicyError extends Error {
  public readonly code: PathPolicyErrorCode;
  public readonly field: string;

  public constructor(code: PathPolicyErrorCode, field: string, message: string) {
    super(message);
    this.name = 'PathPolicyError';
    this.code = code;
    this.field = field;
  }
}

export interface CanonicalDirectoryRoot {
  inputPath: string;
  realPath: string;
  device: number;
  inode: number;
}

export interface CanonicalRootPair {
  source: CanonicalDirectoryRoot;
  destination: CanonicalDirectoryRoot;
}

export interface InventoryFileIdentity {
  path: string;
  device: number;
  inode: number;
  links: number;
  size: number;
  modifiedTimeMs: number;
}

const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

function stripTrailingSeparators(inputPath: string): string {
  const filesystemRoot = path.parse(inputPath).root;
  let result = inputPath;
  while (result.length > filesystemRoot.length && result.endsWith(path.sep)) {
    result = result.slice(0, -1);
  }
  return result;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Path check cancelled'
  );
  error.name = 'AbortError';
  throw error;
}

export function validateAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PathPolicyError('PATH_INVALID_TYPE', field, `${field} must be a string`);
  }
  if (value.length === 0) {
    throw new PathPolicyError('PATH_EMPTY', field, `${field} must not be empty`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new PathPolicyError(
      'PATH_CONTROL_CHARACTER',
      field,
      `${field} must not contain control characters`
    );
  }
  if (!path.isAbsolute(value)) {
    throw new PathPolicyError('PATH_NOT_ABSOLUTE', field, `${field} must be absolute`);
  }

  return stripTrailingSeparators(path.normalize(value));
}

export async function resolveDirectoryRoot(
  inputPath: unknown,
  field: string,
  signal?: AbortSignal
): Promise<CanonicalDirectoryRoot> {
  throwIfAborted(signal);
  const normalizedPath = validateAbsolutePath(inputPath, field);

  let inputStats;
  try {
    inputStats = await fs.lstat(normalizedPath);
  } catch (error) {
    const code = errorCode(error);
    throw new PathPolicyError(
      code === 'ENOENT' ? 'ROOT_NOT_FOUND' : 'ROOT_UNREADABLE',
      field,
      `${field} cannot be inspected`
    );
  }
  throwIfAborted(signal);

  if (inputStats.isSymbolicLink()) {
    throw new PathPolicyError('ROOT_SYMBOLIC_LINK', field, `${field} must not be a symbolic link`);
  }
  if (!inputStats.isDirectory()) {
    throw new PathPolicyError('ROOT_NOT_DIRECTORY', field, `${field} must be a directory`);
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(normalizedPath);
  } catch {
    throw new PathPolicyError('ROOT_UNREADABLE', field, `${field} cannot be resolved`);
  }
  throwIfAborted(signal);

  let canonicalStats;
  try {
    canonicalStats = await fs.stat(realPath);
  } catch {
    throw new PathPolicyError('ROOT_UNREADABLE', field, `${field} cannot be resolved`);
  }
  throwIfAborted(signal);

  if (!canonicalStats.isDirectory()) {
    throw new PathPolicyError('ROOT_NOT_DIRECTORY', field, `${field} must resolve to a directory`);
  }
  if (canonicalStats.dev !== inputStats.dev || canonicalStats.ino !== inputStats.ino) {
    throw new PathPolicyError(
      'ROOT_IDENTITY_CHANGED',
      field,
      `${field} identity changed during inspection`
    );
  }

  return {
    inputPath: normalizedPath,
    realPath,
    device: canonicalStats.dev,
    inode: canonicalStats.ino,
  };
}

export function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return (
    relativePath === '' ||
    (!path.isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`))
  );
}

export function rootsOverlap(
  source: CanonicalDirectoryRoot,
  destination: CanonicalDirectoryRoot
): boolean {
  const sameIdentity = source.device === destination.device && source.inode === destination.inode;
  return (
    sameIdentity ||
    isPathWithinRoot(source.realPath, destination.realPath) ||
    isPathWithinRoot(destination.realPath, source.realPath)
  );
}

export async function resolveRootPair(
  sourcePath: unknown,
  destinationPath: unknown,
  signal?: AbortSignal
): Promise<CanonicalRootPair> {
  throwIfAborted(signal);
  const [source, destination] = await Promise.all([
    resolveDirectoryRoot(sourcePath, 'sourcePath', signal),
    resolveDirectoryRoot(destinationPath, 'destinationPath', signal),
  ]);
  throwIfAborted(signal);

  if (rootsOverlap(source, destination)) {
    throw new PathPolicyError(
      'ROOTS_OVERLAP',
      'sourcePath,destinationPath',
      'Source and destination roots must be separate, non-nested directories'
    );
  }

  return { source, destination };
}

export async function inspectInventoryFile(
  inputPath: unknown,
  sourceRoot: CanonicalDirectoryRoot
): Promise<InventoryFileIdentity> {
  const normalizedPath = validateAbsolutePath(inputPath, 'filePath');

  let inputStats;
  try {
    inputStats = await fs.lstat(normalizedPath);
  } catch (error) {
    const code = errorCode(error);
    throw new PathPolicyError(
      code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_UNREADABLE',
      'filePath',
      'File cannot be inspected'
    );
  }

  if (inputStats.isSymbolicLink()) {
    throw new PathPolicyError(
      'FILE_SYMBOLIC_LINK',
      'filePath',
      'Symbolic links are not inventory files'
    );
  }
  if (!inputStats.isFile()) {
    throw new PathPolicyError(
      'FILE_NOT_REGULAR',
      'filePath',
      'Inventory entries must be regular files'
    );
  }
  if (inputStats.nlink !== 1) {
    throw new PathPolicyError('FILE_HARD_LINKED', 'filePath', 'Hard-linked files are not accepted');
  }

  let realPath: string;
  let canonicalStats;
  try {
    realPath = await fs.realpath(normalizedPath);
    canonicalStats = await fs.stat(realPath);
  } catch {
    throw new PathPolicyError('FILE_UNREADABLE', 'filePath', 'File cannot be resolved');
  }

  if (!isPathWithinRoot(sourceRoot.realPath, realPath) || realPath === sourceRoot.realPath) {
    throw new PathPolicyError('FILE_OUTSIDE_SOURCE', 'filePath', 'File is outside the source root');
  }
  if (canonicalStats.dev !== sourceRoot.device) {
    throw new PathPolicyError(
      'FILE_CROSS_DEVICE',
      'filePath',
      'Inventory files must remain on the source filesystem device'
    );
  }
  if (!canonicalStats.isFile()) {
    throw new PathPolicyError(
      'FILE_NOT_REGULAR',
      'filePath',
      'Inventory entries must be regular files'
    );
  }
  if (canonicalStats.nlink !== 1) {
    throw new PathPolicyError('FILE_HARD_LINKED', 'filePath', 'Hard-linked files are not accepted');
  }
  if (canonicalStats.dev !== inputStats.dev || canonicalStats.ino !== inputStats.ino) {
    throw new PathPolicyError(
      'FILE_IDENTITY_CHANGED',
      'filePath',
      'File identity changed during inspection'
    );
  }

  return {
    path: realPath,
    device: canonicalStats.dev,
    inode: canonicalStats.ino,
    links: canonicalStats.nlink,
    size: canonicalStats.size,
    modifiedTimeMs: canonicalStats.mtimeMs,
  };
}
