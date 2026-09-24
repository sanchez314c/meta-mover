import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import styled from 'styled-components';

import type { AppConfig } from '../../main/services/AppConfigStore';
import type { TestRunProgress } from '../../main/services/TestRunCorpusBuilder';
import type {
  DependencyHealthDTO,
  PreviewResultDTO,
  ProcessingOptionsDTO,
  PreviewRowDTO,
} from '../../shared/types/processing';
import type { AppDispatch, RootState } from '../store';
import { clearPreviewBuild } from '../store/slices/jobsSlice';

const Container = styled.div`
  display: grid;
  gap: 20px;
  animation: fadeIn 180ms ease;
  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
`;
const Card = styled.section`
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  padding: 24px;
  box-shadow: var(--shadow-card);
`;
const HeroCard = styled(Card)`
  background:
    radial-gradient(ellipse at 80% 80%, rgba(20, 184, 166, 0.08), transparent 50%),
    radial-gradient(ellipse at 20% 20%, rgba(139, 92, 246, 0.06), transparent 50%),
    var(--gradient-card);
`;
const Title = styled.h2`
  margin: 0 0 6px;
  color: var(--text-heading);
  font-size: 22px;
  span {
    color: var(--accent-teal);
  }
`;
const Subtitle = styled.p`
  margin: 0 0 20px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.55;
`;
const FolderRow = styled.div`
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
`;
const FolderLabel = styled.span`
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.8px;
  text-transform: uppercase;
`;
const FolderPath = styled.div`
  min-height: 40px;
  display: flex;
  align-items: center;
  padding: 9px 12px;
  overflow: hidden;
  color: var(--text-secondary);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-button);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const SourceList = styled.ul`
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
`;
const SourceItem = styled.li`
  min-height: 40px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 12px;
  color: var(--text-secondary);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-button);
  font-size: 13px;
`;
const SourcePath = styled.span`
  overflow-wrap: anywhere;
`;
const RemoveSourceButton = styled.button`
  padding: 5px 8px;
  color: var(--status-warning);
  background: transparent;
  border: 1px solid currentColor;
  border-radius: var(--radius-button);
  cursor: pointer;
  font-size: 11px;
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
`;
const Button = styled.button<{ $danger?: boolean }>`
  padding: 10px 18px;
  color: ${({ $danger }) => ($danger ? '#fff' : 'var(--bg-void)')};
  background: ${({ $danger }) => ($danger ? 'var(--status-error)' : 'var(--gradient-button)')};
  border: 0;
  border-radius: var(--radius-button);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition:
    opacity 140ms ease,
    transform 140ms ease;
  &:hover:not(:disabled) {
    transform: translateY(-1px);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
`;
const BrowseButton = styled(Button)`
  color: var(--text-secondary);
  background: var(--glass-bg);
  border: 1px solid var(--border-light);
`;
const FullButton = styled(Button)`
  width: 100%;
  margin-top: 16px;
  padding: 13px;
`;
const Banner = styled.div<{ $tone: 'ready' | 'warning' | 'error' }>`
  margin: 14px 0;
  padding: 12px 14px;
  color: ${({ $tone }) =>
    $tone === 'ready'
      ? 'var(--status-success)'
      : $tone === 'warning'
        ? 'var(--status-warning)'
        : 'var(--status-error)'};
  background: ${({ $tone }) =>
    $tone === 'ready'
      ? 'rgba(16,185,129,0.08)'
      : $tone === 'warning'
        ? 'rgba(245,158,11,0.08)'
        : 'rgba(239,68,68,0.08)'};
  border: 1px solid currentColor;
  border-radius: var(--radius-md);
  font-size: 12px;
  line-height: 1.5;
  ul {
    margin: 6px 0 0 18px;
    padding: 0;
    color: var(--text-secondary);
  }
`;
const CardTitle = styled.h3`
  margin: 0 0 14px;
  color: var(--text-heading);
  font-size: 16px;
`;
const StatGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 18px;
`;
const Stat = styled.div`
  padding: 12px;
  text-align: center;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  strong {
    display: block;
    color: var(--accent-teal);
    font-size: 21px;
  }
  span {
    color: var(--text-muted);
    font-size: 10px;
    text-transform: uppercase;
  }
`;
const TableWrap = styled.div`
  overflow-x: auto;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
`;
const PreviewTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  th,
  td {
    padding: 10px;
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
  }
  th {
    color: var(--text-muted);
    font-size: 10px;
    text-transform: uppercase;
  }
  td {
    color: var(--text-secondary);
    vertical-align: top;
  }
  tr:last-child td {
    border-bottom: 0;
  }
`;
const PathCell = styled.div`
  max-width: 300px;
  overflow-wrap: anywhere;
  color: var(--text-primary);
`;
const WarningList = styled.ul`
  margin: 4px 0 0 16px;
  padding: 0;
  color: var(--status-warning);
`;
const Confirmation = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 16px;
  padding: 14px;
  color: var(--status-warning);
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: var(--radius-md);
  font-size: 12px;
  line-height: 1.5;
  input {
    margin-top: 2px;
  }
`;
const ProgressTrack = styled.div`
  height: 10px;
  overflow: hidden;
  background: var(--bg-input);
  border-radius: 999px;
`;
const ProgressFill = styled.div<{ $percentage: number; $indeterminate?: boolean }>`
  width: ${({ $percentage, $indeterminate }) =>
    $indeterminate ? '35%' : `${Math.max(0, Math.min(100, $percentage))}%`};
  height: 100%;
  background: var(--gradient-button);
  transition: width 180ms ease;
  animation: ${({ $indeterminate }) =>
    $indeterminate ? 'previewScan 1.1s ease-in-out infinite' : 'none'};
  @keyframes previewScan {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(300%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    animation: none;
    transform: none;
  }
`;
const ProgressCopy = styled.div`
  display: flex;
  justify-content: space-between;
  margin: 10px 0;
  color: var(--text-secondary);
  font-size: 12px;
`;
const ActionRow = styled.div`
  display: flex;
  gap: 10px;
  margin-top: 16px;
  button {
    flex: 1;
  }
`;
const CurrentFile = styled.div`
  display: grid;
  gap: 5px;
  margin: 12px 0 0;
  padding: 10px 12px;
  color: var(--text-secondary);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  font-size: 12px;
  strong {
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.7px;
    text-transform: uppercase;
  }
  span {
    overflow-wrap: anywhere;
    color: var(--text-primary);
  }
`;
const FailureList = styled.ul`
  margin: 12px 0 0;
  padding-left: 20px;
  color: var(--status-error);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
`;

type Stage = 'select' | 'gathering' | 'previewing' | 'preview' | 'starting' | 'running';

function optionsFromConfig(config: AppConfig): ProcessingOptionsDTO {
  return {
    operation: config.processing.operation,
    conflictPolicy: config.organization.conflictPolicy,
    folderStructure: config.organization.folderStructure,
    appendScreenshotSuffix: config.organization.appendScreenshotSuffix,
    workerCount: config.processing.workerCount,
    verifyIntegrity: true,
    writeMetadataDates: config.processing.writeMetadataDates,
  };
}

function processingOptionsMatch(left: ProcessingOptionsDTO, right: ProcessingOptionsDTO): boolean {
  return (
    left.operation === right.operation &&
    left.conflictPolicy === right.conflictPolicy &&
    left.folderStructure === right.folderStructure &&
    left.appendScreenshotSuffix === right.appendScreenshotSuffix &&
    left.workerCount === right.workerCount &&
    left.verifyIntegrity === right.verifyIntegrity &&
    left.writeMetadataDates === right.writeMetadataDates
  );
}

function isRetainedTestCorpus(sourcePath: string | undefined): boolean {
  return (
    sourcePath !== undefined &&
    /(?:^|[\\/])\.meta-mover-test-runs[\\/]run-[^\\/]+[\\/]source$/.test(sourcePath)
  );
}

function rowWarnings(row: PreviewRowDTO): string[] {
  return Array.from(new Set([...row.dateEvidence.warnings, ...row.warnings]));
}

function displayFilename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

export function ProcessingLauncher() {
  const dispatch = useDispatch<AppDispatch>();
  const jobs = useSelector((state: RootState) => state.jobs.jobs);
  const reduxActiveJobId = useSelector((state: RootState) => state.jobs.activeJobId);
  const previewBuild = useSelector((state: RootState) => state.jobs.previewBuild);
  const [stage, setStage] = useState<Stage>(
    reduxActiveJobId ? 'running' : previewBuild?.status === 'previewing' ? 'previewing' : 'select'
  );
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  const [destinationPath, setDestinationPath] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<DependencyHealthDTO | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResultDTO | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(reduxActiveJobId);
  const [moveAcknowledged, setMoveAcknowledged] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [previewCancelPending, setPreviewCancelPending] = useState(false);
  const [temporarySourcePath, setTemporarySourcePath] = useState<string | null>(null);
  const [testRunProgress, setTestRunProgress] = useState<TestRunProgress | null>(null);
  const previewRequestInFlight = useRef(false);

  const activeJob = useMemo(() => jobs.find((job) => job.id === activeJobId), [activeJobId, jobs]);

  useEffect(() => {
    if (reduxActiveJobId) {
      setActiveJobId(reduxActiveJobId);
      setStage('running');
    }
  }, [reduxActiveJobId]);

  useEffect(() => {
    if (previewBuild?.status === 'previewing' && stage === 'select') {
      setStage('previewing');
      return;
    }
    if (
      (previewBuild?.status === 'failed' || previewBuild?.status === 'cancelled') &&
      stage === 'previewing' &&
      !previewRequestInFlight.current
    ) {
      setPreviewCancelPending(false);
      setStage('select');
    }
  }, [previewBuild?.status, stage]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const api = window.electronAPI;
      if (!api) {
        if (mounted) setStartupError('The secure application bridge is unavailable.');
        return;
      }
      try {
        const [configResponse, healthResponse] = await Promise.all([
          api.getConfig(),
          api.getProcessingHealth(),
        ]);
        if (!mounted) return;
        if (!configResponse.success || !configResponse.data) {
          setStartupError(
            configResponse.error?.message ?? 'Processing settings could not be loaded.'
          );
          return;
        }
        if (!healthResponse.success || !healthResponse.data) {
          setStartupError(
            healthResponse.error?.message ?? 'Bundled runtime health could not be verified.'
          );
          return;
        }
        setConfig(configResponse.data);
        setHealth(healthResponse.data);
      } catch (error) {
        if (mounted)
          setStartupError(error instanceof Error ? error.message : 'Startup checks failed.');
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => window.electronAPI?.onTestRunProgress(setTestRunProgress), []);

  useEffect(() => {
    const receiveConfig = (event: Event) => {
      const updated = (event as CustomEvent<AppConfig>).detail;
      if (updated?.version === 3) setConfig(updated);
    };
    window.addEventListener('meta-mover:config-updated', receiveConfig);
    return () => window.removeEventListener('meta-mover:config-updated', receiveConfig);
  }, []);

  const invalidatePreview = useCallback(() => {
    dispatch(clearPreviewBuild());
    setPreview(null);
    setMoveAcknowledged(false);
    setActionError(null);
    setActionNotice(null);
    setStage('select');
  }, [dispatch]);

  const selectSource = useCallback(async () => {
    const selected = await window.electronAPI?.selectDirectory();
    if (selected) {
      setSourcePaths((current) => (current.includes(selected) ? current : [...current, selected]));
      invalidatePreview();
    }
  }, [invalidatePreview]);

  const removeSource = useCallback(
    (sourcePath: string) => {
      setSourcePaths((current) => current.filter((candidate) => candidate !== sourcePath));
      invalidatePreview();
    },
    [invalidatePreview]
  );

  const selectDestination = useCallback(async () => {
    const selected = await window.electronAPI?.selectDirectory();
    if (selected) {
      setDestinationPath(selected);
      invalidatePreview();
    }
  }, [invalidatePreview]);

  const previewAvailable = health?.capabilities.preview.available === true;
  const startAvailable = health?.capabilities.start.available === true;
  const previewBlockers = health?.capabilities.preview.blockers ?? [];
  const startBlockers = health?.capabilities.start.blockers ?? [];
  const previewActive = previewBuild?.status === 'previewing';
  const previewFinalizing =
    previewActive && previewBuild.phase === 'organization' && previewBuild.percentage === 100;
  const busy =
    previewActive ||
    stage === 'gathering' ||
    stage === 'previewing' ||
    stage === 'starting' ||
    stage === 'running';
  const canPreview =
    Boolean(sourcePaths.length > 0 && destinationPath && config && previewAvailable) && !busy;
  const canReuseTestCorpus =
    temporarySourcePath !== null ||
    (sourcePaths.length === 1 && isRetainedTestCorpus(sourcePaths[0]));

  const buildPreviewFor = useCallback(
    async (selectedSources: string[]) => {
      const api = window.electronAPI;
      if (
        !api ||
        selectedSources.length === 0 ||
        !destinationPath ||
        !config ||
        !previewAvailable ||
        previewActive ||
        previewRequestInFlight.current
      )
        return;
      previewRequestInFlight.current = true;
      setStage('previewing');
      dispatch(clearPreviewBuild());
      setActionError(null);
      setActionNotice(null);
      setPreviewCancelPending(false);
      setPreview(null);
      setMoveAcknowledged(false);
      try {
        // Settings can change in the Settings view while this view stays mounted, so the
        // preview must be planned from what is saved now, not from the startup snapshot.
        const latestConfig = await api.getConfig();
        if (!latestConfig.success || !latestConfig.data) {
          setActionError(
            latestConfig.error?.message ?? 'Processing settings could not be reloaded.'
          );
          dispatch(clearPreviewBuild());
          setStage('select');
          return;
        }
        setConfig(latestConfig.data);
        const response = await api.previewProcessing({
          sourcePaths: [...selectedSources],
          destinationPath,
          options: optionsFromConfig(latestConfig.data),
        });
        if (!response.success || !response.data) {
          if (response.error?.code === 'PREVIEW_CANCELLED') {
            setActionNotice('Preview analysis stopped. No files were changed.');
          } else {
            setActionError(response.error?.message ?? 'Preview failed.');
          }
          dispatch(clearPreviewBuild());
          setPreviewCancelPending(false);
          setStage('select');
          return;
        }
        setPreview(response.data);
        localStorage.setItem('meta-mover:last-preview-id', response.data.previewId);
        window.dispatchEvent(
          new CustomEvent<string>('meta-mover:preview-ready', { detail: response.data.previewId })
        );
        setStage('preview');
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Preview failed.');
        dispatch(clearPreviewBuild());
        setPreviewCancelPending(false);
        setStage('select');
      } finally {
        previewRequestInFlight.current = false;
      }
    },
    [config, destinationPath, dispatch, previewActive, previewAvailable]
  );

  const buildPreview = useCallback(() => {
    void buildPreviewFor(sourcePaths);
  }, [buildPreviewFor, sourcePaths]);

  useEffect(() => {
    if (
      !preview ||
      stage !== 'preview' ||
      !config ||
      processingOptionsMatch(preview.effectiveOptions, optionsFromConfig(config))
    ) {
      return;
    }
    setActionNotice('Settings changed. Rebuilding the preview from the existing source files.');
    void buildPreviewFor(sourcePaths);
  }, [buildPreviewFor, config, preview, sourcePaths, stage]);

  const gatherTestRun = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || sourcePaths.length !== 1 || !destinationPath || busy) return;
    setStage('gathering');
    setActionError(null);
    setActionNotice('Copying a random 15,000-file test corpus. Originals remain untouched.');
    try {
      setTestRunProgress(null);
      const response = await api.gatherTestRun({
        sourcePath: sourcePaths[0],
        destinationPath,
        fileCount: 15000,
      });
      if (!response.success || !response.data) {
        setActionError(response.error?.message ?? 'Test-run gathering failed.');
        setStage('select');
        return;
      }
      const copiedSource = response.data.temporarySourcePath;
      setTemporarySourcePath(copiedSource);
      setSourcePaths([copiedSource]);
      setActionNotice(
        `Copied ${response.data.copiedFiles.toLocaleString()} random files. Building preview from the temporary corpus.`
      );
      await buildPreviewFor([copiedSource]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Test-run gathering failed.');
      setStage('select');
    }
  }, [buildPreviewFor, busy, destinationPath, sourcePaths]);

  const cancelTestRun = useCallback(async () => {
    const response = await window.electronAPI?.cancelTestRun();
    if (!response?.success) setActionError('No active test run could be stopped.');
  }, []);

  const cancelPreview = useCallback(async () => {
    const api = window.electronAPI;
    if (
      !api ||
      stage !== 'previewing' ||
      previewBuild?.status !== 'previewing' ||
      previewCancelPending
    ) {
      return;
    }
    setPreviewCancelPending(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const response = await api.cancelProcessing({
        jobId: previewBuild.jobId,
        reason: 'Stopped by user',
      });
      if (!response.success) {
        setActionError(response.error?.message ?? 'Preview cancellation request failed.');
        setPreviewCancelPending(false);
      }
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Preview cancellation request failed.'
      );
      setPreviewCancelPending(false);
    }
  }, [previewBuild, previewCancelPending, stage]);

  const startProcessing = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || !preview || !startAvailable) return;
    const isMove = preview.effectiveOptions.operation === 'move';
    if (isMove && !moveAcknowledged) return;
    setStage('starting');
    setActionError(null);
    try {
      const response = await api.startProcessing({
        previewId: preview.previewId,
        acknowledgeDestructiveOperation: isMove && moveAcknowledged,
      });
      if (!response.success || !response.data) {
        if (
          response.error?.code === 'PREVIEW_EXPIRED' ||
          response.error?.code === 'PREVIEW_CONSUMED' ||
          response.error?.code === 'PREVIEW_DRIFT'
        ) {
          setActionNotice(
            'Preview changed or expired. Rebuilding it from the existing source files.'
          );
          await buildPreviewFor(sourcePaths);
          return;
        }
        setActionError(response.error?.message ?? 'Processing could not be started.');
        setStage('preview');
        return;
      }
      setActiveJobId(response.data.jobId);
      setStage('running');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Processing could not be started.');
      setStage('preview');
    }
  }, [buildPreviewFor, moveAcknowledged, preview, sourcePaths, startAvailable]);

  const cancelProcessing = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || !activeJobId || cancelPending) return;
    setCancelPending(true);
    setActionError(null);
    try {
      const response = await api.cancelProcessing({
        jobId: activeJobId,
        reason: 'Cancelled by user',
      });
      if (!response.success) {
        setActionError(response.error?.message ?? 'Cancellation request failed.');
        setCancelPending(false);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Cancellation request failed.');
      setCancelPending(false);
    }
  }, [activeJobId, cancelPending]);

  const reset = useCallback(() => {
    setStage('select');
    setSourcePaths([]);
    setDestinationPath(null);
    setPreview(null);
    setActiveJobId(null);
    setMoveAcknowledged(false);
    setCancelPending(false);
    setPreviewCancelPending(false);
    setActionError(null);
    setActionNotice(null);
    dispatch(clearPreviewBuild());
  }, [dispatch]);

  const terminal =
    activeJob?.status === 'completed' ||
    activeJob?.status === 'partial' ||
    activeJob?.status === 'failed' ||
    activeJob?.status === 'cancelled';
  const cancellationRequested = cancelPending || activeJob?.status === 'cancelling';

  useEffect(() => {
    if (activeJob?.status !== 'completed' || !temporarySourcePath) return;
    const ownedPath = temporarySourcePath;
    setTemporarySourcePath(null);
    void window.electronAPI?.discardTestRun(ownedPath).then((response) => {
      if (response.success) setActionNotice('Processing completed. Temporary test corpus removed.');
      else setActionError(response.error?.message ?? `Temporary corpus retained at ${ownedPath}`);
    });
  }, [activeJob?.status, temporarySourcePath]);

  return (
    <Container>
      <HeroCard>
        <Title>
          <span>META</span> Mover
        </Title>
        <Subtitle>
          Select one or more source folders, inspect the proposed names and creation-date evidence,
          then approve the exact preview. Copy is the safe default.
        </Subtitle>
        {startupError ? (
          <Banner $tone="error">{startupError}</Banner>
        ) : !health || !config ? (
          <Banner $tone="warning">Verifying the bundled runtime and processing settings...</Banner>
        ) : previewAvailable ? (
          <Banner $tone="ready">Runtime ready. Preview is available.</Banner>
        ) : (
          <Banner $tone="error">
            Preview is unavailable.
            <ul>
              {previewBlockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </Banner>
        )}
        {actionError && <Banner $tone="error">{actionError}</Banner>}
        {actionNotice && <Banner $tone="warning">{actionNotice}</Banner>}
        {config?.processing.testMode && (
          <Banner $tone="warning">
            <strong>TEST MODE</strong>: META Mover will copy 15,000 random files into private
            temporary storage and process only those copies. Originals remain untouched.
          </Banner>
        )}
        <FolderRow>
          <FolderLabel>Sources</FolderLabel>
          {sourcePaths.length === 0 ? (
            <FolderPath>Select one or more source folders...</FolderPath>
          ) : (
            <SourceList aria-label="Selected source folders">
              {sourcePaths.map((sourcePath) => (
                <SourceItem key={sourcePath}>
                  <SourcePath>{sourcePath}</SourcePath>
                  <RemoveSourceButton
                    type="button"
                    aria-label={`Remove source folder ${sourcePath}`}
                    onClick={() => removeSource(sourcePath)}
                    disabled={busy}
                  >
                    Remove
                  </RemoveSourceButton>
                </SourceItem>
              ))}
            </SourceList>
          )}
          <BrowseButton
            type="button"
            aria-label="Add source folder"
            onClick={selectSource}
            disabled={busy}
          >
            Add
          </BrowseButton>
        </FolderRow>
        <FolderRow>
          <FolderLabel>Destination</FolderLabel>
          <FolderPath>{destinationPath ?? 'Select destination folder...'}</FolderPath>
          <BrowseButton
            type="button"
            aria-label="Select destination folder"
            onClick={selectDestination}
            disabled={busy}
          >
            Browse
          </BrowseButton>
        </FolderRow>
        {!preview &&
          stage !== 'running' &&
          (config?.processing.testMode ? (
            <FullButton
              aria-label={
                canReuseTestCorpus ? 'Rebuild existing test preview' : 'Gather 15,000-file test run'
              }
              onClick={canReuseTestCorpus ? buildPreview : () => void gatherTestRun()}
              disabled={sourcePaths.length !== 1 || !destinationPath || busy}
            >
              {stage === 'gathering'
                ? 'Gathering Test Run...'
                : canReuseTestCorpus
                  ? 'Rebuild Test Preview'
                  : 'Gather & Build Test Preview'}
            </FullButton>
          ) : (
            <FullButton onClick={buildPreview} disabled={!canPreview}>
              {stage === 'previewing' ? 'Building Preview...' : 'Build Preview'}
            </FullButton>
          ))}
      </HeroCard>

      {stage === 'gathering' && (
        <Card role="status" aria-live="polite" aria-atomic="false">
          <CardTitle>
            {testRunProgress?.phase === 'copying'
              ? 'Copying temporary test corpus'
              : 'Scanning source collection'}
          </CardTitle>
          <ProgressCopy>
            <span>
              {testRunProgress?.phase === 'copying'
                ? `${testRunProgress.copiedFiles.toLocaleString()} / 15,000 files (${Math.round(testRunProgress.percentage ?? 0)}%)`
                : `${(testRunProgress?.scannedFiles ?? 0).toLocaleString()} files scanned`}
            </span>
            <span>
              {testRunProgress?.phase === 'copying' ? 'Clone-first copy' : 'Random sampling'}
            </span>
          </ProgressCopy>
          <ProgressTrack
            role="progressbar"
            aria-label="Test run gathering progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              testRunProgress?.percentage === null || testRunProgress?.percentage === undefined
                ? undefined
                : Math.round(testRunProgress.percentage)
            }
          >
            <ProgressFill
              $percentage={testRunProgress?.percentage ?? 0}
              $indeterminate={testRunProgress?.phase !== 'copying'}
            />
          </ProgressTrack>
          {testRunProgress?.currentFile && (
            <CurrentFile>
              <strong>Current file</strong>
              <span>{testRunProgress.currentFile}</span>
            </CurrentFile>
          )}
          <FullButton $danger type="button" aria-label="Stop Test Run" onClick={cancelTestRun}>
            Stop Test Run
          </FullButton>
        </Card>
      )}

      {stage === 'previewing' && (
        <Card role="status" aria-live="polite" aria-atomic="false">
          <CardTitle>Building preview</CardTitle>
          <ProgressCopy>
            <span>
              {previewBuild && previewBuild.phase !== 'discovery'
                ? `${previewBuild.filesProcessed} / ${previewBuild.totalFiles} files (${Math.round(previewBuild.percentage)}%)`
                : 'Discovering files...'}
            </span>
            <span>
              {previewBuild?.phase === 'metadata'
                ? 'Reading metadata'
                : previewBuild?.phase === 'organization'
                  ? 'Finalizing preview'
                  : 'Scanning sources'}
            </span>
          </ProgressCopy>
          <ProgressTrack
            role="progressbar"
            aria-label="Preview analysis progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              previewBuild && previewBuild.phase !== 'discovery'
                ? Math.round(previewBuild.percentage)
                : undefined
            }
          >
            <ProgressFill
              $percentage={previewBuild?.percentage ?? 0}
              $indeterminate={!previewBuild || previewBuild.phase === 'discovery'}
            />
          </ProgressTrack>
          {previewBuild?.currentFile && (
            <CurrentFile>
              <strong>Current file</strong>
              <span>{previewBuild.currentFile}</span>
            </CurrentFile>
          )}
          <FullButton
            $danger
            type="button"
            onClick={cancelPreview}
            disabled={
              previewBuild?.status !== 'previewing' || previewFinalizing || previewCancelPending
            }
          >
            {previewCancelPending ? 'Stopping Preview...' : 'Stop Preview'}
          </FullButton>
        </Card>
      )}

      {preview && stage !== 'running' && (
        <Card>
          <CardTitle>Preview ready</CardTitle>
          <StatGrid>
            <Stat>
              <strong>{preview.summary.totalFiles}</strong>
              <span>Total files</span>
            </Stat>
            <Stat>
              <strong>{preview.summary.copyFiles + preview.summary.moveFiles}</strong>
              <span>Planned</span>
            </Stat>
            <Stat>
              <strong>{preview.summary.skippedFiles}</strong>
              <span>Skipped</span>
            </Stat>
            <Stat>
              <strong>{preview.summary.unresolvedDates}</strong>
              <span>Unresolved dates</span>
            </Stat>
          </StatGrid>
          {preview.rows && preview.rows.length > 0 && (
            <TableWrap>
              <PreviewTable>
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Target</th>
                    <th>Evidence</th>
                    <th>Confidence</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => {
                    const warnings = rowWarnings(row);
                    return (
                      <tr key={row.sourcePath}>
                        <td>
                          <PathCell>{displayFilename(row.sourcePath)}</PathCell>
                        </td>
                        <td>
                          <PathCell>
                            {row.targetPath === null
                              ? 'No target'
                              : displayFilename(row.targetPath)}
                          </PathCell>
                        </td>
                        <td>
                          {row.dateEvidence.source}: {row.dateEvidence.value ?? 'Unresolved'}
                          {warnings.length > 0 && (
                            <WarningList>
                              {warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </WarningList>
                          )}
                        </td>
                        <td>{Math.round(row.dateEvidence.confidence * 100)}%</td>
                        <td>{row.operation}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </PreviewTable>
            </TableWrap>
          )}
          {preview.effectiveOptions.operation === 'move' && (
            <Confirmation>
              <input
                type="checkbox"
                checked={moveAcknowledged}
                onChange={(event) => setMoveAcknowledged(event.target.checked)}
              />
              <span>
                I understand Move deletes each source only after the destination copy passes
                integrity verification.
              </span>
            </Confirmation>
          )}
          {!startAvailable && (
            <Banner $tone="error">
              Start is unavailable.
              <ul>
                {startBlockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </Banner>
          )}
          <ActionRow>
            <BrowseButton onClick={invalidatePreview} disabled={stage === 'starting'}>
              Rebuild Selection
            </BrowseButton>
            <Button
              onClick={startProcessing}
              disabled={
                stage === 'starting' ||
                !startAvailable ||
                (preview.effectiveOptions.operation === 'move' && !moveAcknowledged)
              }
            >
              {stage === 'starting'
                ? 'Starting...'
                : preview.effectiveOptions.operation === 'move'
                  ? 'Start Move'
                  : 'Start Copy'}
            </Button>
          </ActionRow>
        </Card>
      )}

      {stage === 'running' && !terminal && (
        <Card>
          <CardTitle>
            {cancellationRequested
              ? 'Cancellation requested'
              : activeJob?.preparation
                ? 'Preparing metadata audit'
                : 'Processing'}
          </CardTitle>
          <ProgressCopy>
            <span>
              {activeJob
                ? `${activeJob.filesAttempted ?? activeJob.filesSettled ?? activeJob.filesProcessed} attempted / ${activeJob.totalFiles} total`
                : 'Waiting for processing event'}
            </span>
            <span>{activeJob?.status ?? 'queued'}</span>
          </ProgressCopy>
          {activeJob && (
            <ProgressCopy role="status">
              <span>{activeJob.filesProcessed} succeeded</span>
              <span>{activeJob.filesSettled ?? activeJob.filesProcessed} settled</span>
              <span>{activeJob.failedFiles ?? 0} failed</span>
            </ProgressCopy>
          )}
          <ProgressTrack
            role="progressbar"
            aria-label="Processing progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={activeJob?.progress ?? 0}
          >
            <ProgressFill $percentage={activeJob?.progress ?? 0} />
          </ProgressTrack>
          {activeJob?.currentFile && (
            <CurrentFile role="status">
              <strong>{activeJob.phase ?? 'processing'}</strong>
              <span>{activeJob.currentFile}</span>
            </CurrentFile>
          )}
          {activeJob?.preparation && (
            <CurrentFile role="status">
              <strong>{activeJob.preparation.stage}</strong>
              <span>
                {activeJob.preparation.total === undefined
                  ? `${activeJob.preparation.completed.toLocaleString()} ${activeJob.preparation.unit}`
                  : `${activeJob.preparation.completed.toLocaleString()} / ${activeJob.preparation.total.toLocaleString()} ${activeJob.preparation.unit} (${Math.round(
                      (activeJob.preparation.completed / activeJob.preparation.total) * 100
                    )}%)`}
              </span>
            </CurrentFile>
          )}
          <FullButton $danger onClick={cancelProcessing} disabled={cancellationRequested}>
            {cancellationRequested ? 'Cancellation Requested' : 'Cancel Processing'}
          </FullButton>
        </Card>
      )}

      {terminal && activeJob && (
        <Card>
          <CardTitle>
            {activeJob.status === 'completed'
              ? 'Processing complete'
              : activeJob.status === 'partial'
                ? 'Processing completed with failures'
                : activeJob.status === 'cancelled'
                  ? 'Processing cancelled'
                  : 'Processing failed'}
          </CardTitle>
          <Subtitle>
            {activeJob.status === 'cancelled'
              ? `${activeJob.filesProcessed} succeeded, ${activeJob.cancelledFiles ?? 0} cancelled, ${activeJob.unattemptedFiles ?? 0} not attempted, ${activeJob.committedResidueBytes ?? 0} residue bytes.`
              : activeJob.status === 'partial' || (activeJob.failedFiles ?? 0) > 0
                ? `${activeJob.filesProcessed} succeeded, ${(activeJob.skippedFiles ?? 0) > 0 ? `${activeJob.skippedFiles} skipped, ` : ''}${activeJob.failedFiles ?? 0} failed, ${activeJob.totalFiles} total.`
                : `${activeJob.filesProcessed} of ${activeJob.totalFiles} files succeeded.`}
            {activeJob.error ? ` ${activeJob.error}` : ''}
          </Subtitle>
          {activeJob.fileFailures && activeJob.fileFailures.length > 0 && (
            <FailureList aria-label="Failed files">
              {activeJob.fileFailures.map((failure) => (
                <li key={`${failure.sourcePath}:${failure.error}`}>
                  {failure.sourcePath}: {failure.error}
                </li>
              ))}
            </FailureList>
          )}
          {activeJob.cancellationOutcomes && activeJob.cancellationOutcomes.length > 0 && (
            <FailureList aria-label="Cancellation file outcomes">
              {activeJob.cancellationOutcomes.map((outcome) => (
                <li key={`${outcome.sourcePath}:${outcome.destinationPath}:${outcome.state}`}>
                  {outcome.sourcePath} → {outcome.destinationPath ?? '(no destination)'}:{' '}
                  {outcome.state}, {outcome.committedBytes} bytes committed,
                  {outcome.sourceRetained ? ' source retained' : ' source removed'}
                  {outcome.error ? `, ${outcome.error}` : ''}
                </li>
              ))}
            </FailureList>
          )}
          <FullButton onClick={reset}>Organize Another Batch</FullButton>
        </Card>
      )}
    </Container>
  );
}
