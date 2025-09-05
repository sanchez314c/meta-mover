import React, { useState, useEffect, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import styled, { keyframes, css } from 'styled-components';
import { AppDispatch } from '../store';
import { updateJob, setActiveJob, addJob } from '../store/slices/jobsSlice';
import { addNotification } from '../store/slices/uiSlice';

// ─── Animations ──────────────────────────────────────────────────────────────

const pulse = keyframes`
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
`;

const shimmer = keyframes`
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
`;

// ─── Styled Components ───────────────────────────────────────────────────────

const Container = styled.div`
  animation: fadeIn 200ms ease;
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
`;

const Card = styled.div`
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  padding: 24px;
  margin-bottom: 20px;
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

const HeroCard = styled(Card)`
  background:
    radial-gradient(ellipse at 80% 80%, rgba(20,184,166,0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 20% 20%, rgba(139,92,246,0.06) 0%, transparent 50%),
    var(--gradient-card);
  padding: 28px 32px;

  &::after {
    content: '';
    position: absolute;
    inset: 0;
    background-image: radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px);
    background-size: 24px 24px;
    opacity: 0.3;
    pointer-events: none;
  }
`;

const Title = styled.h2`
  font-size: 22px;
  font-weight: 700;
  color: var(--text-heading);
  margin-bottom: 4px;
  position: relative;
  z-index: 1;
  span { color: var(--accent-teal); }
`;

const Subtitle = styled.p`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  position: relative;
  z-index: 1;
`;

const FolderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  position: relative;
  z-index: 1;
`;

const FolderLabel = styled.span`
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  min-width: 80px;
`;

const FolderPath = styled.div`
  flex: 1;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-input, 6px);
  color: var(--text-secondary);
  font-size: 13px;
  min-height: 40px;
  display: flex;
  align-items: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const BrowseBtn = styled.button`
  padding: 10px 18px;
  background: var(--glass-bg);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-button);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 150ms ease;

  &:hover { background: var(--bg-card-hover); color: var(--text-primary); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const StartBtn = styled.button`
  width: 100%;
  padding: 14px;
  background: var(--gradient-button);
  color: var(--bg-void);
  border: none;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
  margin-top: 16px;
  position: relative;
  z-index: 1;
  transition: all 150ms ease;

  &:hover { transform: translateY(-1px); box-shadow: var(--shadow-glow-strong); }
  &:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
`;

const CancelBtn = styled.button`
  width: 100%;
  padding: 12px;
  background: var(--status-error);
  color: #ffffff;
  border: none;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  margin-top: 12px;
  transition: all 150ms ease;
  &:hover { opacity: 0.9; }
`;

const ProgressSection = styled.div`
  margin-top: 20px;
  position: relative;
  z-index: 1;
`;

const ProgressBarTrack = styled.div`
  width: 100%;
  height: 10px;
  background: var(--bg-input);
  border-radius: 5px;
  overflow: hidden;
  margin-bottom: 10px;
`;

const ProgressBarFill = styled.div<{ $percent: number; $indeterminate: boolean }>`
  height: 100%;
  border-radius: 5px;
  transition: width 300ms ease;
  ${({ $indeterminate, $percent }) =>
    $indeterminate
      ? css`
    width: 100%;
    background: linear-gradient(90deg, transparent, var(--accent-teal), transparent);
    background-size: 200% 100%;
    animation: ${shimmer} 1.5s ease-in-out infinite;
  `
      : css`
    width: ${$percent}%;
    background: var(--gradient-button);
  `}
`;

const ProgressInfo = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 4px;
`;

const PhaseLabel = styled.span`
  color: var(--accent-teal);
  font-weight: 500;
  text-transform: capitalize;
`;

const ProgressDetail = styled.div`
  font-size: 11px;
  color: var(--text-dim);
  display: flex;
  gap: 16px;
  margin-top: 2px;
`;

const DetailItem = styled.span<{ $warn?: boolean }>`
  color: ${({ $warn }) => ($warn ? 'var(--status-warning)' : 'var(--text-dim)')};
`;

const CurrentFile = styled.div`
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  animation: ${pulse} 2s ease-in-out infinite;
`;

const SummaryCard = styled(Card)`
  border-left: 3px solid var(--accent-teal);
`;

const SummaryTitle = styled.h3`
  font-size: 16px;
  font-weight: 600;
  color: var(--text-heading);
  margin-bottom: 16px;
`;

const StatGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
`;

const StatBox = styled.div`
  text-align: center;
  padding: 12px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md, 8px);
`;

const StatValue = styled.div`
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--accent-teal);
`;

const StatLabel = styled.div`
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  margin-top: 2px;
`;

const ResetBtn = styled.button`
  width: 100%;
  padding: 12px;
  background: var(--glass-bg);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-button);
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 150ms ease;
  &:hover { background: var(--bg-card-hover); color: var(--text-primary); }
`;

const WarningBanner = styled.div`
  background: rgba(245,158,11,0.1);
  border: 1px solid rgba(245,158,11,0.3);
  border-radius: var(--radius-md, 8px);
  padding: 14px 18px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--status-warning);
  position: relative;
  z-index: 1;

  strong { display: block; margin-bottom: 4px; }
  ul { margin: 6px 0 0 18px; padding: 0; }
  li { margin-bottom: 2px; color: var(--text-secondary); }
`;

const ErrorBanner = styled.div`
  background: rgba(239,68,68,0.1);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: var(--radius-md, 8px);
  padding: 14px 18px;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--status-error);
  position: relative;
  z-index: 1;
`;

// ─── Types ───────────────────────────────────────────────────────────────────

interface DepStatus {
  python: boolean;
  exiftool: boolean;
  errors: string[];
}

interface Progress {
  phase: string;
  filesProcessed: number;
  totalFiles: number;
  percentage: number;
  corruptFiles: number;
  errors: number;
  currentFile: string;
}

interface Statistics {
  totalProcessed: number;
  totalFound: number;
  totalElapsed: number;
  filesPerSecond: number;
  corruptFiles: number;
  errorFiles: number;
  finalSweepCount: number;
  interrupted: boolean;
}

type ViewState = 'idle' | 'processing' | 'completed' | 'error';

// ─── Component ───────────────────────────────────────────────────────────────

export function ProcessingLauncher() {
  const dispatch = useDispatch<AppDispatch>();

  const [viewState, setViewState] = useState<ViewState>('idle');
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [destPath, setDestPath] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [deps, setDeps] = useState<DepStatus | null>(null);
  const [progress, setProgress] = useState<Progress>({
    phase: '',
    filesProcessed: 0,
    totalFiles: 0,
    percentage: 0,
    corruptFiles: 0,
    errors: 0,
    currentFile: '',
  });
  const [statistics, setStatistics] = useState<Statistics | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Check dependencies on mount
  useEffect(() => {
    if (!window.electronAPI?.checkDependencies) return;
    window.electronAPI.checkDependencies().then((result: unknown) => {
      const r = result as DepStatus;
      if (r && typeof r.python === 'boolean') {
        setDeps(r);
      }
    }).catch(() => {
      // checkDependencies not available yet
    });
  }, []);

  // IPC listeners
  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.onProgress((data: Record<string, unknown>) => {
      const p: Progress = {
        phase: typeof data.phase === 'string' ? data.phase : '',
        filesProcessed: typeof data.filesProcessed === 'number' ? data.filesProcessed : 0,
        totalFiles: typeof data.totalFiles === 'number' ? data.totalFiles : 0,
        percentage: typeof data.percentage === 'number' ? data.percentage : 0,
        corruptFiles: typeof data.corruptFiles === 'number' ? data.corruptFiles : 0,
        errors: typeof data.errors === 'number' ? data.errors : 0,
        currentFile: typeof data.currentFile === 'string' ? data.currentFile : '',
      };
      setProgress(p);

      if (data.jobId && typeof data.jobId === 'string') {
        dispatch(updateJob({
          id: data.jobId,
          progress: p.percentage >= 0 ? p.percentage : 0,
          filesProcessed: p.filesProcessed,
          totalFiles: p.totalFiles,
        }));
      }
    });

    window.electronAPI.onProcessingComplete((data: Record<string, unknown>) => {
      setViewState('completed');
      const stats = data.statistics as Statistics | undefined;
      if (stats) setStatistics(stats);

      if (data.jobId && typeof data.jobId === 'string') {
        dispatch(updateJob({
          id: data.jobId,
          status: 'completed',
          endTime: new Date().toISOString(),
        }));
        dispatch(setActiveJob(null));
        dispatch(addNotification({
          id: Date.now().toString(),
          type: 'success',
          message: `Processing complete: ${stats?.totalProcessed ?? 0} files organized`,
          duration: 8000,
        }));
      }
    });

    window.electronAPI.onProcessingError((data: Record<string, unknown>) => {
      setViewState('error');
      const msg = typeof data.message === 'string' ? data.message : 'Processing failed';
      setErrorMessage(msg);

      if (data.jobId && typeof data.jobId === 'string') {
        dispatch(updateJob({
          id: data.jobId,
          status: 'failed',
          error: msg,
          endTime: new Date().toISOString(),
        }));
        dispatch(setActiveJob(null));
      }
    });

    return () => {
      window.electronAPI?.removeProcessingListeners();
    };
  }, [dispatch]);

  const selectSource = useCallback(async () => {
    if (!window.electronAPI) return;
    const p = await window.electronAPI.selectDirectory();
    if (p) setSourcePath(p);
  }, []);

  const selectDest = useCallback(async () => {
    if (!window.electronAPI) return;
    const p = await window.electronAPI.selectDirectory();
    if (p) setDestPath(p);
  }, []);

  const startProcessing = useCallback(async () => {
    if (!window.electronAPI || !sourcePath || !destPath) return;
    setViewState('processing');
    setErrorMessage(null);
    setStatistics(null);
    setProgress({ phase: '', filesProcessed: 0, totalFiles: 0, percentage: 0, corruptFiles: 0, errors: 0, currentFile: '' });

    try {
      const result = await window.electronAPI.startProcessing({
        sourcePath,
        destinationPath: destPath,
      }) as Record<string, unknown>;

      if (result?.success && typeof result.jobId === 'string') {
        setActiveJobId(result.jobId);
        dispatch(addJob({
          id: result.jobId,
          type: 'organize',
          status: 'processing',
          progress: 0,
          filesProcessed: 0,
          totalFiles: 0,
          startTime: new Date().toISOString(),
        }));
        dispatch(setActiveJob(result.jobId));
      } else {
        setViewState('error');
        setErrorMessage(typeof result?.error === 'string' ? result.error : 'Failed to start processing');
      }
    } catch {
      setViewState('error');
      setErrorMessage('Failed to start processing');
    }
  }, [sourcePath, destPath, dispatch]);

  const cancelProcessing = useCallback(async () => {
    if (!window.electronAPI || !activeJobId) return;
    await window.electronAPI.cancelProcessing(activeJobId);
    setViewState('idle');
    setActiveJobId(null);
  }, [activeJobId]);

  const reset = useCallback(() => {
    setViewState('idle');
    setActiveJobId(null);
    setStatistics(null);
    setErrorMessage(null);
    setProgress({ phase: '', filesProcessed: 0, totalFiles: 0, percentage: 0, corruptFiles: 0, errors: 0, currentFile: '' });
  }, []);

  const depsOk = deps === null || (deps.python && deps.exiftool);
  const canStart = !!sourcePath && !!destPath && depsOk && viewState === 'idle';

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs.toFixed(0)}s`;
  };

  return (
    <Container>
      {/* Main processing card */}
      <HeroCard>
        <Title>
          <span>META</span> Mover
        </Title>
        <Subtitle>Select source and destination folders to organize your media files.</Subtitle>

        {/* Dependency warning */}
        {deps && (!deps.python || !deps.exiftool) && (
          <WarningBanner>
            <strong>Missing Dependencies</strong>
            <ul>
              {deps.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </WarningBanner>
        )}

        {/* Error banner */}
        {viewState === 'error' && errorMessage && (
          <ErrorBanner>{errorMessage}</ErrorBanner>
        )}

        {/* Folder pickers */}
        <FolderRow>
          <FolderLabel>Source</FolderLabel>
          <FolderPath>{sourcePath || 'Select source folder...'}</FolderPath>
          <BrowseBtn onClick={selectSource} disabled={viewState === 'processing'}>Browse</BrowseBtn>
        </FolderRow>

        <FolderRow>
          <FolderLabel>Destination</FolderLabel>
          <FolderPath>{destPath || 'Select destination folder...'}</FolderPath>
          <BrowseBtn onClick={selectDest} disabled={viewState === 'processing'}>Browse</BrowseBtn>
        </FolderRow>

        {/* Processing state */}
        {viewState === 'processing' && (
          <ProgressSection>
            <ProgressInfo>
              <PhaseLabel>{progress.phase || 'Starting...'}</PhaseLabel>
              <span>
                {progress.filesProcessed} / {progress.totalFiles} files
                {progress.percentage > 0 && ` (${Math.round(progress.percentage)}%)`}
              </span>
            </ProgressInfo>
            <ProgressBarTrack>
              <ProgressBarFill
                $percent={progress.percentage}
                $indeterminate={progress.percentage <= 0}
              />
            </ProgressBarTrack>
            <ProgressDetail>
              {progress.corruptFiles > 0 && (
                <DetailItem $warn>Corrupt: {progress.corruptFiles}</DetailItem>
              )}
              {progress.errors > 0 && (
                <DetailItem $warn>Errors: {progress.errors}</DetailItem>
              )}
            </ProgressDetail>
            {progress.currentFile && (
              <CurrentFile>{progress.currentFile}</CurrentFile>
            )}
            <CancelBtn onClick={cancelProcessing}>Cancel Processing</CancelBtn>
          </ProgressSection>
        )}

        {/* Idle state */}
        {(viewState === 'idle' || viewState === 'error') && (
          <StartBtn onClick={startProcessing} disabled={!canStart}>
            Start Processing
          </StartBtn>
        )}
      </HeroCard>

      {/* Completion summary */}
      {viewState === 'completed' && statistics && (
        <SummaryCard>
          <SummaryTitle>Processing Complete</SummaryTitle>
          <StatGrid>
            <StatBox>
              <StatValue>{statistics.totalProcessed}</StatValue>
              <StatLabel>Files Processed</StatLabel>
            </StatBox>
            <StatBox>
              <StatValue>{statistics.totalFound}</StatValue>
              <StatLabel>Total Found</StatLabel>
            </StatBox>
            <StatBox>
              <StatValue>{formatTime(statistics.totalElapsed)}</StatValue>
              <StatLabel>Time Elapsed</StatLabel>
            </StatBox>
            <StatBox>
              <StatValue>{statistics.filesPerSecond.toFixed(1)}</StatValue>
              <StatLabel>Files / Second</StatLabel>
            </StatBox>
            <StatBox>
              <StatValue>{statistics.corruptFiles}</StatValue>
              <StatLabel>Corrupt Files</StatLabel>
            </StatBox>
            <StatBox>
              <StatValue>{statistics.errorFiles}</StatValue>
              <StatLabel>Errors</StatLabel>
            </StatBox>
          </StatGrid>
          {statistics.interrupted && (
            <ErrorBanner>Processing was interrupted before completion.</ErrorBanner>
          )}
          <ResetBtn onClick={reset}>Organize Again</ResetBtn>
        </SummaryCard>
      )}
    </Container>
  );
}
