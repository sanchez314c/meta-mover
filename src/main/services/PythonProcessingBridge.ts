/**
 * PythonProcessingBridge — Subprocess wrapper that spawns the Python media
 * organizer script and bridges its JSON stdout into Electron IPC events.
 *
 * Replaces the incomplete TypeScript ProcessingEngine with a proven Python
 * backend while keeping the exact same EventEmitter contract that IPCHandler
 * and the renderer already expect.
 */

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/Logger';

// --- JSON protocol types from the Python script ---

interface ProgressPayload {
  type: 'progress';
  phase: string;
  filesProcessed: number;
  totalFiles: number;
  percentage: number;
  corruptFiles: number;
  errors: number;
  currentFile: string;
}

interface CompletePayload {
  type: 'complete';
  totalProcessed: number;
  totalFound: number;
  totalElapsed: number;
  filesPerSecond: number;
  corruptFiles: number;
  errorFiles: number;
  finalSweepCount: number;
  interrupted: boolean;
}

interface ErrorPayload {
  type: 'error';
  message: string;
}

interface CancelledPayload {
  type: 'cancelled';
  reason: string;
}

type PythonMessage = ProgressPayload | CompletePayload | ErrorPayload | CancelledPayload;

// --- Bridge ---

export class PythonProcessingBridge extends EventEmitter {
  private static instance: PythonProcessingBridge;
  private logger: Logger;
  private activeProcess: ChildProcess | null = null;
  private activeJobId: string | null = null;
  private completedEmitted = false;

  private constructor() {
    super();
    this.logger = Logger.getInstance();
  }

  static getInstance(): PythonProcessingBridge {
    if (!PythonProcessingBridge.instance) {
      PythonProcessingBridge.instance = new PythonProcessingBridge();
    }
    return PythonProcessingBridge.instance;
  }

  hasActiveJob(): boolean {
    return this.activeProcess !== null;
  }

  /**
   * Check whether python3 and exiftool are available on the system.
   */
  static async checkDependencies(): Promise<{
    python: boolean;
    exiftool: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    const check = (cmd: string, args: string[]): Promise<boolean> =>
      new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
      });

    const python = await check('python3', ['--version']);
    if (!python) errors.push('Python 3 not found. Install from python.org or your package manager.');

    const exiftool = await check('exiftool', ['-ver']);
    if (!exiftool)
      errors.push(
        'exiftool not found. Install: sudo apt install libimage-exiftool-perl (Linux) or brew install exiftool (macOS).'
      );

    return { python, exiftool, errors };
  }

  /**
   * Locate the bundled Python script. Checks production path first (inside
   * app.asar resources), then development path (project root).
   */
  private locateScript(): string {
    const candidates = [
      // Production: electron-builder copies scripts/ via extraFiles
      path.join(process.resourcesPath || '', 'scripts', 'media_organizer.py'),
      // Development: project root
      path.join(app.getAppPath(), 'scripts', 'media_organizer.py'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    throw new Error(`Python script not found. Checked:\n  ${candidates.join('\n  ')}`);
  }

  /**
   * Spawn the Python media organizer and start processing.
   * Returns a job ID immediately; progress streams via events.
   */
  startJob(sourcePath: string, destPath: string): string {
    if (this.activeProcess) {
      throw new Error('A processing job is already running');
    }

    const jobId = uuidv4();
    this.activeJobId = jobId;
    this.completedEmitted = false;

    let scriptPath: string;
    try {
      scriptPath = this.locateScript();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Defer emission so the caller can register listeners first
      setImmediate(() => this.emit('job-failed', { id: jobId }, new Error(msg)));
      this.activeJobId = null;
      return jobId;
    }

    const args = [scriptPath, '--source', sourcePath, '--dest', destPath, '--headless', '--json-progress'];

    this.logger.info('Spawning Python media organizer', { scriptPath, sourcePath, destPath });

    const child = spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.activeProcess = child;

    // --- stdout: JSON-lines protocol ---
    let stdoutBuffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? ''; // keep incomplete trailing line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleLine(trimmed, jobId);
      }
    });

    // --- stderr: Python logger output → Electron logger ---
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(DEBUG|INFO|WARNING|ERROR|CRITICAL): (.+)$/);
        if (match) {
          const [, level, msg] = match;
          if (level === 'ERROR' || level === 'CRITICAL') this.logger.error(`[Python] ${msg}`);
          else if (level === 'WARNING') this.logger.warn(`[Python] ${msg}`);
          else this.logger.debug(`[Python] ${msg}`);
        } else {
          this.logger.debug(`[Python] ${trimmed}`);
        }
      }
    });

    // --- Process exit ---
    child.on('close', (code, signal) => {
      this.activeProcess = null;
      const closedJobId = this.activeJobId;
      this.activeJobId = null;

      this.logger.info('Python process exited', { code, signal, jobId: closedJobId });

      // If we already emitted complete/error from a JSON message, don't double-emit
      if (this.completedEmitted) return;

      if (code !== 0 && code !== null) {
        this.emit('job-failed', { id: closedJobId }, new Error(`Python process exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      this.activeProcess = null;
      this.activeJobId = null;
      this.logger.error('Failed to start Python process', { error: err });
      this.emit('job-failed', { id: jobId }, err);
    });

    return jobId;
  }

  /**
   * Parse a single stdout line from the Python script.
   */
  private handleLine(line: string, jobId: string): void {
    let msg: PythonMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      // Non-JSON line (startup banner text, etc.) — ignore
      this.logger.debug(`[Python stdout] ${line}`);
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'progress':
        this.emit('job-progress', {
          id: jobId,
          progress: {
            phase: msg.phase,
            filesProcessed: msg.filesProcessed,
            totalFiles: msg.totalFiles,
            percentage: msg.percentage >= 0 ? msg.percentage : 0,
            corruptFiles: msg.corruptFiles,
            errors: msg.errors,
            currentFile: msg.currentFile,
          },
        });
        break;

      case 'complete':
        this.completedEmitted = true;
        this.emit('job-completed', {
          id: jobId,
          statistics: {
            totalProcessed: msg.totalProcessed,
            totalFound: msg.totalFound,
            totalElapsed: msg.totalElapsed,
            filesPerSecond: msg.filesPerSecond,
            corruptFiles: msg.corruptFiles,
            errorFiles: msg.errorFiles,
            finalSweepCount: msg.finalSweepCount,
            interrupted: msg.interrupted,
          },
        });
        break;

      case 'error':
        this.completedEmitted = true;
        this.emit('job-failed', { id: jobId }, new Error(msg.message));
        break;

      case 'cancelled':
        this.completedEmitted = true;
        this.logger.info('Python confirmed cancellation', { jobId });
        break;
    }
  }

  /**
   * Cancel a running job by sending SIGTERM to the Python process.
   * The Python script's signal handler calls os._exit(1) immediately.
   */
  cancelJob(jobId: string): void {
    if (!this.activeProcess || this.activeJobId !== jobId) return;
    this.logger.info('Sending SIGTERM to Python process', { jobId });
    this.activeProcess.kill('SIGTERM');
  }

  /**
   * Graceful shutdown: SIGTERM → wait 3s → SIGKILL.
   */
  async shutdown(): Promise<void> {
    if (!this.activeProcess) return;

    this.activeProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.activeProcess?.kill('SIGKILL');
        resolve();
      }, 3000);
      this.activeProcess?.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.activeProcess = null;
    this.activeJobId = null;
  }
}
