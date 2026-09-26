import { ChildProcess, SpawnOptions } from 'child_process';
import { FileHandle, open } from 'fs/promises';

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_ERROR = 64 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

interface Request {
  path: string;
  signal?: AbortSignal;
  resolve: (value: Buffer) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

interface Worker {
  child: ChildProcess;
  busy: boolean;
  failed: boolean;
  stopPromise?: Promise<void>;
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error(
    typeof signal?.reason === 'string' ? signal.reason : 'Metadata extraction cancelled'
  );
  error.name = 'AbortError';
  return error;
}

/** One request at a time per ExifTool process. Framing is never shared between requests. */
export class ExifToolStayOpenPool {
  private readonly workers = new Set<Worker>();
  private readonly queue: Request[] = [];
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly spawnProcess: SpawnProcess,
    private readonly executable: string,
    private readonly prefix: readonly string[],
    private readonly options: SpawnOptions,
    private readonly platform: NodeJS.Platform,
    private readonly size = 16
  ) {}

  read(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    if (this.closed) return Promise.reject(new Error('BundledExifToolAdapter is closed'));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const request: Request = { path: filePath, signal, resolve, reject };
      const onAbort = () => {
        const index = this.queue.indexOf(request);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        reject(abortError(signal));
      };
      request.onAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(request);
      this.drain();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.queue.splice(0)) {
      request.signal?.removeEventListener('abort', request.onAbort!);
      request.reject(new Error('BundledExifToolAdapter is closed'));
    }
    await Promise.all([...this.workers].map((worker) => this.stop(worker)));
  }

  private drain(): void {
    while (!this.closed && this.queue.length) {
      let worker = [...this.workers].find((entry) => !entry.busy && !entry.failed);
      if (!worker) {
        if (this.workers.size >= this.size) return;
        let child: ChildProcess;
        try {
          child = this.spawnProcess(
            this.executable,
            [...this.prefix, '-stay_open', 'True', '-@', '-'],
            this.options
          );
        } catch (error) {
          const request = this.queue.shift()!;
          request.signal?.removeEventListener('abort', request.onAbort!);
          request.reject(error);
          continue;
        }
        worker = { child, busy: false, failed: false };
        const spawnedWorker = worker;
        this.workers.add(spawnedWorker);
        child.on('error', () => {
          spawnedWorker.failed = true;
          this.workers.delete(spawnedWorker);
          void this.stop(spawnedWorker);
          this.drain();
        });
        child.on('close', () => {
          spawnedWorker.failed = true;
          this.workers.delete(spawnedWorker);
          this.drain();
        });
      }
      const request = this.queue.shift()!;
      request.signal?.removeEventListener('abort', request.onAbort!);
      worker.busy = true;
      void this.execute(worker, request)
        .then(request.resolve, request.reject)
        .finally(() => {
          worker.busy = false;
          if (!this.closed) this.drain();
        });
    }
  }

  private async execute(worker: Worker, request: Request): Promise<Buffer> {
    let handle: FileHandle | undefined;
    try {
      if (request.signal?.aborted) throw abortError(request.signal);
      // The original pathname is never sent to ExifTool. Keep this descriptor open through
      // both response markers so a concurrent rename cannot retarget the metadata read.
      handle = await open(request.path, 'r');
      if (request.signal?.aborted) throw abortError(request.signal);
      if (this.closed || worker.failed)
        throw new Error('Bundled ExifTool worker closed before metadata read');
      const inputPath =
        this.platform === 'linux' ? `/proc/${process.pid}/fd/${handle.fd}` : request.path;
      return await this.exchange(worker, inputPath, request.signal);
    } catch (error) {
      // A failed open does not corrupt the worker protocol. Any failure after dispatch does.
      if (handle) await this.stop(worker);
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private exchange(worker: Worker, inputPath: string, signal?: AbortSignal): Promise<Buffer> {
    const id = ++this.nextId;
    const ready = Buffer.from(`{ready${id}}`);
    const statusPrefix = Buffer.from(`MMERR${id}:`);
    const child = worker.child;
    return new Promise<Buffer>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let done = false;
      let outReady: Buffer | undefined;
      let status: number | undefined;
      const timeout = setTimeout(
        () => fail(new Error('Bundled ExifTool metadata read timed out')),
        REQUEST_TIMEOUT_MS
      );
      timeout.unref?.();
      const clean = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        child.stdout?.off('data', onOut);
        child.stderr?.off('data', onErr);
        child.stdout?.off('error', fail);
        child.stderr?.off('error', fail);
        child.stdin?.off('error', fail);
        child.off('error', fail);
        child.off('close', onClose);
      };
      const fail = (error: unknown) => {
        if (done) return;
        done = true;
        clean();
        void this.stop(worker);
        reject(error);
      };
      const finish = () => {
        if (done || outReady === undefined || status === undefined) return;
        done = true;
        clean();
        if (status !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          reject(new Error(`Bundled ExifTool direct read failed with code ${status}: ${detail}`));
        } else {
          resolve(outReady);
        }
      };
      const onOut = (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_OUTPUT)
          return fail(new Error('Bundled ExifTool output exceeded 16 MiB'));
        stdout.push(Buffer.from(chunk));
        const combined = Buffer.concat(stdout);
        const suffix = Buffer.concat([Buffer.from('\n'), ready, Buffer.from('\r\n')]);
        const suffixLf = Buffer.concat([Buffer.from('\n'), ready, Buffer.from('\n')]);
        const actual = combined.subarray(-suffix.length).equals(suffix) ? suffix : suffixLf;
        if (!combined.subarray(-actual.length).equals(actual)) return;
        outReady = combined.subarray(0, -actual.length);
        finish();
      };
      const onErr = (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes > MAX_ERROR) return fail(new Error('Bundled ExifTool stderr exceeded 64 KiB'));
        stderr.push(Buffer.from(chunk));
        const combined = Buffer.concat(stderr);
        const text = combined.toString('utf8');
        const match = text.match(
          new RegExp(`(?:^|\\n)${statusPrefix.toString('utf8')}(\\d+)\\r?\\n$`)
        );
        if (!match) return;
        status = Number(match[1]);
        finish();
      };
      const onClose = () => fail(new Error('Bundled ExifTool worker exited during metadata read'));
      const onAbort = () => fail(abortError(signal));
      if (!child.stdin || !child.stdout || !child.stderr) {
        return fail(new Error('Bundled ExifTool worker stdio is unavailable'));
      }
      child.stdout?.on('data', onOut);
      child.stderr?.on('data', onErr);
      child.stdout?.on('error', fail);
      child.stderr?.on('error', fail);
      child.stdin?.on('error', fail);
      child.on('error', fail);
      child.on('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      // Argument file syntax forbids newlines in arguments; the generated descriptor path
      // contains only decimal digits and fixed ASCII. Original names never enter this frame.
      const command = [
        '-json',
        '-G1',
        '-a',
        '-s',
        '-echo4',
        `MMERR${id}:\${status}`,
        inputPath,
        `-execute${id}`,
        '',
      ].join('\n');
      child.stdin.write(command);
    });
  }

  private async stop(worker: Worker): Promise<void> {
    if (worker.stopPromise) return worker.stopPromise;
    worker.failed = true;
    this.workers.delete(worker);
    const child = worker.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    worker.stopPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(boundTimer);
        resolve();
      };
      const termTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 250);
      const boundTimer = setTimeout(finish, 2_000);
      termTimer.unref?.();
      boundTimer.unref?.();
      child.once('close', finish);
      child.kill('SIGTERM');
    });
    await worker.stopPromise;
  }
}
