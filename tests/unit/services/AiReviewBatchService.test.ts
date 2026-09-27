import { chmod, mkdtemp, readFile, writeFile, symlink } from 'fs/promises';
import { waitFor } from '@testing-library/react';
import os from 'os';
import path from 'path';
import { AiReviewBatchService } from '../../../src/main/services/AiReviewBatchService';
import { AiReviewAuthenticationError } from '../../../src/main/services/AiReviewClient';
import type { ReviewItemDTO } from '../../../src/shared/types/review';

const item = {
  reviewId: 'review-1',
  status: 'pending',
  evidence: {
    revision: 'rev-1',
    resolution: {
      candidates: [
        {
          id: 'candidate-1',
          eligibility: 'eligible',
          semantic: 'capture',
          sourceKind: 'embedded-exif',
          tag: 'DateTimeOriginal',
          value: {
            localIso: '2020-01-02T03:04:05',
            precision: 'second',
            zoneBasis: 'floating-local',
          },
          score: { final: 80 },
        },
      ],
      reasonCodes: ['CONFLICT'],
      contenderIds: ['candidate-1'],
    },
  },
  output: { sha256: 'a'.repeat(64) },
} as unknown as ReviewItemDTO;

const defaultMetadataReader = {
  read: jest.fn(async () => ({ 'EXIF:DateTimeOriginal': '2020:01:02 03:04:05' })),
};

function deterministic<T extends object>(review: T) {
  const given = review as T & { dryRun?: jest.Mock; preflightAIEstimateCandidates?: jest.Mock };
  return {
    ...review,
    preflightAIEstimateCandidates:
      given.preflightAIEstimateCandidates ??
      jest.fn(async ({ candidates }: { candidates: Array<{ candidateId: string }> }) =>
        candidates.map((candidate) => candidate.candidateId)
      ),
    dryRun: given.dryRun?.getMockImplementation()
      ? given.dryRun
      : jest.fn(async () => ({ planToken: 'preflight', collision: false })),
    withTransactionSession: jest.fn(async <R>(work: () => Promise<R>) => work()),
    automaticRetryDryRun: jest.fn(async () => ({
      planToken: 'auto',
      targetPath: null,
      collision: false,
    })),
    automaticRetryApply: jest.fn(async () => ({ status: 'pending' })),
  };
}

describe('AiReviewBatchService', () => {
  it('commits a fast second proposal while the first model call is still pending', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const rows = [0, 1].map((n) => {
      const row = JSON.parse(JSON.stringify(item)) as ReviewItemDTO;
      row.reviewId = `review-${n}`;
      row.output.sha256 = String(n).repeat(64);
      row.evidence.resolution.candidates[0].id = `candidate-${n}`;
      return row;
    });
    const review = deterministic({
      list: jest.fn(async () => ({ items: rows })),
      get: jest.fn(async (id: string) => rows.find((row) => row.reviewId === id)!),
      dryRun: jest.fn(async () => ({ planToken: 'p', collision: false })),
      apply: jest.fn(async (request: { reviewId: string }) => ({
        reviewId: request.reviewId,
        status: 'resolved',
      })),
    });
    const releases = new Map<string, (value: unknown) => void>();
    const client = {
      propose: jest.fn(
        ({ candidateIds }: { candidateIds: string[] }) =>
          new Promise((resolve) => releases.set(candidateIds[0], resolve))
      ),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await waitFor(() => expect(releases.size).toBe(2));
    releases.get('candidate-1')!({
      kind: 'candidate',
      candidateId: 'candidate-1',
      rationale: 'EXIF',
    });
    try {
      await waitFor(() => expect(review.apply).toHaveBeenCalledTimes(1));
      expect(review.apply.mock.calls[0][0]).toMatchObject({
        reviewId: 'review-1',
        action: { provenance: { fileSha256: '1'.repeat(64) } },
      });
      expect(service.status().processed).toBe(1);
    } finally {
      releases.get('candidate-0')!({
        kind: 'candidate',
        candidateId: 'candidate-0',
        rationale: 'EXIF',
      });
    }
    await service.wait();
    expect(review.apply.mock.calls.map(([request]) => request.reviewId)).toEqual([
      'review-1',
      'review-0',
    ]);
    expect(review.apply.mock.calls[1][0].action.provenance.fileSha256).toBe('0'.repeat(64));
  });
  it('offers GLM only candidates that pass the review resolver dry run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const conflict = JSON.parse(JSON.stringify(item)) as ReviewItemDTO;
    conflict.evidence.resolution.candidates[0].id = 'midnight';
    conflict.evidence.resolution.candidates[0].value.localIso = '1999-06-03T00:00:00';
    conflict.evidence.resolution.candidates.push({
      ...conflict.evidence.resolution.candidates[0],
      id: 'credible',
      value: { localIso: '2025-08-16T20:01:35', precision: 'second', zoneBasis: 'floating-local' },
    });
    const review = deterministic({
      list: jest.fn(async () => ({ items: [conflict] })),
      get: jest.fn(async () => conflict),
      preflightAIEstimateCandidates: jest.fn(async () => ['credible']),
      dryRun: jest.fn(async () => ({ planToken: 'p', collision: false })),
      apply: jest.fn(async () => ({ status: 'resolved' })),
    });
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'credible',
        rationale: 'supported',
      })),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(client.propose.mock.calls[0][0].candidateIds).toEqual(['credible']);
    expect(review.preflightAIEstimateCandidates).toHaveBeenCalledTimes(1);
    expect(review.preflightAIEstimateCandidates.mock.calls[0][0].candidates).toHaveLength(2);
    expect(service.status()).toMatchObject({ resolved: 1, failed: 0 });
  });

  it('abstains without a paid request when all candidates fail trusted dry run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      preflightAIEstimateCandidates: jest.fn(async () => []),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    const client = { propose: jest.fn() };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ abstained: 1, failed: 0 });
    expect(client.propose).not.toHaveBeenCalled();
  });

  it('treats a later resolver rejection as abstention without applying', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest
        .fn()
        .mockRejectedValueOnce(new Error('review action did not produce a trusted resolution'))
        .mockResolvedValue({ planToken: 'p', collision: false }),
      apply: jest.fn(),
    });
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'candidate-1',
        rationale: 'EXIF',
      })),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ abstained: 1, failed: 0 });
    expect(review.apply).not.toHaveBeenCalled();
  });
  it('runs at most four proposals while applying results serially', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const rows = Array.from({ length: 6 }, (_, n) => ({ ...item, reviewId: `review-${n}` }));
    const review = deterministic({
      list: jest.fn(async () => ({ items: rows })),
      get: jest.fn(async (id: string) => rows.find((row) => row.reviewId === id)!),
      dryRun: jest.fn(async () => ({ planToken: 'p', collision: false })),
      apply: jest.fn(async (request: { reviewId: string }) => ({
        reviewId: request.reviewId,
        status: 'resolved',
      })),
    });
    const releases: Array<(value: unknown) => void> = [];
    let active = 0;
    let peak = 0;
    const client = {
      propose: jest.fn(() => {
        active++;
        peak = Math.max(peak, active);
        return new Promise((resolve) => {
          releases.push((value) => {
            active--;
            resolve(value);
          });
        });
      }),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await waitFor(() => expect(releases).toHaveLength(4));
    expect(peak).toBe(4);
    expect(review.apply).not.toHaveBeenCalled();
    for (let n = 0; n < 6; n++) {
      releases[n]({ kind: 'candidate', candidateId: 'candidate-1', rationale: 'EXIF' });
      if (n < 2) await waitFor(() => expect(releases).toHaveLength(n + 5));
    }
    await service.wait();
    expect(peak).toBe(4);
    expect(review.apply.mock.calls.map(([request]) => request.reviewId)).toEqual(
      rows.map((row) => row.reviewId)
    );
  });
  it('reduces proposal concurrency after a 429 without losing settled peers', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const rows = Array.from({ length: 5 }, (_, n) => ({ ...item, reviewId: `review-${n}` }));
    const review = deterministic({
      list: jest.fn(async () => ({ items: rows })),
      get: jest.fn(async (id: string) => rows.find((row) => row.reviewId === id)!),
      dryRun: jest.fn(async () => ({ planToken: 'p', collision: false })),
      apply: jest.fn(async () => ({ status: 'resolved' })),
    });
    const releases: Array<(value: unknown) => void> = [];
    const client = {
      propose: jest.fn(
        () =>
          new Promise((resolve, reject) => {
            releases.push((value) => (value instanceof Error ? reject(value) : resolve(value)));
          })
      ),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await waitFor(() => expect(releases).toHaveLength(4));
    releases[1](new Error('AI request failed with HTTP 429'));
    await waitFor(() => expect(service.status().processed).toBe(1));
    expect(releases).toHaveLength(4);
    for (const index of [2, 3, 0]) {
      releases[index]({ kind: 'candidate', candidateId: 'candidate-1', rationale: 'EXIF' });
      await waitFor(() =>
        expect(service.status().processed).toBe(index === 2 ? 2 : index === 3 ? 3 : 4)
      );
    }
    await waitFor(() => expect(releases).toHaveLength(5));
    releases[4]({ kind: 'candidate', candidateId: 'candidate-1', rationale: 'EXIF' });
    await service.wait();
    expect(service.status()).toMatchObject({
      phase: 'completed',
      processed: 5,
      resolved: 4,
      failed: 1,
    });
  });
  it('stops proposal dispatch and drains peers on authentication failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const rows = Array.from({ length: 8 }, (_, n) => ({ ...item, reviewId: `review-${n}` }));
    const review = deterministic({
      list: jest.fn(async () => ({ items: rows })),
      get: jest.fn(async (id: string) => rows.find((row) => row.reviewId === id)!),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    let calls = 0;
    const client = {
      propose: jest.fn(({ signal }: { signal?: AbortSignal }) => {
        calls++;
        if (calls === 2) return Promise.reject(new AiReviewAuthenticationError());
        return new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        );
      }),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status().phase).toBe('failed');
    expect(client.propose.mock.calls.length).toBeLessThanOrEqual(4);
    expect(review.apply).not.toHaveBeenCalled();
  });

  it('cancels and drains pending proposal calls without applying them', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const rows = Array.from({ length: 6 }, (_, n) => ({ ...item, reviewId: `review-${n}` }));
    const review = deterministic({
      list: jest.fn(async () => ({ items: rows })),
      get: jest.fn(async (id: string) => rows.find((row) => row.reviewId === id)!),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    const client = {
      propose: jest.fn(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
      ),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await waitFor(() => expect(client.propose).toHaveBeenCalledTimes(4));
    service.cancel();
    await service.wait();
    expect(service.status().phase).toBe('cancelled');
    expect(review.apply).not.toHaveBeenCalled();
  });

  it('rejects a stale output binding before AI apply', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    let gets = 0;
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => {
        gets++;
        return gets === 3 ? { ...item, output: { ...item.output, sha256: 'b'.repeat(64) } } : item;
      }),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'candidate-1',
        rationale: 'EXIF',
      })),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ failed: 1, resolved: 0 });
    expect(review.apply).not.toHaveBeenCalled();
  });
  it('classifies automatic apply validation errors without exposing paths or keys', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    review.automaticRetryApply.mockRejectedValueOnce(
      Object.assign(new Error('invalid override record'), { code: 'INVALID_INPUT' })
    );
    const service = new AiReviewBatchService({
      review,
      client: { propose: jest.fn() },
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'private-secret' });
    await service.wait();
    expect(review.withTransactionSession).toHaveBeenCalledTimes(1);
    expect(service.status().lastFailure).toEqual({
      stage: 'automatic-apply',
      code: 'INVALID_INPUT',
      detail: 'invalid override record',
    });
    const ledger = await readFile(path.join(dir, 'ledger.jsonl'), 'utf8');
    expect(ledger).toContain('INVALID_INPUT');
    expect(ledger).not.toContain('private-secret');
  });
  it('redacts unknown automatic apply errors while retaining their cause', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    review.automaticRetryApply.mockRejectedValueOnce(
      new Error('descriptor mismatch at /private/media/file.jpeg using private-secret')
    );
    const service = new AiReviewBatchService({
      review,
      client: { propose: jest.fn() },
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'private-secret' });
    await service.wait();
    const detail = service.status().lastFailure?.detail ?? '';
    expect(detail).toContain('descriptor mismatch');
    expect(detail).not.toContain('/private/media/file.jpeg');
    expect(detail).not.toContain('private-secret');
  });
  it('continues after one review binding fails with EIO', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const second = { ...item, reviewId: 'review-2' };
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item, second] })),
      get: jest.fn(async (id: string) => {
        if (id === item.reviewId) throw Object.assign(new Error('unreadable'), { code: 'EIO' });
        return second;
      }),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    const client = { propose: jest.fn(async () => ({ kind: 'abstain', rationale: 'uncertain' })) };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({
      phase: 'completed',
      total: 2,
      processed: 2,
      failed: 1,
      abstained: 1,
      lastFailure: { stage: 'binding', code: 'EIO' },
    });
    expect(client.propose).toHaveBeenCalledTimes(1);
  });
  it('resolves deterministically before any paid model call', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(),
      apply: jest.fn(),
    });
    review.automaticRetryDryRun.mockResolvedValueOnce({
      planToken: 'auto',
      targetPath: '/output.jpg',
      collision: false,
    });
    review.automaticRetryApply.mockResolvedValueOnce({ status: 'resolved' });
    const client = { propose: jest.fn() };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ resolved: 1, deterministicResolved: 1 });
    expect(client.propose).not.toHaveBeenCalled();
  });

  it('uses refreshed evidence after deterministic retry remains pending', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const refreshed = JSON.parse(JSON.stringify(item)) as ReviewItemDTO;
    refreshed.evidence.revision = 'rev-2';
    refreshed.evidence.resolution.candidates[0].id = 'candidate-2';
    const review = deterministic({
      list: jest.fn(async () => ({ items: [item] })),
      get: jest
        .fn()
        .mockResolvedValueOnce(item)
        .mockResolvedValueOnce(refreshed)
        .mockResolvedValueOnce(refreshed),
      dryRun: jest.fn(async () => ({ planToken: 'plan', collision: false })),
      apply: jest.fn(async () => ({ status: 'resolved' })),
    });
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'candidate-2',
        rationale: 'EXIF',
      })),
    };
    const service = new AiReviewBatchService({
      review,
      client,
      metadataReader: defaultMetadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(client.propose.mock.calls[0][0].candidateIds).toEqual(['candidate-2']);
    expect(review.apply.mock.calls[0][0].evidenceRevision).toBe('rev-2');
  });
  it('sends bounded creation metadata and omits paths and GPS coordinates', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = {
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(async () => ({ planToken: 'p', collision: false })),
      apply: jest.fn(async () => ({ status: 'resolved' })),
    };
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'candidate-1',
        rationale: 'EXIF and original filename',
      })),
    };
    const metadataReader = {
      read: jest.fn(async () => ({
        'EXIF:DateTimeOriginal': '2020:01:02 03:04:05',
        'EXIF:ModifyDate': '2022:01:02 03:04:05',
        'ICC_Profile:ProfileDateTime': '2014:01:01 00:00:00',
        'XMP:OriginalFileName': 'IMG_20200102_030405.jpg',
        'GPS:GPSLatitude': '40.0',
        'File:Directory': '/private/path',
        'EXIF:SerialNumber': 'secret-device',
      })),
    };
    const service = new AiReviewBatchService({
      review: deterministic(review),
      client,
      metadataReader,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    const sent = JSON.stringify(client.propose.mock.calls[0][0].evidence);
    expect(sent).toContain('DateTimeOriginal');
    expect(sent).toContain('ModifyDate');
    expect(sent).not.toContain('ProfileDateTime');
    expect(sent).toContain('OriginalFileName');
    expect(sent).not.toContain('GPSLatitude');
    expect(sent).not.toContain('/private/path');
    expect(sent).not.toContain('secret-device');
  });
  it('skips files with no eligible dates without a paid model request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const empty = JSON.parse(JSON.stringify(item)) as ReviewItemDTO;
    empty.evidence.resolution.candidates = [];
    const review = {
      list: jest.fn(async () => ({ items: [empty] })),
      get: jest.fn(async () => empty),
      dryRun: jest.fn(),
      apply: jest.fn(),
    };
    const client = { propose: jest.fn() };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ phase: 'completed', abstained: 1 });
    expect(client.propose).not.toHaveBeenCalled();
  });

  it('stops globally after authentication rejection', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = {
      list: jest.fn(async () => ({ items: [item, { ...item, reviewId: 'review-2' }] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(),
      apply: jest.fn(),
    };
    const client = {
      propose: jest.fn(async () => {
        throw new AiReviewAuthenticationError();
      }),
    };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ phase: 'failed', processed: 0, failed: 0 });
    expect(client.propose).toHaveBeenCalledTimes(1);
    expect(service.status().error).not.toContain('secret');
  });
  it('drops unsupported fractional precision and retries failed transactions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const fractional = JSON.parse(JSON.stringify(item)) as ReviewItemDTO;
    fractional.evidence.resolution.candidates[0].value = {
      localIso: '2020-01-02T03:04:05.123',
      precision: 'millisecond',
      zoneBasis: 'floating-local',
      fractionalDigits: '123',
    };
    const review = {
      list: jest.fn(async () => ({ items: [fractional] })),
      get: jest.fn(async () => fractional),
      dryRun: jest.fn(async () => ({ planToken: 'p', collision: false })),
      apply: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary'))
        .mockResolvedValueOnce({ status: 'resolved' }),
    };
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'candidate-1',
        rationale: 'metadata',
      })),
    };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status().failed).toBe(1);
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(review.apply).toHaveBeenCalledTimes(2);
    expect(review.apply.mock.calls[1][0].action.value).toEqual({
      localIso: '2020-01-02T03:04:05',
      precision: 'second',
      zoneBasis: 'floating-local',
    });
  });

  it('recovers a torn final ledger line and refuses a symlink ledger', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const ledgerPath = path.join(dir, 'ledger.jsonl');
    await writeFile(ledgerPath, '{"key":"bad",');
    await chmod(ledgerPath, 0o600);
    const review = {
      list: jest.fn(async () => ({ items: [] })),
      get: jest.fn(),
      dryRun: jest.fn(),
      apply: jest.fn(),
    };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client: { propose: jest.fn() },
      ledgerPath,
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status().phase).toBe('completed');
    expect(await readFile(ledgerPath, 'utf8')).toBe('');
    const linked = path.join(dir, 'linked.jsonl');
    await symlink(ledgerPath, linked);
    const rejected = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client: { propose: jest.fn() },
      ledgerPath: linked,
    });
    await rejected.start({ apiKey: 'secret' });
    await rejected.wait();
    expect(rejected.status().phase).toBe('failed');
  });

  it('cancels between model proposal and transaction', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = {
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(),
      apply: jest.fn(),
    };
    const holder: { service?: AiReviewBatchService } = {};
    const client = {
      propose: jest.fn(async () => {
        holder.service?.cancel();
        return { kind: 'candidate', candidateId: 'candidate-1', rationale: 'x' };
      }),
    };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    holder.service = service;
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status().phase).toBe('cancelled');
    expect(review.apply).not.toHaveBeenCalled();
  });

  it('keeps stale and colliding items pending and permits another attempt', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = {
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest
        .fn()
        .mockRejectedValueOnce(new Error('review evidence revision is stale'))
        .mockResolvedValueOnce({ planToken: 'p', collision: true })
        .mockResolvedValue({ planToken: 'p', collision: false }),
      apply: jest.fn(),
    };
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'candidate-1',
        rationale: 'EXIF',
      })),
    };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ phase: 'completed', failed: 1, resolved: 0 });
    expect(client.propose).toHaveBeenCalledTimes(2);
    expect(review.apply).not.toHaveBeenCalled();
  });
  it('applies a supported AI estimate and resumes without another paid call', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = {
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(async () => ({ planToken: 'plan', collision: false })),
      apply: jest.fn(async () => ({ status: 'resolved' })),
    };
    const client = {
      propose: jest.fn(async () => ({
        kind: 'candidate',
        candidateId: 'candidate-1',
        rationale: 'EXIF capture field',
      })),
    };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ phase: 'completed', total: 1, resolved: 1 });
    expect(review.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          type: 'ai-estimate',
          candidateId: 'candidate-1',
          provenance: expect.objectContaining({
            model: 'glm-5.3',
            evidenceRevision: 'rev-1',
            fileSha256: 'a'.repeat(64),
          }),
        }),
      })
    );
    expect(await readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).not.toContain('secret');
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(client.propose).toHaveBeenCalledTimes(1);
  });

  it('abstains on an invented date and checkpoints it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'meta-ai-batch-'));
    const review = {
      list: jest.fn(async () => ({ items: [item] })),
      get: jest.fn(async () => item),
      dryRun: jest.fn(),
      apply: jest.fn(),
    };
    const client = {
      propose: jest.fn(async () => ({
        kind: 'date',
        date: '1999-01-01',
        precision: 'date',
        rationale: 'guess',
      })),
    };
    const service = new AiReviewBatchService({
      metadataReader: defaultMetadataReader,
      review: deterministic(review),
      client,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    });
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(service.status()).toMatchObject({ abstained: 1, resolved: 0 });
    expect(review.apply).not.toHaveBeenCalled();
    await service.start({ apiKey: 'secret' });
    await service.wait();
    expect(client.propose).toHaveBeenCalledTimes(1);
  });
});
