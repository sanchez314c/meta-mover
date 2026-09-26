import { configureStore } from '@reduxjs/toolkit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { ProcessingLauncher } from '../../../src/renderer/components/ProcessingLauncher';
import jobsReducer, {
  addJob,
  applyProcessingEvent,
  setActiveJob,
  updateJob,
} from '../../../src/renderer/store/slices/jobsSlice';
import type { DependencyHealthDTO, PreviewResultDTO } from '../../../src/shared/types/processing';

const config = {
  version: 3 as const,
  theme: 'system' as const,
  processing: {
    workerCount: 4,
    operation: 'copy' as const,
    verifyIntegrity: true as const,
    writeMetadataDates: false,
    testMode: false,
  },
  organization: {
    folderStructure: 'year/month' as const,
    conflictPolicy: 'rename' as const,
    appendScreenshotSuffix: false,
  },
};

const readyHealth: DependencyHealthDTO = {
  checkedAt: '2026-08-29T20:00:00.000Z',
  ready: true,
  capabilities: {
    preview: { available: true, blockers: [] },
    start: { available: true, blockers: [] },
    metadataWriteback: { available: false, blockers: ['Intentionally disabled'] },
  },
  dependencies: [],
};

function preview(operation: 'copy' | 'move' = 'copy'): PreviewResultDTO {
  return {
    jobId: 'job-1',
    previewId: 'preview-1',
    createdAt: '2026-08-29T20:00:00.000Z',
    request: {
      sourcePaths: ['/media/source'],
      destinationPath: '/media/destination',
      options: {
        operation,
        conflictPolicy: 'rename',
        folderStructure: 'year/month',
        workerCount: 4,
        verifyIntegrity: true,
        appendScreenshotSuffix: false,
        writeMetadataDates: false,
      },
    },
    effectiveOptions: {
      operation,
      conflictPolicy: 'rename',
      folderStructure: 'year/month',
      workerCount: 4,
      verifyIntegrity: true,
      appendScreenshotSuffix: false,
      writeMetadataDates: false,
    },
    summary: {
      totalFiles: 2,
      copyFiles: operation === 'copy' ? 1 : 0,
      moveFiles: operation === 'move' ? 1 : 0,
      skippedFiles: 1,
      renamedFiles: 0,
      overwrittenFiles: 0,
      unresolvedDates: 1,
      totalBytes: 1024,
    },
    rows: [
      {
        sourcePath: '/media/source/a.jpg',
        targetPath: '/media/destination/2024/01/a.jpg',
        operation,
        conflictPolicy: 'rename',
        dateEvidence: {
          value: '2024-01-02T03:04:05.000Z',
          source: 'embedded',
          field: 'DateTimeOriginal',
          confidence: 0.96,
          warnings: [],
        },
        fingerprint: { size: 1024, modifiedAt: '2026-08-29T20:00:00.000Z' },
        warnings: [],
      },
      {
        sourcePath: '/media/source/b.jpg',
        targetPath: null,
        operation: 'skip',
        conflictPolicy: 'rename',
        dateEvidence: {
          value: null,
          source: 'unresolved',
          confidence: 0,
          warnings: ['No trustworthy creation date'],
        },
        fingerprint: { size: 0, modifiedAt: '2026-08-29T20:00:00.000Z' },
        warnings: ['Manual review required'],
      },
    ],
  };
}

function createHarness() {
  const store = configureStore({ reducer: { jobs: jobsReducer } });
  return {
    store,
    renderLauncher: () =>
      render(
        <Provider store={store}>
          <ProcessingLauncher />
        </Provider>
      ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function installAPI(overrides: Partial<NonNullable<Window['electronAPI']>> = {}) {
  const selectDirectory = jest
    .fn()
    .mockResolvedValueOnce('/media/source')
    .mockResolvedValueOnce('/media/destination');
  window.electronAPI = {
    selectDirectory,
    getConfig: jest.fn().mockResolvedValue({ success: true, data: config }),
    getProcessingHealth: jest.fn().mockResolvedValue({ success: true, data: readyHealth }),
    previewProcessing: jest.fn().mockResolvedValue({ success: true, data: preview('copy') }),
    startProcessing: jest.fn().mockResolvedValue({
      success: true,
      data: {
        jobId: 'job-1',
        previewId: 'preview-1',
        acceptedAt: '2026-08-29T20:00:01.000Z',
        effectiveOptions: preview('copy').effectiveOptions,
      },
    }),
    cancelProcessing: jest.fn().mockResolvedValue({ success: true }),
    gatherTestRun: jest.fn().mockResolvedValue({
      success: true,
      data: {
        temporarySourcePath: '/tmp/meta-mover-test-runs/run/source',
        copiedFiles: 15000,
        scannedFiles: 958410,
      },
    }),
    discardTestRun: jest.fn().mockResolvedValue({ success: true }),
    cancelTestRun: jest.fn().mockResolvedValue({ success: true }),
    onTestRunProgress: jest.fn().mockReturnValue(() => undefined),
    ...overrides,
  } as unknown as Window['electronAPI'];
  return window.electronAPI!;
}

async function selectFolders(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add source folder' }));
  await user.click(screen.getByRole('button', { name: 'Select destination folder' }));
}

describe('ProcessingLauncher', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it('shows unreadable source paths and says the inventory count is incomplete', async () => {
    installAPI({
      previewProcessing: jest.fn().mockResolvedValue({
        success: true,
        data: {
          ...preview('move'),
          inventoryIssues: [{ filePath: '/media/source/2019', code: 'EIO' }],
        },
      }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    expect(await screen.findByText(/Source scan incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/unknown number of files/)).toBeInTheDocument();
    expect(screen.getByText(/\/media\/source\/2019.*EIO/)).toBeInTheDocument();
    expect(screen.getByText('Readable files found')).toBeInTheDocument();
    expect(screen.getByText(/Move will process only the readable files/)).toBeInTheDocument();
  });

  it('requires a preview before start and shows the evidence summary and warnings', async () => {
    const api = installAPI();
    const previewReady = jest.fn();
    window.addEventListener('meta-mover:preview-ready', previewReady);
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);

    expect(api.startProcessing).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    expect(api.previewProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.any(Object) })
    );
    const sentOptions = (api.previewProcessing as jest.Mock).mock.calls[0][0].options;
    expect(sentOptions).not.toHaveProperty('corruptionDetection');
    expect(sentOptions.appendScreenshotSuffix).toBe(false);

    expect(await screen.findByText('Preview ready')).toBeInTheDocument();
    expect(localStorage.getItem('meta-mover:last-preview-id')).toBe('preview-1');
    expect(previewReady).toHaveBeenCalledWith(expect.objectContaining({ detail: 'preview-1' }));
    window.removeEventListener('meta-mover:preview-ready', previewReady);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('No trustworthy creation date')).toBeInTheDocument();
    expect(screen.getByText('Manual review required')).toBeInTheDocument();
    expect(api.startProcessing).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Start Copy' }));
    expect(api.startProcessing).toHaveBeenCalledWith({
      previewId: 'preview-1',
      acknowledgeDestructiveOperation: false,
    });
  });

  it('shows only original and proposed filenames in preview source and target columns', async () => {
    installAPI();
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);

    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    expect(await screen.findAllByText('a.jpg')).toHaveLength(2);
    expect(screen.getByText('b.jpg')).toBeInTheDocument();
    expect(screen.queryByText('/media/source/a.jpg')).not.toBeInTheDocument();
    expect(screen.queryByText('/media/destination/2024/01/a.jpg')).not.toBeInTheDocument();
    expect(screen.queryByTitle('/media/source/a.jpg')).not.toBeInTheDocument();
    expect(screen.queryByTitle('/media/destination/2024/01/a.jpg')).not.toBeInTheDocument();
  });

  it('gathers 15000 copied files and previews only the temporary corpus', async () => {
    const testConfig = {
      ...config,
      processing: { ...config.processing, testMode: true },
    };
    const api = installAPI({
      getConfig: jest.fn().mockResolvedValue({ success: true, data: testConfig }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);

    await user.click(screen.getByRole('button', { name: 'Gather 15,000-file test run' }));

    expect(api.gatherTestRun).toHaveBeenCalledWith({
      sourcePath: '/media/source',
      destinationPath: '/media/destination',
      fileCount: 15000,
    });
    await waitFor(() =>
      expect(api.previewProcessing).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePaths: ['/tmp/meta-mover-test-runs/run/source'],
          destinationPath: '/media/destination',
        })
      )
    );
  });

  it('rebuilds a retained test corpus when settings change without gathering another corpus', async () => {
    const testConfig = {
      ...config,
      processing: { ...config.processing, testMode: true },
    };
    const moveConfig = {
      ...testConfig,
      processing: { ...testConfig.processing, operation: 'move' as const },
    };
    const api = installAPI({
      getConfig: jest
        .fn()
        .mockResolvedValueOnce({ success: true, data: testConfig })
        .mockResolvedValueOnce({ success: true, data: testConfig })
        .mockResolvedValue({ success: true, data: moveConfig }),
      previewProcessing: jest
        .fn()
        .mockResolvedValueOnce({ success: true, data: preview('copy') })
        .mockResolvedValue({ success: true, data: preview('move') }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Gather 15,000-file test run' }));
    expect(await screen.findByRole('button', { name: 'Start Copy' })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent('meta-mover:config-updated', { detail: moveConfig }));
    });

    expect(await screen.findByRole('button', { name: 'Start Move' })).toBeInTheDocument();
    expect(api.gatherTestRun).toHaveBeenCalledTimes(1);
    expect(api.previewProcessing).toHaveBeenCalledTimes(2);
    expect(api.previewProcessing).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourcePaths: ['/tmp/meta-mover-test-runs/run/source'],
        options: expect.objectContaining({ operation: 'move' }),
      })
    );
  });

  it('shows test-run scan and copy progress with current filename and cancellation', async () => {
    let progressListener:
      | ((event: import('../../../src/main/services/TestRunCorpusBuilder').TestRunProgress) => void)
      | undefined;
    const pending =
      deferred<Awaited<ReturnType<NonNullable<Window['electronAPI']>['gatherTestRun']>>>();
    const testConfig = { ...config, processing: { ...config.processing, testMode: true } };
    const api = installAPI({
      getConfig: jest.fn().mockResolvedValue({ success: true, data: testConfig }),
      gatherTestRun: jest.fn(() => pending.promise),
      onTestRunProgress: jest.fn((listener) => {
        progressListener = listener;
        return () => undefined;
      }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Gather 15,000-file test run' }));

    act(() =>
      progressListener?.({
        phase: 'copying',
        scannedFiles: 958410,
        selectedFiles: 15000,
        copiedFiles: 4200,
        totalFiles: 15000,
        percentage: 28,
        currentFile: 'Photos/2024/current.jpg',
      })
    );

    expect(screen.getByText('4,200 / 15,000 files (28%)')).toBeInTheDocument();
    expect(screen.getByText('Photos/2024/current.jpg')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop Test Run' }));
    expect(api.cancelTestRun).toHaveBeenCalledTimes(1);
  });

  it('shows a persistent test-mode banner and hides normal preview while enabled', async () => {
    const testConfig = {
      ...config,
      processing: { ...config.processing, testMode: true },
    };
    installAPI({ getConfig: jest.fn().mockResolvedValue({ success: true, data: testConfig }) });
    createHarness().renderLauncher();

    expect(await screen.findByText(/TEST MODE/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Build Preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gather 15,000-file test run' })).toBeInTheDocument();
  });

  it('recognizes a retained test corpus after relaunch and rebuilds without gathering', async () => {
    const retained = '/media/destination/.meta-mover-test-runs/run-12345678-existing/source';
    const testConfig = { ...config, processing: { ...config.processing, testMode: true } };
    const api = installAPI({
      selectDirectory: jest
        .fn()
        .mockResolvedValueOnce(retained)
        .mockResolvedValueOnce('/media/destination'),
      getConfig: jest.fn().mockResolvedValue({ success: true, data: testConfig }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);

    await user.click(screen.getByRole('button', { name: 'Rebuild existing test preview' }));

    expect(api.gatherTestRun).not.toHaveBeenCalled();
    expect(api.previewProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePaths: [retained] })
    );
  });

  it('reflects test mode immediately when Settings saves while Organize stays mounted', async () => {
    installAPI();
    createHarness().renderLauncher();
    expect(await screen.findByRole('button', { name: 'Build Preview' })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent('meta-mover:config-updated', {
          detail: { ...config, processing: { ...config.processing, testMode: true } },
        })
      );
    });

    expect(screen.getByText(/TEST MODE/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Build Preview' })).not.toBeInTheDocument();
  });

  it('carries the enabled screenshot label setting into preview options', async () => {
    const api = installAPI({
      getConfig: jest.fn().mockResolvedValue({
        success: true,
        data: {
          ...config,
          organization: { ...config.organization, appendScreenshotSuffix: true },
        },
      }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);

    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    expect((api.previewProcessing as jest.Mock).mock.calls[0][0].options).toMatchObject({
      appendScreenshotSuffix: true,
    });
  });

  it('shows real preview progress and stops the active analysis by preview job id', async () => {
    const pendingPreview =
      deferred<Awaited<ReturnType<NonNullable<Window['electronAPI']>['previewProcessing']>>>();
    const api = installAPI({ previewProcessing: jest.fn(() => pendingPreview.promise) });
    const user = userEvent.setup();
    const { store, renderLauncher } = createHarness();
    renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    expect(await screen.findByText('Discovering files...')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Preview analysis progress' })
    ).not.toHaveAttribute('aria-valuenow');

    act(() => {
      store.dispatch(
        applyProcessingEvent({
          kind: 'preview-started',
          jobId: 'preview-job',
          sequence: 1,
          emittedAt: '2026-08-31T20:00:00.000Z',
          payload: { sourceCount: 1, destinationPath: '/media/destination' },
        })
      );
      store.dispatch(
        applyProcessingEvent({
          kind: 'preview-progress',
          jobId: 'preview-job',
          sequence: 2,
          emittedAt: '2026-08-31T20:00:01.000Z',
          payload: {
            phase: 'metadata',
            filesProcessed: 3,
            totalFiles: 10,
            percentage: 30,
            currentFile: '/media/source/current-photo.jpg',
          },
        })
      );
    });

    expect(await screen.findByText('3 / 10 files (30%)')).toBeInTheDocument();
    expect(screen.getByText('/media/source/current-photo.jpg')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Preview analysis progress' })).toHaveAttribute(
      'aria-valuenow',
      '30'
    );

    await user.click(screen.getByRole('button', { name: 'Stop Preview' }));
    expect(api.cancelProcessing).toHaveBeenCalledWith({
      jobId: 'preview-job',
      reason: 'Stopped by user',
    });

    pendingPreview.resolve({
      success: false,
      error: {
        code: 'PREVIEW_CANCELLED',
        message: 'Preview analysis stopped',
        recoverable: true,
      },
    });
    expect(
      await screen.findByText('Preview analysis stopped. No files were changed.')
    ).toBeInTheDocument();
  });

  it('disables Stop Preview after analysis enters finalization', async () => {
    const pendingPreview =
      deferred<Awaited<ReturnType<NonNullable<Window['electronAPI']>['previewProcessing']>>>();
    installAPI({ previewProcessing: jest.fn(() => pendingPreview.promise) });
    const user = userEvent.setup();
    const { store, renderLauncher } = createHarness();
    renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    act(() => {
      store.dispatch(
        applyProcessingEvent({
          kind: 'preview-started',
          jobId: 'preview-job',
          sequence: 1,
          emittedAt: '2026-08-31T20:00:00.000Z',
          payload: { sourceCount: 1, destinationPath: '/media/destination' },
        })
      );
      store.dispatch(
        applyProcessingEvent({
          kind: 'preview-progress',
          jobId: 'preview-job',
          sequence: 2,
          emittedAt: '2026-08-31T20:00:01.000Z',
          payload: {
            phase: 'organization',
            filesProcessed: 10,
            totalFiles: 10,
            percentage: 100,
          },
        })
      );
    });

    expect(screen.getByRole('button', { name: 'Stop Preview' })).toBeDisabled();
  });

  it('renders a completed empty-folder preview as determinate zero of zero', async () => {
    const pendingPreview =
      deferred<Awaited<ReturnType<NonNullable<Window['electronAPI']>['previewProcessing']>>>();
    installAPI({ previewProcessing: jest.fn(() => pendingPreview.promise) });
    const user = userEvent.setup();
    const { store, renderLauncher } = createHarness();
    renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    act(() => {
      store.dispatch(
        applyProcessingEvent({
          kind: 'preview-started',
          jobId: 'empty-preview',
          sequence: 1,
          emittedAt: '2026-08-31T20:00:00.000Z',
          payload: { sourceCount: 1, destinationPath: '/media/destination' },
        })
      );
      store.dispatch(
        applyProcessingEvent({
          kind: 'preview-progress',
          jobId: 'empty-preview',
          sequence: 2,
          emittedAt: '2026-08-31T20:00:01.000Z',
          payload: {
            phase: 'organization',
            filesProcessed: 0,
            totalFiles: 0,
            percentage: 100,
          },
        })
      );
    });

    expect(screen.getByText('0 / 0 files (100%)')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Preview analysis progress' })).toHaveAttribute(
      'aria-valuenow',
      '100'
    );
  });

  it('submits only one preview request when Build Preview is activated twice rapidly', async () => {
    const pendingPreview =
      deferred<Awaited<ReturnType<NonNullable<Window['electronAPI']>['previewProcessing']>>>();
    const api = installAPI({ previewProcessing: jest.fn(() => pendingPreview.promise) });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);
    const build = screen.getByRole('button', { name: 'Build Preview' });

    fireEvent.click(build);
    fireEvent.click(build);

    // The request is issued after the saved settings are re-read, so wait for it, then confirm
    // the second activation never produced a second request.
    await waitFor(() => expect(api.previewProcessing).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.previewProcessing).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed preview screen even when terminal events arrive after the IPC response', async () => {
    installAPI({
      previewProcessing: jest.fn().mockResolvedValue({
        success: false,
        error: { code: 'INVALID_PLAN', message: 'destinationPath cannot be inspected' },
      }),
    });
    const user = userEvent.setup();
    const { store, renderLauncher } = createHarness();
    renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));
    expect(await screen.findByText('destinationPath cannot be inspected')).toBeInTheDocument();

    act(() => {
      store.dispatch(
        applyProcessingEvent({
          kind: 'preview-started',
          jobId: 'failed-preview',
          sequence: 1,
          emittedAt: '2026-08-31T21:00:00.000Z',
          payload: { sourceCount: 1, destinationPath: '/missing' },
        })
      );
    });
    expect(await screen.findByText('Building preview')).toBeInTheDocument();

    act(() => {
      store.dispatch(
        applyProcessingEvent({
          kind: 'job-failed',
          jobId: 'failed-preview',
          sequence: 2,
          emittedAt: '2026-08-31T21:00:01.000Z',
          payload: {
            error: { code: 'INVALID_PLAN', message: 'destinationPath cannot be inspected' },
          },
        })
      );
    });

    await waitFor(() => expect(screen.queryByText('Building preview')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Build Preview' })).toBeEnabled();
  });

  it('adds, deduplicates, preserves, and accessibly removes multiple source folders', async () => {
    const selectDirectory = jest
      .fn()
      .mockResolvedValueOnce('/media/source-a')
      .mockResolvedValueOnce('/media/source-b')
      .mockResolvedValueOnce('/media/source-b')
      .mockResolvedValueOnce('/media/destination');
    const api = installAPI({ selectDirectory });
    const user = userEvent.setup();
    createHarness().renderLauncher();

    const addSource = await screen.findByRole('button', { name: 'Add source folder' });
    await user.click(addSource);
    await user.click(addSource);
    await user.click(addSource);

    const selectedSources = screen.getByRole('list', { name: 'Selected source folders' });
    expect(selectedSources).toHaveTextContent('/media/source-a');
    expect(selectedSources).toHaveTextContent('/media/source-b');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Remove source folder /media/source-a' }));
    expect(selectedSources).not.toHaveTextContent('/media/source-a');
    expect(selectedSources).toHaveTextContent('/media/source-b');

    await user.click(screen.getByRole('button', { name: 'Select destination folder' }));
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    expect(api.previewProcessing).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePaths: ['/media/source-b'],
        destinationPath: '/media/destination',
      })
    );
  });

  it('builds the preview from the settings saved after startup, not the startup snapshot', async () => {
    const moveConfig = {
      ...config,
      processing: { ...config.processing, operation: 'move' as const },
    };
    const api = installAPI({
      getConfig: jest
        .fn()
        .mockResolvedValueOnce({ success: true, data: config })
        .mockResolvedValue({ success: true, data: moveConfig }),
      previewProcessing: jest.fn().mockResolvedValue({ success: true, data: preview('move') }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    expect(await screen.findByRole('button', { name: 'Start Move' })).toBeInTheDocument();
    expect(api.previewProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ operation: 'move' }) })
    );
  });

  it('requires explicit acknowledgement before starting a Move preview', async () => {
    const moveConfig = {
      ...config,
      processing: { ...config.processing, operation: 'move' as const },
    };
    const movePreview = preview('move');
    const api = installAPI({
      getConfig: jest.fn().mockResolvedValue({ success: true, data: moveConfig }),
      previewProcessing: jest.fn().mockResolvedValue({ success: true, data: movePreview }),
      startProcessing: jest.fn().mockResolvedValue({
        success: true,
        data: {
          jobId: 'job-1',
          previewId: 'preview-1',
          acceptedAt: '2026-08-29T20:00:01.000Z',
          effectiveOptions: movePreview.effectiveOptions,
        },
      }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));

    const start = await screen.findByRole('button', { name: 'Start Move' });
    expect(start).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: /I understand Move deletes each source/i })
    );
    expect(start).toBeEnabled();
    await user.click(start);
    expect(api.startProcessing).toHaveBeenCalledWith({
      previewId: 'preview-1',
      acknowledgeDestructiveOperation: true,
    });
  });

  it('blocks preview when runtime health says preview is unavailable', async () => {
    const blockedHealth: DependencyHealthDTO = {
      ...readyHealth,
      ready: false,
      capabilities: {
        ...readyHealth.capabilities,
        preview: { available: false, blockers: ['Bundled ExifTool integrity check failed'] },
      },
    };
    const api = installAPI({
      getProcessingHealth: jest.fn().mockResolvedValue({ success: true, data: blockedHealth }),
    });
    const user = userEvent.setup();
    createHarness().renderLauncher();
    await selectFolders(user);

    expect(await screen.findByText('Bundled ExifTool integrity check failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build Preview' })).toBeDisabled();
    expect(api.previewProcessing).not.toHaveBeenCalled();
  });

  it('renders Redux progress and sends the canonical cancel request object', async () => {
    const api = installAPI();
    const user = userEvent.setup();
    const { store, renderLauncher } = createHarness();
    renderLauncher();
    await selectFolders(user);
    await user.click(screen.getByRole('button', { name: 'Build Preview' }));
    await user.click(await screen.findByRole('button', { name: 'Start Copy' }));

    act(() => {
      store.dispatch(
        addJob({
          id: 'job-1',
          type: 'organize',
          status: 'processing',
          progress: 45,
          filesProcessed: 9,
          totalFiles: 20,
          startTime: '2026-08-29T20:00:01.000Z',
        })
      );
    });

    expect(await screen.findByText('9 attempted / 20 total')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel Processing' }));
    expect(api.cancelProcessing).toHaveBeenCalledWith({
      jobId: 'job-1',
      reason: 'Cancelled by user',
    });
  });

  it('shows settled failures while successful progress remains truthful', async () => {
    installAPI();
    const { store, renderLauncher } = createHarness();
    store.dispatch(
      addJob({
        id: 'job-failing',
        type: 'copy',
        status: 'processing',
        progress: 0,
        filesProcessed: 0,
        filesAttempted: 3,
        filesSettled: 3,
        failedFiles: 3,
        totalFiles: 20,
        currentFile: '/media/source/broken-3.jpg',
        startTime: '2026-08-29T20:00:01.000Z',
      })
    );
    store.dispatch(setActiveJob('job-failing'));

    renderLauncher();

    expect(await screen.findByText('3 attempted / 20 total')).toBeInTheDocument();
    expect(screen.getByText('3 settled')).toBeInTheDocument();
    expect(screen.getByText('0 succeeded')).toBeInTheDocument();
    expect(screen.getByText('3 failed')).toBeInTheDocument();
    expect(screen.getByText('/media/source/broken-3.jpg')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Processing progress' })).toHaveAttribute(
      'aria-valuenow',
      '0'
    );
  });

  it('shows the audit preparation stage between file settlements while cancellation stays available', async () => {
    installAPI();
    const { store, renderLauncher } = createHarness();
    store.dispatch(
      addJob({
        id: 'job-1',
        type: 'copy',
        status: 'processing',
        progress: 0,
        filesProcessed: 2,
        totalFiles: 100000,
        preparation: {
          stage: 'Verifying preview evidence',
          completed: 600,
          total: 1000,
          unit: 'records',
        },
        startTime: '2026-08-29T20:00:01.000Z',
      })
    );
    store.dispatch(setActiveJob('job-1'));

    renderLauncher();

    expect(await screen.findByText('2 attempted / 100000 total')).toBeInTheDocument();
    expect(screen.getByText('Preparing metadata audit')).toBeInTheDocument();
    expect(screen.getByText('Verifying preview evidence')).toBeInTheDocument();
    expect(screen.getByText('600 / 1,000 records (60%)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel Processing' })).toBeEnabled();
  });

  it('resumes the active Redux job after navigation remounts the launcher', async () => {
    const api = installAPI();
    const user = userEvent.setup();
    const { store, renderLauncher } = createHarness();
    store.dispatch(
      addJob({
        id: 'job-live',
        type: 'copy',
        status: 'processing',
        progress: 20,
        filesProcessed: 2,
        totalFiles: 10,
        startTime: '2026-08-29T20:00:01.000Z',
      })
    );
    store.dispatch(setActiveJob('job-live'));

    renderLauncher();

    expect(await screen.findByText('2 attempted / 10 total')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel Processing' }));
    expect(api.cancelProcessing).toHaveBeenCalledWith({
      jobId: 'job-live',
      reason: 'Cancelled by user',
    });
  });

  it('shows partial completion counts and each failed file path', async () => {
    installAPI();
    const { store, renderLauncher } = createHarness();
    store.dispatch(
      addJob({
        id: 'job-partial',
        type: 'copy',
        status: 'processing',
        progress: 0,
        filesProcessed: 0,
        totalFiles: 2,
        startTime: '2026-08-29T20:00:01.000Z',
      })
    );
    store.dispatch(setActiveJob('job-partial'));

    renderLauncher();
    act(() => {
      store.dispatch(
        updateJob({
          id: 'job-partial',
          status: 'partial',
          progress: 50,
          filesProcessed: 1,
          failedFiles: 1,
          fileFailures: [{ sourcePath: '/media/source/b.jpg', error: 'permission denied' }],
          endTime: '2026-08-29T20:00:02.000Z',
        })
      );
    });

    expect(await screen.findByText('Processing completed with failures')).toBeInTheDocument();
    expect(screen.getByText(/1 succeeded, 1 failed, 2 total/i)).toBeInTheDocument();
    expect(screen.getByText('/media/source/b.jpg: permission denied')).toBeInTheDocument();
  });

  it('shows cancelled Move residue without calling the file a success', async () => {
    installAPI();
    const { store, renderLauncher } = createHarness();
    store.dispatch(
      addJob({
        id: 'job-cancelled',
        type: 'move',
        status: 'processing',
        progress: 0,
        filesProcessed: 0,
        totalFiles: 2,
        startTime: '2026-08-29T20:00:01.000Z',
      })
    );
    store.dispatch(setActiveJob('job-cancelled'));

    renderLauncher();
    act(() => {
      store.dispatch(
        updateJob({
          id: 'job-cancelled',
          status: 'cancelled',
          cancelledFiles: 1,
          unattemptedFiles: 0,
          committedResidueBytes: 0,
          cancellationOutcomes: [
            {
              sourcePath: '/media/source/a.jpg',
              destinationPath: '/media/destination/a.jpg',
              state: 'destination-committed-source-retained',
              plannedBytes: 0,
              committedBytes: 0,
              sourceRetained: true,
              error: 'cancelled after destination commit',
            },
            {
              sourcePath: '/media/source/unsupported.bin',
              destinationPath: null,
              state: 'skipped',
              plannedBytes: 0,
              committedBytes: 0,
              sourceRetained: true,
            },
          ],
          endTime: '2026-08-29T20:00:02.000Z',
        })
      );
    });

    expect(await screen.findByText('Processing cancelled')).toBeInTheDocument();
    expect(screen.getByText(/0 succeeded, 1 cancelled, 0 not attempted/i)).toBeInTheDocument();
    expect(screen.getByText(/0 residue bytes/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 of 1 files succeeded/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/\/media\/source\/a.jpg.*\/media\/destination\/a.jpg/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/\/media\/source\/unsupported.bin.*no destination/i)
    ).toBeInTheDocument();
  });
});
