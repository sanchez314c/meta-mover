import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { JobPlanInput, JobPlanStore } from '../../../src/main/services/JobPlanStore';

describe('JobPlanStore scale behavior', () => {
  it('streams a large corpus with chunk-bounded append and read state', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-mover-plan-scale-'));
    const recordCount = Number(process.env.JOB_PLAN_SCALE_RECORDS ?? 1_000_000);
    try {
      const store = new JobPlanStore<{ sourcePath: string }>(sandbox, {
        identity: 'scale-source',
        policy: 'scale-policy',
      });
      await store.initialize();

      async function* inputs(): AsyncGenerator<JobPlanInput<{ sourcePath: string }>> {
        for (let index = 0; index < recordCount; index += 1) {
          yield { operationId: `operation-${index}`, payload: { sourcePath: `/source/${index}` } };
        }
      }

      let appended = 0;
      let largestAppendPage = 0;
      for await (const references of store.appendPages(inputs())) {
        appended += references.length;
        largestAppendPage = Math.max(largestAppendPage, references.length);
      }
      expect(appended).toBe(recordCount);
      expect(largestAppendPage).toBeLessThanOrEqual(1_000);

      let streamed = 0;
      let largestReadPage = 0;
      for await (const records of store.pages({ pageSize: 733 })) {
        streamed += records.length;
        largestReadPage = Math.max(largestReadPage, records.length);
      }
      expect(streamed).toBe(recordCount);
      expect(largestReadPage).toBeLessThanOrEqual(733);
      expect(await store.getSummary()).toMatchObject({
        totalRecords: recordCount,
        terminalRecords: 0,
        chunkSize: 1_000,
      });
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  }, 180_000);
});
