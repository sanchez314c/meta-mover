import { ChildProcess, SpawnOptions, spawn } from 'child_process';
import { createHash } from 'crypto';
import { constants } from 'fs';
import { open } from 'fs/promises';
import path from 'path';
import { TextDecoder } from 'util';

import type {
  ExifToolReadAdapter,
  RawExifTags,
  VerifiedRawExifRead,
} from '../core/metadata/MetadataCandidateCollector';
import type {
  MetadataDateWriterPort,
  MetadataNormalizationReceipt,
  NormalizeDateMetadataRequest,
} from '../core/metadata/MetadataDateWriter';
import { buildMetadataNormalizationPlan } from '../core/metadata/MetadataNormalizationPolicy';
import {
  BrokerLaunchTrustPolicy,
  developmentBrokerLaunchTrustPolicy,
  LinuxImmutableBrokerLaunchTrustPolicy,
} from '../native/NativeFilesystemHelperClient';
import { nativePackageBrokerLaunchTrustPolicy } from '../native/NativePackageTrustPolicies';
import { BundledRuntimeHealth } from './BundledRuntimeHealth';

const VERIFIED_READ_ARGS = ['-json', '-G1', '-a', '-s', '-'] as const;
const DIRECT_READ_ARGS = ['-json', '-G1', '-a', '-s', '--'] as const;
const MAX_VERIFIED_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_VERIFIED_ERROR_BYTES = 64 * 1024;

export interface BundledExifToolPaths {
  platform: NodeJS.Platform;
  exiftoolPath: string;
  perlPath?: string;
  perlLibraryPaths?: string[];
}

export type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface BundledExifToolDependencies {
  spawnProcess: SpawnProcess;
}

export interface BundledExifToolRuntimeOptions {
  architecture?: string;
  isPackaged?: boolean;
  launchTrustPolicy?: BrokerLaunchTrustPolicy;
}

const DEFAULT_DEPENDENCIES: BundledExifToolDependencies = {
  spawnProcess: spawn,
};

function platformPath(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`Unsupported bundled ExifTool platform: ${platform}`);
  }
}

function assertAbsolute(platform: NodeJS.Platform, value: string, label: string): void {
  if (!platformPath(platform).isAbsolute(value)) {
    throw new Error(`${label} must be absolute: ${value}`);
  }
}

function resolveLaunchTrustPolicy(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  injectedPolicy?: BrokerLaunchTrustPolicy
): BrokerLaunchTrustPolicy {
  if (injectedPolicy) {
    if (isPackaged && injectedPolicy.mode !== 'production') {
      throw new Error('Packaged runtime rejects a development broker trust policy');
    }
    return injectedPolicy;
  }
  if (!isPackaged) return developmentBrokerLaunchTrustPolicy();
  if (platform === 'linux') return new LinuxImmutableBrokerLaunchTrustPolicy();
  return nativePackageBrokerLaunchTrustPolicy(platform);
}

export class BundledExifToolAdapter implements ExifToolReadAdapter, MetadataDateWriterPort {
  private readonly spawnProcess: SpawnProcess;
  private readonly verifiedExecutable: string;
  private readonly verifiedArguments: readonly string[];
  private readonly directArgumentPrefix: readonly string[];
  private readonly commandPrefix: readonly string[];
  private readonly spawnOptions: SpawnOptions;
  private closed = false;

  constructor(
    paths: BundledExifToolPaths,
    dependencies: BundledExifToolDependencies = DEFAULT_DEPENDENCIES
  ) {
    assertSupportedPlatform(paths.platform);
    assertAbsolute(paths.platform, paths.exiftoolPath, 'Bundled ExifTool path');
    if (paths.platform !== 'win32') {
      if (!paths.perlPath) throw new Error('Bundled Perl path is required');
      assertAbsolute(paths.platform, paths.perlPath, 'Bundled Perl path');
      if (!Array.isArray(paths.perlLibraryPaths) || paths.perlLibraryPaths.length === 0) {
        throw new Error('Bundled Perl library paths are required');
      }
      for (const libraryPath of paths.perlLibraryPaths) {
        assertAbsolute(paths.platform, libraryPath, 'Bundled Perl library path');
      }
    }

    const pathApi = platformPath(paths.platform);
    const environment = Object.freeze({
      EXIFTOOL_HOME: pathApi.dirname(paths.exiftoolPath),
      LANG: 'C',
      LC_ALL: 'C',
      ...(paths.platform === 'win32'
        ? {}
        : {
            PATH: pathApi.dirname(paths.perlPath!),
            PERL5LIB: [
              pathApi.join(pathApi.dirname(paths.exiftoolPath), 'lib'),
              ...paths.perlLibraryPaths!,
            ].join(pathApi.delimiter),
            PERL_USE_UNSAFE_INC: '0',
          }),
    });
    const executable = paths.platform === 'win32' ? paths.exiftoolPath : paths.perlPath!;
    this.spawnProcess = dependencies.spawnProcess;
    this.verifiedExecutable = executable;
    this.verifiedArguments =
      paths.platform === 'win32'
        ? [...VERIFIED_READ_ARGS]
        : [paths.exiftoolPath, ...VERIFIED_READ_ARGS];
    this.commandPrefix = paths.platform === 'win32' ? [] : [paths.exiftoolPath];
    this.directArgumentPrefix = [...this.commandPrefix, ...DIRECT_READ_ARGS];
    this.spawnOptions = {
      detached: false,
      env: { ...environment },
      shell: false,
      stdio: 'pipe',
    };
  }

  static async createPackaged(
    resourcesRoot: string,
    platform: NodeJS.Platform = process.platform,
    dependencies: BundledExifToolDependencies = DEFAULT_DEPENDENCIES,
    runtimeOptions: Readonly<BundledExifToolRuntimeOptions> = {}
  ): Promise<BundledExifToolAdapter> {
    assertSupportedPlatform(platform);
    const isPackaged = runtimeOptions.isPackaged ?? true;
    const launchTrustPolicy = resolveLaunchTrustPolicy(
      platform,
      isPackaged,
      runtimeOptions.launchTrustPolicy
    );
    const runtimePaths = (
      await new BundledRuntimeHealth(
        resourcesRoot,
        platform,
        runtimeOptions.architecture ?? process.arch,
        () => Date.now(),
        { launchTrustPolicy, isPackaged }
      ).verified()
    ).paths;

    return new BundledExifToolAdapter(
      {
        platform,
        exiftoolPath: runtimePaths.exiftoolPath,
        ...(runtimePaths.perlPath ? { perlPath: runtimePaths.perlPath } : {}),
        ...(runtimePaths.perlLibraryPaths.length === 0
          ? {}
          : { perlLibraryPaths: runtimePaths.perlLibraryPaths }),
      },
      dependencies
    );
  }

  async readRaw(filePath: string, signal?: AbortSignal): Promise<RawExifTags> {
    this.assertUsablePath(filePath);
    throwIfAdapterAborted(signal);
    const output = await this.runProcess([...this.directArgumentPrefix, filePath], signal);
    if (output.code !== 0) {
      throw new Error(
        `Bundled ExifTool direct read failed with code ${String(output.code)}: ${output.stderr}`
      );
    }
    return parseVerifiedTags(output.stdout);
  }

  async normalizeDateMetadata(
    request: Readonly<NormalizeDateMetadataRequest>
  ): Promise<MetadataNormalizationReceipt> {
    this.assertUsablePath(request.filePath);
    throwIfAdapterAborted(request.signal);
    const plan = buildMetadataNormalizationPlan(request.filePath, request.selectedDate);
    const before = await this.readRaw(request.filePath, request.signal);
    if (plan.assignments.every((entry) => assignmentVerified(before, entry))) {
      return {
        family: plan.family,
        idempotent: true,
        verified: true,
        before,
        after: before,
        normalizedTags: plan.assignments.map(({ tag }) => tag),
      };
    }
    const output = await this.runProcess(
      [
        ...this.commandPrefix,
        '-overwrite_original_in_place',
        ...plan.assignments.map(({ tag, value }) => `-${tag}=${value}`),
        '--',
        request.filePath,
      ],
      request.signal
    );
    const stdout = output.stdout.toString('utf8');
    if (
      output.code !== 0 ||
      !/\b1 (?:image|video|audio|document|files?) files? updated\b/i.test(stdout)
    ) {
      const detail = output.stderr.trim() || stdout.trim() || 'ExifTool reported no updated file';
      throw new Error(
        `Bundled ExifTool metadata write failed with code ${String(output.code)}: ${detail}`
      );
    }
    const after = await this.readRaw(request.filePath, request.signal);
    verifyMetadataNormalization(before, after, plan.assignments);
    return {
      family: plan.family,
      idempotent: false,
      verified: true,
      before,
      after,
      normalizedTags: plan.assignments.map(({ tag }) => tag),
    };
  }

  async readRawVerified(filePath: string, signal?: AbortSignal): Promise<VerifiedRawExifRead> {
    if (this.closed) throw new Error('BundledExifToolAdapter is closed');
    throwIfAdapterAborted(signal);
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let primaryError: unknown;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error(`Verified metadata input is not a singly linked regular file: ${filePath}`);
      }
      const child = this.spawnProcess(this.verifiedExecutable, [...this.verifiedArguments], {
        ...this.spawnOptions,
      });
      const processCapture = captureVerifiedProcess(child, signal);
      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let bytes = 0;
      try {
        while (true) {
          throwIfAdapterAborted(signal);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          digest.update(chunk);
          await writeChildInput(child, chunk, signal);
          bytes += bytesRead;
        }
        await endChildInput(child, signal);
      } catch (error) {
        processCapture.fail(error);
        try {
          await processCapture.completion;
        } catch {
          // The streaming error remains authoritative; child cleanup was still observed.
        }
        throw error;
      }

      const output = await processCapture.completion;
      throwIfAdapterAborted(signal);
      if (output.code !== 0) {
        throw new Error(
          `Bundled ExifTool verified read failed with code ${String(output.code)}: ${output.stderr}`
        );
      }
      const parsed = parseVerifiedTags(output.stdout);
      return { tags: parsed, sha256: digest.digest('hex'), bytes };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await handle.close();
      } catch (closeError) {
        if (primaryError !== undefined) {
          throw new AdapterAggregateError(
            [primaryError, closeError],
            'Verified metadata read and input close both failed'
          );
        }
        throw closeError;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }

  private assertUsablePath(filePath: string): void {
    if (this.closed) throw new Error('BundledExifToolAdapter is closed');
    if (!path.isAbsolute(filePath) || /\p{Cc}/u.test(filePath)) {
      throw new Error(
        'Bundled ExifTool input path must be absolute and contain no control characters'
      );
    }
  }

  private async runProcess(
    argumentsList: string[],
    signal?: AbortSignal
  ): Promise<VerifiedProcessOutput> {
    const child = this.spawnProcess(this.verifiedExecutable, argumentsList, {
      ...this.spawnOptions,
    });
    const capture = captureVerifiedProcess(child, signal);
    try {
      await endChildInput(child, signal);
    } catch (error) {
      capture.fail(error);
    }
    return capture.completion;
  }
}

function verifyMetadataNormalization(
  before: RawExifTags,
  after: RawExifTags,
  assignments: readonly { tag: string; value: string }[]
): void {
  const normalized = new Set(assignments.map(({ tag }) => tag));
  for (const entry of assignments) {
    if (!assignmentVerified(after, entry)) {
      const { tag } = entry;
      throw new Error(`Bundled ExifTool metadata readback did not verify ${tag}`);
    }
  }
  for (const [tag, value] of Object.entries(before)) {
    if (
      !isNormalizedReadbackTag(tag, normalized) &&
      !isStructuralObservation(tag) &&
      JSON.stringify(after[tag]) !== JSON.stringify(value)
    ) {
      throw new Error(`Bundled ExifTool metadata write changed protected tag ${tag}`);
    }
  }
  for (const tag of Object.keys(after)) {
    if (
      !isNormalizedReadbackTag(tag, normalized) &&
      !isStructuralObservation(tag) &&
      !(tag in before)
    ) {
      throw new Error(`Bundled ExifTool metadata write fabricated protected tag ${tag}`);
    }
  }
}

function assignmentVerified(
  tags: RawExifTags,
  assignment: { tag: string; value: string }
): boolean {
  if (tags[assignment.tag] === assignment.value) return true;
  const name = assignment.tag.slice(assignment.tag.indexOf(':') + 1);
  if (!/^QuickTime:(?:Track|Media)CreateDate$/.test(assignment.tag)) return false;
  const streamValues = Object.entries(tags).filter(([tag]) =>
    new RegExp(`^(?:QuickTime|Track\\d+):${name}$`).test(tag)
  );
  return streamValues.length > 0 && streamValues.every(([, value]) => value === assignment.value);
}

function isNormalizedReadbackTag(tag: string, normalized: ReadonlySet<string>): boolean {
  if (normalized.has(tag)) return true;
  const name = tag.slice(tag.indexOf(':') + 1);
  return /^Track\d+:(?:Track|Media)CreateDate$/.test(tag) && normalized.has(`QuickTime:${name}`);
}

function isStructuralObservation(tag: string): boolean {
  return (
    /^(?:File|System|ExifTool|Composite):/.test(tag) ||
    /^IFD0:(?:XResolution|YResolution|ResolutionUnit|YCbCrPositioning)$/.test(tag) ||
    /^ExifIFD:(?:ExifVersion|FlashpixVersion|ComponentsConfiguration|ColorSpace)$/.test(tag) ||
    /^IPTC:ApplicationRecordVersion$/.test(tag) ||
    /^XMP-x:XMPToolkit$/.test(tag) ||
    /^QuickTime:(?:Media|Movie)Data(?:Offset|Size)$/.test(tag)
  );
}

class AdapterAggregateError extends Error {
  readonly name = 'AggregateError';

  constructor(
    public readonly errors: readonly unknown[],
    message: string
  ) {
    super(message);
  }
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error(
    typeof signal?.reason === 'string' ? signal.reason : 'Metadata extraction cancelled'
  );
  error.name = 'AbortError';
  return error;
}

function throwIfAdapterAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

interface VerifiedProcessOutput {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

interface VerifiedProcessCapture {
  completion: Promise<VerifiedProcessOutput>;
  fail(error: unknown): void;
}

function terminateVerifiedProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
}

function captureVerifiedProcess(child: ChildProcess, signal?: AbortSignal): VerifiedProcessCapture {
  let failProcess: (error: unknown) => void = () => undefined;
  const completion = new Promise<VerifiedProcessOutput>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const fail = (error: unknown) => {
      failure ??= error;
      terminateVerifiedProcess(child);
      if (!killTimer) {
        killTimer = setTimeout(() => {
          if (!settled && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, 250);
        killTimer.unref?.();
      }
    };
    failProcess = fail;
    const onAbort = () => fail(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_VERIFIED_OUTPUT_BYTES) {
        fail(new Error('Bundled ExifTool verified output exceeded 16 MiB'));
      } else {
        stdout.push(Buffer.from(chunk));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_VERIFIED_ERROR_BYTES) {
        fail(new Error('Bundled ExifTool verified stderr exceeded 64 KiB'));
      } else {
        stderr.push(Buffer.from(chunk));
      }
    });
    child.stdout?.once('error', fail);
    child.stderr?.once('error', fail);
    child.stdin?.once('error', fail);
    child.once('error', fail);
    child.once('close', (code) => {
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (failure !== undefined) reject(failure);
      else
        resolve({
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
    });
    if (signal?.aborted) onAbort();
  });
  return {
    completion,
    fail: (error) => failProcess(error),
  };
}

async function writeChildInput(
  child: ChildProcess,
  chunk: Buffer,
  signal?: AbortSignal
): Promise<void> {
  throwIfAdapterAborted(signal);
  if (!child.stdin) throw new Error('Bundled ExifTool stdin is unavailable');
  await new Promise<void>((resolve, reject) => {
    child.stdin!.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
  throwIfAdapterAborted(signal);
}

async function endChildInput(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  throwIfAdapterAborted(signal);
  if (!child.stdin) throw new Error('Bundled ExifTool stdin is unavailable');
  await new Promise<void>((resolve, reject) => {
    child.stdin!.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

function parseVerifiedTags(output: Buffer): RawExifTags {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    throw new Error('Bundled ExifTool verified output is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Bundled ExifTool verified output is not valid JSON');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    typeof parsed[0] !== 'object' ||
    parsed[0] === null ||
    Array.isArray(parsed[0])
  ) {
    throw new Error('Bundled ExifTool verified output must contain exactly one tag object');
  }
  return parsed[0] as RawExifTags;
}
