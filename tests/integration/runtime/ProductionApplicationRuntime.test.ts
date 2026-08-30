import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { createProductionApplicationRuntime } from '../../../src/main/runtime/ProductionApplicationRuntime';
import { developmentBrokerLaunchTrustPolicy } from '../../../src/main/native/NativeFilesystemHelperClient';
import {
  ConflictPolicy,
  FolderStructure,
  OperationMode,
  ProcessingEvent,
  ProcessingEventKind,
  ProcessingResponseDTO,
  PreviewResultDTO,
  StartProcessingResultDTO,
} from '../../../src/shared/types/processing';

describe('ProductionApplicationRuntime integration', () => {
  jest.setTimeout(30_000);

  it('drives canonical IPC through metadata preview and native transactional copy', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-production-smoke-'));
    const sourceRoot = path.join(root, 'source');
    const destinationRoot = path.join(root, 'destination');
    const stateRoot = path.join(root, 'state');
    await Promise.all([mkdir(sourceRoot), mkdir(destinationRoot), mkdir(stateRoot)]);
    await chmod(stateRoot, 0o700);
    const sourcePath = path.join(sourceRoot, 'mixed-up-name.jpg');
    const contents = Buffer.from('media-ground-truth-through-canonical-runtime');
    await writeFile(sourcePath, contents);

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    let resolveTerminal!: (event: ProcessingEvent) => void;
    const terminal = new Promise<ProcessingEvent>((resolve) => {
      resolveTerminal = resolve;
    });
    const runtime = await createProductionApplicationRuntime({
      resourcesRoot: path.resolve('.build-tools'),
      configPath: path.join(stateRoot, 'config.json'),
      historyPath: path.join(stateRoot, 'history.jsonl'),
      evidenceRoot: path.join(stateRoot, 'evidence'),
      evidencePolicyVersion: 'date-resolution/1',
      platform: process.platform,
      architecture: process.arch,
      isPackaged: false,
      launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
      ipc: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      publishEvent: (event) => {
        if (
          event.kind === ProcessingEventKind.JOB_COMPLETED ||
          event.kind === ProcessingEventKind.JOB_FAILED ||
          event.kind === ProcessingEventKind.JOB_CANCELLED
        ) {
          resolveTerminal(event);
        }
      },
    });

    const invoke = <T>(channel: string, value?: unknown) =>
      Promise.resolve(handlers.get(channel)?.({}, value)) as Promise<ProcessingResponseDTO<T>>;

    let bodyFailure: unknown;
    try {
      const previewResponse = await invoke<PreviewResultDTO>('processing:preview', {
        sourcePaths: [sourceRoot],
        destinationPath: destinationRoot,
        options: {
          operation: OperationMode.COPY,
          conflictPolicy: ConflictPolicy.RENAME,
          folderStructure: FolderStructure.YEAR_MONTH,
          workerCount: 2,
          verifyIntegrity: true,
          writeMetadataDates: false,
        },
      });
      if (!previewResponse.success) {
        const plan = await runtime.components.planner.plan({
          sourcePaths: [sourceRoot],
          destinationPath: destinationRoot,
          options: {
            operation: OperationMode.COPY,
            conflictPolicy: ConflictPolicy.RENAME,
            folderStructure: FolderStructure.YEAR_MONTH,
            workerCount: 2,
            verifyIntegrity: true,
            writeMetadataDates: false,
          },
        });
        throw new Error(`${JSON.stringify(previewResponse)}\nPLAN=${JSON.stringify(plan)}`);
      }
      expect(previewResponse.data?.summary).toMatchObject({ totalFiles: 1, copyFiles: 1 });
      const targetPath = previewResponse.data?.rows?.[0]?.targetPath;
      expect(targetPath).toEqual(expect.any(String));

      const startResponse = await invoke<StartProcessingResultDTO>('processing:start', {
        previewId: previewResponse.data!.previewId,
        acknowledgeDestructiveOperation: false,
      });
      expect(startResponse.success).toBe(true);
      expect((await terminal).kind).toBe(ProcessingEventKind.JOB_COMPLETED);
      expect(await readFile(targetPath!, 'utf8')).toBe(contents.toString('utf8'));
      expect(await readFile(sourcePath, 'utf8')).toBe(contents.toString('utf8'));
    } catch (error) {
      bodyFailure = error;
      throw error;
    } finally {
      try {
        await runtime.shutdown();
      } catch (error) {
        if (bodyFailure === undefined) throw error;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
