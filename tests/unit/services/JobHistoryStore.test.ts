import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingOptionsDTO,
  PreviewRowDTO,
  PreviewSummaryDTO,
} from '../../../src/shared/types/processing';
import {
  CreateHistoryJobInput,
  JobHistoryStore,
  JobHistoryStoreError,
} from '../../../src/main/services/JobHistoryStore';

const options = (): ProcessingOptionsDTO => ({
  operation: OperationMode.MOVE,
  conflictPolicy: ConflictPolicy.RENAME,
  folderStructure: FolderStructure.YEAR_MONTH,
  workerCount: 4,
  verifyIntegrity: true,
  appendScreenshotSuffix: false,
  writeMetadataDates: false,
});

const summary = (): PreviewSummaryDTO => ({
  totalFiles: 2,
  copyFiles: 0,
  moveFiles: 2,
  skippedFiles: 0,
  renamedFiles: 1,
  overwrittenFiles: 0,
  unresolvedDates: 0,
  totalBytes: 42,
});

const previewRows = (): PreviewRowDTO[] =>
  ['photo.jpg', 'other.jpg'].map((name) => ({
    sourcePath: `/media/source/${name}`,
    targetPath: `/media/destination/${name}`,
    operation: OperationMode.MOVE,
    conflictPolicy: ConflictPolicy.RENAME,
    dateEvidence: {
      value: '1995-06-01T12:30:00',
      source: 'embedded',
      confidence: 1,
      warnings: [],
    },
    fingerprint: {
      size: 21,
      modifiedAt: '2026-08-29T16:00:00.000Z',
    },
    warnings: [],
  }));

const creation = (): CreateHistoryJobInput => ({
  jobId: randomUUID(),
  createdAt: '2026-08-29T17:00:00.000Z',
  previewId: 'preview-123',
  sourcePaths: ['/media/source'],
  destinationPath: '/media/destination',
  effectiveOptions: options(),
  previewSummary: summary(),
  previewRows: previewRows(),
});

const event = <K extends ProcessingEvent['kind']>(
  jobId: string,
  kind: K,
  sequence: number,
  payload: Extract<ProcessingEvent, { kind: K }>['payload']
): Extract<ProcessingEvent, { kind: K }> =>
  ({
    kind,
    jobId,
    sequence,
    emittedAt: '2026-08-29T18:00:00.000Z',
    payload,
  }) as Extract<ProcessingEvent, { kind: K }>;

const waitForBarrier = async (barrier: Promise<void>, label: string): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

describe('JobHistoryStore', () => {
  let sandbox: string;
  let historyPath: string;
  let openStores: JobHistoryStore[];

  const trackedStore = (
    storePath: string,
    storeOptions?: ConstructorParameters<typeof JobHistoryStore>[1]
  ): JobHistoryStore => {
    const store = new JobHistoryStore(storePath, storeOptions);
    openStores.push(store);
    return store;
  };

  beforeEach(async () => {
    openStores = [];
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-history-'));
    historyPath = path.join(sandbox, 'private', 'jobs.jsonl');
  });

  afterEach(async () => {
    await Promise.allSettled(openStores.map((store) => store.close()));
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('round-trips coordinator identifiers into creation and subsequent durable events', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();

    const input = {
      ...creation(),
      jobId: '40000000-0000-4000-8000-000000000123',
      createdAt: '2026-08-29T16:59:58.321Z',
    };
    const created = await store.createJob(input);
    input.sourcePaths[0] = '/mutated';
    input.effectiveOptions.workerCount = 99;
    input.previewSummary.totalFiles = 999;

    expect(created.jobId).toBe(input.jobId);
    expect(created).toMatchObject({
      status: 'preview-ready',
      createdAt: input.createdAt,
      lastSequence: 2,
      sourcePaths: ['/media/source'],
      effectiveOptions: { workerCount: 4 },
      previewSummary: { totalFiles: 2 },
    });
    expect(Object.isFrozen(created)).toBe(true);
    await expect(
      store.appendEvent(
        input.jobId,
        event(input.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
          previewId: input.previewId,
          effectiveOptions: options(),
        })
      )
    ).resolves.toMatchObject({ jobId: input.jobId, status: 'queued' });
    await expect(store.createJob(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await store.getJob(created.jobId))?.sourcePaths).toEqual(['/media/source']);
    const persisted = JSON.parse((await fs.readFile(historyPath, 'utf8')).split('\n')[0]);
    expect(persisted.creation).toMatchObject({
      jobId: input.jobId,
      createdAt: input.createdAt,
    });
    expect((await fs.stat(historyPath)).mode & 0o777).toBe(0o600);
  });

  it.each([false, true])(
    'rejects current writes containing legacy corruptionDetection=%p',
    async (legacyValue) => {
      const store = trackedStore(historyPath);
      await store.initialize();
      const input = creation();
      input.effectiveOptions = {
        ...input.effectiveOptions,
        corruptionDetection: legacyValue,
      } as never;

      await expect(store.createJob(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await fs.readFile(historyPath, 'utf8')).toBe('');
    }
  );

  it('decodes schema-1 legacy options by dropping corruptionDetection with migration warnings', async () => {
    const warning = jest.fn();
    const input = creation();
    const legacyOptions = { ...options(), corruptionDetection: true };
    const queued = event(input.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
      previewId: input.previewId,
      effectiveOptions: legacyOptions as never,
    });
    const records = [
      {
        schemaVersion: 1,
        recordType: 'job-created',
        creation: { ...input, effectiveOptions: legacyOptions },
      },
      { schemaVersion: 1, recordType: 'event-appended', event: queued },
    ];
    await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      historyPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      {
        mode: 0o600,
      }
    );

    const store = trackedStore(historyPath, {
      now: () => new Date('2026-08-29T19:00:00.000Z'),
      warning,
    });
    await store.initialize();
    const loaded = await store.getJob(input.jobId);

    expect(loaded?.effectiveOptions).not.toHaveProperty('corruptionDetection');
    expect(loaded?.events[0]).not.toHaveProperty('payload.effectiveOptions.corruptionDetection');
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/corruptionDetection/i));
  });

  it('loads pre-screenshot schema-1 options with the new behavior safely disabled', async () => {
    const warning = jest.fn();
    const input = creation();
    const { appendScreenshotSuffix: _removed, ...preScreenshotOptions } = options();
    const records = [
      {
        schemaVersion: 1,
        recordType: 'job-created',
        creation: { ...input, effectiveOptions: preScreenshotOptions },
      },
      {
        schemaVersion: 1,
        recordType: 'event-appended',
        event: event(input.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
          previewId: input.previewId,
          effectiveOptions: preScreenshotOptions as never,
        }),
      },
    ];
    await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      historyPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      { mode: 0o600 }
    );

    const store = trackedStore(historyPath, { warning });
    await store.initialize();
    const loaded = await store.getJob(input.jobId);

    expect(loaded?.effectiveOptions.appendScreenshotSuffix).toBe(false);
    expect(
      (loaded?.events[0].payload as { effectiveOptions: { appendScreenshotSuffix: boolean } })
        .effectiveOptions.appendScreenshotSuffix
    ).toBe(false);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringMatching(/appendScreenshotSuffix/i));
  });

  it('does not report a legacy event as migrated before cross-record validation succeeds', async () => {
    const warning = jest.fn();
    const input = creation();
    const mismatchedOptions = {
      ...options(),
      workerCount: options().workerCount + 1,
      corruptionDetection: false,
    };
    const records = [
      { schemaVersion: 1, recordType: 'job-created', creation: input },
      {
        schemaVersion: 1,
        recordType: 'event-appended',
        event: event(input.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
          previewId: input.previewId,
          effectiveOptions: mismatchedOptions as never,
        }),
      },
    ];
    await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      historyPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      {
        mode: 0o600,
      }
    );

    await expect(trackedStore(historyPath, { warning }).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 2,
    });
    expect(warning).not.toHaveBeenCalled();
  });

  it('enforces monotonic events and exactly one terminal through JobStateMachine', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    const job = await store.createJob(creation());

    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: job.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'discovery' })
    );
    await expect(
      store.appendEvent(
        job.jobId,
        event(job.jobId, ProcessingEventKind.JOB_PROGRESS, 4, {
          phase: 'metadata',
          filesProcessed: 1,
          totalFiles: 2,
          percentage: 50,
        })
      )
    ).rejects.toMatchObject({ code: 'EVENT_REJECTED', reason: 'stale-sequence' });

    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_COMPLETED, 5, {
        statistics: {
          totalFiles: 2,
          processedFiles: 2,
          skippedFiles: 0,
          failedFiles: 0,
          totalBytes: 42,
          processedBytes: 42,
          durationMs: 100,
        },
      })
    );
    await expect(
      store.appendEvent(
        job.jobId,
        event(job.jobId, ProcessingEventKind.JOB_FAILED, 6, {
          error: { code: 'LATE', message: 'too late', recoverable: false },
        })
      )
    ).rejects.toMatchObject({ code: 'EVENT_REJECTED', reason: 'already-terminal' });

    const persisted = (await fs.readFile(historyPath, 'utf8')).trim().split('\n');
    expect(persisted).toHaveLength(4);
    expect((await store.getJob(job.jobId))?.status).toBe('completed');
  });

  it('round-trips a partial terminal with conserved success counts and failed paths', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    const job = await store.createJob(creation());
    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: job.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'organization' })
    );
    const partial = event(job.jobId, ProcessingEventKind.JOB_PARTIALLY_COMPLETED, 5, {
      statistics: {
        totalFiles: 2,
        processedFiles: 1,
        skippedFiles: 0,
        failedFiles: 1,
        totalBytes: 42,
        processedBytes: 20,
        durationMs: 100,
      },
      fileFailures: [{ sourcePath: '/media/source/b.jpg', error: 'permission denied' }],
    });

    await expect(store.appendEvent(job.jobId, partial)).resolves.toMatchObject({
      status: 'partial',
      terminalEventKind: ProcessingEventKind.JOB_PARTIALLY_COMPLETED,
    });
    await store.close();

    const reopened = trackedStore(historyPath);
    await reopened.initialize();
    await expect(reopened.getJob(job.jobId)).resolves.toMatchObject({
      status: 'partial',
      events: expect.arrayContaining([partial]),
    });
  });

  it('rejects partial terminal failure details that contradict statistics', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    const job = await store.createJob(creation());
    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: job.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'organization' })
    );

    await expect(
      store.appendEvent(
        job.jobId,
        event(job.jobId, ProcessingEventKind.JOB_PARTIALLY_COMPLETED, 5, {
          statistics: {
            totalFiles: 2,
            processedFiles: 1,
            skippedFiles: 0,
            failedFiles: 1,
            totalBytes: 42,
            processedBytes: 20,
            durationMs: 100,
          },
          fileFailures: [
            { sourcePath: '/media/source/b.jpg', error: 'permission denied' },
            { sourcePath: '/media/source/c.jpg', error: 'read failed' },
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects queued options that differ from immutable effective options', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    const job = await store.createJob(creation());
    const changedOptions = options();
    changedOptions.workerCount = 8;

    await expect(
      store.appendEvent(
        job.jobId,
        event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
          previewId: job.previewId,
          effectiveOptions: changedOptions,
        })
      )
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD_MISMATCH' });
  });

  it('lists jobs and requires UUIDs for direct lookup', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    const first = await store.createJob(creation());
    const second = await store.createJob({ ...creation(), previewId: 'preview-456' });

    expect((await store.listJobs()).map((job) => job.jobId)).toEqual([first.jobId, second.jobId]);
    expect(await store.getJob('00000000-0000-4000-8000-000000000000')).toBeNull();
    await expect(store.getJob('../jobs.jsonl')).rejects.toBeInstanceOf(JobHistoryStoreError);
  });

  it('converts an active job to one failed/interrupted terminal event on startup', async () => {
    const initial = trackedStore(historyPath);
    await initial.initialize();
    const job = await initial.createJob(creation());
    await initial.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: job.previewId,
        effectiveOptions: options(),
      })
    );
    await initial.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'discovery' })
    );
    await initial.close();

    const recovered = trackedStore(historyPath, {
      now: () => new Date('2026-08-29T19:00:00.000Z'),
    });
    await recovered.initialize();
    expect(await recovered.getJob(job.jobId)).toMatchObject({
      status: 'failed',
      lastSequence: 5,
      terminalEventKind: ProcessingEventKind.JOB_FAILED,
      events: [
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          kind: ProcessingEventKind.JOB_FAILED,
          payload: {
            error: {
              code: 'INTERRUPTED',
              message: 'Job interrupted by application restart',
              recoverable: true,
            },
          },
        }),
      ],
    });
    await recovered.close();

    const reopened = trackedStore(historyPath);
    await reopened.initialize();
    const terminalEvents = (await reopened.getJob(job.jobId))?.events.filter(
      (item) => item.kind === ProcessingEventKind.JOB_FAILED
    );
    expect(terminalEvents).toHaveLength(1);
  });

  it('leaves a preview-ready job nonterminal because it was never active', async () => {
    const initial = trackedStore(historyPath);
    await initial.initialize();
    const job = await initial.createJob(creation());
    await initial.close();

    const reopened = trackedStore(historyPath);
    await reopened.initialize();
    expect(await reopened.getJob(job.jobId)).toMatchObject({
      status: 'preview-ready',
      terminalEventKind: null,
    });
  });

  it('truncates only a torn final JSON line and remains appendable', async () => {
    const initial = trackedStore(historyPath);
    await initial.initialize();
    const first = await initial.createJob(creation());
    await initial.close();
    await fs.appendFile(historyPath, '{"schemaVersion":1,"recordType":"event"');

    const recovered = trackedStore(historyPath);
    await recovered.initialize();
    expect((await recovered.listJobs()).map((job) => job.jobId)).toEqual([first.jobId]);
    await recovered.createJob({ ...creation(), previewId: 'preview-after-torn-line' });
    await recovered.close();

    const reopened = trackedStore(historyPath);
    await reopened.initialize();
    expect(await reopened.listJobs()).toHaveLength(2);
  });

  it('rejects malformed or invalid complete records as interior corruption', async () => {
    await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(historyPath), 0o700);
    await fs.writeFile(historyPath, '{not-json}\n', { mode: 0o600 });
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 1,
    });

    await fs.writeFile(historyPath, '{"schemaVersion":999,"recordType":"job-created"}\n');
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 1,
    });
  });

  it('repairs permissive file permissions during initialization', async () => {
    await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(historyPath), 0o700);
    await fs.writeFile(historyPath, '', { mode: 0o644 });
    await fs.chmod(historyPath, 0o644);

    await trackedStore(historyPath).initialize();
    expect((await fs.stat(historyPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid construction, lifecycle, identifiers, lookup, and payload inputs', async () => {
    expect(() => trackedStore('relative/jobs.jsonl')).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );

    const uninitialized = trackedStore(historyPath);
    await expect(uninitialized.listJobs()).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    await uninitialized.initialize();
    await uninitialized.initialize();

    await expect(uninitialized.createJob({ ...creation(), sourcePaths: [] })).rejects.toMatchObject(
      { code: 'INVALID_INPUT' }
    );
    await expect(uninitialized.createJob({ ...creation(), previewId: '' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      uninitialized.createJob({
        ...creation(),
        effectiveOptions: [] as unknown as ProcessingOptionsDTO,
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const unknownId = '00000000-0000-4000-8000-000000000000';
    await expect(
      uninitialized.appendEvent(
        unknownId,
        event(unknownId, ProcessingEventKind.JOB_STARTED, 3, { phase: 'discovery' })
      )
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });

    await expect(
      uninitialized.createJob({ ...creation(), jobId: 'not-a-uuid' })
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      uninitialized.createJob({ ...creation(), createdAt: '2026-08-29T17:00:00Z' })
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('accepts a complete final record without a newline and repairs the separator', async () => {
    const initial = trackedStore(historyPath);
    await initial.initialize();
    const job = await initial.createJob(creation());
    await initial.close();
    const content = await fs.readFile(historyPath, 'utf8');
    await fs.writeFile(historyPath, content.trimEnd(), { mode: 0o600 });

    const reopened = trackedStore(historyPath);
    await reopened.initialize();
    expect(await reopened.getJob(job.jobId)).toMatchObject({ jobId: job.jobId });
    expect((await fs.readFile(historyPath, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('rejects blank, duplicate, orphaned, and malformed typed records', async () => {
    await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(historyPath), 0o700);
    await fs.writeFile(historyPath, '\n', { mode: 0o600 });
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 1,
    });

    const initial = trackedStore(historyPath);
    await fs.writeFile(historyPath, '', { mode: 0o600 });
    await initial.initialize();
    await initial.createJob(creation());
    await initial.close();
    const creationLine = await fs.readFile(historyPath, 'utf8');
    await fs.appendFile(historyPath, creationLine);
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 2,
    });

    const orphanId = '00000000-0000-4000-8000-000000000001';
    const orphan = {
      schemaVersion: 1,
      recordType: 'event-appended',
      event: event(orphanId, ProcessingEventKind.JOB_STARTED, 3, { phase: 'discovery' }),
    };
    await fs.writeFile(historyPath, `${JSON.stringify(orphan)}\n`, { mode: 0o600 });
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 1,
    });

    const malformedEvent = {
      ...orphan,
      event: { ...orphan.event, sequence: 'three' },
    };
    await fs.writeFile(historyPath, `${JSON.stringify(malformedEvent)}\n`, { mode: 0o600 });
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 1,
    });

    await fs.writeFile(
      historyPath,
      `${JSON.stringify({ schemaVersion: 1, recordType: 'unknown' })}\n`,
      { mode: 0o600 }
    );
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 1,
    });
  });

  it('rejects symlinked ancestors or leaves, hard links, and non-regular history files', async () => {
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    const victim = path.join(sandbox, 'victim.jsonl');
    await fs.writeFile(victim, '', { mode: 0o644 });
    await fs.chmod(victim, 0o644);
    await fs.symlink(victim, historyPath, 'file');
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'UNSAFE_HISTORY_PATH',
    });
    expect((await fs.stat(victim)).mode & 0o777).toBe(0o644);

    await fs.unlink(historyPath);
    const hardLink = path.join(path.dirname(historyPath), 'hardlink.jsonl');
    await fs.link(victim, hardLink);
    await expect(trackedStore(hardLink).initialize()).rejects.toMatchObject({
      code: 'UNSAFE_HISTORY_PATH',
    });

    const directoryPath = path.join(sandbox, 'history-directory');
    await fs.mkdir(directoryPath);
    await expect(trackedStore(directoryPath).initialize()).rejects.toMatchObject({
      code: 'UNSAFE_HISTORY_PATH',
    });

    const realParent = path.join(sandbox, 'real-parent');
    const parentAlias = path.join(sandbox, 'parent-alias');
    await fs.mkdir(realParent);
    await fs.chmod(realParent, 0o755);
    await fs.symlink(realParent, parentAlias, 'dir');
    await expect(
      trackedStore(path.join(parentAlias, 'jobs.jsonl')).initialize()
    ).rejects.toMatchObject({ code: 'UNSAFE_HISTORY_PATH' });
    expect((await fs.stat(realParent)).mode & 0o777).toBe(0o755);
  });

  it('reconciles an ambiguous sync failure and makes an identical retry idempotent', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    const job = await store.createJob(creation());
    const queued = event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
      previewId: job.previewId,
      effectiveOptions: options(),
    });

    const probe = await fs.open(path.join(sandbox, 'probe'), 'w');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const syncSpy = jest
      .spyOn(fileHandlePrototype, 'sync')
      .mockRejectedValueOnce(new Error('injected sync ambiguity'));
    try {
      await expect(store.appendEvent(job.jobId, queued)).resolves.toMatchObject({
        status: 'queued',
      });
      await expect(store.appendEvent(job.jobId, queued)).resolves.toMatchObject({
        status: 'queued',
        lastSequence: 3,
      });
    } finally {
      syncSpy.mockRestore();
    }

    const eventLines = (await fs.readFile(historyPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .filter((line) => JSON.parse(line).recordType === 'event-appended');
    expect(eventLines).toHaveLength(1);
    await store.close();
  });

  it('serializes same-instance initialization and locks out a second live owner', async () => {
    const seed = trackedStore(historyPath);
    await seed.initialize();
    const job = await seed.createJob(creation());
    await seed.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: job.previewId,
        effectiveOptions: options(),
      })
    );
    await seed.close();

    const sameInstance = trackedStore(historyPath);
    await expect(
      Promise.all([sameInstance.initialize(), sameInstance.initialize()])
    ).resolves.toEqual([undefined, undefined]);
    expect(
      (await sameInstance.getJob(job.jobId))?.events.filter(
        (item) => item.kind === ProcessingEventKind.JOB_FAILED
      )
    ).toHaveLength(1);
    await sameInstance.close();

    const ownerA = trackedStore(historyPath);
    const ownerB = trackedStore(historyPath);
    const results = await Promise.allSettled([ownerA.initialize(), ownerB.initialize()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'STORE_LOCKED' });

    if (results[0].status === 'fulfilled') await ownerA.close();
    if (results[1].status === 'fulfilled') await ownerB.close();

    const reopened = trackedStore(historyPath);
    await reopened.initialize();
    expect(
      (await reopened.getJob(job.jobId))?.events.filter(
        (item) => item.kind === ProcessingEventKind.JOB_FAILED
      )
    ).toHaveLength(1);
    await reopened.close();
  });

  it('reports lock contention when the reclaimer vanishes after observation', async () => {
    let releaseOwnerPublication!: () => void;
    let announceOwnerPublication!: () => void;
    let releaseContenderObservation!: () => void;
    let announceContenderObservation!: () => void;
    const ownerPublicationReached = new Promise<void>((resolve) => {
      announceOwnerPublication = resolve;
    });
    const ownerPublicationBarrier = new Promise<void>((resolve) => {
      releaseOwnerPublication = resolve;
    });
    const contenderObservationReached = new Promise<void>((resolve) => {
      announceContenderObservation = resolve;
    });
    const contenderObservationBarrier = new Promise<void>((resolve) => {
      releaseContenderObservation = resolve;
    });

    const owner = trackedStore(historyPath, {
      testHooks: {
        afterLockLinked: async (targetPath) => {
          if (targetPath.endsWith('.reclaim')) return;
          announceOwnerPublication();
          await ownerPublicationBarrier;
        },
      },
    });
    const contender = trackedStore(historyPath, {
      testHooks: {
        afterLockPathObserved: async (targetPath) => {
          if (!targetPath.endsWith('.reclaim')) return;
          announceContenderObservation();
          await contenderObservationBarrier;
        },
      },
    });

    const ownerInitialization = owner.initialize();
    let contenderInitialization: Promise<void> | undefined;
    try {
      await waitForBarrier(ownerPublicationReached, 'owner primary-lock publication');
      contenderInitialization = contender.initialize();
      await waitForBarrier(contenderObservationReached, 'contender reclaimer observation');
      releaseOwnerPublication();
      await expect(ownerInitialization).resolves.toBeUndefined();
      releaseContenderObservation();
      await expect(contenderInitialization).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    } finally {
      releaseOwnerPublication();
      releaseContenderObservation();
      await Promise.allSettled(
        contenderInitialization
          ? [ownerInitialization, contenderInitialization]
          : [ownerInitialization]
      );
    }
  });

  it('serializes stale-lock reclamation and binds removal to the inspected owner', async () => {
    await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(historyPath, '', { mode: 0o600 });
    await fs.writeFile(
      `${historyPath}.lock`,
      `${JSON.stringify({
        pid: 2147483647,
        token: '00000000-0000-4000-8000-000000000099',
        createdAt: '2026-08-29T18:00:00.000Z',
      })}\n`,
      { mode: 0o600 }
    );

    let releaseReclaimer!: () => void;
    let announceReclaimer!: () => void;
    let announceContention!: () => void;
    const reclaimerReached = new Promise<void>((resolve) => {
      announceReclaimer = resolve;
    });
    const contenderReached = new Promise<void>((resolve) => {
      announceContention = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseReclaimer = resolve;
    });

    const ownerA = trackedStore(historyPath, {
      testHooks: {
        beforeStaleLockRemoval: async () => {
          announceReclaimer();
          await release;
        },
      },
    });
    const ownerB = trackedStore(historyPath, {
      testHooks: { onReclaimerContended: () => announceContention() },
    });
    const first = ownerA.initialize();
    await reclaimerReached;
    const second = ownerB.initialize();
    await contenderReached;
    releaseReclaimer();

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'STORE_LOCKED' });
  });

  it.each([
    ['', 'empty'],
    ['{"pid":', 'partial'],
    ['{"pid":"wrong","token":"bad"}\n', 'invalid'],
  ])('recovers an abandoned %s crash lock under the reclaimer', async (lockContent, label) => {
    const casePath = path.join(sandbox, `crash-lock-${label}`, 'jobs.jsonl');
    await fs.mkdir(path.dirname(casePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${casePath}.lock`, lockContent, { mode: 0o600 });

    const store = trackedStore(casePath);
    await expect(store.initialize()).resolves.toBeUndefined();
    await expect(store.createJob(creation())).resolves.toMatchObject({ status: 'preview-ready' });
  });

  it('rejects an append if the canonical history pathname changes during sync', async () => {
    let armSwap = false;
    let swapped = false;
    const detachedPath = path.join(sandbox, 'detached-history.jsonl');
    const store = trackedStore(historyPath, {
      testHooks: {
        beforeHistorySync: async () => {
          if (!armSwap || swapped) return;
          swapped = true;
          await fs.rename(historyPath, detachedPath);
          await fs.writeFile(historyPath, '', { mode: 0o600 });
        },
      },
    });
    await store.initialize();
    const job = await store.createJob(creation());
    armSwap = true;

    const queued = event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
      previewId: job.previewId,
      effectiveOptions: options(),
    });
    await expect(store.appendEvent(job.jobId, queued)).rejects.toMatchObject({
      code: 'UNSAFE_HISTORY_PATH',
    });
    await expect(store.getJob(job.jobId)).rejects.toMatchObject({
      code: 'UNSAFE_HISTORY_PATH',
    });
    await expect(store.listJobs()).rejects.toMatchObject({ code: 'UNSAFE_HISTORY_PATH' });
  });

  it('coordinates close with initialization and synchronously rejects late writes', async () => {
    const initialized = trackedStore(historyPath);
    await initialized.initialize();
    const closeFirst = initialized.close();
    const rejectedCreate = expect(initialized.createJob(creation())).rejects.toMatchObject({
      code: 'STORE_CLOSED',
    });
    await expect(closeFirst).resolves.toBeUndefined();
    await rejectedCreate;

    const admitted = trackedStore(path.join(sandbox, 'admitted', 'jobs.jsonl'));
    await admitted.initialize();
    const admittedCreate = admitted.createJob(creation());
    const admittedClose = admitted.close();
    await expect(admittedCreate).resolves.toMatchObject({ status: 'preview-ready' });
    await expect(admittedClose).resolves.toBeUndefined();

    const pausedPath = path.join(sandbox, 'paused', 'jobs.jsonl');
    await fs.mkdir(path.dirname(pausedPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${pausedPath}.lock`, '{"pid":', { mode: 0o600 });
    let announce!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = trackedStore(pausedPath, {
      testHooks: {
        beforeStaleLockRemoval: async () => {
          announce();
          await barrier;
        },
      },
    });
    const initialization = paused.initialize();
    await reached;
    const closing = paused.close();
    release();
    await expect(initialization).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    await expect(paused.listJobs()).rejects.toMatchObject({ code: 'STORE_CLOSED' });
    await expect(fs.lstat(`${pausedPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['get', 'list'] as const)(
    'drains an admitted %s read before close releases storage handles',
    async (operation) => {
      let announce!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const store = trackedStore(historyPath, {
        testHooks: {
          beforeReadOwnershipCheck: async (admittedOperation) => {
            if (admittedOperation !== operation) return;
            announce();
            await barrier;
          },
        },
      });
      await store.initialize();
      const job = await store.createJob(creation());
      const read = operation === 'get' ? store.getJob(job.jobId) : store.listJobs();
      await reached;
      let closeSettled = false;
      const closing = store.close().finally(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      release();
      await expect(read).resolves.toBeDefined();
      await expect(closing).resolves.toBeUndefined();
    }
  );

  it.each(['reclaimer', 'primary'])(
    'cleans an identity-bound %s lock after post-link publication failure',
    async (failureTarget) => {
      let injected = false;
      const failing = trackedStore(historyPath, {
        testHooks: {
          afterLockLinked: async (targetPath) => {
            const isReclaimer = targetPath.endsWith('.reclaim');
            const shouldFail = failureTarget === 'reclaimer' ? isReclaimer : !isReclaimer;
            if (shouldFail && !injected) {
              injected = true;
              const error = new Error('injected post-link failure') as NodeJS.ErrnoException;
              error.code = 'EIO';
              throw error;
            }
          },
        },
      });
      await expect(failing.initialize()).rejects.toMatchObject({ code: 'EIO' });
      await expect(fs.lstat(`${historyPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(`${historyPath}.lock.reclaim`)).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const retry = trackedStore(historyPath);
      await expect(retry.initialize()).resolves.toBeUndefined();
    }
  );

  it('never deletes a replacement lock during failed-publication cleanup', async () => {
    const replacementToken = '40000000-0000-4000-8000-000000000001';
    let injectedFailure = false;
    let replaced = false;
    const failing = trackedStore(historyPath, {
      testHooks: {
        afterLockLinked: async (targetPath) => {
          if (!targetPath.endsWith('.reclaim') && !injectedFailure) {
            injectedFailure = true;
            const error = new Error('injected post-link failure') as NodeJS.ErrnoException;
            error.code = 'EIO';
            throw error;
          }
        },
        beforeOwnedLockQuarantine: async (targetPath) => {
          if (targetPath.endsWith('.reclaim') || replaced) return;
          replaced = true;
          await fs.unlink(targetPath);
          await fs.writeFile(
            targetPath,
            `${JSON.stringify({
              pid: process.pid,
              token: replacementToken,
              createdAt: '2026-01-01T00:00:00.000Z',
            })}\n`,
            { mode: 0o600 }
          );
        },
      },
    });
    await expect(failing.initialize()).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    expect(JSON.parse(await fs.readFile(`${historyPath}.lock`, 'utf8')).token).toBe(
      replacementToken
    );
  });

  it('never deletes a replacement lock during normal ownership release', async () => {
    const replacementToken = '40000000-0000-4000-8000-000000000002';
    let armed = false;
    let replaced = false;
    const store = trackedStore(historyPath, {
      testHooks: {
        beforeOwnedLockQuarantine: async (targetPath) => {
          if (!armed || targetPath.endsWith('.reclaim') || replaced) return;
          replaced = true;
          await fs.unlink(targetPath);
          await fs.writeFile(
            targetPath,
            `${JSON.stringify({
              pid: process.pid,
              token: replacementToken,
              createdAt: '2026-01-01T00:00:00.000Z',
            })}\n`,
            { mode: 0o600 }
          );
        },
      },
    });
    await store.initialize();
    armed = true;
    await expect(store.close()).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    expect(JSON.parse(await fs.readFile(`${historyPath}.lock`, 'utf8')).token).toBe(
      replacementToken
    );
  });

  it('syncs containing directories for new entries and syncs chmod repairs', async () => {
    const nestedPath = path.join(sandbox, 'one', 'two', 'three', 'jobs.jsonl');
    const syncedDirectories: string[] = [];
    let permissionRepairSynced = false;
    const nested = trackedStore(nestedPath, {
      testHooks: {
        onDirectorySynced: (directoryPath) => syncedDirectories.push(directoryPath),
        onHistoryPermissionSynced: () => {
          permissionRepairSynced = true;
        },
      },
    });
    await nested.initialize();
    expect(syncedDirectories).toEqual(
      expect.arrayContaining([sandbox, path.join(sandbox, 'one'), path.join(sandbox, 'one', 'two')])
    );
    expect(permissionRepairSynced).toBe(true);

    const existingPath = path.join(sandbox, 'existing', 'jobs.jsonl');
    await fs.mkdir(path.dirname(existingPath), { mode: 0o700 });
    await fs.writeFile(existingPath, '', { mode: 0o644 });
    await fs.chmod(existingPath, 0o644);
    let existingRepairSynced = false;
    const existing = trackedStore(existingPath, {
      testHooks: {
        onHistoryPermissionSynced: () => {
          existingRepairSynced = true;
        },
      },
    });
    await existing.initialize();
    expect(existingRepairSynced).toBe(true);
    expect((await fs.stat(existingPath)).mode & 0o777).toBe(0o600);
  });

  it('rejects unknown keys and malformed nested DTO and event payloads', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    await expect(
      store.createJob({ ...creation(), secret: 'persist-me' } as CreateHistoryJobInput)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const executableNullTarget = creation();
    executableNullTarget.jobId = randomUUID();
    executableNullTarget.previewRows[0].targetPath = null;
    await expect(store.createJob(executableNullTarget)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const impossibleInstant = creation();
    impossibleInstant.jobId = randomUUID();
    impossibleInstant.previewRows[0].dateEvidence.value = '2024-02-30T00:00:00Z';
    await expect(store.createJob(impossibleInstant)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    const job = await store.createJob(creation());
    await expect(
      store.appendEvent(job.jobId, null as unknown as ProcessingEvent)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: job.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      job.jobId,
      event(job.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'discovery' })
    );
    await expect(
      store.appendEvent(
        job.jobId,
        event(
          job.jobId,
          ProcessingEventKind.JOB_COMPLETED,
          5,
          {} as Extract<ProcessingEvent, { kind: 'job-completed' }>['payload']
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await store.close();

    const lines = (await fs.readFile(historyPath, 'utf8')).trimEnd().split('\n');
    const creationRecord = JSON.parse(lines[0]) as Record<string, unknown>;
    creationRecord.unknown = 'secret';
    await fs.writeFile(historyPath, `${JSON.stringify(creationRecord)}\n`, { mode: 0o600 });
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 1,
    });

    const malformedTerminal = {
      schemaVersion: 1,
      recordType: 'event-appended',
      event: {
        kind: ProcessingEventKind.JOB_COMPLETED,
        jobId: job.jobId,
        sequence: 5,
        emittedAt: 'not-a-timestamp',
        payload: {},
      },
    };
    await fs.writeFile(historyPath, `${lines.join('\n')}\n${JSON.stringify(malformedTerminal)}\n`, {
      mode: 0o600,
    });
    await expect(trackedStore(historyPath).initialize()).rejects.toMatchObject({
      code: 'CORRUPT_HISTORY',
      line: 4,
    });
  });

  it('validates every discriminated event payload before persistence', async () => {
    const store = trackedStore(historyPath);
    await store.initialize();
    const invalidJob = await store.createJob(creation());
    const eventKinds = Object.values(ProcessingEventKind);
    for (const [offset, kind] of eventKinds.entries()) {
      await expect(
        store.appendEvent(invalidJob.jobId, {
          kind,
          jobId: invalidJob.jobId,
          sequence: offset + 3,
          emittedAt: '2026-08-29T18:00:00.000Z',
          payload: { unknown: true },
        } as ProcessingEvent)
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }

    const cancelledJob = await store.createJob({ ...creation(), previewId: 'preview-cancelled' });
    await store.appendEvent(
      cancelledJob.jobId,
      event(cancelledJob.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: cancelledJob.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      cancelledJob.jobId,
      event(cancelledJob.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'discovery' })
    );
    await store.appendEvent(
      cancelledJob.jobId,
      event(cancelledJob.jobId, ProcessingEventKind.JOB_PROGRESS, 5, {
        phase: 'metadata',
        filesProcessed: 1,
        totalFiles: 2,
        percentage: 50,
        currentFile: '/media/source/photo.jpg',
      })
    );
    await store.appendEvent(
      cancelledJob.jobId,
      event(cancelledJob.jobId, ProcessingEventKind.JOB_CANCELLING, 6, { reason: 'user' })
    );
    await expect(
      store.appendEvent(
        cancelledJob.jobId,
        event(cancelledJob.jobId, ProcessingEventKind.JOB_CANCELLED, 7, {
          reason: 'user',
          filesProcessed: 0,
          statistics: {
            totalFiles: 2,
            processedFiles: 0,
            skippedFiles: 0,
            failedFiles: 0,
            cancelledFiles: 1,
            unattemptedFiles: 1,
            totalBytes: 42,
            processedBytes: 0,
            committedResidueBytes: 21,
            durationMs: 100,
          },
          fileFailures: [],
          fileOutcomes: [
            {
              sourcePath: '/media/source/photo.jpg',
              destinationPath: '/media/destination/photo.jpg',
              state: 'destination-committed-source-retained',
              plannedBytes: 21,
              committedBytes: 21,
              sourceRetained: true,
              error: 'cancelled after commit',
            },
            {
              sourcePath: '/media/source/other.jpg',
              destinationPath: '/media/destination/other.jpg',
              state: 'not-attempted',
              plannedBytes: 21,
              committedBytes: 0,
              sourceRetained: true,
              error: 'not attempted',
            },
          ],
        })
      )
    ).resolves.toMatchObject({ status: 'cancelled' });

    const zeroByteCreation: CreateHistoryJobInput = {
      ...creation(),
      previewId: 'preview-zero-byte-cancelled',
      previewSummary: {
        totalFiles: 3,
        copyFiles: 0,
        moveFiles: 1,
        skippedFiles: 2,
        renamedFiles: 0,
        overwrittenFiles: 0,
        unresolvedDates: 1,
        totalBytes: 0,
      },
      previewRows: [
        {
          ...previewRows()[0],
          sourcePath: '/media/source/empty.mov',
          targetPath: '/media/destination/empty.mov',
          fingerprint: { ...previewRows()[0].fingerprint, size: 0 },
        },
        {
          ...previewRows()[0],
          sourcePath: '/media/source/conflict.mov',
          targetPath: '/media/destination/conflict.mov',
          operation: 'skip',
          conflictPolicy: 'skip',
          fingerprint: { ...previewRows()[0].fingerprint, size: 0 },
          warnings: ['Target already exists'],
        },
        {
          ...previewRows()[0],
          sourcePath: '/media/source/unsupported.bin',
          targetPath: null,
          operation: 'skip',
          dateEvidence: {
            value: null,
            source: 'unresolved',
            confidence: 0,
            warnings: ['Needs Review'],
          },
          fingerprint: { ...previewRows()[0].fingerprint, size: 0 },
          warnings: ['Needs Review'],
        },
      ],
    };
    const zeroByteJob = await store.createJob(zeroByteCreation);
    await store.appendEvent(
      zeroByteJob.jobId,
      event(zeroByteJob.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: zeroByteJob.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      zeroByteJob.jobId,
      event(zeroByteJob.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'organization' })
    );
    await store.appendEvent(
      zeroByteJob.jobId,
      event(zeroByteJob.jobId, ProcessingEventKind.JOB_CANCELLING, 5, { reason: 'user' })
    );
    const zeroBytePayload = {
      reason: 'user',
      filesProcessed: 0,
      statistics: {
        totalFiles: 3,
        processedFiles: 0,
        skippedFiles: 2,
        failedFiles: 0,
        cancelledFiles: 1,
        unattemptedFiles: 0,
        totalBytes: 0,
        processedBytes: 0,
        committedResidueBytes: 0,
        durationMs: 100,
      },
      fileFailures: [],
      fileOutcomes: [
        {
          sourcePath: '/media/source/empty.mov',
          destinationPath: '/media/destination/empty.mov',
          state: 'destination-committed-source-retained' as const,
          plannedBytes: 0,
          committedBytes: 0,
          sourceRetained: true,
          error: 'cancelled after zero-byte destination commit',
        },
        {
          sourcePath: '/media/source/conflict.mov',
          destinationPath: '/media/destination/conflict.mov',
          state: 'skipped' as const,
          plannedBytes: 0,
          committedBytes: 0,
          sourceRetained: true,
        },
        {
          sourcePath: '/media/source/unsupported.bin',
          destinationPath: null,
          state: 'skipped' as const,
          plannedBytes: 0,
          committedBytes: 0,
          sourceRetained: true,
        },
      ],
    };
    await expect(
      store.appendEvent(
        zeroByteJob.jobId,
        event(zeroByteJob.jobId, ProcessingEventKind.JOB_CANCELLED, 6, zeroBytePayload)
      )
    ).resolves.toMatchObject({ status: 'cancelled' });

    const substitutedJob = await store.createJob({
      ...zeroByteCreation,
      jobId: randomUUID(),
      previewId: 'preview-substituted-cancelled',
    });
    await store.appendEvent(
      substitutedJob.jobId,
      event(substitutedJob.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: substitutedJob.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      substitutedJob.jobId,
      event(substitutedJob.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'organization' })
    );
    await store.appendEvent(
      substitutedJob.jobId,
      event(substitutedJob.jobId, ProcessingEventKind.JOB_CANCELLING, 5, { reason: 'user' })
    );
    await expect(
      store.appendEvent(
        substitutedJob.jobId,
        event(substitutedJob.jobId, ProcessingEventKind.JOB_CANCELLED, 6, {
          ...zeroBytePayload,
          fileOutcomes: [
            { ...zeroBytePayload.fileOutcomes[0], sourcePath: '/media/source/substituted.mov' },
            ...zeroBytePayload.fileOutcomes.slice(1),
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD_MISMATCH' });

    const falseSuccessJob = await store.createJob({
      ...zeroByteCreation,
      jobId: randomUUID(),
      previewId: 'preview-false-success-cancelled',
    });
    await store.appendEvent(
      falseSuccessJob.jobId,
      event(falseSuccessJob.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: falseSuccessJob.previewId,
        effectiveOptions: options(),
      })
    );
    await store.appendEvent(
      falseSuccessJob.jobId,
      event(falseSuccessJob.jobId, ProcessingEventKind.JOB_STARTED, 4, { phase: 'organization' })
    );
    await store.appendEvent(
      falseSuccessJob.jobId,
      event(falseSuccessJob.jobId, ProcessingEventKind.JOB_CANCELLING, 5, { reason: 'user' })
    );
    const { error: _cancelError, ...falseCompletedOutcome } = zeroBytePayload.fileOutcomes[0];
    await expect(
      store.appendEvent(
        falseSuccessJob.jobId,
        event(falseSuccessJob.jobId, ProcessingEventKind.JOB_CANCELLED, 6, {
          ...zeroBytePayload,
          filesProcessed: 1,
          statistics: {
            ...zeroBytePayload.statistics,
            processedFiles: 1,
            cancelledFiles: 0,
          },
          fileOutcomes: [
            {
              ...falseCompletedOutcome,
              state: 'completed',
              sourceRetained: true,
            },
            ...zeroBytePayload.fileOutcomes.slice(1),
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'IMMUTABLE_FIELD_MISMATCH' });

    await expect(
      store.appendEvent(
        falseSuccessJob.jobId,
        event(falseSuccessJob.jobId, ProcessingEventKind.JOB_CANCELLED, 6, {
          ...zeroBytePayload,
          statistics: {
            ...zeroBytePayload.statistics,
            skippedFiles: 3,
            cancelledFiles: 0,
          },
          fileOutcomes: [
            {
              ...falseCompletedOutcome,
              state: 'skipped',
              sourceRetained: false,
            },
            ...zeroBytePayload.fileOutcomes.slice(1),
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const failedJob = await store.createJob({ ...creation(), previewId: 'preview-failed' });
    await store.appendEvent(
      failedJob.jobId,
      event(failedJob.jobId, ProcessingEventKind.JOB_QUEUED, 3, {
        previewId: failedJob.previewId,
        effectiveOptions: options(),
      })
    );
    await expect(
      store.appendEvent(
        failedJob.jobId,
        event(failedJob.jobId, ProcessingEventKind.JOB_FAILED, 4, {
          error: {
            code: 'TEST_FAILURE',
            message: 'expected failure',
            recoverable: false,
            details: 'validated details',
          },
        })
      )
    ).resolves.toMatchObject({ status: 'failed' });
    await store.close();
  });
});
