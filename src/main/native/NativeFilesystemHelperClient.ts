import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { access, FileHandle, lstat, open, readFile, readdir, realpath, stat } from 'fs/promises';
import path from 'path';
import { TextDecoder } from 'util';

const PROTOCOL_VERSION = 1 as const;
const MAX_LINE_BYTES = 65_536;
const MAX_JSON_DEPTH = 16;
const MAX_ARRAY_ITEMS = 256;
const DEFAULT_STDERR_BYTES = 65_536;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const IDENTITY_TERMINATION_GRACE_MS = 250;
const BROKEN_PIPE_OUTPUT_GRACE_MS = 250;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL_PATTERN = /^(?:0|-?[1-9][0-9]*)$/;
const ROOT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const REQUIRED_FEATURES = Object.freeze([
  'capability-relative',
  'no-follow',
  'no-replace',
  'sha256',
  'durable-sync',
] as const);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type HelperOperation =
  | 'hello'
  | 'bind_roots'
  | 'ensure_dir_chain'
  | 'stage_copy'
  | 'write_marker_new'
  | 'hard_link_no_replace'
  | 'rename_no_replace'
  | 'remove_managed_exact'
  | 'delete_source_exact'
  | 'reconcile_source_delete'
  | 'close';

export type NativeFilesystemRootKind = 'source' | 'destination' | 'control';

export interface NativeFilesystemRootBinding {
  name: string;
  kind: NativeFilesystemRootKind;
  absolutePath: string;
}

export interface NativeFilesystemCapabilityPath {
  root: string;
  components: string[];
}

export interface UnixNativeIdentity {
  kind: 'unix';
  device: string;
  inode: string;
  links: string;
  size: string;
  mtimeNs: string;
}

export interface WindowsNativeIdentity {
  kind: 'windows';
  volumeSerial: string;
  fileId: string;
  links: string;
  size: string;
  mtimeNs: string;
}

export type NativeFilesystemIdentity = UnixNativeIdentity | WindowsNativeIdentity;

export interface NativeFilesystemDurabilityReceipt {
  file: 'synced' | 'not-applicable';
  parents: 'synced'[];
}

export interface NativeFilesystemOperationResult {
  outcome: 'applied';
  before?: NativeFilesystemIdentity | null;
  after?: NativeFilesystemIdentity | null;
  sha256?: string;
  durability: NativeFilesystemDurabilityReceipt;
}

export interface ReconcileSourceDeleteRetainedResult {
  outcome: 'not-applied';
  state: 'source-retained';
  sourceState: 'expected';
  quarantineState: 'absent' | 'empty-removed';
  receiptState: 'absent';
  deleteId: string;
  durability: NativeFilesystemDurabilityReceipt & { file: 'not-applicable' };
}

export interface ReconcileSourceDeleteDeletedResult {
  outcome: 'applied';
  state: 'deleted';
  sourceState: 'absent' | 'replacement-preserved';
  quarantineState: 'entry-deleted' | 'empty-removed' | 'absent';
  receiptState: 'created' | 'exact';
  deleteId: string;
  durability: NativeFilesystemDurabilityReceipt;
}

export type ReconcileSourceDeleteResult =
  | ReconcileSourceDeleteRetainedResult
  | ReconcileSourceDeleteDeletedResult;

export interface DeleteSourceExactResult {
  outcome: 'applied';
  state: 'deleted';
  sourceState: 'absent';
  quarantineState: 'entry-deleted';
  receiptState: 'created';
  deleteId: string;
  durability: NativeFilesystemDurabilityReceipt & { file: 'synced' };
}

export type ReconcileSourceDeleteFailureSourceState =
  | 'expected'
  | 'absent'
  | 'other'
  | 'special'
  | 'unreadable';

export type ReconcileSourceDeleteFailureQuarantineState =
  | 'absent'
  | 'empty'
  | 'entry-expected'
  | 'entry-other'
  | 'entry-special'
  | 'unexpected-entries'
  | 'special'
  | 'unreadable';

export interface ReconcileSourceDeleteRelativeResidue {
  source: NativeFilesystemCapabilityPath;
  quarantine: NativeFilesystemCapabilityPath;
  entry: NativeFilesystemCapabilityPath;
  receipt: NativeFilesystemCapabilityPath;
}

export interface ReconcileSourceDeleteErrorDetails {
  deleteId: string;
  sourceState: ReconcileSourceDeleteFailureSourceState;
  quarantineState: ReconcileSourceDeleteFailureQuarantineState;
  receiptState: 'absent' | 'exact' | 'other' | 'special' | 'unreadable';
  relativeResidue: ReconcileSourceDeleteRelativeResidue;
}

export type NativeFilesystemHelperErrorPhase =
  | 'validation'
  | 'precondition'
  | 'mutation'
  | 'durability'
  | 'protocol';

export type NativeFilesystemHelperErrorOutcome = 'not-applied' | 'unknown';

export class NativeFilesystemHelperClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly phase: NativeFilesystemHelperErrorPhase,
    public readonly outcome: NativeFilesystemHelperErrorOutcome,
    public readonly retryable: boolean,
    message: string,
    public readonly stderr = '',
    public readonly stderrTruncated = false,
    public readonly details?: ReconcileSourceDeleteErrorDetails
  ) {
    super(message);
    this.name = 'NativeFilesystemHelperClientError';
  }
}

export interface NativeFilesystemHelperLaunchOptions {
  shell: false;
  stdio: readonly ['pipe', 'pipe', 'pipe'] | readonly ['pipe', 'pipe', 'pipe', number];
  windowsHide: true;
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface VerifiedHelperLaunchDescriptor {
  canonicalPath: string;
  manifestPath: string;
  platform: NodeJS.Platform;
  architecture: string;
  electronTarget: string;
  sha256: string;
  protocolVersion: 1;
  buildVersion: string;
  helperSha256: string;
  helperBuildVersion: string;
  releaseSigner: string | null;
  verifiedFileDescriptor: number;
}

export interface VerifiedHelperLaunchLease {
  mechanism: 'deny-write-delete' | 'authenticated-package';
  executablePath: string;
  authority: string;
  inheritedFileDescriptor?: number;
  release(): Promise<void>;
}

export interface VerifiedHelperLaunchLeaseProvider {
  acquire(descriptor: Readonly<VerifiedHelperLaunchDescriptor>): Promise<VerifiedHelperLaunchLease>;
}

export interface BrokerLaunchTrustPolicy {
  readonly mode: 'production' | 'development';
  readonly attestedPlatform: NodeJS.Platform | 'development-any';
  acquire(descriptor: Readonly<VerifiedHelperLaunchDescriptor>): Promise<VerifiedHelperLaunchLease>;
}

export interface LinuxBrokerPathState {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface LinuxBrokerLaunchTrustSystem {
  canonicalPath(candidate: string): Promise<string>;
  pathState(candidate: string): Promise<LinuxBrokerPathState>;
  followedPathState(candidate: string): Promise<LinuxBrokerPathState>;
  directoryEntries(candidate: string): Promise<readonly string[]>;
  mountInfo(): Promise<string>;
  currentUid(): number | undefined;
}

export type LinuxBrokerPackageBoundary =
  | { kind: 'system-root' }
  | { kind: 'appimage'; outerImagePath: string; mountDescriptorPath?: string };

export interface NativeFilesystemHelperProcessPort {
  write(data: Buffer): Promise<void>;
  endInput(): void;
  terminate(force?: boolean): void;
  onStdout(listener: (chunk: Buffer) => void): () => void;
  onStderr(listener: (chunk: Buffer) => void): () => void;
  onStdoutEnd(listener: () => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}

export interface NativeFilesystemHelperLauncher {
  launch(
    executablePath: string,
    args: readonly string[],
    options: Readonly<NativeFilesystemHelperLaunchOptions>
  ): NativeFilesystemHelperProcessPort;
}

export interface NativeFilesystemHelperClientOptions {
  resourcesRoot: string;
  roots: readonly NativeFilesystemRootBinding[];
  platform?: NodeJS.Platform;
  architecture?: string;
  launcher?: NativeFilesystemHelperLauncher;
  launchTrustPolicy?: BrokerLaunchTrustPolicy;
  isPackaged?: boolean;
  idGenerator?: () => string;
  maxStderrBytes?: number;
  shutdownTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export interface StageCopyRequest {
  source: NativeFilesystemCapabilityPath;
  target: NativeFilesystemCapabilityPath;
  expected?: NativeFilesystemIdentity;
  expectedSha256?: string;
}

export interface LinkOrRenameRequest {
  source: NativeFilesystemCapabilityPath;
  target: NativeFilesystemCapabilityPath;
  expected?: NativeFilesystemIdentity;
}

export interface RemoveManagedExactRequest {
  path: NativeFilesystemCapabilityPath;
  expected: NativeFilesystemIdentity;
}

export interface DeleteSourceExactRequest {
  source: NativeFilesystemCapabilityPath;
  expected: NativeFilesystemIdentity;
  expectedSha256: string;
  deleteId: string;
  receipt: NativeFilesystemCapabilityPath;
}

export type ReconcileSourceDeleteRequest = DeleteSourceExactRequest;

interface VerifiedHelper {
  executablePath: string;
  manifestPath: string;
  toolsRoot: string;
  electronTarget: string;
  buildVersion: string;
  rustTarget: string;
  helperSha256: string;
  helperBuildVersion: string;
  releaseSigner: string | null;
  identityKind: NativeFilesystemIdentity['kind'];
  platform: NodeJS.Platform;
  architecture: string;
  sha256: string;
  handle: FileHandle;
}

interface AcquiredLaunchLease {
  executablePath: string;
  inheritedFileDescriptor?: number;
  release(): Promise<void>;
}

interface PendingRequest {
  id: string;
  operation: HelperOperation;
  resolve(value: JsonValue): void;
  reject(error: unknown): void;
  removeAbort?: () => void;
  reconciliation?: {
    deleteId: string;
    source: NativeFilesystemCapabilityPath;
    receipt: NativeFilesystemCapabilityPath;
  };
}

interface StrictRecord {
  [key: string]: JsonValue;
}

class LaunchBoundaryReleaseError extends Error {
  constructor(public readonly failures: readonly unknown[]) {
    super('Filesystem helper launch boundary release failed');
    this.name = 'LaunchBoundaryReleaseError';
  }
}

export class DefaultHelperProcessPort implements NativeFilesystemHelperProcessPort {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  endInput(): void {
    this.child.stdin.end();
  }

  terminate(force = false): void {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  }

  onStdout(listener: (chunk: Buffer) => void): () => void {
    this.child.stdout.on('data', listener);
    return () => this.child.stdout.off('data', listener);
  }

  onStderr(listener: (chunk: Buffer) => void): () => void {
    this.child.stderr.on('data', listener);
    return () => this.child.stderr.off('data', listener);
  }

  onStdoutEnd(listener: () => void): () => void {
    this.child.stdout.on('end', listener);
    return () => this.child.stdout.off('end', listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.child.on('close', listener);
    return () => this.child.off('close', listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.child.on('error', listener);
    this.child.stdin.on('error', listener);
    this.child.stdout.on('error', listener);
    this.child.stderr.on('error', listener);
    return () => {
      this.child.off('error', listener);
      this.child.stdin.off('error', listener);
      this.child.stdout.off('error', listener);
      this.child.stderr.off('error', listener);
    };
  }
}

class DefaultHelperLauncher implements NativeFilesystemHelperLauncher {
  launch(
    executablePath: string,
    args: readonly string[],
    options: Readonly<NativeFilesystemHelperLaunchOptions>
  ): NativeFilesystemHelperProcessPort {
    const child = spawn(executablePath, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: options.shell,
      stdio: [...options.stdio],
      windowsHide: options.windowsHide,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      throw new Error('Filesystem helper did not provide private piped stdio');
    }
    return new DefaultHelperProcessPort(child as ChildProcessWithoutNullStreams);
  }
}

function clientError(
  code: string,
  outcome: NativeFilesystemHelperErrorOutcome,
  message: string,
  phase: NativeFilesystemHelperErrorPhase = 'protocol'
): NativeFilesystemHelperClientError {
  return new NativeFilesystemHelperClientError(code, phase, outcome, false, message);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function exactKeys(record: StrictRecord, expected: readonly string[], label: string): void {
  const keys = Object.keys(record);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new Error(`${label} has missing or unknown keys`);
  }
}

function allowedKeys(record: StrictRecord, allowed: readonly string[], label: string): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} has unknown keys`);
  }
}

function strictRecord(value: unknown, label: string): StrictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as StrictRecord;
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
    if (depth > MAX_JSON_DEPTH) throw new Error('JSON nesting exceeds protocol limit');
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
      if (items > MAX_ARRAY_ITEMS) throw new Error('JSON array exceeds protocol limit');
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

function parseStrictJson(bytes: Buffer): JsonValue {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  new StrictJsonScanner(text).scan();
  return JSON.parse(text) as JsonValue;
}

function safeInputRecord(
  value: unknown,
  allowed: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw clientError('invalid-request', 'not-applied', `${label} must be an object`, 'validation');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw clientError(
      'invalid-request',
      'not-applied',
      `${label} must be a plain object`,
      'validation'
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      !allowed.includes(key) ||
      !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')
    ) {
      throw clientError(
        'invalid-request',
        'not-applied',
        `${label} has unsafe or unknown keys`,
        'validation'
      );
    }
    result[key] = descriptors[key].value;
  }
  return result;
}

function validateIdentity(
  value: unknown,
  label: string,
  requiredKind: NativeFilesystemIdentity['kind']
): NativeFilesystemIdentity {
  const record = safeInputRecord(
    value,
    ['kind', 'device', 'inode', 'volumeSerial', 'fileId', 'links', 'size', 'mtimeNs'],
    label
  );
  const kind = record.kind;
  const keys =
    kind === 'unix'
      ? ['kind', 'device', 'inode', 'links', 'size', 'mtimeNs']
      : kind === 'windows'
        ? ['kind', 'volumeSerial', 'fileId', 'links', 'size', 'mtimeNs']
        : [];
  if (
    kind !== requiredKind ||
    keys.length === 0 ||
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record))
  ) {
    throw clientError(
      'invalid-request',
      'not-applied',
      `${label} identity is invalid`,
      'validation'
    );
  }
  for (const key of keys.slice(1)) {
    const pattern = key === 'mtimeNs' ? SIGNED_DECIMAL_PATTERN : DECIMAL_PATTERN;
    if (typeof record[key] !== 'string' || !pattern.test(record[key] as string)) {
      throw clientError(
        'invalid-request',
        'not-applied',
        `${label}.${key} is invalid`,
        'validation'
      );
    }
  }
  return { ...record } as unknown as NativeFilesystemIdentity;
}

function validateResponseIdentity(
  value: JsonValue,
  label: string,
  requiredKind: NativeFilesystemIdentity['kind']
): NativeFilesystemIdentity {
  try {
    return validateIdentity(value, label, requiredKind);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : `${label} is invalid`);
  }
}

function validateSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw clientError(
      'invalid-request',
      'not-applied',
      `${label} must be lowercase SHA-256`,
      'validation'
    );
  }
  return value;
}

function validateDeleteId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw clientError(
      'invalid-delete-id',
      'not-applied',
      'deleteId must be a lowercase canonical UUID v4',
      'validation'
    );
  }
  return value;
}

function validateRootBindings(
  value: readonly NativeFilesystemRootBinding[]
): NativeFilesystemRootBinding[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARRAY_ITEMS) {
    throw clientError(
      'invalid-request',
      'not-applied',
      'roots must contain 1 through 256 entries',
      'validation'
    );
  }
  const names = new Set<string>();
  return value.map((candidate, index) => {
    const record = safeInputRecord(candidate, ['name', 'kind', 'absolutePath'], `roots[${index}]`);
    if (
      typeof record.name !== 'string' ||
      !ROOT_NAME_PATTERN.test(record.name) ||
      names.has(record.name)
    ) {
      throw clientError(
        'invalid-request',
        'not-applied',
        'root names must be unique identifiers',
        'validation'
      );
    }
    if (!['source', 'destination', 'control'].includes(String(record.kind))) {
      throw clientError('invalid-request', 'not-applied', 'root kind is invalid', 'validation');
    }
    if (
      typeof record.absolutePath !== 'string' ||
      record.absolutePath.includes('\0') ||
      !path.isAbsolute(record.absolutePath)
    ) {
      throw clientError(
        'invalid-request',
        'not-applied',
        'root path must be absolute',
        'validation'
      );
    }
    names.add(record.name);
    return {
      name: record.name,
      kind: record.kind as NativeFilesystemRootKind,
      absolutePath: path.normalize(record.absolutePath),
    };
  });
}

function validateCapabilityPath(
  value: NativeFilesystemCapabilityPath,
  boundRoots: ReadonlySet<string>,
  label: string
): NativeFilesystemCapabilityPath {
  const record = safeInputRecord(value, ['root', 'components'], label);
  if (typeof record.root !== 'string' || !boundRoots.has(record.root)) {
    throw clientError('invalid-request', 'not-applied', `${label}.root is not bound`, 'validation');
  }
  if (
    !Array.isArray(record.components) ||
    record.components.length === 0 ||
    record.components.length > 256
  ) {
    throw clientError(
      'invalid-request',
      'not-applied',
      `${label}.components is invalid`,
      'validation'
    );
  }
  const components = record.components.map((component) => {
    if (
      typeof component !== 'string' ||
      component.length === 0 ||
      component.includes('\0') ||
      component === '.' ||
      component === '..' ||
      component.includes('/') ||
      component.includes('\\') ||
      component.includes(':') ||
      component.endsWith('.') ||
      component.endsWith(' ') ||
      WINDOWS_DEVICE_PATTERN.test(component)
    ) {
      throw clientError(
        'invalid-request',
        'not-applied',
        `${label} contains an unsafe component`,
        'validation'
      );
    }
    return component;
  });
  return { root: record.root, components };
}

function electronTarget(platform: NodeJS.Platform, architecture: string): string {
  const supported =
    (platform === 'linux' || platform === 'darwin') && ['x64', 'arm64'].includes(architecture)
      ? true
      : platform === 'win32' && ['x64', 'arm64', 'ia32'].includes(architecture);
  if (!supported)
    throw new Error(`Unsupported filesystem-helper target: ${platform}-${architecture}`);
  return `${platform}-${architecture}`;
}

function validRustTargets(target: string): readonly string[] {
  const targets: Record<string, readonly string[]> = {
    'linux-x64': ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'],
    'linux-arm64': ['aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl'],
    'darwin-x64': ['x86_64-apple-darwin'],
    'darwin-arm64': ['aarch64-apple-darwin'],
    'win32-x64': ['x86_64-pc-windows-msvc'],
    'win32-arm64': ['aarch64-pc-windows-msvc'],
    'win32-ia32': ['i686-pc-windows-msvc'],
  };
  return targets[target] ?? [];
}

async function verifyBundledExecutable(
  toolsRoot: string,
  relativePath: string,
  expectedDigest: string,
  label: string,
  platform: NodeJS.Platform,
  keepOpen: boolean
): Promise<{ executablePath: string; manifestPath: string; sha256: string; handle?: FileHandle }> {
  if (path.isAbsolute(relativePath)) throw new Error(`${label} manifest path must be relative`);
  const candidate = path.resolve(toolsRoot, relativePath);
  if (!isWithin(toolsRoot, candidate)) throw new Error(`${label} escapes application resources`);
  const visibleBefore = await lstat(candidate);
  if (!visibleBefore.isFile() || visibleBefore.isSymbolicLink() || visibleBefore.nlink !== 1) {
    throw new Error(`${label} must be a singly-linked regular file`);
  }
  const canonical = await realpath(candidate);
  if (!isWithin(toolsRoot, canonical)) throw new Error(`${label} escapes application resources`);
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const heldBefore = await handle.stat();
    if (heldBefore.dev !== visibleBefore.dev || heldBefore.ino !== visibleBefore.ino) {
      throw new Error(`${label} identity changed before verification`);
    }
    const bytes = await handle.readFile();
    const digest = createHash('sha256').update(bytes).digest('hex');
    const [heldAfter, visibleAfter] = await Promise.all([handle.stat(), lstat(candidate)]);
    if (
      heldAfter.size !== heldBefore.size ||
      heldAfter.mtimeMs !== heldBefore.mtimeMs ||
      visibleAfter.isSymbolicLink() ||
      !visibleAfter.isFile() ||
      visibleAfter.nlink !== 1 ||
      visibleAfter.dev !== heldBefore.dev ||
      visibleAfter.ino !== heldBefore.ino ||
      visibleAfter.size !== heldBefore.size ||
      visibleAfter.mtimeMs !== heldBefore.mtimeMs
    ) {
      throw new Error(`${label} identity changed during verification`);
    }
    if (digest !== expectedDigest) throw new Error(`${label} digest does not match manifest`);
    if (platform !== 'win32') await access(canonical, constants.X_OK);
    if (!keepOpen) await handle.close();
    return {
      executablePath: canonical,
      sha256: digest,
      manifestPath: candidate,
      ...(keepOpen ? { handle } : {}),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function validateDirectoryManifestEntry(value: JsonValue, label: string): void {
  const entry = strictRecord(value, label);
  exactKeys(entry, ['path', 'sha256', 'fileCount'], label);
  if (
    typeof entry.path !== 'string' ||
    entry.path.length === 0 ||
    path.isAbsolute(entry.path) ||
    typeof entry.sha256 !== 'string' ||
    !SHA256_PATTERN.test(entry.sha256) ||
    !Number.isSafeInteger(entry.fileCount) ||
    Number(entry.fileCount) < 0
  ) {
    throw new Error(`${label} is invalid`);
  }
}

async function verifiedHelper(
  resourcesRoot: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<VerifiedHelper> {
  if (!path.isAbsolute(resourcesRoot))
    throw new Error('Application resources path must be absolute');
  const resources = await lstat(resourcesRoot);
  if (!resources.isDirectory() || resources.isSymbolicLink()) {
    throw new Error('Application resources root must be a regular directory');
  }
  const canonicalResources = await realpath(resourcesRoot);
  const toolsPath = path.join(canonicalResources, 'tools');
  const toolsVisible = await lstat(toolsPath);
  if (!toolsVisible.isDirectory() || toolsVisible.isSymbolicLink()) {
    throw new Error('Bundled tools root must be a regular directory');
  }
  const toolsRoot = await realpath(toolsPath);
  if (!isWithin(canonicalResources, toolsRoot))
    throw new Error('Bundled tools root escapes resources');

  const manifestPath = path.join(toolsRoot, 'manifest.json');
  const manifestVisible = await lstat(manifestPath);
  if (
    !manifestVisible.isFile() ||
    manifestVisible.isSymbolicLink() ||
    manifestVisible.nlink !== 1
  ) {
    throw new Error('Bundled tool manifest must be a singly-linked regular file');
  }
  const manifestHandle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let manifestBytes: Buffer;
  try {
    const held = await manifestHandle.stat();
    if (held.dev !== manifestVisible.dev || held.ino !== manifestVisible.ino) {
      throw new Error('Bundled tool manifest identity changed');
    }
    manifestBytes = await manifestHandle.readFile();
    const after = await manifestHandle.stat();
    if (after.size !== held.size || after.mtimeMs !== held.mtimeMs) {
      throw new Error('Bundled tool manifest changed during read');
    }
  } finally {
    await manifestHandle.close();
  }
  const manifest = strictRecord(parseStrictJson(manifestBytes), 'tool manifest');
  exactKeys(
    manifest,
    platform === 'win32'
      ? ['schemaVersion', 'platform', 'arch', 'tools', 'runtimeCompatibility']
      : ['schemaVersion', 'platform', 'arch', 'tools', 'perlLibs', 'runtimeCompatibility'],
    'tool manifest'
  );
  const target = electronTarget(platform, architecture);
  if (
    manifest.schemaVersion !== 3 ||
    manifest.platform !== platform ||
    manifest.arch !== architecture
  ) {
    throw new Error(`Bundled tool manifest does not match target ${target}`);
  }
  if (!Array.isArray(manifest.tools)) throw new Error('Bundled tool manifest has no tools');
  const requiredNames =
    platform === 'win32'
      ? ['exiftool', 'fs-helper', 'launch-broker']
      : ['exiftool', 'fs-helper', 'launch-broker', 'perl'];
  const entries = new Map<string, StrictRecord>();
  for (const value of manifest.tools) {
    const entry = strictRecord(value, 'tool manifest entry');
    if (
      typeof entry.name !== 'string' ||
      !requiredNames.includes(entry.name) ||
      entries.has(entry.name)
    ) {
      throw new Error('Bundled tool manifest contains an invalid or duplicate tool entry');
    }
    const baseKeys = ['name', 'path', 'version', 'sha256'];
    exactKeys(
      entry,
      entry.name === 'fs-helper'
        ? [...baseKeys, 'target', 'protocolVersion', 'buildVersion']
        : entry.name === 'launch-broker'
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
          : entry.name === 'exiftool' && platform !== 'win32'
            ? [...baseKeys, 'supportDirectory']
            : baseKeys,
      `${entry.name} manifest entry`
    );
    if (
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      path.isAbsolute(entry.path) ||
      typeof entry.version !== 'string' ||
      entry.version.length === 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      throw new Error(`${entry.name} manifest entry is invalid`);
    }
    if (entry.name === 'exiftool' && platform !== 'win32') {
      validateDirectoryManifestEntry(entry.supportDirectory, 'ExifTool support directory');
    }
    entries.set(entry.name, entry);
  }
  if (entries.size !== requiredNames.length || requiredNames.some((name) => !entries.has(name))) {
    throw new Error(`Bundled tool manifest must contain exactly: ${requiredNames.join(', ')}`);
  }
  if (platform !== 'win32') {
    if (!Array.isArray(manifest.perlLibs) || manifest.perlLibs.length === 0) {
      throw new Error('Bundled tool manifest has no Perl library roots');
    }
    manifest.perlLibs.forEach((entry, index) =>
      validateDirectoryManifestEntry(entry, `Perl library entry ${index}`)
    );
  }
  const compatibility = strictRecord(manifest.runtimeCompatibility, 'runtime compatibility');
  exactKeys(
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
    'runtime compatibility'
  );
  if (
    compatibility.platform !== platform ||
    compatibility.arch !== architecture ||
    compatibility.nativePlatformOnly !== true ||
    compatibility.inspectedTool !== (platform === 'win32' ? 'exiftool' : 'perl') ||
    typeof compatibility.binaryFormat !== 'string' ||
    compatibility.binaryFormat.length === 0 ||
    typeof compatibility.loader !== 'string' ||
    compatibility.loader.length === 0 ||
    !Array.isArray(compatibility.sharedLibraries) ||
    compatibility.sharedLibraries.length === 0 ||
    compatibility.sharedLibraries.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new Error('Bundled runtime compatibility evidence is invalid');
  }

  const helper = entries.get('fs-helper')!;
  exactKeys(
    helper,
    ['name', 'path', 'version', 'sha256', 'target', 'protocolVersion', 'buildVersion'],
    'fs-helper manifest entry'
  );
  if (
    helper.name !== 'fs-helper' ||
    helper.target !== target ||
    helper.protocolVersion !== PROTOCOL_VERSION ||
    typeof helper.version !== 'string' ||
    helper.version.length === 0 ||
    typeof helper.buildVersion !== 'string' ||
    helper.buildVersion !== helper.version ||
    typeof helper.sha256 !== 'string' ||
    !SHA256_PATTERN.test(helper.sha256) ||
    typeof helper.path !== 'string' ||
    path.isAbsolute(helper.path)
  ) {
    throw new Error('fs-helper manifest entry is invalid for the current target');
  }
  const executableName = platform === 'win32' ? 'meta-mover-fs-helper.exe' : 'meta-mover-fs-helper';
  const expectedPath = path.posix.join('fs-helper', target, executableName);
  if (helper.path !== expectedPath)
    throw new Error(`fs-helper manifest path must be ${expectedPath}`);
  await verifyBundledExecutable(
    toolsRoot,
    helper.path,
    helper.sha256,
    'fs-helper',
    platform,
    false
  );

  const broker = entries.get('launch-broker')!;
  const brokerExecutableName =
    platform === 'win32' ? 'meta-mover-launch-broker.exe' : 'meta-mover-launch-broker';
  const expectedBrokerPath = path.posix.join('launch-broker', target, brokerExecutableName);
  const releaseSignerValid =
    broker.releaseSigner === null ||
    (typeof broker.releaseSigner === 'string' &&
      broker.releaseSigner.length > 0 &&
      !/[\0\r\n]/.test(broker.releaseSigner));
  if (
    broker.path !== expectedBrokerPath ||
    broker.target !== target ||
    typeof broker.rustTarget !== 'string' ||
    !validRustTargets(target).includes(broker.rustTarget) ||
    typeof broker.buildVersion !== 'string' ||
    broker.buildVersion !== broker.version ||
    broker.helperSha256 !== helper.sha256 ||
    broker.helperProtocolVersion !== helper.protocolVersion ||
    broker.helperBuildVersion !== helper.buildVersion ||
    !releaseSignerValid
  ) {
    throw new Error('Launch broker manifest entry does not match the native filesystem helper');
  }
  const verifiedBroker = await verifyBundledExecutable(
    toolsRoot,
    broker.path,
    broker.sha256 as string,
    'launch-broker',
    platform,
    true
  );
  if (!verifiedBroker.handle) throw new Error('Launch broker verification did not retain a handle');
  return {
    executablePath: verifiedBroker.executablePath,
    manifestPath: verifiedBroker.manifestPath,
    toolsRoot,
    electronTarget: target,
    buildVersion: broker.buildVersion,
    rustTarget: broker.rustTarget,
    helperSha256: helper.sha256,
    helperBuildVersion: helper.buildVersion,
    releaseSigner: broker.releaseSigner as string | null,
    identityKind: platform === 'win32' ? 'windows' : 'unix',
    platform,
    architecture,
    sha256: verifiedBroker.sha256,
    handle: verifiedBroker.handle,
  };
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

async function validateLinuxPackageChain(
  system: LinuxBrokerLaunchTrustSystem,
  boundary: string,
  candidate: string,
  requireRootOwnership: boolean,
  finalKind: 'file' | 'directory' = 'file'
): Promise<void> {
  if (!isWithin(boundary, candidate)) throw new Error('Launch broker escapes trusted package root');
  const relative = path.relative(boundary, candidate);
  const components = relative === '' ? [] : relative.split(path.sep);
  let current = boundary;
  for (let index = 0; index <= components.length; index += 1) {
    if (index > 0) current = path.join(current, components[index - 1]);
    const state = await system.pathState(current);
    const final = index === components.length;
    const expectedKind = final ? finalKind : 'directory';
    if (
      state.isSymbolicLink() ||
      (expectedKind === 'file' ? !state.isFile() : !state.isDirectory())
    ) {
      throw new Error('Launch broker package chain contains a symlink or special entry');
    }
    if (requireRootOwnership && (state.uid !== 0 || (state.mode & 0o022) !== 0)) {
      throw new Error('Launch broker package chain is not root-owned and protected');
    }
  }
}

async function validateLinuxPackageTree(
  system: LinuxBrokerLaunchTrustSystem,
  toolsRoot: string
): Promise<void> {
  const visit = async (candidate: string): Promise<void> => {
    const state = await system.pathState(candidate);
    if (
      state.isSymbolicLink() ||
      (!state.isDirectory() && !state.isFile()) ||
      state.uid !== 0 ||
      (state.mode & 0o022) !== 0
    ) {
      throw new Error('Launch broker package tree is not root-owned and protected');
    }
    if (!state.isDirectory()) return;
    for (const entry of await system.directoryEntries(candidate)) {
      if (entry !== path.basename(entry) || entry === '.' || entry === '..') {
        throw new Error('Launch broker package tree returned an unsafe directory entry');
      }
      await visit(path.join(candidate, entry));
    }
  };
  await visit(toolsRoot);
}

const DEFAULT_LINUX_TRUST_SYSTEM: LinuxBrokerLaunchTrustSystem = {
  canonicalPath: (candidate) => realpath(candidate),
  pathState: (candidate) => lstat(candidate),
  followedPathState: (candidate) => stat(candidate),
  directoryEntries: (candidate) => readdir(candidate),
  mountInfo: () => readFile('/proc/self/mountinfo', 'utf8'),
  currentUid: () => process.geteuid?.(),
};

export class LinuxImmutableBrokerLaunchTrustPolicy implements BrokerLaunchTrustPolicy {
  readonly mode = 'production' as const;
  readonly attestedPlatform = 'linux' as const;
  private readonly protectedSystemTrees = new Map<string, Promise<void>>();

  constructor(
    private readonly boundary: Readonly<LinuxBrokerPackageBoundary> = { kind: 'system-root' },
    private readonly system: LinuxBrokerLaunchTrustSystem = DEFAULT_LINUX_TRUST_SYSTEM
  ) {}

  async acquire(
    descriptor: Readonly<VerifiedHelperLaunchDescriptor>
  ): Promise<VerifiedHelperLaunchLease> {
    if (descriptor.platform !== 'linux') {
      throw new Error('Linux package trust policy cannot attest a non-Linux broker');
    }
    const currentUid = this.system.currentUid();
    if (!Number.isSafeInteger(currentUid) || Number(currentUid) <= 0) {
      throw new Error('Packaged broker cannot run with a package-mutable root token');
    }
    const canonicalManifestPath = await this.system.canonicalPath(descriptor.manifestPath);
    if (canonicalManifestPath !== descriptor.canonicalPath) {
      throw new Error('Launch broker package identity changed before trust attestation');
    }
    const authority =
      this.boundary.kind === 'appimage'
        ? await this.attestAppImage(descriptor, this.boundary)
        : await this.attestSystemRoot(descriptor);
    return {
      mechanism: 'authenticated-package',
      executablePath: '/proc/self/fd/3',
      inheritedFileDescriptor: descriptor.verifiedFileDescriptor,
      authority,
      release: async () => undefined,
    };
  }

  private async attestSystemRoot(
    descriptor: Readonly<VerifiedHelperLaunchDescriptor>
  ): Promise<string> {
    const launchBrokerRoot = path.dirname(path.dirname(descriptor.manifestPath));
    if (path.basename(launchBrokerRoot) !== 'launch-broker') {
      throw new Error('Launch broker is outside the exact packaged tools layout');
    }
    const toolsRoot = path.dirname(launchBrokerRoot);
    const allowedRoot = ['/opt', '/usr/lib'].find(
      (candidate) => isWithin(candidate, toolsRoot) && isWithin(candidate, descriptor.canonicalPath)
    );
    if (!allowedRoot) throw new Error('Launch broker is outside an allowed system install root');
    await validateLinuxPackageChain(this.system, allowedRoot, toolsRoot, true, 'directory');
    await validateLinuxPackageChain(this.system, toolsRoot, descriptor.manifestPath, true);
    let attestation = this.protectedSystemTrees.get(toolsRoot);
    if (!attestation) {
      attestation = validateLinuxPackageTree(this.system, toolsRoot);
      this.protectedSystemTrees.set(toolsRoot, attestation);
    }
    try {
      await attestation;
    } catch (error) {
      if (this.protectedSystemTrees.get(toolsRoot) === attestation) {
        this.protectedSystemTrees.delete(toolsRoot);
      }
      throw error;
    }
    return `linux-root-owned:${allowedRoot}`;
  }

  private async attestAppImage(
    descriptor: Readonly<VerifiedHelperLaunchDescriptor>,
    boundary: Readonly<Extract<LinuxBrokerPackageBoundary, { kind: 'appimage' }>>
  ): Promise<string> {
    if (!path.isAbsolute(boundary.outerImagePath)) {
      throw new Error('Outer AppImage path must be absolute');
    }
    const outerImage = await this.system.canonicalPath(boundary.outerImagePath);
    await validateLinuxPackageChain(this.system, path.parse(outerImage).root, outerImage, true);
    const mountDescriptorPath = boundary.mountDescriptorPath ?? '/proc/self/fd/1023';
    const mountRoot = await this.system.canonicalPath(mountDescriptorPath);
    const [descriptorState, mountState] = await Promise.all([
      this.system.followedPathState(mountDescriptorPath),
      this.system.pathState(mountRoot),
    ]);
    if (
      !descriptorState.isDirectory() ||
      !mountState.isDirectory() ||
      descriptorState.dev !== mountState.dev ||
      descriptorState.ino !== mountState.ino
    ) {
      throw new Error('Inherited AppImage mount descriptor identity does not match its mount root');
    }
    if (!isWithin(mountRoot, descriptor.manifestPath)) {
      throw new Error('Launch broker is outside the inherited AppImage mount');
    }
    const mountRecord = (await this.system.mountInfo())
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(' - ');
        if (separator < 0) return undefined;
        const before = line.slice(0, separator).split(' ');
        const after = line.slice(separator + 3).split(' ');
        if (before.length < 6 || after.length < 3) return undefined;
        return {
          mountPoint: decodeMountInfoPath(before[4]),
          mountOptions: before[5].split(','),
          filesystem: after[0],
          source: decodeMountInfoPath(after[1]),
          superOptions: after[2].split(','),
        };
      })
      .find((entry) => entry?.mountPoint === mountRoot);
    if (
      !mountRecord ||
      !mountRecord.mountOptions.includes('ro') ||
      !mountRecord.superOptions.includes('ro') ||
      mountRecord.source !== outerImage ||
      !['squashfs', 'fuse.AppImage', 'fuse.appimage'].includes(mountRecord.filesystem)
    ) {
      throw new Error('Inherited AppImage mount is not a read-only package filesystem');
    }
    await validateLinuxPackageChain(this.system, mountRoot, descriptor.manifestPath, false);
    return `linux-appimage-ro:${outerImage}`;
  }
}

export function developmentBrokerLaunchTrustPolicy(
  provider?: VerifiedHelperLaunchLeaseProvider
): BrokerLaunchTrustPolicy {
  return {
    mode: 'development',
    attestedPlatform: 'development-any',
    acquire: async (descriptor) => {
      if (provider) return provider.acquire(descriptor);
      if (descriptor.platform !== 'linux') {
        throw new Error('Development broker launch on this target requires an injected lease');
      }
      return {
        mechanism: 'authenticated-package',
        executablePath: '/proc/self/fd/3',
        inheritedFileDescriptor: descriptor.verifiedFileDescriptor,
        authority: 'explicit-untrusted-development',
        release: async () => undefined,
      };
    },
  };
}

async function acquireLaunchLease(
  helper: VerifiedHelper,
  policy: BrokerLaunchTrustPolicy
): Promise<AcquiredLaunchLease> {
  const leaseValue: unknown = await policy.acquire({
    canonicalPath: helper.executablePath,
    manifestPath: helper.manifestPath,
    platform: helper.platform,
    architecture: helper.architecture,
    electronTarget: helper.electronTarget,
    sha256: helper.sha256,
    protocolVersion: PROTOCOL_VERSION,
    buildVersion: helper.buildVersion,
    helperSha256: helper.helperSha256,
    helperBuildVersion: helper.helperBuildVersion,
    releaseSigner: helper.releaseSigner,
    verifiedFileDescriptor: helper.handle.fd,
  });
  const leaseRecord =
    typeof leaseValue === 'object' && leaseValue !== null && !Array.isArray(leaseValue)
      ? (leaseValue as Record<string, unknown>)
      : undefined;
  const release = leaseRecord?.release;
  const inheritedFileDescriptor = leaseRecord?.inheritedFileDescriptor;
  const leaseKeys = Object.keys(leaseRecord ?? {});
  if (
    !leaseRecord ||
    ![4, 5].includes(leaseKeys.length) ||
    !['mechanism', 'executablePath', 'authority', 'release'].every((key) =>
      Object.prototype.hasOwnProperty.call(leaseRecord, key)
    ) ||
    (leaseKeys.length === 5 &&
      !Object.prototype.hasOwnProperty.call(leaseRecord, 'inheritedFileDescriptor')) ||
    (leaseRecord.mechanism !== 'deny-write-delete' &&
      leaseRecord.mechanism !== 'authenticated-package') ||
    (leaseRecord.executablePath !== helper.executablePath &&
      leaseRecord.executablePath !== '/proc/self/fd/3' &&
      leaseRecord.executablePath !== '/dev/fd/3') ||
    (inheritedFileDescriptor !== undefined && inheritedFileDescriptor !== helper.handle.fd) ||
    ((leaseRecord.executablePath === '/proc/self/fd/3' ||
      leaseRecord.executablePath === '/dev/fd/3') &&
      inheritedFileDescriptor !== helper.handle.fd) ||
    typeof leaseRecord.authority !== 'string' ||
    leaseRecord.authority.length === 0 ||
    typeof release !== 'function'
  ) {
    const validationError = new Error('Filesystem helper launch lease is invalid');
    if (typeof release === 'function') {
      try {
        await Reflect.apply(release, leaseValue, []);
      } catch (releaseError) {
        throw new LaunchBoundaryReleaseError([validationError, releaseError]);
      }
    }
    throw validationError;
  }
  return {
    executablePath: leaseRecord.executablePath as string,
    ...(typeof inheritedFileDescriptor === 'number' ? { inheritedFileDescriptor } : {}),
    release: () => Reflect.apply(release, leaseValue, []) as Promise<void>,
  };
}

function brokerEnvironment(platform: NodeJS.Platform): Readonly<Record<string, string>> {
  return {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '',
    ...(platform === 'win32' && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
}

function validateBrokerIdentity(value: JsonValue, helper: VerifiedHelper): void {
  const identity = strictRecord(value, 'launch broker identity');
  exactKeys(
    identity,
    [
      'brokerBuild',
      'brokerTarget',
      'helperSha256',
      'helperProtocol',
      'helperBuild',
      'helperTarget',
      'releaseSigner',
    ],
    'launch broker identity'
  );
  if (
    identity.brokerBuild !== helper.buildVersion ||
    identity.brokerTarget !== helper.rustTarget ||
    identity.helperSha256 !== helper.helperSha256 ||
    identity.helperProtocol !== PROTOCOL_VERSION ||
    identity.helperBuild !== helper.helperBuildVersion ||
    identity.helperTarget !== helper.electronTarget ||
    identity.releaseSigner !== helper.releaseSigner
  ) {
    throw new Error('Launch broker compiled identity does not match its manifest');
  }
}

async function probeBrokerIdentity(
  processPort: NativeFilesystemHelperProcessPort,
  helper: VerifiedHelper,
  handshakeTimeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    let failure: Error | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const removers: Array<() => void> = [];
    const cleanup = () => {
      clearTimeout(executionTimer);
      if (forceTimer) clearTimeout(forceTimer);
      for (const remove of removers.splice(0)) remove();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: Error) => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(executionTimer);
      processPort.terminate(false);
      forceTimer = setTimeout(() => {
        processPort.terminate(true);
      }, IDENTITY_TERMINATION_GRACE_MS);
    };
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer,
      stream: string
    ): Buffer<ArrayBufferLike> => {
      if (failure || settled) return current;
      if (chunk.length > MAX_LINE_BYTES - current.length) {
        fail(new Error(`Launch broker ${stream} exceeded 65536 bytes`));
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    const executionTimer = setTimeout(
      () => fail(new Error('Launch broker identity timed out')),
      handshakeTimeoutMs
    );

    removers.push(
      processPort.onStdout((chunk) => {
        stdout = append(stdout, chunk, 'identity output');
      }),
      processPort.onStderr((chunk) => {
        stderr = append(stderr, chunk, 'identity diagnostics');
      }),
      processPort.onStdoutEnd(() => undefined),
      processPort.onExit((code, signal) => {
        if (settled) return;
        if (failure) {
          finish(failure);
          return;
        }
        if (code !== 0) {
          finish(
            new Error(
              `Launch broker identity failed with exit ${code ?? 'null'}${
                signal ? ` (${signal})` : ''
              }: ${stderr.toString('utf8').trim()}`
            )
          );
          return;
        }
        try {
          if (
            stdout.length < 2 ||
            stdout.length > MAX_LINE_BYTES ||
            stdout[stdout.length - 1] !== 0x0a ||
            stdout.subarray(0, -1).includes(0x0a)
          ) {
            throw new Error(
              'Launch broker identity must be exactly one newline-terminated JSON record'
            );
          }
          validateBrokerIdentity(parseStrictJson(stdout.subarray(0, -1)) as JsonValue, helper);
          finish();
        } catch (error) {
          processPort.terminate(true);
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }),
      processPort.onError((error) =>
        fail(new Error(`Launch broker identity failed: ${error.message}`))
      )
    );
  });
}

function validateDurability(value: JsonValue): NativeFilesystemDurabilityReceipt {
  const durability = strictRecord(value, 'durability');
  exactKeys(durability, ['file', 'parents'], 'durability');
  if (
    !['synced', 'not-applicable'].includes(String(durability.file)) ||
    !Array.isArray(durability.parents)
  ) {
    throw new Error('durability receipt is invalid');
  }
  if (durability.parents.some((entry) => entry !== 'synced')) {
    throw new Error('durability parent receipt is invalid');
  }
  return {
    file: durability.file as NativeFilesystemDurabilityReceipt['file'],
    parents: [...durability.parents] as 'synced'[],
  };
}

export class NativeFilesystemHelperClient {
  private readonly boundRoots: ReadonlySet<string>;
  private readonly boundRootKinds: ReadonlyMap<string, NativeFilesystemRootKind>;
  private readonly removers: Array<() => void> = [];
  private stdoutBuffer = Buffer.alloc(0);
  private stderrBuffer = Buffer.alloc(0);
  private stderrWasTruncated = false;
  private pending?: PendingRequest;
  private queueTail: Promise<void> = Promise.resolve();
  private fatalError?: NativeFilesystemHelperClientError;
  private closing = false;
  private closed = false;
  private closeResponseReceived = false;
  private processExited = false;
  private closePromise?: Promise<void>;
  private forceTerminationTimer?: NodeJS.Timeout;
  private deferredBrokenPipeFailure?: NativeFilesystemHelperClientError;
  private deferredBrokenPipeTimer?: NodeJS.Timeout;
  private cleanExitResolve!: () => void;
  private cleanExitReject!: (error: unknown) => void;
  private readonly cleanExit: Promise<void>;

  private constructor(
    private readonly processPort: NativeFilesystemHelperProcessPort,
    private readonly helper: VerifiedHelper,
    roots: readonly NativeFilesystemRootBinding[],
    private readonly idGenerator: () => string,
    private readonly maxStderrBytes: number,
    private readonly shutdownTimeoutMs: number
  ) {
    this.boundRoots = new Set(roots.map((root) => root.name));
    this.boundRootKinds = new Map(roots.map((root) => [root.name, root.kind]));
    this.cleanExit = new Promise<void>((resolve, reject) => {
      this.cleanExitResolve = resolve;
      this.cleanExitReject = reject;
    });
    this.removers.push(
      processPort.onStdout((chunk) => this.acceptStdout(chunk)),
      processPort.onStderr((chunk) => this.acceptStderr(chunk)),
      processPort.onStdoutEnd(() => this.onStdoutEnd()),
      processPort.onExit((code, signal) => this.onExit(code, signal)),
      processPort.onError((error) => this.onProcessError(error))
    );
  }

  static async open(
    options: NativeFilesystemHelperClientOptions
  ): Promise<NativeFilesystemHelperClient> {
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    const roots = validateRootBindings(options.roots);
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_BYTES;
    if (
      !Number.isSafeInteger(maxStderrBytes) ||
      maxStderrBytes < 1 ||
      maxStderrBytes > MAX_LINE_BYTES
    ) {
      throw new Error('maxStderrBytes must be an integer from 1 through 65536');
    }
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(shutdownTimeoutMs) ||
      shutdownTimeoutMs < 1 ||
      shutdownTimeoutMs > MAX_SHUTDOWN_TIMEOUT_MS
    ) {
      throw new Error('shutdownTimeoutMs must be an integer from 1 through 60000');
    }
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(handshakeTimeoutMs) ||
      handshakeTimeoutMs < 1 ||
      handshakeTimeoutMs > MAX_SHUTDOWN_TIMEOUT_MS
    ) {
      throw new Error('handshakeTimeoutMs must be an integer from 1 through 60000');
    }
    const launchTrustPolicy = options.launchTrustPolicy;
    const isPackaged = options.isPackaged ?? true;
    if (
      !launchTrustPolicy ||
      !['production', 'development'].includes(launchTrustPolicy.mode) ||
      (launchTrustPolicy.attestedPlatform !== 'development-any' &&
        launchTrustPolicy.attestedPlatform !== platform)
    ) {
      throw new Error('Filesystem helper launch requires an explicit broker trust policy');
    }
    if (isPackaged && launchTrustPolicy.mode !== 'production') {
      throw new Error('Packaged filesystem helper rejects an untrusted development launch policy');
    }
    const helper = await verifiedHelper(options.resourcesRoot, platform, architecture);
    const launcher = options.launcher ?? new DefaultHelperLauncher();
    let lease: AcquiredLaunchLease | undefined;
    let processPort: NativeFilesystemHelperProcessPort | undefined;
    let client: NativeFilesystemHelperClient | undefined;
    let boundaryReleaseAttempted = false;
    try {
      lease = await acquireLaunchLease(helper, launchTrustPolicy);
      const identityStdio: NativeFilesystemHelperLaunchOptions['stdio'] =
        lease.inheritedFileDescriptor === undefined
          ? ['pipe', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe', lease.inheritedFileDescriptor];
      const identityProcess = launcher.launch(lease.executablePath, ['--identity'], {
        shell: false,
        stdio: identityStdio,
        windowsHide: true,
        cwd: helper.toolsRoot,
        env: brokerEnvironment(platform),
      });
      const identityProof = probeBrokerIdentity(identityProcess, helper, handshakeTimeoutMs).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error })
      );
      try {
        await Promise.resolve().then(() => lease?.release());
      } catch (error) {
        identityProcess.terminate(true);
        await identityProof;
        throw new LaunchBoundaryReleaseError([error]);
      }
      lease = undefined;
      const identityOutcome = await identityProof;
      if (!identityOutcome.ok) throw identityOutcome.error;

      lease = await acquireLaunchLease(helper, launchTrustPolicy);
      const stdio: NativeFilesystemHelperLaunchOptions['stdio'] =
        lease.inheritedFileDescriptor === undefined
          ? ['pipe', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe', lease.inheritedFileDescriptor];
      processPort = launcher.launch(lease.executablePath, ['--stdio'], {
        shell: false,
        stdio,
        windowsHide: true,
        cwd: helper.toolsRoot,
        env: brokerEnvironment(platform),
      });
      client = new NativeFilesystemHelperClient(
        processPort,
        helper,
        roots,
        options.idGenerator ?? randomUUID,
        maxStderrBytes,
        shutdownTimeoutMs
      );
      boundaryReleaseAttempted = true;
      const released = await Promise.allSettled([
        Promise.resolve().then(() => lease?.release()),
        Promise.resolve().then(() => helper.handle.close()),
      ]);
      const failures = released
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new LaunchBoundaryReleaseError(failures);
      }
    } catch (error) {
      if (!boundaryReleaseAttempted) {
        await Promise.allSettled([
          Promise.resolve().then(() => lease?.release()),
          Promise.resolve().then(() => helper.handle.close()),
        ]);
      }
      if (client) client.forceTerminate();
      else processPort?.terminate(true);
      throw error;
    }
    if (!client) throw new Error('Filesystem helper client launch did not complete');
    const handshakeController = new AbortController();
    let handshakeTimedOut = false;
    const handshakeTimer = setTimeout(() => {
      handshakeTimedOut = true;
      handshakeController.abort('Filesystem helper handshake timed out');
    }, handshakeTimeoutMs);
    try {
      await client.performRequest('hello', {}, handshakeController.signal);
      await client.performRequest(
        'bind_roots',
        { roots: roots as unknown as JsonValue },
        handshakeController.signal
      );
      return client;
    } catch (error) {
      client.forceTerminate();
      if (handshakeTimedOut) {
        throw clientError('helper-timeout', 'unknown', 'Filesystem helper handshake timed out');
      }
      throw error;
    } finally {
      clearTimeout(handshakeTimer);
    }
  }

  async ensureDirChain(
    requestPath: NativeFilesystemCapabilityPath,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult> {
    const validatedPath = validateCapabilityPath(requestPath, this.boundRoots, 'path');
    return (await this.enqueue(
      'ensure_dir_chain',
      { path: validatedPath as unknown as JsonValue },
      signal
    )) as unknown as NativeFilesystemOperationResult;
  }

  async stageCopy(
    request: StageCopyRequest,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult> {
    const record = safeInputRecord(
      request,
      ['source', 'target', 'expected', 'expectedSha256'],
      'stage_copy'
    );
    const payload: Record<string, JsonValue> = {
      source: validateCapabilityPath(
        record.source as NativeFilesystemCapabilityPath,
        this.boundRoots,
        'source'
      ) as unknown as JsonValue,
      target: validateCapabilityPath(
        record.target as NativeFilesystemCapabilityPath,
        this.boundRoots,
        'target'
      ) as unknown as JsonValue,
    };
    if (record.expected !== undefined)
      payload.expected = validateIdentity(
        record.expected,
        'expected',
        this.helper.identityKind
      ) as unknown as JsonValue;
    if (record.expectedSha256 !== undefined)
      payload.expectedSha256 = validateSha256(record.expectedSha256, 'expectedSha256');
    return (await this.enqueue(
      'stage_copy',
      payload,
      signal
    )) as unknown as NativeFilesystemOperationResult;
  }

  async writeMarkerNew(
    requestPath: NativeFilesystemCapabilityPath,
    contents: string,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult> {
    if (typeof contents !== 'string' || contents.includes('\0')) {
      throw clientError(
        'invalid-request',
        'not-applied',
        'marker contents are invalid',
        'validation'
      );
    }
    const validatedPath = validateCapabilityPath(requestPath, this.boundRoots, 'path');
    return (await this.enqueue(
      'write_marker_new',
      { path: validatedPath as unknown as JsonValue, contents },
      signal
    )) as unknown as NativeFilesystemOperationResult;
  }

  async hardLinkNoReplace(
    request: LinkOrRenameRequest,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult> {
    return await this.linkOrRename('hard_link_no_replace', request, signal);
  }

  async renameNoReplace(
    request: LinkOrRenameRequest,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult> {
    return await this.linkOrRename('rename_no_replace', request, signal);
  }

  async removeManagedExact(
    request: RemoveManagedExactRequest,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult> {
    const record = safeInputRecord(request, ['path', 'expected'], 'remove_managed_exact');
    return (await this.enqueue(
      'remove_managed_exact',
      {
        path: validateCapabilityPath(
          record.path as NativeFilesystemCapabilityPath,
          this.boundRoots,
          'path'
        ) as unknown as JsonValue,
        expected: validateIdentity(
          record.expected,
          'expected',
          this.helper.identityKind
        ) as unknown as JsonValue,
      },
      signal
    )) as unknown as NativeFilesystemOperationResult;
  }

  async deleteSourceExact(
    request: DeleteSourceExactRequest,
    signal?: AbortSignal
  ): Promise<DeleteSourceExactResult> {
    return (await this.enqueue(
      'delete_source_exact',
      this.deleteRequestPayload(request, 'delete_source_exact'),
      signal
    )) as unknown as DeleteSourceExactResult;
  }

  async reconcileSourceDelete(
    request: ReconcileSourceDeleteRequest,
    signal?: AbortSignal
  ): Promise<ReconcileSourceDeleteResult> {
    return (await this.enqueue(
      'reconcile_source_delete',
      this.deleteRequestPayload(request, 'reconcile_source_delete'),
      signal
    )) as unknown as ReconcileSourceDeleteResult;
  }

  drain(): Promise<void> {
    return this.queueTail;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.enqueueInternal('close', {}).then(async () => {
      this.closeResponseReceived = true;
      this.processPort.endInput();
      await this.waitForCleanExit();
      this.closed = true;
      this.removeListeners();
    });
    return this.closePromise;
  }

  private waitForCleanExit(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = this.withDiagnostics(
          clientError(
            'helper-disconnected',
            'unknown',
            `Filesystem helper did not exit within ${this.shutdownTimeoutMs}ms after close`
          )
        );
        this.markFatal(error, true);
        reject(error);
      }, this.shutdownTimeoutMs);
    });
    return Promise.race([this.cleanExit, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private linkOrRename(
    operation: 'hard_link_no_replace' | 'rename_no_replace',
    request: LinkOrRenameRequest,
    signal?: AbortSignal
  ): Promise<NativeFilesystemOperationResult> {
    const record = safeInputRecord(request, ['source', 'target', 'expected'], operation);
    const payload: Record<string, JsonValue> = {
      source: validateCapabilityPath(
        record.source as NativeFilesystemCapabilityPath,
        this.boundRoots,
        'source'
      ) as unknown as JsonValue,
      target: validateCapabilityPath(
        record.target as NativeFilesystemCapabilityPath,
        this.boundRoots,
        'target'
      ) as unknown as JsonValue,
    };
    if (record.expected !== undefined)
      payload.expected = validateIdentity(
        record.expected,
        'expected',
        this.helper.identityKind
      ) as unknown as JsonValue;
    return this.enqueue(
      operation,
      payload,
      signal
    ) as unknown as Promise<NativeFilesystemOperationResult>;
  }

  private deleteRequestPayload(
    request: DeleteSourceExactRequest,
    operation: 'delete_source_exact' | 'reconcile_source_delete'
  ): Record<string, JsonValue> {
    const record = safeInputRecord(
      request,
      ['source', 'expected', 'expectedSha256', 'deleteId', 'receipt'],
      operation
    );
    const receipt = validateCapabilityPath(
      record.receipt as NativeFilesystemCapabilityPath,
      this.boundRoots,
      'receipt'
    );
    if (this.boundRootKinds.get(receipt.root) !== 'control') {
      throw clientError(
        'invalid-request',
        'not-applied',
        'receipt.root must bind a control capability',
        'validation'
      );
    }
    return {
      source: validateCapabilityPath(
        record.source as NativeFilesystemCapabilityPath,
        this.boundRoots,
        'source'
      ) as unknown as JsonValue,
      expected: validateIdentity(
        record.expected,
        'expected',
        this.helper.identityKind
      ) as unknown as JsonValue,
      expectedSha256: validateSha256(record.expectedSha256, 'expectedSha256'),
      deleteId: validateDeleteId(record.deleteId),
      receipt: receipt as unknown as JsonValue,
    };
  }

  private enqueue(
    operation: Exclude<HelperOperation, 'hello' | 'bind_roots' | 'close'>,
    payload: Record<string, JsonValue>,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    if (this.closing || this.closed) {
      return Promise.reject(
        clientError('client-closed', 'not-applied', 'Filesystem helper client is closing')
      );
    }
    if (this.fatalError) return Promise.reject(this.fatalError);
    return this.schedule(operation, payload, signal);
  }

  private enqueueInternal(
    operation: 'close',
    payload: Record<string, JsonValue>
  ): Promise<JsonValue> {
    return this.schedule(operation, payload);
  }

  private schedule(
    operation: HelperOperation,
    payload: Record<string, JsonValue>,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    let started = false;
    let cancelled = signal?.aborted === true;
    let externallySettled = false;
    let rejectOuter!: (error: unknown) => void;
    const result = new Promise<JsonValue>((resolve, reject) => {
      rejectOuter = reject;
      const run = this.queueTail.then(async () => {
        if (cancelled) return;
        started = true;
        removeQueuedAbort?.();
        try {
          const value = await this.performRequest(operation, payload, signal);
          if (!externallySettled) {
            externallySettled = true;
            resolve(value);
          }
        } catch (error) {
          if (!externallySettled) {
            externallySettled = true;
            reject(error);
          }
        }
      });
      this.queueTail = run.then(
        () => undefined,
        () => undefined
      );
    });
    let removeQueuedAbort: (() => void) | undefined;
    const onQueuedAbort = () => {
      if (started || externallySettled) return;
      cancelled = true;
      externallySettled = true;
      removeQueuedAbort?.();
      rejectOuter(
        clientError(
          'aborted',
          'not-applied',
          'Filesystem helper request aborted before transmission'
        )
      );
    };
    if (signal) {
      signal.addEventListener('abort', onQueuedAbort, { once: true });
      removeQueuedAbort = () => signal.removeEventListener('abort', onQueuedAbort);
    }
    if (cancelled) onQueuedAbort();
    return result;
  }

  private performRequest(
    operation: HelperOperation,
    payload: Record<string, JsonValue>,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (signal?.aborted) {
      return Promise.reject(
        clientError(
          'aborted',
          'not-applied',
          'Filesystem helper request aborted before transmission'
        )
      );
    }
    if (this.pending)
      return Promise.reject(
        clientError('client-busy', 'not-applied', 'Filesystem helper request is already active')
      );
    const id = this.idGenerator();
    if (!UUID_PATTERN.test(id)) {
      return Promise.reject(
        clientError('invalid-request-id', 'not-applied', 'Request ID is not a lowercase UUID v4')
      );
    }
    const deleteId =
      operation === 'delete_source_exact' || operation === 'reconcile_source_delete'
        ? payload.deleteId
        : undefined;
    if (deleteId !== undefined && deleteId === id) {
      return Promise.reject(
        clientError(
          'invalid-delete-id',
          'not-applied',
          'deleteId must differ from the transport request ID',
          'validation'
        )
      );
    }
    const request = { v: PROTOCOL_VERSION, id, op: operation, ...payload };
    const line = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
    if (line.length > MAX_LINE_BYTES) {
      return Promise.reject(
        clientError(
          'request-too-large',
          'not-applied',
          'Request exceeds 65536-byte line limit',
          'validation'
        )
      );
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const onAbort = () => {
        const error = this.withDiagnostics(
          clientError('aborted', 'unknown', 'Filesystem helper request aborted after transmission')
        );
        this.markFatal(error);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pending = {
        id,
        operation,
        resolve,
        reject,
        ...(operation === 'reconcile_source_delete' || operation === 'delete_source_exact'
          ? {
              reconciliation: {
                deleteId: deleteId as string,
                source: payload.source as unknown as NativeFilesystemCapabilityPath,
                receipt: payload.receipt as unknown as NativeFilesystemCapabilityPath,
              },
            }
          : {}),
        ...(signal ? { removeAbort: () => signal.removeEventListener('abort', onAbort) } : {}),
      };
      void this.processPort.write(line).catch((error) => {
        this.handleProcessFailure(
          error,
          `Filesystem helper request transmission failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    });
  }

  private acceptStdout(chunk: Buffer): void {
    if (this.fatalError || this.closed) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.from(chunk)]);
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length >= MAX_LINE_BYTES) {
          this.protocolFailure('Filesystem helper response exceeds 65536-byte line limit');
        }
        return;
      }
      if (newline + 1 > MAX_LINE_BYTES) {
        this.protocolFailure('Filesystem helper response exceeds 65536-byte line limit');
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      try {
        this.acceptResponse(parseStrictJson(line));
      } catch (error) {
        this.protocolFailure(
          `Invalid filesystem helper response: ${error instanceof Error ? error.message : String(error)}`
        );
        return;
      }
      if (this.fatalError) return;
    }
  }

  private acceptStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.stderrBuffer, Buffer.from(chunk)]);
    if (combined.length > this.maxStderrBytes) {
      this.stderrWasTruncated = true;
      this.stderrBuffer = combined.subarray(combined.length - this.maxStderrBytes);
    } else {
      this.stderrBuffer = combined;
    }
  }

  private acceptResponse(value: JsonValue): void {
    const pending = this.pending;
    if (!pending) throw new Error('Helper emitted an unsolicited response');
    const response = strictRecord(value, 'response');
    if (response.ok === true) exactKeys(response, ['v', 'id', 'ok', 'result'], 'response');
    else if (response.ok === false) exactKeys(response, ['v', 'id', 'ok', 'error'], 'response');
    else throw new Error('Response ok field is invalid');
    if (response.v !== PROTOCOL_VERSION || response.id !== pending.id) {
      throw new Error('Response protocol version or request ID does not match');
    }
    if (response.ok === false) {
      const error = this.validateHelperError(response.error, pending);
      pending.removeAbort?.();
      this.pending = undefined;
      pending.reject(error);
      return;
    }
    const result = this.validateSuccess(pending, response.result);
    pending.removeAbort?.();
    this.pending = undefined;
    if (pending.operation === 'close') this.closeResponseReceived = true;
    pending.resolve(result);
  }

  private validateHelperError(
    value: JsonValue,
    pending: PendingRequest
  ): NativeFilesystemHelperClientError {
    const error = strictRecord(value, 'error');
    const hasDetails = Object.prototype.hasOwnProperty.call(error, 'details');
    exactKeys(
      error,
      hasDetails
        ? ['code', 'phase', 'outcome', 'retryable', 'message', 'details']
        : ['code', 'phase', 'outcome', 'retryable', 'message'],
      'error'
    );
    if (
      typeof error.code !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(error.code) ||
      !['validation', 'precondition', 'mutation', 'durability', 'protocol'].includes(
        String(error.phase)
      ) ||
      !['not-applied', 'unknown'].includes(String(error.outcome)) ||
      typeof error.retryable !== 'boolean' ||
      typeof error.message !== 'string' ||
      error.message.length === 0
    ) {
      throw new Error('Helper error response is invalid');
    }
    let details: ReconcileSourceDeleteErrorDetails | undefined;
    if (error.code === 'reconciliation-required') {
      if (
        error.phase !== 'precondition' ||
        error.outcome !== 'unknown' ||
        error.retryable !== false
      ) {
        throw new Error('Reconciliation-required error response is invalid');
      }
      if (pending.operation === 'reconcile_source_delete' && hasDetails) {
        details = this.validateReconciliationDetails(error.details, pending);
      } else if (pending.operation !== 'delete_source_exact' || hasDetails) {
        throw new Error('Reconciliation-required error response is invalid');
      }
    } else if (hasDetails) {
      throw new Error('Helper error details are not allowed for this response');
    }
    return new NativeFilesystemHelperClientError(
      error.code,
      error.phase as NativeFilesystemHelperErrorPhase,
      error.outcome as NativeFilesystemHelperErrorOutcome,
      error.retryable,
      error.message,
      this.stderrText(),
      this.stderrWasTruncated,
      details
    );
  }

  private validateReconciliationDetails(
    value: JsonValue,
    pending: PendingRequest
  ): ReconcileSourceDeleteErrorDetails {
    const context = pending.reconciliation;
    if (!context) throw new Error('Reconciliation response has no request context');
    const details = strictRecord(value, 'reconciliation error details');
    exactKeys(
      details,
      ['deleteId', 'sourceState', 'quarantineState', 'receiptState', 'relativeResidue'],
      'reconciliation error details'
    );
    const sourceStates: readonly ReconcileSourceDeleteFailureSourceState[] = [
      'expected',
      'absent',
      'other',
      'special',
      'unreadable',
    ];
    const quarantineStates: readonly ReconcileSourceDeleteFailureQuarantineState[] = [
      'absent',
      'empty',
      'entry-expected',
      'entry-other',
      'entry-special',
      'unexpected-entries',
      'special',
      'unreadable',
    ];
    const receiptStates = ['absent', 'exact', 'other', 'special', 'unreadable'] as const;
    if (
      details.deleteId !== context.deleteId ||
      !sourceStates.includes(details.sourceState as ReconcileSourceDeleteFailureSourceState) ||
      !quarantineStates.includes(
        details.quarantineState as ReconcileSourceDeleteFailureQuarantineState
      ) ||
      !receiptStates.includes(details.receiptState as (typeof receiptStates)[number])
    ) {
      throw new Error('Reconciliation error state is invalid');
    }
    const residue = strictRecord(details.relativeResidue, 'reconciliation relative residue');
    exactKeys(
      residue,
      ['source', 'quarantine', 'entry', 'receipt'],
      'reconciliation relative residue'
    );
    const quarantineName = `.meta-mover-delete-${context.deleteId.replace(/-/g, '')}`;
    const expectedPaths = {
      source: context.source,
      quarantine: {
        root: context.source.root,
        components: [...context.source.components.slice(0, -1), quarantineName],
      },
      entry: {
        root: context.source.root,
        components: [...context.source.components.slice(0, -1), quarantineName, 'entry'],
      },
      receipt: context.receipt,
    };
    const normalizedPaths = Object.fromEntries(
      Object.entries(expectedPaths).map(([name, expected]) => {
        const actual = strictRecord(residue[name], `reconciliation residue ${name}`);
        exactKeys(actual, ['root', 'components'], `reconciliation residue ${name}`);
        if (
          actual.root !== expected.root ||
          !Array.isArray(actual.components) ||
          actual.components.length !== expected.components.length ||
          actual.components.some((component, index) => component !== expected.components[index])
        ) {
          throw new Error('Reconciliation relative residue does not match the request capability');
        }
        return [name, { root: expected.root, components: [...expected.components] }];
      })
    ) as unknown as ReconcileSourceDeleteRelativeResidue;
    if (
      !normalizedPaths.source ||
      !normalizedPaths.quarantine ||
      !normalizedPaths.entry ||
      !normalizedPaths.receipt
    ) {
      throw new Error('Reconciliation relative residue does not match the request capability');
    }
    return {
      deleteId: context.deleteId,
      sourceState: details.sourceState as ReconcileSourceDeleteFailureSourceState,
      quarantineState: details.quarantineState as ReconcileSourceDeleteFailureQuarantineState,
      receiptState: details.receiptState as ReconcileSourceDeleteErrorDetails['receiptState'],
      relativeResidue: normalizedPaths,
    };
  }

  private validateReconciliationSuccess(
    result: StrictRecord,
    pending: PendingRequest
  ): ReconcileSourceDeleteResult {
    const context = pending.reconciliation;
    if (!context) throw new Error('Reconciliation response has no request context');
    exactKeys(
      result,
      [
        'outcome',
        'state',
        'sourceState',
        'quarantineState',
        'receiptState',
        'deleteId',
        'durability',
      ],
      'reconcile_source_delete result'
    );
    if (result.deleteId !== context.deleteId) {
      throw new Error('Reconciliation result deleteId does not match the request');
    }
    const durability = validateDurability(result.durability);
    if (
      result.outcome === 'not-applied' &&
      result.state === 'source-retained' &&
      result.sourceState === 'expected' &&
      result.receiptState === 'absent' &&
      (result.quarantineState === 'absent' || result.quarantineState === 'empty-removed')
    ) {
      const expectedParents = result.quarantineState === 'absent' ? 0 : 1;
      if (durability.file !== 'not-applicable' || durability.parents.length !== expectedParents) {
        throw new Error('Source-retained reconciliation durability is invalid');
      }
      return {
        outcome: 'not-applied',
        state: 'source-retained',
        sourceState: 'expected',
        quarantineState: result.quarantineState,
        receiptState: 'absent',
        deleteId: context.deleteId,
        durability: { file: 'not-applicable', parents: [...durability.parents] },
      };
    }
    if (
      result.outcome === 'applied' &&
      result.state === 'deleted' &&
      (result.sourceState === 'absent' || result.sourceState === 'replacement-preserved') &&
      (result.quarantineState === 'entry-deleted' ||
        result.quarantineState === 'empty-removed' ||
        result.quarantineState === 'absent') &&
      (result.receiptState === 'created' || result.receiptState === 'exact') &&
      ((result.receiptState === 'created' &&
        result.quarantineState === 'entry-deleted' &&
        durability.file === 'synced' &&
        durability.parents.length === 3) ||
        (result.receiptState === 'exact' &&
          durability.file === 'not-applicable' &&
          durability.parents.length === (result.quarantineState === 'absent' ? 1 : 2)))
    ) {
      return {
        outcome: 'applied',
        state: 'deleted',
        sourceState: result.sourceState,
        quarantineState: result.quarantineState,
        receiptState: result.receiptState,
        deleteId: context.deleteId,
        durability: { file: durability.file, parents: [...durability.parents] },
      };
    }
    throw new Error('Reconciliation result state is invalid');
  }

  private validateDeleteSourceSuccess(
    result: StrictRecord,
    pending: PendingRequest
  ): DeleteSourceExactResult {
    const context = pending.reconciliation;
    if (!context) throw new Error('Delete response has no request context');
    exactKeys(
      result,
      [
        'outcome',
        'state',
        'sourceState',
        'quarantineState',
        'receiptState',
        'deleteId',
        'durability',
      ],
      'delete_source_exact result'
    );
    const durability = validateDurability(result.durability);
    if (
      result.outcome !== 'applied' ||
      result.state !== 'deleted' ||
      result.sourceState !== 'absent' ||
      result.quarantineState !== 'entry-deleted' ||
      result.receiptState !== 'created' ||
      result.deleteId !== context.deleteId ||
      durability.file !== 'synced' ||
      durability.parents.length !== 3
    ) {
      throw new Error('Delete source result is invalid');
    }
    return {
      outcome: 'applied',
      state: 'deleted',
      sourceState: 'absent',
      quarantineState: 'entry-deleted',
      receiptState: 'created',
      deleteId: context.deleteId,
      durability: { file: 'synced', parents: [...durability.parents] },
    };
  }

  private validateSuccess(pending: PendingRequest, value: JsonValue): JsonValue {
    const { operation } = pending;
    const result = strictRecord(value, 'result');
    if (operation === 'hello') {
      exactKeys(result, ['outcome', 'protocol', 'build', 'target', 'features'], 'hello result');
      const features = result.features;
      if (
        result.outcome !== 'applied' ||
        result.protocol !== PROTOCOL_VERSION ||
        result.build !== this.helper.helperBuildVersion ||
        typeof result.target !== 'string' ||
        !validRustTargets(this.helper.electronTarget).includes(result.target) ||
        !Array.isArray(features) ||
        features.length !== REQUIRED_FEATURES.length ||
        REQUIRED_FEATURES.some((feature) => !features.includes(feature))
      ) {
        throw new Error('Helper hello result does not match packaged manifest');
      }
      return { ...result };
    }
    if (operation === 'bind_roots') {
      exactKeys(result, ['outcome', 'roots', 'durability'], 'bind_roots result');
      if (result.outcome !== 'applied' || !Array.isArray(result.roots)) {
        throw new Error('bind_roots result is invalid');
      }
      const returned = result.roots.map((entry, index) => {
        const root = strictRecord(entry, `bind_roots result.roots[${index}]`);
        exactKeys(root, ['name', 'kind', 'identity'], 'bound root');
        return {
          name: root.name,
          kind: root.kind,
          identity: validateResponseIdentity(
            root.identity,
            'bound root identity',
            this.helper.identityKind
          ),
        };
      });
      const returnedNames = new Set<string>();
      if (
        returned.length !== this.boundRootKinds.size ||
        returned.some((root) => {
          if (
            typeof root.name !== 'string' ||
            typeof root.kind !== 'string' ||
            returnedNames.has(root.name)
          ) {
            return true;
          }
          returnedNames.add(root.name);
          return this.boundRootKinds.get(root.name) !== root.kind;
        })
      ) {
        throw new Error('bind_roots result does not match requested roots');
      }
      validateDurability(result.durability);
      return {
        outcome: 'applied',
        roots: returned,
        durability: validateDurability(result.durability),
      } as unknown as JsonValue;
    }
    if (operation === 'close') {
      exactKeys(result, ['outcome', 'durability'], 'close result');
      if (result.outcome !== 'applied') throw new Error('close result is invalid');
      return {
        outcome: 'applied',
        durability: validateDurability(result.durability),
      } as unknown as JsonValue;
    }
    if (operation === 'delete_source_exact') {
      return this.validateDeleteSourceSuccess(result, pending) as unknown as JsonValue;
    }
    if (operation === 'reconcile_source_delete') {
      return this.validateReconciliationSuccess(result, pending) as unknown as JsonValue;
    }
    allowedKeys(result, ['outcome', 'before', 'after', 'sha256', 'durability'], 'operation result');
    if (
      result.outcome !== 'applied' ||
      !Object.prototype.hasOwnProperty.call(result, 'durability')
    ) {
      throw new Error('Operation result is invalid');
    }
    const normalized: Record<string, JsonValue> = {
      outcome: 'applied',
      durability: validateDurability(result.durability) as unknown as JsonValue,
    };
    for (const key of ['before', 'after'] as const) {
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        normalized[key] =
          result[key] === null
            ? null
            : (validateResponseIdentity(
                result[key],
                key,
                this.helper.identityKind
              ) as unknown as JsonValue);
      }
    }
    if (Object.prototype.hasOwnProperty.call(result, 'sha256')) {
      if (typeof result.sha256 !== 'string' || !SHA256_PATTERN.test(result.sha256)) {
        throw new Error('Operation result SHA-256 is invalid');
      }
      normalized.sha256 = result.sha256;
    }
    if (
      operation === 'ensure_dir_chain' &&
      (!Object.prototype.hasOwnProperty.call(normalized, 'after') || normalized.after === null)
    ) {
      throw new Error('ensure_dir_chain result must include the final directory identity');
    }
    return normalized;
  }

  private protocolFailure(message: string): void {
    this.markFatal(this.withDiagnostics(clientError('helper-protocol', 'unknown', message)));
  }

  private onStdoutEnd(): void {
    if (this.closeResponseReceived) return;
    this.markFatal(
      this.withDiagnostics(
        clientError('helper-disconnected', 'unknown', 'Filesystem helper stdout reached EOF')
      )
    );
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.processExited = true;
    this.clearForceTerminationTimer();
    if (this.fatalError) {
      this.removeListeners();
      return;
    }
    if (this.deferredBrokenPipeFailure) {
      const error = this.deferredBrokenPipeFailure;
      this.clearDeferredBrokenPipeFailure();
      if (this.closeResponseReceived) this.cleanExitReject(error);
      this.markFatal(error);
      return;
    }
    if (this.closeResponseReceived && code === 0 && signal === null) {
      this.cleanExitResolve();
      return;
    }
    const error = this.withDiagnostics(
      clientError(
        'helper-disconnected',
        'unknown',
        `Filesystem helper exited unexpectedly: code=${String(code)} signal=${String(signal)}`
      )
    );
    if (this.closeResponseReceived) this.cleanExitReject(error);
    this.markFatal(error);
  }

  private onProcessError(cause: Error): void {
    this.handleProcessFailure(cause, `Filesystem helper process failed: ${cause.message}`);
  }

  private handleProcessFailure(cause: unknown, message: string): void {
    const error = this.withDiagnostics(clientError('helper-disconnected', 'unknown', message));
    const code =
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? String((cause as { code?: unknown }).code)
        : '';
    if (code === 'EPIPE' || /\bEPIPE\b/.test(error.message)) {
      if (this.deferredBrokenPipeFailure || this.fatalError) return;
      // The child can close stdin while its final stdout is still queued. Wait for
      // close (which follows stdio drain), with a bounded fallback, before EPIPE wins.
      this.deferredBrokenPipeFailure = error;
      this.deferredBrokenPipeTimer = setTimeout(() => {
        this.deferredBrokenPipeTimer = undefined;
        this.deferredBrokenPipeFailure = undefined;
        if (this.closeResponseReceived) this.cleanExitReject(error);
        this.markFatal(error);
      }, BROKEN_PIPE_OUTPUT_GRACE_MS);
      return;
    }
    if (this.closeResponseReceived) this.cleanExitReject(error);
    this.markFatal(error);
  }

  private markFatal(error: NativeFilesystemHelperClientError, forceImmediately = false): void {
    if (this.fatalError) return;
    this.clearDeferredBrokenPipeFailure();
    this.fatalError = error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.removeAbort?.();
    pending?.reject(error);
    if (this.processExited) {
      this.removeListeners();
      return;
    }
    this.processPort.terminate(false);
    if (forceImmediately) {
      this.processPort.terminate(true);
      this.removeListeners();
      return;
    }
    this.forceTerminationTimer = setTimeout(() => {
      this.processPort.terminate(true);
      this.removeListeners();
    }, this.shutdownTimeoutMs);
    this.forceTerminationTimer.unref?.();
  }

  private withDiagnostics(
    error: NativeFilesystemHelperClientError
  ): NativeFilesystemHelperClientError {
    return new NativeFilesystemHelperClientError(
      error.code,
      error.phase,
      error.outcome,
      error.retryable,
      error.message,
      this.stderrText(),
      this.stderrWasTruncated
    );
  }

  private stderrText(): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(this.stderrBuffer);
  }

  private forceTerminate(): void {
    this.clearForceTerminationTimer();
    this.processPort.terminate(true);
    this.removeListeners();
  }

  private clearForceTerminationTimer(): void {
    if (!this.forceTerminationTimer) return;
    clearTimeout(this.forceTerminationTimer);
    this.forceTerminationTimer = undefined;
  }

  private clearDeferredBrokenPipeFailure(): void {
    if (this.deferredBrokenPipeTimer) clearTimeout(this.deferredBrokenPipeTimer);
    this.deferredBrokenPipeTimer = undefined;
    this.deferredBrokenPipeFailure = undefined;
  }

  private removeListeners(): void {
    this.clearDeferredBrokenPipeFailure();
    for (const remove of this.removers.splice(0)) remove();
  }
}
