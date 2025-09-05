/**
 * Core Processing Engine - Main orchestrator for media file processing
 *
 * This replaces the monolithic Python scripts with a modern, modular architecture
 * that provides parallel processing, error recovery, and progress tracking.
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as fsSync from 'fs';
import { v4 as uuidv4 } from 'uuid';

import {
  MediaFile,
  ProcessingJob,
  ProcessingOptions,
  JobStatus,
  ProcessingPhase,
  ProcessingStatistics,
  ProcessingStatus,
  MediaType,
  CorruptionLevel,
} from '@shared/types/media';
import { PROCESSING_LIMITS, ERROR_CODES } from '@shared/constants/index';

import { Logger } from '../utils/Logger';
import { MetadataExtractor } from './MetadataExtractor';
import { FileOrganizer } from './FileOrganizer';
import { CorruptionDetector } from './CorruptionDetector';
import { FileDiscovery } from './FileDiscovery';
import { DatabaseManager, JobRecord } from '../services/DatabaseManager';
import { ConfigManager } from '../services/ConfigManager';
import { JobQueue, Job } from '../utils/JobQueue';
import { PerformanceMonitor } from '../utils/PerformanceMonitor';

interface WorkerMessage {
  type: 'progress' | 'completed' | 'error' | 'file-processed' | 'ready';
  jobId: string;
  data: Record<string, unknown>;
}

export class ProcessingEngine extends EventEmitter {
  private static instance: ProcessingEngine;
  private logger: Logger;
  private metadataExtractor: MetadataExtractor;
  private fileOrganizer: FileOrganizer;
  private corruptionDetector: CorruptionDetector;
  private fileDiscovery: FileDiscovery;
  private databaseManager: DatabaseManager;
  private configManager: ConfigManager;
  private jobQueue: JobQueue;
  private performanceMonitor: PerformanceMonitor;

  private workers: Worker[] = [];
  private activeJobs: Map<string, ProcessingJob> = new Map();
  private jobStatistics: Map<string, ProcessingStatistics> = new Map();
  private workerRestartCounts: Map<number, number> = new Map();
  private static readonly MAX_WORKER_RESTARTS = 3;
  private isInitialized = false;
  private isShuttingDown = false;

  private constructor(databaseManager: DatabaseManager, configManager: ConfigManager) {
    super();

    this.logger = Logger.getInstance();
    this.databaseManager = databaseManager;
    this.configManager = configManager;
    this.jobQueue = new JobQueue();
    this.performanceMonitor = new PerformanceMonitor();

    // Initialize core components
    this.metadataExtractor = new MetadataExtractor();
    this.fileOrganizer = new FileOrganizer();
    this.corruptionDetector = new CorruptionDetector();
    this.fileDiscovery = new FileDiscovery();

    this.initialize();
  }

  static getInstance(): ProcessingEngine {
    if (!ProcessingEngine.instance) {
      const databaseManager = DatabaseManager.getInstance();
      const configManager = ConfigManager.getInstance();
      ProcessingEngine.instance = new ProcessingEngine(databaseManager, configManager);
    }
    return ProcessingEngine.instance;
  }

  static createInstance(
    databaseManager: DatabaseManager,
    configManager: ConfigManager
  ): ProcessingEngine {
    ProcessingEngine.instance = new ProcessingEngine(databaseManager, configManager);
    return ProcessingEngine.instance;
  }

  /**
   * Initialize the processing engine
   */
  private async initialize(): Promise<void> {
    try {
      this.logger.info('Initializing ProcessingEngine...');

      // Initialize worker pool
      await this.initializeWorkers();

      // Setup event handlers
      this.setupEventHandlers();

      // Start performance monitoring
      this.performanceMonitor.start();

      this.isInitialized = true;
      this.logger.info('ProcessingEngine initialized successfully', {
        workerCount: this.workers.length,
      });
    } catch (error) {
      this.logger.error('Failed to initialize ProcessingEngine', { error });
      throw error;
    }
  }

  /**
   * Optimize core usage based on system capabilities.
   * Ported from legacy optimize_core_usage().
   *
   * Returns: { numWorkers, filesPerWorker, batchSize }
   */
  private optimizeCoreUsage(): { numWorkers: number; filesPerWorker: number; batchSize: number } {
    const availableCores = os.cpus().length;

    let numWorkers: number;
    let filesPerWorker: number;
    let batchSize: number;

    if (availableCores >= 12) {
      numWorkers = 6;
      filesPerWorker = 50;
      batchSize = 10;
    } else if (availableCores >= 8) {
      numWorkers = 5;
      filesPerWorker = 40;
      batchSize = 8;
    } else if (availableCores >= 4) {
      numWorkers = 4;
      filesPerWorker = 30;
      batchSize = 5;
    } else {
      numWorkers = 2;
      filesPerWorker = 20;
      batchSize = 3;
    }

    // Enforce limits (matches legacy)
    numWorkers = Math.min(numWorkers, PROCESSING_LIMITS.MAX_WORKER_COUNT);
    batchSize = Math.min(batchSize, PROCESSING_LIMITS.MAX_BATCH_SIZE);

    this.logger.info(
      `Core optimization: ${availableCores} cores available, using ${numWorkers} workers with batch size ${batchSize}`
    );

    return { numWorkers, filesPerWorker, batchSize };
  }

  /**
   * Initialize worker thread pool
   */
  private async initializeWorkers(): Promise<void> {
    const { numWorkers } = this.optimizeCoreUsage();
    const workerCount = numWorkers;
    const workerPath = path.join(__dirname, '../workers/ProcessingWorker.js');

    const workerExists = fsSync.existsSync(workerPath);
    if (!workerExists) {
      this.logger.warn(`Worker file not found at ${workerPath}, running in single-thread mode`);
      return;
    }

    this.logger.info(`Creating ${workerCount} worker threads...`);

    for (let i = 0; i < workerCount; i++) {
      try {
        const worker = new Worker(workerPath);

        worker.on('message', (message: WorkerMessage) => {
          this.handleWorkerMessage(worker, message);
        });

        worker.on('error', (error) => {
          this.logger.error('Worker error', { workerId: i, error });
          this.emit('worker-error', { worker, error });
          this.restartWorker(worker, i);
        });

        worker.on('exit', (code) => {
          if (code !== 0 && !this.isShuttingDown) {
            this.logger.warn('Worker exited unexpectedly', { workerId: i, code });
            this.restartWorker(worker, i);
          }
        });

        this.workers.push(worker);
      } catch (error) {
        this.logger.error('Failed to create worker', { workerId: i, error });
      }
    }

    this.logger.info(`Created ${this.workers.length} worker threads`);
  }

  /**
   * Restart a failed worker
   */
  private async restartWorker(failedWorker: Worker, index: number): Promise<void> {
    const restartCount = (this.workerRestartCounts.get(index) || 0) + 1;
    this.workerRestartCounts.set(index, restartCount);

    if (restartCount > ProcessingEngine.MAX_WORKER_RESTARTS) {
      this.logger.error(
        `Worker ${index} exceeded max restarts (${ProcessingEngine.MAX_WORKER_RESTARTS}), marking as dead`
      );
      try {
        await failedWorker.terminate();
      } catch {
        // Ignore termination errors for dead workers
      }
      this.emit('worker-health', { workerId: index, status: 'dead', restarts: restartCount });
      return;
    }

    try {
      const workerPath = path.join(__dirname, '../workers/ProcessingWorker.js');
      const newWorker = new Worker(workerPath);

      // Setup event handlers for new worker
      newWorker.on('message', (message: WorkerMessage) => {
        this.handleWorkerMessage(newWorker, message);
      });

      newWorker.on('error', (error) => {
        this.logger.error('Restarted worker error', { workerId: index, error });
        this.emit('worker-error', { worker: newWorker, error });
      });

      // Replace the failed worker
      this.workers[index] = newWorker;

      // Terminate the failed worker
      await failedWorker.terminate();

      this.logger.info('Worker restarted successfully', {
        workerId: index,
        restartCount,
      });
    } catch (error) {
      this.logger.error('Failed to restart worker', { workerId: index, error });
    }
  }

  /**
   * Get health status of all workers
   */
  public getWorkerHealth(): Array<{ id: number; status: string; restarts: number }> {
    return this.workers.map((worker, i) => ({
      id: i,
      status:
        (this.workerRestartCounts.get(i) || 0) > ProcessingEngine.MAX_WORKER_RESTARTS
          ? 'dead'
          : 'alive',
      restarts: this.workerRestartCounts.get(i) || 0,
    }));
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Job queue events
    this.jobQueue.on('job-started', (job: ProcessingJob) => {
      this.emit('job-started', job);
    });

    this.jobQueue.on('job-completed', (job: ProcessingJob) => {
      this.emit('job-completed', job);
    });

    this.jobQueue.on('job-failed', (job: ProcessingJob, error: Error) => {
      this.emit('job-failed', job, error);
    });
  }

  /**
   * Create a new processing job
   */
  public async createJob(
    name: string,
    sourcePaths: string[],
    destinationPath: string,
    options: ProcessingOptions
  ): Promise<ProcessingJob> {
    if (!this.isInitialized) {
      throw new Error('ProcessingEngine not initialized');
    }

    const jobId = uuidv4();
    const now = new Date();

    const job: ProcessingJob = {
      id: jobId,
      name,
      sourcePaths,
      destinationPath,
      options,
      status: JobStatus.CREATED,
      progress: {
        phase: ProcessingPhase.DISCOVERY,
        filesProcessed: 0,
        totalFiles: 0,
        bytesProcessed: 0,
        totalBytes: 0,
        percentage: 0,
      },
      files: [],
      statistics: this.createInitialStatistics(),
      createdAt: now,
    };

    // Validate job parameters
    await this.validateJob(job);

    // Save job to database
    await this.databaseManager.saveJob(job);

    // Track as active
    this.activeJobs.set(jobId, job);

    this.logger.info('Processing job created', {
      jobId,
      name,
      sourcePaths: sourcePaths.length,
      destinationPath,
    });

    return job;
  }

  /**
   * Map database status to JobStatus
   */
  private mapDatabaseStatusToJobStatus(status: string): JobStatus {
    switch (status) {
      case 'pending':
        return JobStatus.QUEUED;
      case 'processing':
        return JobStatus.PROCESSING;
      case 'completed':
        return JobStatus.COMPLETED;
      case 'failed':
        return JobStatus.FAILED;
      default:
        return JobStatus.CREATED;
    }
  }

  /**
   * Convert JobRecord from database to ProcessingJob
   */
  private async convertJobRecordToProcessingJob(jobRecord: JobRecord): Promise<ProcessingJob> {
    const metadata = jobRecord.metadata ? JSON.parse(jobRecord.metadata) : {};

    return {
      id: metadata.jobId || jobRecord.id?.toString() || '',
      name: jobRecord.type,
      sourcePaths: metadata.sourcePaths || [],
      destinationPath: metadata.destinationPath || '',
      options: metadata.options || {},
      status: this.mapDatabaseStatusToJobStatus(jobRecord.status),
      progress: {
        phase: ProcessingPhase.DISCOVERY,
        filesProcessed: jobRecord.filesProcessed,
        totalFiles: jobRecord.totalFiles,
        bytesProcessed: 0,
        totalBytes: 0,
        percentage: 0,
      },
      files: [],
      statistics: metadata.statistics || this.createInitialStatistics(),
      createdAt: new Date(jobRecord.startTime),
      startedAt: jobRecord.startTime ? new Date(jobRecord.startTime) : undefined,
      completedAt: jobRecord.endTime ? new Date(jobRecord.endTime) : undefined,
    };
  }

  /**
   * Map JobStatus to database status
   */
  private mapJobStatusToDatabaseStatus(
    status: JobStatus
  ): 'pending' | 'processing' | 'completed' | 'failed' {
    switch (status) {
      case JobStatus.CREATED:
      case JobStatus.QUEUED:
        return 'pending';
      case JobStatus.PROCESSING:
        return 'processing';
      case JobStatus.COMPLETED:
        return 'completed';
      case JobStatus.FAILED:
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * Start processing a job
   */
  public async startJob(jobId: string): Promise<void> {
    const jobRecord = await this.databaseManager.getJobByUuid(jobId);
    if (!jobRecord) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (jobRecord.status !== 'pending') {
      throw new Error(`Job cannot be started from status: ${jobRecord.status}`);
    }

    // Convert JobRecord back to ProcessingJob
    const job = await this.convertJobRecordToProcessingJob(jobRecord);

    // Add job to active jobs
    this.activeJobs.set(jobId, job);

    // Queue the job for processing - convert ProcessingJob to Job
    const queueJob: Job = {
      id: job.id,
      type: 'processing',
      data: job,
      priority: 1,
      createdAt: job.createdAt,
      status: 'pending',
    };
    await this.jobQueue.add(queueJob);

    this.logger.info('Job queued for processing', { jobId, name: job.name });
  }

  /**
   * Process a job through all phases
   */
  public async processJob(job: ProcessingJob): Promise<void> {
    try {
      this.logger.info('Starting job processing', { jobId: job.id, name: job.name });

      job.status = JobStatus.PROCESSING;
      job.startedAt = new Date();

      await this.updateJobInDatabase(job);
      this.emit('job-started', job);

      // Phase 1: File Discovery
      await this.executePhase(job, ProcessingPhase.DISCOVERY);
      const discoveredFiles = await this.discoverFiles(job);
      job.files = discoveredFiles;

      // Phase 2: Metadata Extraction
      await this.executePhase(job, ProcessingPhase.METADATA_EXTRACTION);
      await this.extractMetadataParallel(job);

      // Phase 3: Corruption Detection (if enabled)
      if (job.options.enableCorruptionDetection) {
        await this.executePhase(job, ProcessingPhase.CORRUPTION_DETECTION);
        await this.detectCorruptionParallel(job);
      }

      // Phase 4: File Organization
      await this.executePhase(job, ProcessingPhase.ORGANIZATION);
      await this.organizeFilesParallel(job);

      // Phase 5: Final Sweep - re-scan source for remaining files (legacy perform_final_sweep)
      await this.executePhase(job, ProcessingPhase.VERIFICATION);
      await this.performFinalSweep(job);

      // Phase 6: Cleanup - remove empty directories + temp files (legacy remove_empty_directories)
      await this.executePhase(job, ProcessingPhase.CLEANUP);
      await this.cleanupAfterProcessing(job);

      // Complete the job
      job.status = JobStatus.COMPLETED;
      job.completedAt = new Date();
      job.progress.phase = ProcessingPhase.COMPLETED;
      job.progress.percentage = 100;

      await this.updateJobInDatabase(job);
      this.activeJobs.delete(job.id);

      this.logger.info('Job completed successfully', {
        jobId: job.id,
        duration: Date.now() - job.startedAt!.getTime(),
        filesProcessed: job.statistics.processedFiles,
      });

      this.emit('job-completed', job);
    } catch (error) {
      this.logger.error('Job processing failed', { jobId: job.id, error });

      job.status = JobStatus.FAILED;
      job.completedAt = new Date();

      await this.updateJobInDatabase(job);
      this.activeJobs.delete(job.id);

      this.emit('job-failed', job, error);
      throw error;
    }
  }

  /**
   * Execute a processing phase
   */
  private async executePhase(job: ProcessingJob, phase: ProcessingPhase): Promise<void> {
    this.logger.info(`Starting phase: ${phase}`, { jobId: job.id });

    job.progress.phase = phase;
    await this.updateJobInDatabase(job);

    this.emit('job-phase-started', { jobId: job.id, phase });
  }

  /**
   * Discover files in source paths
   */
  private async discoverFiles(job: ProcessingJob): Promise<MediaFile[]> {
    const files: MediaFile[] = [];

    for (const sourcePath of job.sourcePaths) {
      const discoveredPaths = await this.fileDiscovery.discover(sourcePath, {
        recursive: true,
        extensions: job.options.supportedFormats,
        maxDepth: 50,
        excludeOutputDirs: true, // Legacy: skip 'output' directories
      });

      // Create MediaFile objects with file size from stat
      for (const filePath of discoveredPaths) {
        try {
          const stat = await fs.stat(filePath);
          files.push({
            path: filePath,
            size: stat.size,
          } as MediaFile);
        } catch {
          // Skip files we can't stat
          files.push({ path: filePath, size: 0 } as MediaFile);
        }
      }
    }

    // Update statistics
    job.statistics.totalFiles = files.length;
    job.statistics.totalSize = files.reduce((sum, file) => sum + (file.size || 0), 0);
    job.progress.totalFiles = files.length;
    job.progress.totalBytes = job.statistics.totalSize;

    this.logger.info('File discovery completed', {
      jobId: job.id,
      filesFound: files.length,
      totalSize: job.statistics.totalSize,
    });

    return files;
  }

  /**
   * Extract metadata from files using parallel processing
   */
  private async extractMetadataParallel(job: ProcessingJob): Promise<void> {
    const { batchSize: optimizedBatchSize } = this.optimizeCoreUsage();
    const batchSize = job.options.batchSize || optimizedBatchSize;
    const batches = this.createBatches(job.files, batchSize);

    for (const batch of batches) {
      const tasks: Promise<void>[] = batch.map((file) => this.processFileMetadata(file, job));

      await Promise.all(tasks);

      // Update progress
      job.progress.filesProcessed += batch.length;
      job.progress.percentage = (job.progress.filesProcessed / job.progress.totalFiles) * 100;

      await this.updateJobProgress(job);

      if (job.status === JobStatus.CANCELLED) {
        break;
      }
    }
  }

  /**
   * Process metadata for a single file
   */
  private async processFileMetadata(file: MediaFile, job: ProcessingJob): Promise<void> {
    try {
      // Check cache before extraction
      try {
        const stat = await fs.stat(file.path);
        const cached = await this.databaseManager.getCachedFile(file.path);
        if (
          cached &&
          cached.lastModified === stat.mtime.toISOString() &&
          cached.size === stat.size
        ) {
          file.metadata = { ...file.metadata, ...JSON.parse(cached.metadata ?? '{}') };
          file.processingStatus = ProcessingStatus.COMPLETED;
          job.statistics.processedFiles++;
          job.statistics.skippedFiles++;
          return; // Skip extraction, use cache
        }
      } catch {
        // Cache miss or error, proceed with extraction
      }

      file.processingStatus = ProcessingStatus.PROCESSING;

      const metadata = await this.metadataExtractor.extractMetadata(file.path, file.type);
      file.metadata = { ...file.metadata, ...metadata };

      file.processingStatus = ProcessingStatus.COMPLETED;
      job.statistics.processedFiles++;

      // Write to cache after successful extraction
      try {
        const stat = await fs.stat(file.path);
        await this.databaseManager.cacheFile(
          file.path,
          file.hash || '',
          JSON.stringify(file.metadata),
          stat.mtime.toISOString(),
          stat.size
        );
      } catch {
        // Cache write failure is non-fatal
      }
    } catch (error) {
      this.logger.error('Metadata extraction failed', { filePath: file.path, error });

      file.processingStatus = ProcessingStatus.FAILED;
      file.error = {
        code: ERROR_CODES.METADATA_EXTRACTION_FAILED,
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
        recoverable: true,
      };

      job.statistics.failedFiles++;
    }
  }

  /**
   * Detect corruption in files using parallel processing
   */
  private async detectCorruptionParallel(job: ProcessingJob): Promise<void> {
    const filesToCheck = job.files.filter(
      (file) => file.type === MediaType.VIDEO || file.type === MediaType.IMAGE
    );

    const batchSize = Math.max(1, Math.floor(job.options.batchSize / 2)); // Smaller batches for intensive operation
    const batches = this.createBatches(filesToCheck, batchSize);

    for (const batch of batches) {
      const tasks: Promise<void>[] = batch.map((file) => this.processFileCorruption(file, job));

      await Promise.all(tasks);

      if (job.status === JobStatus.CANCELLED) {
        break;
      }
    }
  }

  /**
   * Process corruption detection for a single file
   */
  private async processFileCorruption(file: MediaFile, job: ProcessingJob): Promise<void> {
    try {
      const corruptionReport = await this.corruptionDetector.analyzeFile(file.path, file.type);
      file.corruption = corruptionReport;

      if (corruptionReport.corruptionLevel !== CorruptionLevel.NONE) {
        job.statistics.corruptedFiles++;

        // Quarantine if severe corruption
        if (
          corruptionReport.corruptionLevel === CorruptionLevel.SEVERE ||
          corruptionReport.corruptionLevel === CorruptionLevel.CATASTROPHIC
        ) {
          file.processingStatus = ProcessingStatus.QUARANTINED;
          job.statistics.quarantinedFiles++;
        }
      }
    } catch (error) {
      this.logger.error('Corruption detection failed', { filePath: file.path, error });

      file.error = {
        code: ERROR_CODES.CORRUPTION_DETECTION_FAILED,
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
        recoverable: true,
      };
    }
  }

  /**
   * Organize files using parallel processing
   */
  private async organizeFilesParallel(job: ProcessingJob): Promise<void> {
    const filesToOrganize = job.files.filter(
      (file) =>
        file.processingStatus !== ProcessingStatus.QUARANTINED &&
        file.processingStatus !== ProcessingStatus.FAILED
    );

    const { batchSize: optimizedBatchSize } = this.optimizeCoreUsage();
    const batchSize = job.options.batchSize || optimizedBatchSize;
    const batches = this.createBatches(filesToOrganize, batchSize);

    for (const batch of batches) {
      const tasks: Promise<void>[] = batch.map((file) => this.organizeFile(file, job));

      await Promise.all(tasks);

      if (job.status === JobStatus.CANCELLED) {
        break;
      }
    }
  }

  /**
   * Organize a single file
   */
  private async organizeFile(file: MediaFile, job: ProcessingJob): Promise<void> {
    try {
      const result = await this.fileOrganizer.organizeFile(file, job.destinationPath, job.options);

      if (result.success) {
        file.processingStatus = ProcessingStatus.COMPLETED;
        job.statistics.processedSize += file.size;
      } else {
        throw new Error(result.error || 'Organization failed');
      }
    } catch (error) {
      this.logger.error('File organization failed', { filePath: file.path, error });

      file.processingStatus = ProcessingStatus.FAILED;
      file.error = {
        code: ERROR_CODES.FILE_ORGANIZATION_FAILED,
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
        recoverable: true,
      };

      job.statistics.failedFiles++;
    }
  }

  /**
   * Perform final sweep to catch any remaining files.
   * Ported from legacy perform_final_sweep().
   *
   * Re-scans the source directories and processes any files that were
   * missed or added during the initial processing pass.
   */
  private async performFinalSweep(job: ProcessingJob): Promise<void> {
    this.logger.info('Performing final sweep...', { jobId: job.id });
    this.emit('job-phase-info', { jobId: job.id, message: 'Performing final sweep...' });

    const startTime = Date.now();
    let finalSuccessCount = 0;
    let finalTotalCount = 0;

    for (const sourcePath of job.sourcePaths) {
      if (job.status === JobStatus.CANCELLED) break;

      try {
        const remainingPaths = await this.fileDiscovery.discover(sourcePath, {
          recursive: true,
          extensions: job.options.supportedFormats,
          maxDepth: 50,
        });

        if (remainingPaths.length === 0) {
          this.logger.info('No remaining files found in final sweep', { sourcePath });
          continue;
        }

        this.logger.info(`Final sweep found ${remainingPaths.length} remaining files`, {
          sourcePath,
        });
        finalTotalCount += remainingPaths.length;

        // Convert to MediaFile objects
        const remainingFiles: MediaFile[] = remainingPaths.map((filePath) => ({
          path: filePath,
        })) as MediaFile[];

        // Process remaining files through the same pipeline
        const { batchSize } = this.optimizeCoreUsage();
        const batches = this.createBatches(remainingFiles, batchSize);

        for (const batch of batches) {
          if ((job.status as JobStatus) === JobStatus.CANCELLED) break;

          // Extract metadata
          await Promise.all(batch.map((file) => this.processFileMetadata(file, job)));

          // Corruption detection
          if (job.options.enableCorruptionDetection) {
            const videoFiles = batch.filter(
              (file) => file.type === MediaType.VIDEO || file.type === MediaType.IMAGE
            );
            await Promise.all(videoFiles.map((file) => this.processFileCorruption(file, job)));
          }

          // Organize
          const filesToOrganize = batch.filter(
            (file) =>
              file.processingStatus !== ProcessingStatus.QUARANTINED &&
              file.processingStatus !== ProcessingStatus.FAILED
          );
          await Promise.all(filesToOrganize.map((file) => this.organizeFile(file, job)));

          finalSuccessCount += filesToOrganize.length;
        }
      } catch (error) {
        this.logger.error('Error during final sweep', { sourcePath, error });
      }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    this.logger.info('Final sweep complete', {
      jobId: job.id,
      finalSuccessCount,
      finalTotalCount,
      elapsed: `${elapsed.toFixed(1)}s`,
    });

    // Update final statistics
    job.statistics.duration = Date.now() - job.startedAt!.getTime();
    job.statistics.averageSpeed = job.statistics.processedFiles / (job.statistics.duration / 1000);
    job.statistics.errorRate =
      job.statistics.totalFiles > 0
        ? (job.statistics.failedFiles / job.statistics.totalFiles) * 100
        : 0;
  }

  /**
   * Cleanup after processing: remove empty directories + temp files.
   * Ported from legacy remove_empty_directories() call in main().
   */
  private async cleanupAfterProcessing(job: ProcessingJob): Promise<void> {
    this.logger.info('Cleaning up after processing...', { jobId: job.id });

    // Remove empty directories in source paths (legacy behavior)
    for (const sourcePath of job.sourcePaths) {
      try {
        const removedCount = await this.fileOrganizer.removeEmptyDirectories(sourcePath);
        if (removedCount > 0) {
          this.logger.info(`Removed ${removedCount} empty directories`, { sourcePath });
        }
      } catch (error) {
        this.logger.error('Error removing empty directories', { sourcePath, error });
      }
    }
  }

  /**
   * Handle messages from worker threads
   */
  private handleWorkerMessage(worker: Worker, message: WorkerMessage): void {
    const { type, jobId, data } = message;

    switch (type) {
      case 'progress':
        this.handleWorkerProgress(jobId, data);
        break;

      case 'file-processed':
        this.handleFileProcessed(jobId, data);
        break;

      case 'completed':
        this.handleWorkerCompleted(jobId, data);
        break;

      case 'error':
        this.handleWorkerError(jobId, data);
        break;

      case 'ready':
        this.logger.info('Worker ready', { workerId: data?.workerId });
        break;

      default:
        this.logger.warn('Unknown worker message type', { type, jobId });
    }
  }

  private handleWorkerProgress(jobId: string, _data: Record<string, unknown>): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      // Update job progress based on worker data
      this.updateJobProgress(job);
      this.emit('job-progress', job);
    }
  }

  private handleFileProcessed(jobId: string, data: Record<string, unknown>): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      // Update file processing status
      this.emit('file-processed', { jobId, file: data.file });
    }
  }

  private handleWorkerCompleted(jobId: string, data: Record<string, unknown>): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      this.logger.info('Worker completed task', { jobId, workerId: data.workerId });
    }
  }

  private handleWorkerError(jobId: string, data: Record<string, unknown>): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      this.logger.error('Worker reported error', { jobId, error: data.error });
      this.emit('job-error', { jobId, error: data.error });
    }
  }

  /**
   * Utility methods
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private createInitialStatistics(): ProcessingStatistics {
    return {
      totalFiles: 0,
      processedFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      quarantinedFiles: 0,
      duplicateFiles: 0,
      corruptedFiles: 0,
      totalSize: 0,
      processedSize: 0,
      duration: 0,
      averageSpeed: 0,
      errorRate: 0,
      imageFiles: 0,
      videoFiles: 0,
      audioFiles: 0,
      documentFiles: 0,
      artFiles: 0,
      unknownFiles: 0,
    };
  }

  private async updateJobInDatabase(job: ProcessingJob): Promise<void> {
    try {
      const updates: Partial<JobRecord> = {
        status: this.mapJobStatusToDatabaseStatus(job.status),
        filesProcessed: job.progress.filesProcessed,
        totalFiles: job.progress.totalFiles,
        endTime: job.completedAt?.toISOString(),
        metadata: JSON.stringify({
          jobId: job.id,
          sourcePaths: job.sourcePaths,
          destinationPath: job.destinationPath,
          options: job.options,
          statistics: job.statistics,
        }),
      };

      await this.databaseManager.updateJobByUuid(job.id, updates);
    } catch (error) {
      this.logger.error('Failed to update job in database', { jobId: job.id, error });
    }
  }

  private async updateJobProgress(job: ProcessingJob): Promise<void> {
    await this.updateJobInDatabase(job);
    this.emit('job-progress', job);
  }

  private async validateJob(job: ProcessingJob): Promise<void> {
    // Validate source paths exist
    for (const sourcePath of job.sourcePaths) {
      try {
        await fs.access(sourcePath);
      } catch {
        throw new Error(`Source path does not exist: ${sourcePath}`);
      }
    }

    // Validate destination path
    try {
      await fs.access(path.dirname(job.destinationPath));
    } catch {
      throw new Error(
        `Destination parent directory does not exist: ${path.dirname(job.destinationPath)}`
      );
    }
  }

  /**
   * Public API methods
   */
  public async pauseJob(jobId: string): Promise<void> {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    job.status = JobStatus.PAUSED;
    await this.updateJobInDatabase(job);

    this.logger.info('Job paused', { jobId });
    this.emit('job-paused', job);
  }

  public async resumeJob(jobId: string): Promise<void> {
    const job = await this.databaseManager.getJob(parseInt(jobId));
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== 'pending') {
      throw new Error(`Job cannot be resumed from status: ${job.status}`);
    }

    await this.startJob(jobId);
  }

  public async cancelJob(jobId: string): Promise<void> {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    job.status = JobStatus.CANCELLED;
    await this.updateJobInDatabase(job);

    this.activeJobs.delete(jobId);

    this.logger.info('Job cancelled', { jobId });
    this.emit('job-cancelled', job);
  }

  public async getJob(jobId: string): Promise<ProcessingJob | null> {
    const jobRecord = await this.databaseManager.getJob(parseInt(jobId));
    return jobRecord ? await this.convertJobRecordToProcessingJob(jobRecord) : null;
  }

  public async getJobs(): Promise<ProcessingJob[]> {
    const jobRecords = await this.databaseManager.getJobs();
    return await Promise.all(
      jobRecords.map((record) => this.convertJobRecordToProcessingJob(record))
    );
  }

  public hasActiveJobs(): boolean {
    return this.activeJobs.size > 0;
  }

  public async cancelAllJobs(): Promise<void> {
    const activeJobIds = Array.from(this.activeJobs.keys());

    for (const jobId of activeJobIds) {
      try {
        await this.cancelJob(jobId);
      } catch (error) {
        this.logger.error('Failed to cancel job', { jobId, error });
      }
    }
  }

  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down ProcessingEngine...');
    this.isShuttingDown = true;

    // Cancel all active jobs
    await this.cancelAllJobs();

    // Terminate all workers
    const terminatePromises = this.workers.map((worker) => worker.terminate());
    await Promise.all(terminatePromises);

    // Reset performance monitor
    this.performanceMonitor.reset();

    this.logger.info('ProcessingEngine shutdown complete');
  }
}
