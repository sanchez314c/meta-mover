import React, { useEffect, useState } from 'react';
import styled from 'styled-components';

import type { AppConfig, AppConfigUpdate } from '../../../main/services/AppConfigStore';

const View = styled.div`
  display: grid;
  gap: 18px;
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
const Title = styled.h3`
  margin: 0 0 14px;
  color: var(--text-heading);
  font-size: 16px;
`;
const Row = styled.label`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
  &:last-child {
    border-bottom: 0;
  }
`;
const Copy = styled.span`
  display: grid;
  gap: 3px;
  color: var(--text-primary);
  font-size: 14px;
`;
const Hint = styled.span`
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
`;
const Control = styled.select`
  min-width: 170px;
  padding: 8px 11px;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-button);
`;
const NumberControl = styled.input`
  width: 76px;
  padding: 8px 11px;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-button);
`;
const Message = styled.div<{ $error?: boolean }>`
  color: ${({ $error }) => ($error ? 'var(--status-error)' : 'var(--status-success)')};
  font-size: 12px;
`;
const Reset = styled.button`
  padding: 10px 14px;
  color: var(--status-error);
  background: transparent;
  border: 1px solid var(--status-error);
  border-radius: var(--radius-button);
  cursor: pointer;
`;

export function SettingsView() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.electronAPI?.getConfig().then((response) => {
      if (!mounted) return;
      if (response.success && response.data) setConfig(response.data);
      else setMessage({ text: response.error?.message ?? 'Could not load settings', error: true });
    });
    return () => {
      mounted = false;
    };
  }, []);

  const save = async (update: AppConfigUpdate) => {
    if (!window.electronAPI) return;
    setMessage(null);
    const response = await window.electronAPI.updateConfig(update);
    if (response.success && response.data) {
      setConfig(response.data);
      setMessage({ text: 'Saved', error: false });
    } else {
      setMessage({ text: response.error?.message ?? 'Could not save settings', error: true });
    }
  };

  const reset = async () => {
    if (!window.electronAPI) return;
    setMessage(null);
    const response = await window.electronAPI.resetConfig();
    if (response.success && response.data) {
      setConfig(response.data);
      setMessage({ text: 'Defaults restored', error: false });
    } else {
      setMessage({ text: response.error?.message ?? 'Could not reset settings', error: true });
    }
  };

  if (!config)
    return <Message $error={message?.error}>{message?.text ?? 'Loading settings…'}</Message>;

  return (
    <View>
      {message && <Message $error={message.error}>{message.text}</Message>}
      <Card>
        <Title>General</Title>
        <Row>
          <Copy>
            Theme<Hint>Application color scheme</Hint>
          </Copy>
          <Control
            aria-label="Theme"
            value={config.theme}
            onChange={(event) => void save({ theme: event.target.value as AppConfig['theme'] })}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </Control>
        </Row>
      </Card>
      <Card>
        <Title>Processing</Title>
        <Row>
          <Copy>
            Worker count<Hint>Parallel file transactions, 1 to 10</Hint>
          </Copy>
          <NumberControl
            aria-label="Worker count"
            type="number"
            min={1}
            max={10}
            value={config.processing.workerCount}
            onChange={(event) =>
              setConfig({
                ...config,
                processing: { ...config.processing, workerCount: Number(event.target.value) },
              })
            }
            onBlur={(event) =>
              void save({ processing: { workerCount: Number(event.currentTarget.value) } })
            }
          />
        </Row>
        <Row>
          <Copy>
            Default operation
            <Hint>Copy preserves source files. Move requires confirmation per job.</Hint>
          </Copy>
          <Control
            aria-label="Default operation"
            value={config.processing.operation}
            onChange={(event) =>
              void save({ processing: { operation: event.target.value as 'copy' | 'move' } })
            }
          >
            <option value="copy">Copy</option>
            <option value="move">Move</option>
          </Control>
        </Row>
      </Card>
      <Card>
        <Title>Organization</Title>
        <Row>
          <Copy>
            Folder structure<Hint>Applied to metadata-grounded dates</Hint>
          </Copy>
          <Control
            aria-label="Folder structure"
            value={config.organization.folderStructure}
            onChange={(event) =>
              void save({
                organization: {
                  folderStructure: event.target
                    .value as AppConfig['organization']['folderStructure'],
                },
              })
            }
          >
            <option value="year/month">Year / Month</option>
            <option value="year-month">Year-Month</option>
            <option value="flat">Flat</option>
          </Control>
        </Row>
        <Row>
          <Copy>
            Existing target<Hint>Overwrite is never allowed</Hint>
          </Copy>
          <Control
            aria-label="Existing target"
            value={config.organization.conflictPolicy}
            onChange={(event) =>
              void save({
                organization: { conflictPolicy: event.target.value as 'rename' | 'skip' },
              })
            }
          >
            <option value="rename">Rename with suffix</option>
            <option value="skip">Skip</option>
          </Control>
        </Row>
      </Card>
      <Card>
        <Title>Reset</Title>
        <Reset onClick={() => void reset()}>Restore safe defaults</Reset>
      </Card>
    </View>
  );
}
