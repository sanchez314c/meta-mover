/** @jest-environment node */
import { mkdtemp, rm, stat, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { EvidenceManifest } from '../../../src/main/core/evidence/EvidenceManifest';

describe('evidence verification responsiveness', () => {
  let root: string;
  let file: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'evidence-progress-'));
    file = path.join(root, 'events.jsonl');
    const manifest = await EvidenceManifest.create(file, 'progress', 'policy/1');
    await manifest.appendBatch(Array.from({ length: 128 }, (_, i) => ({
      kind: 'file-observed' as const,
      payload: { index: i, text: 'x'.repeat(8192), nested: { eventHash: 'data', '__proto__': null } },
    })));
    await manifest.close({ done: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('reports bounded monotonic byte progress with an exact final count', async () => {
    const reports: Array<{ bytesRead: number; totalBytes: number; eventCount: number }> = [];
    await expect(EvidenceManifest.verify(file, { onProgress: async p => { reports.push(p); } }))
      .resolves.toMatchObject({ valid: true, eventCount: 130 });
    expect(reports[0].bytesRead).toBe(0);
    expect(reports.at(-1)).toEqual({ bytesRead: (await stat(file)).size, totalBytes: (await stat(file)).size, eventCount: 130 });
    expect(reports.length).toBeLessThan(20);
    reports.forEach((p, i) => { if (i) expect(p.bytesRead).toBeGreaterThanOrEqual(reports[i - 1].bytesRead); });
  });

  it('propagates preexisting cancellation for both entry points', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(EvidenceManifest.verify(file, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(EvidenceManifest.verifyPreviewSnapshot(file, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('yields so timer cancellation interrupts verification', async () => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    await expect(EvidenceManifest.verify(file, {
      signal: controller.signal,
      onProgress: () => { timer ??= setTimeout(() => controller.abort(), 0); },
    })).rejects.toMatchObject({ name: 'AbortError' });
    if (timer) clearTimeout(timer);
    await expect(EvidenceManifest.verify(file)).resolves.toMatchObject({ valid: true });
  });

  it('rejects overflowing JSON numbers without canonicalizing parsed object copies', async () => {
    const content = await readFile(file, 'utf8');
    await writeFile(file, content.replace('"index":0', '"index":1e400'));
    await expect(EvidenceManifest.verify(file)).resolves.toMatchObject({ valid: false });
  });
});
