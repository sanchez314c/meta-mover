import { configureStore } from '@reduxjs/toolkit';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { ProcessingLauncher } from '../../../src/renderer/components/ProcessingLauncher';
import jobsReducer, {
  addJob,
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
  },
  organization: {
    folderStructure: 'year/month' as const,
    conflictPolicy: 'rename' as const,
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
        writeMetadataDates: false,
      },
    },
    effectiveOptions: {
      operation,
      conflictPolicy: 'rename',
      folderStructure: 'year/month',
      workerCount: 4,
      verifyIntegrity: true,
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

  it('requires a preview before start and shows the evidence summary and warnings', async () => {
    const api = installAPI();
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

    expect(await screen.findByText('Preview ready')).toBeInTheDocument();
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

    expect(await screen.findByText('9 / 20 files (45%)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel Processing' }));
    expect(api.cancelProcessing).toHaveBeenCalledWith({
      jobId: 'job-1',
      reason: 'Cancelled by user',
    });
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

    expect(await screen.findByText('2 / 10 files (20%)')).toBeInTheDocument();
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
