/** Read-only replay of persisted date-resolution rows through the current resolver. */
import fs from 'fs';
import readline from 'readline';

import { resolveDateCandidates } from '../src/main/core/date/DateResolver';

interface ReplayRow {
  resolution: {
    fileId: string;
    mediaKind: Parameters<typeof resolveDateCandidates>[0]['mediaKind'];
    evaluationTimeUtc: string;
    candidates: Parameters<typeof resolveDateCandidates>[0]['candidates'];
    status: string;
  };
}

async function replay(source: string): Promise<void> {
  let total = 0;
  let resolved = 0;
  let dateOnly = 0;
  const transitions: Record<string, number> = {};
  const input = fs.createReadStream(source);
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line) continue;
    const row = JSON.parse(line) as ReplayRow;
    const before = row.resolution.status;
    const result = resolveDateCandidates({
      fileId: row.resolution.fileId,
      mediaKind: row.resolution.mediaKind,
      evaluationTimeUtc: row.resolution.evaluationTimeUtc,
      candidates: row.resolution.candidates,
    });
    total += 1;
    if (result.status === 'resolved') resolved += 1;
    if (result.reasonCodes.includes('RESOLVED_DATE_ONLY')) dateOnly += 1;
    const transition = `${before}->${result.status}`;
    transitions[transition] = (transitions[transition] ?? 0) + 1;
  }
  process.stdout.write(
    `${JSON.stringify({ source, total, resolved, dateOnly, residue: total - resolved, transitions }, null, 2)}\n`
  );
}

const source = process.argv[2];
if (!source) throw new Error('usage: ts-node tools/replay-date-resolution.ts <rows.jsonl>');
void replay(source);
