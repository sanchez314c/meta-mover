import React, { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import type {
  AuditDecision,
  AuditDryRunItem,
  AuditDryRunPage,
  AuditPage,
} from '../../../shared/types/audit';

const LAST_PREVIEW_KEY = 'meta-mover:last-preview-id';
const PAGE_SIZE = 50;
interface AuditSummary {
  revision: string;
  total: number;
  dispositions: Record<string, number>;
}
interface CohortItem {
  cohortKey: string;
  count: number;
  dispositions: Record<string, number>;
}
interface CohortPage {
  revision: string;
  items: CohortItem[];
  nextCursor?: string;
}

const View = styled.div`
  display: grid;
  gap: 16px;
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
  padding: 20px;
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
`;
const Header = styled.div`
  h3 {
    margin: 0 0 6px;
    color: var(--text-heading);
    font-size: 19px;
  }
  p {
    margin: 0;
    max-width: 760px;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }
`;
const InputRow = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 16px;
  input {
    flex: 1;
    min-width: 0;
    padding: 9px 11px;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
  }
`;
const Button = styled.button<{ $danger?: boolean }>`
  padding: 8px 12px;
  color: ${({ $danger }) => ($danger ? 'var(--status-error)' : 'var(--text-primary)')};
  background: rgba(20, 184, 166, 0.09);
  border: 1px solid rgba(20, 184, 166, 0.3);
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  &:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }
`;
const Metrics = styled.div`
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-top: 16px;
`;
const Metric = styled.div`
  padding: 13px;
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  strong {
    display: block;
    color: var(--accent-teal);
    font-size: 20px;
  }
  span {
    color: var(--text-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.55px;
  }
`;
const SectionTitle = styled.h4`
  margin: 0 0 12px;
  color: var(--text-heading);
  font-size: 14px;
`;
const TableWrap = styled.div`
  overflow: auto;
  max-height: 390px;
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  th {
    position: sticky;
    top: 0;
    z-index: 1;
    color: var(--text-muted);
    background: var(--bg-card);
    text-align: left;
  }
  th,
  td {
    padding: 9px 10px;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: top;
  }
  td {
    color: var(--text-secondary);
  }
  code {
    color: var(--text-primary);
    overflow-wrap: anywhere;
    white-space: normal;
  }
`;
const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
`;
const Notice = styled.div<{ $error?: boolean }>`
  padding: 11px 13px;
  color: ${({ $error }) => ($error ? 'var(--status-error)' : 'var(--text-secondary)')};
  background: ${({ $error }) => ($error ? 'rgba(239,68,68,.07)' : 'rgba(20,184,166,.07)')};
  border: 1px solid ${({ $error }) => ($error ? 'rgba(239,68,68,.25)' : 'rgba(20,184,166,.22)')};
  border-radius: 8px;
  font-size: 12px;
  overflow-wrap: anywhere;
`;

function count(summary: AuditSummary | null, key: string): number {
  return summary?.dispositions[key] ?? 0;
}
function data<T>(response: { success: boolean; data?: unknown; error?: { message: string } }): T {
  if (!response.success || response.data === undefined)
    throw new Error(response.error?.message ?? 'Audit request failed.');
  return response.data as T;
}

export function MetadataView() {
  const [previewId, setPreviewId] = useState(() => localStorage.getItem(LAST_PREVIEW_KEY) ?? '');
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [cohorts, setCohorts] = useState<CohortPage | null>(null);
  const [rows, setRows] = useState<AuditPage | null>(null);
  const [sample, setSample] = useState<AuditDecision[]>([]);
  const [dryRun, setDryRun] = useState<AuditDryRunItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = window.electronAPI;
    if (!api || !previewId.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const id = previewId.trim();
      localStorage.setItem(LAST_PREVIEW_KEY, id);
      const [summaryResponse, cohortResponse, rowResponse] = await Promise.all([
        api.getNormalizationAuditSummary({ previewId: id }),
        api.getNormalizationAuditCohorts({ previewId: id, limit: PAGE_SIZE }),
        api.getNormalizationAuditRows({ previewId: id, limit: PAGE_SIZE }),
      ]);
      setSummary(data<AuditSummary>(summaryResponse));
      setCohorts(data<CohortPage>(cohortResponse));
      setRows(data<AuditPage>(rowResponse));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Audit could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [previewId]);

  useEffect(() => {
    if (previewId && localStorage.getItem(LAST_PREVIEW_KEY) === previewId) void load();
  }, [load, previewId]);
  useEffect(() => {
    const listener = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === 'string' && id) {
        localStorage.setItem(LAST_PREVIEW_KEY, id);
        setPreviewId(id);
      }
    };
    window.addEventListener('meta-mover:preview-ready', listener);
    return () => window.removeEventListener('meta-mover:preview-ready', listener);
  }, []);

  const approve = async (cohortKey: string, approved: boolean) => {
    if (!summary || !window.electronAPI) return;
    setBusy(true);
    setError(null);
    try {
      data(
        await window.electronAPI.approveNormalizationAuditCohort({
          previewId,
          revision: summary.revision,
          cohortKey,
          approved,
        })
      );
      setMessage(`${approved ? 'Approved' : 'Rejected'} cohort ${cohortKey}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Approval failed.');
    } finally {
      setBusy(false);
    }
  };

  const buildSample = async () => {
    if (!window.electronAPI) return;
    setBusy(true);
    setError(null);
    try {
      const result = data<{ items: AuditDecision[] }>(
        await window.electronAPI.getNormalizationAuditSample({
          previewId,
          seed: `manual-${summary?.revision.slice(0, 16) ?? 'audit'}`,
          targetSize: 50,
        })
      );
      setSample(result.items);
      setMessage(`Loaded ${result.items.length.toLocaleString()} reproducible audit samples.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sample failed.');
    } finally {
      setBusy(false);
    }
  };

  const buildDryRun = async () => {
    if (!summary || !window.electronAPI) return;
    setBusy(true);
    setError(null);
    try {
      const result = data<AuditDryRunPage>(
        await window.electronAPI.dryRunNormalizationAudit({
          previewId,
          revision: summary.revision,
          limit: PAGE_SIZE,
        })
      );
      setDryRun(result.items);
      setMessage(`Dry run selected ${result.items.length.toLocaleString()} files on this page.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Dry run failed.');
    } finally {
      setBusy(false);
    }
  };

  const openEvidenceFile = async (row: AuditDecision) => {
    if (!window.electronAPI) return;
    const response = await window.electronAPI.openPath(row.sourcePath);
    if (!response.success) {
      setError(response.error?.message ?? 'Evidence file could not be opened.');
    }
  };

  const loadMoreRows = async () => {
    if (!rows?.nextCursor || !window.electronAPI) return;
    const next = data<AuditPage>(
      await window.electronAPI.getNormalizationAuditRows({
        previewId,
        limit: PAGE_SIZE,
        cursor: rows.nextCursor,
      })
    );
    setRows({ ...next, items: [...rows.items, ...next.items] });
  };

  const loadMoreCohorts = async () => {
    if (!cohorts?.nextCursor || !window.electronAPI) return;
    const next = data<CohortPage>(
      await window.electronAPI.getNormalizationAuditCohorts({
        previewId,
        limit: PAGE_SIZE,
        cursor: cohorts.nextCursor,
      })
    );
    setCohorts({ ...next, items: [...cohorts.items, ...next.items] });
  };

  const displayed = sample.length > 0 ? sample : (rows?.items ?? []);
  return (
    <View>
      <Card>
        <Header>
          <h3>Normalization audit</h3>
          <p>
            Audit immutable date evidence, approve matching cohorts in bulk, and inspect a
            reproducible sample before enabling destination metadata normalization.
          </p>
        </Header>
        <InputRow>
          <input
            aria-label="Preview ID"
            value={previewId}
            onChange={(event) => setPreviewId(event.currentTarget.value)}
            placeholder="Preview ID from Organize"
          />
          <Button onClick={() => void load()} disabled={busy || !previewId.trim()}>
            Load audit
          </Button>
        </InputRow>
        {summary && (
          <Metrics>
            <Metric>
              <strong>{summary.total.toLocaleString()}</strong>
              <span>Total</span>
            </Metric>
            <Metric>
              <strong>{count(summary, 'auto-normalize').toLocaleString()}</strong>
              <span>Automatic</span>
            </Metric>
            <Metric>
              <strong>{count(summary, 'normalize-after-cohort-approval').toLocaleString()}</strong>
              <span>Cohort approval</span>
            </Metric>
            <Metric>
              <strong>{count(summary, 'manual-review').toLocaleString()}</strong>
              <span>Manual review</span>
            </Metric>
            <Metric>
              <strong>{count(summary, 'quarantine-unresolved').toLocaleString()}</strong>
              <span>Quarantine</span>
            </Metric>
          </Metrics>
        )}
      </Card>
      {error && <Notice $error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {summary && (
        <Card>
          <SectionTitle>Bulk cohorts</SectionTitle>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Cohort</th>
                  <th>Files</th>
                  <th>Disposition</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {(cohorts?.items ?? []).map((cohort) => (
                  <tr key={cohort.cohortKey}>
                    <td>
                      <code>{cohort.cohortKey}</code>
                    </td>
                    <td>{cohort.count.toLocaleString()}</td>
                    <td>{Object.keys(cohort.dispositions).join(', ')}</td>
                    <td>
                      <Button
                        aria-label={`Approve cohort ${cohort.cohortKey}`}
                        disabled={busy}
                        onClick={() => void approve(cohort.cohortKey, true)}
                      >
                        Approve cohort
                      </Button>{' '}
                      <Button
                        $danger
                        disabled={busy}
                        onClick={() => void approve(cohort.cohortKey, false)}
                      >
                        Reject
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {cohorts?.nextCursor && (
            <Button onClick={() => void loadMoreCohorts()}>Load more cohorts</Button>
          )}
        </Card>
      )}
      {summary && (
        <Card>
          <Toolbar>
            <Button disabled={busy} onClick={() => void buildSample()}>
              Build 50-file stratified sample
            </Button>
            <Button disabled={busy} onClick={() => void buildDryRun()}>
              Build normalization dry run
            </Button>
          </Toolbar>
          <SectionTitle>
            {sample.length ? 'Stratified manual sample' : 'Evidence rows, first 50'}
          </SectionTitle>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Disposition</th>
                  <th>Confidence</th>
                  <th>Reasons</th>
                  <th>Output</th>
                  <th>Inspect</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((row) => (
                  <tr key={row.recordId}>
                    <td>{row.disposition}</td>
                    <td>{row.confidence}</td>
                    <td>{row.reasonCodes.join(', ')}</td>
                    <td>
                      <code>{row.outputPath}</code>
                    </td>
                    <td>
                      <Button onClick={() => void openEvidenceFile(row)}>Open source</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {sample.length === 0 && rows?.nextCursor && (
            <Button onClick={() => void loadMoreRows()}>Load more evidence</Button>
          )}
        </Card>
      )}
      {dryRun.length > 0 && (
        <Card>
          <SectionTitle>Normalization dry run, approved and automatic rows</SectionTitle>
          <Notice>
            No media was changed. Existing values come from the immutable preview evidence, not a
            fresh file read. Every listed assignment is the exact value the writer will verify after
            staging.
          </Notice>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Tag</th>
                  <th>Before → after</th>
                </tr>
              </thead>
              <tbody>
                {dryRun.flatMap((row) =>
                  row.metadataChanges.map((change) => (
                    <tr key={`${row.recordId}:${change.tag}`}>
                      <td>
                        <code>{row.outputPath}</code>
                      </td>
                      <td>{change.tag}</td>
                      <td>
                        <code>
                          {String(change.before ?? 'null')} → {change.after}
                        </code>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </View>
  );
}
