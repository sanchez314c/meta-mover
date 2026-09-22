import { createHash, randomUUID } from 'crypto';
import { lstat, realpath } from 'fs/promises';
import path from 'path';

import {
  resolveDateCandidates,
  type DateCandidateInput,
  type DateResolutionRecord,
  type JsonValue,
  type MediaKind,
} from '../core/date';
import type { MetadataCollectionResult } from '../core/metadata/MetadataCandidateCollector';
import { MediaPlanner } from '../core/planning/MediaPlanner';
import { hashFile } from '../core/transaction/Hashing';
import type {
  TransactionRequest,
  TransactionResult,
} from '../core/transaction/TransactionalFileCore';
import {
  CancellationFileState,
  OperationMode,
  ProcessingEventKind,
  type PreviewRowDTO,
  type ProcessingEvent,
} from '../../shared/types/processing';
import type {
  ReviewAction,
  ReviewApplyRequestDTO,
  ReviewApplyResultDTO,
  ReviewDryRunDTO,
  ReviewDryRunRequestDTO,
  ReviewEvidenceSnapshot,
  ReviewItemDTO,
  ReviewListRequestDTO,
  ReviewOutputBinding,
  ReviewOverrideRecord,
  ReviewPageDTO,
} from '../../shared/types/review';

interface HistorySnapshot {
  readonly jobId: string;
  readonly previewId: string;
  readonly destinationPath: string;
  readonly effectiveOptions: {
    operation: OperationMode;
    conflictPolicy: PreviewRowDTO['conflictPolicy'];
    folderStructure: import('../../shared/types/processing').FolderStructure;
    appendScreenshotSuffix: boolean;
  };
  readonly previewRows?: readonly Readonly<PreviewRowDTO>[];
  readonly events: readonly Readonly<ProcessingEvent>[];
}

export interface ReviewHistoryPort {
  listJobs(): Promise<readonly HistorySnapshot[]>;
}
export interface ReviewAuditPort {
  reviewPage?(request: Readonly<{ previewId: string; limit: number; cursor?: string }>): Promise<{
    revision: string;
    items: Array<{
      recordId: string;
      sourcePath: string;
      outputPath: string;
      mediaKind: MediaKind;
      resolution: DateResolutionRecord;
    }>;
    nextCursor?: string;
  }>;
  reviewInput(
    request: Readonly<{ previewId: string; sourcePath: string; outputPath: string }>
  ): Promise<{
    revision: string;
    input: {
      recordId: string;
      sourcePath: string;
      outputPath: string;
      mediaKind: MediaKind;
      resolution: DateResolutionRecord;
    };
  } | null>;
}
export interface ReviewOverridePort {
  list(): Promise<ReviewOverrideRecord[]>;
  get(reviewId: string): Promise<ReviewOverrideRecord | null>;
  append(record: ReviewOverrideRecord): Promise<ReviewOverrideRecord>;
}
export interface ReviewMetadataCollectorPort {
  collectDetailed(
    request: Readonly<{
      fileId: string;
      filePath: string;
      verifiedExtractionPath: string;
      expectedContentSha256: string;
      expectedContentBytes: number;
      mediaKind: MediaKind;
    }>
  ): Promise<MetadataCollectionResult>;
}
interface ReviewTransactionCorePort {
  execute(request: TransactionRequest): Promise<TransactionResult>;
  close(): Promise<void>;
}

export interface ReviewRemediationServiceOptions {
  history: ReviewHistoryPort;
  audit: ReviewAuditPort;
  overrides: ReviewOverridePort;
  metadataCollector?: ReviewMetadataCollectorPort;
  coreFactory: (destinationRoot: string) => Promise<ReviewTransactionCorePort>;
  planner?: MediaPlanner;
  now?: () => Date;
  outputBinding?: (filePath: string) => Promise<ReviewOutputBinding>;
}

export class ReviewCommittedPersistenceError extends Error {
  readonly code = 'REVIEW_COMMITTED_PERSISTENCE_FAILED';
  public readonly cause: unknown;
  constructor(
    public readonly reviewId: string,
    public readonly transactionId: string,
    public readonly resolvedPath: string,
    cause: unknown
  ) {
    super(
      `review transaction committed at ${resolvedPath}, but override persistence failed; reconcile transaction ${transactionId}`
    );
    this.name = 'ReviewCommittedPersistenceError';
    this.cause = cause;
  }
}

interface LocatedItem {
  item: ReviewItemDTO;
  row: Readonly<PreviewRowDTO>;
  options: HistorySnapshot['effectiveOptions'];
}

interface ReviewDescriptor {
  id: string;
  job: HistorySnapshot;
  row: Readonly<PreviewRowDTO>;
  rowIndex: number;
  audit: NonNullable<Awaited<ReturnType<ReviewAuditPort['reviewInput']>>>;
  override?: ReviewOverrideRecord;
  status: ReviewItemDTO['status'];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function reviewId(jobId: string, rowIndex: number): string {
  return `review-${digest({ jobId, rowIndex }).slice(0, 32)}`;
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function terminalCommittedRows(job: HistorySnapshot): Set<number> {
  const rows = job.previewRows ?? [];
  const terminal = job.events.at(-1);
  const committed = new Set<number>();
  if (!terminal) return committed;
  if (terminal.kind === ProcessingEventKind.JOB_COMPLETED) {
    rows.forEach((row, index) => {
      if (row.operation !== 'skip' && row.targetPath !== null) committed.add(index);
    });
    return committed;
  }
  if (terminal.kind === ProcessingEventKind.JOB_PARTIALLY_COMPLETED) {
    rows.forEach((row, index) => {
      const outcome = terminal.payload.fileOutcomes[index];
      if (
        row.targetPath !== null &&
        outcome?.sourcePath === row.sourcePath &&
        outcome.destinationPath === row.targetPath &&
        outcome.plannedBytes === row.fingerprint.size &&
        outcome.committedBytes === row.fingerprint.size &&
        (outcome.state === CancellationFileState.COMPLETED ||
          outcome.state === CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED)
      )
        committed.add(index);
    });
    return committed;
  }
  if (terminal.kind === ProcessingEventKind.JOB_CANCELLED) {
    rows.forEach((row, index) => {
      const outcome = terminal.payload.fileOutcomes[index];
      if (
        row.targetPath !== null &&
        outcome?.sourcePath === row.sourcePath &&
        outcome.destinationPath === row.targetPath &&
        outcome.committedBytes === row.fingerprint.size &&
        (outcome.state === CancellationFileState.COMPLETED ||
          outcome.state === CancellationFileState.DESTINATION_COMMITTED_SOURCE_RETAINED)
      )
        committed.add(index);
    });
  }
  return committed;
}

async function binding(filePath: string): Promise<ReviewOutputBinding> {
  const stats = await lstat(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n)
    throw new Error('review output identity is not a regular file');
  if ((await realpath(filePath)) !== filePath)
    throw new Error('review output path is not canonical');
  return {
    path: filePath,
    device: Number(stats.dev),
    inode: Number(stats.ino),
    size: Number(stats.size),
    modifiedTimeMs: Number(stats.mtimeNs) / 1_000_000,
    mtimeNs: stats.mtimeNs.toString(),
    sha256: await hashFile(filePath),
  };
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameBinding(left: ReviewOutputBinding, right: ReviewOutputBinding): boolean {
  return (
    left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.sha256 === right.sha256
  );
}

function sameFileIdentity(left: ReviewOutputBinding, right: ReviewOutputBinding): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.sha256 === right.sha256
  );
}

function selectedResolution(
  evidence: ReviewEvidenceSnapshot,
  action: Extract<ReviewAction, { type: 'select-candidate' | 'manual-date' }>
): DateResolutionRecord {
  const original = evidence.resolution;
  let candidate: DateCandidateInput;
  if (action.type === 'select-candidate') {
    const found = original.candidates.find((entry) => entry.id === action.candidateId);
    if (!found) throw new Error('selected candidate does not exist in this evidence revision');
    if (found.eligibility !== 'eligible') throw new Error('selected candidate is not eligible');
    candidate = {
      id: found.id,
      fileId: found.fileId,
      mediaKind: found.mediaKind,
      semantic: found.semantic,
      sourceKind: found.sourceKind,
      sourceFamily: found.sourceFamily,
      tag: found.tag,
      rawValue: clone(found.rawValue),
      value: clone(found.value),
      ...(found.issues ? { issues: [...found.issues] } : {}),
    };
  } else {
    const semantic =
      original.mediaKind === 'audio'
        ? 'recording'
        : original.mediaKind === 'image' ||
            original.mediaKind === 'raw' ||
            original.mediaKind === 'video'
          ? 'capture'
          : 'content-created';
    candidate = {
      id: `${original.fileId}:user-override`,
      fileId: original.fileId,
      mediaKind: original.mediaKind,
      semantic,
      sourceKind: 'user-override',
      sourceFamily: 'user-override',
      tag: 'UserOverride:CreationDate',
      rawValue: JSON.parse(JSON.stringify(action.value)) as JsonValue,
      value: clone(action.value),
    };
  }
  const resolution = resolveDateCandidates({
    fileId: original.fileId,
    mediaKind: original.mediaKind,
    evaluationTimeUtc: original.evaluationTimeUtc,
    candidates: [candidate],
  });
  if (resolution.status !== 'resolved')
    throw new Error('review action did not produce a trusted resolution');
  return resolution;
}

export class ReviewRemediationService {
  private readonly initialBindings = new Map<string, ReviewOutputBinding>();
  private readonly planner: MediaPlanner;
  private readonly now: () => Date;
  private readonly outputBinding: (filePath: string) => Promise<ReviewOutputBinding>;
  constructor(private readonly options: ReviewRemediationServiceOptions) {
    this.planner = options.planner ?? new MediaPlanner();
    this.now = options.now ?? (() => new Date());
    this.outputBinding = options.outputBinding ?? binding;
  }

  withMetadataCollector(metadataCollector: ReviewMetadataCollectorPort): ReviewRemediationService {
    const service = new ReviewRemediationService({
      ...this.options,
      metadataCollector,
      planner: this.planner,
      now: this.now,
      outputBinding: this.outputBinding,
    });
    for (const [key, value] of this.initialBindings) service.initialBindings.set(key, clone(value));
    return service;
  }

  async list(request: ReviewListRequestDTO): Promise<ReviewPageDTO> {
    const descriptors = await this.descriptors();
    const selectedStatuses = request.statuses ?? (request.status ? [request.status] : undefined);
    const filtered =
      selectedStatuses === undefined
        ? descriptors
        : descriptors.filter((entry) => selectedStatuses.includes(entry.status));
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > filtered.length)
      throw new Error('review cursor is invalid');
    const page = await Promise.all(
      filtered.slice(offset, offset + request.limit).map((entry) => this.materialize(entry))
    );
    const next = offset + page.length;
    return {
      items: page.map((entry) => entry.item),
      ...(next < filtered.length ? { nextCursor: String(next) } : {}),
    };
  }

  async get(id: string): Promise<ReviewItemDTO | null> {
    const descriptor = (await this.descriptors(id))[0];
    return descriptor ? (await this.materialize(descriptor)).item : null;
  }

  async dryRun(request: ReviewDryRunRequestDTO): Promise<ReviewDryRunDTO> {
    const located = await this.locate(request.reviewId);
    if (located.item.evidence.revision !== request.evidenceRevision)
      throw new Error('review evidence revision is stale');
    return this.buildPlan(located, request.action);
  }

  async apply(request: ReviewApplyRequestDTO): Promise<ReviewApplyResultDTO> {
    const located = await this.locate(request.reviewId);
    if (located.item.evidence.revision !== request.evidenceRevision)
      throw new Error('review evidence revision is stale');
    const plan = await this.buildPlan(located, request.action);
    if (plan.collision) throw new Error('review destination collision detected');
    if (plan.planToken !== request.planToken)
      throw new Error('review plan token is stale or invalid');
    const sequence = ((await this.options.overrides.get(request.reviewId))?.sequence ?? 0) + 1;
    const base = {
      schemaVersion: 1 as const,
      eventId: randomUUID(),
      reviewId: located.item.reviewId,
      sequence,
      recordedAt: this.timestamp(),
      jobId: located.item.jobId,
      previewId: located.item.previewId,
      rowIndex: located.item.rowIndex,
      output: clone(located.item.output),
      evidenceRevision: located.item.evidence.revision,
      action: clone(request.action),
    };

    if (request.action.type === 'keep') {
      await this.options.overrides.append({
        ...base,
        result: { status: 'kept', currentPath: located.item.currentPath },
      });
      return {
        reviewId: located.item.reviewId,
        status: 'kept',
        currentPath: located.item.currentPath,
        evidenceRevision: located.item.evidence.revision,
      };
    }
    if (request.action.type === 'retry-metadata') {
      if (!plan.refreshedEvidence)
        throw new Error('metadata retry did not produce refreshed evidence');
      await this.options.overrides.append({
        ...base,
        result: {
          status: 'pending',
          currentPath: located.item.currentPath,
          refreshedEvidence: plan.refreshedEvidence,
        },
      });
      return {
        reviewId: located.item.reviewId,
        status: 'pending',
        currentPath: located.item.currentPath,
        evidenceRevision: plan.refreshedEvidence.revision,
      };
    }

    const targetPath = plan.targetPath!;
    const operationId = `review-${randomUUID()}`;
    await this.options.overrides.append({
      ...base,
      result: {
        status: 'reconciling',
        currentPath: located.item.currentPath,
        targetPath,
        transactionId: operationId,
      },
    });
    const terminalBase = { ...base, eventId: randomUUID(), sequence: sequence + 1 };
    let committedReceipt = false;
    let committedClaim = false;
    let core: ReviewTransactionCorePort | undefined;
    try {
      core = await this.options.coreFactory(located.item.destinationRoot);
      const stats = await lstat(located.item.currentPath, { bigint: true });
      const result = await core.execute({
        operationId,
        sourcePath: located.item.currentPath,
        targetFilename: path.relative(located.item.destinationRoot, targetPath),
        expectedDestinationPath: targetPath,
        collisionMode: 'exact-no-clobber',
        expectedSourceIdentity: {
          device: Number(stats.dev),
          inode: Number(stats.ino),
          links: Number(stats.nlink),
          size: Number(stats.size),
          modifiedTimeMs: Number(stats.mtimeNs) / 1_000_000,
        },
        expectedSha256: located.item.output.sha256,
        mode: 'move',
      });
      committedClaim = result.committed;
      if (
        result.operationId === operationId &&
        result.sourcePath === located.item.currentPath &&
        result.status === 'moved' &&
        result.committed &&
        !result.sourceRetained &&
        result.destinationPath === targetPath &&
        result.hash === located.item.output.sha256 &&
        result.bytes === located.item.output.size
      ) {
        committedReceipt = true;
        await this.options.overrides.append({
          ...terminalBase,
          result: {
            status: 'resolved',
            previousPath: located.item.currentPath,
            resolvedPath: targetPath,
            transactionId: result.operationId,
          },
        });
        return {
          reviewId: located.item.reviewId,
          status: 'resolved',
          currentPath: targetPath,
          resolvedPath: targetPath,
          evidenceRevision: located.item.evidence.revision,
        };
      }
      const error = result.error ?? 'review transaction failed before commit';
      if (committedClaim) {
        throw new ReviewCommittedPersistenceError(
          located.item.reviewId,
          result.operationId,
          result.destinationPath ?? targetPath,
          new Error(`committed transaction receipt was invalid: ${error}`)
        );
      }
      await this.options.overrides.append({
        ...terminalBase,
        result: { status: 'failed', currentPath: located.item.currentPath, error },
      });
      return {
        reviewId: located.item.reviewId,
        status: 'failed',
        currentPath: located.item.currentPath,
        evidenceRevision: located.item.evidence.revision,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (committedReceipt) {
        throw new ReviewCommittedPersistenceError(
          located.item.reviewId,
          operationId,
          targetPath,
          error
        );
      }
      if (committedClaim || error instanceof ReviewCommittedPersistenceError) throw error;
      const [sourceState, targetState] = await Promise.all([
        binding(located.item.currentPath).catch(() => null),
        binding(targetPath).catch(() => null),
      ]);
      const sourceStillBound =
        sourceState !== null && sameBinding(sourceState, located.item.output);
      if (!sourceStillBound || targetState !== null) {
        throw new ReviewCommittedPersistenceError(
          located.item.reviewId,
          operationId,
          targetPath,
          error
        );
      }
      await this.options.overrides.append({
        ...terminalBase,
        result: { status: 'failed', currentPath: located.item.currentPath, error: message },
      });
      return {
        reviewId: located.item.reviewId,
        status: 'failed',
        currentPath: located.item.currentPath,
        evidenceRevision: located.item.evidence.revision,
      };
    } finally {
      await core?.close();
    }
  }

  private async buildPlan(located: LocatedItem, action: ReviewAction): Promise<ReviewDryRunDTO> {
    let targetPath: string | null = null;
    let refreshedEvidence: ReviewEvidenceSnapshot | undefined;
    if (action.type === 'select-candidate' || action.type === 'manual-date') {
      const resolution = selectedResolution(located.item.evidence, action);
      const planned = this.planner.planForExecution({
        sourcePath: located.item.currentPath,
        destinationRoot: located.item.destinationRoot,
        mediaKind: located.item.mediaKind,
        resolution,
        operation: OperationMode.MOVE,
        conflictPolicy: located.row.conflictPolicy,
        folderStructure: located.options.folderStructure,
        appendScreenshotSuffix: located.options.appendScreenshotSuffix,
        screenshotDetected: located.item.screenshotDetected,
      });
      if (planned.needsReview) throw new Error('review action still requires review');
      targetPath = planned.targetPath;
      if (
        path.resolve(targetPath) !== targetPath ||
        !contained(located.item.destinationRoot, targetPath)
      )
        throw new Error('review target is outside its canonical destination root');
    } else if (action.type === 'retry-metadata') {
      const collector = this.options.metadataCollector;
      if (!collector) throw new Error('metadata retry is unavailable');
      const collected = await collector.collectDetailed({
        fileId: located.item.evidence.resolution.fileId,
        filePath: located.item.currentPath,
        verifiedExtractionPath: located.item.currentPath,
        expectedContentSha256: located.item.output.sha256,
        expectedContentBytes: located.item.output.size,
        mediaKind: located.item.mediaKind,
      });
      const resolution = resolveDateCandidates({
        fileId: located.item.evidence.resolution.fileId,
        mediaKind: located.item.mediaKind,
        evaluationTimeUtc: located.item.evidence.resolution.evaluationTimeUtc,
        candidates: collected.candidates,
      });
      refreshedEvidence = {
        revision: digest(resolution),
        resolution,
        collectedAt: this.timestamp(),
      };
    }
    const collision =
      targetPath === null
        ? false
        : await lstat(targetPath).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            }
          );
    const warnings = collision
      ? ['Destination already exists; exact-no-clobber apply is blocked.']
      : [];
    const planToken = digest({
      reviewId: located.item.reviewId,
      evidenceRevision: located.item.evidence.revision,
      action,
      output: located.item.output,
      targetPath,
      ...(refreshedEvidence ? { refreshedRevision: refreshedEvidence.revision } : {}),
    });
    return {
      planToken,
      action: clone(action),
      currentPath: located.item.currentPath,
      targetPath,
      collision,
      warnings,
      ...(refreshedEvidence ? { refreshedEvidence } : {}),
    };
  }

  private async locate(id: string): Promise<LocatedItem> {
    const descriptor = (await this.descriptors(id))[0];
    const found = descriptor ? await this.materialize(descriptor) : undefined;
    if (!found) throw new Error('review item does not exist');
    if (found.item.status === 'stale') throw new Error('review output identity is stale');
    if (!['pending', 'failed'].includes(found.item.status))
      throw new Error('review item is already terminal');
    return found;
  }

  private async descriptors(exactId?: string): Promise<ReviewDescriptor[]> {
    const [jobs, overrideList] = await Promise.all([
      this.options.history.listJobs(),
      this.options.overrides.list(),
    ]);
    const overrides = new Map(overrideList.map((entry) => [entry.reviewId, entry]));
    const catalogs = new Map<
      string,
      Map<string, Awaited<ReturnType<ReviewAuditPort['reviewInput']>>>
    >();
    if (this.options.audit.reviewPage && exactId === undefined) {
      for (const previewId of new Set(jobs.map((job) => job.previewId))) {
        const catalog = new Map<string, Awaited<ReturnType<ReviewAuditPort['reviewInput']>>>();
        let cursor: string | undefined;
        do {
          const page = await this.options.audit.reviewPage({
            previewId,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          for (const input of page.items) {
            const key = `${input.sourcePath}\0${input.outputPath}`;
            if (catalog.has(key))
              throw new Error('audit review input binding is ambiguous or corrupt');
            catalog.set(key, { revision: page.revision, input });
          }
          cursor = page.nextCursor;
        } while (cursor);
        catalogs.set(previewId, catalog);
      }
    }
    const items: ReviewDescriptor[] = [];
    for (const job of jobs) {
      if (path.resolve(job.destinationPath) !== job.destinationPath)
        throw new Error('review destination root is not canonical');
      if ((await realpath(job.destinationPath)) !== job.destinationPath)
        throw new Error('review destination root identity is not canonical');
      const committed = terminalCommittedRows(job);
      for (const rowIndex of committed) {
        const row = job.previewRows![rowIndex];
        if (!row.targetPath) continue;
        if (
          path.resolve(row.targetPath) !== row.targetPath ||
          !contained(job.destinationPath, row.targetPath)
        )
          throw new Error('committed review output is outside its destination root');
        const id = reviewId(job.jobId, rowIndex);
        if (exactId !== undefined && id !== exactId) continue;
        const audit =
          this.options.audit.reviewPage && exactId === undefined
            ? (catalogs.get(job.previewId)?.get(`${row.sourcePath}\0${row.targetPath}`) ?? null)
            : await this.options.audit.reviewInput({
                previewId: job.previewId,
                sourcePath: row.sourcePath,
                outputPath: row.targetPath,
              });
        if (!audit || audit.input.resolution.status === 'resolved') continue;
        let override = overrides.get(id);
        if (override) this.validateOverride(override, job, row, rowIndex, audit.input.outputPath);
        if (override?.result.status === 'reconciling') {
          override = await this.reconcileOverride(override);
        }
        if (override?.result.status === 'reconciling')
          throw new Error('review transaction reconciliation did not terminalize');
        let status: ReviewItemDTO['status'] = 'pending';
        if (override) {
          this.validateOverride(override, job, row, rowIndex, audit.input.outputPath);
          status = override.result.status;
        }
        items.push({ id, job, row, rowIndex, audit, ...(override ? { override } : {}), status });
      }
    }
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async materialize(descriptor: ReviewDescriptor): Promise<LocatedItem> {
    const { id, job, row, rowIndex, audit, override } = descriptor;
    let status = descriptor.status;
    let currentPath = row.targetPath!;
    let evidence: ReviewEvidenceSnapshot = {
      revision: audit.revision,
      resolution: clone(audit.input.resolution),
      collectedAt: this.timestamp(),
    };
    let lastError: string | undefined;
    let resolvedPath: string | undefined;
    let output: ReviewOutputBinding;
    let observed: ReviewOutputBinding | undefined;
    if (override) {
      if (override.result.status === 'resolved') {
        currentPath = override.result.resolvedPath;
        resolvedPath = override.result.resolvedPath;
      } else currentPath = override.result.currentPath;
      if (override.result.status === 'pending') evidence = clone(override.result.refreshedEvidence);
      if (override.result.status === 'failed') lastError = override.result.error;
      output = clone(override.output);
    } else {
      const cached = this.initialBindings.get(id);
      if (cached) output = clone(cached);
      else {
        observed = await this.outputBinding(currentPath);
        output = clone(observed);
        this.initialBindings.set(id, clone(output));
      }
    }
    if (status === 'pending' || status === 'failed' || status === 'resolved') {
      try {
        observed ??= await this.outputBinding(currentPath);
        const matches =
          status === 'resolved'
            ? sameFileIdentity(observed, output)
            : sameBinding(observed, output);
        if (!matches) status = 'stale';
      } catch {
        status = 'stale';
      }
    }
    const item: ReviewItemDTO = {
      reviewId: id,
      jobId: job.jobId,
      previewId: job.previewId,
      rowIndex,
      originalSourcePath: row.sourcePath,
      currentPath,
      destinationRoot: job.destinationPath,
      mediaKind: audit.input.mediaKind,
      status,
      reasonCodes: [...evidence.resolution.reasonCodes],
      warnings: [...row.warnings],
      evidence,
      output,
      screenshotDetected: evidence.resolution.candidates.some(
        (candidate) => candidate.sourceFamily === 'screenshot-filename'
      ),
      ...(lastError ? { lastError } : {}),
      ...(resolvedPath ? { resolvedPath } : {}),
      updatedAt: override?.recordedAt ?? evidence.collectedAt,
    };
    return { item, row, options: job.effectiveOptions };
  }

  private validateOverride(
    override: ReviewOverrideRecord,
    job: HistorySnapshot,
    row: Readonly<PreviewRowDTO>,
    rowIndex: number,
    auditOutputPath: string
  ): void {
    if (
      override.jobId !== job.jobId ||
      override.previewId !== job.previewId ||
      override.rowIndex !== rowIndex ||
      override.output.path !== row.targetPath ||
      auditOutputPath !== row.targetPath
    )
      throw new Error('persisted review override binding is corrupt');
    const result = override.result;
    if (
      (result.status === 'resolved' &&
        (result.previousPath !== row.targetPath ||
          path.resolve(result.resolvedPath) !== result.resolvedPath ||
          !contained(job.destinationPath, result.resolvedPath))) ||
      (result.status !== 'resolved' && result.currentPath !== row.targetPath)
    )
      throw new Error('persisted review override path is corrupt');
    if (
      result.status === 'reconciling' &&
      (path.resolve(result.targetPath) !== result.targetPath ||
        !contained(job.destinationPath, result.targetPath))
    )
      throw new Error('persisted review reconciliation target is corrupt');
  }

  private async reconcileOverride(override: ReviewOverrideRecord): Promise<ReviewOverrideRecord> {
    if (override.result.status !== 'reconciling') return override;
    const [sourceState, targetState] = await Promise.all([
      this.outputBinding(override.result.currentPath).catch(() => null),
      this.outputBinding(override.result.targetPath).catch(() => null),
    ]);
    const sourceMatches = sourceState !== null && sameBinding(sourceState, override.output);
    const targetMatches = targetState !== null && sameFileIdentity(targetState, override.output);
    let result: ReviewOverrideRecord['result'];
    if (targetMatches && sourceState === null) {
      result = {
        status: 'resolved',
        previousPath: override.result.currentPath,
        resolvedPath: override.result.targetPath,
        transactionId: override.result.transactionId,
      };
    } else if (sourceMatches && targetState === null) {
      result = {
        status: 'failed',
        currentPath: override.result.currentPath,
        error: 'Interrupted review transaction did not commit',
      };
    } else {
      throw new ReviewCommittedPersistenceError(
        override.reviewId,
        override.result.transactionId,
        override.result.targetPath,
        new Error('source and target state require transaction-journal reconciliation')
      );
    }
    return this.options.overrides.append({
      ...override,
      eventId: randomUUID(),
      sequence: override.sequence + 1,
      recordedAt: this.timestamp(),
      result,
    });
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) throw new Error('review clock returned an invalid date');
    return value.toISOString();
  }
}
