import { chmod, link, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { EvidenceManifest, canonicalJson } from '../../../src/main/core/evidence/EvidenceManifest';

describe('EvidenceManifest', () => {
  let root: string;
  let manifestPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-evidence-'));
    manifestPath = path.join(root, 'run.jsonl');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes an ordered hash chain with private permissions', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-1', 'date-policy/1');
    await manifest.append('file-observed', { fileId: 'abc', bytes: 3 });
    await manifest.append('resolution-decided', { candidateId: 'candidate-1' });
    const closed = await manifest.close({ outcome: 'completed' });

    expect(closed.eventCount).toBe(4);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toEqual({
      valid: true,
      eventCount: 4,
      finalHash: closed.finalHash,
    });
    if (process.platform !== 'win32') {
      expect((await lstat(manifestPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects canonical accessors without executing them', () => {
    let getterExecutions = 0;
    const value = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterExecutions += 1;
        return 'executed';
      },
    });

    expect(() => canonicalJson(value)).toThrow(/accessor|data property/i);
    expect(getterExecutions).toBe(0);
  });

  it('rejects proxies without executing their traps', () => {
    let trapExecutions = 0;
    const value = new Proxy(
      { visible: true },
      {
        getPrototypeOf: () => {
          trapExecutions += 1;
          return Object.prototype;
        },
        ownKeys: () => {
          trapExecutions += 1;
          return ['visible'];
        },
      }
    );

    expect(() => canonicalJson(value)).toThrow(/canonical|proxy|plain/i);
    expect(trapExecutions).toBe(0);
  });

  it('preserves __proto__ as canonical evidence data', () => {
    const value = JSON.parse('{"safe":1,"__proto__":{"polluted":true}}') as unknown;

    expect(canonicalJson(value)).toBe('{"__proto__":{"polluted":true},"safe":1}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    ['symbol property', () => ({ visible: true, [Symbol('hidden')]: 'secret' })],
    ['class instance', () => new (class EvidenceClass {})()],
    [
      'cycle',
      () => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      },
    ],
    ['undefined object value', () => ({ missing: undefined })],
    ['undefined array value', () => [undefined]],
    ['non-finite number', () => ({ invalid: Number.POSITIVE_INFINITY })],
  ])('rejects non-canonical %s', (_label, build) => {
    expect(() => canonicalJson(build())).toThrow(/canonical|unsupported|serializable/i);
  });

  it('rejects a maximum-length sparse array without iterating its declared length', () => {
    const hostile: unknown[] = [];
    hostile.length = 0xffff_ffff;

    expect(() => canonicalJson(hostile)).toThrow(/hole|array|canonical/i);
  });

  it('serializes concurrent appends into unique monotonic chain positions', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-concurrent', 'date-policy/1');
    const events = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        manifest.append('file-observed', { fileId: `file-${index}` })
      )
    );
    const closed = await manifest.close({ outcome: 'completed' });

    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 2)
    );
    expect(new Set(events.map((event) => event.sequence)).size).toBe(32);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: true,
      eventCount: 34,
      finalHash: closed.finalHash,
    });
  });

  it('requires an absolute path and a private real parent directory', async () => {
    const relativePath = `relative-evidence-${process.pid}.jsonl`;
    await expect(
      EvidenceManifest.create(relativePath, 'job-relative', 'date-policy/1')
    ).rejects.toThrow(/absolute/i);
    await rm(relativePath, { force: true });

    if (process.platform !== 'win32') await chmod(root, 0o755);
    let opened: EvidenceManifest | undefined;
    let failure: unknown;
    try {
      opened = await EvidenceManifest.create(manifestPath, 'job-public', 'date-policy/1');
    } catch (error) {
      failure = error;
    }
    if (opened) await opened.close({ cleanup: true });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/private|directory|permission/i);
  });

  it('rejects empty identity fields and reserved append operations', async () => {
    await expect(EvidenceManifest.create(manifestPath, '', 'date-policy/1')).rejects.toThrow(
      /non-empty/i
    );
    await expect(EvidenceManifest.create(manifestPath, 'job-invalid', '')).rejects.toThrow(
      /non-empty/i
    );

    const manifest = await EvidenceManifest.create(
      manifestPath,
      'job-input-validation',
      'date-policy/1'
    );
    await expect(manifest.append('job-closed', { outcome: 'bypass-close' })).rejects.toThrow(
      /use close/i
    );
    await expect(manifest.append('file-observed', { missing: undefined })).rejects.toThrow(
      /canonical|unsupported/i
    );
    await expect(manifest.close({ invalid: undefined })).rejects.toThrow(/canonical|unsupported/i);

    const closed = await manifest.close({ outcome: 'completed' });
    await expect(manifest.close({ outcome: 'duplicate' })).resolves.toEqual(closed);
  });

  it('fails closed on an oversized event even when cleanup reports a secondary error', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-oversized', 'date-policy/1');
    const internal = manifest as unknown as { handle: { close(): Promise<void> } };
    const originalClose = internal.handle.close.bind(internal.handle);
    const closeSpy = jest.spyOn(internal.handle, 'close').mockImplementationOnce(async () => {
      await originalClose();
      throw new Error('injected cleanup close failure');
    });

    await expect(
      manifest.append('file-observed', { content: 'x'.repeat(16 * 1024 * 1024) })
    ).rejects.toThrow(/size limit/i);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    await expect(manifest.append('file-observed', { content: 'late' })).rejects.toThrow(/closed/i);
  });

  it('returns invalid verification results for missing, open, and malformed manifests', async () => {
    await expect(EvidenceManifest.verify(path.join(root, 'missing.jsonl'))).resolves.toMatchObject({
      valid: false,
      eventCount: 0,
    });

    const openManifest = await EvidenceManifest.create(
      manifestPath,
      'job-open-verification',
      'date-policy/1'
    );
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: false,
      eventCount: 1,
      reason: expect.stringMatching(/not closed/i),
    });
    await openManifest.close({ outcome: 'completed' });

    const malformedPath = path.join(root, 'malformed-schema.jsonl');
    await writeFile(malformedPath, '{"wrong":true}\n', { mode: 0o600 });
    await expect(EvidenceManifest.verify(malformedPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/schema/i),
    });
  });

  it('rejects empty records and structural chain violations before trusting hashes', async () => {
    const emptyPath = path.join(root, 'empty-record.jsonl');
    await writeFile(emptyPath, '\n', { mode: 0o600 });
    await expect(EvidenceManifest.verify(emptyPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/empty line/i),
    });

    const structuralPath = path.join(root, 'structural.jsonl');
    const manifest = await EvidenceManifest.create(
      structuralPath,
      'job-structural',
      'date-policy/1'
    );
    await manifest.close({ outcome: 'completed' });
    const firstEvent = JSON.parse(
      (await readFile(structuralPath, 'utf8')).split('\n')[0]
    ) as Record<string, unknown>;

    await writeFile(structuralPath, `${canonicalJson({ ...firstEvent, sequence: 2 })}\n`, {
      mode: 0o600,
    });
    await expect(EvidenceManifest.verify(structuralPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/sequence/i),
    });

    await writeFile(
      structuralPath,
      `${canonicalJson({ ...firstEvent, previousHash: 'f'.repeat(64) })}\n`,
      { mode: 0o600 }
    );
    await expect(EvidenceManifest.verify(structuralPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/chain/i),
    });
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects verification through a %s leaf',
    async (kind) => {
      const originalPath = path.join(root, 'original.jsonl');
      const manifest = await EvidenceManifest.create(originalPath, 'job-link', 'date-policy/1');
      await manifest.close({ outcome: 'completed' });
      if (kind === 'symlink') await symlink(originalPath, manifestPath);
      else await link(originalPath, manifestPath);

      await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: false });
    }
  );

  it('detects pathname replacement before appending through its held handle', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-identity', 'date-policy/1');
    const displaced = path.join(root, 'displaced.jsonl');
    await rename(manifestPath, displaced);
    await writeFile(manifestPath, 'replacement\n', { mode: 0o600 });

    await expect(manifest.append('file-observed', { fileId: 'blocked' })).rejects.toThrow(
      /identity|replaced|link/i
    );
    expect(await readFile(manifestPath, 'utf8')).toBe('replacement\n');

    await rm(manifestPath);
    await rename(displaced, manifestPath);
    await expect(manifest.close({ outcome: 'must-not-recover' })).rejects.toThrow(/closed/i);
  });

  it('fails closed if directory or manifest permissions become public', async () => {
    if (process.platform === 'win32') return;
    const manifest = await EvidenceManifest.create(
      manifestPath,
      'job-permissions',
      'date-policy/1'
    );
    await chmod(root, 0o755);

    await expect(manifest.append('file-observed', { fileId: 'blocked' })).rejects.toThrow(
      /private|permission|unsafe|identity|linked/i
    );

    await chmod(root, 0o700);
    await expect(manifest.close({ outcome: 'must-not-recover' })).rejects.toThrow(/closed|unsafe/i);
    await chmod(manifestPath, 0o644);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: false });
  });

  it('poisons and closes the held handle when identity fails after a durable write', async () => {
    if (process.platform === 'win32') return;
    const manifest = await EvidenceManifest.create(
      manifestPath,
      'job-post-write-failure',
      'date-policy/1'
    );
    const internal = manifest as unknown as {
      handle: { sync(): Promise<void> };
    };
    const originalSync = internal.handle.sync.bind(internal.handle);
    internal.handle.sync = async () => {
      await originalSync();
      await chmod(root, 0o755);
    };

    await expect(
      manifest.append('file-observed', { fileId: 'written-then-rejected' })
    ).rejects.toThrow(/identity|linked|unsafe/i);
    await chmod(root, 0o700);
    await expect(
      manifest.append('file-observed', { fileId: 'duplicate-sequence' })
    ).rejects.toThrow(/closed/i);
    await expect(manifest.close({ outcome: 'must-not-recover' })).rejects.toThrow(/closed/i);
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: false });
  });

  it('makes concurrent close idempotent and rejects later appends', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-close', 'date-policy/1');
    const append = manifest.append('file-observed', { fileId: 'before-close' });
    const firstClose = manifest.close({ outcome: 'completed' });
    const secondClose = manifest.close({ outcome: 'ignored-duplicate' });

    await expect(append).resolves.toMatchObject({ sequence: 2 });
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([
      expect.objectContaining({ eventCount: 3 }),
      expect.objectContaining({ eventCount: 3 }),
    ]);
    await expect(manifest.append('operation-failed', { code: 'late' })).rejects.toThrow(
      /closed|closing/i
    );
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: true,
      eventCount: 3,
    });
  });

  it('detects payload tampering', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-2', 'date-policy/1');
    await manifest.append('file-observed', { fileId: 'before' });
    await manifest.close({ outcome: 'completed' });

    const content = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, content.replace('before', 'after!'), { mode: 0o600 });

    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({ valid: false });
  });

  it.each([
    [
      'a duplicate key whose final parsed value preserves the original hash input',
      (line: string) => line.replace('"safe":"x"', '"safe":"evil","safe":"x"'),
    ],
    ['leading whitespace', (line: string) => ` ${line}`],
  ])('rejects non-canonical raw JSON containing %s', async (_label, alter) => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-raw-json', 'date-policy/1');
    await manifest.append('file-observed', { safe: 'x' });
    await manifest.close({ outcome: 'completed' });

    const lines = (await readFile(manifestPath, 'utf8')).trimEnd().split('\n');
    lines[1] = alter(lines[1]);
    await writeFile(manifestPath, `${lines.join('\n')}\n`, { mode: 0o600 });

    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/canonical|json/i),
    });
  });

  it('fails closed for truncation and malformed final lines without throwing', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-3', 'date-policy/1');
    await manifest.append('file-observed', { fileId: 'abc' });
    await manifest.close({ outcome: 'completed' });

    const lines = (await readFile(manifestPath, 'utf8')).trimEnd().split('\n');
    await writeFile(manifestPath, lines.join('\n'), { mode: 0o600 });
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/newline|truncat|closed/i),
    });

    await writeFile(manifestPath, `${lines.slice(0, -1).join('\n')}\n{"broken":\n`, {
      mode: 0o600,
    });
    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/invalid json/i),
    });
  });

  it('rejects invalid UTF-8 even when decoding lossily would preserve the hashed value', async () => {
    const manifest = await EvidenceManifest.create(manifestPath, 'job-utf8', 'date-policy/1');
    await manifest.append('file-observed', { marker: '\ufffd' });
    await manifest.close({ outcome: 'completed' });

    const bytes = await readFile(manifestPath);
    const marker = Buffer.from('\ufffd', 'utf8');
    const markerOffset = bytes.indexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    const tampered = Buffer.concat([
      bytes.subarray(0, markerOffset),
      Buffer.from([0xff]),
      bytes.subarray(markerOffset + marker.length),
    ]);
    await writeFile(manifestPath, tampered, { mode: 0o600 });

    await expect(EvidenceManifest.verify(manifestPath)).resolves.toMatchObject({
      valid: false,
      reason: expect.stringMatching(/utf-8/i),
    });
  });
});
