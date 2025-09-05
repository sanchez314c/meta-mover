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

const DuplicatesCard = styled.div`
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

const ComingSoonBanner = styled.div`
  margin-top: 16px;
  padding: 14px 18px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: var(--radius-md, 8px);
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
  color: var(--status-warning);
`;

const ComingSoonIcon = styled.div`
  font-size: 18px;
  flex-shrink: 0;
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
  max-width: 420px;
  margin: 0 auto;
  line-height: 1.6;
`;

const FeatureList = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 20px;
`;

const FeatureItem = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  background: var(--bg-card, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md, 8px);
`;

const FeatureItemIcon = styled.div`
  width: 28px;
  height: 28px;
  background: var(--accent-teal-dim);
  border-radius: var(--radius-sm, 4px);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-teal);
  font-size: 13px;
  flex-shrink: 0;
`;

const FeatureItemText = styled.div`
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;

  strong {
    color: var(--text-primary);
    display: block;
    margin-bottom: 2px;
  }
`;

// ─── Component ───────────────────────────────────────────────────────────────

export function DuplicatesView() {
  const [scanPath, setScanPath] = useState<string | null>(null);

  const selectFolder = useCallback(async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.selectDirectory();
    if (path) setScanPath(path);
  }, []);

  return (
    <ViewContainer>
      <DuplicatesCard>
        <CardTitle>Scan for Duplicates</CardTitle>
        <FolderSelector>
          <FolderPath>{scanPath || 'Select a folder to scan...'}</FolderPath>
          <BrowseBtn onClick={selectFolder}>Browse</BrowseBtn>
        </FolderSelector>

        <ComingSoonBanner>
          <ComingSoonIcon>⚠</ComingSoonIcon>
          <span>
            <strong>Feature coming soon.</strong> Duplicate detection backend is not yet
            implemented. Folder selection is ready for when the feature ships.
          </span>
        </ComingSoonBanner>
      </DuplicatesCard>

      <DuplicatesCard>
        <EmptyState>
          <EmptyIcon>&#128196;&#128196;</EmptyIcon>
          <EmptyTitle>Duplicate Detection</EmptyTitle>
          <EmptyDesc>
            Find and manage duplicate files across your photo and video libraries. Select a folder
            above to begin scanning.
          </EmptyDesc>
        </EmptyState>

        <FeatureList>
          <FeatureItem>
            <FeatureItemIcon>#</FeatureItemIcon>
            <FeatureItemText>
              <strong>Hash Comparison</strong>
              Compare files using SHA-256 hashes for exact duplicate detection
            </FeatureItemText>
          </FeatureItem>
          <FeatureItem>
            <FeatureItemIcon>~</FeatureItemIcon>
            <FeatureItemText>
              <strong>Visual Similarity</strong>
              Detect near-duplicates using perceptual image hashing
            </FeatureItemText>
          </FeatureItem>
          <FeatureItem>
            <FeatureItemIcon>G</FeatureItemIcon>
            <FeatureItemText>
              <strong>Group Review</strong>
              Review duplicate groups and choose which copies to keep
            </FeatureItemText>
          </FeatureItem>
          <FeatureItem>
            <FeatureItemIcon>S</FeatureItemIcon>
            <FeatureItemText>
              <strong>Space Recovery</strong>
              See how much disk space you can recover by removing duplicates
            </FeatureItemText>
          </FeatureItem>
        </FeatureList>
      </DuplicatesCard>
    </ViewContainer>
  );
}
