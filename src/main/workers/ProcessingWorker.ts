/**
 * Processing Worker Thread
 *
 * Runs in a worker_threads context. Receives file processing tasks from
 * ProcessingEngine and executes them in parallel. Falls back gracefully
 * if imported modules aren't available.
 */

import { parentPort, workerData } from 'worker_threads';

if (!parentPort) {
  throw new Error('ProcessingWorker must be run as a worker thread');
}

// Worker task and message types (must match ProcessingEngine interfaces)
interface WorkerTask {
  id: string;
  jobId: string;
  type: 'extract-metadata' | 'detect-corruption' | 'organize-file';
  files: Array<{
    path: string;
    size?: number;
    type?: string;
    metadata?: Record<string, unknown>;
  }>;
  options: Record<string, unknown>;
  destinationPath?: string;
}

interface WorkerMessage {
  type: 'progress' | 'completed' | 'error' | 'file-processed' | 'ready';
  jobId: string;
  data: Record<string, unknown>;
}

function sendMessage(msg: WorkerMessage): void {
  parentPort!.postMessage(msg);
}

// Lazy-loaded service instances
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let metadataExtractor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let corruptionDetector: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fileOrganizer: any = null;

async function getMetadataExtractor() {
  if (!metadataExtractor) {
    const { MetadataExtractor } = await import('../core/MetadataExtractor');
    metadataExtractor = new MetadataExtractor();
  }
  return metadataExtractor;
}

async function getCorruptionDetector() {
  if (!corruptionDetector) {
    const { CorruptionDetector } = await import('../core/CorruptionDetector');
    corruptionDetector = new CorruptionDetector();
  }
  return corruptionDetector;
}

async function getFileOrganizer() {
  if (!fileOrganizer) {
    const { FileOrganizer } = await import('../core/FileOrganizer');
    fileOrganizer = new FileOrganizer();
  }
  return fileOrganizer;
}

async function handleTask(task: WorkerTask): Promise<void> {
  const { id, jobId, type, files, options, destinationPath } = task;

  try {
    switch (type) {
      case 'extract-metadata': {
        const extractor = await getMetadataExtractor();
        const results = [];
        for (const file of files) {
          try {
            const metadata = await extractor.extractMetadata(file.path, file.type);
            results.push({ path: file.path, metadata, success: true });
            sendMessage({
              type: 'file-processed',
              jobId,
              data: { taskId: id, file: file.path, metadata, success: true },
            });
          } catch (error) {
            results.push({
              path: file.path,
              error: error instanceof Error ? error.message : 'Unknown error',
              success: false,
            });
            sendMessage({
              type: 'file-processed',
              jobId,
              data: {
                taskId: id,
                file: file.path,
                error: error instanceof Error ? error.message : 'Unknown error',
                success: false,
              },
            });
          }
        }
        sendMessage({
          type: 'completed',
          jobId,
          data: { taskId: id, results },
        });
        break;
      }

      case 'detect-corruption': {
        const detector = await getCorruptionDetector();
        const results = [];
        for (const file of files) {
          try {
            const report = await detector.analyzeFile(file.path, file.type);
            results.push({ path: file.path, report, success: true });
            sendMessage({
              type: 'file-processed',
              jobId,
              data: { taskId: id, file: file.path, report, success: true },
            });
          } catch (error) {
            results.push({
              path: file.path,
              error: error instanceof Error ? error.message : 'Unknown error',
              success: false,
            });
            sendMessage({
              type: 'file-processed',
              jobId,
              data: {
                taskId: id,
                file: file.path,
                error: error instanceof Error ? error.message : 'Unknown error',
                success: false,
              },
            });
          }
        }
        sendMessage({
          type: 'completed',
          jobId,
          data: { taskId: id, results },
        });
        break;
      }

      case 'organize-file': {
        const organizer = await getFileOrganizer();
        const results = [];
        for (const file of files) {
          try {
            const result = await organizer.organizeFile(file, destinationPath, options);
            results.push({ path: file.path, result, success: result.success });
            sendMessage({
              type: 'file-processed',
              jobId,
              data: { taskId: id, file: file.path, result, success: result.success },
            });
          } catch (error) {
            results.push({
              path: file.path,
              error: error instanceof Error ? error.message : 'Unknown error',
              success: false,
            });
            sendMessage({
              type: 'file-processed',
              jobId,
              data: {
                taskId: id,
                file: file.path,
                error: error instanceof Error ? error.message : 'Unknown error',
                success: false,
              },
            });
          }
        }
        sendMessage({
          type: 'completed',
          jobId,
          data: { taskId: id, results },
        });
        break;
      }

      default:
        sendMessage({
          type: 'error',
          jobId,
          data: { taskId: id, error: `Unknown task type: ${type}` },
        });
    }
  } catch (error) {
    sendMessage({
      type: 'error',
      jobId,
      data: {
        taskId: id,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
}

// Signal readiness
sendMessage({ type: 'ready', jobId: '', data: { workerId: workerData?.workerId } });

// Listen for tasks
parentPort.on('message', (task: WorkerTask) => {
  handleTask(task).catch((error) => {
    sendMessage({
      type: 'error',
      jobId: task.jobId || '',
      data: { error: error instanceof Error ? error.message : 'Unknown error' },
    });
  });
});
