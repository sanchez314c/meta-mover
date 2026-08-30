import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { constants } from 'fs';
import { access, lstat, readFile, readdir, realpath } from 'fs/promises';
import path from 'path';
import { promisify, TextDecoder } from 'util';

import { RuntimeReadinessResult } from '../services/MediaPreviewRevalidator';
import {
  BrokerLaunchTrustPolicy,
  NativeFilesystemHelperClient,
  NativeFilesystemHelperLauncher,
} from '../native/NativeFilesystemHelperClient';
import { DependencyHealthDTO, DependencyStatusDTO } from '../../shared/types/processing';

const execFileAsync = promisify(execFile);

type BundledToolName = 'exiftool' | 'fs-helper' | 'launch-broker' | 'perl';
type HealthDependencyName = 'exiftool' | 'fs-helper';

const FILESYSTEM_HELPER_PROTOCOL_VERSION = 1;
const FILESYSTEM_HELPER_HELLO_ID = '00000000-0000-4000-8000-000000000001';
const FILESYSTEM_HELPER_BIND_ID = '00000000-0000-4000-8000-000000000002';
const FILESYSTEM_HELPER_CLOSE_ID = '00000000-0000-4000-8000-000000000003';
const FILESYSTEM_HELPER_TIMEOUT_MS = 3_000;
const FILESYSTEM_HELPER_MAX_OUTPUT_BYTES = 65_536;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ARRAY_ITEMS = 256;

interface ToolManifestEntry {
  name: BundledToolName;
  path: string;
  version: string;
  sha256: string;
  target?: string;
  protocolVersion?: number;
  buildVersion?: string;
  rustTarget?: string;
  helperSha256?: string;
  helperProtocolVersion?: number;
  helperBuildVersion?: string;
  releaseSigner?: string | null;
  supportDirectory?: DirectoryManifestEntry;
}

interface DirectoryManifestEntry {
  path: string;
  sha256: string;
  fileCount: number;
}

type PerlLibraryManifestEntry = DirectoryManifestEntry;

interface ToolManifest {
  schemaVersion: 3;
  platform: NodeJS.Platform;
  arch: string;
  tools: ToolManifestEntry[];
  perlLibs?: PerlLibraryManifestEntry[];
  runtimeCompatibility: RuntimeCompatibilityEvidence;
}

interface RuntimeCompatibilityEvidence {
  platform: NodeJS.Platform;
  arch: string;
  nativePlatformOnly: true;
  inspectedTool: 'exiftool' | 'perl';
  binaryFormat: string;
  loader: string;
  sharedLibraries: string[];
}

export interface BundledRuntimePaths {
  toolsRoot: string;
  exiftoolPath: string;
  fsHelperPath: string;
  launchBrokerPath: string;
  perlPath?: string;
  perlLibraryPaths: string[];
}

interface LoadedRuntime {
  manifest: ToolManifest;
  entries: Map<BundledToolName, ToolManifestEntry>;
  paths: BundledRuntimePaths;
}

export interface VerifiedBundledRuntime {
  paths: BundledRuntimePaths;
  versions: Readonly<Record<HealthDependencyName, string>>;
}

export interface BundledRuntimeFilesystemProbeOptions {
  launcher?: NativeFilesystemHelperLauncher;
  launchTrustPolicy?: BrokerLaunchTrustPolicy;
  isPackaged?: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstOutputLine(stdout: string, stderr: string): string | undefined {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(comparePaths);
  const expected = [...keys].sort(comparePaths);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  if (!hasExactKeys(value, keys)) throw new Error(`${label} has missing or unknown keys`);
}

class StrictJsonScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace();
    this.value(1);
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new Error('JSON contains trailing data');
  }

  private value(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new Error('JSON nesting exceeds protocol depth limit');
    const character = this.text[this.index];
    if (character === '{') return this.object(depth);
    if (character === '[') return this.array(depth);
    if (character === '"') return void this.string();
    if (this.text.startsWith('true', this.index)) return void (this.index += 4);
    if (this.text.startsWith('false', this.index)) return void (this.index += 5);
    if (this.text.startsWith('null', this.index)) return void (this.index += 4);
    this.integer();
  }

  private object(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.text[this.index] !== '"') throw new Error('JSON object key must be a string');
      const key = this.string();
      if (keys.has(key)) throw new Error(`JSON contains duplicate key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') throw new Error('JSON object key has no value');
      this.index += 1;
      this.skipWhitespace();
      this.value(depth + 1);
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') throw new Error('JSON object is malformed');
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private array(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    let items = 0;
    if (this.text[this.index] === ']') {
      this.index += 1;
      return;
    }
    while (true) {
      items += 1;
      if (items > MAX_JSON_ARRAY_ITEMS) throw new Error('JSON array exceeds 256-item limit');
      this.value(depth + 1);
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') throw new Error('JSON array is malformed');
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
      if (character === '\\') {
        this.index += 2;
      } else {
        if (character < ' ') throw new Error('JSON string contains a control character');
        this.index += 1;
      }
    }
    throw new Error('JSON string is unterminated');
  }

  private integer(): void {
    const start = this.index;
    while (this.index < this.text.length && !/[\s,\]}]/.test(this.text[this.index])) {
      this.index += 1;
    }
    const token = this.text.slice(start, this.index);
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(token)) {
      throw new Error('JSON numbers must be integers');
    }
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.index] ?? '')) this.index += 1;
  }
}

function parseStrictJson(bytes: Buffer<ArrayBufferLike>, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${errorMessage(error)}`);
  }
  try {
    new StrictJsonScanner(text).scan();
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid strict JSON: ${errorMessage(error)}`);
  }
}

function rustTargets(platform: NodeJS.Platform, architecture: string): readonly string[] {
  const targets: Partial<Record<NodeJS.Platform, Record<string, readonly string[]>>> = {
    linux: {
      x64: ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'],
      arm64: ['aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl'],
    },
    darwin: {
      x64: ['x86_64-apple-darwin'],
      arm64: ['aarch64-apple-darwin'],
    },
    win32: {
      x64: ['x86_64-pc-windows-msvc'],
      arm64: ['aarch64-pc-windows-msvc'],
      ia32: ['i686-pc-windows-msvc'],
    },
  };
  return targets[platform]?.[architecture] ?? [];
}

export class BundledRuntimeHealth {
  constructor(
    private readonly resourcesRoot: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly architecture: string = process.arch,
    private readonly now: () => number = () => Date.now(),
    private readonly filesystemProbe: Readonly<BundledRuntimeFilesystemProbeOptions> = {}
  ) {}

  async paths(): Promise<BundledRuntimePaths> {
    return (await this.verified()).paths;
  }

  async verified(): Promise<VerifiedBundledRuntime> {
    const loaded = await this.load();
    await this.verifyFilesystemHelper();
    await this.verifyTool(loaded);
    return {
      paths: loaded.paths,
      versions: {
        exiftool: loaded.entries.get('exiftool')!.version,
        'fs-helper': loaded.entries.get('fs-helper')!.version,
      },
    };
  }

  async check(): Promise<RuntimeReadinessResult> {
    const health = await this.getHealth();
    return {
      ready: health.ready,
      reasons: health.dependencies
        .filter((dependency) => !dependency.available)
        .map((dependency) => `${dependency.name}: ${dependency.error ?? 'unavailable'}`),
    };
  }

  async getHealth(): Promise<DependencyHealthDTO> {
    const checkedAt = new Date(this.now()).toISOString();
    let loaded: LoadedRuntime;
    try {
      loaded = await this.load();
    } catch (error) {
      const message = errorMessage(error);
      const dependencies = this.unavailableDependencies(message);
      return this.health(checkedAt, dependencies);
    }

    let filesystemHelperError: unknown;
    try {
      await this.verifyFilesystemHelper();
    } catch (error) {
      filesystemHelperError = error;
    }

    const dependencies: DependencyStatusDTO[] = [];
    for (const name of ['exiftool', 'fs-helper'] as const) {
      try {
        if (filesystemHelperError !== undefined) throw filesystemHelperError;
        if (name === 'exiftool') await this.verifyTool(loaded);
        dependencies.push({
          name,
          available: true,
          source: 'bundled',
          requiredFor: ['preview', 'start'],
          version: loaded.entries.get(name)!.version,
        });
      } catch (error) {
        dependencies.push({
          name,
          available: false,
          source: 'bundled',
          requiredFor: ['preview', 'start'],
          error: errorMessage(error),
        });
      }
    }
    return this.health(checkedAt, dependencies);
  }

  private health(checkedAt: string, dependencies: DependencyStatusDTO[]): DependencyHealthDTO {
    const unavailable = (name: DependencyStatusDTO['name']) =>
      dependencies.find((dependency) => dependency.name === name)?.available !== true;
    const runtimeBlockers = dependencies
      .filter((dependency) => !dependency.available)
      .map(
        (dependency) =>
          dependency.error ??
          (dependency.name === 'exiftool'
            ? 'Bundled ExifTool is unavailable'
            : 'Bundled filesystem helper is unavailable')
      );
    return {
      checkedAt,
      ready: !unavailable('exiftool') && !unavailable('fs-helper'),
      capabilities: {
        preview: { available: runtimeBlockers.length === 0, blockers: runtimeBlockers },
        start: { available: runtimeBlockers.length === 0, blockers: runtimeBlockers },
        metadataWriteback: {
          available: false,
          blockers: ['Meta Mover never writes inferred dates back into source metadata'],
        },
      },
      dependencies,
    };
  }

  private unavailableDependencies(error: string): DependencyStatusDTO[] {
    return (['exiftool', 'fs-helper'] as const).map((name) => ({
      name,
      available: false,
      source: 'bundled',
      requiredFor: ['preview', 'start'],
      error,
    }));
  }

  private async load(): Promise<LoadedRuntime> {
    if (!path.isAbsolute(this.resourcesRoot)) {
      throw new Error('Application resources path must be absolute');
    }
    const resourcesStats = await lstat(this.resourcesRoot);
    if (!resourcesStats.isDirectory() || resourcesStats.isSymbolicLink()) {
      throw new Error('Application resources root must be a regular directory');
    }
    const canonicalResourcesRoot = await realpath(this.resourcesRoot);
    const toolsPath = path.join(canonicalResourcesRoot, 'tools');
    const toolsStats = await lstat(toolsPath);
    if (!toolsStats.isDirectory() || toolsStats.isSymbolicLink()) {
      throw new Error('Bundled tools root must be a regular directory, not a symbolic link');
    }
    const toolsRoot = await realpath(toolsPath);
    if (!isWithin(canonicalResourcesRoot, toolsRoot)) {
      throw new Error('Bundled tools root escapes application resources');
    }
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifestStats = await lstat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.nlink !== 1) {
      throw new Error('Bundled tool manifest must be a singly-linked regular file');
    }
    const parsedManifest = parseStrictJson(await readFile(manifestPath), 'Bundled tool manifest');
    if (!isRecord(parsedManifest)) throw new Error('Bundled tool manifest must be an object');
    assertExactKeys(
      parsedManifest,
      this.platform === 'win32'
        ? ['schemaVersion', 'platform', 'arch', 'tools', 'runtimeCompatibility']
        : ['schemaVersion', 'platform', 'arch', 'tools', 'perlLibs', 'runtimeCompatibility'],
      'Bundled tool manifest'
    );
    const raw = parsedManifest as unknown as ToolManifest;
    if (raw.schemaVersion !== 3) throw new Error('Bundled tool manifest schema is unsupported');
    if (raw.platform !== this.platform) {
      throw new Error(
        `Bundled tool manifest platform is ${raw.platform}, expected ${this.platform}`
      );
    }
    if (raw.arch !== this.architecture) {
      throw new Error(
        `Bundled tool manifest architecture is ${raw.arch}, expected ${this.architecture}`
      );
    }
    if (!Array.isArray(raw.tools)) throw new Error('Bundled tool manifest has no tool entries');
    const required: BundledToolName[] =
      this.platform === 'win32'
        ? ['exiftool', 'fs-helper', 'launch-broker']
        : ['exiftool', 'fs-helper', 'launch-broker', 'perl'];
    const compatibility = raw.runtimeCompatibility;
    if (!isRecord(compatibility)) {
      throw new Error('Bundled runtime compatibility evidence must be an object');
    }
    assertExactKeys(
      compatibility,
      [
        'platform',
        'arch',
        'nativePlatformOnly',
        'inspectedTool',
        'binaryFormat',
        'loader',
        'sharedLibraries',
      ],
      'Bundled runtime compatibility evidence'
    );
    if (
      !compatibility ||
      compatibility.platform !== this.platform ||
      compatibility.arch !== this.architecture ||
      compatibility.nativePlatformOnly !== true ||
      compatibility.inspectedTool !== (this.platform === 'win32' ? 'exiftool' : 'perl') ||
      typeof compatibility.binaryFormat !== 'string' ||
      compatibility.binaryFormat.length === 0 ||
      typeof compatibility.loader !== 'string' ||
      compatibility.loader.length === 0 ||
      !Array.isArray(compatibility.sharedLibraries) ||
      compatibility.sharedLibraries.length === 0 ||
      compatibility.sharedLibraries.some(
        (library) => typeof library !== 'string' || library.length === 0
      )
    ) {
      throw new Error('Bundled runtime compatibility evidence is invalid');
    }
    const entries = new Map<BundledToolName, ToolManifestEntry>();
    for (const entry of raw.tools) {
      if (!isRecord(entry)) throw new Error('Bundled tool entry must be an object');
      const baseKeys = ['name', 'path', 'version', 'sha256'];
      const entryName = entry.name;
      assertExactKeys(
        entry,
        entryName === 'fs-helper'
          ? [...baseKeys, 'target', 'protocolVersion', 'buildVersion']
          : entryName === 'launch-broker'
            ? [
                ...baseKeys,
                'target',
                'rustTarget',
                'buildVersion',
                'helperSha256',
                'helperProtocolVersion',
                'helperBuildVersion',
                'releaseSigner',
              ]
            : entryName === 'exiftool' && this.platform !== 'win32'
              ? [...baseKeys, 'supportDirectory']
              : baseKeys,
        `${String(entryName)} tool entry`
      );
      if (
        !required.includes(entry?.name) ||
        entries.has(entry.name) ||
        typeof entry.path !== 'string' ||
        typeof entry.version !== 'string' ||
        entry.version.length === 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      ) {
        throw new Error('Bundled tool manifest contains an invalid or duplicate tool entry');
      }
      entries.set(entry.name, entry);
    }
    if (required.some((name) => !entries.has(name)) || entries.size !== required.length) {
      throw new Error(`Bundled tool manifest must contain exactly: ${required.join(', ')}`);
    }

    const helperEntry = entries.get('fs-helper')!;
    const helperSuffix = this.platform === 'win32' ? '.exe' : '';
    const expectedHelperPath = `fs-helper/${this.platform}-${this.architecture}/meta-mover-fs-helper${helperSuffix}`;
    if (
      helperEntry.path !== expectedHelperPath ||
      helperEntry.target !== `${this.platform}-${this.architecture}` ||
      helperEntry.protocolVersion !== FILESYSTEM_HELPER_PROTOCOL_VERSION ||
      helperEntry.buildVersion !== helperEntry.version
    ) {
      throw new Error(
        `Filesystem helper manifest metadata must match ${this.platform}-${this.architecture}, protocol ${FILESYSTEM_HELPER_PROTOCOL_VERSION}, build version, and path ${expectedHelperPath}`
      );
    }

    const brokerEntry = entries.get('launch-broker')!;
    const brokerSuffix = this.platform === 'win32' ? '.exe' : '';
    const expectedBrokerPath = `launch-broker/${this.platform}-${this.architecture}/meta-mover-launch-broker${brokerSuffix}`;
    if (
      brokerEntry.path !== expectedBrokerPath ||
      brokerEntry.target !== `${this.platform}-${this.architecture}` ||
      typeof brokerEntry.rustTarget !== 'string' ||
      !rustTargets(this.platform, this.architecture).includes(brokerEntry.rustTarget) ||
      brokerEntry.buildVersion !== brokerEntry.version ||
      brokerEntry.helperSha256 !== helperEntry.sha256 ||
      brokerEntry.helperProtocolVersion !== helperEntry.protocolVersion ||
      brokerEntry.helperBuildVersion !== helperEntry.buildVersion ||
      !(
        brokerEntry.releaseSigner === null ||
        (typeof brokerEntry.releaseSigner === 'string' &&
          brokerEntry.releaseSigner.length > 0 &&
          !/[\0\r\n]/.test(brokerEntry.releaseSigner))
      )
    ) {
      throw new Error('Launch broker manifest entry does not match the native filesystem helper');
    }

    const resolveEntry = async (entry: ToolManifestEntry): Promise<string> => {
      if (path.isAbsolute(entry.path))
        throw new Error(`${entry.name} manifest path must be relative`);
      const candidate = path.resolve(toolsRoot, entry.path);
      if (!isWithin(toolsRoot, candidate))
        throw new Error(`${entry.name} escapes bundled resources`);
      const candidateStats = await lstat(candidate);
      if (
        !candidateStats.isFile() ||
        candidateStats.isSymbolicLink() ||
        candidateStats.nlink !== 1
      ) {
        throw new Error(`${entry.name} must be a singly-linked regular bundled file`);
      }
      const canonical = await realpath(candidate);
      if (!isWithin(toolsRoot, canonical))
        throw new Error(`${entry.name} escapes bundled resources`);
      const stats = await lstat(canonical);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw new Error(`${entry.name} is not a regular bundled file`);
      }
      if (this.platform !== 'win32') {
        try {
          await access(canonical, constants.X_OK);
        } catch {
          throw new Error(`${entry.name} bundled file must be executable`);
        }
      }
      return canonical;
    };

    const resolved = new Map<BundledToolName, string>();
    for (const name of required) resolved.set(name, await resolveEntry(entries.get(name)!));

    if (this.platform !== 'win32') {
      const exiftool = entries.get('exiftool')!;
      const support = exiftool.supportDirectory;
      const expectedSupportPath = path.posix.join(path.posix.dirname(exiftool.path), 'lib');
      if (isRecord(support)) {
        assertExactKeys(support, ['path', 'sha256', 'fileCount'], 'ExifTool support directory');
      }
      if (
        typeof support?.path !== 'string' ||
        support.path !== expectedSupportPath ||
        path.isAbsolute(support.path) ||
        !/^[a-f0-9]{64}$/.test(support.sha256) ||
        !Number.isSafeInteger(support.fileCount) ||
        support.fileCount < 1
      ) {
        throw new Error(`ExifTool support directory must be ${expectedSupportPath}`);
      }
      const supportPath = path.resolve(toolsRoot, support.path);
      if (!isWithin(toolsRoot, supportPath)) {
        throw new Error('ExifTool support directory escapes application resources');
      }
      const visibleSupport = await lstat(supportPath);
      if (!visibleSupport.isDirectory() || visibleSupport.isSymbolicLink()) {
        throw new Error('ExifTool support directory is not a regular directory');
      }
      const canonicalSupport = await realpath(supportPath);
      if (!isWithin(toolsRoot, canonicalSupport)) {
        throw new Error('ExifTool support directory escapes application resources');
      }
      const actualSupport = await this.hashDirectory(canonicalSupport);
      if (
        actualSupport.sha256 !== support.sha256 ||
        actualSupport.fileCount !== support.fileCount
      ) {
        throw new Error('ExifTool support directory digest does not match');
      }
    }

    const perlLibraryPaths: string[] = [];
    if (this.platform !== 'win32') {
      if (!Array.isArray(raw.perlLibs) || raw.perlLibs.length === 0) {
        throw new Error('Bundled tool manifest has no Perl library roots');
      }
      for (const library of raw.perlLibs) {
        if (!isRecord(library)) throw new Error('Bundled Perl library entry must be an object');
        assertExactKeys(library, ['path', 'sha256', 'fileCount'], 'Bundled Perl library entry');
        if (
          typeof library?.path !== 'string' ||
          path.isAbsolute(library.path) ||
          !/^[a-f0-9]{64}$/.test(library.sha256) ||
          !Number.isSafeInteger(library.fileCount) ||
          library.fileCount < 0
        ) {
          throw new Error('Bundled Perl library path must be relative');
        }
        const candidate = path.resolve(toolsRoot, library.path);
        if (!isWithin(toolsRoot, candidate)) {
          throw new Error('Bundled Perl library escapes application resources');
        }
        const candidateStats = await lstat(candidate);
        if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()) {
          throw new Error('Bundled Perl library root is not a regular directory');
        }
        const canonical = await realpath(candidate);
        if (!isWithin(toolsRoot, canonical)) {
          throw new Error('Bundled Perl library resolves outside application resources');
        }
        const stats = await lstat(canonical);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new Error('Bundled Perl library root is not a regular directory');
        }
        const actual = await this.hashDirectory(canonical);
        if (actual.sha256 !== library.sha256 || actual.fileCount !== library.fileCount) {
          throw new Error(`Perl library digest does not match: ${library.path}`);
        }
        perlLibraryPaths.push(canonical);
      }
    }

    return {
      manifest: raw,
      entries,
      paths: {
        toolsRoot,
        exiftoolPath: resolved.get('exiftool')!,
        fsHelperPath: resolved.get('fs-helper')!,
        launchBrokerPath: resolved.get('launch-broker')!,
        ...(resolved.has('perl') ? { perlPath: resolved.get('perl')! } : {}),
        perlLibraryPaths,
      },
    };
  }

  private async hashDirectory(directory: string): Promise<{ sha256: string; fileCount: number }> {
    const digest = createHash('sha256');
    let fileCount = 0;
    const visit = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => comparePaths(left.name, right.name));
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name);
        const stats = await lstat(entryPath);
        if (stats.isSymbolicLink())
          throw new Error(`Bundled support directory contains a symlink: ${entryPath}`);
        if (stats.isDirectory()) {
          await visit(entryPath);
        } else if (stats.isFile()) {
          if (stats.nlink !== 1)
            throw new Error(`Bundled support directory contains a hard link: ${entryPath}`);
          digest.update(path.relative(directory, entryPath).split(path.sep).join('/'));
          digest.update('\0');
          digest.update(await readFile(entryPath));
          digest.update('\0');
          fileCount += 1;
        } else {
          throw new Error(
            `Bundled support directory contains a special non-regular entry: ${entryPath}`
          );
        }
      }
    };
    await visit(directory);
    return { sha256: digest.digest('hex'), fileCount };
  }

  private async verifyTool(loaded: LoadedRuntime) {
    const name = 'exiftool' as const;
    const manifestEntry = loaded.entries.get(name)!;
    const executablePath = loaded.paths.exiftoolPath;
    const actualDigest = createHash('sha256')
      .update(await readFile(executablePath))
      .digest('hex');
    if (actualDigest !== manifestEntry.sha256) {
      throw new Error(`${name} bundled binary digest does not match its manifest`);
    }

    let command = executablePath;
    let args = ['-ver'];
    if (this.platform !== 'win32') {
      const perlPath = loaded.paths.perlPath!;
      const perlEntry = loaded.entries.get('perl')!;
      const perlDigest = createHash('sha256')
        .update(await readFile(perlPath))
        .digest('hex');
      if (perlDigest !== perlEntry.sha256) {
        throw new Error('perl bundled binary digest does not match its manifest');
      }
      command = perlPath;
      args = [executablePath, '-ver'];
    }
    const result = await execFileAsync(command, args, {
      cwd: loaded.paths.toolsRoot,
      env: {
        LANG: 'C',
        LC_ALL: 'C',
        PATH: loaded.paths.toolsRoot,
        ...(loaded.paths.perlLibraryPaths.length === 0
          ? {}
          : {
              PERL5LIB: [
                path.join(path.dirname(loaded.paths.exiftoolPath), 'lib'),
                ...loaded.paths.perlLibraryPaths,
              ].join(path.delimiter),
              PERL_USE_UNSAFE_INC: '0',
            }),
      },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const version = firstOutputLine(result.stdout, result.stderr);
    if (version !== manifestEntry.version) {
      throw new Error(`${name} executable version does not match its manifest`);
    }
  }

  private async verifyFilesystemHelper(): Promise<void> {
    const probeIds = [
      FILESYSTEM_HELPER_HELLO_ID,
      FILESYSTEM_HELPER_BIND_ID,
      FILESYSTEM_HELPER_CLOSE_ID,
    ];
    let probeIdIndex = 0;
    const client = await NativeFilesystemHelperClient.open({
      resourcesRoot: this.resourcesRoot,
      roots: [
        {
          name: 'runtime-health',
          kind: 'control',
          absolutePath: this.resourcesRoot,
        },
      ],
      platform: this.platform,
      architecture: this.architecture,
      ...(this.filesystemProbe.launcher === undefined
        ? {}
        : { launcher: this.filesystemProbe.launcher }),
      ...(this.filesystemProbe.launchTrustPolicy === undefined
        ? {}
        : { launchTrustPolicy: this.filesystemProbe.launchTrustPolicy }),
      isPackaged: this.filesystemProbe.isPackaged ?? true,
      maxStderrBytes: FILESYSTEM_HELPER_MAX_OUTPUT_BYTES,
      shutdownTimeoutMs: FILESYSTEM_HELPER_TIMEOUT_MS,
      handshakeTimeoutMs: FILESYSTEM_HELPER_TIMEOUT_MS,
      idGenerator: () => probeIds[probeIdIndex++] ?? FILESYSTEM_HELPER_CLOSE_ID,
    });
    await client.close();
  }
}
