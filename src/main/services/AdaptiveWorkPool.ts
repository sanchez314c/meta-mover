import { availableParallelism, cpus } from 'os';

export interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

export interface AdaptiveWorkPoolOptions {
  cpuCeiling?: number;
  concurrencyFraction?: number;
  maxConcurrency?: number;
  sampleIntervalMs?: number;
  availableParallelism?: () => number;
  readCpuTimes?: () => CpuTimesSnapshot;
  wait?: (durationMs: number, signal: AbortSignal) => Promise<void>;
}

export interface WeightedWorkLimit<T> {
  maxInFlightWeight: number;
  weight(value: T, index: number): number;
}

const DEFAULT_CPU_CEILING = 0.8;
const DEFAULT_CONCURRENCY_FRACTION = 0.75;
const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_SAMPLE_INTERVAL_MS = 50;

function systemCpuTimes(): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function validateCpuTimes(snapshot: CpuTimesSnapshot): void {
  if (
    !Number.isFinite(snapshot.idle) ||
    !Number.isFinite(snapshot.total) ||
    snapshot.idle < 0 ||
    snapshot.total < snapshot.idle
  ) {
    throw new Error('CPU time sampler returned an invalid snapshot');
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'Parallel analysis cancelled'
  );
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortableWait(durationMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class CpuAdmissionGate {
  private previous: CpuTimesSnapshot;
  private probe?: Promise<number>;

  constructor(
    private readonly ceiling: number,
    private readonly sampleIntervalMs: number,
    private readonly readCpuTimes: () => CpuTimesSnapshot,
    private readonly wait: (durationMs: number, signal: AbortSignal) => Promise<void>
  ) {
    this.previous = this.readCpuTimes();
    validateCpuTimes(this.previous);
  }

  async waitForCapacity(signal: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const usage = await this.sample(signal);
      if (usage < this.ceiling) return;
    }
  }

  private async sample(signal: AbortSignal): Promise<number> {
    const activeProbe =
      this.probe ??
      (this.probe = (async () => {
        await this.wait(this.sampleIntervalMs, signal);
        throwIfAborted(signal);
        const current = this.readCpuTimes();
        validateCpuTimes(current);
        const idleDelta = current.idle - this.previous.idle;
        const totalDelta = current.total - this.previous.total;
        this.previous = current;
        if (idleDelta < 0 || totalDelta <= 0 || idleDelta > totalDelta) {
          throw new Error('CPU time sampler returned a non-monotonic snapshot');
        }
        return Math.max(0, Math.min(1, (totalDelta - idleDelta) / totalDelta));
      })());

    try {
      return await activeProbe;
    } finally {
      if (this.probe === activeProbe) this.probe = undefined;
    }
  }
}

class WeightedAdmissionGate {
  private activeWeight = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error('maxInFlightWeight must be a positive safe integer');
    }
  }

  async acquire(weight: number, signal: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(weight) || weight < 0 || weight > this.maximum) {
      throw new Error('Work weight must be a non-negative safe integer within the limit');
    }
    while (this.activeWeight + weight > this.maximum) {
      throwIfAborted(signal);
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', onAbort);
          this.waiters.delete(wake);
          resolve();
        };
        const onAbort = () => {
          this.waiters.delete(wake);
          reject(abortError(signal));
        };
        this.waiters.add(wake);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    throwIfAborted(signal);
    this.activeWeight += weight;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeWeight -= weight;
      for (const wake of [...this.waiters]) wake();
    };
  }
}

export class AdaptiveWorkPool {
  readonly maxConcurrency: number;

  private readonly cpuCeiling: number;
  private readonly sampleIntervalMs: number;
  private readonly readCpuTimes: () => CpuTimesSnapshot;
  private readonly wait: (durationMs: number, signal: AbortSignal) => Promise<void>;

  constructor(options: Readonly<AdaptiveWorkPoolOptions> = {}) {
    const cpuCeiling = options.cpuCeiling ?? DEFAULT_CPU_CEILING;
    const concurrencyFraction = options.concurrencyFraction ?? DEFAULT_CONCURRENCY_FRACTION;
    const maximum = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    const parallelism = (options.availableParallelism ?? availableParallelism)();
    if (!Number.isFinite(cpuCeiling) || cpuCeiling <= 0 || cpuCeiling >= 1) {
      throw new Error('cpuCeiling must be greater than zero and less than one');
    }
    if (
      !Number.isFinite(concurrencyFraction) ||
      concurrencyFraction <= 0 ||
      concurrencyFraction >= cpuCeiling
    ) {
      throw new Error('concurrencyFraction must be positive and below cpuCeiling');
    }
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new Error('maxConcurrency must be a positive safe integer');
    }
    if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs <= 0) {
      throw new Error('sampleIntervalMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(parallelism) || parallelism <= 0) {
      throw new Error('availableParallelism must return a positive safe integer');
    }
    this.cpuCeiling = cpuCeiling;
    this.maxConcurrency = Math.max(
      1,
      Math.min(maximum, Math.floor(parallelism * concurrencyFraction))
    );
    this.sampleIntervalMs = sampleIntervalMs;
    this.readCpuTimes = options.readCpuTimes ?? systemCpuTimes;
    this.wait = options.wait ?? abortableWait;
  }

  async mapOrdered<T, R>(
    values: readonly T[],
    task: (value: T, index: number, signal: AbortSignal) => Promise<R>,
    externalSignal?: AbortSignal,
    completed?: (value: R, index: number) => Promise<void> | void,
    weightedLimit?: Readonly<WeightedWorkLimit<T>>
  ): Promise<R[]> {
    if (!Array.isArray(values)) throw new Error('Parallel work values must be an array');
    if (externalSignal?.aborted) throw abortError(externalSignal);
    if (values.length === 0) return [];

    const controller = new AbortController();
    const relayAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', relayAbort, { once: true });
    const gate = new CpuAdmissionGate(
      this.cpuCeiling,
      this.sampleIntervalMs,
      this.readCpuTimes,
      this.wait
    );
    const weightedGate = weightedLimit
      ? new WeightedAdmissionGate(weightedLimit.maxInFlightWeight)
      : undefined;
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    let firstError: unknown;
    let failed = false;

    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        if (index >= values.length) return;
        nextIndex += 1;
        try {
          await gate.waitForCapacity(controller.signal);
          throwIfAborted(controller.signal);
          const weight = weightedLimit?.weight(values[index], index) ?? 0;
          const releaseWeight = weightedGate
            ? await weightedGate.acquire(weight, controller.signal)
            : () => undefined;
          let result: R;
          try {
            result = await task(values[index], index, controller.signal);
          } finally {
            releaseWeight();
          }
          results[index] = result;
          await completed?.(result, index);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
          if (!controller.signal.aborted) controller.abort(error);
          return;
        }
      }
    };

    try {
      const workerCount = Math.min(this.maxConcurrency, values.length);
      await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
      if (failed) throw firstError;
      if (controller.signal.aborted) throw abortError(controller.signal);
      return results;
    } finally {
      externalSignal?.removeEventListener('abort', relayAbort);
    }
  }
}
