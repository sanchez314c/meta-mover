import { createHash } from 'crypto';
import { constants } from 'fs';
import { lstat, open, realpath } from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { TextDecoder, types as utilTypes } from 'util';

export type EvidenceEventKind =
  | 'job-opened'
  | 'preview-recorded'
  | 'file-observed'
  | 'candidate-observed'
  | 'resolution-decided'
  | 'operation-planned'
  | 'preview-sealed'
  | 'operation-committed'
  | 'operation-skipped'
  | 'operation-failed'
  | 'operation-cancelled'
  | 'start-rejected'
  | 'job-closed';

export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export interface EvidenceEvent {
  schemaVersion: 'meta-mover-evidence/1';
  policyVersion: string;
  jobId: string;
  sequence: number;
  emittedAt: string;
  previousHash: string;
  eventHash: string;
  kind: EvidenceEventKind;
  payload: CanonicalJsonValue;
}

export interface ManifestVerification {
  valid: boolean;
  eventCount: number;
  finalHash?: string;
  reason?: string;
}

export interface ManifestVerificationProgress {
  bytesRead: number;
  totalBytes: number;
  eventCount: number;
}

export interface ManifestVerificationOptions {
  /** Aborts verification; rejects with an AbortError, including mid-read. */
  signal?: AbortSignal;
  /**
   * Receives bounded, monotonic byte progress. Reports are throttled to at
   * most one per 250 ms plus one initial and one exact final report.
   */
  onProgress?: (progress: ManifestVerificationProgress) => void | Promise<void>;
}

export type EvidenceManifestErrorCode =
  | 'INVALID_INPUT'
  | 'UNSAFE_DIRECTORY'
  | 'UNSAFE_MANIFEST'
  | 'MANIFEST_CLOSED';

export class EvidenceManifestError extends Error {
  constructor(
    public readonly code: EvidenceManifestErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EvidenceManifestError';
  }
}

interface FileIdentity {
  device: number;
  inode: number;
}

interface CloseResult {
  eventCount: number;
  finalHash: string;
}

const GENESIS_HASH = '0'.repeat(64);
const PRIVATE_FILE_MODE = 0o600;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_EVENTS = 256;
const READ_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const EVENT_KEYS = [
  'schemaVersion',
  'policyVersion',
  'jobId',
  'sequence',
  'emittedAt',
  'previousHash',
  'eventHash',
  'kind',
  'payload',
] as const;
const EVENT_KINDS = new Set<EvidenceEventKind>([
  'job-opened',
  'preview-recorded',
  'file-observed',
  'candidate-observed',
  'resolution-decided',
  'operation-planned',
  'preview-sealed',
  'operation-committed',
  'operation-skipped',
  'operation-failed',
  'operation-cancelled',
  'start-rejected',
  'job-closed',
]);

function failCanonical(pathLabel: string, reason: string): never {
  throw new EvidenceManifestError(
    'INVALID_INPUT',
    `Evidence value at ${pathLabel} is not canonical: ${reason}`
  );
}

function canonicalize(
  value: unknown,
  pathLabel = '$',
  ancestors: WeakSet<object> = new WeakSet()
): CanonicalJsonValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failCanonical(pathLabel, 'number must be finite');
    return value;
  }
  if (typeof value !== 'object') {
    failCanonical(pathLabel, `${typeof value} is unsupported`);
  }
  if (utilTypes.isProxy(value)) failCanonical(pathLabel, 'proxy values are unsupported');
  if (ancestors.has(value)) failCanonical(pathLabel, 'cycles are unsupported');

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    failCanonical(pathLabel, 'value must be a plain object or array');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    failCanonical(pathLabel, 'symbol properties are unsupported');
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        failCanonical(pathLabel, 'array length is invalid');
      }
      const length = lengthDescriptor.value as number;
      const elementKeys = ownKeys.filter((key) => key !== 'length');
      if (elementKeys.length !== length) {
        failCanonical(pathLabel, 'array holes or unsupported properties are unsupported');
      }
      for (const key of elementKeys) {
        if (
          typeof key !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          !Number.isSafeInteger(Number(key)) ||
          Number(key) >= length
        ) {
          failCanonical(pathLabel, 'array has an invalid index or unsupported property');
        }
      }
      const result: CanonicalJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined)
          failCanonical(`${pathLabel}[${index}]`, 'array holes are unsupported');
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          failCanonical(`${pathLabel}[${index}]`, 'accessor properties are unsupported');
        }
        result.push(canonicalize(descriptor.value, `${pathLabel}[${index}]`, ancestors));
      }
      return result;
    }

    const result = Object.create(null) as { [key: string]: CanonicalJsonValue };
    const keys = ownKeys as string[];
    keys.sort();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable)
        failCanonical(`${pathLabel}.${key}`, 'hidden properties are unsupported');
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        failCanonical(`${pathLabel}.${key}`, 'accessor properties are unsupported');
      }
      result[key] = canonicalize(descriptor.value, `${pathLabel}.${key}`, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function serializeCanonical(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`)
    .join(',')}}`;
}

function canonicalJson(value: unknown): string {
  return serializeCanonical(canonicalize(value));
}

function calculateEventHash(event: Omit<EvidenceEvent, 'eventHash'>): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function requireAbsolutePath(manifestPath: string): string {
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) {
    throw new EvidenceManifestError('INVALID_INPUT', 'Manifest path must be absolute');
  }
  return path.normalize(manifestPath);
}

async function validatePrivateDirectory(directoryPath: string): Promise<FileIdentity> {
  const normalized = path.normalize(directoryPath);
  const [stats, resolved] = await Promise.all([lstat(normalized), realpath(normalized)]);
  const currentUser = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    resolved !== normalized ||
    (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) ||
    (currentUser !== null && stats.uid !== currentUser)
  ) {
    throw new EvidenceManifestError(
      'UNSAFE_DIRECTORY',
      'Evidence directory must be a private, owned, real directory'
    );
  }
  return { device: stats.dev, inode: stats.ino };
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, constants.O_RDONLY | NO_FOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function sameIdentity(first: { dev: number; ino: number }, second: FileIdentity): boolean {
  return first.dev === second.device && first.ino === second.inode;
}

function invalidVerification(eventCount: number, reason: string): ManifestVerification {
  return { valid: false, eventCount, reason };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isEvidenceEvent(value: unknown): value is EvidenceEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === EVENT_KEYS.length &&
    keys.every(
      (key) => typeof key === 'string' && EVENT_KEYS.includes(key as (typeof EVENT_KEYS)[number])
    ) &&
    EVENT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
    record.schemaVersion === 'meta-mover-evidence/1' &&
    typeof record.policyVersion === 'string' &&
    record.policyVersion.length > 0 &&
    typeof record.jobId === 'string' &&
    record.jobId.length > 0 &&
    Number.isSafeInteger(record.sequence) &&
    (record.sequence as number) > 0 &&
    isIsoTimestamp(record.emittedAt) &&
    typeof record.previousHash === 'string' &&
    HASH_PATTERN.test(record.previousHash) &&
    typeof record.eventHash === 'string' &&
    HASH_PATTERN.test(record.eventHash) &&
    typeof record.kind === 'string' &&
    EVENT_KINDS.has(record.kind as EvidenceEventKind)
  );
}

export class EvidenceManifest {
  private sequence = 0;
  private previousHash = GENESIS_HASH;
  private closed = false;
  private writeTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<CloseResult> | null = null;
  private failure: unknown | null = null;

  private constructor(
    private readonly handle: FileHandle,
    private readonly manifestPath: string,
    private readonly fileIdentity: FileIdentity,
    private readonly directoryIdentity: FileIdentity,
    private readonly jobId: string,
    private readonly policyVersion: string
  ) {}

  static async create(
    manifestPath: string,
    jobId: string,
    policyVersion: string
  ): Promise<EvidenceManifest> {
    const normalizedPath = requireAbsolutePath(manifestPath);
    if (
      typeof jobId !== 'string' ||
      jobId.length === 0 ||
      typeof policyVersion !== 'string' ||
      policyVersion.length === 0
    ) {
      throw new EvidenceManifestError(
        'INVALID_INPUT',
        'jobId and policyVersion must be non-empty strings'
      );
    }
    const directoryPath = path.dirname(normalizedPath);
    const directoryIdentity = await validatePrivateDirectory(directoryPath);
    const handle = await open(
      normalizedPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND | NO_FOLLOW,
      PRIVATE_FILE_MODE
    );
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      const [held, visible] = await Promise.all([handle.stat(), lstat(normalizedPath)]);
      if (
        !held.isFile() ||
        held.nlink !== 1 ||
        visible.isSymbolicLink() ||
        !visible.isFile() ||
        visible.nlink !== 1 ||
        held.dev !== visible.dev ||
        held.ino !== visible.ino
      ) {
        throw new EvidenceManifestError('UNSAFE_MANIFEST', 'Evidence manifest leaf is unsafe');
      }
      const manifest = new EvidenceManifest(
        handle,
        normalizedPath,
        { device: held.dev, inode: held.ino },
        directoryIdentity,
        jobId,
        policyVersion
      );
      await handle.sync();
      await syncDirectory(directoryPath);
      await manifest.append('job-opened', { jobId, policyVersion });
      return manifest;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  append(kind: EvidenceEventKind, payload: unknown): Promise<EvidenceEvent> {
    if (this.closed || this.closePromise) {
      return Promise.reject(
        new EvidenceManifestError('MANIFEST_CLOSED', 'Manifest is closed or closing')
      );
    }
    if (!EVENT_KINDS.has(kind) || kind === 'job-closed') {
      return Promise.reject(
        new EvidenceManifestError('INVALID_INPUT', 'Use close() to close a manifest')
      );
    }
    let payloadSnapshot: CanonicalJsonValue;
    try {
      payloadSnapshot = canonicalize(payload);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => this.writeEvent(kind, payloadSnapshot));
  }

  appendBatch(
    records: readonly Readonly<{ kind: EvidenceEventKind; payload: unknown }>[]
  ): Promise<readonly EvidenceEvent[]> {
    if (this.closed || this.closePromise) {
      return Promise.reject(
        new EvidenceManifestError('MANIFEST_CLOSED', 'Manifest is closed or closing')
      );
    }
    if (records.length === 0 || records.length > MAX_BATCH_EVENTS) {
      return Promise.reject(
        new EvidenceManifestError(
          'INVALID_INPUT',
          `Evidence batch must contain between 1 and ${MAX_BATCH_EVENTS} events`
        )
      );
    }
    let snapshots: Array<{ kind: EvidenceEventKind; payload: CanonicalJsonValue }>;
    try {
      snapshots = records.map(({ kind, payload }) => {
        if (!EVENT_KINDS.has(kind) || kind === 'job-closed') {
          throw new EvidenceManifestError('INVALID_INPUT', 'Use close() to close a manifest');
        }
        return { kind, payload: canonicalize(payload) };
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(() => this.writeBatch(snapshots));
  }

  close(payload: unknown): Promise<CloseResult> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) {
      return Promise.reject(new EvidenceManifestError('MANIFEST_CLOSED', 'Manifest is closed'));
    }
    let payloadSnapshot: CanonicalJsonValue;
    try {
      payloadSnapshot = canonicalize(payload);
    } catch (error) {
      return Promise.reject(error);
    }
    this.closePromise = this.enqueue(async () => {
      try {
        const event = await this.writeEvent('job-closed', payloadSnapshot);
        this.closed = true;
        await this.handle.close();
        return { eventCount: event.sequence, finalHash: event.eventHash };
      } catch (error) {
        this.closed = true;
        await this.handle.close().catch(() => undefined);
        throw error;
      }
    });
    return this.closePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(async () => {
      if (this.closed || this.failure !== null) {
        throw new EvidenceManifestError('MANIFEST_CLOSED', 'Manifest is closed after a failure');
      }
      try {
        return await operation();
      } catch (error) {
        this.failure = error;
        this.closed = true;
        await this.handle.close().catch(() => undefined);
        throw error;
      }
    });
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async writeEvent(
    kind: EvidenceEventKind,
    payload: CanonicalJsonValue
  ): Promise<EvidenceEvent> {
    return (await this.writeBatch([{ kind, payload }]))[0];
  }

  private async writeBatch(
    records: readonly Readonly<{ kind: EvidenceEventKind; payload: CanonicalJsonValue }>[]
  ): Promise<readonly EvidenceEvent[]> {
    await this.assertIdentity();
    let sequence = this.sequence;
    let previousHash = this.previousHash;
    const events = records.map(({ kind, payload }) => {
      const unsigned: Omit<EvidenceEvent, 'eventHash'> = {
        schemaVersion: 'meta-mover-evidence/1',
        policyVersion: this.policyVersion,
        jobId: this.jobId,
        sequence: sequence + 1,
        emittedAt: new Date().toISOString(),
        previousHash,
        kind,
        payload,
      };
      const event = deepFreeze({ ...unsigned, eventHash: calculateEventHash(unsigned) });
      const line = canonicalJson(event);
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
        throw new EvidenceManifestError('INVALID_INPUT', 'Evidence event exceeds the size limit');
      }
      sequence = event.sequence;
      previousHash = event.eventHash;
      return { event, line };
    });
    await this.handle.writeFile(`${events.map(({ line }) => line).join('\n')}\n`, 'utf8');
    await this.handle.sync();
    await this.assertIdentity();
    const final = events.at(-1);
    if (final === undefined) {
      throw new EvidenceManifestError('INVALID_INPUT', 'Evidence batch must not be empty');
    }
    this.sequence = final.event.sequence;
    this.previousHash = final.event.eventHash;
    return events.map(({ event }) => event);
  }

  private async assertIdentity(): Promise<void> {
    const directoryPath = path.dirname(this.manifestPath);
    const [held, visible, directory, resolvedDirectory] = await Promise.all([
      this.handle.stat(),
      lstat(this.manifestPath),
      lstat(directoryPath),
      realpath(directoryPath),
    ]);
    const currentUser = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !held.isFile() ||
      held.nlink !== 1 ||
      (process.platform !== 'win32' && (held.mode & 0o077) !== 0) ||
      (currentUser !== null && held.uid !== currentUser) ||
      visible.isSymbolicLink() ||
      !visible.isFile() ||
      visible.nlink !== 1 ||
      (process.platform !== 'win32' && (visible.mode & 0o077) !== 0) ||
      (currentUser !== null && visible.uid !== currentUser) ||
      !sameIdentity(held, this.fileIdentity) ||
      !sameIdentity(visible, this.fileIdentity) ||
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      resolvedDirectory !== directoryPath ||
      (process.platform !== 'win32' && (directory.mode & 0o077) !== 0) ||
      (currentUser !== null && directory.uid !== currentUser) ||
      !sameIdentity(directory, this.directoryIdentity)
    ) {
      throw new EvidenceManifestError(
        'UNSAFE_MANIFEST',
        'Evidence manifest or directory identity was replaced or linked'
      );
    }
  }

  static verify(
    manifestPath: string,
    options?: ManifestVerificationOptions
  ): Promise<ManifestVerification> {
    return this.verifyEnding(manifestPath, 'job-closed', options);
  }

  static verifyPreviewSnapshot(
    manifestPath: string,
    options?: ManifestVerificationOptions
  ): Promise<ManifestVerification> {
    return this.verifyEnding(manifestPath, 'preview-sealed', options);
  }

  private static async verifyEnding(
    manifestPath: string,
    requiredEnding: 'job-closed' | 'preview-sealed',
    options?: ManifestVerificationOptions
  ): Promise<ManifestVerification> {
    let verifiedEvents = 0;
    let handle: FileHandle | undefined;
    try {
      options?.signal?.throwIfAborted();
      const normalizedPath = requireAbsolutePath(manifestPath);
      const directoryPath = path.dirname(normalizedPath);
      const directoryIdentity = await validatePrivateDirectory(directoryPath);
      const before = await lstat(normalizedPath);
      const currentUser = typeof process.getuid === 'function' ? process.getuid() : null;
      if (
        before.isSymbolicLink() ||
        !before.isFile() ||
        before.nlink !== 1 ||
        (process.platform !== 'win32' && (before.mode & 0o077) !== 0) ||
        (currentUser !== null && before.uid !== currentUser)
      ) {
        return invalidVerification(0, 'Manifest leaf is a symlink, hardlink, or non-file');
      }
      handle = await open(normalizedPath, constants.O_RDONLY | NO_FOLLOW);
      const held = await handle.stat();
      if (
        !held.isFile() ||
        held.nlink !== 1 ||
        (process.platform !== 'win32' && (held.mode & 0o077) !== 0) ||
        (currentUser !== null && held.uid !== currentUser) ||
        held.dev !== before.dev ||
        held.ino !== before.ino
      ) {
        return invalidVerification(0, 'Manifest identity changed during open');
      }
      let previousHash = GENESIS_HASH;
      let jobId: string | undefined;
      let policyVersion: string | undefined;
      let lastKind: EvidenceEventKind | undefined;
      const verifyLine = (lineBytes: Buffer): ManifestVerification | undefined => {
        const index = verifiedEvents;
        if (lineBytes.length === 0) return invalidVerification(index, 'Manifest has an empty line');
        let line: string;
        try {
          line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
        } catch {
          return invalidVerification(index, `Invalid UTF-8 at event ${index + 1}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return invalidVerification(index, `Invalid JSON at event ${index + 1}`);
        }
        if (!isEvidenceEvent(parsed)) {
          return invalidVerification(index, `Invalid event schema at event ${index + 1}`);
        }
        let canonicalLine: string;
        try {
          canonicalLine = canonicalJson(parsed);
        } catch (error) {
          return invalidVerification(
            index,
            `Invalid canonical JSON at event ${index + 1}: ${String(error)}`
          );
        }
        if (line !== canonicalLine) {
          return invalidVerification(index, `Non-canonical JSON at event ${index + 1}`);
        }
        const event = parsed;
        try {
          canonicalize(event.payload);
        } catch (error) {
          return invalidVerification(
            index,
            `Invalid payload at event ${index + 1}: ${String(error)}`
          );
        }
        if (event.sequence !== index + 1) {
          return invalidVerification(index, `Invalid sequence at event ${index + 1}`);
        }
        if (event.previousHash !== previousHash) {
          return invalidVerification(index, `Broken chain at event ${index + 1}`);
        }
        if (index === 0) {
          if (event.kind !== 'job-opened') {
            return invalidVerification(0, 'Manifest does not start with job-opened');
          }
          jobId = event.jobId;
          policyVersion = event.policyVersion;
        } else if (event.jobId !== jobId || event.policyVersion !== policyVersion) {
          return invalidVerification(index, `Manifest identity changed at event ${index + 1}`);
        }
        if (lastKind === 'job-closed') {
          return invalidVerification(index, 'Manifest contains events after job-closed');
        }
        const { eventHash, ...unsigned } = event;
        let calculated: string;
        try {
          calculated = calculateEventHash(unsigned);
        } catch (error) {
          return invalidVerification(
            index,
            `Hash input is invalid at event ${index + 1}: ${String(error)}`
          );
        }
        if (calculated !== eventHash) {
          return invalidVerification(index, `Hash mismatch at event ${index + 1}`);
        }
        previousHash = eventHash;
        lastKind = event.kind;
        verifiedEvents = index + 1;
        return undefined;
      };

      const signal = options?.signal;
      const totalBytes = held.size;
      let lastReportAtMs = Number.NaN;
      const report = async (bytesRead: number, force = false): Promise<void> => {
        signal?.throwIfAborted();
        if (force || Number.isNaN(lastReportAtMs) || Date.now() - lastReportAtMs >= 250) {
          lastReportAtMs = Date.now();
          // Awaiting the callback yields to timers even when it returns void,
          // so abort deadlines can interrupt an otherwise CPU-bound pass.
          await options?.onProgress?.({ bytesRead, totalBytes, eventCount: verifiedEvents });
        }
        signal?.throwIfAborted();
      };
      await report(0, true);

      const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      let position = 0;
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      while (position < held.size) {
        const requested = Math.min(READ_CHUNK_BYTES, held.size - position);
        const { bytesRead } = await handle.read(readBuffer, 0, requested, position);
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        position += bytesRead;
        let cursor = 0;
        while (cursor < bytesRead) {
          const newline = readBuffer.indexOf(0x0a, cursor);
          const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
          const piece = Buffer.from(readBuffer.subarray(cursor, end));
          pendingBytes += piece.length;
          if (pendingBytes > MAX_EVENT_BYTES) {
            return invalidVerification(
              verifiedEvents,
              `Event ${verifiedEvents + 1} exceeds the size limit`
            );
          }
          pending.push(piece);
          if (newline === -1 || newline >= bytesRead) break;
          const failure = verifyLine(Buffer.concat(pending, pendingBytes));
          if (failure) return failure;
          pending = [];
          pendingBytes = 0;
          cursor = newline + 1;
        }
        await report(position);
      }
      if (position !== held.size || pendingBytes !== 0) {
        return invalidVerification(
          verifiedEvents,
          'Manifest is truncated or missing its final newline'
        );
      }

      const [after, afterHeld, afterDirectory] = await Promise.all([
        lstat(normalizedPath),
        handle.stat(),
        validatePrivateDirectory(directoryPath),
      ]);
      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.nlink !== 1 ||
        (process.platform !== 'win32' && (after.mode & 0o077) !== 0) ||
        (currentUser !== null && after.uid !== currentUser) ||
        after.dev !== held.dev ||
        after.ino !== held.ino ||
        !afterHeld.isFile() ||
        afterHeld.dev !== held.dev ||
        afterHeld.ino !== held.ino ||
        afterHeld.size !== held.size ||
        afterHeld.mtimeMs !== held.mtimeMs ||
        afterHeld.ctimeMs !== held.ctimeMs ||
        afterDirectory.device !== directoryIdentity.device ||
        afterDirectory.inode !== directoryIdentity.inode
      ) {
        return invalidVerification(verifiedEvents, 'Manifest identity changed during verification');
      }
      if (lastKind !== requiredEnding) {
        return invalidVerification(
          verifiedEvents,
          requiredEnding === 'job-closed'
            ? 'Manifest is not closed'
            : 'Preview snapshot is not sealed'
        );
      }
      await report(position, true);
      return { valid: true, eventCount: verifiedEvents, finalHash: previousHash };
    } catch (error) {
      // Cancellation must surface as a rejection, not as invalid evidence.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (options?.signal?.aborted) options.signal.throwIfAborted();
      return invalidVerification(
        verifiedEvents,
        error instanceof Error ? error.message : 'Manifest cannot be verified'
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

export { canonicalJson, canonicalize, validatePrivateDirectory };
