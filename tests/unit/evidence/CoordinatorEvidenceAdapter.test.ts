import { lstat, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { EvidenceManifest } from '../../../src/main/core/evidence/EvidenceManifest';
import { CoordinatorEvidenceAdapter } from '../../../src/main/services/CoordinatorEvidenceAdapter';
import {
  ConflictPolicy,
  DateEvidenceSource,
  FolderStructure,
  OperationMode,
  ProcessingEventKind,
  PreviewResultDTO,
  TerminalProcessingEvent,
} from '../../../src/shared/types/processing';
import {
  CoordinatorErrorCode,
  LedgerHistoryRecord,
  PreviewAuditRecord,
  StartRejectionRecord,
} from '../../../src/main/services/ProcessingCoordinator';

const options = {
  operation: OperationMode.COPY,
  conflictPolicy: ConflictPolicy.RENAME,
  folderStructure: FolderStructure.YEAR_MONTH,
  workerCount: 1,
  verifyIntegrity: true,
  appendScreenshotSuffix: false,
  writeMetadataDates: false,
};

function preview(jobId = '9d54e950-f226-4df5-8838-39895197634e'): PreviewResultDTO {
  return {
    jobId,
    previewId: 'f536fc6b-cee5-4a52-a7ab-bec86db1cf8c',
    createdAt: '2026-08-29T12:00:00.000Z',
    expiresAt: '2026-08-29T12:01:00.000Z',
    request: {
      sourcePaths: ['/source'],
      destinationPath: '/destination',
      options,
    },
    effectiveOptions: options,
    summary: {
      totalFiles: 1,
      copyFiles: 1,
      moveFiles: 0,
      skippedFiles: 0,
      renamedFiles: 0,
      overwrittenFiles: 0,
      unresolvedDates: 0,
      totalBytes: 42,
    },
    rows: [
      {
        sourcePath: '/source/image.jpg',
        targetPath: '/destination/2024/01/image.jpg',
        operation: OperationMode.COPY,
        conflictPolicy: ConflictPolicy.RENAME,
        dateEvidence: {
          value: '2024-01-02T03:04:05.123456Z',
          source: DateEvidenceSource.EMBEDDED,
          field: 'EXIF:DateTimeOriginal',
          confidence: 1,
          warnings: ['timezone inferred'],
        },
        fingerprint: {
          size: 42,
          modifiedAt: '2026-08-29T11:59:00.000Z',
          hash: 'a'.repeat(64),
        },
        warnings: ['timezone inferred'],
      },
    ],
  };
}

function terminal(jobId: string): TerminalProcessingEvent {
  return {
    kind: ProcessingEventKind.JOB_COMPLETED,
    jobId,
    sequence: 6,
    emittedAt: '2026-08-29T12:00:10.000Z',
    payload: {
      statistics: {
        totalFiles: 1,
        processedFiles: 1,
        skippedFiles: 0,
        failedFiles: 0,
        totalBytes: 42,
        processedBytes: 42,
        durationMs: 10_000,
      },
    },
  };
}

function audit(prepared: PreviewResultDTO): PreviewAuditRecord {
  return {
    jobId: prepared.jobId,
    previewId: prepared.previewId,
    decisionRecords: [
      {
        rowIndex: 0,
        sourcePath: '/source/image.jpg',
        resolution: {
          policyVersion: 'date-resolution/1',
          fileId: '7:11',
          mediaKind: 'image',
          target: 'capture-time',
          evaluationTimeUtc: '2026-08-29T12:00:00.000Z',
          status: 'resolved',
          confidence: 'high',
          selectedCandidateId: 'candidate-1',
          selectedGroupId: 'group-1',
          selectedGroupScore: 98,
          selectedValue: {
            localIso: '2024-01-02T03:04:05.123456',
            instantUtc: '2024-01-02T03:04:05.123456Z',
            offsetMinutes: 0,
            zoneBasis: 'explicit-offset',
            precision: 'microsecond',
            fractionalDigits: '123456',
          },
          contenderIds: ['candidate-1'],
          rejected: [],
          reasonCodes: ['independent-source-corroboration'],
          candidates: [
            {
              id: 'candidate-1',
              fileId: '7:11',
              mediaKind: 'image',
              semantic: 'capture',
              sourceKind: 'embedded-exif',
              sourceFamily: 'exif-primary',
              tag: 'EXIF:DateTimeOriginal',
              rawValue: '2024:01:02 03:04:05.123456+00:00',
              value: {
                localIso: '2024-01-02T03:04:05.123456',
                instantUtc: '2024-01-02T03:04:05.123456Z',
                offsetMinutes: 0,
                zoneBasis: 'explicit-offset',
                precision: 'microsecond',
                fractionalDigits: '123456',
              },
              eligibility: 'eligible',
              score: {
                base: 95,
                modifiers: [{ code: 'explicit-offset', delta: 3 }],
                semanticCap: 100,
                final: 98,
              },
              resolutionIssues: [],
            },
          ],
        },
      },
    ],
    operationRecords: [
      {
        operationIndex: 0,
        operationId: 'operation-1',
        sourcePath: '/source/image.jpg',
        targetPath: '/destination/2024/01/image.jpg',
        bytes: 42,
        decisionRowIndex: 0,
      },
    ],
  };
}

function batchPreview(count: number): {
  prepared: PreviewResultDTO;
  privateAudit: PreviewAuditRecord;
} {
  const prepared = preview();
  const rowTemplate = prepared.rows![0];
  const decisionTemplate = audit(prepared).decisionRecords[0];
  prepared.rows = Array.from({ length: count }, (_, index) => ({
    ...rowTemplate,
    sourcePath: `/source/image-${index}.jpg`,
    targetPath: `/destination/2024/01/image-${index}.jpg`,
    dateEvidence: { ...rowTemplate.dateEvidence, warnings: [...rowTemplate.dateEvidence.warnings] },
    fingerprint: { ...rowTemplate.fingerprint, size: index },
    warnings: [...rowTemplate.warnings],
  }));
  prepared.summary = {
    ...prepared.summary,
    totalFiles: count,
    copyFiles: count,
    totalBytes: (count * (count - 1)) / 2,
  };
  const decisionRecords = prepared.rows.map((row, index) => {
    const resolution = JSON.parse(
      JSON.stringify(decisionTemplate.resolution)
    ) as typeof decisionTemplate.resolution;
    const fileId = `7:${index + 11}`;
    const candidateId = `candidate-${index}`;
    resolution.fileId = fileId;
    resolution.selectedCandidateId = candidateId;
    resolution.contenderIds = [candidateId];
    resolution.candidates[0].id = candidateId;
    resolution.candidates[0].fileId = fileId;
    return { rowIndex: index, sourcePath: row.sourcePath, resolution };
  });
  return {
    prepared,
    privateAudit: {
      jobId: prepared.jobId,
      previewId: prepared.previewId,
      decisionRecords,
      operationRecords: prepared.rows.map((row, index) => ({
        operationIndex: index,
        operationId: `operation-${index}`,
        sourcePath: row.sourcePath,
        targetPath: row.targetPath!,
        bytes: row.fingerprint.size,
        decisionRowIndex: index,
      })),
    },
  };
}

describe('CoordinatorEvidenceAdapter', () => {
  let parent: string;
  let evidenceRoot: string;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(tmpdir(), 'meta-mover-evidence-adapter-'));
    evidenceRoot = path.join(parent, 'evidence');
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('persists complete preview rows, date resolution, rejection, ledger, and terminal evidence', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    const rejection: StartRejectionRecord = {
      jobId: prepared.jobId,
      previewId: prepared.previewId,
      code: CoordinatorErrorCode.PREVIEW_DRIFT,
      reasons: ['source changed'],
      rejectedAt: '2026-08-29T12:00:02.000Z',
    };
    const ledger: LedgerHistoryRecord = {
      jobId: prepared.jobId,
      previewId: prepared.previewId,
      entry: { operationId: 'operation-1', outcome: 'committed', bytes: 42 },
    };

    const privateAudit = audit(prepared);
    const recording = adapter.recordPreview(prepared, privateAudit);
    privateAudit.decisionRecords[0].resolution.candidates[0].rawValue = 'mutated-after-admission';
    privateAudit.operationRecords[0].targetPath = '/mutated-target.jpg';
    await recording;
    await adapter.recordStartRejection(rejection);
    await adapter.recordLedgerEntry(ledger);
    await adapter.recordTerminal(terminal(prepared.jobId));

    const manifestPath = adapter.manifestPathForJob(prepared.jobId);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: true });
    const events = (await readFile(manifestPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(events.map((event) => event.kind)).toEqual([
      'job-opened',
      'preview-recorded',
      'file-observed',
      'candidate-observed',
      'resolution-decided',
      'operation-planned',
      'start-rejected',
      'operation-committed',
      'job-closed',
    ]);
    const { rows: _rows, ...previewHeader } = prepared;
    expect(events[1].payload).toEqual({ preview: previewHeader, rowCount: 1 });
    expect(events[2].payload).toMatchObject({
      previewId: prepared.previewId,
      rowIndex: 0,
      row: {
        dateEvidence: {
          value: '2024-01-02T03:04:05.123456Z',
          field: 'EXIF:DateTimeOriginal',
          warnings: ['timezone inferred'],
        },
      },
    });
    expect(events[3].payload).toMatchObject({
      previewId: prepared.previewId,
      rowIndex: 0,
      candidateIndex: 0,
      sourcePath: '/source/image.jpg',
      candidate: {
        id: 'candidate-1',
        rawValue: '2024:01:02 03:04:05.123456+00:00',
      },
    });
    expect(events[4].payload).toEqual({
      previewId: prepared.previewId,
      rowIndex: 0,
      sourcePath: '/source/image.jpg',
      resolution: audit(prepared).decisionRecords[0].resolution,
    });
    expect(events[5].payload).toEqual({
      previewId: prepared.previewId,
      operation: {
        operationIndex: 0,
        operationId: 'operation-1',
        sourcePath: '/source/image.jpg',
        targetPath: '/destination/2024/01/image.jpg',
        bytes: 42,
        decisionRowIndex: 0,
      },
    });
    expect(JSON.stringify(events[1].payload)).not.toContain('rawValue');
    expect(JSON.stringify(events[2].payload)).not.toContain('rawValue');
    expect(events[8].payload).toEqual({ terminal: terminal(prepared.jobId) });
    if (process.platform !== 'win32') {
      expect((await lstat(evidenceRoot)).mode & 0o777).toBe(0o700);
    }
  });

  it('rejects audit records that add fields or disagree with the public operation mapping', async () => {
    const prepared = preview();
    const withUnknownField = audit(prepared) as PreviewAuditRecord & { secret?: string };
    withUnknownField.secret = 'must-not-be-admitted';
    const first = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });

    await expect(first.recordPreview(prepared, withUnknownField)).rejects.toThrow(
      /unknown fields|schema/i
    );
    await expect(first.shutdown()).rejects.toThrow(/failed/i);

    const secondRoot = path.join(parent, 'second-evidence');
    const second = await CoordinatorEvidenceAdapter.create({
      evidenceRoot: secondRoot,
      policyVersion: 'date-policy/1',
    });
    const mismatched = audit(prepared);
    mismatched.operationRecords[0].targetPath = '/destination/substituted.jpg';
    await expect(second.recordPreview(prepared, mismatched)).rejects.toThrow(/disagrees|mapping/i);
    await expect(second.shutdown()).rejects.toThrow(/failed/i);
  });

  it('persists planner-shaped supported conflict skips while keeping unsupported skips decision-free', async () => {
    const supported = preview('supported-conflict-skip');
    supported.summary.copyFiles = 0;
    supported.summary.skippedFiles = 1;
    supported.rows![0].operation = 'skip';
    supported.rows![0].warnings.push('Target already exists');
    const supportedAudit = audit(supported);
    supportedAudit.operationRecords = [];
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    await adapter.recordPreview(supported, supportedAudit);
    await adapter.shutdown();

    const unsupported = preview('unsupported-skip');
    unsupported.summary.copyFiles = 0;
    unsupported.summary.skippedFiles = 1;
    unsupported.summary.unresolvedDates = 1;
    unsupported.rows![0] = {
      ...unsupported.rows![0],
      targetPath: null,
      operation: 'skip',
      dateEvidence: {
        value: null,
        source: DateEvidenceSource.UNRESOLVED,
        confidence: 0,
        warnings: ['Needs Review'],
      },
      warnings: ['Needs Review', 'Creation date requires review'],
    };
    const second = await CoordinatorEvidenceAdapter.create({
      evidenceRoot: path.join(parent, 'unsupported-evidence'),
      policyVersion: 'date-policy/1',
    });
    await second.recordPreview(unsupported, {
      jobId: unsupported.jobId,
      previewId: unsupported.previewId,
      decisionRecords: [],
      operationRecords: [],
    });
    await second.shutdown();
  });

  it('rejects contradictory resolution semantics and public date projections', async () => {
    const prepared = preview('contradictory-resolution');
    const privateAudit = audit(prepared);
    privateAudit.decisionRecords[0].resolution.candidates[0].mediaKind = 'video';
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    await expect(adapter.recordPreview(prepared, privateAudit)).rejects.toThrow(
      /mediaKind|resolution/i
    );
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);

    const secondAudit = audit(prepared);
    prepared.rows![0].dateEvidence.value = '2025-01-01T00:00:00.000Z';
    const second = await CoordinatorEvidenceAdapter.create({
      evidenceRoot: path.join(parent, 'contradictory-evidence'),
      policyVersion: 'date-policy/1',
    });
    await expect(second.recordPreview(prepared, secondAudit)).rejects.toThrow(
      /public date evidence|disagrees/i
    );
    await expect(second.shutdown()).rejects.toThrow(/failed/i);
  });

  it('persists real floating-local EXIF evidence and rejects partial selection groups', async () => {
    const prepared = preview('floating-local');
    prepared.rows![0].dateEvidence.value = '2024-01-02T03:04:05';
    const privateAudit = audit(prepared);
    const localValue = {
      localIso: '2024-01-02T03:04:05',
      zoneBasis: 'floating-local' as const,
      precision: 'second' as const,
    };
    privateAudit.decisionRecords[0].resolution.selectedValue = localValue;
    privateAudit.decisionRecords[0].resolution.candidates[0].value = localValue;
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    await adapter.recordPreview(prepared, privateAudit);
    await adapter.shutdown();

    const partial = audit(prepared);
    delete partial.decisionRecords[0].resolution.selectedGroupScore;
    const second = await CoordinatorEvidenceAdapter.create({
      evidenceRoot: path.join(parent, 'partial-selection-evidence'),
      policyVersion: 'date-policy/1',
    });
    await expect(second.recordPreview(prepared, partial)).rejects.toThrow(
      /all present or absent|selection/i
    );
    await expect(second.shutdown()).rejects.toThrow(/failed/i);
  });

  it('closes evidence with a truthful partial terminal and failed path details', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const partial: TerminalProcessingEvent = {
      kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        statistics: {
          totalFiles: 2,
          processedFiles: 1,
          skippedFiles: 0,
          failedFiles: 1,
          totalBytes: 84,
          processedBytes: 42,
          durationMs: 10_000,
        },
        fileFailures: [{ sourcePath: '/source/failed.jpg', error: 'permission denied' }],
      },
    };

    await adapter.recordTerminal(partial);

    const manifestPath = adapter.manifestPathForJob(prepared.jobId);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: true });
    const closingRecord = JSON.parse(
      (await readFile(manifestPath, 'utf8')).trimEnd().split('\n').at(-1)!
    ) as {
      payload: Record<string, unknown>;
    };
    expect(closingRecord.payload).toEqual({ terminal: partial });
  });

  it('accepts a coordinator-failed terminal that preserves successful mutations and exact failed paths', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const failedAfterMutation: TerminalProcessingEvent = {
      kind: ProcessingEventKind.JOB_FAILED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        error: {
          code: CoordinatorErrorCode.HISTORY_PERSISTENCE_FAILED,
          message: 'ledger entry persistence failed: evidence append failed',
          recoverable: false,
        },
        statistics: {
          totalFiles: 1,
          processedFiles: 1,
          skippedFiles: 0,
          failedFiles: 0,
          totalBytes: 42,
          processedBytes: 42,
          durationMs: 10_000,
        },
        fileFailures: [],
      },
    };

    await adapter.recordTerminal(failedAfterMutation);

    const manifestPath = adapter.manifestPathForJob(prepared.jobId);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: true });
    const closingRecord = JSON.parse(
      (await readFile(manifestPath, 'utf8')).trimEnd().split('\n').at(-1)!
    ) as { payload: Record<string, unknown> };
    expect(closingRecord.payload).toEqual({ terminal: failedAfterMutation });
  });

  it('closes zero-byte post-commit Move cancellation evidence with explicit retained-source truth', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    prepared.request.options.operation = OperationMode.MOVE;
    prepared.effectiveOptions.operation = OperationMode.MOVE;
    prepared.summary.copyFiles = 0;
    prepared.summary.moveFiles = 1;
    prepared.summary.totalBytes = 0;
    prepared.rows![0].operation = OperationMode.MOVE;
    prepared.rows![0].fingerprint.size = 0;
    const preparedAudit = audit(prepared);
    preparedAudit.operationRecords[0].bytes = 0;
    await adapter.recordPreview(prepared, preparedAudit);
    await adapter.recordLedgerEntry({
      jobId: prepared.jobId,
      previewId: prepared.previewId,
      entry: {
        operationId: 'operation-1',
        outcome: 'cancelled',
        bytes: 0,
        cancellationState: 'destination-committed-source-retained',
        sourceRetained: true,
        destinationCommitted: true,
        error: 'operator cancelled after destination commit',
      },
    });
    const cancelled: TerminalProcessingEvent = {
      kind: ProcessingEventKind.JOB_CANCELLED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        reason: 'operator requested',
        filesProcessed: 0,
        statistics: {
          totalFiles: 1,
          processedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          cancelledFiles: 1,
          unattemptedFiles: 0,
          totalBytes: 0,
          processedBytes: 0,
          committedResidueBytes: 0,
          durationMs: 10_000,
        },
        fileFailures: [],
        fileOutcomes: [
          {
            sourcePath: '/source/image.jpg',
            destinationPath: '/destination/2024/01/image.jpg',
            state: 'destination-committed-source-retained',
            plannedBytes: 0,
            committedBytes: 0,
            sourceRetained: true,
            error: 'operator cancelled after destination commit',
          },
        ],
      },
    };

    await adapter.recordTerminal(cancelled);

    const manifestPath = adapter.manifestPathForJob(prepared.jobId);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: true });
    const closingRecord = JSON.parse(
      (await readFile(manifestPath, 'utf8')).trimEnd().split('\n').at(-1)!
    ) as { payload: Record<string, unknown> };
    expect(closingRecord.payload).toEqual({ terminal: cancelled });
    expect(await readFile(manifestPath, 'utf8')).toContain('"kind":"operation-cancelled"');
  });

  it('rejects cancellation evidence that hides a committed residue', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const hiddenResidue = {
      kind: ProcessingEventKind.JOB_CANCELLED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        filesProcessed: 0,
        statistics: {
          totalFiles: 1,
          processedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          cancelledFiles: 1,
          unattemptedFiles: 0,
          totalBytes: 42,
          processedBytes: 0,
          committedResidueBytes: 0,
          durationMs: 10_000,
        },
        fileFailures: [],
        fileOutcomes: [
          {
            sourcePath: '/source/substituted.jpg',
            destinationPath: '/destination/2024/01/image.jpg',
            state: 'cancelled-before-commit',
            plannedBytes: 42,
            committedBytes: 0,
            sourceRetained: true,
            error: 'cancelled',
          },
        ],
      },
    } as TerminalProcessingEvent;

    await expect(adapter.recordTerminal(hiddenResidue)).rejects.toThrow(/preview|outcome|source/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('rejects cancellation terminal errors invented outside the exact operation ledger', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    await adapter.recordLedgerEntry({
      jobId: prepared.jobId,
      previewId: prepared.previewId,
      entry: { operationId: 'operation-1', outcome: 'committed', bytes: 42 },
    });
    const inventedError: TerminalProcessingEvent = {
      kind: ProcessingEventKind.JOB_CANCELLED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        filesProcessed: 1,
        statistics: {
          totalFiles: 1,
          processedFiles: 1,
          skippedFiles: 0,
          failedFiles: 0,
          cancelledFiles: 0,
          unattemptedFiles: 0,
          totalBytes: 42,
          processedBytes: 42,
          committedResidueBytes: 0,
          durationMs: 10_000,
        },
        fileFailures: [],
        fileOutcomes: [
          {
            sourcePath: '/source/image.jpg',
            destinationPath: '/destination/2024/01/image.jpg',
            state: 'completed',
            plannedBytes: 42,
            committedBytes: 42,
            sourceRetained: true,
            error: 'invented terminal-only error',
          },
        ],
      },
    };

    await expect(adapter.recordTerminal(inventedError)).rejects.toThrow(/ledger|error/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);

    const absentLedgerAdapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot: path.join(parent, 'absent-ledger-error-evidence'),
      policyVersion: 'date-policy/1',
    });
    await absentLedgerAdapter.recordPreview(prepared, audit(prepared));
    await expect(
      absentLedgerAdapter.recordTerminal({
        ...inventedError,
        payload: {
          ...inventedError.payload,
          filesProcessed: 0,
          statistics: {
            ...inventedError.payload.statistics,
            processedFiles: 0,
            unattemptedFiles: 1,
            processedBytes: 0,
          },
          fileOutcomes: [
            {
              ...inventedError.payload.fileOutcomes[0],
              state: 'not-attempted',
              committedBytes: 0,
              error: 'invented absent-ledger error',
            },
          ],
        },
      })
    ).rejects.toThrow(/ledger|error|absent/i);
    await expect(absentLedgerAdapter.shutdown()).rejects.toThrow(/failed/i);

    const skipped = preview('skip-error-evidence');
    skipped.summary.copyFiles = 0;
    skipped.summary.skippedFiles = 1;
    skipped.rows![0].operation = 'skip';
    const skippedAudit = audit(skipped);
    skippedAudit.operationRecords = [];
    const skippedAdapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot: path.join(parent, 'skip-error-evidence'),
      policyVersion: 'date-policy/1',
    });
    await skippedAdapter.recordPreview(skipped, skippedAudit);
    await expect(
      skippedAdapter.recordTerminal({
        ...inventedError,
        jobId: skipped.jobId,
        payload: {
          ...inventedError.payload,
          filesProcessed: 0,
          statistics: {
            ...inventedError.payload.statistics,
            processedFiles: 0,
            skippedFiles: 1,
            processedBytes: 0,
          },
          fileOutcomes: [
            {
              ...inventedError.payload.fileOutcomes[0],
              state: 'skipped',
              committedBytes: 0,
              error: 'invented skip error',
            },
          ],
        },
      })
    ).rejects.toThrow(/skip|error/i);
    await expect(skippedAdapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('rejects cancelled-before-commit ledger bytes and terminal processed-byte inflation', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: {
          operationId: 'operation-1',
          outcome: 'cancelled',
          bytes: 1,
          cancellationState: 'cancelled-before-commit',
          sourceRetained: true,
          destinationCommitted: false,
          error: 'cancelled',
        },
      })
    ).rejects.toThrow(/bytes|cancel/i);

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: {
          operationId: 'operation-1',
          outcome: 'cancelled',
          bytes: 41,
          cancellationState: 'destination-committed-source-retained',
          sourceRetained: true,
          destinationCommitted: true,
          error: 'partial destination commit claim',
        },
      })
    ).rejects.toThrow(/bytes|planned|commit/i);

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: {
          operationId: 'operation-1',
          outcome: 'cancelled',
          bytes: 42,
          cancellationState: 'destination-committed-source-retained',
          sourceRetained: true,
          destinationCommitted: true,
          error: 'invalid Copy residue claim',
        },
      })
    ).rejects.toThrow(/copy|move|operation/i);

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: { operationId: 'operation-1', outcome: 'committed', bytes: 41 },
      })
    ).rejects.toThrow(/bytes|planned|commit/i);

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: { operationId: 'operation-1', outcome: 'skipped', bytes: 1 },
      })
    ).rejects.toThrow(/skip|bytes/i);

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: { operationId: 'operation-1', outcome: 'failed', bytes: 0 },
      })
    ).rejects.toThrow(/failed|error/i);

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: { operationId: 'operation-1', outcome: 'failed', bytes: 0, error: '   ' },
      })
    ).rejects.toThrow(/failed|error/i);

    for (const entry of [
      { operationId: 'operation-1', outcome: 'committed' as const, bytes: 42, error: '   ' },
      { operationId: 'operation-1', outcome: 'skipped' as const, bytes: 0, error: '   ' },
      {
        operationId: 'operation-1',
        outcome: 'cancelled' as const,
        bytes: 0,
        cancellationState: 'cancelled-before-commit' as const,
        sourceRetained: true,
        destinationCommitted: false,
        error: '   ',
      },
    ]) {
      await expect(
        adapter.recordLedgerEntry({
          jobId: prepared.jobId,
          previewId: prepared.previewId,
          entry,
        })
      ).rejects.toThrow(/error|blank|empty/i);
    }

    const inflated = {
      kind: ProcessingEventKind.JOB_CANCELLED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        filesProcessed: 0,
        statistics: {
          totalFiles: 1,
          processedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          cancelledFiles: 0,
          unattemptedFiles: 1,
          totalBytes: 42,
          processedBytes: 1,
          committedResidueBytes: 0,
          durationMs: 10_000,
        },
        fileFailures: [],
        fileOutcomes: [
          {
            sourcePath: '/source/image.jpg',
            destinationPath: '/destination/2024/01/image.jpg',
            state: 'not-attempted',
            plannedBytes: 42,
            committedBytes: 0,
            sourceRetained: true,
          },
        ],
      },
    } as TerminalProcessingEvent;

    await expect(adapter.recordTerminal(inflated)).rejects.toThrow(/processed|bytes|outcome/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('rejects impossible calendar dates before immutable evidence admission', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    const privateAudit = audit(prepared);
    prepared.rows![0].dateEvidence.value = '2024-02-30T00:00:00Z';
    privateAudit.decisionRecords[0].resolution.selectedValue!.localIso = '2024-02-30T00:00:00';
    privateAudit.decisionRecords[0].resolution.selectedValue!.instantUtc = '2024-02-30T00:00:00Z';
    privateAudit.decisionRecords[0].resolution.candidates[0].value.localIso = '2024-02-30T00:00:00';
    privateAudit.decisionRecords[0].resolution.candidates[0].value.instantUtc =
      '2024-02-30T00:00:00Z';

    await expect(adapter.recordPreview(prepared, privateAudit)).rejects.toThrow(/date|timestamp/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('rejects FILE_OPERATIONS_FAILED evidence that omits its required all-file details', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const incomplete = {
      kind: ProcessingEventKind.JOB_FAILED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        error: {
          code: 'FILE_OPERATIONS_FAILED',
          message: 'All 1 file operation failed',
          recoverable: true,
        },
      },
    } as TerminalProcessingEvent;

    await expect(adapter.recordTerminal(incomplete)).rejects.toThrow(/statistics|fileFailures/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('rejects partial evidence whose failed path count contradicts statistics', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const contradictory = {
      kind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        statistics: {
          totalFiles: 2,
          processedFiles: 1,
          skippedFiles: 0,
          failedFiles: 1,
          totalBytes: 84,
          processedBytes: 42,
          durationMs: 10_000,
        },
        fileFailures: [
          { sourcePath: '/source/a.jpg', error: 'denied' },
          { sourcePath: '/source/b.jpg', error: 'denied' },
        ],
      },
    } as TerminalProcessingEvent;

    await expect(adapter.recordTerminal(contradictory)).rejects.toThrow(/failure counts/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('conserves unresolvedDates from the planner needs-review marker, not only a null date', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    prepared.summary.unresolvedDates = 1;
    prepared.rows![0].dateEvidence = {
      value: '2026-08-29T11:59:00.000Z',
      source: DateEvidenceSource.FILESYSTEM_BIRTH,
      field: 'FileSystem:BirthTime',
      confidence: 0.4,
      warnings: ['Creation date requires review'],
    };
    prepared.rows![0].warnings = ['Creation date requires review'];
    const privateAudit = audit(prepared);
    privateAudit.decisionRecords[0].resolution.status = 'review-required';
    privateAudit.decisionRecords[0].resolution.confidence = 'low';
    privateAudit.decisionRecords[0].resolution.selectedValue = {
      localIso: '2026-08-29T11:59:00',
      instantUtc: '2026-08-29T11:59:00.000Z',
      offsetMinutes: 0,
      zoneBasis: 'explicit-offset',
      precision: 'second',
    };
    privateAudit.decisionRecords[0].resolution.candidates[0].semantic = 'filesystem-birth';
    privateAudit.decisionRecords[0].resolution.candidates[0].sourceKind = 'filesystem';
    privateAudit.decisionRecords[0].resolution.candidates[0].tag = 'FileSystem:BirthTime';
    privateAudit.decisionRecords[0].resolution.candidates[0].value = {
      localIso: '2026-08-29T11:59:00',
      instantUtc: '2026-08-29T11:59:00.000Z',
      offsetMinutes: 0,
      zoneBasis: 'explicit-offset',
      precision: 'second',
    };

    await expect(adapter.recordPreview(prepared, privateAudit)).resolves.toBeUndefined();
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it.each([false, true])(
    'rejects evidence containing legacy corruptionDetection=%p',
    async (legacyValue) => {
      const adapter = await CoordinatorEvidenceAdapter.create({
        evidenceRoot,
        policyVersion: 'date-policy/1',
      });
      const prepared = preview();
      prepared.request.options = {
        ...prepared.request.options,
        corruptionDetection: legacyValue,
      } as never;
      prepared.effectiveOptions = {
        ...prepared.effectiveOptions,
        corruptionDetection: legacyValue,
      } as never;

      await expect(adapter.recordPreview(prepared, audit(prepared))).rejects.toThrow(
        /missing or unknown fields/i
      );
      await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
    }
  );

  it('serializes concurrent ledger records and closes a terminal exactly once', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const { prepared, privateAudit } = batchPreview(24);
    await adapter.recordPreview(prepared, privateAudit);
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        adapter.recordLedgerEntry({
          jobId: prepared.jobId,
          previewId: prepared.previewId,
          entry: {
            operationId: `operation-${index}`,
            outcome: index % 3 === 0 ? 'skipped' : index % 3 === 1 ? 'failed' : 'committed',
            bytes: index % 3 === 0 ? 0 : index,
            ...(index % 3 === 1 ? { error: 'synthetic' } : {}),
          },
        })
      )
    );
    await Promise.all([
      adapter.recordTerminal(terminal(prepared.jobId)),
      adapter.recordTerminal(terminal(prepared.jobId)),
    ]);

    const manifestPath = adapter.manifestPathForJob(prepared.jobId);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: true,
      eventCount: 123,
    });
    const sequences = (await readFile(manifestPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    expect(sequences).toEqual(Array.from({ length: 123 }, (_, index) => index + 1));
  });

  it('rejects a contradictory concurrent terminal instead of reporting discarded evidence as durable', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const failed = {
      kind: ProcessingEventKind.JOB_FAILED,
      jobId: prepared.jobId,
      sequence: 6,
      emittedAt: '2026-08-29T12:00:10.000Z',
      payload: {
        error: { code: 'FAILED', message: 'contradiction', recoverable: false },
      },
    } as const;

    const results = await Promise.allSettled([
      adapter.recordTerminal(terminal(prepared.jobId)),
      adapter.recordTerminal(failed),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
    const events = (await readFile(adapter.manifestPathForJob(prepared.jobId), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(events.filter((event) => event.kind === 'job-closed')).toHaveLength(1);
    expect(events.at(-1)?.payload).toEqual({ terminal: terminal(prepared.jobId) });
  });

  it('contains hostile job ids under the evidence root', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const hostileJobId = '../../outside-evidence';
    const manifestPath = adapter.manifestPathForJob(hostileJobId);
    expect(path.dirname(manifestPath)).toBe(evidenceRoot);
    expect(path.basename(manifestPath)).not.toContain('..');

    const prepared = preview(hostileJobId);
    await adapter.recordPreview(prepared, audit(prepared));
    await adapter.recordTerminal(terminal(hostileJobId));
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: true });
  });

  it('shutdown drains admitted writes and closes each open manifest', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const { prepared, privateAudit } = batchPreview(20);
    await adapter.recordPreview(prepared, privateAudit);
    const admitted = Array.from({ length: 20 }, (_, index) =>
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: { operationId: `operation-${index}`, outcome: 'committed', bytes: index },
      })
    );

    await adapter.shutdown();
    await expect(Promise.all(admitted)).resolves.toHaveLength(20);
    await expect(
      EvidenceManifest.verify(adapter.manifestPathForJob(prepared.jobId))
    ).resolves.toMatchObject({
      valid: true,
      eventCount: 103,
    });
    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: prepared.previewId,
        entry: { operationId: 'late', outcome: 'committed', bytes: 1 },
      })
    ).rejects.toThrow(/shut|closed/i);
  });

  it('rejects relative roots and records no ledger before a preview creates the job manifest', async () => {
    await expect(
      CoordinatorEvidenceAdapter.create({
        evidenceRoot: 'relative-evidence-root',
        policyVersion: 'date-policy/1',
      })
    ).rejects.toThrow(/absolute/i);

    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    await expect(
      adapter.recordLedgerEntry({
        jobId: 'missing-job',
        previewId: 'missing-preview',
        entry: { operationId: 'operation-1', outcome: 'committed', bytes: 1 },
      })
    ).rejects.toThrow(/preview|manifest|unknown/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('rejects incomplete preview rows and malformed date-resolution evidence before creation', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const missingRows = { ...preview(), rows: undefined };
    const malformedDate = preview('second-job');
    malformedDate.rows![0].dateEvidence.confidence = 2;

    await expect(adapter.recordPreview(missingRows)).rejects.toThrow(/rows|preview/i);
    await expect(adapter.recordPreview(malformedDate)).rejects.toThrow(/date|confidence|row/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('binds ledger and start-rejection evidence to the recorded preview identity', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));

    await expect(
      adapter.recordLedgerEntry({
        jobId: prepared.jobId,
        previewId: 'wrong-preview',
        entry: { operationId: '', outcome: 'committed', bytes: -1 },
      })
    ).rejects.toThrow(/preview|operation|bytes/i);
    await expect(
      adapter.recordStartRejection({
        jobId: prepared.jobId,
        previewId: 'wrong-preview',
        code: CoordinatorErrorCode.PREVIEW_DRIFT,
        reasons: ['drift'],
        rejectedAt: 'not-a-date',
      })
    ).rejects.toThrow(/preview|date|timestamp/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
    await expect(
      EvidenceManifest.verify(adapter.manifestPathForJob(prepared.jobId))
    ).resolves.toMatchObject({ valid: true });
  });

  it('rejects a malformed terminal schema without consuming the valid terminal close', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const invalid = {
      ...terminal(prepared.jobId),
      kind: 'not-terminal',
      sequence: -1,
    } as unknown as TerminalProcessingEvent;

    await expect(adapter.recordTerminal(invalid)).rejects.toThrow(/terminal|kind|sequence/i);
    await adapter.recordTerminal(terminal(prepared.jobId));
    await expect(
      EvidenceManifest.verify(adapter.manifestPathForJob(prepared.jobId))
    ).resolves.toMatchObject({ valid: true, eventCount: 7 });
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });

  it('drains and closes manifests but reports any rejected admitted hook during shutdown', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });
    const prepared = preview();
    await adapter.recordPreview(prepared, audit(prepared));
    const rejected = adapter.recordLedgerEntry({
      jobId: prepared.jobId,
      previewId: prepared.previewId,
      entry: { operationId: 'bad-bytes', outcome: 'committed', bytes: -1 },
    });

    await expect(rejected).rejects.toThrow(/bytes|ledger/i);
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
    await expect(
      EvidenceManifest.verify(adapter.manifestPathForJob(prepared.jobId))
    ).resolves.toMatchObject({ valid: true, eventCount: 7 });
  });

  it('rejects accessor-bearing configuration without executing its getter', async () => {
    let getterExecutions = 0;
    const hostileOptions = Object.defineProperty({ evidenceRoot }, 'policyVersion', {
      enumerable: true,
      get: () => {
        getterExecutions += 1;
        return 'date-policy/1';
      },
    });

    await expect(
      CoordinatorEvidenceAdapter.create(
        hostileOptions as unknown as { evidenceRoot: string; policyVersion: string }
      )
    ).rejects.toThrow(/accessor|canonical/i);
    expect(getterExecutions).toBe(0);
  });

  it('returns a controlled rejected promise for an unknown terminal job', async () => {
    const adapter = await CoordinatorEvidenceAdapter.create({
      evidenceRoot,
      policyVersion: 'date-policy/1',
    });

    await expect(adapter.recordTerminal(terminal('unknown-job'))).rejects.toThrow(
      /preview|manifest|unknown/i
    );
    await expect(adapter.shutdown()).rejects.toThrow(/failed/i);
  });
});
