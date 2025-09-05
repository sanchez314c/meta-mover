import React, { useState, useCallback } from 'react';
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

const BatchCard = styled.div`
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
`;

const CardDesc = styled.p`
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 16px;
`;

const OperationGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
`;

const OperationCard = styled.div<{ $disabled?: boolean }>`
  padding: 20px;
  background: var(--bg-card, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md, 8px);
  cursor: ${({ $disabled }) => ($disabled ? 'default' : 'pointer')};
  opacity: ${({ $disabled }) => ($disabled ? 0.6 : 1)};
  transition: all 150ms ease;

  &:hover {
    border-color: ${({ $disabled }) => ($disabled ? 'var(--glass-border)' : 'var(--border-light)')};
    transform: ${({ $disabled }) => ($disabled ? 'none' : 'translateY(-1px)')};
  }
`;

const OpIcon = styled.div`
  width: 40px;
  height: 40px;
  background: var(--accent-teal-dim);
  border-radius: var(--radius-sm, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-teal);
  font-size: 18px;
  margin-bottom: 12px;
`;

const OpTitle = styled.h4`
  font-size: 14px;
  font-weight: 600;
  color: var(--text-heading);
  margin-bottom: 6px;
`;

const OpDesc = styled.p`
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
`;

const OpBadge = styled.span`
  display: inline-block;
  padding: 2px 8px;
  background: rgba(245, 158, 11, 0.12);
  color: var(--status-warning);
  border-radius: var(--radius-full, 999px);
  font-size: 10px;
  font-weight: 500;
  margin-top: 8px;
`;

const FolderSelector = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
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

  &:hover {
    background: var(--bg-card-hover);
    color: var(--text-primary);
  }
`;

const SelectInput = styled.select`
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-button, 6px);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  outline: none;
  margin-bottom: 12px;
  transition: border-color 150ms ease;

  &:focus {
    border-color: var(--accent-teal);
  }

  option {
    background: var(--bg-void, #0a0a0f);
    color: var(--text-primary);
  }
`;

const SettingLabel = styled.label`
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
`;

const PreviewBanner = styled.div`
  padding: 14px 18px;
  background: rgba(20, 184, 166, 0.08);
  border: 1px solid rgba(20, 184, 166, 0.2);
  border-radius: var(--radius-md, 8px);
  display: flex;
  align-items: center;
  gap: 12px;
`;

const PreviewIcon = styled.div`
  width: 32px;
  height: 32px;
  background: var(--accent-teal-dim);
  border-radius: var(--radius-sm, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-teal);
  font-size: 16px;
  flex-shrink: 0;
`;

const PreviewText = styled.div`
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;

  strong {
    color: var(--accent-teal);
  }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 40px 20px;
  color: var(--text-muted);
  font-size: 14px;
`;

// ─── Component ───────────────────────────────────────────────────────────────

export function BatchView() {
  const [batchFolder, setBatchFolder] = useState<string | null>(null);
  const [renameTemplate, setRenameTemplate] = useState('date-sequential');
  const [dateSource, setDateSource] = useState('exif');

  const selectFolder = useCallback(async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.selectDirectory();
    if (path) setBatchFolder(path);
  }, []);

  return (
    <ViewContainer>
      {/* Batch Operations Overview */}
      <BatchCard>
        <CardTitle>Batch Operations</CardTitle>
        <CardDesc>
          Apply bulk operations to your media files. Select a folder, choose an operation, and
          preview changes before applying them.
        </CardDesc>

        <FolderSelector>
          <FolderPath>{batchFolder || 'Select a folder for batch operations...'}</FolderPath>
          <BrowseBtn onClick={selectFolder}>Browse</BrowseBtn>
        </FolderSelector>

        <OperationGrid>
          <OperationCard $disabled>
            <OpIcon>R</OpIcon>
            <OpTitle>Batch Rename</OpTitle>
            <OpDesc>
              Rename files using customizable templates based on date, sequence numbers, or original
              metadata.
            </OpDesc>
            <OpBadge>Coming Soon</OpBadge>
          </OperationCard>

          <OperationCard $disabled>
            <OpIcon>D</OpIcon>
            <OpTitle>Date Correction</OpTitle>
            <OpDesc>
              Fix incorrect dates in file metadata. Shift dates by offset or set from folder names.
            </OpDesc>
            <OpBadge>Coming Soon</OpBadge>
          </OperationCard>

          <OperationCard $disabled>
            <OpIcon>C</OpIcon>
            <OpTitle>Format Conversion</OpTitle>
            <OpDesc>
              Convert between image formats (HEIC to JPEG, RAW to TIFF, etc.) with quality settings.
            </OpDesc>
            <OpBadge>Coming Soon</OpBadge>
          </OperationCard>

          <OperationCard $disabled>
            <OpIcon>T</OpIcon>
            <OpTitle>Tag Management</OpTitle>
            <OpDesc>Add, remove, or edit tags and keywords across multiple files at once.</OpDesc>
            <OpBadge>Coming Soon</OpBadge>
          </OperationCard>
        </OperationGrid>
      </BatchCard>

      {/* Rename Configuration */}
      <BatchCard>
        <CardTitle>Rename Template</CardTitle>

        <SettingLabel>Naming Pattern</SettingLabel>
        <SelectInput value={renameTemplate} onChange={(e) => setRenameTemplate(e.target.value)}>
          <option value="date-sequential">Date + Sequence (2024-01-15_001.jpg)</option>
          <option value="date-original">Date + Original Name (2024-01-15_IMG_1234.jpg)</option>
          <option value="sequential">Sequential Only (001.jpg, 002.jpg)</option>
          <option value="camera-date">Camera + Date (Canon_2024-01-15_001.jpg)</option>
          <option value="custom">Custom Template</option>
        </SelectInput>

        <SettingLabel>Date Source</SettingLabel>
        <SelectInput value={dateSource} onChange={(e) => setDateSource(e.target.value)}>
          <option value="exif">EXIF Date Taken</option>
          <option value="modified">File Modified Date</option>
          <option value="created">File Created Date</option>
          <option value="filename">Extract from Filename</option>
        </SelectInput>

        {batchFolder ? (
          <EmptyState>
            Batch processing backend is not yet connected. Select options above to configure, then
            use the processing view to run operations.
          </EmptyState>
        ) : (
          <EmptyState>Select a folder above to configure batch operations.</EmptyState>
        )}
      </BatchCard>

      {/* Preview Mode Info */}
      <BatchCard>
        <CardTitle>Preview Mode</CardTitle>
        <PreviewBanner>
          <PreviewIcon>P</PreviewIcon>
          <PreviewText>
            All batch operations run in <strong>preview mode</strong> first. You&apos;ll see exactly
            what changes will be made before anything is modified. No files are touched until you
            confirm the operation.
          </PreviewText>
        </PreviewBanner>
      </BatchCard>
    </ViewContainer>
  );
}
