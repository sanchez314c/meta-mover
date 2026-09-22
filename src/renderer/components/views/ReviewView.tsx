import React, { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import type {
  ReviewAction,
  ReviewApplyRequestDTO,
  ReviewApplyResultDTO,
  ReviewDryRunDTO,
  ReviewDryRunRequestDTO,
  ReviewItemDTO,
  ReviewListRequestDTO,
  ReviewPageDTO,
} from '../../../shared/types/review';

const PAGE_SIZE = 50;
type Response<T> = { success: boolean; data?: T; error?: { message: string } };
interface ReviewAPI {
  reviewList(request: ReviewListRequestDTO): Promise<Response<ReviewPageDTO>>;
  reviewGet(request: { reviewId: string }): Promise<Response<ReviewItemDTO | null>>;
  reviewDryRun(request: ReviewDryRunRequestDTO): Promise<Response<ReviewDryRunDTO>>;
  reviewApply(request: ReviewApplyRequestDTO): Promise<Response<ReviewApplyResultDTO>>;
}

const View = styled.div`
  display: grid;
  gap: 16px;
  animation: fadeIn 180ms ease;
`;
const Card = styled.section`
  padding: 20px;
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
`;
const Header = styled.header`
  h3 {
    margin: 0 0 6px;
    color: var(--text-heading);
    font-size: 19px;
  }
  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }
`;
const Grid = styled.div`
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(360px, 1.4fr);
  gap: 16px;
`;
const List = styled.div`
  display: grid;
  gap: 8px;
  margin-top: 14px;
  max-height: 620px;
  overflow: auto;
`;
const Row = styled.button<{ $active: boolean }>`
  width: 100%;
  padding: 11px;
  text-align: left;
  color: var(--text-primary);
  background: ${({ $active }) => ($active ? 'var(--accent-teal-dim)' : 'rgba(255,255,255,.025)')};
  border: 1px solid ${({ $active }) => ($active ? 'rgba(20,184,166,.45)' : 'var(--glass-border)')};
  border-radius: 8px;
  cursor: pointer;
  strong,
  small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    margin-top: 4px;
    color: var(--text-muted);
  }
`;
const Button = styled.button<{ $primary?: boolean }>`
  padding: 8px 12px;
  color: ${({ $primary }) => ($primary ? '#061b19' : 'var(--text-primary)')};
  background: ${({ $primary }) => ($primary ? 'var(--accent-teal)' : 'rgba(20,184,166,.09)')};
  border: 1px solid rgba(20, 184, 166, 0.35);
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  &:disabled {
    opacity: 0.42;
    cursor: not-allowed;
  }
`;
const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
`;
const Notice = styled.div<{ $error?: boolean }>`
  padding: 11px 13px;
  color: ${({ $error }) => ($error ? 'var(--status-error)' : 'var(--text-secondary)')};
  background: ${({ $error }) => ($error ? 'rgba(239,68,68,.07)' : 'rgba(20,184,166,.07)')};
  border: 1px solid ${({ $error }) => ($error ? 'rgba(239,68,68,.25)' : 'rgba(20,184,166,.22)')};
  border-radius: 8px;
  font-size: 12px;
`;
const Detail = styled.div`
  display: grid;
  gap: 14px;
  h4 {
    margin: 0;
    color: var(--text-heading);
  }
  h5 {
    margin: 0 0 8px;
    color: var(--text-secondary);
  }
  code {
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }
  ul {
    margin: 0;
    padding-left: 18px;
    color: var(--text-secondary);
    font-size: 12px;
  }
  label {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    color: var(--text-secondary);
    font-size: 12px;
    margin: 7px 0;
  }
  input[type='datetime-local'] {
    padding: 8px;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    border-radius: 7px;
  }
`;
const Plan = styled.div`
  padding: 12px;
  border: 1px solid rgba(20, 184, 166, 0.28);
  border-radius: 8px;
  background: rgba(20, 184, 166, 0.06);
  font-size: 12px;
  color: var(--text-secondary);
`;

function api(): ReviewAPI | null {
  return (window.electronAPI as unknown as ReviewAPI | undefined) ?? null;
}
function unwrap<T>(response: Response<T>): T {
  if (!response.success || response.data === undefined)
    throw new Error(response.error?.message ?? 'Review request failed.');
  return response.data;
}
function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

export function ReviewView() {
  const [items, setItems] = useState<ReviewItemDTO[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<ReviewItemDTO | null>(null);
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [manualDate, setManualDate] = useState('');
  const [plan, setPlan] = useState<ReviewDryRunDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const select = useCallback(async (reviewId: string) => {
    const bridge = api();
    if (!bridge) return setError('Review Queue is unavailable.');
    setBusy(true);
    setError(null);
    setPlan(null);
    setAction(null);
    try {
      const detail = unwrap(await bridge.reviewGet({ reviewId }));
      setSelected(detail);
      if (!detail) setError('This review item no longer exists.');
      else if (detail.lastError) setError(detail.lastError);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Review item could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, []);

  const load = useCallback(
    async (nextCursor?: string) => {
      const bridge = api();
      if (!bridge) {
        setError('Review Queue is unavailable.');
        setLoading(false);
        return;
      }
      nextCursor ? setBusy(true) : setLoading(true);
      setError(null);
      try {
        const page = unwrap(
          await bridge.reviewList({
            statuses: ['pending', 'failed'],
            limit: PAGE_SIZE,
            ...(nextCursor ? { cursor: nextCursor } : {}),
          })
        );
        const actionable = page.items.filter(
          (item) => item.status === 'pending' || item.status === 'failed'
        );
        setItems((current) =>
          nextCursor
            ? [
                ...current,
                ...actionable.filter(
                  (item) => !current.some((old) => old.reviewId === item.reviewId)
                ),
              ]
            : actionable
        );
        setCursor(page.nextCursor);
        if (!nextCursor && actionable[0]) await select(actionable[0].reviewId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Review Queue could not be loaded.');
      } finally {
        setLoading(false);
        setBusy(false);
      }
    },
    [select]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const chooseManual = (input: string) => {
    setManualDate(input);
    setPlan(null);
    if (!input) return setAction(null);
    setAction({
      type: 'manual-date',
      value: {
        localIso: input,
        zoneBasis: 'floating-local',
        precision: input.length > 16 ? 'second' : 'minute',
      },
    });
  };
  const preview = async () => {
    const bridge = api();
    if (!bridge || !selected || !action) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    setPlan(null);
    try {
      setPlan(
        unwrap(
          await bridge.reviewDryRun({
            reviewId: selected.reviewId,
            evidenceRevision: selected.evidence.revision,
            action,
          })
        )
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Fix preview failed.');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    const bridge = api();
    if (!bridge || !selected || !action || !plan) return;
    setBusy(true);
    setError(null);
    try {
      const result = unwrap(
        await bridge.reviewApply({
          reviewId: selected.reviewId,
          evidenceRevision: selected.evidence.revision,
          action,
          planToken: plan.planToken,
        })
      );
      setMessage(
        result.status === 'resolved' ? 'Review fix applied.' : `Review item is ${result.status}.`
      );
      setPlan(null);
      setAction(null);
      if (result.status === 'resolved' || result.status === 'kept') {
        setItems((current) => current.filter((item) => item.reviewId !== selected.reviewId));
        setSelected(null);
      } else {
        const refreshed = unwrap(await bridge.reviewGet({ reviewId: selected.reviewId }));
        if (!refreshed) throw new Error('Review item disappeared after a non-terminal result.');
        setItems((current) =>
          current.map((item) => (item.reviewId === refreshed.reviewId ? refreshed : item))
        );
        setSelected(refreshed);
        if (refreshed.lastError) setError(refreshed.lastError);
      }
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : 'Fix could not be applied.';
      setError(text);
      setPlan(null);
      if (/stale|changed|revision/i.test(text))
        setMessage('Evidence changed. Preview the fix again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Card>
        <Header>
          <h3>Review Queue</h3>
          <p>
            Resolve uncertain dates against the saved evidence. Every change requires a fresh
            preview token before it can be applied.
          </p>
        </Header>
      </Card>
      {error && (
        <Notice role="alert" $error>
          {error}
        </Notice>
      )}
      {message && <Notice>{message}</Notice>}
      {loading ? (
        <Card aria-live="polite">Loading pending review items…</Card>
      ) : items.length === 0 ? (
        <Card>
          <Notice>No pending review items.</Notice>
        </Card>
      ) : (
        <Grid>
          <Card>
            <h4>Pending ({items.length})</h4>
            <List>
              {items.map((item) => (
                <Row
                  key={item.reviewId}
                  $active={selected?.reviewId === item.reviewId}
                  onClick={() => void select(item.reviewId)}
                >
                  <strong>{basename(item.currentPath)}</strong>
                  <small>{item.reasonCodes.join(', ')}</small>
                </Row>
              ))}
            </List>
            {cursor && (
              <Toolbar>
                <Button disabled={busy} onClick={() => void load(cursor)}>
                  Load more
                </Button>
              </Toolbar>
            )}
          </Card>
          <Card>
            {!selected ? (
              <Notice>Select a review item.</Notice>
            ) : (
              <Detail>
                <div>
                  <h4>{basename(selected.currentPath)}</h4>
                  <code>{selected.currentPath}</code>
                </div>
                {selected.status === 'stale' && (
                  <Notice $error>Evidence is stale. Retry metadata before applying a fix.</Notice>
                )}
                <div>
                  <h5>Reasons</h5>
                  <ul>
                    {selected.reasonCodes.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                    {selected.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h5>Date candidates</h5>
                  {selected.evidence.resolution.candidates.length === 0 ? (
                    <Notice>No usable candidates were found.</Notice>
                  ) : (
                    selected.evidence.resolution.candidates.map((candidate) => (
                      <label key={candidate.id}>
                        <input
                          type="radio"
                          name="review-action"
                          aria-label={candidate.id}
                          checked={
                            action?.type === 'select-candidate' &&
                            action.candidateId === candidate.id
                          }
                          onChange={() => {
                            setAction({ type: 'select-candidate', candidateId: candidate.id });
                            setPlan(null);
                          }}
                        />
                        <span>
                          <strong>{candidate.id}</strong> · {candidate.tag}
                          <br />
                          {candidate.value.localIso} · score {candidate.score.final}
                        </span>
                      </label>
                    ))
                  )}
                </div>
                <div>
                  <h5>Manual date</h5>
                  <input
                    aria-label="Manual date"
                    type="datetime-local"
                    step="1"
                    value={manualDate}
                    onChange={(event) => chooseManual(event.currentTarget.value)}
                  />
                </div>
                <Toolbar>
                  <Button
                    onClick={() => {
                      setAction({ type: 'retry-metadata' });
                      setPlan(null);
                    }}
                  >
                    Retry Metadata
                  </Button>
                  <Button
                    onClick={() => {
                      setAction({ type: 'keep' });
                      setPlan(null);
                    }}
                  >
                    Keep Here
                  </Button>
                  <Button $primary disabled={busy || !action} onClick={() => void preview()}>
                    Preview Fix
                  </Button>
                  <Button $primary disabled={busy || !plan} onClick={() => void apply()}>
                    Apply Fix
                  </Button>
                </Toolbar>
                {plan && (
                  <Plan>
                    <strong>Proposed result</strong>
                    <br />
                    <code>{plan.targetPath ?? plan.currentPath}</code>
                    {plan.collision && (
                      <>
                        <br />A destination collision will be resolved.
                      </>
                    )}
                    {plan.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </Plan>
                )}
              </Detail>
            )}
          </Card>
        </Grid>
      )}
    </View>
  );
}
