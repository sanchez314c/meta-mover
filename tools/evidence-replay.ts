/**
 * Diagnostic: replays normalization authorization against a real sealed
 * evidence root to exercise dataset preparation progress and cancellation
 * without touching source media or the transaction journal.
 *
 * Usage:
 *   npx ts-node tools/evidence-replay.ts <evidenceRoot> <previewId> <record.json>
 *
 * record.json is one AuditInputRecord row extracted from the durable audit
 * index (recordId, operationId, sourcePath, outputPath, resolution).
 */
import { readFile } from 'fs/promises';

import { EvidenceNormalizationAuditRepository } from '../src/main/services/EvidenceNormalizationAuditRepository';
import type { DateResolutionRecord } from '../src/main/core/date/types';

interface ReplayRecord {
  operationId: string;
  sourcePath: string;
  outputPath: string;
  resolution: DateResolutionRecord;
}

async function main(): Promise<void> {
  const [evidenceRoot, previewId, recordPath] = process.argv.slice(2);
  if (!evidenceRoot || !previewId || !recordPath) {
    throw new Error('usage: evidence-replay <evidenceRoot> <previewId> <record.json>');
  }
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as ReplayRecord;
  const repository = await EvidenceNormalizationAuditRepository.open(evidenceRoot);

  let reports = 0;
  let lastLine = '';
  const reportProgress = (progress: {
    stage: string;
    completed: number;
    total?: number;
    unit: 'bytes' | 'records';
  }): void => {
    reports += 1;
    const line = `${progress.stage}: ${progress.completed.toLocaleString()}${
      progress.total === undefined ? '' : ` / ${progress.total.toLocaleString()}`
    } ${progress.unit}`;
    if (line !== lastLine) {
      console.log(`[stage] ${line}`);
      lastLine = line;
    } else if (reports % 500 === 0) {
      console.log(`[stage] ${line} (${reports} reports)`);
    }
  };

  // Phase 1: abort mid-preparation; must reject promptly with AbortError.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const cancelStartedAt = Date.now();
  try {
    await repository.authorizeNormalization({
      previewId,
      recordId: record.operationId,
      sourcePath: record.sourcePath,
      outputPath: record.outputPath,
      resolution: record.resolution,
      signal: controller.signal,
      reportProgress,
    });
    console.log('phase 1: FAIL - authorization completed before cancellation');
    process.exitCode = 1;
  } catch (error) {
    const elapsedS = ((Date.now() - cancelStartedAt) / 1000).toFixed(1);
    const name = error instanceof Error ? error.name : String(error);
    const message = error instanceof Error ? error.message : String(error);
    const prompt = Date.now() - cancelStartedAt < 15_000;
    console.log(
      `phase 1: ${prompt ? 'OK' : 'FAIL'} - rejected after ${elapsedS}s with ${name}: ${message} (${reports} stage reports)`
    );
    if (!prompt || name !== 'AbortError') process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }

  // Phase 2: full preparation without cancellation, from a cold dataset cache.
  reports = 0;
  lastLine = '';
  const startedAt = Date.now();
  const authorized = await repository.authorizeNormalization({
    previewId,
    recordId: record.operationId,
    sourcePath: record.sourcePath,
    outputPath: record.outputPath,
    resolution: record.resolution,
    reportProgress,
  });
  console.log(
    `phase 2: OK - authorized=${authorized} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${reports} stage reports)`
  );

  // Phase 3: the warmed dataset must answer immediately.
  const cachedStartedAt = Date.now();
  const cached = await repository.authorizeNormalization({
    previewId,
    recordId: record.operationId,
    sourcePath: record.sourcePath,
    outputPath: record.outputPath,
    resolution: record.resolution,
  });
  console.log(
    `phase 3: OK - cached authorized=${cached} after ${Date.now() - cachedStartedAt}ms`
  );

  await repository.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
