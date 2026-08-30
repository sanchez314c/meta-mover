import React, { useEffect, useState } from 'react';
import styled from 'styled-components';

import type { JobHistoryDTO } from '../../../shared/types/processing';

const ViewContainer = styled.div`
  animation: fadeIn 200ms ease;
  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
`;
const HistoryCard = styled.section`
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  padding: 24px;
  box-shadow: var(--shadow-card);
`;
const CardTitle = styled.h3`
  margin: 0 0 16px;
  color: var(--text-heading);
  font-size: 16px;
`;
const JobList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;
const JobItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 12px 16px;
  background: var(--bg-card, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md, 8px);
  font-size: 13px;
`;
const JobInfo = styled.div`
  min-width: 0;
`;
const JobTitle = styled.div`
  overflow: hidden;
  color: var(--text-primary);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const JobMeta = styled.div`
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 12px;
`;
const FailureList = styled.ul`
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--status-error);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
`;
const JobStatus = styled.span<{ $status: JobHistoryDTO['status'] }>`
  flex-shrink: 0;
  padding: 3px 10px;
  border-radius: var(--radius-full, 999px);
  font-size: 11px;
  font-weight: 500;
  background: ${({ $status }) =>
    $status === 'completed'
      ? 'rgba(16,185,129,0.15)'
      : $status === 'failed' || $status === 'partial'
        ? 'rgba(239,68,68,0.15)'
        : ['queued', 'processing', 'cancelling'].includes($status)
          ? 'rgba(245,158,11,0.15)'
          : 'rgba(92,92,106,0.15)'};
  color: ${({ $status }) =>
    $status === 'completed'
      ? 'var(--status-success)'
      : $status === 'failed' || $status === 'partial'
        ? 'var(--status-error)'
        : ['queued', 'processing', 'cancelling'].includes($status)
          ? 'var(--status-warning)'
          : 'var(--text-muted)'};
`;
const StateMessage = styled.div<{ $error?: boolean }>`
  padding: 40px 20px;
  color: ${({ $error }) => ($error ? 'var(--status-error)' : 'var(--text-muted)')};
  text-align: center;
  font-size: 14px;
`;

function cancellationMeta(job: JobHistoryDTO): string {
  const statistics = job.statistics;
  if (!statistics || !('cancelledFiles' in statistics)) {
    return `${job.progress.filesProcessed}/${job.progress.totalFiles} files succeeded`;
  }
  return `${job.progress.filesProcessed} succeeded, ${statistics.cancelledFiles} cancelled, ${statistics.unattemptedFiles} not attempted, ${statistics.committedResidueBytes} residue bytes`;
}

export function ProcessingView() {
  const [jobs, setJobs] = useState<JobHistoryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadJobs = async () => {
      const api = window.electronAPI;
      if (!api) {
        if (mounted) {
          setError('The secure application bridge is unavailable.');
          setLoading(false);
        }
        return;
      }
      try {
        const response = await api.getJobHistory(20);
        if (!mounted) return;
        if (!response.success || !response.data) {
          setError(response.error?.message ?? 'Job history could not be loaded.');
        } else {
          setJobs(response.data);
        }
      } catch (loadError) {
        if (mounted) {
          setError(
            loadError instanceof Error ? loadError.message : 'Job history could not be loaded.'
          );
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void loadJobs();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <ViewContainer>
      <HistoryCard>
        <CardTitle>Job History</CardTitle>
        {loading ? (
          <StateMessage>Loading persisted history...</StateMessage>
        ) : error ? (
          <StateMessage $error>{error}</StateMessage>
        ) : jobs.length === 0 ? (
          <StateMessage>No processing jobs yet. Use the Organize tab to get started.</StateMessage>
        ) : (
          <JobList>
            {jobs.map((job) => (
              <JobItem key={job.jobId}>
                <JobInfo>
                  <JobTitle>
                    {job.effectiveOptions.operation === 'move' ? 'Move' : 'Copy'} to{' '}
                    {job.destinationPath}
                  </JobTitle>
                  <JobMeta>
                    {job.status === 'cancelled'
                      ? cancellationMeta(job)
                      : (job.statistics?.failedFiles ?? 0) > 0
                        ? `${job.progress.filesProcessed} succeeded, ${(job.statistics?.skippedFiles ?? 0) > 0 ? `${job.statistics?.skippedFiles} skipped, ` : ''}${job.statistics?.failedFiles ?? 0} failed, ${job.progress.totalFiles} total`
                        : `${job.progress.filesProcessed}/${job.progress.totalFiles} files succeeded`}
                    {' | '}
                    {new Date(job.createdAt).toLocaleString()}
                  </JobMeta>
                  {job.fileFailures && job.fileFailures.length > 0 && (
                    <FailureList aria-label="Failed files">
                      {job.fileFailures.map((failure) => (
                        <li key={`${failure.sourcePath}:${failure.error}`}>
                          {failure.sourcePath}: {failure.error}
                        </li>
                      ))}
                    </FailureList>
                  )}
                  {job.cancellationOutcomes && job.cancellationOutcomes.length > 0 && (
                    <FailureList aria-label="Cancellation file outcomes">
                      {job.cancellationOutcomes.map((outcome) => (
                        <li
                          key={`${outcome.sourcePath}:${outcome.destinationPath}:${outcome.state}`}
                        >
                          {outcome.sourcePath} → {outcome.destinationPath ?? '(no destination)'}:{' '}
                          {outcome.state}, {outcome.committedBytes} bytes committed,
                          {outcome.sourceRetained ? ' source retained' : ' source removed'}
                          {outcome.error ? `, ${outcome.error}` : ''}
                        </li>
                      ))}
                    </FailureList>
                  )}
                </JobInfo>
                <JobStatus $status={job.status}>{job.status}</JobStatus>
              </JobItem>
            ))}
          </JobList>
        )}
      </HistoryCard>
    </ViewContainer>
  );
}
