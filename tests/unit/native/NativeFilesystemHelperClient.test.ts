import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import { closeSync, fstatSync } from 'fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  DefaultHelperProcessPort,
  developmentBrokerLaunchTrustPolicy,
  DeleteSourceExactResult,
  LinuxBrokerLaunchTrustSystem,
  LinuxImmutableBrokerLaunchTrustPolicy,
  NativeFilesystemHelperClient,
  NativeFilesystemHelperClientError,
  NativeFilesystemHelperLaunchOptions,
  NativeFilesystemHelperLauncher,
  NativeFilesystemHelperProcessPort,
  ReconcileSourceDeleteResult,
  VerifiedHelperLaunchDescriptor,
  VerifiedHelperLaunchLeaseProvider,
} from '../../../src/main/native/NativeFilesystemHelperClient';

const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012',
] as const;

const SHA256 = 'a'.repeat(64);
const DELETE_ID = '00000000-0000-4000-8000-000000000031';
const RECEIPT = {
  root: 'control',
  components: ['delete-receipts', `${DELETE_ID}.json`],
};
const UNIX_IDENTITY = {
  kind: 'unix' as const,
  device: '1',
  inode: '10',
  links: '1',
  size: '42',
  mtimeNs: '-100',
};
const WINDOWS_IDENTITY = {
  kind: 'windows' as const,
  volumeSerial: '1',
  fileId: '10',
  links: '1',
  size: '42',
  mtimeNs: '-100',
};
const NATIVE_IDENTITY = process.platform === 'win32' ? WINDOWS_IDENTITY : UNIX_IDENTITY;
const FOREIGN_IDENTITY = process.platform === 'win32' ? UNIX_IDENTITY : WINDOWS_IDENTITY;
const INVALID_NATIVE_IDENTITY =
  process.platform === 'win32'
    ? { ...WINDOWS_IDENTITY, fileId: '-1' }
    : { ...UNIX_IDENTITY, inode: '-1' };

type ProtocolRequest = Record<string, unknown> & { v: 1; id: string; op: string };

function electronTarget(platform = process.platform, architecture = process.arch): string {
  return `${platform}-${architecture}`;
}

function rustTarget(platform = process.platform, architecture = process.arch): string {
  const prefix = architecture === 'x64' ? 'x86_64' : architecture === 'arm64' ? 'aarch64' : 'i686';
  if (platform === 'linux') return `${prefix}-unknown-linux-gnu`;
  if (platform === 'darwin') return `${prefix}-apple-darwin`;
  return `${prefix}-pc-windows-msvc`;
}

function success(id: string, result: Record<string, unknown>): Record<string, unknown> {
  return { v: 1, id, ok: true, result };
}

function lifecycleResult(request: ProtocolRequest): Record<string, unknown> {
  if (request.op === 'hello') {
    return success(request.id, {
      outcome: 'applied',
      protocol: 1,
      build: '0.1.0',
      target: rustTarget(),
      features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
    });
  }
  if (request.op === 'bind_roots') {
    const roots = request.roots as Array<{ name: string; kind: string }>;
    return success(request.id, {
      outcome: 'applied',
      roots: roots.map((root, index) => ({
        name: root.name,
        kind: root.kind,
        identity:
          process.platform === 'win32'
            ? {
                kind: 'windows',
                volumeSerial: '1',
                fileId: String(index + 1),
                links: '1',
                size: '0',
                mtimeNs: '1',
              }
            : {
                kind: 'unix',
                device: '1',
                inode: String(index + 1),
                links: '1',
                size: '0',
                mtimeNs: '1',
              },
      })),
      durability: { file: 'not-applicable', parents: [] },
    });
  }
  if (request.op === 'close') {
    return success(request.id, {
      outcome: 'applied',
      durability: { file: 'not-applicable', parents: [] },
    });
  }
  if (request.op === 'reconcile_source_delete') {
    return success(request.id, {
      outcome: 'not-applied',
      state: 'source-retained',
      sourceState: 'expected',
      quarantineState: 'absent',
      receiptState: 'absent',
      deleteId: request.deleteId,
      durability: { file: 'not-applicable', parents: [] },
    });
  }
  if (request.op === 'delete_source_exact') {
    return success(request.id, {
      outcome: 'applied',
      state: 'deleted',
      sourceState: 'absent',
      quarantineState: 'entry-deleted',
      receiptState: 'created',
      deleteId: request.deleteId,
      durability: { file: 'synced', parents: ['synced', 'synced', 'synced'] },
    });
  }
  return success(request.id, {
    outcome: 'applied',
    after: {
      kind: 'unix',
      device: '1',
      inode: '10',
      links: '1',
      size: '0',
      mtimeNs: '1',
    },
    durability: { file: 'not-applicable', parents: ['synced'] },
  });
}

class FakeHelperProcess implements NativeFilesystemHelperProcessPort {
  readonly writes: ProtocolRequest[] = [];
  readonly rawWrites: Buffer[] = [];
  inputEnded = false;
  terminated = false;
  readonly terminations: boolean[] = [];
  autoRespond = true;
  writeFailure?: unknown;
  outputAfterWriteFailure?: Buffer;
  responseFor: (request: ProtocolRequest) => Record<string, unknown> = lifecycleResult;
  private stdoutListeners = new Set<(chunk: Buffer) => void>();
  private stderrListeners = new Set<(chunk: Buffer) => void>();
  private endListeners = new Set<() => void>();
  private exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private errorListeners = new Set<(error: Error) => void>();

  async write(data: Buffer): Promise<void> {
    if (this.writeFailure !== undefined) {
      const failure = this.writeFailure;
      this.writeFailure = undefined;
      if (this.outputAfterWriteFailure) {
        const output = this.outputAfterWriteFailure;
        this.outputAfterWriteFailure = undefined;
        setTimeout(() => this.emitStdout(output), 0);
      }
      throw failure;
    }
    this.rawWrites.push(Buffer.from(data));
    const request = JSON.parse(data.toString('utf8')) as ProtocolRequest;
    this.writes.push(request);
    if (this.autoRespond) {
      queueMicrotask(() => {
        this.emitJson(this.responseFor(request));
        if (request.op === 'close') queueMicrotask(() => this.emitExit(0, null));
      });
    }
  }

  endInput(): void {
    this.inputEnded = true;
  }

  terminate(force = false): void {
    this.terminated = true;
    this.terminations.push(force);
  }

  onStdout(listener: (chunk: Buffer) => void): () => void {
    this.stdoutListeners.add(listener);
    return () => this.stdoutListeners.delete(listener);
  }

  onStderr(listener: (chunk: Buffer) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onStdoutEnd(listener: () => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  emitJson(value: Record<string, unknown>): void {
    this.emitStdout(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
  }

  emitStdout(chunk: Buffer): void {
    for (const listener of [...this.stdoutListeners]) listener(chunk);
  }

  emitStderr(chunk: Buffer): void {
    for (const listener of [...this.stderrListeners]) listener(chunk);
  }

  emitEnd(): void {
    for (const listener of [...this.endListeners]) listener();
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }

  listenerCount(): number {
    return (
      this.stdoutListeners.size +
      this.stderrListeners.size +
      this.endListeners.size +
      this.exitListeners.size +
      this.errorListeners.size
    );
  }
}

class FakeBrokerIdentityProcess implements NativeFilesystemHelperProcessPort {
  terminated = false;
  readonly terminations: boolean[] = [];
  identity: Record<string, unknown>;
  exitCode = 0;
  autoExit = true;
  rawOutput?: Buffer;
  private stdoutListeners = new Set<(chunk: Buffer) => void>();
  private stderrListeners = new Set<(chunk: Buffer) => void>();
  private endListeners = new Set<() => void>();
  private exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private scheduled = false;

  constructor(identity: Record<string, unknown>) {
    this.identity = identity;
  }

  async write(): Promise<void> {
    throw new Error('Broker identity probe must not accept stdin');
  }

  endInput(): void {}

  terminate(force = false): void {
    this.terminated = true;
    this.terminations.push(force);
  }

  onStdout(listener: (chunk: Buffer) => void): () => void {
    this.stdoutListeners.add(listener);
    return () => this.stdoutListeners.delete(listener);
  }

  onStderr(listener: (chunk: Buffer) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onStdoutEnd(listener: () => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        const output = this.rawOutput ?? Buffer.from(`${JSON.stringify(this.identity)}\n`, 'utf8');
        for (const stdoutListener of [...this.stdoutListeners]) stdoutListener(output);
        for (const endListener of [...this.endListeners]) endListener();
        if (this.autoExit) this.emitExit(this.exitCode, null);
      });
    }
    return () => this.exitListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  emitStdout(chunk: Buffer): void {
    for (const listener of [...this.stdoutListeners]) listener(chunk);
  }
}

class FakeLauncher implements NativeFilesystemHelperLauncher {
  readonly launches: Array<{
    executablePath: string;
    args: readonly string[];
    options: Readonly<NativeFilesystemHelperLaunchOptions>;
  }> = [];
  errorAfterLaunch?: Error;

  constructor(
    readonly process = new FakeHelperProcess(),
    readonly identityProcess = new FakeBrokerIdentityProcess({})
  ) {}

  launch(
    executablePath: string,
    args: readonly string[],
    options: Readonly<NativeFilesystemHelperLaunchOptions>
  ): NativeFilesystemHelperProcessPort {
    this.launches.push({ executablePath, args, options });
    if (this.errorAfterLaunch && args.includes('--stdio')) {
      const error = this.errorAfterLaunch;
      queueMicrotask(() => this.process.emitError(error));
    }
    return args.includes('--identity') ? this.identityProcess : this.process;
  }
}

async function waitForWrites(processPort: FakeHelperProcess, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (processPort.writes.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} helper writes, received ${processPort.writes.length}`);
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

describe('NativeFilesystemHelperClient', () => {
  let resourcesRoot: string;
  let executablePath: string;
  let brokerPath: string;
  let manifestPath: string;
  let launcher: FakeLauncher;

  const absoluteRoot = (name: string): string =>
    process.platform === 'win32' ? path.win32.join('C:\\', name) : path.posix.join('/', name);
  const roots = [
    { name: 'source', kind: 'source' as const, absolutePath: absoluteRoot('input') },
    { name: 'destination', kind: 'destination' as const, absolutePath: absoluteRoot('output') },
    {
      name: 'control',
      kind: 'control' as const,
      absolutePath: path.join(absoluteRoot('output'), '.meta-mover'),
    },
  ];

  beforeEach(async () => {
    resourcesRoot = await mkdtemp(path.join(tmpdir(), 'meta-mover-helper-client-'));
    const target = electronTarget();
    const executableName =
      process.platform === 'win32' ? 'meta-mover-fs-helper.exe' : 'meta-mover-fs-helper';
    executablePath = path.join(resourcesRoot, 'tools', 'fs-helper', target, executableName);
    const brokerName =
      process.platform === 'win32' ? 'meta-mover-launch-broker.exe' : 'meta-mover-launch-broker';
    brokerPath = path.join(resourcesRoot, 'tools', 'launch-broker', target, brokerName);
    manifestPath = path.join(resourcesRoot, 'tools', 'manifest.json');
    await mkdir(path.dirname(executablePath), { recursive: true });
    await mkdir(path.dirname(brokerPath), { recursive: true });
    await writeFile(executablePath, 'native-helper-fixture');
    await writeFile(brokerPath, 'native-launch-broker-fixture');
    await chmod(executablePath, 0o755);
    await chmod(brokerPath, 0o755);
    const sha256 = createHash('sha256')
      .update(await readFile(executablePath))
      .digest('hex');
    const brokerSha256 = createHash('sha256')
      .update(await readFile(brokerPath))
      .digest('hex');
    const baseTools = [
      {
        name: 'exiftool',
        path: process.platform === 'win32' ? 'exiftool/exiftool.exe' : 'exiftool/exiftool',
        version: '13.33',
        sha256: 'b'.repeat(64),
        ...(process.platform === 'win32'
          ? {}
          : {
              supportDirectory: {
                path: 'exiftool/lib',
                sha256: 'c'.repeat(64),
                fileCount: 1,
              },
            }),
      },
      {
        name: 'fs-helper',
        path: path
          .relative(path.join(resourcesRoot, 'tools'), executablePath)
          .split(path.sep)
          .join('/'),
        version: '0.1.0',
        sha256,
        target,
        protocolVersion: 1,
        buildVersion: '0.1.0',
      },
      {
        name: 'launch-broker',
        path: path
          .relative(path.join(resourcesRoot, 'tools'), brokerPath)
          .split(path.sep)
          .join('/'),
        version: '0.1.0',
        sha256: brokerSha256,
        target,
        rustTarget: rustTarget(),
        buildVersion: '0.1.0',
        helperSha256: sha256,
        helperProtocolVersion: 1,
        helperBuildVersion: '0.1.0',
        releaseSigner: null,
      },
      ...(process.platform === 'win32'
        ? []
        : [
            {
              name: 'perl',
              path: 'perl/bin/perl',
              version: '5.40.2',
              sha256: 'd'.repeat(64),
            },
          ]),
    ];
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 3,
        platform: process.platform,
        arch: process.arch,
        tools: baseTools,
        ...(process.platform === 'win32'
          ? {}
          : { perlLibs: [{ path: 'perl/lib', sha256: 'e'.repeat(64), fileCount: 1 }] }),
        runtimeCompatibility: {
          platform: process.platform,
          arch: process.arch,
          nativePlatformOnly: true,
          inspectedTool: process.platform === 'win32' ? 'exiftool' : 'perl',
          binaryFormat: process.platform === 'win32' ? 'PE' : 'ELF',
          loader: process.platform === 'win32' ? 'PE loader' : 'static',
          sharedLibraries: ['static'],
        },
      })
    );
    launcher = new FakeLauncher(
      new FakeHelperProcess(),
      new FakeBrokerIdentityProcess({
        brokerBuild: '0.1.0',
        brokerTarget: rustTarget(),
        helperSha256: sha256,
        helperProtocol: 1,
        helperBuild: '0.1.0',
        helperTarget: target,
        releaseSigner: null,
      })
    );
  });

  afterEach(async () => {
    await rm(resourcesRoot, { recursive: true, force: true });
  });

  function openClient(
    options: {
      idGenerator?: () => string;
      maxStderrBytes?: number;
      shutdownTimeoutMs?: number;
      handshakeTimeoutMs?: number;
      launchLeaseProvider?: VerifiedHelperLaunchLeaseProvider;
    } = {}
  ) {
    let index = 0;
    return NativeFilesystemHelperClient.open({
      resourcesRoot,
      roots,
      launcher,
      launchTrustPolicy: developmentBrokerLaunchTrustPolicy(options.launchLeaseProvider),
      isPackaged: false,
      idGenerator: options.idGenerator ?? (() => IDS[index++]),
      ...(options.maxStderrBytes === undefined ? {} : { maxStderrBytes: options.maxStderrBytes }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    });
  }

  const trustDescriptor = (
    manifestPath: string,
    canonicalPath = manifestPath
  ): VerifiedHelperLaunchDescriptor => ({
    canonicalPath,
    manifestPath,
    platform: 'linux',
    architecture: 'x64',
    electronTarget: 'linux-x64',
    sha256: SHA256,
    protocolVersion: 1,
    buildVersion: '0.1.0',
    helperSha256: SHA256,
    helperBuildVersion: '0.1.0',
    releaseSigner: null,
    verifiedFileDescriptor: 42,
  });

  const linuxTrustSystem = (options: {
    canonical?: Readonly<Record<string, string>>;
    writablePath?: string;
    symlinkPath?: string;
    filePaths?: readonly string[];
    directoryEntries?: Readonly<Record<string, readonly string[]>>;
    mountInfo?: string;
    currentUid?: number | null;
  }): LinuxBrokerLaunchTrustSystem => ({
    canonicalPath: async (candidate) => options.canonical?.[candidate] ?? candidate,
    pathState: async (candidate) => {
      const final =
        candidate.endsWith('meta-mover-launch-broker') ||
        candidate.endsWith('.AppImage') ||
        options.filePaths?.includes(candidate) === true;
      return {
        dev: 1,
        ino: candidate === '/proc/self/fd/1023' || candidate === '/tmp/.mount_meta' ? 1023 : 1,
        uid: 0,
        mode:
          candidate === options.writablePath
            ? final
              ? 0o100577
              : 0o40577
            : final
              ? 0o100555
              : 0o40555,
        isDirectory: () => !final,
        isFile: () => final,
        isSymbolicLink: () => candidate === options.symlinkPath,
      };
    },
    followedPathState: async (candidate) => ({
      dev: 1,
      ino: candidate === '/proc/self/fd/1023' ? 1023 : 1,
      uid: 0,
      mode: 0o40555,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    }),
    directoryEntries: async (candidate) => options.directoryEntries?.[candidate] ?? [],
    mountInfo: async () => options.mountInfo ?? '',
    currentUid: () => (options.currentUid === null ? undefined : (options.currentUid ?? 1000)),
  });

  it('requires an explicit trust policy and rejects development trust when packaged', async () => {
    await expect(
      NativeFilesystemHelperClient.open({ resourcesRoot, roots, launcher })
    ).rejects.toThrow(/explicit.*trust policy/i);
    await expect(
      NativeFilesystemHelperClient.open({
        resourcesRoot,
        roots,
        launcher,
        launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
        isPackaged: true,
      })
    ).rejects.toThrow(/packaged.*development/i);
    await expect(
      NativeFilesystemHelperClient.open({
        resourcesRoot,
        roots,
        launcher,
        launchTrustPolicy: {
          mode: 'production',
          attestedPlatform: 'darwin',
          acquire: async () => {
            throw new Error('wrong-platform policy must not run');
          },
        },
        isPackaged: true,
      })
    ).rejects.toThrow(/explicit.*trust policy/i);
    expect(launcher.launches).toHaveLength(0);
  });

  it('attests only a root-owned non-writable Linux system install chain', async () => {
    const manifestPath =
      '/opt/meta-mover/resources/tools/launch-broker/linux-x64/meta-mover-launch-broker';
    const policy = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      linuxTrustSystem({})
    );

    await expect(policy.acquire(trustDescriptor(manifestPath))).resolves.toMatchObject({
      mechanism: 'authenticated-package',
      executablePath: '/proc/self/fd/3',
      inheritedFileDescriptor: 42,
      authority: 'linux-root-owned:/opt',
    });

    const writable = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      linuxTrustSystem({ writablePath: '/opt/meta-mover/resources' })
    );
    await expect(writable.acquire(trustDescriptor(manifestPath))).rejects.toThrow(
      /root-owned|protected/i
    );

    const linked = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      linuxTrustSystem({ symlinkPath: '/opt/meta-mover/resources/tools/launch-broker' })
    );
    await expect(linked.acquire(trustDescriptor(manifestPath))).rejects.toThrow(/symlink/i);

    const toolsRoot = '/opt/meta-mover/resources/tools';
    const writableRuntime = path.join(toolsRoot, 'exiftool', 'exiftool');
    const nestedWritable = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      linuxTrustSystem({
        writablePath: writableRuntime,
        filePaths: [writableRuntime],
        directoryEntries: {
          [toolsRoot]: ['exiftool'],
          [path.join(toolsRoot, 'exiftool')]: ['exiftool'],
        },
      })
    );
    await expect(nestedWritable.acquire(trustDescriptor(manifestPath))).rejects.toThrow(
      /root-owned|protected/i
    );

    const elevated = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      linuxTrustSystem({ currentUid: 0 })
    );
    await expect(elevated.acquire(trustDescriptor(manifestPath))).rejects.toThrow(/root token/i);

    const unknownToken = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      linuxTrustSystem({ currentUid: null })
    );
    await expect(unknownToken.acquire(trustDescriptor(manifestPath))).rejects.toThrow(
      /root token/i
    );
  });

  it('shares one successful full-tree scan across repeated and concurrent acquires', async () => {
    const manifestPath =
      '/opt/meta-mover/resources/tools/launch-broker/linux-x64/meta-mover-launch-broker';
    const directoryEntries = jest.fn(async () => [] as string[]);
    const policy = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      { ...linuxTrustSystem({}), directoryEntries }
    );

    await expect(
      Promise.all([
        policy.acquire(trustDescriptor(manifestPath)),
        policy.acquire(trustDescriptor(manifestPath)),
      ])
    ).resolves.toHaveLength(2);
    await expect(policy.acquire(trustDescriptor(manifestPath))).resolves.toMatchObject({
      authority: 'linux-root-owned:/opt',
    });
    expect(directoryEntries).toHaveBeenCalledTimes(1);
  });

  it('evicts a shared failed tree scan and reacquires without retaining a rejection', async () => {
    const manifestPath =
      '/opt/meta-mover/resources/tools/launch-broker/linux-x64/meta-mover-launch-broker';
    let rejectScan = true;
    const directoryEntries = jest.fn(async () => {
      if (rejectScan) throw new Error('injected package tree scan failure');
      return [] as string[];
    });
    const policy = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'system-root' },
      { ...linuxTrustSystem({}), directoryEntries }
    );

    const failed = await Promise.allSettled([
      policy.acquire(trustDescriptor(manifestPath)),
      policy.acquire(trustDescriptor(manifestPath)),
    ]);
    expect(failed).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(directoryEntries).toHaveBeenCalledTimes(1);

    rejectScan = false;
    await expect(policy.acquire(trustDescriptor(manifestPath))).resolves.toMatchObject({
      authority: 'linux-root-owned:/opt',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(directoryEntries).toHaveBeenCalledTimes(2);
  });

  it('fails closed when packaged resources are a writable development tree', async () => {
    await expect(
      NativeFilesystemHelperClient.open({
        resourcesRoot,
        roots,
        launcher,
        launchTrustPolicy: new LinuxImmutableBrokerLaunchTrustPolicy(),
        isPackaged: true,
      })
    ).rejects.toThrow(/system install root/i);
    expect(launcher.launches).toHaveLength(0);
  });

  it('attests AppImage only with a protected outer image and matching read-only inherited mount', async () => {
    const outerImage = '/opt/meta-mover.AppImage';
    const mountRoot = '/tmp/.mount_meta';
    const manifestPath = `${mountRoot}/resources/tools/launch-broker/linux-x64/meta-mover-launch-broker`;
    const mountInfo = `36 25 0:32 / ${mountRoot} ro,nosuid - fuse.AppImage ${outerImage} ro`;
    const canonical = { '/proc/self/fd/1023': mountRoot };
    const policy = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'appimage', outerImagePath: outerImage },
      linuxTrustSystem({ canonical, mountInfo })
    );

    await expect(policy.acquire(trustDescriptor(manifestPath))).resolves.toMatchObject({
      authority: `linux-appimage-ro:${outerImage}`,
      executablePath: '/proc/self/fd/3',
      inheritedFileDescriptor: 42,
    });

    const writableOuter = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'appimage', outerImagePath: outerImage },
      linuxTrustSystem({ canonical, mountInfo, writablePath: outerImage })
    );
    await expect(writableOuter.acquire(trustDescriptor(manifestPath))).rejects.toThrow(
      /root-owned|protected/i
    );

    const writableMount = new LinuxImmutableBrokerLaunchTrustPolicy(
      { kind: 'appimage', outerImagePath: outerImage },
      linuxTrustSystem({
        canonical,
        mountInfo: `36 25 0:32 / ${mountRoot} rw,nosuid - fuse.AppImage ${outerImage} rw`,
      })
    );
    await expect(writableMount.acquire(trustDescriptor(manifestPath))).rejects.toThrow(
      /read-only/i
    );

    await expect(
      policy.acquire(trustDescriptor('/tmp/other/resources/meta-mover-launch-broker'))
    ).rejects.toThrow(/outside.*mount/i);
  });

  it('verifies the packaged target then launches private stdio and binds roots once', async () => {
    const client = await openClient();

    expect(launcher.launches).toHaveLength(2);
    expect(launcher.launches.map((launch) => launch.args)).toEqual([['--identity'], ['--stdio']]);
    for (const launch of launcher.launches) {
      expect(launch).toEqual({
        executablePath: '/proc/self/fd/3',
        args: launch.args,
        options: {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe', expect.any(Number)],
          windowsHide: true,
          cwd: path.join(resourcesRoot, 'tools'),
          env: {
            LANG: 'C',
            LC_ALL: 'C',
            PATH: '',
          },
        },
      });
    }
    expect(launcher.launches.map((launch) => launch.executablePath)).not.toContain(executablePath);
    expect(launcher.launches.map((launch) => launch.executablePath)).not.toContain(brokerPath);
    expect(launcher.process.writes.map((request) => request.op)).toEqual(['hello', 'bind_roots']);
    expect(launcher.process.writes[1]).toEqual({ v: 1, id: IDS[1], op: 'bind_roots', roots });
    expect(JSON.stringify(launcher.process.writes.slice(2))).not.toContain('/media/');
    for (const launch of launcher.launches) {
      const inheritedFd = launch.options.stdio[3];
      expect(typeof inheritedFd).toBe('number');
      expect(() => fstatSync(inheritedFd as number)).toThrow();
    }
    await client.close();
  });

  it('accepts an explicit authenticated package lease and releases it after spawn', async () => {
    const release = jest.fn(async () => undefined);
    const provider: VerifiedHelperLaunchLeaseProvider = {
      acquire: jest.fn(async (descriptor) => ({
        mechanism: 'authenticated-package',
        executablePath: descriptor.canonicalPath,
        authority: 'runtime-health:test-signature',
        release,
      })),
    };

    const client = await openClient({ launchLeaseProvider: provider });

    expect(provider.acquire).toHaveBeenCalledTimes(2);
    expect(provider.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalPath: brokerPath,
        electronTarget: electronTarget(),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        protocolVersion: 1,
        verifiedFileDescriptor: expect.any(Number),
      })
    );
    expect(launcher.launches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executablePath: brokerPath,
          args: ['--identity'],
          options: expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
        }),
        expect.objectContaining({
          executablePath: brokerPath,
          args: ['--stdio'],
          options: expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
        }),
      ])
    );
    expect(release).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it('closes the verified descriptor and child when a valid lease release throws synchronously', async () => {
    let verifiedFileDescriptor = -1;
    const provider: VerifiedHelperLaunchLeaseProvider = {
      acquire: jest.fn(async (descriptor) => {
        verifiedFileDescriptor = descriptor.verifiedFileDescriptor;
        return {
          mechanism: 'authenticated-package',
          executablePath: descriptor.canonicalPath,
          authority: 'runtime-health:test-signature',
          release: (() => {
            throw new Error('lease release failed');
          }) as () => Promise<void>,
        };
      }),
    };

    try {
      await expect(openClient({ launchLeaseProvider: provider })).rejects.toThrow(
        /boundary release/i
      );
      expect(launcher.identityProcess.terminated).toBe(true);
      expect(() => fstatSync(verifiedFileDescriptor)).toThrow();
    } finally {
      try {
        fstatSync(verifiedFileDescriptor);
        closeSync(verifiedFileDescriptor);
      } catch {
        // The passing path already closed the descriptor.
      }
    }
  });

  it('observes a child error emitted immediately after spawn before awaiting lease release', async () => {
    launcher.errorAfterLaunch = new Error('fd3 execution failed');

    await expect(openClient()).rejects.toMatchObject({
      code: 'helper-disconnected',
      outcome: 'unknown',
      message: expect.stringContaining('fd3 execution failed'),
    });
    expect(launcher.process.terminated).toBe(true);
  });

  it.each([
    ['unknown mechanism', { mechanism: 'path-only' }],
    ['wrong executable', { executablePath: 'wrong' }],
    ['empty authority', { authority: '' }],
    ['unknown key', { extra: true }],
  ])('releases a launch lease rejected for %s', async (_label, invalid) => {
    let verifiedFileDescriptor = -1;
    const release = jest.fn(async () => undefined);
    const provider: VerifiedHelperLaunchLeaseProvider = {
      acquire: jest.fn(async (descriptor) => {
        verifiedFileDescriptor = descriptor.verifiedFileDescriptor;
        const lease = {
          mechanism: 'authenticated-package',
          executablePath: descriptor.canonicalPath,
          authority: 'runtime-health:test-signature',
          release,
        };
        return {
          ...lease,
          ...invalid,
          ...(invalid.executablePath === 'wrong'
            ? { executablePath: `${descriptor.canonicalPath}.wrong` }
            : {}),
        } as never;
      }),
    };

    await expect(openClient({ launchLeaseProvider: provider })).rejects.toThrow(/lease/i);
    expect(launcher.launches).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(() => fstatSync(verifiedFileDescriptor)).toThrow();
  });

  it('captures every real child stream error and force-terminates only that child', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)",
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ) as ChildProcessWithoutNullStreams;
    const port = new DefaultHelperProcessPort(child);
    const observed: string[] = [];
    const remove = port.onError((error) => observed.push(error.message));
    try {
      await once(child.stdout, 'data');
      child.stdin.emit('error', new Error('stdin failure'));
      child.stdout.emit('error', new Error('stdout failure'));
      child.stderr.emit('error', new Error('stderr failure'));
      expect(observed).toEqual(['stdin failure', 'stdout failure', 'stderr failure']);

      port.terminate(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      const exited = once(child, 'exit');
      port.terminate(true);
      const [code, signal] = await exited;
      expect(code).toBeNull();
      expect(signal).toBe('SIGKILL');
    } finally {
      remove();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  it('reports real spawn-failure close as process lifecycle completion', async () => {
    const child = spawn(path.join(resourcesRoot, 'missing-launch-broker'), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const port = new DefaultHelperProcessPort(child);
    const errors: Error[] = [];
    let lifecycle: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const removeError = port.onError((error) => errors.push(error));
    const removeExit = port.onExit((code, signal) => {
      lifecycle = { code, signal };
    });
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));

    await closed;

    expect(errors).toEqual([expect.objectContaining({ code: 'ENOENT' })]);
    expect(lifecycle).toEqual({ code: expect.any(Number), signal: null });
    removeError();
    removeExit();
  });

  it('rejects a real broker identity spawn failure and releases every launch boundary', async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let verifiedFileDescriptor = -1;
    const release = jest.fn(async () => undefined);
    const provider: VerifiedHelperLaunchLeaseProvider = {
      acquire: jest.fn(async (descriptor) => {
        verifiedFileDescriptor = descriptor.verifiedFileDescriptor;
        return {
          mechanism: 'authenticated-package',
          executablePath: descriptor.canonicalPath,
          authority: 'runtime-health:test-signature',
          release,
        };
      }),
    };
    const failingLauncher: NativeFilesystemHelperLauncher = {
      launch: (_executablePath, args) => {
        if (!args.includes('--identity')) throw new Error('Helper relay must not launch');
        child = spawn(path.join(resourcesRoot, 'missing-launch-broker'), [], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams;
        return new DefaultHelperProcessPort(child);
      },
    };

    await expect(
      NativeFilesystemHelperClient.open({
        resourcesRoot,
        roots,
        launcher: failingLauncher,
        launchTrustPolicy: developmentBrokerLaunchTrustPolicy(provider),
        isPackaged: false,
        handshakeTimeoutMs: 1_000,
      })
    ).rejects.toThrow(/identity.*ENOENT/i);

    expect(release).toHaveBeenCalledTimes(1);
    expect(() => fstatSync(verifiedFileDescriptor)).toThrow();
    expect(child).toBeDefined();
    expect(child?.listenerCount('error')).toBe(0);
    expect(child?.listenerCount('close')).toBe(0);
    expect(child?.stdin.listenerCount('error')).toBe(0);
    expect(child?.stdout.listenerCount('error')).toBe(0);
    expect(child?.stderr.listenerCount('error')).toBe(0);
  });

  it.each([
    ['helper digest', async () => writeFile(executablePath, 'tampered')],
    ['broker digest', async () => writeFile(brokerPath, 'tampered')],
    [
      'schema',
      async () => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.schemaVersion = 2;
        await writeFile(manifestPath, JSON.stringify(manifest));
      },
    ],
    [
      'helper target',
      async () => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.tools.find((tool: { name: string }) => tool.name === 'fs-helper').target =
          'darwin-arm64';
        await writeFile(manifestPath, JSON.stringify(manifest));
      },
    ],
    [
      'duplicate broker',
      async () => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.tools.push(
          manifest.tools.find((tool: { name: string }) => tool.name === 'launch-broker')
        );
        await writeFile(manifestPath, JSON.stringify(manifest));
      },
    ],
    [
      'broker/helper hash binding',
      async () => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.tools.find(
          (tool: { name: string }) => tool.name === 'launch-broker'
        ).helperSha256 = 'f'.repeat(64);
        await writeFile(manifestPath, JSON.stringify(manifest));
      },
    ],
    [
      'unknown inventory entry',
      async () => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.tools.push({
          name: 'ambient-helper',
          path: 'ambient/helper',
          version: '1',
          sha256: 'f'.repeat(64),
        });
        await writeFile(manifestPath, JSON.stringify(manifest));
      },
    ],
  ])('rejects a packaged runtime with an invalid %s before launch', async (_label, mutate) => {
    await mutate();

    await expect(openClient()).rejects.toThrow(/digest|target|duplicate|manifest|schema|exactly/i);
    expect(launcher.launches).toHaveLength(0);
  });

  it.each([
    ['broker build', { brokerBuild: '9.9.9' }],
    ['broker target', { brokerTarget: 'aarch64-unknown-linux-gnu' }],
    ['helper digest', { helperSha256: 'f'.repeat(64) }],
    ['helper protocol', { helperProtocol: 2 }],
    ['helper build', { helperBuild: '9.9.9' }],
    ['helper target', { helperTarget: 'darwin-arm64' }],
    ['release signer', { releaseSigner: 'unexpected signer' }],
    ['unknown identity key', { extra: true }],
  ])('terminates and rejects broker identity mismatch: %s', async (_label, mutation) => {
    launcher.identityProcess.identity = {
      ...launcher.identityProcess.identity,
      ...mutation,
    };

    await expect(openClient()).rejects.toThrow(/broker|identity|target|manifest/i);
    expect(launcher.identityProcess.terminated).toBe(true);
    expect(launcher.launches.map((launch) => launch.args)).toEqual([['--identity']]);
  });

  it('caps broker identity output before allocation and waits for observed exit after escalation', async () => {
    launcher.identityProcess.autoExit = false;
    launcher.identityProcess.rawOutput = Buffer.alloc(65_537, 0x78);
    let settled = false;
    const pending = openClient({ handshakeTimeoutMs: 5 }).finally(() => {
      settled = true;
    });

    await waitForCondition(
      () => launcher.identityProcess.terminations.includes(false),
      'Expected broker identity probe to request graceful termination'
    );
    launcher.identityProcess.emitStdout(Buffer.alloc(1024 * 1024, 0x79));
    await waitForCondition(
      () => launcher.identityProcess.terminations.includes(true),
      'Expected broker identity probe to escalate termination'
    );
    expect(settled).toBe(false);

    launcher.identityProcess.emitExit(null, 'SIGKILL');
    await expect(pending).rejects.toThrow(/identity output.*65536/i);
  });

  it('uses one identity timeout budget and rejects only after the broker exit is observed', async () => {
    launcher.identityProcess.autoExit = false;
    launcher.identityProcess.rawOutput = Buffer.alloc(0);
    let settled = false;
    const startedAt = Date.now();
    const pending = openClient({ handshakeTimeoutMs: 5 }).finally(() => {
      settled = true;
    });

    await waitForCondition(
      () => launcher.identityProcess.terminations.includes(false),
      'Expected broker identity timeout to request graceful termination'
    );
    await waitForCondition(
      () => launcher.identityProcess.terminations.includes(true),
      'Expected broker identity timeout to escalate termination'
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(settled).toBe(false);

    launcher.identityProcess.emitExit(null, 'SIGKILL');
    await expect(pending).rejects.toThrow(/identity timed out/i);
  });

  it('observes broker identity rejection while an asynchronous lease release is pending', async () => {
    launcher.identityProcess.identity = {
      ...launcher.identityProcess.identity,
      helperSha256: 'f'.repeat(64),
    };
    let releaseBoundary!: () => void;
    const releasePending = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    const provider: VerifiedHelperLaunchLeaseProvider = {
      acquire: jest.fn(async (descriptor) => ({
        mechanism: 'authenticated-package',
        executablePath: descriptor.canonicalPath,
        authority: 'runtime-health:test-signature',
        release: () => releasePending,
      })),
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.prependListener('unhandledRejection', onUnhandled);
    let pending: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;

    try {
      pending = openClient({ launchLeaseProvider: provider }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      releaseBoundary();
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Expected broker identity rejection');
      expect(outcome.error).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/identity|manifest/i) })
      );
    } finally {
      releaseBoundary?.();
      await pending;
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it.each([
    ['empty roots', []],
    ['duplicate root names', [roots[0], { ...roots[1], name: roots[0].name }]],
    ['invalid root kind', [{ ...roots[0], kind: 'cache' }]],
    ['relative root path', [{ ...roots[0], absolutePath: 'relative/input' }]],
  ])('rejects %s before launching the helper', async (_label, invalidRoots) => {
    await expect(
      NativeFilesystemHelperClient.open({
        resourcesRoot,
        roots: invalidRoots as never,
        launcher,
      })
    ).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    expect(launcher.launches).toHaveLength(0);
  });

  it('rejects unsupported targets, relative resources, and invalid diagnostic bounds', async () => {
    await expect(
      NativeFilesystemHelperClient.open({
        resourcesRoot: 'relative/resources',
        roots,
        launcher,
        launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
        isPackaged: false,
      })
    ).rejects.toThrow(/absolute/i);
    await expect(
      NativeFilesystemHelperClient.open({
        resourcesRoot,
        roots,
        launcher,
        platform: 'aix',
        architecture: 'ppc64',
        launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
        isPackaged: false,
      })
    ).rejects.toThrow(/target|manifest/i);
    await expect(openClient({ maxStderrBytes: 0 })).rejects.toThrow(/maxStderrBytes/);
    expect(launcher.launches).toHaveLength(0);
  });

  it.each([
    ['unknown manifest key', (manifest: Record<string, unknown>) => (manifest.extra = true)],
    ['missing tools array', (manifest: Record<string, unknown>) => (manifest.tools = 'invalid')],
    [
      'wrong protocol version',
      (manifest: Record<string, unknown>) =>
        ((manifest.tools as Array<Record<string, unknown>>).find(
          (tool) => tool.name === 'fs-helper'
        )!.protocolVersion = 2),
    ],
    [
      'wrong helper path',
      (manifest: Record<string, unknown>) =>
        ((manifest.tools as Array<Record<string, unknown>>).find(
          (tool) => tool.name === 'fs-helper'
        )!.path = 'fs-helper/wrong'),
    ],
  ])('rejects a manifest with %s', async (_label, mutate) => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    mutate(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(openClient()).rejects.toThrow(/manifest|path/i);
    expect(launcher.launches).toHaveLength(0);
  });

  it('serializes concurrent operations so only one request is in flight', async () => {
    const client = await openClient();
    launcher.process.autoRespond = false;

    const first = client.ensureDirChain({ root: 'destination', components: ['2026'] });
    const second = client.ensureDirChain({ root: 'destination', components: ['2027'] });
    await waitForWrites(launcher.process, 3);
    expect(launcher.process.writes).toHaveLength(3);

    launcher.process.emitJson(lifecycleResult(launcher.process.writes[2]));
    await first;
    await waitForWrites(launcher.process, 4);
    expect(launcher.process.writes).toHaveLength(4);
    launcher.process.emitJson(lifecycleResult(launcher.process.writes[3]));
    await second;

    launcher.process.autoRespond = true;
    await client.close();
  });

  it('emits every mutating operation with only frozen capability DTO fields', async () => {
    const client = await openClient();
    const source = { root: 'source', components: ['camera', 'IMG_0001.JPG'] };
    const target = { root: 'destination', components: ['2026', 'IMG_0001.JPG'] };

    await client.stageCopy({ source, target, expected: NATIVE_IDENTITY, expectedSha256: SHA256 });
    await client.hardLinkNoReplace({ source, target });
    await client.renameNoReplace({ source, target, expected: NATIVE_IDENTITY });
    await client.removeManagedExact({ path: target, expected: NATIVE_IDENTITY });
    const deletion: DeleteSourceExactResult = await client.deleteSourceExact({
      source,
      expected: NATIVE_IDENTITY,
      expectedSha256: SHA256,
      deleteId: DELETE_ID,
      receipt: RECEIPT,
    });
    expect(deletion.state).toBe('deleted');
    await client.reconcileSourceDelete({
      source,
      expected: NATIVE_IDENTITY,
      expectedSha256: SHA256,
      deleteId: DELETE_ID,
      receipt: RECEIPT,
    });

    expect(launcher.process.writes.slice(2)).toEqual([
      {
        v: 1,
        id: IDS[2],
        op: 'stage_copy',
        source,
        target,
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
      },
      { v: 1, id: IDS[3], op: 'hard_link_no_replace', source, target },
      {
        v: 1,
        id: IDS[4],
        op: 'rename_no_replace',
        source,
        target,
        expected: NATIVE_IDENTITY,
      },
      {
        v: 1,
        id: IDS[5],
        op: 'remove_managed_exact',
        path: target,
        expected: NATIVE_IDENTITY,
      },
      {
        v: 1,
        id: IDS[6],
        op: 'delete_source_exact',
        source,
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
        deleteId: DELETE_ID,
        receipt: RECEIPT,
      },
      {
        v: 1,
        id: IDS[7],
        op: 'reconcile_source_delete',
        source,
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
        deleteId: DELETE_ID,
        receipt: RECEIPT,
      },
    ]);
    expect(JSON.stringify(launcher.process.writes.slice(2))).not.toContain(absoluteRoot('output'));
    await client.close();
  });

  it('keeps the durable delete ID separate from internal transport correlation', async () => {
    const client = await openClient();
    const source = { root: 'source', components: ['incoming', 'photo.jpg'] };

    const result: ReconcileSourceDeleteResult = await client.reconcileSourceDelete({
      source,
      expected: NATIVE_IDENTITY,
      expectedSha256: SHA256,
      deleteId: DELETE_ID,
      receipt: RECEIPT,
    });

    expect(launcher.process.writes[2]).toEqual({
      v: 1,
      id: IDS[2],
      op: 'reconcile_source_delete',
      source,
      expected: NATIVE_IDENTITY,
      expectedSha256: SHA256,
      deleteId: DELETE_ID,
      receipt: RECEIPT,
    });
    expect(launcher.process.writes[2].id).not.toBe(DELETE_ID);
    expect(result).toEqual({
      outcome: 'not-applied',
      state: 'source-retained',
      sourceState: 'expected',
      quarantineState: 'absent',
      receiptState: 'absent',
      deleteId: DELETE_ID,
      durability: { file: 'not-applicable', parents: [] },
    });
    await client.close();
  });

  it.each(['absent', 'replacement-preserved'] as const)(
    'returns the typed deleted state while preserving a %s source observation',
    async (sourceState) => {
      const client = await openClient();
      launcher.process.responseFor = (request) =>
        request.op === 'reconcile_source_delete'
          ? success(request.id, {
              outcome: 'applied',
              state: 'deleted',
              sourceState,
              quarantineState: 'entry-deleted',
              receiptState: 'exact',
              deleteId: request.deleteId,
              durability: { file: 'not-applicable', parents: ['synced', 'synced'] },
            })
          : lifecycleResult(request);

      await expect(
        client.reconcileSourceDelete({
          source: { root: 'source', components: ['incoming', 'photo.jpg'] },
          expected: NATIVE_IDENTITY,
          expectedSha256: SHA256,
          deleteId: DELETE_ID,
          receipt: RECEIPT,
        })
      ).resolves.toEqual({
        outcome: 'applied',
        state: 'deleted',
        sourceState,
        quarantineState: 'entry-deleted',
        receiptState: 'exact',
        deleteId: DELETE_ID,
        durability: { file: 'not-applicable', parents: ['synced', 'synced'] },
      });
      launcher.process.responseFor = lifecycleResult;
      await client.close();
    }
  );

  it.each([
    ['created', 'entry-deleted', 'synced', ['synced', 'synced', 'synced']],
    ['exact', 'entry-deleted', 'not-applicable', ['synced', 'synced']],
    ['exact', 'empty-removed', 'not-applicable', ['synced', 'synced']],
    ['exact', 'absent', 'not-applicable', ['synced']],
  ] as const)(
    'accepts deleted reconciliation with %s receipt and %s quarantine evidence',
    async (receiptState, quarantineState, file, parents) => {
      const client = await openClient();
      launcher.process.responseFor = (request) =>
        success(request.id, {
          outcome: 'applied',
          state: 'deleted',
          sourceState: 'absent',
          quarantineState,
          receiptState,
          deleteId: DELETE_ID,
          durability: { file, parents },
        });

      await expect(
        client.reconcileSourceDelete({
          source: { root: 'source', components: ['incoming', 'photo.jpg'] },
          expected: NATIVE_IDENTITY,
          expectedSha256: SHA256,
          deleteId: DELETE_ID,
          receipt: RECEIPT,
        })
      ).resolves.toMatchObject({ receiptState, quarantineState, durability: { file, parents } });
      launcher.process.responseFor = lifecycleResult;
      await client.close();
    }
  );

  it.each([
    ['non-v4', '00000000-0000-1000-8000-000000000031'],
    ['uppercase', '00000000-0000-4000-8000-00000000003A'],
    ['transport collision', IDS[2]],
  ])('rejects a %s delete ID before transmitting the mutator', async (_label, deleteId) => {
    const client = await openClient();
    const writesBefore = launcher.process.writes.length;

    await expect(
      client.deleteSourceExact({
        source: { root: 'source', components: ['incoming', 'photo.jpg'] },
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
        deleteId,
        receipt: RECEIPT,
      })
    ).rejects.toMatchObject({ code: 'invalid-delete-id', outcome: 'not-applied' });
    expect(launcher.process.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it('rejects a delete receipt outside a control capability before transmission', async () => {
    const client = await openClient();
    const writesBefore = launcher.process.writes.length;

    await expect(
      client.deleteSourceExact({
        source: { root: 'source', components: ['incoming', 'photo.jpg'] },
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
        deleteId: DELETE_ID,
        receipt: { root: 'destination', components: ['delete-receipts', `${DELETE_ID}.json`] },
      })
    ).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    expect(launcher.process.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it('exposes strict capability-relative reconciliation residue on UNKNOWN', async () => {
    const client = await openClient();
    const source = { root: 'source', components: ['incoming', 'photo.jpg'] };
    const quarantine = '.meta-mover-delete-00000000000040008000000000000031';
    launcher.process.responseFor = (request) => ({
      v: 1,
      id: request.id,
      ok: false,
      error: {
        code: 'reconciliation-required',
        phase: 'precondition',
        outcome: 'unknown',
        retryable: false,
        message: 'source deletion requires journal reconciliation',
        details: {
          deleteId: DELETE_ID,
          sourceState: 'absent',
          quarantineState: 'entry-other',
          receiptState: 'absent',
          relativeResidue: {
            source,
            quarantine: { root: 'source', components: ['incoming', quarantine] },
            entry: { root: 'source', components: ['incoming', quarantine, 'entry'] },
            receipt: RECEIPT,
          },
        },
      },
    });

    await expect(
      client.reconcileSourceDelete({
        source,
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
        deleteId: DELETE_ID,
        receipt: RECEIPT,
      })
    ).rejects.toMatchObject({
      code: 'reconciliation-required',
      phase: 'precondition',
      outcome: 'unknown',
      retryable: false,
      details: {
        deleteId: DELETE_ID,
        sourceState: 'absent',
        quarantineState: 'entry-other',
        receiptState: 'absent',
        relativeResidue: {
          source,
          quarantine: { root: 'source', components: ['incoming', quarantine] },
          entry: { root: 'source', components: ['incoming', quarantine, 'entry'] },
          receipt: RECEIPT,
        },
      },
    });
    expect(JSON.stringify(launcher.process.writes[2])).not.toContain(absoluteRoot('input'));
    launcher.process.responseFor = lifecycleResult;
    await client.close();
  });

  it.each([
    [
      'mismatched delete ID',
      {
        outcome: 'not-applied',
        state: 'source-retained',
        sourceState: 'expected',
        quarantineState: 'absent',
        receiptState: 'absent',
        deleteId: IDS[9],
        durability: { file: 'not-applicable', parents: [] },
      },
    ],
    [
      'invalid source-retained durability',
      {
        outcome: 'not-applied',
        state: 'source-retained',
        sourceState: 'expected',
        quarantineState: 'empty-removed',
        receiptState: 'absent',
        deleteId: DELETE_ID,
        durability: { file: 'not-applicable', parents: [] },
      },
    ],
    [
      'invalid deleted state combination',
      {
        outcome: 'applied',
        state: 'deleted',
        sourceState: 'expected',
        quarantineState: 'entry-deleted',
        receiptState: 'exact',
        deleteId: DELETE_ID,
        durability: { file: 'not-applicable', parents: ['synced', 'synced'] },
      },
    ],
    [
      'created receipt without an exact deleted entry',
      {
        outcome: 'applied',
        state: 'deleted',
        sourceState: 'absent',
        quarantineState: 'absent',
        receiptState: 'created',
        deleteId: DELETE_ID,
        durability: { file: 'synced', parents: ['synced'] },
      },
    ],
    [
      'exact receipt with excessive absent-quarantine syncs',
      {
        outcome: 'applied',
        state: 'deleted',
        sourceState: 'absent',
        quarantineState: 'absent',
        receiptState: 'exact',
        deleteId: DELETE_ID,
        durability: { file: 'not-applicable', parents: ['synced', 'synced', 'synced'] },
      },
    ],
  ])('fails closed for a reconciliation result with %s', async (_label, result) => {
    const client = await openClient();
    launcher.process.responseFor = (request) => success(request.id, result);

    await expect(
      client.reconcileSourceDelete({
        source: { root: 'source', components: ['incoming', 'photo.jpg'] },
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
        deleteId: DELETE_ID,
        receipt: RECEIPT,
      })
    ).rejects.toMatchObject({ code: 'helper-protocol', outcome: 'unknown' });
    expect(launcher.process.terminated).toBe(true);
  });

  it('normalizes optional operation evidence without discarding null identities', async () => {
    const client = await openClient();
    launcher.process.responseFor = (request) =>
      success(request.id, {
        outcome: 'applied',
        before: null,
        after: NATIVE_IDENTITY,
        sha256: SHA256,
        durability: { file: 'synced', parents: ['synced'] },
      });

    await expect(
      client.ensureDirChain({ root: 'destination', components: ['2026'] })
    ).resolves.toEqual({
      outcome: 'applied',
      before: null,
      after: NATIVE_IDENTITY,
      sha256: SHA256,
      durability: { file: 'synced', parents: ['synced'] },
    });
    launcher.process.responseFor = lifecycleResult;
    await client.close();
  });

  it('rejects malformed request DTOs before transmitting them', async () => {
    const client = await openClient();
    const writesBefore = launcher.process.writes.length;
    const unsafe = Object.defineProperty({}, 'source', {
      enumerable: true,
      get: () => ({ root: 'source', components: ['file'] }),
    });

    await expect(client.stageCopy(unsafe as never)).rejects.toMatchObject({
      code: 'invalid-request',
      outcome: 'not-applied',
    });
    await expect(
      client.stageCopy({
        source: { root: 'source', components: ['file'] },
        target: { root: 'destination', components: ['file'] },
        expectedSha256: 'ABC',
      })
    ).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    await expect(
      client.removeManagedExact({
        path: { root: 'destination', components: ['file'] },
        expected: INVALID_NATIVE_IDENTITY,
      })
    ).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    await expect(
      client.writeMarkerNew({ root: 'control', components: ['marker'] }, 'bad\0contents')
    ).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    await expect(
      client.writeMarkerNew({ root: 'control', components: ['marker'] }, 'x'.repeat(65_536))
    ).rejects.toMatchObject({ code: 'request-too-large', outcome: 'not-applied' });
    expect(launcher.process.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it('rejects an identity from the wrong native platform before transmission', async () => {
    const client = await openClient();
    const writesBefore = launcher.process.writes.length;

    await expect(
      client.removeManagedExact({
        path: { root: 'destination', components: ['file'] },
        expected: FOREIGN_IDENTITY,
      })
    ).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-applied' });
    expect(launcher.process.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it('rejects a handshake that does not prove every requested root exactly once', async () => {
    launcher.process.responseFor = (request) => {
      const response = lifecycleResult(request);
      if (request.op !== 'bind_roots') return response;
      const result = response.result as { roots: Array<Record<string, unknown>> };
      result.roots = result.roots.map((root) => ({ ...root, name: 'source', kind: 'source' }));
      return response;
    };

    await expect(openClient()).rejects.toThrow(/roots/i);
    expect(launcher.process.terminated).toBe(true);
  });

  it('rejects a bind response carrying identities from another platform', async () => {
    launcher.process.responseFor = (request) => {
      const response = lifecycleResult(request);
      if (request.op !== 'bind_roots') return response;
      const result = response.result as { roots: Array<Record<string, unknown>> };
      result.roots[0].identity = FOREIGN_IDENTITY;
      return response;
    };

    await expect(openClient()).rejects.toThrow(/identity|platform/i);
    expect(launcher.process.terminated).toBe(true);
  });

  it.each([
    ['duplicate keys', `{"v":1,"id":"${IDS[2]}","ok":true,"ok":true,"result":{}}\n`],
    [
      'unknown keys',
      `${JSON.stringify({ ...success(IDS[2], { outcome: 'applied', durability: { file: 'not-applicable', parents: ['synced'] } }), extra: true })}\n`,
    ],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
    ['oversized line', `${' '.repeat(65_536)}\n`],
    ['fractional JSON number', `{"v":1.0,"id":"${IDS[2]}","ok":true,"result":{}}\n`],
    ['trailing JSON data', `${JSON.stringify(success(IDS[2], { outcome: 'applied' }))} true\n`],
    ['unterminated JSON string', `{"v":1,"id":"${IDS[2]}\n`],
    [
      'excessive JSON array',
      `${JSON.stringify({ v: 1, id: IDS[2], ok: true, result: { values: Array(257).fill(1) } })}\n`,
    ],
    [
      'excessive JSON nesting',
      `${JSON.stringify({ v: 1, id: IDS[2], ok: true, result: JSON.parse(`${'['.repeat(17)}0${']'.repeat(17)}`) })}\n`,
    ],
  ])('fails the active request as UNKNOWN for %s protocol output', async (_label, output) => {
    const client = await openClient();
    launcher.process.autoRespond = false;
    const operation = client.ensureDirChain({ root: 'destination', components: ['2026'] });
    await waitForWrites(launcher.process, 3);

    launcher.process.emitStdout(typeof output === 'string' ? Buffer.from(output) : output);

    await expect(operation).rejects.toMatchObject({ outcome: 'unknown', retryable: false });
    expect(launcher.process.terminated).toBe(true);
    await expect(
      client.ensureDirChain({ root: 'destination', components: ['later'] })
    ).rejects.toMatchObject({
      outcome: 'unknown',
    });
  });

  it('rejects mismatched UUID responses and never retries the mutator', async () => {
    const client = await openClient();
    launcher.process.autoRespond = false;
    const operation = client.writeMarkerNew(
      { root: 'control', components: ['guards', 'operation.json'] },
      '{"operation":"one"}'
    );
    await waitForWrites(launcher.process, 3);
    const request = launcher.process.writes[2];

    launcher.process.emitJson(lifecycleResult({ ...request, id: IDS[5] }));

    await expect(operation).rejects.toMatchObject({ code: 'helper-protocol', outcome: 'unknown' });
    expect(launcher.process.writes.filter((entry) => entry.op === 'write_marker_new')).toHaveLength(
      1
    );
  });

  it('preserves a strict helper error response without converting not-applied to UNKNOWN', async () => {
    const client = await openClient();
    launcher.process.responseFor = (request) => ({
      v: 1,
      id: request.id,
      ok: false,
      error: {
        code: 'target-exists',
        phase: 'precondition',
        outcome: 'not-applied',
        retryable: false,
        message: 'target already exists',
      },
    });

    await expect(
      client.ensureDirChain({ root: 'destination', components: ['occupied'] })
    ).rejects.toMatchObject({
      code: 'target-exists',
      phase: 'precondition',
      outcome: 'not-applied',
      retryable: false,
    });
    expect(launcher.process.terminated).toBe(false);
    launcher.process.responseFor = lifecycleResult;
    await client.close();
  });

  it('preserves delete reconciliation-required so the caller can invoke reconciliation', async () => {
    const client = await openClient();
    launcher.process.responseFor = (request) => ({
      v: 1,
      id: request.id,
      ok: false,
      error: {
        code: 'reconciliation-required',
        phase: 'precondition',
        outcome: 'unknown',
        retryable: false,
        message: 'durable delete state requires reconciliation',
      },
    });

    await expect(
      client.deleteSourceExact({
        source: { root: 'source', components: ['incoming', 'photo.jpg'] },
        expected: NATIVE_IDENTITY,
        expectedSha256: SHA256,
        deleteId: DELETE_ID,
        receipt: RECEIPT,
      })
    ).rejects.toMatchObject({
      code: 'reconciliation-required',
      phase: 'precondition',
      outcome: 'unknown',
      retryable: false,
      details: undefined,
    });
    expect(launcher.process.terminated).toBe(false);
    launcher.process.responseFor = lifecycleResult;
    await client.close();
  });

  it.each([
    ['invalid durability', { outcome: 'applied', durability: { file: 'maybe', parents: [] } }],
    [
      'invalid parent receipt',
      { outcome: 'applied', durability: { file: 'synced', parents: ['pending'] } },
    ],
    [
      'invalid result digest',
      { outcome: 'applied', sha256: 'ABC', durability: { file: 'synced', parents: [] } },
    ],
    [
      'invalid result identity',
      {
        outcome: 'applied',
        after: INVALID_NATIVE_IDENTITY,
        durability: { file: 'synced', parents: [] },
      },
    ],
    [
      'foreign-platform result identity',
      {
        outcome: 'applied',
        after: FOREIGN_IDENTITY,
        durability: { file: 'synced', parents: [] },
      },
    ],
    ['missing outcome', { durability: { file: 'synced', parents: [] } }],
    [
      'missing ensure_dir_chain identity',
      { outcome: 'applied', durability: { file: 'synced', parents: ['synced'] } },
    ],
  ])('converts %s in a success response to a fatal protocol UNKNOWN', async (_label, result) => {
    const client = await openClient();
    launcher.process.responseFor = (request) => success(request.id, result);

    await expect(
      client.ensureDirChain({ root: 'destination', components: ['2026'] })
    ).rejects.toMatchObject({ code: 'helper-protocol', outcome: 'unknown', retryable: false });
    expect(launcher.process.terminated).toBe(true);
  });

  it('converts malformed helper errors to protocol UNKNOWN', async () => {
    const client = await openClient();
    launcher.process.responseFor = (request) => ({
      v: 1,
      id: request.id,
      ok: false,
      error: {
        code: 'INVALID CODE',
        phase: 'mutation',
        outcome: 'not-applied',
        retryable: false,
        message: 'invalid error fixture',
      },
    });

    await expect(
      client.ensureDirChain({ root: 'destination', components: ['2026'] })
    ).rejects.toMatchObject({ code: 'helper-protocol', outcome: 'unknown', retryable: false });
  });

  it('marks transmission failure and unexpected process exit as UNKNOWN', async () => {
    const client = await openClient();
    launcher.process.writeFailure = Object.assign(new Error('broken stdin EPIPE'), {
      code: 'EPIPE',
    });
    await expect(
      client.ensureDirChain({ root: 'destination', components: ['write-failure'] })
    ).rejects.toMatchObject({ code: 'helper-disconnected', outcome: 'unknown' });

    expect(launcher.process.terminated).toBe(true);
  });

  it('reports an oversized helper response when stdin EPIPE races the emitted output', async () => {
    const writeError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    launcher.process.writeFailure = writeError;
    launcher.process.outputAfterWriteFailure = Buffer.alloc(65_537, 0x78);

    await expect(openClient()).rejects.toMatchObject({
      code: 'helper-protocol',
      outcome: 'unknown',
      message: expect.stringMatching(/response exceeds 65536-byte line limit/i),
    });
    expect(launcher.process.terminated).toBe(true);
  });

  it('rejects non-v4 and invalid-variant request IDs before transmission', async () => {
    let index = 0;
    const ids = [
      IDS[0],
      IDS[1],
      '00000000-0000-1000-8000-000000000003',
      '00000000-0000-4000-7000-000000000004',
      IDS[2],
    ];
    const client = await openClient({ idGenerator: () => ids[index++] });
    const writesBefore = launcher.process.writes.length;

    for (const component of ['invalid-version', 'invalid-variant']) {
      await expect(
        client.ensureDirChain({ root: 'destination', components: [component] })
      ).rejects.toMatchObject({ code: 'invalid-request-id', outcome: 'not-applied' });
    }
    expect(launcher.process.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it('reports crash and EOF as UNKNOWN with bounded stderr diagnostics', async () => {
    const client = await openClient({ maxStderrBytes: 8 });
    launcher.process.autoRespond = false;
    launcher.process.emitStderr(Buffer.from('0123456789abcdef'));
    const operation = client.ensureDirChain({ root: 'destination', components: ['2026'] });
    await waitForWrites(launcher.process, 3);

    launcher.process.emitEnd();

    await expect(operation).rejects.toMatchObject({
      code: 'helper-disconnected',
      outcome: 'unknown',
      retryable: false,
      stderr: '89abcdef',
      stderrTruncated: true,
    });
  });

  it('accepts a valid response split across stdout chunks', async () => {
    const client = await openClient();
    launcher.process.autoRespond = false;
    launcher.process.emitStderr(Buffer.from('note'));
    const operation = client.ensureDirChain({ root: 'destination', components: ['2026'] });
    await waitForWrites(launcher.process, 3);
    const response = Buffer.from(
      `${JSON.stringify(lifecycleResult(launcher.process.writes[2]))}\n`,
      'utf8'
    );

    launcher.process.emitStdout(response.subarray(0, 12));
    launcher.process.emitStdout(response.subarray(12));

    await expect(operation).resolves.toMatchObject({ outcome: 'applied' });
    launcher.process.autoRespond = true;
    await client.close();
  });

  it('rejects close when the helper exits nonzero after acknowledging close', async () => {
    const client = await openClient();
    launcher.process.autoRespond = false;
    const closing = client.close();
    await waitForWrites(launcher.process, 3);

    launcher.process.emitJson(lifecycleResult(launcher.process.writes[2]));
    launcher.process.emitExit(2, null);

    await expect(closing).rejects.toMatchObject({
      code: 'helper-disconnected',
      outcome: 'unknown',
    });
  });

  it('converts a child-process error into UNKNOWN without leaving work unresolved', async () => {
    const client = await openClient();
    launcher.process.autoRespond = false;
    const operation = client.ensureDirChain({ root: 'destination', components: ['2026'] });
    await waitForWrites(launcher.process, 3);

    launcher.process.emitError(new Error('spawn transport failed'));

    await expect(operation).rejects.toMatchObject({
      code: 'helper-disconnected',
      outcome: 'unknown',
      retryable: false,
      message: expect.stringContaining('spawn transport failed'),
    });
    expect(launcher.process.terminated).toBe(true);
    expect(launcher.process.listenerCount()).toBe(5);
    launcher.process.emitExit(1, null);
    expect(launcher.process.listenerCount()).toBe(0);
  });

  it('bounds acknowledged close and escalates only its owned helper', async () => {
    const client = await openClient({ shutdownTimeoutMs: 5 });
    launcher.process.autoRespond = false;
    const closing = client.close();
    await waitForWrites(launcher.process, 3);
    launcher.process.emitJson(lifecycleResult(launcher.process.writes[2]));

    await expect(closing).rejects.toMatchObject({
      code: 'helper-disconnected',
      outcome: 'unknown',
    });
    expect(launcher.process.terminations).toEqual([false, true]);
    expect(launcher.process.listenerCount()).toBe(0);
  });

  it('distinguishes queued abort from an abort after request transmission', async () => {
    const client = await openClient();
    launcher.process.autoRespond = false;
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = client.ensureDirChain(
      { root: 'destination', components: ['active'] },
      activeController.signal
    );
    const queued = client.ensureDirChain(
      { root: 'destination', components: ['queued'] },
      queuedController.signal
    );
    queuedController.abort('queued cancellation');
    await waitForWrites(launcher.process, 3);

    await expect(queued).rejects.toMatchObject({
      code: 'aborted',
      outcome: 'not-applied',
      retryable: false,
    });
    expect(launcher.process.writes.filter((entry) => entry.op === 'ensure_dir_chain')).toHaveLength(
      1
    );

    activeController.abort('active cancellation');
    await expect(active).rejects.toMatchObject({
      code: 'aborted',
      outcome: 'unknown',
      retryable: false,
    });
    expect(launcher.process.terminated).toBe(true);
  });

  it('removes the abort listener when a request arrives already cancelled', async () => {
    const client = await openClient();
    const controller = new AbortController();
    const addListener = jest.spyOn(controller.signal, 'addEventListener');
    const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
    controller.abort();

    await expect(
      client.ensureDirChain({ root: 'destination', components: ['cancelled'] }, controller.signal)
    ).rejects.toMatchObject({ code: 'aborted', outcome: 'not-applied' });
    expect(addListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    await client.close();
  });

  it('validates capability paths and never sends ambient or unsafe components after bind', async () => {
    const client = await openClient();
    const writesBefore = launcher.process.writes.length;

    await expect(
      client.ensureDirChain({ root: 'destination', components: ['/absolute', '..', 'CON'] })
    ).rejects.toBeInstanceOf(NativeFilesystemHelperClientError);
    await expect(
      client.ensureDirChain({ root: 'missing', components: ['safe'] })
    ).rejects.toMatchObject({ outcome: 'not-applied' });
    expect(launcher.process.writes).toHaveLength(writesBefore);
    await client.close();
  });

  it('drains queued work and closes exactly once while rejecting late admission', async () => {
    const client = await openClient();
    launcher.process.autoRespond = false;
    const operation = client.ensureDirChain({ root: 'destination', components: ['2026'] });
    await waitForWrites(launcher.process, 3);

    const firstClose = client.close();
    const secondClose = client.close();
    expect(secondClose).toBe(firstClose);
    await expect(
      client.ensureDirChain({ root: 'destination', components: ['late'] })
    ).rejects.toMatchObject({
      code: 'client-closed',
      outcome: 'not-applied',
    });
    expect(launcher.process.writes.map((request) => request.op)).not.toContain('close');

    launcher.process.emitJson(lifecycleResult(launcher.process.writes[2]));
    await operation;
    await waitForWrites(launcher.process, 4);
    const closeRequest = launcher.process.writes.find((request) => request.op === 'close');
    expect(closeRequest).toBeDefined();
    launcher.process.emitJson(lifecycleResult(closeRequest!));
    launcher.process.emitExit(0, null);

    await firstClose;
    await client.drain();
    expect(launcher.process.writes.filter((request) => request.op === 'close')).toHaveLength(1);
    expect(launcher.process.inputEnded).toBe(true);
  });
});
