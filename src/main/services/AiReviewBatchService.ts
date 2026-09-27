import { createHash } from 'crypto';
import { constants } from 'fs';
import { open } from 'fs/promises';
import {
  isSelectedValueSupported,
  type JsonValue,
  type ParsedDateValue,
  type ScoredDateCandidate,
} from '../core/date';
import type {
  ReviewAction,
  ReviewApplyResultDTO,
  ReviewDryRunDTO,
  ReviewItemDTO,
  ReviewPageDTO,
} from '../../shared/types/review';
import {
  AiReviewAuthenticationError,
  type AiReviewClient,
  type AiReviewProposal,
} from './AiReviewClient';
import type { ReviewRemediationService } from './ReviewRemediationService';

const MODEL = 'glm-5.3';
const PROMPT = 'ai-review/1';
type ReviewPort = Pick<
  ReviewRemediationService,
  'list' | 'get' | 'dryRun' | 'apply' | 'withTransactionSession' | 'preflightAIEstimateCandidates'
> & {
  automaticRetryDryRun(request: {
    reviewId: string;
    evidenceRevision: string;
  }): Promise<ReviewDryRunDTO>;
  automaticRetryApply(request: {
    reviewId: string;
    evidenceRevision: string;
    planToken: string;
  }): Promise<ReviewApplyResultDTO>;
};
type ClientPort = Pick<AiReviewClient, 'propose'>;
type Phase = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed';
type Stage =
  | 'binding'
  | 'automatic-plan'
  | 'automatic-apply'
  | 'refresh-binding'
  | 'metadata-read'
  | 'model-call'
  | 'ai-plan'
  | 'ai-apply'
  | 'checkpoint';
interface SafeFailure {
  stage: Stage;
  code: string;
  detail: string;
}
export interface AiReviewBatchStatus {
  phase: Phase;
  total: number;
  processed: number;
  resolved: number;
  deterministicResolved: number;
  abstained: number;
  failed: number;
  currentIndex: number | null;
  currentStage?: Stage;
  lastFailure?: SafeFailure;
  error?: string;
}
interface Checkpoint {
  key: string;
  outcome: 'resolved' | 'abstained' | 'failed';
  stage?: Stage;
  code?: string;
  detail?: string;
}

const SAFE_DETAILS = new Set([
  'invalid override record',
  'review plan token is stale or invalid',
  'review evidence revision is stale',
  'review destination collision detected',
  'review output identity is stale',
  'review item is already terminal',
  'metadata retry is unavailable',
  'metadata retry did not produce refreshed evidence',
  'review action still requires review',
  'resolved metadata retry still requires review',
  'review output identity is not a regular file',
  'review output path is not canonical',
  'override store is locked',
  'override file identity is unsafe',
]);

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (
    typeof code === 'string' &&
    /^(?:EIO|ENOENT|EACCES|EPERM|ENOSPC|ESTALE|ETIMEDOUT|INVALID_INPUT|UNSAFE_STORE_PATH|STORE_LOCKED|STORE_CLOSED|STORE_POISONED|CORRUPT_STORE|SEQUENCE_REJECTED)$/.test(
      code
    )
  )
    return code;
  if (error instanceof Error) {
    if (/metadata retry is unavailable/i.test(error.message)) return 'METADATA_UNAVAILABLE';
    if (/evidence revision is stale/i.test(error.message)) return 'STALE_REVISION';
    if (/destination collision/i.test(error.message)) return 'COLLISION';
    if (/plan token is stale or invalid/i.test(error.message)) return 'PLAN_TOKEN';
    if (/invalid override record/i.test(error.message)) return 'INVALID_INPUT';
    if (/output changed|identity is stale/i.test(error.message)) return 'OUTPUT_CHANGED';
  }
  return 'UNKNOWN';
}
function safeErrorDetail(error: unknown, apiKey: string): string {
  if (!(error instanceof Error)) return 'Unclassified error';
  if (SAFE_DETAILS.has(error.message)) return error.message;
  let detail = error.message;
  if (apiKey) detail = detail.split(apiKey).join('[secret]');
  detail = detail
    .replace(/Bearer\s+\S+/gi, 'Bearer [secret]')
    .replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '[secret]')
    .replace(/(?:[A-Za-z]:\\|\/[\w.~-]+\/)[^\s,;:]+/g, '[path]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[digest]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/[\r\n\t\0-\x1f]/g, ' ');
  return detail.slice(0, 200) || 'Unclassified error';
}
function untrustedProposal(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'review action did not produce a trusted resolution' ||
      error.message === 'review action still requires review')
  );
}
class AiReviewLedgerError extends Error {}
export interface AiReviewBatchOptions {
  review: ReviewPort;
  client: ClientPort;
  metadataReader?: {
    read(item: ReviewItemDTO, signal: AbortSignal): Promise<Record<string, unknown>>;
  };
  ledgerPath: string;
}

function sanitizedMetadata(raw: Record<string, unknown>): JsonValue {
  const output: Record<string, JsonValue> = {};
  const relevant =
    /(?:Date|Time|SubSec|Offset|Zone|OriginalFileName|FileName|Make|Model|Software)/i;
  const forbidden =
    /(?:Latitude|Longitude|Coordinates|GPSPosition|Directory|Path|Serial|Owner|Artist|Copyright|Comment|Description|Subject|Keywords|User|Creator|Address|Email|Phone)/i;
  for (const [tag, value] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
    if (Object.keys(output).length >= 256) break;
    if (
      tag.length > 96 ||
      !relevant.test(tag) ||
      forbidden.test(tag) ||
      /(?:^|:)ICC(?:_|:)|ProfileDateTime|Profile.*Date/i.test(tag)
    )
      continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value);
    if (
      text.length > 256 ||
      /^(?:[\\/]|[A-Za-z]:[\\/])/.test(text) ||
      /(?:^|[\\/])(?:home|media|Users)[\\/]/i.test(text)
    )
      continue;
    output[tag] = text;
  }
  return output;
}

function key(item: ReviewItemDTO): string {
  return createHash('sha256')
    .update(
      JSON.stringify([item.reviewId, item.evidence.revision, item.output.sha256, MODEL, PROMPT])
    )
    .digest('hex');
}

function eligible(item: ReviewItemDTO): ScoredDateCandidate[] {
  return item.evidence.resolution.candidates.filter(
    (candidate) => candidate.eligibility === 'eligible'
  );
}

function evidence(item: ReviewItemDTO, metadata: JsonValue): JsonValue {
  return {
    mediaKind: item.mediaKind,
    target: item.evidence.resolution.target,
    reasonCodes: item.reasonCodes,
    metadata,
    candidates: item.evidence.resolution.candidates.map((candidate) => ({
      id: candidate.id,
      semantic: candidate.semantic,
      sourceKind: candidate.sourceKind,
      tag: candidate.tag,
      date: candidate.value.localIso,
      precision: candidate.value.precision,
      zoneBasis: candidate.value.zoneBasis,
      eligibility: candidate.eligibility,
      score: candidate.score.final,
      issues: candidate.resolutionIssues,
    })),
  } as JsonValue;
}

function supportedValue(
  candidate: ScoredDateCandidate,
  proposal: AiReviewProposal
): ParsedDateValue | null {
  if (proposal.kind === 'candidate') {
    const value = candidate.value;
    if (value.precision === 'date')
      return { localIso: value.localIso, precision: 'date', zoneBasis: 'date-only' };
    if (value.precision === 'minute') return null;
    const { fractionalDigits: _fractionalDigits, ...whole } = value;
    return {
      ...whole,
      localIso: value.localIso.slice(0, 19),
      ...(value.instantUtc
        ? { instantUtc: value.instantUtc.replace(/(?:\.\d{1,9})?Z$/, '.000Z') }
        : {}),
      precision: 'second',
    };
  }
  if (proposal.kind !== 'date') return null;
  if (proposal.precision === 'date' && candidate.value.localIso.slice(0, 10) === proposal.date)
    return { localIso: proposal.date, zoneBasis: 'date-only', precision: 'date' };
  if (
    proposal.precision === 'second' &&
    candidate.value.localIso.slice(0, 19) === proposal.date &&
    candidate.value.precision !== 'date' &&
    candidate.value.precision !== 'minute'
  )
    return supportedValue(candidate, {
      kind: 'candidate',
      candidateId: candidate.id,
      rationale: '',
    });
  return null;
}

type SettledProposal = { ok: true; value: AiReviewProposal } | { ok: false; error: unknown };
type PreparedEntry = {
  id: string;
  originalItem?: ReviewItemDTO;
  item?: ReviewItemDTO;
  candidates?: ScoredDateCandidate[];
  terminal?: 'skip' | 'deterministic' | 'abstained' | 'failed';
  failure?: SafeFailure;
  proposal?: Promise<SettledProposal>;
};

function sameOutputBinding(left: ReviewItemDTO, right: ReviewItemDTO): boolean {
  const a = left.output;
  const b = right.output;
  return (
    a.path === b.path &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.size === b.size &&
    a.modifiedTimeMs === b.modifiedTimeMs &&
    a.mtimeNs === b.mtimeNs &&
    a.sha256 === b.sha256
  );
}

export class AiReviewBatchService {
  private state: AiReviewBatchStatus = {
    phase: 'idle',
    total: 0,
    processed: 0,
    resolved: 0,
    deterministicResolved: 0,
    abstained: 0,
    failed: 0,
    currentIndex: null,
  };
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  constructor(private readonly options: AiReviewBatchOptions) {}

  status(): AiReviewBatchStatus {
    return { ...this.state };
  }
  async wait(): Promise<void> {
    await this.active;
  }
  cancel(): void {
    this.controller?.abort();
  }

  async start({ apiKey }: { apiKey: string }): Promise<AiReviewBatchStatus> {
    if (this.active) return this.status();
    if (!apiKey.trim()) throw new Error('AI API key is required');
    const controller = new AbortController();
    this.controller = controller;
    this.state = {
      phase: 'running',
      total: 0,
      processed: 0,
      resolved: 0,
      deterministicResolved: 0,
      abstained: 0,
      failed: 0,
      currentIndex: null,
    };
    const active = this.run(apiKey, controller.signal)
      .catch((_error: unknown) => {
        this.state.phase = controller.signal.aborted ? 'cancelled' : 'failed';
        this.state.error = 'AI batch could not complete';
      })
      .finally(() => {
        this.active = null;
        this.controller = null;
      });
    this.active = active;
    return this.status();
  }

  private async ledger<T>(
    work: (handle: import('fs/promises').FileHandle) => Promise<T>
  ): Promise<T> {
    const flags = constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(this.options.ledgerPath, flags, 0o600);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o077) !== 0)
        throw new Error('AI assessment ledger has unsafe permissions or identity');
      return await work(handle);
    } finally {
      await handle.close();
    }
  }

  private async checkpoints(): Promise<Set<string>> {
    return this.ledger(async (handle) => {
      let content = await handle.readFile('utf8');
      const finalNewline = content.lastIndexOf('\n');
      if (content.length && finalNewline !== content.length - 1) {
        const complete = content.slice(0, finalNewline + 1);
        await handle.truncate(Buffer.byteLength(complete));
        await handle.sync();
        content = complete;
      }
      const keys = new Set<string>();
      for (const line of content.split('\n')) {
        if (!line) continue;
        const row = JSON.parse(line) as Checkpoint;
        if (
          !/^[a-f0-9]{64}$/.test(row.key) ||
          !['resolved', 'abstained', 'failed'].includes(row.outcome)
        )
          throw new Error('AI assessment ledger is invalid');
        if (row.outcome !== 'failed') keys.add(row.key);
      }
      return keys;
    });
  }

  private async checkpoint(
    item: ReviewItemDTO,
    outcome: Checkpoint['outcome'],
    failure?: SafeFailure
  ): Promise<void> {
    try {
      await this.ledger(async (handle) => {
        const stats = await handle.stat();
        await handle.write(
          `${JSON.stringify({ key: key(item), outcome, ...(failure ? failure : {}) })}\n`,
          stats.size
        );
        await handle.sync();
      });
    } catch {
      throw new AiReviewLedgerError('AI assessment ledger write failed');
    }
  }

  private async run(apiKey: string, signal: AbortSignal): Promise<void> {
    return this.options.review.withTransactionSession(() =>
      this.runWithinTransactionSession(apiKey, signal)
    );
  }

  private async runWithinTransactionSession(apiKey: string, signal: AbortSignal): Promise<void> {
    if (!this.options.metadataReader) throw new Error('Verified metadata reader is unavailable');
    const done = await this.checkpoints();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page: ReviewPageDTO = await this.options.review.list({
        statuses: ['pending', 'failed'],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...page.items.map((item) => item.reviewId));
      cursor = page.nextCursor;
    } while (cursor);
    this.state.total = ids.length;

    const proposalController = new AbortController();
    const abortProposals = () => proposalController.abort();
    signal.addEventListener('abort', abortProposals, { once: true });
    const queue: PreparedEntry[] = [];
    let next = 0;
    let concurrency = 4;
    let authFailure: AiReviewAuthenticationError | null = null;
    const onAuthenticationFailure = (error: AiReviewAuthenticationError) => {
      authFailure = error;
      proposalController.abort();
    };
    try {
      while (next < ids.length || queue.length > 0) {
        while (queue.length < concurrency && next < ids.length && !signal.aborted && !authFailure) {
          const entry = await this.prepareEntry(
            ids[next++],
            done,
            apiKey,
            signal,
            proposalController.signal,
            onAuthenticationFailure
          );
          queue.push(entry);
        }
        if (signal.aborted) {
          this.state.phase = 'cancelled';
          return;
        }
        if (authFailure) throw authFailure;
        if (queue.length === 0) continue;
        const { entry, settled } = await Promise.race(
          queue.map(async (pending) => ({
            entry: pending,
            settled: pending.proposal ? await pending.proposal : null,
          }))
        );
        queue.splice(queue.indexOf(entry), 1);
        if (signal.aborted) {
          this.state.phase = 'cancelled';
          return;
        }
        if (authFailure) throw authFailure;
        this.state.currentIndex = this.state.processed + 1;
        this.state.currentStage = entry.proposal ? 'model-call' : 'checkpoint';
        if (entry.proposal) {
          if (!settled) throw new Error('Missing settled AI proposal');
          if (!settled.ok && settled.error instanceof AiReviewAuthenticationError)
            throw settled.error;
          if (
            !settled.ok &&
            settled.error instanceof Error &&
            /HTTP 429/.test(settled.error.message)
          )
            concurrency = 1;
          await this.commitEntry(entry, settled, apiKey, signal, proposalController.signal);
        } else {
          await this.commitEntry(entry, null, apiKey, signal, proposalController.signal);
        }
        this.state.processed++;
      }
      this.state.currentIndex = null;
      this.state.currentStage = undefined;
      this.state.phase = 'completed';
    } finally {
      proposalController.abort();
      signal.removeEventListener('abort', abortProposals);
      await Promise.all(queue.map((entry) => entry.proposal ?? Promise.resolve()));
    }
  }

  private async prepareEntry(
    id: string,
    done: Set<string>,
    apiKey: string,
    signal: AbortSignal,
    proposalSignal: AbortSignal,
    onAuthenticationFailure: (error: AiReviewAuthenticationError) => void
  ): Promise<PreparedEntry> {
    const entry: PreparedEntry = { id };
    let stage: Stage = 'binding';
    try {
      this.state.currentStage = stage;
      let item = await this.options.review.get(id);
      if (!item || (item.status !== 'pending' && item.status !== 'failed'))
        return { ...entry, terminal: 'skip' };
      entry.originalItem = item;
      if (item.evidence.resolution.reasonCodes.includes('EMPTY_FILE')) {
        entry.item = item;
        return { ...entry, terminal: 'abstained' };
      }
      stage = 'automatic-plan';
      this.state.currentStage = stage;
      const automatic = await this.options.review.automaticRetryDryRun({
        reviewId: id,
        evidenceRevision: item.evidence.revision,
      });
      if (signal.aborted) return entry;
      if (automatic.collision) throw new Error('Automatic review destination collision');
      stage = 'automatic-apply';
      this.state.currentStage = stage;
      const automaticResult = await this.options.review.automaticRetryApply({
        reviewId: id,
        evidenceRevision: item.evidence.revision,
        planToken: automatic.planToken,
      });
      if (automaticResult.status === 'resolved') return { ...entry, terminal: 'deterministic' };
      if (automaticResult.status !== 'pending') throw new Error('Automatic review did not refresh');
      stage = 'refresh-binding';
      this.state.currentStage = stage;
      item = await this.options.review.get(id);
      if (!item || item.status !== 'pending')
        throw new Error('Automatic review evidence unavailable');
      entry.item = item;
      if (done.has(key(item))) return { ...entry, terminal: 'skip' };
      const proposedCandidates = eligible(item).flatMap((candidate) => {
        const value = supportedValue(candidate, {
          kind: 'candidate',
          candidateId: candidate.id,
          rationale: 'Candidate preflight',
        });
        return value && isSelectedValueSupported(value, candidate.value)
          ? [{ candidateId: candidate.id, value }]
          : [];
      });
      const actionableIds = await this.options.review.preflightAIEstimateCandidates({
        reviewId: id,
        evidenceRevision: item.evidence.revision,
        candidates: proposedCandidates,
        signal,
      });
      const actionable = new Set(actionableIds);
      const candidates = eligible(item).filter((candidate) => actionable.has(candidate.id));
      if (candidates.length === 0) return { ...entry, terminal: 'abstained' };
      stage = 'metadata-read';
      this.state.currentStage = stage;
      const metadata = sanitizedMetadata(await this.options.metadataReader!.read(item, signal));
      if (signal.aborted || proposalSignal.aborted) return entry;
      entry.candidates = candidates;
      const proposal = this.options.client.propose({
        evidence: evidence(item, metadata),
        candidateIds: candidates.map((candidate) => candidate.id),
        apiKey,
        signal: proposalSignal,
      });
      entry.proposal = proposal.then(
        (value): SettledProposal => ({ ok: true, value }),
        (error): SettledProposal => {
          if (error instanceof AiReviewAuthenticationError) onAuthenticationFailure(error);
          return { ok: false, error };
        }
      );
      return entry;
    } catch (error) {
      if (signal.aborted) return entry;
      if (error instanceof AiReviewLedgerError) throw error;
      entry.terminal = 'failed';
      entry.failure = { stage, code: safeErrorCode(error), detail: safeErrorDetail(error, apiKey) };
      return entry;
    }
  }

  private async commitEntry(
    entry: PreparedEntry,
    settled: SettledProposal | null,
    apiKey: string,
    signal: AbortSignal,
    proposalSignal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) return;
    if (entry.terminal === 'skip') return;
    if (entry.terminal === 'deterministic') {
      this.state.resolved++;
      this.state.deterministicResolved++;
      return;
    }
    if (entry.terminal === 'abstained') {
      await this.checkpoint(entry.item!, 'abstained');
      this.state.abstained++;
      return;
    }
    if (entry.terminal === 'failed') {
      this.state.failed++;
      this.state.lastFailure = entry.failure;
      if (entry.originalItem) await this.checkpoint(entry.originalItem, 'failed', entry.failure);
      return;
    }
    const item = entry.item!;
    let stage: Stage = 'model-call';
    try {
      if (!settled || !settled.ok)
        throw settled && !settled.ok ? settled.error : new Error('Missing AI proposal');
      const proposal = settled.value;
      const candidates = entry.candidates!;
      let candidate: ScoredDateCandidate | undefined;
      if (proposal.kind === 'candidate')
        candidate = candidates.find((value) => value.id === proposal.candidateId);
      if (proposal.kind === 'date')
        candidate = candidates.find((value) => supportedValue(value, proposal) !== null);
      const proposedValue = candidate ? supportedValue(candidate, proposal) : null;
      const value =
        candidate && proposedValue && isSelectedValueSupported(proposedValue, candidate.value)
          ? proposedValue
          : null;
      if (!candidate || !value) {
        stage = 'checkpoint';
        this.state.currentStage = stage;
        await this.checkpoint(item, 'abstained');
        this.state.abstained++;
        return;
      }
      stage = 'refresh-binding';
      this.state.currentStage = stage;
      const current = await this.options.review.get(entry.id);
      if (signal.aborted) return;
      if (proposalSignal.aborted && !signal.aborted) throw new AiReviewAuthenticationError();
      if (
        !current ||
        current.status !== 'pending' ||
        current.evidence.revision !== item.evidence.revision ||
        !sameOutputBinding(current, item)
      )
        throw new Error('Review proposal binding changed before apply');
      const action: ReviewAction = {
        type: 'ai-estimate',
        candidateId: candidate.id,
        value,
        provenance: {
          model: MODEL,
          promptVersion: PROMPT,
          evidenceRevision: item.evidence.revision,
          fileSha256: item.output.sha256,
          rationale: proposal.rationale,
        },
      };
      stage = 'ai-plan';
      this.state.currentStage = stage;
      const plan = await this.options.review.dryRun({
        reviewId: entry.id,
        evidenceRevision: item.evidence.revision,
        action,
      });
      if (plan.collision) throw new Error('AI review destination collision');
      if (signal.aborted) return;
      if (proposalSignal.aborted) throw new AiReviewAuthenticationError();
      stage = 'ai-apply';
      this.state.currentStage = stage;
      const result = await this.options.review.apply({
        reviewId: entry.id,
        evidenceRevision: item.evidence.revision,
        action,
        planToken: plan.planToken,
      });
      if (result.status !== 'resolved') throw new Error('AI review transaction did not resolve');
      stage = 'checkpoint';
      this.state.currentStage = stage;
      await this.checkpoint(item, 'resolved');
      this.state.resolved++;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof AiReviewAuthenticationError || error instanceof AiReviewLedgerError)
        throw error;
      if (untrustedProposal(error)) {
        await this.checkpoint(item, 'abstained');
        this.state.abstained++;
        return;
      }
      const failure = { stage, code: safeErrorCode(error), detail: safeErrorDetail(error, apiKey) };
      this.state.failed++;
      this.state.lastFailure = failure;
      if (entry.originalItem) await this.checkpoint(entry.originalItem, 'failed', failure);
    }
  }
}
