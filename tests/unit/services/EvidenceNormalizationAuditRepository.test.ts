import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

import { EvidenceManifest } from '../../../src/main/core/evidence/EvidenceManifest';
import { EvidenceNormalizationAuditRepository } from '../../../src/main/services/EvidenceNormalizationAuditRepository';

function resolvedRecord(fileId: string) {
  const selectedValue = {
    localIso: '2020-01-02T03:04:05',
    zoneBasis: 'floating-local' as const,
    precision: 'second' as const,
  };
  const candidate = (id: string, sourceKind: 'embedded-exif' | 'embedded-xmp') => ({
    id,
    fileId,
    mediaKind: 'image' as const,
    semantic: 'capture' as const,
    sourceKind,
    sourceFamily: sourceKind === 'embedded-exif' ? 'EXIF' : 'XMP',
    tag: sourceKind === 'embedded-exif' ? 'EXIF:DateTimeOriginal' : 'XMP:DateCreated',
    rawValue: '2020:01:02 03:04:05',
    value: selectedValue,
    eligibility: 'eligible' as const,
    score: { base: 95, modifiers: [], semanticCap: 100, final: 95 },
    resolutionIssues: [],
  });
  return {
    policyVersion: 'date-resolution/1',
    fileId,
    mediaKind: 'image' as const,
    target: 'capture-time' as const,
    evaluationTimeUtc: '2026-09-08T00:00:00.000Z',
    status: 'resolved' as const,
    confidence: 'high' as const,
    selectedCandidateId: 'selected',
    selectedGroupId: 'group-1',
    selectedGroupScore: 98,
    selectedValue,
    contenderIds: ['selected', 'corroborator'],
    rejected: [],
    reasonCodes: ['INDEPENDENT_CORROBORATION', 'RESOLVED_HIGH_CONFIDENCE'],
    candidates: [candidate('selected', 'embedded-exif'), candidate('corroborator', 'embedded-xmp')],
  };
}

async function writeSealedPreview(
  root: string,
  previewId: string,
  rows: number,
  resolutionFactory: (index: number) => ReturnType<typeof resolvedRecord> = (index) =>
    resolvedRecord(`file-${index}`)
): Promise<void> {
  const manifest = await EvidenceManifest.create(
    path.join(root, `${previewId}.evidence.jsonl`),
    `job-${previewId}`,
    'date-resolution/1'
  );
  await manifest.append('preview-recorded', { preview: { previewId }, rowCount: rows });
  for (let index = 0; index < rows; index += 1) {
    await manifest.append('resolution-decided', {
      previewId,
      rowIndex: index,
      sourcePath: `/source/${index}.jpg`,
      resolution: resolutionFactory(index),
    });
  }
  for (let index = 0; index < rows; index += 1) {
    await manifest.append('operation-planned', {
      previewId,
      operation: {
        operationId: `operation-${index}`,
        decisionRowIndex: index,
        targetPath: `/output/${index}.jpg`,
      },
    });
  }
  await manifest.append('preview-sealed', { previewId, decisionCount: rows, operationCount: rows });
  await manifest.close({ status: 'completed' });
}

describe('EvidenceNormalizationAuditRepository', () => {
  it('honors pre-aborted authorization without searching or poisoning its cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-abort-'));
    try {
      const repository = await EvidenceNormalizationAuditRepository.open(root);
      const controller = new AbortController();
      controller.abort();
      const request = {
        previewId: 'missing',
        recordId: 'op',
        sourcePath: '/in.jpg',
        outputPath: '/out.jpg',
        resolution: {} as never,
        signal: controller.signal,
      };
      await expect(repository.authorizeNormalization(request)).rejects.toThrow(/abort/i);
      await expect(
        repository.authorizeNormalization({ ...request, signal: undefined })
      ).rejects.toThrow(/dataset/i);
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('does not leak a cancelled caller abort into the next authorization', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-retry-'));
    try {
      const manifest = await EvidenceManifest.create(
        path.join(root, 'job.evidence.jsonl'),
        'job-retry',
        'date-resolution/1'
      );
      await manifest.append('preview-recorded', {
        preview: { previewId: 'preview-retry' },
        rowCount: 1,
      });
      await manifest.append('resolution-decided', {
        previewId: 'preview-retry',
        rowIndex: 0,
        sourcePath: '/source/retry.jpg',
        resolution: {
          policyVersion: 'date-resolution/1',
          fileId: 'retry',
          mediaKind: 'image',
          target: 'capture-time',
          evaluationTimeUtc: '2026-09-08T00:00:00.000Z',
          status: 'unresolved',
          confidence: 'low',
          contenderIds: [],
          rejected: [],
          reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
          candidates: [],
        },
      });
      await manifest.append('operation-planned', {
        previewId: 'preview-retry',
        operation: {
          operationId: 'operation-retry',
          decisionRowIndex: 0,
          targetPath: '/output/retry.jpg',
        },
      });
      await manifest.append('preview-sealed', {
        previewId: 'preview-retry',
        decisionCount: 1,
        operationCount: 1,
      });
      await manifest.close({ status: 'completed' });

      const repository = await EvidenceNormalizationAuditRepository.open(root);
      const controller = new AbortController();
      const resolution = {
        policyVersion: 'date-resolution/1',
        fileId: 'retry',
        mediaKind: 'image' as const,
        target: 'capture-time' as const,
        evaluationTimeUtc: '2026-09-08T00:00:00.000Z',
        status: 'unresolved' as const,
        confidence: 'low' as const,
        contenderIds: [],
        rejected: [],
        reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
        candidates: [],
      };
      const request = {
        previewId: 'preview-retry',
        recordId: 'operation-retry',
        sourcePath: '/source/retry.jpg',
        outputPath: '/output/retry.jpg',
        resolution,
      };
      // Cancel mid-preparation: the abort fires from the first progress report,
      // poisoning the shared dataset build that is still settling.
      await expect(
        repository.authorizeNormalization({
          ...request,
          signal: controller.signal,
          reportProgress: () => {
            controller.abort();
          },
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
      // An immediate retry without a signal must rebuild instead of inheriting
      // the previous caller's abort.
      await expect(repository.authorizeNormalization(request)).resolves.toBe(false);
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('opens a sealed preview before the job manifest reaches terminal closure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-live-preview-audit-'));
    try {
      const manifest = await EvidenceManifest.create(
        path.join(root, 'live.evidence.jsonl'),
        'job-live',
        'date-resolution/1'
      );
      await manifest.append('preview-recorded', {
        preview: { previewId: 'preview-live' },
        rowCount: 1,
      });
      await manifest.append('resolution-decided', {
        previewId: 'preview-live',
        rowIndex: 0,
        sourcePath: '/source/live.jpg',
        resolution: {
          policyVersion: 'date-resolution/1',
          fileId: 'live',
          mediaKind: 'image',
          target: 'capture-time',
          evaluationTimeUtc: '2026-09-08T00:00:00.000Z',
          status: 'unresolved',
          confidence: 'low',
          contenderIds: [],
          rejected: [],
          reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
          candidates: [],
        },
      });
      await manifest.append('operation-planned', {
        previewId: 'preview-live',
        operation: {
          operationId: 'operation-live',
          decisionRowIndex: 0,
          targetPath: '/output/live.jpg',
        },
      });
      await manifest.append('preview-sealed', {
        previewId: 'preview-live',
        decisionCount: 1,
        operationCount: 1,
      });

      const repository = await EvidenceNormalizationAuditRepository.open(root);
      await expect(repository.summary({ previewId: 'preview-live' })).resolves.toMatchObject({
        total: 1,
      });
      await repository.close();
      await manifest.close({ status: 'cancelled-after-audit' });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('builds and reuses a durable bounded audit dataset from a closed evidence manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-repository-'));
    try {
      const manifest = await EvidenceManifest.create(
        path.join(root, 'job.evidence.jsonl'),
        'job-1',
        'date-resolution/1'
      );
      await manifest.append('preview-recorded', {
        preview: { previewId: 'preview-1' },
        rowCount: 1,
      });
      await manifest.append('resolution-decided', {
        previewId: 'preview-1',
        rowIndex: 0,
        sourcePath: '/source/photo.jpg',
        resolution: {
          policyVersion: 'date-resolution/1',
          fileId: 'file-1',
          mediaKind: 'image',
          target: 'capture-time',
          evaluationTimeUtc: '2026-09-08T00:00:00.000Z',
          status: 'unresolved',
          confidence: 'low',
          contenderIds: [],
          rejected: [],
          reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
          candidates: [],
        },
      });
      await manifest.append('operation-planned', {
        previewId: 'preview-1',
        operation: {
          operationId: 'operation-1',
          decisionRowIndex: 0,
          targetPath: '/output/photo.jpg',
        },
      });
      await manifest.append('preview-sealed', {
        previewId: 'preview-1',
        decisionCount: 1,
        operationCount: 1,
      });
      await manifest.close({ status: 'completed' });

      const repository = await EvidenceNormalizationAuditRepository.open(root);
      const first = await repository.rows({ previewId: 'preview-1', limit: 100 });
      expect(first).toMatchObject({
        items: [{ sourcePath: '/source/photo.jpg', outputPath: '/output/photo.jpg' }],
      });
      expect((await repository.summary({ previewId: 'preview-1' })).total).toBe(1);
      await expect(
        repository.authorizeNormalization({
          previewId: 'preview-1',
          recordId: 'operation-1',
          sourcePath: '/source/photo.jpg',
          outputPath: '/output/photo.jpg',
          resolution: {
            policyVersion: 'date-resolution/1',
            fileId: 'file-1',
            mediaKind: 'image',
            target: 'capture-time',
            evaluationTimeUtc: '2026-09-08T00:00:00.000Z',
            status: 'unresolved',
            confidence: 'low',
            contenderIds: [],
            rejected: [],
            reasonCodes: ['NO_ELIGIBLE_CANDIDATES'],
            candidates: [],
          },
        })
      ).resolves.toBe(false);
      expect(
        (await fs.readdir(path.join(root, '.normalization-audit'))).some((name) =>
          name.endsWith('.jsonl')
        )
      ).toBe(true);

      const indexName = (await fs.readdir(path.join(root, '.normalization-audit'))).find((name) =>
        /^[0-9a-f]{64}\.jsonl$/.test(name)
      )!;
      await fs.appendFile(path.join(root, '.normalization-audit', indexName), '{}\n');
      await expect(repository.rows({ previewId: 'preview-1', limit: 10 })).rejects.toThrow(/hash/i);
      await repository.close();
      const reopened = await EvidenceNormalizationAuditRepository.open(root);
      await expect(reopened.rows({ previewId: 'preview-1', limit: 10 })).rejects.toThrow(
        /corrupt|hash/i
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked private index root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-symlink-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-outside-'));
    try {
      await fs.symlink(outside, path.join(root, '.normalization-audit'));
      await expect(EvidenceNormalizationAuditRepository.open(root)).rejects.toThrow(/unsafe/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects replacement of the private index directory after opening', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-swap-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-swap-outside-'));
    try {
      const repository = await EvidenceNormalizationAuditRepository.open(root);
      await fs.rename(path.join(root, '.normalization-audit'), path.join(root, 'original-index'));
      await fs.symlink(outside, path.join(root, '.normalization-audit'));
      await expect(repository.rows({ previewId: 'missing', limit: 10 })).rejects.toThrow(
        /identity|unsafe/i
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('fails closed when the requested preview has no closed evidence dataset', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-missing-'));
    try {
      const repository = await EvidenceNormalizationAuditRepository.open(root);
      await expect(repository.rows({ previewId: 'missing', limit: 10 })).rejects.toThrow(
        /dataset/i
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('single-flights preparation across separate repository instances', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-multi-instance-'));
    try {
      await writeSealedPreview(root, 'preview-concurrent', 32);
      const first = await EvidenceNormalizationAuditRepository.open(root);
      const second = await EvidenceNormalizationAuditRepository.open(root);
      const request = {
        previewId: 'preview-concurrent',
        recordId: 'operation-0',
        sourcePath: '/source/0.jpg',
        outputPath: '/output/0.jpg',
        resolution: resolvedRecord('file-0'),
      };
      const [left, right] = await Promise.all([
        first.authorizeNormalization(request),
        second.authorizeNormalization(request),
      ]);
      expect([left, right]).toEqual([true, true]);
      const files = await fs.readdir(path.join(root, '.normalization-audit'));
      expect(files.filter((name) => /^[0-9a-f]{64}\.jsonl$/.test(name))).toHaveLength(1);
      expect(files.some((name) => name.endsWith('.tmp') || name.includes('.decisions'))).toBe(
        false
      );
      await Promise.all([first.close(), second.close()]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('recovers from interrupted index-build artifacts without trusting partial state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-recovery-'));
    try {
      await writeSealedPreview(root, 'preview-recovery', 3);
      const indexRoot = path.join(root, '.normalization-audit');
      await fs.mkdir(indexRoot, { recursive: true });
      await fs.writeFile(path.join(indexRoot, `${process.pid}.tmp`), '{"partial":true}\n');
      await fs.writeFile(
        path.join(indexRoot, `${process.pid}.tmp.decisions`),
        '{"partial":true}\n'
      );
      const repository = await EvidenceNormalizationAuditRepository.open(root);
      await expect(
        repository.authorizeNormalization({
          previewId: 'preview-recovery',
          recordId: 'operation-2',
          sourcePath: '/source/2.jpg',
          outputPath: '/output/2.jpg',
          resolution: resolvedRecord('file-2'),
        })
      ).resolves.toBe(true);
      const files = await fs.readdir(indexRoot);
      expect(files).not.toContain(`${process.pid}.tmp`);
      expect(files).not.toContain(`${process.pid}.tmp.decisions`);
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('authorizes the immutable decision and rejects every binding mismatch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-bindings-'));
    try {
      await writeSealedPreview(root, 'preview-bindings', 1);
      const repository = await EvidenceNormalizationAuditRepository.open(root);
      const request = {
        previewId: 'preview-bindings',
        recordId: 'operation-0',
        sourcePath: '/source/0.jpg',
        outputPath: '/output/0.jpg',
        resolution: resolvedRecord('file-0'),
      };
      await expect(repository.authorizeNormalization(request)).resolves.toBe(true);
      await expect(
        repository.authorizeNormalization({ ...request, recordId: 'operation-missing' })
      ).rejects.toThrow(/bound/i);
      await expect(
        repository.authorizeNormalization({ ...request, sourcePath: '/source/swapped.jpg' })
      ).rejects.toThrow(/source/i);
      await expect(
        repository.authorizeNormalization({ ...request, outputPath: '/output/swapped.jpg' })
      ).rejects.toThrow(/destination/i);
      await expect(
        repository.authorizeNormalization({
          ...request,
          resolution: { ...request.resolution, evaluationTimeUtc: '2026-09-09T00:00:00.000Z' },
        })
      ).rejects.toThrow(/resolution/i);
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale policy metadata and invalidates approvals from another audit revision', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-stale-policy-'));
    try {
      const cohortResolution = resolvedRecord('file-0');
      cohortResolution.reasonCodes = ['RESOLVED_HIGH_CONFIDENCE'];
      cohortResolution.contenderIds = ['selected'];
      cohortResolution.candidates = [cohortResolution.candidates[0]];
      await writeSealedPreview(root, 'preview-policy', 1, () => cohortResolution);
      let repository = await EvidenceNormalizationAuditRepository.open(root);
      const page = (await repository.rows({ previewId: 'preview-policy', limit: 10 })) as {
        revision: string;
        items: Array<{ cohortKey: string }>;
      };
      await repository.approve({
        previewId: 'preview-policy',
        revision: page.revision,
        cohortKey: page.items[0].cohortKey,
        approved: true,
      });
      const request = {
        previewId: 'preview-policy',
        recordId: 'operation-0',
        sourcePath: '/source/0.jpg',
        outputPath: '/output/0.jpg',
        resolution: cohortResolution,
      };
      await expect(repository.authorizeNormalization(request)).resolves.toBe(true);
      await repository.close();

      const digest = createHash('sha256').update('preview-policy').digest('hex');
      const indexRoot = path.join(root, '.normalization-audit');
      const metadataPath = path.join(indexRoot, `${digest}.json`);
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as Record<
        string,
        unknown
      >;
      await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, policyFingerprint: 'stale' }));
      const approvalPath = path.join(indexRoot, `${digest}.approvals.json`);
      const approval = JSON.parse(await fs.readFile(approvalPath, 'utf8')) as Record<
        string,
        unknown
      >;
      await fs.writeFile(approvalPath, JSON.stringify({ ...approval, revision: 'stale-revision' }));

      repository = await EvidenceNormalizationAuditRepository.open(root);
      await expect(repository.authorizeNormalization(request)).resolves.toBe(false);
      const rebuilt = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
        policyFingerprint?: string;
      };
      expect(rebuilt.policyFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(rebuilt.policyFingerprint).not.toBe('stale');
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('classifies unsupported output formats consistently across every repository view', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-unsupported-'));
    try {
      await writeSealedPreview(root, 'preview-unsupported', 1);
      const manifestPath = path.join(root, 'preview-unsupported.evidence.jsonl');
      const contents = await fs.readFile(manifestPath, 'utf8');
      await fs.writeFile(manifestPath, contents.replace('/output/0.jpg', '/output/0.bmp'));
      // Rewriting invalidates the manifest hashes, so regenerate the fixture with a BMP operation.
      await fs.rm(manifestPath);
      const manifest = await EvidenceManifest.create(
        manifestPath,
        'job-preview-unsupported',
        'date-resolution/1'
      );
      await manifest.append('preview-recorded', {
        preview: { previewId: 'preview-unsupported' },
        rowCount: 1,
      });
      await manifest.append('resolution-decided', {
        previewId: 'preview-unsupported',
        rowIndex: 0,
        sourcePath: '/source/0.jpg',
        resolution: resolvedRecord('file-0'),
      });
      await manifest.append('operation-planned', {
        previewId: 'preview-unsupported',
        operation: { operationId: 'operation-0', decisionRowIndex: 0, targetPath: '/output/0.bmp' },
      });
      await manifest.append('preview-sealed', {
        previewId: 'preview-unsupported',
        decisionCount: 1,
        operationCount: 1,
      });
      await manifest.close({ status: 'completed' });

      const repository = await EvidenceNormalizationAuditRepository.open(root);
      const page = (await repository.rows({ previewId: 'preview-unsupported', limit: 10 })) as {
        revision: string;
        items: Array<{ disposition: string }>;
      };
      expect(page.items).toMatchObject([{ disposition: 'skip-unsupported' }]);
      await expect(
        repository.decision({ previewId: 'preview-unsupported', recordId: 'row-0000000000000000' })
      ).resolves.toMatchObject({ disposition: 'skip-unsupported' });
      await expect(repository.summary({ previewId: 'preview-unsupported' })).resolves.toMatchObject(
        {
          total: 1,
          dispositions: { 'skip-unsupported': 1 },
        }
      );
      await expect(
        repository.dryRun({ previewId: 'preview-unsupported', revision: page.revision, limit: 10 })
      ).resolves.toMatchObject({ items: [] });
      await expect(
        repository.authorizeNormalization({
          previewId: 'preview-unsupported',
          recordId: 'operation-0',
          sourcePath: '/source/0.jpg',
          outputPath: '/output/0.bmp',
          resolution: resolvedRecord('file-0'),
        })
      ).resolves.toBe(false);
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('merges concurrent approvals from separate repository instances without losing either cohort', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-approval-merge-'));
    try {
      const firstResolution = resolvedRecord('file-0');
      firstResolution.reasonCodes = ['RESOLVED_HIGH_CONFIDENCE'];
      firstResolution.contenderIds = ['selected'];
      firstResolution.candidates = [firstResolution.candidates[0]];
      const secondResolution = resolvedRecord('file-1');
      secondResolution.reasonCodes = ['RESOLVED_HIGH_CONFIDENCE'];
      secondResolution.contenderIds = ['selected'];
      secondResolution.candidates = [
        {
          ...secondResolution.candidates[0],
          sourceKind: 'embedded-xmp',
          sourceFamily: 'XMP',
          tag: 'XMP:DateCreated',
        },
      ];
      await writeSealedPreview(root, 'preview-approval-merge', 2, (index) =>
        index === 0 ? firstResolution : secondResolution
      );
      await fs.mkdir(path.join(root, 'alias-segment'));
      const first = await EvidenceNormalizationAuditRepository.open(root);
      const second = await EvidenceNormalizationAuditRepository.open(
        path.join(root, 'alias-segment', '..')
      );
      const page = (await first.rows({ previewId: 'preview-approval-merge', limit: 10 })) as {
        revision: string;
        items: Array<{ cohortKey: string }>;
      };
      expect(new Set(page.items.map((item) => item.cohortKey)).size).toBe(2);
      await Promise.all([
        first.approve({
          previewId: 'preview-approval-merge',
          revision: page.revision,
          cohortKey: page.items[0].cohortKey,
          approved: true,
        }),
        second.approve({
          previewId: 'preview-approval-merge',
          revision: page.revision,
          cohortKey: page.items[1].cohortKey,
          approved: true,
        }),
      ]);
      await expect(
        first.authorizeNormalization({
          previewId: 'preview-approval-merge',
          recordId: 'operation-0',
          sourcePath: '/source/0.jpg',
          outputPath: '/output/0.jpg',
          resolution: firstResolution,
        })
      ).resolves.toBe(true);
      await expect(
        second.authorizeNormalization({
          previewId: 'preview-approval-merge',
          recordId: 'operation-1',
          sourcePath: '/source/1.jpg',
          outputPath: '/output/1.jpg',
          resolution: secondResolution,
        })
      ).resolves.toBe(true);
      await Promise.all([first.close(), second.close()]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports bounded progress and cancellation while preparing a large evidence dataset', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-large-cancel-'));
    try {
      await writeSealedPreview(root, 'preview-large', 1_024);
      const repository = await EvidenceNormalizationAuditRepository.open(root);
      const controller = new AbortController();
      const progress: Array<{ stage: string; completed: number; total?: number }> = [];
      await expect(
        repository.authorizeNormalization({
          previewId: 'preview-large',
          recordId: 'operation-1023',
          sourcePath: '/source/1023.jpg',
          outputPath: '/output/1023.jpg',
          resolution: resolvedRecord('file-1023'),
          signal: controller.signal,
          reportProgress: (update) => {
            progress.push(update);
            if (progress.length === 3) controller.abort();
          },
        })
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(progress.length).toBeGreaterThanOrEqual(3);
      expect(progress.every((item) => item.completed >= 0)).toBe(true);
      expect(progress.some((item) => item.total !== undefined && item.total > 0)).toBe(true);
      const indexRoot = path.join(root, '.normalization-audit');
      expect(
        (await fs.readdir(indexRoot)).filter(
          (name) =>
            name.endsWith('.tmp') || name.includes('.decisions') || name.includes('.buckets')
        )
      ).toEqual([]);
      await expect(
        repository.authorizeNormalization({
          previewId: 'preview-large',
          recordId: 'operation-1023',
          sourcePath: '/source/1023.jpg',
          outputPath: '/output/1023.jpg',
          resolution: resolvedRecord('file-1023'),
        })
      ).resolves.toBe(true);
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('cleans randomized preparation artifacts after malformed evidence and retries after repair', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-audit-error-cleanup-'));
    try {
      await writeSealedPreview(root, 'preview-error-cleanup', 4);
      const manifestPath = path.join(root, 'preview-error-cleanup.evidence.jsonl');
      const valid = await fs.readFile(manifestPath, 'utf8');
      await fs.writeFile(
        manifestPath,
        valid
          .split('\n')
          .filter(
            (line) => line && !line.includes('preview-sealed') && !line.includes('job-finished')
          )
          .join('\n') + '\n'
      );
      const repository = await EvidenceNormalizationAuditRepository.open(root);
      const request = {
        previewId: 'preview-error-cleanup',
        recordId: 'operation-3',
        sourcePath: '/source/3.jpg',
        outputPath: '/output/3.jpg',
        resolution: resolvedRecord('file-3'),
      };
      await expect(repository.authorizeNormalization(request)).rejects.toThrow(
        /closed|valid|dataset|sealed/i
      );
      const indexRoot = path.join(root, '.normalization-audit');
      expect(
        (await fs.readdir(indexRoot)).filter(
          (name) =>
            name.endsWith('.tmp') || name.includes('.decisions') || name.includes('.buckets')
        )
      ).toEqual([]);
      await fs.writeFile(manifestPath, valid);
      await expect(repository.authorizeNormalization(request)).resolves.toBe(true);
      await repository.close();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
