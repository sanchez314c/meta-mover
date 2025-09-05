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

const MetadataCard = styled.div`
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

const SelectFilesBtn = styled.button`
  padding: 12px 24px;
  background: var(--gradient-button);
  color: var(--bg-void);
  border: none;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: all 150ms ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow-glow-strong);
  }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 60px 20px;
  color: var(--text-muted);
`;

const EmptyIcon = styled.div`
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.3;
`;

const EmptyTitle = styled.h3`
  font-size: 18px;
  font-weight: 600;
  color: var(--text-heading);
  margin-bottom: 8px;
`;

const EmptyDesc = styled.p`
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 400px;
  margin: 0 auto 24px;
  line-height: 1.6;
`;

const FileList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 20px;
`;

const FileItem = styled.div<{ $active?: boolean }>`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: ${({ $active }) =>
    $active ? 'var(--accent-teal-dim)' : 'var(--bg-card, rgba(255,255,255,0.02))'};
  border: 1px solid ${({ $active }) => ($active ? 'rgba(20,184,166,0.3)' : 'var(--glass-border)')};
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  transition: all 150ms ease;

  &:hover {
    border-color: var(--border-light);
  }
`;

const FileIcon = styled.div`
  width: 32px;
  height: 32px;
  background: var(--accent-teal-dim);
  border-radius: var(--radius-sm, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-teal);
  font-size: 14px;
  flex-shrink: 0;
`;

const FileDetails = styled.div`
  flex: 1;
  overflow: hidden;
`;

const FileName = styled.div`
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const FilePath = styled.div`
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const MetadataPanel = styled.div`
  background: var(--bg-input, rgba(0, 0, 0, 0.2));
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md, 8px);
  padding: 20px;
`;

const MetadataGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
`;

const MetadataField = styled.div``;

const FieldLabel = styled.div`
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 4px;
`;

const FieldValue = styled.div`
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 400;
`;

const PlaceholderNote = styled.div`
  margin-top: 16px;
  padding: 12px 16px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: var(--radius-md, 8px);
  font-size: 12px;
  color: var(--status-warning);
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function getFileExtension(filePath: string): string {
  const name = getFileName(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(dot + 1).toUpperCase() : 'FILE';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function MetadataView() {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const handleSelectFiles = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const files = await window.electronAPI.selectFiles();
      if (files && Array.isArray(files) && files.length > 0) {
        setSelectedFiles(files);
        setActiveFile(files[0]);
      }
    } catch {
      // Selection cancelled or failed
    }
  }, []);

  const handleSelectFolder = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const folder = await window.electronAPI.selectDirectory();
      if (folder) {
        setSelectedFiles([folder]);
        setActiveFile(folder);
      }
    } catch {
      // Selection cancelled or failed
    }
  }, []);

  if (selectedFiles.length === 0) {
    return (
      <ViewContainer>
        <MetadataCard>
          <EmptyState>
            <EmptyIcon>&#128269;</EmptyIcon>
            <EmptyTitle>Metadata Inspector</EmptyTitle>
            <EmptyDesc>
              Select files or a folder to view their metadata. You can inspect EXIF data, file
              properties, camera info, dimensions, and more.
            </EmptyDesc>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <SelectFilesBtn onClick={handleSelectFiles}>Select Files</SelectFilesBtn>
              <SelectFilesBtn
                onClick={handleSelectFolder}
                style={{
                  background: 'var(--glass-bg)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-light)',
                }}
              >
                Select Folder
              </SelectFilesBtn>
            </div>
          </EmptyState>
        </MetadataCard>
      </ViewContainer>
    );
  }

  const active = activeFile || selectedFiles[0];
  const ext = getFileExtension(active);

  return (
    <ViewContainer>
      <MetadataCard>
        <CardTitle>Selected Files ({selectedFiles.length})</CardTitle>
        <FileList>
          {selectedFiles.map((file) => (
            <FileItem key={file} $active={file === active} onClick={() => setActiveFile(file)}>
              <FileIcon>{getFileExtension(file).substring(0, 3)}</FileIcon>
              <FileDetails>
                <FileName>{getFileName(file)}</FileName>
                <FilePath>{file}</FilePath>
              </FileDetails>
            </FileItem>
          ))}
        </FileList>
        <div style={{ display: 'flex', gap: 12 }}>
          <SelectFilesBtn onClick={handleSelectFiles} style={{ fontSize: 13, padding: '8px 16px' }}>
            Add More Files
          </SelectFilesBtn>
          <SelectFilesBtn
            onClick={() => {
              setSelectedFiles([]);
              setActiveFile(null);
            }}
            style={{
              fontSize: 13,
              padding: '8px 16px',
              background: 'var(--glass-bg)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-light)',
            }}
          >
            Clear
          </SelectFilesBtn>
        </div>
      </MetadataCard>

      <MetadataCard>
        <CardTitle>Metadata: {getFileName(active)}</CardTitle>
        <MetadataPanel>
          <MetadataGrid>
            <MetadataField>
              <FieldLabel>File Name</FieldLabel>
              <FieldValue>{getFileName(active)}</FieldValue>
            </MetadataField>
            <MetadataField>
              <FieldLabel>File Type</FieldLabel>
              <FieldValue>{ext}</FieldValue>
            </MetadataField>
            <MetadataField>
              <FieldLabel>Full Path</FieldLabel>
              <FieldValue style={{ wordBreak: 'break-all' }}>{active}</FieldValue>
            </MetadataField>
            <MetadataField>
              <FieldLabel>Size</FieldLabel>
              <FieldValue>--</FieldValue>
            </MetadataField>
            <MetadataField>
              <FieldLabel>Dimensions</FieldLabel>
              <FieldValue>--</FieldValue>
            </MetadataField>
            <MetadataField>
              <FieldLabel>Camera</FieldLabel>
              <FieldValue>--</FieldValue>
            </MetadataField>
            <MetadataField>
              <FieldLabel>Date Taken</FieldLabel>
              <FieldValue>--</FieldValue>
            </MetadataField>
            <MetadataField>
              <FieldLabel>Date Modified</FieldLabel>
              <FieldValue>--</FieldValue>
            </MetadataField>
          </MetadataGrid>
        </MetadataPanel>
        <PlaceholderNote>
          Metadata extraction requires the backend handler (coming in a future update). File
          selection and path display are fully functional.
        </PlaceholderNote>
      </MetadataCard>
    </ViewContainer>
  );
}
