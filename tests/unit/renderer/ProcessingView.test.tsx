import { render, screen } from '@testing-library/react';

import { ProcessingView } from '../../../src/renderer/components/views/ProcessingView';

describe('ProcessingView', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it('renders typed persisted history from the canonical response envelope', async () => {
    window.electronAPI = {
      getJobHistory: jest.fn().mockResolvedValue({
        success: true,
        data: [
          {
            jobId: 'job-42',
            previewId: 'preview-42',
            status: 'completed',
            sourcePaths: ['/media/source'],
            destinationPath: '/media/destination',
            effectiveOptions: {
              operation: 'copy',
              conflictPolicy: 'rename',
              folderStructure: 'year/month',
              workerCount: 4,
              verifyIntegrity: true,
              appendScreenshotSuffix: false,
              writeMetadataDates: false,
            },
            createdAt: '2026-08-29T20:00:00.000Z',
            completedAt: '2026-08-29T20:01:00.000Z',
            progress: { filesProcessed: 7, totalFiles: 7, percentage: 100 },
          },
        ],
      }),
    } as unknown as Window['electronAPI'];

    render(<ProcessingView />);

    expect(await screen.findByText('Copy to /media/destination')).toBeInTheDocument();
    expect(screen.getByText(/7\/7 files/)).toBeInTheDocument();
    expect(window.electronAPI.getJobHistory).toHaveBeenCalledWith(20);
  });

  it('surfaces a history read failure instead of claiming no jobs exist', async () => {
    window.electronAPI = {
      getJobHistory: jest.fn().mockResolvedValue({
        success: false,
        error: { code: 'READ_FAILED', message: 'History is unreadable', recoverable: false },
      }),
    } as unknown as Window['electronAPI'];

    render(<ProcessingView />);

    expect(await screen.findByText('History is unreadable')).toBeInTheDocument();
    expect(screen.queryByText(/No processing jobs yet/)).not.toBeInTheDocument();
  });

  it('shows partial history success and failure counts with failed paths', async () => {
    window.electronAPI = {
      getJobHistory: jest.fn().mockResolvedValue({
        success: true,
        data: [
          {
            jobId: 'job-partial',
            previewId: 'preview-partial',
            status: 'partial',
            sourcePaths: ['/media/source'],
            destinationPath: '/media/destination',
            effectiveOptions: {
              operation: 'copy',
              conflictPolicy: 'rename',
              folderStructure: 'year/month',
              workerCount: 2,
              verifyIntegrity: true,
              appendScreenshotSuffix: false,
              writeMetadataDates: false,
            },
            createdAt: '2026-08-29T20:00:00.000Z',
            completedAt: '2026-08-29T20:01:00.000Z',
            progress: { filesProcessed: 1, totalFiles: 2, percentage: 50 },
            statistics: {
              totalFiles: 2,
              processedFiles: 1,
              skippedFiles: 0,
              failedFiles: 1,
              totalBytes: 20,
              processedBytes: 10,
              durationMs: 100,
            },
            fileFailures: [{ sourcePath: '/media/source/b.jpg', error: 'permission denied' }],
          },
        ],
      }),
    } as unknown as Window['electronAPI'];

    render(<ProcessingView />);

    expect(await screen.findByText(/1 succeeded, 1 failed, 2 total/i)).toBeInTheDocument();
    expect(screen.getByText('/media/source/b.jpg: permission denied')).toBeInTheDocument();
    expect(screen.getByText('partial')).toBeInTheDocument();
  });

  it('shows cancelled Move residue with exact source and destination paths', async () => {
    window.electronAPI = {
      getJobHistory: jest.fn().mockResolvedValue({
        success: true,
        data: [
          {
            jobId: 'job-cancelled',
            previewId: 'preview-cancelled',
            status: 'cancelled',
            sourcePaths: ['/media/source'],
            destinationPath: '/media/destination',
            effectiveOptions: {
              operation: 'move',
              conflictPolicy: 'rename',
              folderStructure: 'year/month',
              workerCount: 1,
              verifyIntegrity: true,
              appendScreenshotSuffix: false,
              writeMetadataDates: false,
            },
            createdAt: '2026-08-29T20:00:00.000Z',
            completedAt: '2026-08-29T20:00:01.000Z',
            progress: { filesProcessed: 0, totalFiles: 2, percentage: 0 },
            statistics: {
              totalFiles: 2,
              processedFiles: 0,
              skippedFiles: 1,
              failedFiles: 0,
              cancelledFiles: 1,
              unattemptedFiles: 0,
              totalBytes: 0,
              processedBytes: 0,
              committedResidueBytes: 0,
              durationMs: 100,
            },
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
          },
        ],
      }),
    } as unknown as Window['electronAPI'];

    render(<ProcessingView />);

    expect(
      await screen.findByText(/0 succeeded, 1 cancelled, 0 not attempted/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/0 residue bytes/i)).toBeInTheDocument();
    expect(
      screen.getByText(/\/media\/source\/a.jpg.*\/media\/destination\/a.jpg/i)
    ).toHaveTextContent('destination-committed-source-retained');
    expect(screen.getAllByText(/source retained/i)).toHaveLength(2);
    expect(
      screen.getByText(/\/media\/source\/unsupported.bin.*no destination/i)
    ).toBeInTheDocument();
  });
});
