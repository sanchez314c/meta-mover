import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { FileHandle, lstat, mkdir, open, realpath, rename, unlink } from 'fs/promises';
import path from 'path';

import { ConflictPolicy, FolderStructure, OperationMode } from '../../shared/types/processing';

export interface AppConfig {
  version: 3;
  theme: 'light' | 'dark' | 'system';
  windowBounds?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
  processing: {
    workerCount: number;
    operation: OperationMode;
    verifyIntegrity: true;
    writeMetadataDates: boolean;
    testMode: boolean;
  };
  organization: {
    folderStructure: FolderStructure;
    conflictPolicy: ConflictPolicy;
    appendScreenshotSuffix: boolean;
  };
}

export interface AppConfigUpdate {
  theme?: AppConfig['theme'];
  windowBounds?: AppConfig['windowBounds'];
  processing?: Partial<AppConfig['processing']>;
  organization?: Partial<AppConfig['organization']>;
}

export const DEFAULT_APP_CONFIG: Readonly<AppConfig> = Object.freeze({
  version: 3,
  theme: 'system',
  processing: Object.freeze({
    workerCount: 4,
    operation: OperationMode.COPY,
    verifyIntegrity: true,
    writeMetadataDates: false,
    testMode: false,
  }),
  organization: Object.freeze({
    folderStructure: FolderStructure.YEAR_MONTH,
    conflictPolicy: ConflictPolicy.RENAME,
    appendScreenshotSuffix: false,
  }),
});

export class AppConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppConfigValidationError';
  }
}

export interface AppConfigStoreTestHooks {
  afterParentPrepared?: () => Promise<void>;
  beforeConfigRead?: () => Promise<void>;
  beforePersist?: () => Promise<void>;
  onDirectorySynced?: (directoryPath: string) => void;
  platform?: NodeJS.Platform;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotData(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    throw new AppConfigValidationError('Configuration arrays are not allowed');
  }
  if (!plainObject(value))
    throw new AppConfigValidationError('Configuration must use plain objects');
  const snapshot = Object.create(null) as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new AppConfigValidationError('Configuration symbol fields are not allowed');
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new AppConfigValidationError(`Configuration accessor is not allowed: ${key}`);
    }
    snapshot[key] = snapshotData(descriptor.value);
  }
  return snapshot;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function sameIdentity(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number }
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function prepareSafeParent(
  parent: string,
  testHooks: AppConfigStoreTestHooks
): Promise<{ canonicalPath: string; device: number; inode: number; handle: FileHandle }> {
  const filesystemRoot = path.parse(parent).root;
  const components = parent.slice(filesystemRoot.length).split(path.sep).filter(Boolean);
  const platform = testHooks.platform ?? process.platform;
  let portableFirstCreated = -1;

  if (platform !== 'linux') {
    let candidate = filesystemRoot;
    for (let index = 0; index < components.length; index += 1) {
      candidate = path.join(candidate, components[index]);
      try {
        const visible = await lstat(candidate);
        if (visible.isSymbolicLink() || !visible.isDirectory()) {
          throw new Error('Configuration ancestor must be a real directory');
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        portableFirstCreated = index;
        break;
      }
    }
    if (portableFirstCreated >= 0) {
      /*
       * Node exposes no portable openat/mkdirat API. Create the entire missing suffix in one
       * operation after validating every existing ancestor, then perform no more pathname-based
       * mutation while verifying it component by component. A malicious process running as the
       * same OS user can still race that single mkdir call on non-Linux platforms; normal callers
       * and lower-privilege processes cannot redirect later component creation into another tree.
       */
      await mkdir(parent, { recursive: true, mode: 0o700 });
    }
  }

  let currentPath = filesystemRoot;
  let currentHandle = await open(
    filesystemRoot,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  );
  let retained = false;
  try {
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      const operationParent =
        platform === 'linux' ? `/proc/self/fd/${currentHandle.fd}` : currentPath;
      const childPath = path.join(operationParent, component);
      let created =
        platform !== 'linux' && portableFirstCreated >= 0 && index >= portableFirstCreated;
      let visible;
      try {
        visible = await lstat(childPath);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        if (platform !== 'linux') {
          throw new Error('Configuration ancestor identity changed during creation');
        }
        try {
          await mkdir(childPath, { mode: 0o700 });
          created = true;
          await currentHandle.sync();
          testHooks.onDirectorySynced?.(currentPath);
        } catch (mkdirError) {
          if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
        }
        visible = await lstat(childPath);
      }
      if (visible.isSymbolicLink() || !visible.isDirectory()) {
        throw new Error('Configuration ancestor must be a real directory');
      }
      if (created && (visible.mode & 0o777) !== 0o700) {
        throw new Error('New configuration directory is not private');
      }

      const childHandle = await open(
        childPath,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
      );
      try {
        const held = await childHandle.stat();
        if (!held.isDirectory() || !sameIdentity(held, visible)) {
          throw new Error('Configuration ancestor identity changed');
        }
        if (created && platform !== 'linux') {
          await currentHandle.sync();
          testHooks.onDirectorySynced?.(currentPath);
        }
      } catch (error) {
        await childHandle.close().catch(() => undefined);
        throw error;
      }
      await currentHandle.close();
      currentHandle = childHandle;
      currentPath = path.join(currentPath, component);
    }

    const parentStats = await currentHandle.stat();
    const canonicalPath = await realpath(parent);
    if (canonicalPath !== path.resolve(parent)) {
      throw new Error('Configuration parent must not traverse symbolic links');
    }
    retained = true;
    return {
      canonicalPath,
      device: parentStats.dev,
      inode: parentStats.ino,
      handle: currentHandle,
    };
  } finally {
    if (!retained) await currentHandle.close().catch(() => undefined);
  }
}

async function assertVisibleParent(
  parent: string,
  identity: { canonicalPath: string; device: number; inode: number }
): Promise<void> {
  const visible = await lstat(parent);
  if (
    visible.isSymbolicLink() ||
    !visible.isDirectory() ||
    visible.dev !== identity.device ||
    visible.ino !== identity.inode ||
    (await realpath(parent)) !== identity.canonicalPath
  ) {
    throw new Error('Configuration parent identity changed');
  }
}

function clone(config: AppConfig): AppConfig {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new AppConfigValidationError(`Unknown configuration field: ${prefix}${String(key)}`);
    }
  }
}

function finiteInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new AppConfigValidationError(
      `${label} must be an integer from ${minimum} through ${maximum}`
    );
  }
  return value;
}

function validateWindowBounds(value: unknown): AppConfig['windowBounds'] {
  if (!plainObject(value)) throw new AppConfigValidationError('windowBounds must be an object');
  rejectUnknown(value, ['width', 'height', 'x', 'y'], 'windowBounds.');
  const width = finiteInteger(value.width, 900, 10_000, 'windowBounds.width');
  const height = finiteInteger(value.height, 600, 10_000, 'windowBounds.height');
  const coordinate = (candidate: unknown, label: string): number | undefined => {
    if (candidate === undefined) return undefined;
    return finiteInteger(candidate, -100_000, 100_000, label);
  };
  const x = coordinate(value.x, 'windowBounds.x');
  const y = coordinate(value.y, 'windowBounds.y');
  return { width, height, ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }) };
}

function mergeUpdate(
  base: AppConfig,
  input: unknown,
  strictUnknown: boolean,
  persisted = false,
  allowLegacyCorruption = false
): AppConfig {
  if (!plainObject(input)) throw new AppConfigValidationError('Configuration must be an object');
  const topLevel = ['version', 'theme', 'windowBounds', 'processing', 'organization'];
  if (strictUnknown)
    rejectUnknown(input, persisted ? topLevel : topLevel.filter((key) => key !== 'version'), '');

  const next = clone(base);
  if (input.version !== undefined && input.version !== 2 && input.version !== 3) {
    throw new AppConfigValidationError('Configuration version is unsupported');
  }
  if (input.theme !== undefined) {
    if (!['light', 'dark', 'system'].includes(input.theme as string)) {
      throw new AppConfigValidationError('theme is invalid');
    }
    next.theme = input.theme as AppConfig['theme'];
  }
  if (input.windowBounds !== undefined)
    next.windowBounds = validateWindowBounds(input.windowBounds);

  if (input.processing !== undefined) {
    if (!plainObject(input.processing)) {
      throw new AppConfigValidationError('processing must be an object');
    }
    const processing = input.processing;
    if (strictUnknown) {
      rejectUnknown(
        processing,
        [
          'workerCount',
          'operation',
          'verifyIntegrity',
          'writeMetadataDates',
          'testMode',
          ...(allowLegacyCorruption ? ['corruptionDetection'] : []),
        ],
        'processing.'
      );
    }
    if (
      allowLegacyCorruption &&
      processing.corruptionDetection !== undefined &&
      typeof processing.corruptionDetection !== 'boolean'
    ) {
      throw new AppConfigValidationError('processing.corruptionDetection must be boolean');
    }
    if (!allowLegacyCorruption && processing.corruptionDetection !== undefined) {
      throw new AppConfigValidationError(
        'Unknown configuration field: processing.corruptionDetection'
      );
    }
    if (processing.workerCount !== undefined) {
      next.processing.workerCount = finiteInteger(
        processing.workerCount,
        1,
        10,
        'processing.workerCount'
      );
    }
    if (processing.operation !== undefined) {
      if (!Object.values(OperationMode).includes(processing.operation as OperationMode)) {
        throw new AppConfigValidationError('processing.operation must be copy or move');
      }
      next.processing.operation = processing.operation as OperationMode;
    }
    if (processing.verifyIntegrity !== undefined && processing.verifyIntegrity !== true) {
      throw new AppConfigValidationError('processing.verifyIntegrity cannot be disabled');
    }
    if (
      processing.writeMetadataDates !== undefined &&
      typeof processing.writeMetadataDates !== 'boolean'
    ) {
      throw new AppConfigValidationError('processing.writeMetadataDates must be boolean');
    }
    if (processing.writeMetadataDates !== undefined) {
      next.processing.writeMetadataDates = processing.writeMetadataDates;
    }
    if (processing.testMode !== undefined && typeof processing.testMode !== 'boolean') {
      throw new AppConfigValidationError('processing.testMode must be boolean');
    }
    if (processing.testMode !== undefined) next.processing.testMode = processing.testMode;
  }

  if (input.organization !== undefined) {
    if (!plainObject(input.organization)) {
      throw new AppConfigValidationError('organization must be an object');
    }
    const organization = input.organization;
    if (strictUnknown) {
      rejectUnknown(
        organization,
        ['folderStructure', 'conflictPolicy', 'appendScreenshotSuffix'],
        'organization.'
      );
    }
    if (organization.folderStructure !== undefined) {
      if (
        !Object.values(FolderStructure).includes(organization.folderStructure as FolderStructure)
      ) {
        throw new AppConfigValidationError('organization.folderStructure is invalid');
      }
      next.organization.folderStructure = organization.folderStructure as FolderStructure;
    }
    if (organization.conflictPolicy !== undefined) {
      if (!Object.values(ConflictPolicy).includes(organization.conflictPolicy as ConflictPolicy)) {
        throw new AppConfigValidationError('organization.conflictPolicy must be skip or rename');
      }
      next.organization.conflictPolicy = organization.conflictPolicy as ConflictPolicy;
    }
    if (
      organization.appendScreenshotSuffix !== undefined &&
      typeof organization.appendScreenshotSuffix !== 'boolean'
    ) {
      throw new AppConfigValidationError('organization.appendScreenshotSuffix must be boolean');
    }
    if (organization.appendScreenshotSuffix !== undefined) {
      next.organization.appendScreenshotSuffix = organization.appendScreenshotSuffix;
    }
  }
  return next;
}

export class AppConfigStore {
  private writeTail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly configPath: string,
    private config: AppConfig,
    private readonly parentCanonicalPath: string,
    private readonly parentDevice: number,
    private readonly parentInode: number,
    private readonly runtimePlatform: NodeJS.Platform,
    private readonly testHooks: AppConfigStoreTestHooks
  ) {}

  static async open(
    configPath: string,
    warning: (message: string) => void = () => undefined,
    testHooks: AppConfigStoreTestHooks = {}
  ): Promise<AppConfigStore> {
    if (!path.isAbsolute(configPath)) {
      throw new AppConfigValidationError('Configuration path must be absolute');
    }
    const normalizedConfigPath = path.normalize(configPath);
    const parent = path.dirname(normalizedConfigPath);
    const parentIdentity = await prepareSafeParent(parent, testHooks);

    let config = clone(DEFAULT_APP_CONFIG as AppConfig);
    let configHandle: FileHandle | undefined;
    try {
      await testHooks.afterParentPrepared?.();
      await assertVisibleParent(parent, parentIdentity);
      const heldConfigPath =
        (testHooks.platform ?? process.platform) === 'linux'
          ? path.join(`/proc/self/fd/${parentIdentity.handle.fd}`, path.basename(configPath))
          : normalizedConfigPath;
      try {
        configHandle = await open(heldConfigPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const [heldBefore, visibleBefore] = await Promise.all([
          configHandle.stat(),
          lstat(heldConfigPath),
        ]);
        if (
          !heldBefore.isFile() ||
          heldBefore.nlink !== 1 ||
          visibleBefore.isSymbolicLink() ||
          !visibleBefore.isFile() ||
          visibleBefore.nlink !== 1 ||
          !sameIdentity(heldBefore, visibleBefore)
        ) {
          throw new Error('Configuration file must be a singly-linked regular file');
        }
        await testHooks.beforeConfigRead?.();
        const contents = await configHandle.readFile('utf8');
        const [heldAfter, visibleAfter] = await Promise.all([
          configHandle.stat(),
          lstat(heldConfigPath),
        ]);
        if (
          visibleAfter.isSymbolicLink() ||
          !visibleAfter.isFile() ||
          visibleAfter.nlink !== 1 ||
          !sameIdentity(heldBefore, heldAfter) ||
          !sameIdentity(heldBefore, visibleAfter) ||
          heldBefore.size !== heldAfter.size ||
          heldBefore.mtimeMs !== heldAfter.mtimeMs
        ) {
          throw new Error('Configuration file identity changed during read');
        }
        const parsed = snapshotData(JSON.parse(contents) as unknown);
        const persistedVersion = plainObject(parsed) ? parsed.version : undefined;
        const legacyVersion = persistedVersion === 2;
        config = mergeUpdate(config, parsed, persistedVersion === 3, true, legacyVersion);
        if (legacyVersion) {
          const migratingStore = new AppConfigStore(
            normalizedConfigPath,
            config,
            parentIdentity.canonicalPath,
            parentIdentity.device,
            parentIdentity.inode,
            testHooks.platform ?? process.platform,
            testHooks
          );
          await migratingStore.persist(config);
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          if (error instanceof SyntaxError || error instanceof AppConfigValidationError) {
            warning(`Persisted configuration is invalid; defaults remain active: ${error.message}`);
          } else {
            throw error;
          }
        }
      }
      await assertVisibleParent(parent, parentIdentity);
      return new AppConfigStore(
        normalizedConfigPath,
        config,
        parentIdentity.canonicalPath,
        parentIdentity.device,
        parentIdentity.inode,
        testHooks.platform ?? process.platform,
        testHooks
      );
    } finally {
      await configHandle?.close().catch(() => undefined);
      await parentIdentity.handle.close().catch(() => undefined);
    }
  }

  /** Safe during and after close because this returns only a defensive in-memory snapshot. */
  getAll(): AppConfig {
    return clone(this.config);
  }

  async update(update: AppConfigUpdate): Promise<AppConfig> {
    this.assertAcceptingWrites();
    const snapshot = snapshotData(update) as AppConfigUpdate;
    return this.enqueue(() => mergeUpdate(this.config, snapshot, true));
  }

  async reset(): Promise<AppConfig> {
    this.assertAcceptingWrites();
    return this.enqueue(() => clone(DEFAULT_APP_CONFIG as AppConfig));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.writeTail.then(() => undefined);
    return this.closePromise;
  }

  private assertAcceptingWrites(): void {
    if (this.closing) throw new Error('AppConfigStore is closing or closed');
  }

  private async enqueue(nextConfig: () => AppConfig): Promise<AppConfig> {
    let result!: AppConfig;
    const write = this.writeTail.then(async () => {
      const next = nextConfig();
      await this.persist(next);
      this.config = next;
      result = clone(next);
    });
    this.writeTail = write.catch(() => undefined);
    await write;
    return result;
  }

  private async persist(config: AppConfig): Promise<void> {
    await this.testHooks.beforePersist?.();
    const parent = path.dirname(this.configPath);
    const parentHandle = await open(parent, 'r');
    const parentStats = await parentHandle.stat();
    if (
      !parentStats.isDirectory() ||
      parentStats.dev !== this.parentDevice ||
      parentStats.ino !== this.parentInode ||
      (await realpath(parent)) !== this.parentCanonicalPath
    ) {
      await parentHandle.close();
      throw new Error('Configuration parent identity changed');
    }
    // Linux binds writes to the held directory descriptor. Node has no portable *at API, so
    // macOS/Windows use pre/post identity checks; same-user pathname sabotage between those checks
    // remains an explicit OS-account trust boundary rather than silently claiming atomic binding.
    const operationParent =
      this.runtimePlatform === 'linux' ? `/proc/self/fd/${parentHandle.fd}` : parent;
    const temporaryPath = path.join(operationParent, `.config-${process.pid}-${randomUUID()}.tmp`);
    const targetPath = path.join(operationParent, path.basename(this.configPath));
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      const currentParentStats = await lstat(parent);
      if (
        currentParentStats.isSymbolicLink() ||
        currentParentStats.dev !== this.parentDevice ||
        currentParentStats.ino !== this.parentInode ||
        (await realpath(parent)) !== this.parentCanonicalPath
      ) {
        throw new Error('Configuration parent identity changed');
      }
      await rename(temporaryPath, targetPath);
      await parentHandle.sync();
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    } finally {
      await parentHandle.close().catch(() => undefined);
    }
  }
}
