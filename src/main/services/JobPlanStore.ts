import { createHash, randomUUID } from 'crypto';
import { constants, createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

const SCHEMA_VERSION = 1;
const DEFAULT_CHUNK_SIZE = 1_000;
const MAX_CHUNK_SIZE = 100_000;
const MAX_RECORD_BYTES = 1024 * 1024;
const BLOOM_BYTES = 8 * 1024 * 1024;
const BLOOM_HASHES = 4;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type JobPlanStoreErrorCode =
  | 'NOT_INITIALIZED'
  | 'INVALID_INPUT'
  | 'IDENTITY_MISMATCH'
  | 'POLICY_MISMATCH'
  | 'CORRUPT_STORE'
  | 'DUPLICATE_OPERATION_ID'
  | 'INVALID_TERMINAL_REFERENCE';

export class JobPlanStoreError extends Error {
  public constructor(
    public readonly code: JobPlanStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'JobPlanStoreError';
  }
}

export interface JobPlanInput<T> {
  operationId: string;
  payload: T;
}

export interface JobPlanRecord<T> extends JobPlanInput<T> {
  sequence: number;
}

export interface JobPlanReference {
  sequence: number;
  operationId: string;
}

export interface JobPlanSummary {
  readonly totalRecords: number;
  readonly terminalRecords: number;
  readonly pendingRecords: number;
  readonly chunkCount: number;
  readonly chunkSize: number;
}

export interface JobPlanStoreOptions {
  identity: string;
  policy: string;
  chunkSize?: number;
  testHooks?: {
    afterPlanRecordsSynced?: () => Promise<void>;
    afterTerminalBitmapSynced?: () => Promise<void>;
    beforeCheckpointWrite?: () => Promise<void>;
    beforeTailDelimiterRepair?: () => Promise<void>;
  };
}

export interface JobPlanPageOptions {
  pageSize?: number;
  includeTerminal?: boolean;
}

interface PlanMetadata {
  schemaVersion: typeof SCHEMA_VERSION;
  identity: string;
  policy: string;
  chunkSize: number;
}

interface PlanCheckpoint {
  schemaVersion: typeof SCHEMA_VERSION;
  identity: string;
  policy: string;
  chunkSize: number;
  totalRecords: number;
  terminalRecords: number;
  chunkCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value as object)) return false;
  seen.add(value as object);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonSafe(entry, seen))
    : isPlainObject(value) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === 'string' && isJsonSafe((value as Record<string, unknown>)[key], seen)
      );
  seen.delete(value as object);
  return valid;
}

function validateToken(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096) {
    throw new JobPlanStoreError('INVALID_INPUT', `${field} must be a non-empty bounded string`);
  }
}

function chunkName(index: number): string {
  return `chunk-${index.toString().padStart(8, '0')}.jsonl`;
}

function parseChunkIndex(fileName: string): number | null {
  const match = /^chunk-(\d{8})\.jsonl$/.exec(fileName);
  return match ? Number(match[1]) : null;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, constants.O_RDONLY | NO_FOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JobPlanStore<T> {
  private readonly chunksPath: string;
  private readonly metadataPath: string;
  private readonly checkpointPath: string;
  private readonly terminalPath: string;
  private readonly chunkSize: number;
  private initialized = false;
  private poisoned = false;
  private checkpoint: PlanCheckpoint | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  /** Fixed-size accelerator only; chunks remain the source of truth. */
  private readonly operationBloom = Buffer.alloc(BLOOM_BYTES);

  public constructor(
    private readonly rootPath: string,
    private readonly options: JobPlanStoreOptions
  ) {
    validateToken(rootPath, 'rootPath');
    validateToken(options.identity, 'identity');
    validateToken(options.policy, 'policy');
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (
      !Number.isInteger(this.chunkSize) ||
      this.chunkSize < 1 ||
      this.chunkSize > MAX_CHUNK_SIZE
    ) {
      throw new JobPlanStoreError('INVALID_INPUT', 'chunkSize is outside the supported range');
    }
    this.chunksPath = path.join(rootPath, 'chunks');
    this.metadataPath = path.join(rootPath, 'plan.json');
    this.checkpointPath = path.join(rootPath, 'checkpoint.json');
    this.terminalPath = path.join(rootPath, 'terminal.bin');
  }

  public async initialize(): Promise<void> {
    this.initialized = false;
    this.poisoned = false;
    this.operationBloom.fill(0);
    await fs.mkdir(this.rootPath, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(this.rootPath, DIRECTORY_MODE);
    await fs.mkdir(this.chunksPath, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(this.chunksPath, DIRECTORY_MODE);

    const metadata = await this.loadOrCreateMetadata();
    this.assertMetadata(metadata);
    const recovered = await this.recoverChunksAndIndex();
    const terminalRecords = await this.recoverTerminalBitmap(recovered.totalRecords);
    this.checkpoint = {
      ...metadata,
      totalRecords: recovered.totalRecords,
      terminalRecords,
      chunkCount: recovered.chunkCount,
    };
    await this.writeCheckpoint();
    this.initialized = true;
  }

  public async append(
    inputs: Iterable<JobPlanInput<T>> | AsyncIterable<JobPlanInput<T>>
  ): Promise<void> {
    for await (const _page of this.appendPages(inputs)) {
      // Intentionally discard references so this convenience path stays bounded.
    }
  }

  public async *appendPages(
    inputs: Iterable<JobPlanInput<T>> | AsyncIterable<JobPlanInput<T>>
  ): AsyncGenerator<readonly JobPlanReference[]> {
    this.assertInitialized();
    const release = await this.acquireMutation();
    try {
      let batch: JobPlanInput<T>[] = [];
      for await (const input of inputs as AsyncIterable<JobPlanInput<T>>) {
        this.validateInput(input);
        batch.push(input);
        if (batch.length === this.chunkSize) {
          yield await this.appendBatch(batch);
          batch = [];
        }
      }
      if (batch.length > 0) yield await this.appendBatch(batch);
    } finally {
      release();
    }
  }

  public async markTerminal(
    references: Iterable<JobPlanReference> | AsyncIterable<JobPlanReference>
  ): Promise<void> {
    this.assertInitialized();
    let batch: JobPlanReference[] = [];
    for await (const reference of references as AsyncIterable<JobPlanReference>) {
      batch.push(reference);
      if (batch.length === this.chunkSize) {
        await this.markTerminalBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await this.markTerminalBatch(batch);
  }

  private async markTerminalBatch(references: readonly JobPlanReference[]): Promise<void> {
    await this.withMutation(async () => {
      const unique = new Map<number, JobPlanReference>();
      for (const reference of references) {
        if (
          !reference ||
          !Number.isInteger(reference.sequence) ||
          reference.sequence < 0 ||
          reference.sequence >= this.checkpoint!.totalRecords ||
          typeof reference.operationId !== 'string'
        ) {
          throw new JobPlanStoreError(
            'INVALID_TERMINAL_REFERENCE',
            'Terminal reference is invalid'
          );
        }
        unique.set(reference.sequence, reference);
      }
      const recordsBySequence = await this.readReferencedRecords(unique);
      for (const reference of unique.values()) {
        if (recordsBySequence.get(reference.sequence)?.operationId !== reference.operationId) {
          throw new JobPlanStoreError(
            'INVALID_TERMINAL_REFERENCE',
            `Terminal reference does not match sequence ${reference.sequence}`
          );
        }
      }

      let added = 0;
      try {
        const handle = await fs.open(this.terminalPath, constants.O_RDWR | NO_FOLLOW, FILE_MODE);
        try {
          const byte = Buffer.alloc(1);
          for (const sequence of unique.keys()) {
            const { bytesRead } = await handle.read(byte, 0, 1, sequence);
            if (bytesRead !== 1) {
              throw new JobPlanStoreError(
                'CORRUPT_STORE',
                'Terminal bitmap is shorter than the plan'
              );
            }
            if (byte[0] === 0) {
              byte[0] = 1;
              await handle.write(byte, 0, 1, sequence);
              byte[0] = 0;
              added += 1;
            }
          }
          if (added > 0) {
            await handle.sync();
            await this.options.testHooks?.afterTerminalBitmapSynced?.();
          }
        } finally {
          await handle.close();
        }
        if (added > 0) {
          this.checkpoint!.terminalRecords += added;
          await this.writeCheckpoint();
        }
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
    });
  }

  public async *pages(
    options: JobPlanPageOptions = {}
  ): AsyncGenerator<readonly JobPlanRecord<T>[]> {
    this.assertInitialized();
    const pageSize = options.pageSize ?? this.chunkSize;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_CHUNK_SIZE) {
      throw new JobPlanStoreError('INVALID_INPUT', 'pageSize is outside the supported range');
    }
    const includeTerminal = options.includeTerminal ?? false;
    const terminal = await fs.open(this.terminalPath, constants.O_RDONLY | NO_FOLLOW);
    let page: JobPlanRecord<T>[] = [];
    try {
      for (let chunkIndex = 0; chunkIndex < this.checkpoint!.chunkCount; chunkIndex += 1) {
        const firstSequence = chunkIndex * this.chunkSize;
        const stateLength = Math.min(this.chunkSize, this.checkpoint!.totalRecords - firstSequence);
        const states = Buffer.alloc(stateLength);
        if (!includeTerminal) {
          const { bytesRead } = await terminal.read(states, 0, stateLength, firstSequence);
          if (bytesRead !== stateLength) {
            throw new JobPlanStoreError(
              'CORRUPT_STORE',
              'Terminal bitmap is shorter than the plan'
            );
          }
        }
        for await (const record of this.readChunk(chunkIndex)) {
          if (!includeTerminal && states[record.sequence - firstSequence] === 1) continue;
          page.push(record);
          if (page.length === pageSize) {
            yield page;
            page = [];
          }
        }
      }
      if (page.length > 0) yield page;
    } finally {
      await terminal.close();
    }
  }

  public async getSummary(): Promise<JobPlanSummary> {
    this.assertInitialized();
    const checkpoint = this.checkpoint!;
    return Object.freeze({
      totalRecords: checkpoint.totalRecords,
      terminalRecords: checkpoint.terminalRecords,
      pendingRecords: checkpoint.totalRecords - checkpoint.terminalRecords,
      chunkCount: checkpoint.chunkCount,
      chunkSize: checkpoint.chunkSize,
    });
  }

  private async withMutation<R>(operation: () => Promise<R>): Promise<R> {
    const release = await this.acquireMutation();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async acquireMutation(): Promise<() => void> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private assertInitialized(): void {
    if (this.poisoned) {
      throw new JobPlanStoreError(
        'CORRUPT_STORE',
        'Store must be reinitialized after an I/O failure'
      );
    }
    if (!this.initialized || !this.checkpoint) {
      throw new JobPlanStoreError('NOT_INITIALIZED', 'Job plan store is not initialized');
    }
  }

  private validateInput(input: JobPlanInput<T>): void {
    if (!isPlainObject(input) || typeof input.operationId !== 'string') {
      throw new JobPlanStoreError('INVALID_INPUT', 'Plan input is invalid');
    }
    validateToken(input.operationId, 'operationId');
    if (!isJsonSafe(input.payload)) {
      throw new JobPlanStoreError('INVALID_INPUT', 'Plan payload must be JSON-safe');
    }
  }

  private async appendBatch(inputs: readonly JobPlanInput<T>[]): Promise<JobPlanReference[]> {
    const references: JobPlanReference[] = [];
    const incomingIds = new Set<string>();
    for (const input of inputs) {
      if (incomingIds.has(input.operationId) || (await this.lookupOperation(input.operationId))) {
        throw new JobPlanStoreError(
          'DUPLICATE_OPERATION_ID',
          `Operation ID already exists: ${input.operationId}`
        );
      }
      incomingIds.add(input.operationId);
      const sequence = this.checkpoint!.totalRecords + references.length;
      references.push({ sequence, operationId: input.operationId });
    }

    try {
      await this.appendRecords(
        inputs.map((input, index) => ({
          sequence: references[index].sequence,
          operationId: input.operationId,
          payload: input.payload,
        }))
      );
      await this.options.testHooks?.afterPlanRecordsSynced?.();
      const terminal = await fs.open(
        this.terminalPath,
        constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW
      );
      try {
        await terminal.write(Buffer.alloc(inputs.length));
        await terminal.sync();
      } finally {
        await terminal.close();
      }
      references.forEach((reference) => this.addToBloom(reference.operationId));
      this.checkpoint!.totalRecords += inputs.length;
      this.checkpoint!.chunkCount = Math.ceil(this.checkpoint!.totalRecords / this.chunkSize);
      await this.writeCheckpoint();
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
    return references;
  }

  private async appendRecords(records: readonly JobPlanRecord<T>[]): Promise<void> {
    const grouped = new Map<number, string[]>();
    for (const record of records) {
      const serialized = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
        throw new JobPlanStoreError('INVALID_INPUT', 'Serialized plan record exceeds 1 MiB');
      }
      const chunkIndex = Math.floor(record.sequence / this.chunkSize);
      const lines = grouped.get(chunkIndex) ?? [];
      lines.push(serialized);
      grouped.set(chunkIndex, lines);
    }
    for (const [chunkIndex, lines] of grouped) {
      const target = path.join(this.chunksPath, chunkName(chunkIndex));
      const handle = await fs.open(
        target,
        constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW,
        FILE_MODE
      );
      try {
        await handle.write(lines.join(''));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  private async lookupOperation(operationId: string): Promise<boolean> {
    if (!this.mightContainOperation(operationId)) return false;
    for (let chunkIndex = 0; chunkIndex < this.checkpoint!.chunkCount; chunkIndex += 1) {
      for await (const record of this.readChunk(chunkIndex)) {
        if (record.operationId === operationId) return true;
      }
    }
    return false;
  }

  private bloomPositions(operationId: string): number[] {
    const digest = createHash('sha256').update(operationId).digest();
    const bitCount = BLOOM_BYTES * 8;
    const first = digest.readUInt32BE(0);
    const second = digest.readUInt32BE(4) || 1;
    return Array.from({ length: BLOOM_HASHES }, (_, index) => (first + index * second) % bitCount);
  }

  private mightContainOperation(operationId: string): boolean {
    return this.bloomPositions(operationId).every(
      (position) => (this.operationBloom[position >>> 3] & (1 << (position & 7))) !== 0
    );
  }

  private addToBloom(operationId: string): void {
    for (const position of this.bloomPositions(operationId)) {
      this.operationBloom[position >>> 3] |= 1 << (position & 7);
    }
  }

  private async loadOrCreateMetadata(): Promise<PlanMetadata> {
    try {
      return JSON.parse(await fs.readFile(this.metadataPath, 'utf8')) as PlanMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new JobPlanStoreError('CORRUPT_STORE', 'Plan metadata cannot be decoded');
      }
      const metadata: PlanMetadata = {
        schemaVersion: SCHEMA_VERSION,
        identity: this.options.identity,
        policy: this.options.policy,
        chunkSize: this.chunkSize,
      };
      await this.atomicWrite(this.metadataPath, metadata);
      return metadata;
    }
  }

  private assertMetadata(metadata: PlanMetadata): void {
    if (
      !isPlainObject(metadata) ||
      metadata.schemaVersion !== SCHEMA_VERSION ||
      !Number.isInteger(metadata.chunkSize) ||
      metadata.chunkSize < 1
    ) {
      throw new JobPlanStoreError('CORRUPT_STORE', 'Plan metadata is invalid');
    }
    if (metadata.identity !== this.options.identity) {
      throw new JobPlanStoreError('IDENTITY_MISMATCH', 'Plan source identity does not match');
    }
    if (metadata.policy !== this.options.policy) {
      throw new JobPlanStoreError('POLICY_MISMATCH', 'Plan policy does not match');
    }
    if (metadata.chunkSize !== this.chunkSize) {
      throw new JobPlanStoreError('POLICY_MISMATCH', 'Plan chunk size does not match');
    }
  }

  private async recoverChunksAndIndex(): Promise<{ totalRecords: number; chunkCount: number }> {
    const files = await fs.readdir(this.chunksPath);
    const indices = files
      .map(parseChunkIndex)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);
    for (let index = 0; index < indices.length; index += 1) {
      if (indices[index] !== index) {
        throw new JobPlanStoreError('CORRUPT_STORE', 'Plan chunks are not contiguous');
      }
    }

    let expectedSequence = 0;
    for (const chunkIndex of indices) {
      let count = 0;
      for await (const record of this.readChunk(chunkIndex, chunkIndex === indices.length - 1)) {
        if (record.sequence !== expectedSequence) {
          throw new JobPlanStoreError('CORRUPT_STORE', 'Plan record sequence is not contiguous');
        }
        if (Math.floor(record.sequence / this.chunkSize) !== chunkIndex) {
          throw new JobPlanStoreError('CORRUPT_STORE', 'Plan record is stored in the wrong chunk');
        }
        if (
          this.mightContainOperation(record.operationId) &&
          (await this.operationExistsBefore(record.operationId, record.sequence))
        ) {
          throw new JobPlanStoreError('CORRUPT_STORE', 'Plan contains a duplicate operation ID');
        }
        this.addToBloom(record.operationId);
        expectedSequence += 1;
        count += 1;
      }
      if (count > this.chunkSize || (chunkIndex < indices.length - 1 && count !== this.chunkSize)) {
        throw new JobPlanStoreError('CORRUPT_STORE', 'Plan chunk has an invalid record count');
      }
    }
    return { totalRecords: expectedSequence, chunkCount: indices.length };
  }

  private async operationExistsBefore(operationId: string, sequence: number): Promise<boolean> {
    const lastChunk = Math.floor(sequence / this.chunkSize);
    for (let chunkIndex = 0; chunkIndex <= lastChunk; chunkIndex += 1) {
      for await (const record of this.readChunk(chunkIndex)) {
        if (record.sequence >= sequence) return false;
        if (record.operationId === operationId) return true;
      }
    }
    return false;
  }

  private async *readChunk(
    chunkIndex: number,
    repairTornTail = false
  ): AsyncGenerator<JobPlanRecord<T>> {
    const target = path.join(this.chunksPath, chunkName(chunkIndex));
    const input = createReadStream(target);
    let validBytes = 0;
    let pending: Buffer = Buffer.alloc(0);
    try {
      for await (const rawChunk of input) {
        const chunk = rawChunk as Buffer;
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        let newline = pending.indexOf(0x0a);
        while (newline >= 0) {
          if (newline > MAX_RECORD_BYTES) {
            throw new JobPlanStoreError('CORRUPT_STORE', 'Plan record exceeds 1 MiB');
          }
          const line = pending.subarray(0, newline).toString('utf8');
          pending = pending.subarray(newline + 1);
          validBytes += newline + 1;
          if (line.length > 0) yield this.decodeRecord(line, chunkIndex);
          newline = pending.indexOf(0x0a);
        }
        if (pending.length > MAX_RECORD_BYTES) {
          throw new JobPlanStoreError('CORRUPT_STORE', 'Plan record exceeds 1 MiB');
        }
      }
      if (pending.length > 0) {
        let record: JobPlanRecord<T>;
        try {
          record = this.decodeRecord(pending.toString('utf8'), chunkIndex);
        } catch (error) {
          if (!repairTornTail) throw error;
          await fs.truncate(target, validBytes);
          return;
        }
        if (repairTornTail) {
          await this.options.testHooks?.beforeTailDelimiterRepair?.();
          const handle = await fs.open(target, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW);
          try {
            const { bytesWritten } = await handle.write('\n');
            if (bytesWritten !== 1) {
              throw new JobPlanStoreError('CORRUPT_STORE', 'Could not repair plan record framing');
            }
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        yield record;
      }
    } finally {
      input.destroy();
    }
  }

  private decodeRecord(line: string, chunkIndex: number): JobPlanRecord<T> {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new JobPlanStoreError('CORRUPT_STORE', `Invalid JSON in ${chunkName(chunkIndex)}`);
    }
    if (
      !isPlainObject(record) ||
      !Number.isInteger(record.sequence) ||
      typeof record.operationId !== 'string' ||
      !Object.prototype.hasOwnProperty.call(record, 'payload') ||
      !isJsonSafe(record.payload)
    ) {
      throw new JobPlanStoreError('CORRUPT_STORE', 'Plan record is invalid');
    }
    return record as unknown as JobPlanRecord<T>;
  }

  private async readReferencedRecords(
    references: ReadonlyMap<number, JobPlanReference>
  ): Promise<Map<number, JobPlanRecord<T>>> {
    const byChunk = new Map<number, Set<number>>();
    for (const sequence of references.keys()) {
      const chunkIndex = Math.floor(sequence / this.chunkSize);
      const sequences = byChunk.get(chunkIndex) ?? new Set<number>();
      sequences.add(sequence);
      byChunk.set(chunkIndex, sequences);
    }
    const found = new Map<number, JobPlanRecord<T>>();
    for (const [chunkIndex, sequences] of byChunk) {
      for await (const record of this.readChunk(chunkIndex)) {
        if (sequences.has(record.sequence)) found.set(record.sequence, record);
      }
    }
    return found;
  }

  private async recoverTerminalBitmap(totalRecords: number): Promise<number> {
    const handle = await fs.open(
      this.terminalPath,
      constants.O_CREAT | constants.O_RDWR | NO_FOLLOW,
      FILE_MODE
    );
    let terminalRecords = 0;
    try {
      const stat = await handle.stat();
      if (stat.size > totalRecords) await handle.truncate(totalRecords);
      if (stat.size < totalRecords) {
        const zeroes = Buffer.alloc(Math.min(this.chunkSize, totalRecords - stat.size));
        let extensionPosition = stat.size;
        while (extensionPosition < totalRecords) {
          const length = Math.min(zeroes.length, totalRecords - extensionPosition);
          await handle.write(zeroes, 0, length, extensionPosition);
          extensionPosition += length;
        }
      }
      const buffer = Buffer.alloc(Math.min(this.chunkSize, Math.max(totalRecords, 1)));
      let position = 0;
      while (position < totalRecords) {
        const length = Math.min(buffer.length, totalRecords - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead !== length) {
          throw new JobPlanStoreError('CORRUPT_STORE', 'Terminal bitmap cannot be recovered');
        }
        for (let index = 0; index < length; index += 1) {
          if (buffer[index] === 1) terminalRecords += 1;
          else if (buffer[index] !== 0) {
            throw new JobPlanStoreError('CORRUPT_STORE', 'Terminal bitmap contains invalid state');
          }
        }
        position += length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return terminalRecords;
  }

  private async writeCheckpoint(): Promise<void> {
    await this.options.testHooks?.beforeCheckpointWrite?.();
    await this.atomicWrite(this.checkpointPath, this.checkpoint!);
  }

  private async atomicWrite(target: string, value: unknown): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
      FILE_MODE
    );
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    await fs.chmod(target, FILE_MODE);
    await syncDirectory(this.rootPath);
  }
}
