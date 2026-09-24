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
    expect(screen.getAllByText(/different credible dates found/i)).toHaveLength(1);
    expect(screen.getByText(/camera exif date taken/i)).toBeInTheDocument();
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

  it('explains conflicting metadata in plain English and keeps exact candidate selection', async () => {
    const conflicting = {
      ...item,
      reasonCodes: ['STRONG_CONFLICT', 'STRONG_CONFLICT'],
      warnings: ['Creation date requires review', 'Creation date requires review'],
      evidence: {
        ...item.evidence,
        resolution: {
          ...resolution,
          contenderIds: ['camera', 'photoshop'],
          candidates: [
            {
              ...resolution.candidates[0],
              id: 'camera',
              value: { ...resolution.candidates[0].value, localIso: '2000-08-11T19:51:59' },
            },
            {
              ...resolution.candidates[0],
              id: 'photoshop',
              sourceKind: 'embedded-iptc' as const,
              sourceFamily: 'IPTC',
              tag: 'IPTC:DateCreated',
              rawValue: '2015:10:18 12:00:00',
              value: { ...resolution.candidates[0].value, localIso: '2015-10-18T12:00:00' },
              score: { base: 88, modifiers: [], semanticCap: 100, final: 88 },
            },
            {
              ...resolution.candidates[0],
              id: 'filename',
              sourceKind: 'filename' as const,
              sourceFamily: 'Filename',
              tag: 'Filename:Date',
              rawValue: '2000-08-11_19-51-59.jpg',
              value: { ...resolution.candidates[0].value, localIso: '2000-08-11T19:51:59' },
              score: { base: 30, modifiers: [], semanticCap: 40, final: 30 },
            },
          ],
        },
      },
    };
    const bridge = window.electronAPI as unknown as { reviewList: jest.Mock; reviewGet: jest.Mock };
    bridge.reviewList.mockResolvedValue({ success: true, data: { items: [conflicting] } });
    bridge.reviewGet.mockResolvedValue({ success: true, data: conflicting });

    render(<ReviewView />);

    expect(await screen.findByText(/metadata contains two different dates/i)).toBeInTheDocument();
    expect(screen.getByText(/08\/11\/2000/)).toBeInTheDocument();
    expect(screen.getByText(/10\/18\/2015/)).toBeInTheDocument();
    expect(screen.getByText(/iptc\/photoshop/i)).toBeInTheDocument();
    expect(screen.getByText(/filename.*weak context/i)).toBeInTheDocument();
    expect(screen.queryByText('STRONG_CONFLICT')).not.toBeInTheDocument();
    expect(screen.queryByText(/creation date requires review/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /camera exif date taken.*2000/i }));
    fireEvent.click(screen.getByRole('button', { name: /preview fix/i }));
    await waitFor(() => expect(bridge.reviewGet).toHaveBeenCalledWith({ reviewId: item.reviewId }));
    const dryRun = window.electronAPI as unknown as { reviewDryRun: jest.Mock };
    await waitFor(() =>
      expect(dryRun.reviewDryRun).toHaveBeenCalledWith(
        expect.objectContaining({ action: { type: 'select-candidate', candidateId: 'camera' } })
      )
    );
  });

  it('explains placeholder, missing-date, and metadata-read failures without raw codes', async () => {
    const special = {
      ...item,
      reasonCodes: [
        'MIDNIGHT_PLACEHOLDER_REVIEW',
        'INSUFFICIENT_CONFIDENCE',
        'METADATA_READ_FAILED',
      ],
      warnings: [],
      evidence: {
        ...item.evidence,
        resolution: { ...resolution, candidates: [], reasonCodes: ['MIDNIGHT_PLACEHOLDER_REVIEW'] },
      },
    };
    const bridge = window.electronAPI as unknown as { reviewList: jest.Mock; reviewGet: jest.Mock };
    bridge.reviewList.mockResolvedValue({ success: true, data: { items: [special] } });
    bridge.reviewGet.mockResolvedValue({ success: true, data: special });

    render(<ReviewView />);

    expect(await screen.findByText(/exactly midnight/i)).toBeInTheDocument();
    expect(screen.getByText(/could not read all metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/no trustworthy date/i)).toBeInTheDocument();
    expect(screen.queryByText(/MIDNIGHT_PLACEHOLDER_REVIEW/)).not.toBeInTheDocument();
  });

  it('keeps offset-only and subsecond conflicts separate and shows their exact time basis', async () => {
    const temporal = {
      ...item,
      reasonCodes: ['STRONG_CONFLICT', 'SUBSECOND_CONFLICT'],
      evidence: {
        ...item.evidence,
        resolution: {
          ...resolution,
          reasonCodes: ['STRONG_CONFLICT', 'SUBSECOND_CONFLICT'],
          candidates: [
            {
              ...resolution.candidates[0],
              id: 'east',
              value: {
                ...resolution.candidates[0].value,
                localIso: '2020-01-02T03:04:05.123',
                instantUtc: '2020-01-02T08:04:05.123Z',
                offsetMinutes: -300,
                zoneBasis: 'explicit-offset' as const,
                precision: 'millisecond' as const,
                fractionalDigits: '123',
              },
            },
            {
              ...resolution.candidates[0],
              id: 'utc',
              sourceKind: 'embedded-xmp' as const,
              sourceFamily: 'XMP',
              tag: 'XMP:CreateDate',
              value: {
                ...resolution.candidates[0].value,
                localIso: '2020-01-02T03:04:05.456',
                instantUtc: '2020-01-02T03:04:05.456Z',
                offsetMinutes: 0,
                zoneBasis: 'explicit-offset' as const,
                precision: 'millisecond' as const,
                fractionalDigits: '456',
              },
            },
          ],
        },
      },
    };
    const bridge = window.electronAPI as unknown as { reviewList: jest.Mock; reviewGet: jest.Mock };
    bridge.reviewList.mockResolvedValue({ success: true, data: { items: [temporal] } });
    bridge.reviewGet.mockResolvedValue({ success: true, data: temporal });

    render(<ReviewView />);

    expect(await screen.findByText(/03:04:05\.123.*UTC-05:00/i)).toBeInTheDocument();
    expect(screen.getByText(/03:04:05\.456.*UTC\+00:00/i)).toBeInTheDocument();
    expect(screen.getByText(/metadata disagrees within the same second/i)).toBeInTheDocument();
  });

  it('labels EXIF digitized dates by meaning and explains unknown reason codes safely', async () => {
    const unknown = {
      ...item,
      reasonCodes: ['VENDOR_PRIVATE_CONFLICT'],
      warnings: [],
      evidence: {
        ...item.evidence,
        resolution: {
          ...resolution,
          reasonCodes: ['VENDOR_PRIVATE_CONFLICT'],
          candidates: [
            {
              ...resolution.candidates[0],
              semantic: 'digitized' as const,
              tag: 'EXIF:CreateDate',
            },
          ],
        },
      },
    };
    const bridge = window.electronAPI as unknown as { reviewList: jest.Mock; reviewGet: jest.Mock };
    bridge.reviewList.mockResolvedValue({ success: true, data: { items: [unknown] } });
    bridge.reviewGet.mockResolvedValue({ success: true, data: unknown });

    render(<ReviewView />);

    expect(await screen.findByText(/camera exif date digitized/i)).toBeInTheDocument();
    expect(screen.getByText(/additional metadata conflict/i)).toBeInTheDocument();
    expect(screen.queryByText('VENDOR_PRIVATE_CONFLICT')).not.toBeInTheDocument();
  });

  it('requires Preview Fix to issue a plan token before Apply Fix', async () => {
    render(<ReviewView />);
    await screen.findByText(/camera exif date taken/i);
    const apply = screen.getByRole('button', { name: /apply fix/i });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /camera exif date taken/i }));
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
    await screen.findByText(/camera exif date taken/i);
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

  it('offers a manual calendar date without inventing a time', async () => {
    render(<ReviewView />);
    await screen.findByText(/camera exif date taken/i);
    fireEvent.change(screen.getByLabelText(/manual calendar date/i), {
      target: { value: '2021-04-05' },
    });
    expect(screen.getByLabelText(/^manual date$/i)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /preview fix/i }));
    const api = window.electronAPI as unknown as { reviewDryRun: jest.Mock };
    await waitFor(() =>
      expect(api.reviewDryRun).toHaveBeenCalledWith({
        reviewId: 'review-1',
        evidenceRevision: 'evidence-1',
        action: {
          type: 'manual-date',
          value: { localIso: '2021-04-05', zoneBasis: 'date-only', precision: 'date' },
        },
      })
    );
    expect(screen.getByText(/date is known; time remains unknown/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /camera exif date taken/i }));
    expect(screen.getByLabelText(/manual calendar date/i)).toHaveValue('');
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
    await screen.findByText(/camera exif date taken/i);
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
    await screen.findByText(/camera exif date taken/i);
    fireEvent.click(screen.getByRole('radio', { name: /camera exif date taken/i }));
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
