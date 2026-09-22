import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ReviewView } from '../../../src/renderer/components/views/ReviewView';

const resolution = {
  policyVersion: 'date-resolution/1' as const,
  fileId: 'file-1',
  mediaKind: 'image' as const,
  target: 'capture-time' as const,
  evaluationTimeUtc: '2026-09-22T12:00:00.000Z',
  status: 'ambiguous' as const,
  confidence: 'low' as const,
  contenderIds: ['candidate-1'],
  rejected: [],
  reasonCodes: ['STRONG_CONFLICT'],
  candidates: [
    {
      id: 'candidate-1',
      fileId: 'file-1',
      mediaKind: 'image' as const,
      semantic: 'capture' as const,
      sourceKind: 'embedded-exif' as const,
      sourceFamily: 'EXIF',
      tag: 'EXIF:DateTimeOriginal',
      rawValue: '2020:01:02 03:04:05',
      value: {
        localIso: '2020-01-02T03:04:05',
        zoneBasis: 'floating-local' as const,
        precision: 'second' as const,
      },
      eligibility: 'eligible' as const,
      score: { base: 95, modifiers: [], semanticCap: 100, final: 95 },
      resolutionIssues: [],
    },
  ],
};
const item = {
  reviewId: 'review-1',
  jobId: 'job-1',
  previewId: 'preview-1',
  rowIndex: 0,
  originalSourcePath: '/source/photo.jpg',
  currentPath: '/destination/Photos/_Needs Review/photo.jpg',
  destinationRoot: '/destination',
  mediaKind: 'image' as const,
  status: 'pending' as const,
  reasonCodes: ['STRONG_CONFLICT'],
  warnings: ['Creation date requires review'],
  evidence: { revision: 'evidence-1', resolution, collectedAt: '2026-09-22T12:00:00.000Z' },
  output: {
    path: '/destination/Photos/_Needs Review/photo.jpg',
    device: 1,
    inode: 2,
    size: 3,
    modifiedTimeMs: 4,
    mtimeNs: '4000000',
    sha256: 'a'.repeat(64),
  },
  screenshotDetected: false,
  updatedAt: '2026-09-22T12:00:00.000Z',
};

describe('ReviewView', () => {
  beforeEach(() => {
    window.electronAPI = {
      reviewList: jest.fn(async () => ({
        success: true,
        data: { items: [item], nextCursor: 'page-2' },
      })),
      reviewGet: jest.fn(async () => ({ success: true, data: item })),
      reviewDryRun: jest.fn(async (request) => ({
        success: true,
        data: {
          planToken: 'plan-1',
          action: request.action,
          currentPath: item.currentPath,
          targetPath: '/destination/Photos/2020/01/photo.jpg',
          collision: false,
          warnings: [],
        },
      })),
      reviewApply: jest.fn(async () => ({
        success: true,
        data: {
          reviewId: item.reviewId,
          status: 'resolved',
          currentPath: item.currentPath,
          resolvedPath: '/destination/Photos/2020/01/photo.jpg',
          evidenceRevision: 'evidence-1',
        },
      })),
    } as never;
  });
  afterEach(() => delete window.electronAPI);

  it('loads the pending queue, selects a detail, and pages without discarding prior rows', async () => {
    render(<ReviewView />);
    expect(await screen.findAllByText('photo.jpg')).toHaveLength(2);
    expect(screen.getAllByText('STRONG_CONFLICT')).toHaveLength(2);
    expect(screen.getByText(/EXIF:DateTimeOriginal/)).toBeInTheDocument();
    const api = window.electronAPI as unknown as { reviewList: jest.Mock };
    expect(api.reviewList).toHaveBeenCalledWith({
      statuses: ['pending', 'failed'],
      limit: 50,
    });
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() =>
      expect(api.reviewList).toHaveBeenLastCalledWith({
        statuses: ['pending', 'failed'],
        limit: 50,
        cursor: 'page-2',
      })
    );
  });

  it('requires Preview Fix to issue a plan token before Apply Fix', async () => {
    render(<ReviewView />);
    await screen.findByText(/EXIF:DateTimeOriginal/);
    const apply = screen.getByRole('button', { name: /apply fix/i });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /candidate-1/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview fix/i }));
    await screen.findByText('/destination/Photos/2020/01/photo.jpg');
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    const api = window.electronAPI as unknown as { reviewApply: jest.Mock };
    await waitFor(() =>
      expect(api.reviewApply).toHaveBeenCalledWith({
        reviewId: 'review-1',
        evidenceRevision: 'evidence-1',
        action: { type: 'select-candidate', candidateId: 'candidate-1' },
        planToken: 'plan-1',
      })
    );
  });

  it('offers manual date, metadata retry, and keep-here actions', async () => {
    render(<ReviewView />);
    await screen.findByText(/EXIF:DateTimeOriginal/);
    expect(screen.getByRole('button', { name: /retry metadata/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep here/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/manual date/i), {
      target: { value: '2021-04-05T06:07:08' },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview fix/i }));
    const api = window.electronAPI as unknown as { reviewDryRun: jest.Mock };
    await waitFor(() =>
      expect(api.reviewDryRun).toHaveBeenCalledWith({
        reviewId: 'review-1',
        evidenceRevision: 'evidence-1',
        action: {
          type: 'manual-date',
          value: {
            localIso: '2021-04-05T06:07:08.000',
            zoneBasis: 'floating-local',
            precision: 'second',
          },
        },
      })
    );
  });

  it('shows empty, request errors, and stale-plan errors without leaving Apply enabled', async () => {
    const api = window.electronAPI as unknown as { reviewList: jest.Mock };
    api.reviewList.mockResolvedValueOnce({ success: true, data: { items: [] } });
    const { unmount } = render(<ReviewView />);
    expect(await screen.findByText(/no pending review items/i)).toBeInTheDocument();
    unmount();
    api.reviewList.mockResolvedValueOnce({
      success: false,
      error: { message: 'Queue unavailable' },
    });
    render(<ReviewView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue unavailable');
  });

  it('keeps retry-metadata pending rows visible and refreshes their evidence', async () => {
    const bridge = window.electronAPI as unknown as {
      reviewGet: jest.Mock;
      reviewApply: jest.Mock;
    };
    const refreshed = {
      ...item,
      evidence: { ...item.evidence, revision: 'evidence-2' },
      updatedAt: '2026-09-22T12:01:00.000Z',
    };
    bridge.reviewGet.mockResolvedValueOnce({ success: true, data: item });
    bridge.reviewGet.mockResolvedValueOnce({ success: true, data: refreshed });
    bridge.reviewApply.mockResolvedValueOnce({
      success: true,
      data: {
        reviewId: item.reviewId,
        status: 'pending',
        currentPath: item.currentPath,
        evidenceRevision: 'evidence-2',
      },
    });

    render(<ReviewView />);
    await screen.findByText(/EXIF:DateTimeOriginal/);
    fireEvent.click(screen.getByRole('button', { name: /retry metadata/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview fix/i }));
    await screen.findByText(item.currentPath);
    fireEvent.click(screen.getByRole('button', { name: /apply fix/i }));

    await waitFor(() => expect(bridge.reviewGet).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('photo.jpg')).toHaveLength(2);
    expect(screen.getByText(/review item is pending/i)).toBeInTheDocument();
  });

  it('keeps failed rows visible and refreshes the service error truth', async () => {
    const bridge = window.electronAPI as unknown as {
      reviewGet: jest.Mock;
      reviewApply: jest.Mock;
    };
    const failed = { ...item, status: 'failed' as const, lastError: 'transaction rejected' };
    bridge.reviewGet.mockResolvedValueOnce({ success: true, data: item });
    bridge.reviewGet.mockResolvedValueOnce({ success: true, data: failed });
    bridge.reviewApply.mockResolvedValueOnce({
      success: true,
      data: {
        reviewId: item.reviewId,
        status: 'failed',
        currentPath: item.currentPath,
        evidenceRevision: item.evidence.revision,
      },
    });

    render(<ReviewView />);
    await screen.findByText(/EXIF:DateTimeOriginal/);
    fireEvent.click(screen.getByRole('radio', { name: /candidate-1/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview fix/i }));
    await screen.findByText('/destination/Photos/2020/01/photo.jpg');
    fireEvent.click(screen.getByRole('button', { name: /apply fix/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('transaction rejected');
    expect(screen.getAllByText('photo.jpg')).toHaveLength(2);
  });

  it('reloads persisted failed rows after remount while excluding terminal rows', async () => {
    const bridge = window.electronAPI as unknown as {
      reviewList: jest.Mock;
      reviewGet: jest.Mock;
    };
    const failed = { ...item, status: 'failed' as const, lastError: 'retryable failure' };
    const resolved = {
      ...item,
      reviewId: 'review-resolved',
      status: 'resolved' as const,
      resolvedPath: '/destination/Photos/2020/01/photo.jpg',
    };
    bridge.reviewList.mockResolvedValue({
      success: true,
      data: { items: [failed, resolved] },
    });
    bridge.reviewGet.mockResolvedValue({ success: true, data: failed });

    const first = render(<ReviewView />);
    expect(await screen.findAllByText('photo.jpg')).toHaveLength(2);
    expect(bridge.reviewList).toHaveBeenLastCalledWith({
      statuses: ['pending', 'failed'],
      limit: 50,
    });
    first.unmount();

    render(<ReviewView />);
    expect(await screen.findAllByText('photo.jpg')).toHaveLength(2);
    expect(screen.getByRole('alert')).toHaveTextContent('retryable failure');
    expect(bridge.reviewList).toHaveBeenCalledTimes(2);
  });

  it('uses server-side actionable pagination so terminal first pages cannot cause false empty', async () => {
    const bridge = window.electronAPI as unknown as {
      reviewList: jest.Mock;
      reviewGet: jest.Mock;
    };
    const failed = { ...item, status: 'failed' as const, lastError: 'retry me' };
    bridge.reviewList.mockImplementation(async (request: { statuses?: string[] }) =>
      request.statuses
        ? { success: true, data: { items: [failed] } }
        : { success: true, data: { items: [], nextCursor: '50' } }
    );
    bridge.reviewGet.mockResolvedValue({ success: true, data: failed });

    render(<ReviewView />);

    expect(await screen.findAllByText('photo.jpg')).toHaveLength(2);
    expect(screen.queryByText(/no pending review items/i)).not.toBeInTheDocument();
    expect(bridge.reviewList).toHaveBeenCalledWith({
      statuses: ['pending', 'failed'],
      limit: 50,
    });
  });
});
