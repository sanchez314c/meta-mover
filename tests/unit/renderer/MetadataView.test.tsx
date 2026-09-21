import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MetadataView } from '../../../src/renderer/components/views/MetadataView';

describe('MetadataView', () => {
  beforeEach(() => {
    localStorage.clear();
    window.electronAPI = {
      getNormalizationAuditSummary: jest.fn(async () => ({
        success: true,
        data: {
          revision: 'revision-1',
          total: 15000,
          dispositions: {
            'auto-normalize': 4200,
            'normalize-after-cohort-approval': 10300,
            'manual-review': 300,
            'quarantine-unresolved': 200,
          },
        },
      })),
      getNormalizationAuditCohorts: jest.fn(async () => ({
        success: true,
        data: {
          revision: 'revision-1',
          items: [
            {
              cohortKey: 'cohort-1',
              count: 10300,
              dispositions: { 'normalize-after-cohort-approval': 10300 },
            },
          ],
        },
      })),
      getNormalizationAuditRows: jest.fn(async () => ({
        success: true,
        data: {
          revision: 'revision-1',
          items: [
            {
              recordId: 'row-1',
              sourcePath: '/source/photo.jpg',
              outputPath: '/output/photo.jpg',
              mediaKind: 'image',
              extension: '.jpg',
              confidence: 'high',
              resolutionStatus: 'resolved',
              disposition: 'auto-normalize',
              reasonCodes: ['INDEPENDENT_CORROBORATION'],
              cohortKey: 'cohort-safe',
              policyDigest: 'policy',
              transformDigest: 'transform',
              resolutionPolicyVersion: 'date-resolution/1',
            },
          ],
        },
      })),
      getNormalizationAuditSample: jest.fn(async () => ({
        success: true,
        data: { revision: 'revision-1', items: [] },
      })),
      approveNormalizationAuditCohort: jest.fn(async () => ({ success: true, data: {} })),
      dryRunNormalizationAudit: jest.fn(async () => ({
        success: true,
        data: { revision: 'revision-1', items: [] },
      })),
      openPath: jest.fn(async () => ({ success: true })),
    } as never;
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  it('loads a bounded durable audit with cohorts and review rows', async () => {
    localStorage.setItem('meta-mover:last-preview-id', 'preview-1');
    render(<MetadataView />);

    await waitFor(() => expect(screen.getByText('15,000')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Normalization audit' })).toBeInTheDocument();
    expect(screen.getByText('4,200')).toBeInTheDocument();
    expect(screen.getAllByText('10,300')).toHaveLength(2);
    expect(screen.getByText('/output/photo.jpg')).toBeInTheDocument();
    expect(screen.getByText(/cohort-1/i)).toBeInTheDocument();
    expect(window.electronAPI?.getNormalizationAuditRows).toHaveBeenCalledWith({
      previewId: 'preview-1',
      limit: 50,
    });
  });

  it('approves a cohort against the loaded immutable revision and runs a dry audit', async () => {
    localStorage.setItem('meta-mover:last-preview-id', 'preview-1');
    (window.electronAPI?.dryRunNormalizationAudit as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        revision: 'revision-1',
        items: [{
          recordId: 'row-1', sourcePath: '/source/photo.jpg', outputPath: '/output/photo.jpg',
          mediaKind: 'image', extension: '.jpg', confidence: 'high', resolutionStatus: 'resolved',
          disposition: 'auto-normalize', reasonCodes: [], cohortKey: 'cohort-safe',
          policyDigest: 'policy', transformDigest: 'transform', resolutionPolicyVersion: 'date-resolution/1',
          metadataChanges: [{ tag: 'ExifIFD:DateTimeOriginal', before: '2020:01:02 03:04:05', after: '2020:01:02 03:04:05' }],
        }],
      },
    });
    render(<MetadataView />);
    await screen.findByText(/cohort-1/i);

    fireEvent.click(screen.getByRole('button', { name: /approve cohort/i }));
    await waitFor(() =>
      expect(window.electronAPI?.approveNormalizationAuditCohort).toHaveBeenCalledWith({
        previewId: 'preview-1',
        revision: 'revision-1',
        cohortKey: 'cohort-1',
        approved: true,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /build normalization dry run/i }));
    await waitFor(() =>
      expect(window.electronAPI?.dryRunNormalizationAudit).toHaveBeenCalledWith({
        previewId: 'preview-1',
        revision: 'revision-1',
        limit: 50,
      })
    );
    expect(await screen.findByText('ExifIFD:DateTimeOriginal')).toBeInTheDocument();
    expect(screen.getByText('2020:01:02 03:04:05 → 2020:01:02 03:04:05')).toBeInTheDocument();
  });
});
