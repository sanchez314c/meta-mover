import React, { useState, useEffect, useCallback } from 'react';
import styled from 'styled-components';

// ─── Styled Components ───────────────────────────────────────────────────────

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

const SettingsCard = styled.div`
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

const CardTitle = styled.h3`
  font-size: 16px;
  font-weight: 600;
  color: var(--text-heading);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
`;

const CardIcon = styled.span`
  width: 28px;
  height: 28px;
  background: var(--accent-teal-dim);
  border-radius: var(--radius-sm, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-teal);
  font-size: 14px;
`;

const SettingRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);

  &:last-child {
    border-bottom: none;
  }
`;

const SettingInfo = styled.div``;

const SettingLabel = styled.div`
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 2px;
`;

const SettingDesc = styled.div`
  font-size: 12px;
  color: var(--text-muted);
`;

const SelectInput = styled.select`
  padding: 8px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-button, 6px);
  color: var(--text-primary);
  font-size: 13px;
  min-width: 160px;
  cursor: pointer;
  outline: none;
  transition: border-color 150ms ease;

  &:focus {
    border-color: var(--accent-teal);
  }

  option {
    background: var(--bg-void, #0a0a0f);
    color: var(--text-primary);
  }
`;

const NumberInput = styled.input`
  width: 80px;
  padding: 8px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-button, 6px);
  color: var(--text-primary);
  font-size: 13px;
  text-align: center;
  outline: none;
  transition: border-color 150ms ease;

  &:focus {
    border-color: var(--accent-teal);
  }

  &::-webkit-inner-spin-button,
  &::-webkit-outer-spin-button {
    opacity: 1;
  }
`;

const ToggleSwitch = styled.label`
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  cursor: pointer;
`;

const ToggleInput = styled.input`
  opacity: 0;
  width: 0;
  height: 0;

  &:checked + span {
    background: var(--accent-teal);
  }

  &:checked + span::before {
    transform: translateX(20px);
  }
`;

const ToggleSlider = styled.span`
  position: absolute;
  inset: 0;
  background: var(--border-subtle);
  border-radius: 12px;
  transition: all 200ms ease;

  &::before {
    content: '';
    position: absolute;
    height: 18px;
    width: 18px;
    left: 3px;
    bottom: 3px;
    background: #ffffff;
    border-radius: 50%;
    transition: transform 200ms ease;
  }
`;

const ResetBtn = styled.button`
  width: 100%;
  padding: 12px;
  background: transparent;
  border: 1px solid var(--status-error);
  border-radius: var(--radius-button);
  color: var(--status-error);
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 150ms ease;

  &:hover {
    background: rgba(239, 68, 68, 0.1);
  }
`;

const SaveIndicator = styled.span`
  font-size: 11px;
  color: var(--status-success);
  opacity: 0;
  transition: opacity 300ms ease;

  &.visible {
    opacity: 1;
  }
`;

// ─── Config Types ────────────────────────────────────────────────────────────

interface LocalSettings {
  theme: string;
  workerCount: number;
  folderStructure: string;
  conflictResolution: string;
  gpuAcceleration: boolean;
  corruptionDetection: boolean;
}

const DEFAULT_SETTINGS: LocalSettings = {
  theme: 'dark',
  workerCount: 4,
  folderStructure: 'year/month',
  conflictResolution: 'rename',
  gpuAcceleration: false,
  corruptionDetection: true,
};

// ─── Component ───────────────────────────────────────────────────────────────

export function SettingsView() {
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [saveFlash, setSaveFlash] = useState('');

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    if (!window.electronAPI) return;
    try {
      const loaded = await window.electronAPI.getConfig();
      if (loaded && typeof loaded === 'object') {
        const cfg = loaded as Record<string, unknown>;
        // ConfigManager stores nested: processingOptions and organizationOptions
        const proc = (cfg.processingOptions as Record<string, unknown>) || {};
        const org = (cfg.organizationOptions as Record<string, unknown>) || {};
        setSettings({
          theme: typeof cfg.theme === 'string' ? cfg.theme : DEFAULT_SETTINGS.theme,
          workerCount:
            typeof proc.maxConcurrentJobs === 'number'
              ? proc.maxConcurrentJobs
              : DEFAULT_SETTINGS.workerCount,
          folderStructure:
            typeof org.folderStructure === 'string'
              ? org.folderStructure
              : DEFAULT_SETTINGS.folderStructure,
          conflictResolution:
            typeof org.conflictResolution === 'string'
              ? org.conflictResolution
              : DEFAULT_SETTINGS.conflictResolution,
          gpuAcceleration:
            typeof proc.enableGPU === 'boolean' ? proc.enableGPU : DEFAULT_SETTINGS.gpuAcceleration,
          corruptionDetection: DEFAULT_SETTINGS.corruptionDetection,
        });
      }
    } catch {
      // Config API may not be available
    }
  }

  const saveProcessingOptions = useCallback(async (patch: Partial<LocalSettings>) => {
    if (!window.electronAPI) return;
    try {
      // Build the correct nested processingOptions patch
      const procPatch: Record<string, unknown> = {};
      if ('workerCount' in patch) procPatch.maxConcurrentJobs = patch.workerCount;
      if ('gpuAcceleration' in patch) procPatch.enableGPU = patch.gpuAcceleration;

      const orgPatch: Record<string, unknown> = {};
      if ('folderStructure' in patch) orgPatch.folderStructure = patch.folderStructure;
      if ('conflictResolution' in patch) orgPatch.conflictResolution = patch.conflictResolution;

      if (Object.keys(procPatch).length > 0) {
        const current = await window.electronAPI.getConfig();
        const currentProc =
          current && typeof current === 'object'
            ? ((current as Record<string, unknown>).processingOptions as Record<string, unknown>) ||
              {}
            : {};
        await window.electronAPI.setConfig('processingOptions', {
          ...currentProc,
          ...procPatch,
        } as unknown);
      }

      if (Object.keys(orgPatch).length > 0) {
        const current = await window.electronAPI.getConfig();
        const currentOrg =
          current && typeof current === 'object'
            ? ((current as Record<string, unknown>).organizationOptions as Record<
                string,
                unknown
              >) || {}
            : {};
        await window.electronAPI.setConfig('organizationOptions', {
          ...currentOrg,
          ...orgPatch,
        } as unknown);
      }

      if ('theme' in patch) {
        await window.electronAPI.setConfig('theme', patch.theme as unknown);
      }
    } catch {
      // Save failed silently
    }
  }, []);

  const updateSetting = useCallback(
    async (key: keyof LocalSettings, value: LocalSettings[keyof LocalSettings]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));

      if (window.electronAPI) {
        try {
          await saveProcessingOptions({ [key]: value });
          setSaveFlash(key);
          setTimeout(() => setSaveFlash(''), 1500);
        } catch {
          // Save failed silently
        }
      }
    },
    [saveProcessingOptions]
  );

  const handleReset = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.resetConfig();
      setSettings(DEFAULT_SETTINGS);
      setSaveFlash('reset');
      setTimeout(() => setSaveFlash(''), 1500);
    } catch {
      // Reset failed
    }
  }, []);

  return (
    <ViewContainer>
      {/* General Settings */}
      <SettingsCard>
        <CardTitle>
          <CardIcon>G</CardIcon>
          General
        </CardTitle>

        <SettingRow>
          <SettingInfo>
            <SettingLabel>Theme</SettingLabel>
            <SettingDesc>Application color scheme</SettingDesc>
          </SettingInfo>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SelectInput
              value={settings.theme}
              onChange={(e) => updateSetting('theme', e.target.value)}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </SelectInput>
            <SaveIndicator className={saveFlash === 'theme' ? 'visible' : ''}>Saved</SaveIndicator>
          </div>
        </SettingRow>
      </SettingsCard>

      {/* Processing Settings */}
      <SettingsCard>
        <CardTitle>
          <CardIcon>P</CardIcon>
          Processing
        </CardTitle>

        <SettingRow>
          <SettingInfo>
            <SettingLabel>Worker Count</SettingLabel>
            <SettingDesc>Number of parallel processing workers</SettingDesc>
          </SettingInfo>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <NumberInput
              type="number"
              min={1}
              max={16}
              value={settings.workerCount}
              onChange={(e) => updateSetting('workerCount', parseInt(e.target.value, 10) || 1)}
            />
            <SaveIndicator className={saveFlash === 'workerCount' ? 'visible' : ''}>
              Saved
            </SaveIndicator>
          </div>
        </SettingRow>

        <SettingRow>
          <SettingInfo>
            <SettingLabel>GPU Acceleration</SettingLabel>
            <SettingDesc>Use GPU for image processing when available</SettingDesc>
          </SettingInfo>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ToggleSwitch>
              <ToggleInput
                type="checkbox"
                checked={settings.gpuAcceleration}
                onChange={(e) => updateSetting('gpuAcceleration', e.target.checked)}
              />
              <ToggleSlider />
            </ToggleSwitch>
            <SaveIndicator className={saveFlash === 'gpuAcceleration' ? 'visible' : ''}>
              Saved
            </SaveIndicator>
          </div>
        </SettingRow>

        <SettingRow>
          <SettingInfo>
            <SettingLabel>Corruption Detection</SettingLabel>
            <SettingDesc>Validate file integrity during processing</SettingDesc>
          </SettingInfo>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ToggleSwitch>
              <ToggleInput
                type="checkbox"
                checked={settings.corruptionDetection}
                onChange={(e) => updateSetting('corruptionDetection', e.target.checked)}
              />
              <ToggleSlider />
            </ToggleSwitch>
            <SaveIndicator className={saveFlash === 'corruptionDetection' ? 'visible' : ''}>
              Saved
            </SaveIndicator>
          </div>
        </SettingRow>
      </SettingsCard>

      {/* Organization Settings */}
      <SettingsCard>
        <CardTitle>
          <CardIcon>O</CardIcon>
          Organization
        </CardTitle>

        <SettingRow>
          <SettingInfo>
            <SettingLabel>Folder Structure</SettingLabel>
            <SettingDesc>How files are organized into folders</SettingDesc>
          </SettingInfo>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SelectInput
              value={settings.folderStructure}
              onChange={(e) => updateSetting('folderStructure', e.target.value)}
            >
              <option value="year/month">Year / Month</option>
              <option value="year-month">Year-Month</option>
              <option value="flat">Flat (no subfolders)</option>
            </SelectInput>
            <SaveIndicator className={saveFlash === 'folderStructure' ? 'visible' : ''}>
              Saved
            </SaveIndicator>
          </div>
        </SettingRow>

        <SettingRow>
          <SettingInfo>
            <SettingLabel>Conflict Resolution</SettingLabel>
            <SettingDesc>What to do when a file already exists at the destination</SettingDesc>
          </SettingInfo>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SelectInput
              value={settings.conflictResolution}
              onChange={(e) => updateSetting('conflictResolution', e.target.value)}
            >
              <option value="rename">Rename (add suffix)</option>
              <option value="skip">Skip existing</option>
              <option value="overwrite">Overwrite</option>
            </SelectInput>
            <SaveIndicator className={saveFlash === 'conflictResolution' ? 'visible' : ''}>
              Saved
            </SaveIndicator>
          </div>
        </SettingRow>
      </SettingsCard>

      {/* Reset */}
      <SettingsCard>
        <CardTitle>
          <CardIcon>R</CardIcon>
          Reset
        </CardTitle>
        <SettingDesc style={{ marginBottom: 16 }}>
          Restore all settings to their default values. This action cannot be undone.
        </SettingDesc>
        <ResetBtn onClick={handleReset}>Reset All Settings</ResetBtn>
        {saveFlash === 'reset' && (
          <div
            style={{
              textAlign: 'center',
              marginTop: 8,
              color: 'var(--status-success)',
              fontSize: 12,
            }}
          >
            Settings reset to defaults
          </div>
        )}
      </SettingsCard>
    </ViewContainer>
  );
}
