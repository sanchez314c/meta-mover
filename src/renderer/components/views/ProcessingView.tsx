import React, { useState, useEffect } from 'react';
import styled from 'styled-components';

const ViewContainer = styled.div`
  animation: fadeIn 200ms ease;
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
`;

const HistoryCard = styled.div`
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  padding: 24px;
  box-shadow: var(--shadow-card);
  position: relative;
  overflow: hidden;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--glass-highlight), transparent);
    pointer-events: none;
  }
`;

const CardTitle = styled.h3`
  font-size: 16px;
  font-weight: 600;
  color: var(--text-heading);
  margin-bottom: 16px;
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
  padding: 12px 16px;
  background: var(--bg-card, rgba(255,255,255,0.02));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md, 8px);
  font-size: 13px;
  transition: all 150ms ease;
  &:hover { border-color: var(--border-light); }
`;

const JobInfo = styled.div``;

const JobTitle = styled.div`
  color: var(--text-primary);
  font-weight: 500;
`;

const JobMeta = styled.div`
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 2px;
`;

const JobStatus = styled.span<{ $status: string }>`
  padding: 3px 10px;
  border-radius: var(--radius-full, 999px);
  font-size: 11px;
  font-weight: 500;
  background: ${({ $status }) =>
    $status === 'completed' ? 'rgba(16,185,129,0.15)'
    : $status === 'failed' ? 'rgba(239,68,68,0.15)'
    : $status === 'processing' ? 'rgba(245,158,11,0.15)'
    : 'rgba(92,92,106,0.15)'};
  color: ${({ $status }) =>
    $status === 'completed' ? 'var(--status-success)'
    : $status === 'failed' ? 'var(--status-error)'
    : $status === 'processing' ? 'var(--status-warning)'
    : 'var(--text-muted)'};
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 40px 20px;
  color: var(--text-muted);
  font-size: 14px;
`;

export function ProcessingView() {
  const [jobs, setJobs] = useState<Record<string, unknown>[]>([]);

  useEffect(() => {
    loadJobs();
  }, []);

  async function loadJobs() {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.getJobs(20);
      if (Array.isArray(result)) setJobs(result);
    } catch {
      // Jobs API may not be available yet
    }
  }

  return (
    <ViewContainer>
      <HistoryCard>
        <CardTitle>Job History</CardTitle>
        {jobs.length === 0 ? (
          <EmptyState>No processing jobs yet. Use the Organize tab to get started.</EmptyState>
        ) : (
          <JobList>
            {jobs.map((job) => {
              const jobId = typeof job.id === 'string' ? job.id : String(job.id ?? '');
              const jobType = typeof job.type === 'string' ? job.type : 'Processing';
              const filesProcessed = typeof job.filesProcessed === 'number' ? job.filesProcessed : 0;
              const totalFiles = typeof job.totalFiles === 'number' ? job.totalFiles : 0;
              const startTime = typeof job.startTime === 'string' ? job.startTime : null;
              const jobStatus = typeof job.status === 'string' ? job.status : 'unknown';
              return (
                <JobItem key={jobId}>
                  <JobInfo>
                    <JobTitle>{jobType}</JobTitle>
                    <JobMeta>
                      {filesProcessed}/{totalFiles} files
                      {startTime && ` — ${new Date(startTime).toLocaleDateString()}`}
                    </JobMeta>
                  </JobInfo>
                  <JobStatus $status={jobStatus}>{jobStatus}</JobStatus>
                </JobItem>
              );
            })}
          </JobList>
        )}
      </HistoryCard>
    </ViewContainer>
  );
}
