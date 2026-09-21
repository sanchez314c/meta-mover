import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { copyFile, lstat, mkdir, opendir, realpath, rm } from 'fs/promises';
import path from 'path';

export interface GatherTestRunRequest {
  sourcePath: string;
  destinationPath?: string;
  fileCount: number;
}

export interface GatherTestRunResult {
  temporarySourcePath: string;
  copiedFiles: number;
  scannedFiles: number;
}

interface Candidate {
  absolutePath: string;
  relativePath: string;
}

export interface TestRunProgress {
  phase: 'scanning' | 'copying';
  scannedFiles: number;
  selectedFiles: number;
  copiedFiles: number;
  totalFiles: number | null;
  percentage: number | null;
  currentFile: string;
}

export class TestRunCorpusBuilder {
  private readonly ownedSources = new Set<string>();
  private activeAbortController: AbortController | null = null;

  constructor(
    private readonly fixedTemporaryRoot?: string,
    private readonly random: () => number = Math.random
  ) {}

  async gather(
    request: GatherTestRunRequest,
    progress: (event: TestRunProgress) => void = () => undefined
  ): Promise<GatherTestRunResult> {
    if (this.activeAbortController) throw new Error('A test run is already being gathered');
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    try {
      return await this.gatherOnce(request, progress, abortController.signal);
    } finally {
      if (this.activeAbortController === abortController) this.activeAbortController = null;
    }
  }

  cancel(): boolean {
    if (!this.activeAbortController) return false;
    this.activeAbortController.abort();
    return true;
  }

  private async gatherOnce(
    request: GatherTestRunRequest,
    progress: (event: TestRunProgress) => void,
    signal: AbortSignal
  ): Promise<GatherTestRunResult> {
    if (
      !Number.isSafeInteger(request.fileCount) ||
      request.fileCount < 1 ||
      request.fileCount > 15000
    )
      throw new Error('Test run fileCount must be an integer from 1 through 15000');
    if (
      !path.isAbsolute(request.sourcePath) ||
      path.normalize(request.sourcePath) !== request.sourcePath
    )
      throw new Error('Test run source path must be canonical and absolute');
    const visibleSourceStats = await lstat(request.sourcePath);
    if (visibleSourceStats.isSymbolicLink())
      throw new Error('Test run source must not be a symbolic link');
    const sourcePath = await realpath(request.sourcePath);
    const sourceStats = await lstat(sourcePath);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink())
      throw new Error('Test run source must be a real directory');
    const temporaryRoot = await this.temporaryRootFor(request, sourcePath);

    const candidates: Candidate[] = [];
    let scannedFiles = 0;
    for await (const candidate of this.walk(sourcePath, sourcePath)) {
      this.assertNotCancelled(signal);
      scannedFiles += 1;
      if (candidates.length < request.fileCount) candidates.push(candidate);
      else {
        const replacement = Math.floor(this.random() * scannedFiles);
        if (replacement < request.fileCount) candidates[replacement] = candidate;
      }
      if (scannedFiles === 1 || scannedFiles % 250 === 0) {
        progress({
          phase: 'scanning',
          scannedFiles,
          selectedFiles: candidates.length,
          copiedFiles: 0,
          totalFiles: null,
          percentage: null,
          currentFile: candidate.relativePath,
        });
      }
    }
    if (scannedFiles < request.fileCount)
      throw new Error(
        `Source contains ${scannedFiles} regular files; ${request.fileCount} are required`
      );

    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    const runRoot = path.join(temporaryRoot, `run-${Date.now()}-${randomUUID()}`);
    const temporarySourcePath = path.join(runRoot, 'source');
    await mkdir(temporarySourcePath, { recursive: true, mode: 0o700 });
    try {
      let copiedFiles = 0;
      let lastPublishedAt = 0;
      const directoryPromises = new Map<string, Promise<void>>();
      const ensureDirectory = (directory: string): Promise<void> => {
        const existing = directoryPromises.get(directory);
        if (existing) return existing;
        const created = mkdir(directory, { recursive: true, mode: 0o700 }).then(() => undefined);
        directoryPromises.set(directory, created);
        return created;
      };
      const workerResults = await Promise.allSettled(
        Array.from({ length: Math.min(8, candidates.length) }, async (_, worker) => {
          for (let index = worker; index < candidates.length; index += 8) {
            this.assertNotCancelled(signal);
            const candidate = candidates[index];
            const target = path.join(temporarySourcePath, candidate.relativePath);
            await ensureDirectory(path.dirname(target));
            await this.cloneFirstCopy(candidate.absolutePath, target);
            copiedFiles += 1;
            const now = Date.now();
            if (copiedFiles === request.fileCount || now - lastPublishedAt >= 100) {
              lastPublishedAt = now;
              progress({
                phase: 'copying',
                scannedFiles,
                selectedFiles: request.fileCount,
                copiedFiles,
                totalFiles: request.fileCount,
                percentage: (copiedFiles / request.fileCount) * 100,
                currentFile: candidate.relativePath,
              });
            }
          }
        })
      );
      const failedWorker = workerResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failedWorker) throw failedWorker.reason;
      this.ownedSources.add(temporarySourcePath);
      return { temporarySourcePath, copiedFiles, scannedFiles };
    } catch (error) {
      await rm(runRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async discard(temporarySourcePath: string): Promise<void> {
    const candidate = path.resolve(temporarySourcePath);
    if (path.basename(candidate) !== 'source' || !this.ownedSources.has(candidate))
      throw new Error('Test run cleanup path is not owned by META Mover');
    await rm(path.dirname(candidate), { recursive: true, force: true });
    this.ownedSources.delete(candidate);
  }

  async listRegularFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    for await (const candidate of this.walk(root, root)) files.push(candidate.absolutePath);
    return files;
  }

  private async *walk(root: string, directory: string): AsyncGenerator<Candidate> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && !/^META-Mover-Test-Run-/i.test(entry.name))
        yield* this.walk(root, absolutePath);
      else if (entry.isFile()) {
        yield { absolutePath, relativePath: path.relative(root, absolutePath) };
      }
    }
  }

  private async temporaryRootFor(
    request: GatherTestRunRequest,
    sourcePath: string
  ): Promise<string> {
    if (this.fixedTemporaryRoot) return path.resolve(this.fixedTemporaryRoot);
    if (!request.destinationPath || !path.isAbsolute(request.destinationPath))
      throw new Error('Test run destination path must be canonical and absolute');
    const destinationPath = await realpath(request.destinationPath);
    const temporaryRoot = path.join(path.dirname(destinationPath), '.meta-mover-test-runs');
    const relative = path.relative(sourcePath, temporaryRoot);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
      throw new Error('Test run temporary root must be outside the original source');
    return temporaryRoot;
  }

  private async cloneFirstCopy(source: string, target: string): Promise<void> {
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'EXDEV'].includes(String(code))) throw error;
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
  }

  private assertNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Test run gathering cancelled');
  }
}
