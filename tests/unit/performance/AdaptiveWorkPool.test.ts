import { AdaptiveWorkPool } from '../../../src/main/services/AdaptiveWorkPool';

const lowCpuTimes = (() => {
  let total = 0;
  return () => {
    total += 100;
    return { idle: total, total };
  };
})();

describe('AdaptiveWorkPool', () => {
  it('reserves CPU headroom and preserves ordered results while running work concurrently', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      allStarted = resolve;
    });
    const pool = new AdaptiveWorkPool({
      availableParallelism: () => 20,
      readCpuTimes: lowCpuTimes,
      sampleIntervalMs: 1,
      wait: async () => undefined,
    });

    const resultPromise = pool.mapOrdered([0, 1, 2, 3, 4, 5], async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 6) allStarted();
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value * 2;
    });

    await started;
    expect(pool.maxConcurrency).toBe(15);
    expect(peak).toBeGreaterThan(1);
    releases.splice(0).forEach((release) => release());

    await expect(resultPromise).resolves.toEqual([0, 2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(15);
  });

  it('pauses new work at the 80 percent host CPU ceiling', async () => {
    const waits: number[] = [];
    const snapshots = [
      { idle: 0, total: 0 },
      { idle: 10, total: 100 },
      { idle: 70, total: 200 },
    ];
    const task = jest.fn(async () => 'done');
    const pool = new AdaptiveWorkPool({
      availableParallelism: () => 4,
      readCpuTimes: () => snapshots.shift() ?? { idle: 170, total: 300 },
      sampleIntervalMs: 25,
      wait: async (durationMs) => {
        waits.push(durationMs);
      },
    });

    await expect(pool.mapOrdered(['file'], task)).resolves.toEqual(['done']);

    expect(waits).toEqual([25, 25]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('stops admitting queued work after cancellation and waits for active work to settle', async () => {
    const controller = new AbortController();
    let admitted = 0;
    let settled = 0;
    const pool = new AdaptiveWorkPool({
      maxConcurrency: 2,
      availableParallelism: () => 20,
      readCpuTimes: lowCpuTimes,
      sampleIntervalMs: 1,
      wait: async () => undefined,
    });

    const result = pool.mapOrdered(
      [0, 1, 2, 3, 4],
      async (_value, _index, signal) => {
        admitted += 1;
        if (admitted === 2) controller.abort('operator stopped preview');
        try {
          if (signal.aborted) {
            const error = new Error(String(signal.reason));
            error.name = 'AbortError';
            throw error;
          }
          return 'unexpected';
        } finally {
          settled += 1;
        }
      },
      controller.signal
    );

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(admitted).toBe(2);
    expect(settled).toBe(2);
  });

  it('limits simultaneous weighted work without serializing smaller items', async () => {
    let activeWeight = 0;
    let peakWeight = 0;
    let peakWorkers = 0;
    let activeWorkers = 0;
    const pool = new AdaptiveWorkPool({
      maxConcurrency: 4,
      availableParallelism: () => 20,
      readCpuTimes: lowCpuTimes,
      sampleIntervalMs: 1,
      wait: async () => undefined,
    });

    const results = await pool.mapOrdered(
      [6, 6, 4, 4],
      async (weight) => {
        activeWeight += weight;
        activeWorkers += 1;
        peakWeight = Math.max(peakWeight, activeWeight);
        peakWorkers = Math.max(peakWorkers, activeWorkers);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeWeight -= weight;
        activeWorkers -= 1;
        return weight;
      },
      undefined,
      undefined,
      { maxInFlightWeight: 10, weight: (value) => value }
    );

    expect(results).toEqual([6, 6, 4, 4]);
    expect(peakWeight).toBeLessThanOrEqual(10);
    expect(peakWorkers).toBeGreaterThan(1);
  });

  it('rejects invalid resource limits instead of silently oversubscribing', () => {
    expect(() => new AdaptiveWorkPool({ cpuCeiling: 1 })).toThrow(/cpuCeiling/i);
    expect(() => new AdaptiveWorkPool({ concurrencyFraction: 0 })).toThrow(/concurrencyFraction/i);
    expect(() => new AdaptiveWorkPool({ maxConcurrency: 0 })).toThrow(/maxConcurrency/i);
  });
});
