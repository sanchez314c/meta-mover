import { createHash, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { createInterface } from 'readline';

import { canonicalJson, EvidenceManifest } from '../core/evidence/EvidenceManifest';
import { NormalizationAuditService } from './NormalizationAuditService';
import type { DateResolutionRecord } from '../core/date/types';
import { AuditInputRecord, NormalizationAuditPolicy } from '../../shared/types/audit';
import { AuditDisposition } from '../../shared/types/audit';
import { isMetadataNormalizationSupported } from '../core/metadata/MetadataNormalizationPolicy';
import { buildMetadataNormalizationPlan } from '../core/metadata/MetadataNormalizationPolicy';
import type { NormalizationAuthorizationPort } from './TransactionalOperationExecutor';

const POLICY: NormalizationAuditPolicy = {
  policyVersion: 'normalization-audit/1',
  transformVersion: 'metadata-normalization/1',
  normalizedCreationTags: [
    'EXIF:DateTimeOriginal',
    'EXIF:CreateDate',
    'IPTC:DateCreated',
    'XMP:DateCreated',
    'QuickTime:CreateDate',
    'QuickTime:TrackCreateDate',
    'QuickTime:MediaCreateDate',
  ],
  protectedTemporalTags: ['EXIF:GPSDateStamp', 'QuickTime:TimeCode'],
};
const MAX_COHORT_AGGREGATION_BYTES = 4 * 1024 * 1024;
const POLICY_FINGERPRINT = createHash('sha256').update(canonicalJson(POLICY)).digest('hex');

// Repository instances share preparation because the application may construct more than
// one runtime facade over the same private evidence root. The durable files remain the
// source of truth; this map only prevents concurrent writers inside this process.
const sharedDatasetPreparations = new Map<string, Promise<Dataset>>();
const sharedApprovalQueues = new Map<string, Promise<void>>();

interface AuditWorkContext {
  signal?: AbortSignal;
  reportProgress?: (progress: {
    stage: string;
    completed: number;
    total?: number;
    unit: 'bytes' | 'records';
  }) => Promise<void> | void;
}
const activeWork = new AsyncLocalStorage<AuditWorkContext>();
function checkCancellation(): void {
  activeWork.getStore()?.signal?.throwIfAborted();
}
function progressReporter(stage: string, unit: 'bytes' | 'records', total?: number) {
  const context = activeWork.getStore();
  let last = -Infinity;
  return async (completed: number, force = false): Promise<void> => {
    context?.signal?.throwIfAborted();
    if (force || Date.now() - last >= 250) {
      last = Date.now();
      await context?.reportProgress?.({
        stage,
        completed,
        unit,
        ...(total === undefined ? {} : { total }),
      });
      context?.signal?.throwIfAborted();
    }
  };
}
async function awaitWork<T>(promise: Promise<T>): Promise<T> {
  const signal = activeWork.getStore()?.signal;
  signal?.throwIfAborted();
  if (!signal) return promise;
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error('Audit preparation aborted'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * True when an AbortError came from a cancelled caller other than this one.
 * A cancelled caller legitimately stops the shared dataset build it started,
 * but that abort must not leak into the next authorization request.
 */
function isForeignAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'AbortError' &&
    activeWork.getStore()?.signal?.aborted !== true
  );
}

interface Dataset {
  revision: string;
  indexPath: string;
  cohortPath: string;
  reviewPath: string;
  reviewHash: string;
  reviewCount: number;
  reviewRecords: readonly AuditInputRecord[];
  reviewIdentity: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
  }>;
  reviewLookup: ReadonlyMap<string, AuditInputRecord | null>;
  indexHash: string;
  service: NormalizationAuditService;
}
interface DatasetRequest {
  previewId: string;
}
interface PageRequest extends DatasetRequest {
  limit: number;
  cursor?: string;
}

async function* jsonLines(
  filePath: string,
  stage = 'Reading audit records'
): AsyncGenerator<Record<string, unknown>> {
  checkCancellation();
  const report = progressReporter(stage, 'records');
  let count = 0;
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    await report(0, true);
    for await (const line of lines) {
      checkCancellation();
      if (line.trim()) {
        yield JSON.parse(line) as Record<string, unknown>;
        await report(++count);
      }
    }
    await report(count, true);
  } finally {
    lines.close();
    input.destroy();
  }
}

function recordId(index: number): string {
  return `row-${index.toString().padStart(16, '0')}`;
}

export class EvidenceNormalizationAuditRepository implements NormalizationAuthorizationPort {
  private readonly datasets = new Map<string, Promise<Dataset>>();
  private readonly authorizationIndexes = new Map<
    string,
    Promise<
      Map<
        string,
        {
          sourcePath: string;
          outputPath: string;
          resolutionHash: string;
          disposition: AuditDisposition;
          cohortKey: string;
        }
      >
    >
  >();
  private closing = false;
  private constructor(
    private readonly evidenceRoot: string,
    private readonly indexRoot: string,
    private readonly indexIdentity: Readonly<{ dev: number; ino: number }>
  ) {}

  static async open(evidenceRoot: string): Promise<EvidenceNormalizationAuditRepository> {
    if (!path.isAbsolute(evidenceRoot)) throw new Error('evidence root must be absolute');
    const evidenceStat = await fs.lstat(evidenceRoot);
    if (evidenceStat.isSymbolicLink() || !evidenceStat.isDirectory())
      throw new Error('evidence root is unsafe');
    const canonicalEvidenceRoot = await fs.realpath(evidenceRoot);
    const canonicalEvidenceStat = await fs.lstat(canonicalEvidenceRoot);
    if (
      canonicalEvidenceStat.isSymbolicLink() ||
      !canonicalEvidenceStat.isDirectory() ||
      canonicalEvidenceStat.dev !== evidenceStat.dev ||
      canonicalEvidenceStat.ino !== evidenceStat.ino
    )
      throw new Error('evidence root identity changed during canonicalization');
    const requestedIndexRoot = path.join(canonicalEvidenceRoot, '.normalization-audit');
    await fs.mkdir(requestedIndexRoot, { recursive: true, mode: 0o700 });
    const requestedIndexStat = await fs.lstat(requestedIndexRoot);
    if (requestedIndexStat.isSymbolicLink() || !requestedIndexStat.isDirectory())
      throw new Error('audit index root is unsafe');
    const indexRoot = await fs.realpath(requestedIndexRoot);
    const indexStat = await fs.lstat(indexRoot);
    if (indexStat.isSymbolicLink() || !indexStat.isDirectory())
      throw new Error('audit index root is unsafe');
    await fs.chmod(indexRoot, 0o700);
    return new EvidenceNormalizationAuditRepository(canonicalEvidenceRoot, indexRoot, {
      dev: indexStat.dev,
      ino: indexStat.ino,
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...sharedApprovalQueues.values()]);
    this.datasets.clear();
    this.authorizationIndexes.clear();
  }

  async rows(request: PageRequest): Promise<unknown> {
    const dataset = await this.dataset(request.previewId);
    return dataset.service.page({
      limit: request.limit,
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
  }

  async sample(request: DatasetRequest & { seed: string; targetSize: number }): Promise<unknown> {
    return (await this.dataset(request.previewId)).service.sample(request);
  }

  async summary(
    request: DatasetRequest
  ): Promise<{ revision: string; total: number; dispositions: Record<string, number> }> {
    const dataset = await this.dataset(request.previewId);
    const dispositions: Record<string, number> = {};
    let total = 0;
    for await (const input of this.source(dataset.indexPath)()) {
      const result = await dataset.serviceForOne(input);
      dispositions[result.disposition] = (dispositions[result.disposition] ?? 0) + 1;
      total += 1;
    }
    return { revision: dataset.revision, total, dispositions };
  }

  async cohorts(request: PageRequest): Promise<unknown> {
    const dataset = await this.dataset(request.previewId);
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('audit cohort cursor is invalid or expired');
    }
    const items: Record<string, unknown>[] = [];
    let index = 0;
    let hasMore = false;
    for await (const cohort of jsonLines(dataset.cohortPath)) {
      if (index++ < offset) continue;
      if (items.length === request.limit) {
        hasMore = true;
        break;
      }
      items.push(cohort);
    }
    if (offset > index) throw new Error('audit cohort cursor is invalid or expired');
    const nextOffset = offset + items.length;
    return {
      revision: dataset.revision,
      items,
      ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async decision(request: DatasetRequest & { recordId: string }): Promise<unknown> {
    const dataset = await this.dataset(request.previewId);
    for await (const input of this.source(dataset.indexPath)())
      if (input.recordId === request.recordId) return dataset.serviceForOne(input);
    return null;
  }

  async reviewPage(request: PageRequest): Promise<{
    revision: string;
    items: AuditInputRecord[];
    nextCursor?: string;
  }> {
    const dataset = await this.dataset(request.previewId);
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > dataset.reviewCount)
      throw new Error('review catalog cursor is invalid');
    await this.assertReviewCatalogIdentity(dataset);
    const items = dataset.reviewRecords.slice(offset, offset + request.limit);
    const next = offset + items.length;
    return {
      revision: dataset.revision,
      items,
      ...(next < dataset.reviewCount ? { nextCursor: String(next) } : {}),
    };
  }

  async reviewInput(
    request: Readonly<DatasetRequest & { sourcePath: string; outputPath: string }>
  ): Promise<{ revision: string; input: AuditInputRecord } | null> {
    const dataset = await this.dataset(request.previewId);
    await this.assertReviewCatalogIdentity(dataset);
    const key = `${request.sourcePath}\0${request.outputPath}`;
    const matched = dataset.reviewLookup.get(key);
    if (matched === null) throw new Error('audit review input binding is ambiguous or corrupt');
    return matched === undefined ? null : { revision: dataset.revision, input: matched };
  }

  async approve(
    request: DatasetRequest & { revision: string; cohortKey: string; approved: boolean }
  ): Promise<unknown> {
    if (this.closing) throw new Error('normalization audit repository is closed');
    const dataset = await this.dataset(request.previewId);
    if (request.revision !== dataset.revision) throw new Error('audit revision is stale');
    let found = false;
    for await (const input of this.source(dataset.indexPath)()) {
      if (dataset.service.classify(input).cohortKey === request.cohortKey) {
        found = true;
        break;
      }
    }
    if (!found) throw new Error('audit cohort does not exist in this dataset');
    const approvalPath = path.join(
      this.indexRoot,
      `${createHash('sha256').update(request.previewId).digest('hex')}.approvals.json`
    );
    await this.withApprovalMutation(request.previewId, async () => {
      const approvals = await this.readApprovals(request.previewId, dataset.revision);
      approvals[request.cohortKey] = request.approved;
      const temporary = `${approvalPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify({ revision: dataset.revision, approvals }), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, approvalPath);
      } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
      }
      const directory = await fs.open(this.indexRoot, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    return { revision: dataset.revision, cohortKey: request.cohortKey, approved: request.approved };
  }

  async dryRun(request: PageRequest & { revision: string }): Promise<unknown> {
    const dataset = await this.dataset(request.previewId);
    if (request.revision !== dataset.revision) throw new Error('audit revision is stale');
    const page = await dataset.service.page({
      limit: request.limit,
      ...(request.cursor ? { cursor: request.cursor } : {}),
    });
    const approvals = await this.readApprovals(request.previewId, dataset.revision);
    return {
      ...page,
      items: page.items
        .filter(
          (item) =>
            item.disposition === 'auto-normalize' ||
            (item.disposition === 'normalize-after-cohort-approval' &&
              approvals[item.cohortKey] === true)
        )
        .flatMap((item) => {
          if (item.selectedValue === undefined) return [];
          const plan = buildMetadataNormalizationPlan(item.outputPath, item.selectedValue);
          return [
            {
              ...item,
              metadataChanges: plan.assignments.map((assignment) => ({
                tag: assignment.tag,
                before:
                  Object.entries(item.sourceTagValues ?? {}).find(
                    ([tag]) => tag.split(':').at(-1) === assignment.tag.split(':').at(-1)
                  )?.[1] ?? null,
                after: assignment.value,
              })),
            },
          ];
        }),
    };
  }

  async authorizeNormalization(
    request: Readonly<{
      previewId: string;
      recordId: string;
      sourcePath: string;
      outputPath: string;
      resolution: DateResolutionRecord;
      signal?: AbortSignal;
      reportProgress?: AuditWorkContext['reportProgress'];
    }>
  ): Promise<boolean> {
    return activeWork
      .run(request, async () => {
        checkCancellation();
        const dataset = await this.dataset(request.previewId);
        const matched = (await this.authorizationIndex(request.previewId, dataset)).get(
          request.recordId
        );
        checkCancellation();
        if (!matched) throw new Error('operation is not bound to this immutable preview audit');
        if (matched.sourcePath !== request.sourcePath)
          throw new Error('operation source diverges from the immutable preview audit');
        if (matched.outputPath !== request.outputPath)
          throw new Error('operation destination diverges from the immutable preview audit');
        if (
          matched.resolutionHash !==
          createHash('sha256').update(canonicalJson(request.resolution)).digest('hex')
        )
          throw new Error('operation date resolution diverges from the immutable preview audit');
        const decision = matched;
        if (decision.disposition === AuditDisposition.AUTO_NORMALIZE) return true;
        if (decision.disposition !== AuditDisposition.NORMALIZE_AFTER_COHORT_APPROVAL) return false;
        const approvals = await this.readApprovals(request.previewId, dataset.revision);
        checkCancellation();
        return approvals[decision.cohortKey] === true;
      })
      .catch(async (error) => {
        if (error instanceof Error && error.name === 'AbortError') {
          // Caller-visible cancellation settles only after the abandoned builder has
          // removed its private randomized artifacts, so an immediate retry starts clean.
          await this.datasets.get(request.previewId)?.catch(() => undefined);
        }
        throw error;
      });
  }

  private async authorizationIndex(
    previewId: string,
    dataset: Dataset
  ): Promise<
    Map<
      string,
      {
        sourcePath: string;
        outputPath: string;
        resolutionHash: string;
        disposition: AuditDisposition;
        cohortKey: string;
      }
    >
  > {
    const cached = this.authorizationIndexes.get(previewId);
    if (cached === undefined) return awaitWork(this.buildAuthorizationIndex(previewId, dataset));
    try {
      return await awaitWork(cached);
    } catch (error) {
      if (!isForeignAbort(error)) throw error;
      if (this.authorizationIndexes.get(previewId) === cached)
        this.authorizationIndexes.delete(previewId);
      return awaitWork(this.buildAuthorizationIndex(previewId, dataset));
    }
  }

  private buildAuthorizationIndex(
    previewId: string,
    dataset: Dataset
  ): Promise<
    Map<
      string,
      {
        sourcePath: string;
        outputPath: string;
        resolutionHash: string;
        disposition: AuditDisposition;
        cohortKey: string;
      }
    >
  > {
    const promise = (async () => {
      const index = new Map<
        string,
        {
          sourcePath: string;
          outputPath: string;
          resolutionHash: string;
          disposition: AuditDisposition;
          cohortKey: string;
        }
      >();
      for await (const input of this.source(dataset.indexPath, dataset.indexHash)()) {
        if (!input.operationId || index.has(input.operationId)) {
          throw new Error('audit operation index is corrupt');
        }
        const decision = dataset.service.classify({
          ...input,
          supported: isMetadataNormalizationSupported(input.outputPath),
        });
        index.set(input.operationId, {
          sourcePath: input.sourcePath,
          outputPath: input.outputPath,
          resolutionHash: createHash('sha256')
            .update(canonicalJson(input.resolution))
            .digest('hex'),
          disposition: decision.disposition,
          cohortKey: decision.cohortKey,
        });
      }
      return index;
    })();
    this.authorizationIndexes.set(previewId, promise);
    const pending = promise;
    promise.catch(() => {
      if (this.authorizationIndexes.get(previewId) === pending)
        this.authorizationIndexes.delete(previewId);
    });
    return promise;
  }

  private async readApprovals(
    previewId: string,
    revision: string
  ): Promise<Record<string, boolean>> {
    const approvalPath = path.join(
      this.indexRoot,
      `${createHash('sha256').update(previewId).digest('hex')}.approvals.json`
    );
    try {
      const stored = JSON.parse(await fs.readFile(approvalPath, 'utf8')) as {
        revision?: string;
        approvals?: Record<string, boolean>;
      };
      return stored.revision === revision && stored.approvals ? stored.approvals : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async withApprovalMutation(key: string, operation: () => Promise<void>): Promise<void> {
    const sharedKey = `${this.indexRoot}\0${key}`;
    const previous = sharedApprovalQueues.get(sharedKey) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    sharedApprovalQueues.set(sharedKey, current);
    try {
      await current;
    } finally {
      if (sharedApprovalQueues.get(sharedKey) === current) sharedApprovalQueues.delete(sharedKey);
    }
  }

  private async dataset(previewId: string): Promise<
    Dataset & {
      serviceForOne(
        input: AuditInputRecord
      ): Promise<ReturnType<NormalizationAuditService['classify']>>;
    }
  > {
    if (this.closing) throw new Error('normalization audit repository is closed');
    checkCancellation();
    await this.assertIndexRoot();
    const attach = (base: Dataset) =>
      Object.assign(base, {
        serviceForOne: (input: AuditInputRecord) => Promise.resolve(base.service.classify(input)),
      });
    const cached = this.datasets.get(previewId);
    if (cached === undefined) return attach(await awaitWork(this.cacheDataset(previewId)));
    try {
      return attach(await awaitWork(cached));
    } catch (error) {
      if (!isForeignAbort(error)) throw error;
      // The cached build was stopped by a cancelled caller; rebuild under the
      // current request so its authorization is not poisoned by that abort.
      if (this.datasets.get(previewId) === cached) this.datasets.delete(previewId);
      return attach(await awaitWork(this.cacheDataset(previewId)));
    }
  }

  private cacheDataset(previewId: string): Promise<Dataset> {
    const sharedKey = `${this.indexRoot}\0${previewId}\0${POLICY_FINGERPRINT}`;
    let promise = sharedDatasetPreparations.get(sharedKey);
    if (!promise) {
      promise = this.openDataset(previewId).catch(async (error) => {
        const digest = createHash('sha256').update(previewId).digest('hex');
        await this.cleanupPreparationArtifacts(digest);
        throw error;
      });
      sharedDatasetPreparations.set(sharedKey, promise);
      const pending = promise;
      promise
        .finally(() => {
          if (sharedDatasetPreparations.get(sharedKey) === pending)
            sharedDatasetPreparations.delete(sharedKey);
        })
        .catch(() => undefined);
    }

    this.datasets.set(previewId, promise);
    promise.catch(() => {
      if (this.datasets.get(previewId) === promise) this.datasets.delete(previewId);
    });
    return promise;
  }

  private async openDataset(previewId: string): Promise<Dataset> {
    const manifestPath = await this.findManifest(previewId);
    const digest = createHash('sha256').update(previewId).digest('hex');
    const snapshotPath = path.join(this.indexRoot, `${digest}.evidence.snapshot.jsonl`);
    const indexPath = path.join(this.indexRoot, `${digest}.jsonl`);
    const cohortPath = path.join(this.indexRoot, `${digest}.cohorts.jsonl`);
    const reviewPath = path.join(this.indexRoot, `${digest}.review.jsonl`);
    const metadataPath = path.join(this.indexRoot, `${digest}.json`);

    // A previously verified private snapshot is durable input. Verify it before doing any
    // source recopy so reopening a repository does not duplicate the full evidence stream.
    let verification: Awaited<ReturnType<typeof EvidenceManifest.verifyPreviewSnapshot>> = {
      valid: false,
      eventCount: 0,
      reason: 'Cached preview evidence is absent',
    };
    try {
      verification = await this.verifySnapshot(snapshotPath, 'Verifying cached preview evidence');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!verification.valid || !verification.finalHash) {
      const snapshotTemporary = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
      await this.copySealedPreview(manifestPath, snapshotTemporary, previewId);
      verification = await this.verifySnapshot(snapshotTemporary, 'Verifying preview evidence');
      if (!verification.valid || !verification.finalHash) {
        await fs.rm(snapshotTemporary, { force: true });
        throw new Error('audit dataset evidence is not closed and valid');
      }
      await fs.rename(snapshotTemporary, snapshotPath);
    }

    const evidenceRevision = verification.finalHash;
    const revision = createHash('sha256')
      .update(`${evidenceRevision}\0${POLICY_FINGERPRINT}`)
      .digest('hex');
    let indexHash: string | undefined;
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
        previewId?: string;
        evidenceRevision?: string;
        revision?: string;
        policyFingerprint?: string;
        count?: number;
        indexHash?: string;
        cohortHash?: string;
        reviewHash?: string;
        reviewCount?: number;
      };
      if (
        metadata.previewId === previewId &&
        metadata.evidenceRevision === evidenceRevision &&
        metadata.revision === revision &&
        metadata.policyFingerprint === POLICY_FINGERPRINT
      ) {
        const validatedIndexHash = await this.validateIndex(indexPath, metadata.count);
        if (
          metadata.indexHash === validatedIndexHash &&
          metadata.cohortHash === (await this.hashFile(cohortPath))
        ) {
          if (metadata.reviewHash === undefined || metadata.reviewCount === undefined) {
            const derived = await this.buildReviewCatalog(indexPath, reviewPath);
            await this.writeMetadata(metadataPath, {
              ...metadata,
              reviewHash: derived.hash,
              reviewCount: derived.count,
            });
            metadata.reviewHash = derived.hash;
            metadata.reviewCount = derived.count;
          } else {
            const validated = await this.validateReviewCatalog(reviewPath, metadata.reviewCount);
            if (validated !== metadata.reviewHash)
              throw new Error('review catalog hash is corrupt');
          }
          indexHash = validatedIndexHash;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
        throw error;
    }
    if (indexHash === undefined) {
      // Remove artifacts emitted by the pre-randomized builder. They are never
      // authoritative because metadata is published only after all files sync.
      await Promise.all([
        fs.rm(path.join(this.indexRoot, `${process.pid}.tmp`), { force: true }),
        fs.rm(path.join(this.indexRoot, `${process.pid}.tmp.decisions`), { force: true }),
      ]);
      indexHash = await this.buildIndex(
        snapshotPath,
        previewId,
        indexPath,
        metadataPath,
        evidenceRevision,
        revision
      );
    }
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
      reviewHash: string;
      reviewCount: number;
    };
    const loadedReview = await this.loadReviewCatalog(
      reviewPath,
      metadata.reviewCount,
      metadata.reviewHash
    );
    const reviewLookup = new Map<string, AuditInputRecord | null>();
    for (const input of loadedReview.records) {
      const key = `${input.sourcePath}\0${input.outputPath}`;
      reviewLookup.set(key, reviewLookup.has(key) ? null : input);
    }
    const service = new NormalizationAuditService({
      policy: POLICY,
      source: this.source(indexPath, indexHash),
      currentRevision: async () => revision,
    });
    return {
      revision,
      indexPath,
      cohortPath,
      reviewPath,
      reviewHash: metadata.reviewHash,
      reviewCount: metadata.reviewCount,
      reviewRecords: loadedReview.records,
      reviewIdentity: loadedReview.identity,
      reviewLookup,
      indexHash,
      service,
    };
  }

  private source(
    indexPath: string,
    expectedHash?: string
  ): (afterRecordId?: string) => AsyncIterable<AuditInputRecord> {
    return (afterRecordId?: string) => this.readSource(indexPath, expectedHash, afterRecordId);
  }

  private async *readSource(
    indexPath: string,
    expectedHash?: string,
    afterRecordId?: string
  ): AsyncIterable<AuditInputRecord> {
    if (expectedHash && (await this.hashFile(indexPath)) !== expectedHash)
      throw new Error('audit index hash is corrupt');
    for await (const value of jsonLines(indexPath)) {
      const record = value as unknown as AuditInputRecord;
      if (afterRecordId === undefined || record.recordId > afterRecordId) yield record;
    }
    if (expectedHash && (await this.hashFile(indexPath)) !== expectedHash)
      throw new Error('audit index changed while it was being read');
  }

  private async findManifest(previewId: string): Promise<string> {
    for (const name of await fs.readdir(this.evidenceRoot)) {
      if (!name.endsWith('.evidence.jsonl')) continue;
      const manifestPath = path.join(this.evidenceRoot, name);
      for await (const event of jsonLines(manifestPath, 'Finding preview evidence')) {
        if (event.kind !== 'preview-recorded') continue;
        const payload = event.payload as { preview?: { previewId?: string } };
        if (payload.preview?.previewId === previewId) return manifestPath;
        break;
      }
    }
    throw new Error(`No durable audit dataset exists for preview ${previewId}`);
  }

  private async copySealedPreview(
    manifestPath: string,
    targetPath: string,
    previewId: string
  ): Promise<void> {
    const output = await fs.open(targetPath, 'wx', 0o600);
    let sealed = false;
    try {
      for await (const event of jsonLines(manifestPath, 'Copying sealed preview evidence')) {
        await output.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        if (
          event.kind === 'preview-sealed' &&
          (event.payload as { previewId?: string })?.previewId === previewId
        ) {
          sealed = true;
          break;
        }
      }
      if (!sealed) throw new Error('preview evidence is not sealed');
      await output.sync();
    } catch (error) {
      await output.close().catch(() => undefined);
      await fs.rm(targetPath, { force: true });
      throw error;
    }
    await output.close();
  }

  private async buildIndex(
    manifestPath: string,
    previewId: string,
    indexPath: string,
    metadataPath: string,
    evidenceRevision: string,
    revision: string
  ): Promise<string> {
    const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
    const cohortPath = indexPath.replace(/\.jsonl$/, '.cohorts.jsonl');
    const decisionPath = `${temporary}.decisions`;
    const handle = await fs.open(temporary, 'w', 0o600);
    const decisionHandle = await fs.open(decisionPath, 'w', 0o600);
    let decisionIterator: AsyncIterator<Record<string, unknown>> | undefined;
    let count = 0;
    try {
      for await (const event of jsonLines(manifestPath, 'Building normalization audit index')) {
        const payload = event.payload as Record<string, unknown>;
        if (payload.previewId !== previewId) continue;
        if (event.kind === 'resolution-decided') {
          await decisionHandle.writeFile(
            `${JSON.stringify({ rowIndex: payload.rowIndex, sourcePath: payload.sourcePath, resolution: payload.resolution })}\n`,
            'utf8'
          );
        }
        if (event.kind === 'operation-planned') {
          if (!decisionIterator) {
            await decisionHandle.sync();
            await decisionHandle.close();
            decisionIterator = jsonLines(decisionPath)[Symbol.asyncIterator]();
          }
          const operation = payload.operation as {
            decisionRowIndex: number;
            operationId: string;
            targetPath: string;
          };
          const next = await decisionIterator.next();
          if (next.done) throw new Error('Evidence operation has no matching resolution');
          const decision = next.value as unknown as {
            rowIndex: number;
            sourcePath: string;
            resolution: DateResolutionRecord;
          };
          if (decision.rowIndex !== operation.decisionRowIndex)
            throw new Error('Evidence decision and operation order disagree');
          const input: AuditInputRecord = {
            recordId: recordId(operation.decisionRowIndex),
            operationId: operation.operationId,
            sourcePath: decision.sourcePath,
            outputPath: operation.targetPath,
            mediaKind: decision.resolution.mediaKind,
            extension: path.extname(operation.targetPath).toLowerCase(),
            supported: isMetadataNormalizationSupported(operation.targetPath),
            resolution: decision.resolution,
          };
          await handle.writeFile(`${JSON.stringify(input)}\n`, 'utf8');
          count += 1;
        }
      }
      if (decisionIterator && !(await decisionIterator.next()).done)
        throw new Error('Evidence resolutions are missing planned operations');
      await handle.sync();
    } finally {
      await decisionIterator?.return?.();
      await decisionHandle.close().catch(() => undefined);
      await handle.close();
      await fs.rm(decisionPath, { force: true });
    }
    const postVerification = await this.verifySnapshot(manifestPath, 'Rechecking preview evidence');
    if (!postVerification.valid || postVerification.finalHash !== evidenceRevision) {
      await fs.rm(temporary, { force: true });
      throw new Error('audit evidence changed while deriving the dataset');
    }
    await fs.rename(temporary, indexPath);
    await this.buildCohortIndex(indexPath, cohortPath);
    const review = await this.buildReviewCatalog(
      indexPath,
      indexPath.replace(/\.jsonl$/, '.review.jsonl')
    );
    const indexHash = await this.validateIndex(indexPath, count);
    const cohortHash = await this.hashFile(cohortPath);
    const metadataTemporary = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    const metadataHandle = await fs.open(metadataTemporary, 'wx', 0o600);
    try {
      await metadataHandle.writeFile(
        JSON.stringify({
          previewId,
          evidenceRevision,
          revision,
          policyFingerprint: POLICY_FINGERPRINT,
          count,
          indexHash,
          cohortHash,
          reviewHash: review.hash,
          reviewCount: review.count,
        }),
        'utf8'
      );
      await metadataHandle.sync();
    } finally {
      await metadataHandle.close();
    }
    await fs.rename(metadataTemporary, metadataPath);
    const directory = await fs.open(this.indexRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return indexHash;
  }

  private async buildReviewCatalog(
    indexPath: string,
    reviewPath: string
  ): Promise<{ hash: string; count: number }> {
    const temporary = `${reviewPath}.${process.pid}.${randomUUID()}.tmp`;
    const output = await fs.open(temporary, 'wx', 0o600);
    let count = 0;
    try {
      for await (const input of this.source(indexPath)()) {
        if (input.resolution.status === 'resolved') continue;
        await output.writeFile(`${JSON.stringify(input)}\n`, 'utf8');
        count += 1;
      }
      await output.sync();
    } finally {
      await output.close();
    }
    await fs.rename(temporary, reviewPath);
    return { hash: await this.validateReviewCatalog(reviewPath, count), count };
  }

  private async validateReviewCatalog(reviewPath: string, expectedCount: number): Promise<string> {
    return (await this.loadReviewCatalog(reviewPath, expectedCount)).hash;
  }

  private async loadReviewCatalog(
    reviewPath: string,
    expectedCount: number,
    expectedHash?: string
  ): Promise<{
    hash: string;
    records: AuditInputRecord[];
    identity: { dev: number; ino: number; size: number; mtimeNs: string; ctimeNs: string };
  }> {
    await this.assertIndexRoot();
    const handle = await fs.open(reviewPath, 'r');
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
        throw new Error('review catalog identity is unsafe');
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      const visible = await fs.lstat(reviewPath, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        visible.dev !== after.dev ||
        visible.ino !== after.ino ||
        visible.size !== after.size ||
        visible.mtimeNs !== after.mtimeNs ||
        visible.ctimeNs !== after.ctimeNs
      )
        throw new Error('review catalog changed while it was being read');
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (expectedHash !== undefined && hash !== expectedHash)
        throw new Error('review catalog hash is corrupt');
      const records: AuditInputRecord[] = [];
      let previous = '';
      for (const line of bytes.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const value = JSON.parse(line) as Record<string, unknown>;
        if (
          typeof value.recordId !== 'string' ||
          value.recordId <= previous ||
          typeof value.sourcePath !== 'string' ||
          typeof value.outputPath !== 'string' ||
          typeof value.resolution !== 'object' ||
          value.resolution === null ||
          (value.resolution as { status?: string }).status === 'resolved'
        )
          throw new Error('review catalog record is corrupt');
        previous = value.recordId;
        records.push(value as unknown as AuditInputRecord);
      }
      if (records.length !== expectedCount)
        throw new Error('review catalog record count is corrupt');
      return {
        hash,
        records,
        identity: {
          dev: Number(after.dev),
          ino: Number(after.ino),
          size: Number(after.size),
          mtimeNs: after.mtimeNs.toString(),
          ctimeNs: after.ctimeNs.toString(),
        },
      };
    } finally {
      await handle.close();
    }
  }

  private async assertReviewCatalogIdentity(dataset: Dataset): Promise<void> {
    const value = await fs.lstat(dataset.reviewPath, { bigint: true });
    const expected = dataset.reviewIdentity;
    if (
      !value.isFile() ||
      value.isSymbolicLink() ||
      value.nlink !== 1n ||
      Number(value.dev) !== expected.dev ||
      Number(value.ino) !== expected.ino ||
      Number(value.size) !== expected.size ||
      value.mtimeNs.toString() !== expected.mtimeNs ||
      value.ctimeNs.toString() !== expected.ctimeNs
    )
      throw new Error('review catalog identity changed after validation');
  }

  private async writeMetadata(
    metadataPath: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const temporary = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(metadata), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, metadataPath);
    const directory = await fs.open(this.indexRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async cleanupPreparationArtifacts(digest: string): Promise<void> {
    const names = await fs.readdir(this.indexRoot).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter(
          (name) =>
            name.startsWith(`${digest}.`) &&
            (name.includes('.tmp') || name.endsWith('.decisions') || name.endsWith('.buckets'))
        )
        .map((name) => fs.rm(path.join(this.indexRoot, name), { recursive: true, force: true }))
    );
  }

  private async hashFile(filePath: string): Promise<string> {
    checkCancellation();
    await this.assertIndexRoot();
    const hash = createHash('sha256');
    const report = progressReporter(
      `Hashing ${path.basename(filePath)}`,
      'bytes',
      (await fs.stat(filePath)).size
    );
    let bytes = 0;
    await report(0, true);
    for await (const chunk of createReadStream(filePath)) {
      checkCancellation();
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
      await report(bytes);
    }
    await report(bytes, true);
    await this.assertIndexRoot();
    return hash.digest('hex');
  }

  private async verifySnapshot(filePath: string, stage: string) {
    const report = progressReporter(stage, 'bytes', (await fs.stat(filePath)).size);
    return EvidenceManifest.verifyPreviewSnapshot(filePath, {
      signal: activeWork.getStore()?.signal,
      onProgress: ({ bytesRead }) => report(bytesRead),
    });
  }

  private async assertIndexRoot(): Promise<void> {
    const visible = await fs.lstat(this.indexRoot);
    if (
      visible.isSymbolicLink() ||
      !visible.isDirectory() ||
      visible.dev !== this.indexIdentity.dev ||
      visible.ino !== this.indexIdentity.ino
    )
      throw new Error('audit index root identity changed');
  }

  private async validateIndex(indexPath: string, expectedCount?: number): Promise<string> {
    let count = 0;
    for await (const value of jsonLines(indexPath)) {
      if (
        value.recordId !== recordId(count) ||
        typeof value.operationId !== 'string' ||
        typeof value.sourcePath !== 'string' ||
        typeof value.outputPath !== 'string' ||
        typeof value.resolution !== 'object' ||
        value.resolution === null
      )
        throw new Error('audit index is corrupt');
      count += 1;
    }
    if (expectedCount !== undefined && count !== expectedCount)
      throw new Error('audit index record count is corrupt');
    return this.hashFile(indexPath);
  }

  private async buildCohortIndex(indexPath: string, cohortPath: string): Promise<void> {
    const bucketRoot = `${cohortPath}.${process.pid}.${randomUUID()}.buckets`;
    await fs.mkdir(bucketRoot, { mode: 0o700 });
    const service = new NormalizationAuditService({
      policy: POLICY,
      source: this.source(indexPath),
      currentRevision: async () => 'building',
    });
    try {
      const buckets = new Map<string, FileHandle>();
      try {
        for await (const input of this.source(indexPath)()) {
          const decision = service.classify(input);
          const bucket = decision.cohortKey.slice(0, 2);
          let bucketHandle = buckets.get(bucket);
          if (!bucketHandle) {
            bucketHandle = await fs.open(path.join(bucketRoot, `${bucket}.jsonl`), 'a', 0o600);
            buckets.set(bucket, bucketHandle);
          }
          await bucketHandle.writeFile(
            `${JSON.stringify({ cohortKey: decision.cohortKey, disposition: decision.disposition })}\n`,
            'utf8'
          );
        }
      } finally {
        await Promise.all([...buckets.values()].map((handle) => handle.close()));
      }
      const temporary = `${cohortPath}.${process.pid}.${randomUUID()}.tmp`;
      const output = await fs.open(temporary, 'wx', 0o600);
      try {
        for (const name of (await fs.readdir(bucketRoot)).sort()) {
          await this.aggregateCohortBucket(path.join(bucketRoot, name), name.slice(0, 2), output);
        }
        await output.sync();
      } finally {
        await output.close();
      }
      await fs.rename(temporary, cohortPath);
    } finally {
      await fs.rm(bucketRoot, { recursive: true, force: true });
    }
  }

  private async aggregateCohortBucket(
    bucketPath: string,
    prefix: string,
    output: FileHandle
  ): Promise<void> {
    if ((await fs.stat(bucketPath)).size <= MAX_COHORT_AGGREGATION_BYTES || prefix.length === 64) {
      const aggregate = new Map<
        string,
        { cohortKey: string; count: number; dispositions: Record<string, number> }
      >();
      for await (const row of jsonLines(bucketPath)) {
        const key = row.cohortKey as string;
        const disposition = row.disposition as string;
        const item = aggregate.get(key) ?? { cohortKey: key, count: 0, dispositions: {} };
        item.count += 1;
        item.dispositions[disposition] = (item.dispositions[disposition] ?? 0) + 1;
        aggregate.set(key, item);
      }
      for (const item of [...aggregate.values()].sort((left, right) =>
        left.cohortKey.localeCompare(right.cohortKey)
      ))
        await output.writeFile(`${JSON.stringify(item)}\n`, 'utf8');
      return;
    }
    const childRoot = `${bucketPath}.split`;
    await fs.mkdir(childRoot, { mode: 0o700 });
    const children = new Map<string, FileHandle>();
    try {
      for await (const row of jsonLines(bucketPath)) {
        const childPrefix = (row.cohortKey as string).slice(0, prefix.length + 2);
        let child = children.get(childPrefix);
        if (!child) {
          child = await fs.open(path.join(childRoot, `${childPrefix}.jsonl`), 'a', 0o600);
          children.set(childPrefix, child);
        }
        await child.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
      }
      await Promise.all([...children.values()].map((handle) => handle.close()));
      children.clear();
      for (const name of (await fs.readdir(childRoot)).sort())
        await this.aggregateCohortBucket(
          path.join(childRoot, name),
          name.slice(0, -'.jsonl'.length),
          output
        );
    } finally {
      await Promise.allSettled([...children.values()].map((handle) => handle.close()));
      await fs.rm(childRoot, { recursive: true, force: true });
    }
  }
}
