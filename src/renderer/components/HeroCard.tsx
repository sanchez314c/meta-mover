import React from 'react';
import {
  HeroCard,
  HeroTitle,
  HeroSubtitle,
  ButtonGroup,
  BtnPrimary,
  BtnSecondary,
  FolderBanner,
  ProcessingSpinner,
  StatGrid,
  StatCard,
  StatValue,
  StatLabel,
  ContentSection,
  SectionHeader,
  FeatureGrid,
  FeatureCard,
  FeatureIcon,
} from '../styles/components';

type AppStatus = 'ready' | 'processing' | 'error';

interface HeroCardSectionProps {
  status: AppStatus;
  selectedFolder: string | null;
  fileCount: number;
  onSelectFolder: () => void;
}

export function HeroCardSection({
  status,
  selectedFolder,
  fileCount,
  onSelectFolder,
}: HeroCardSectionProps) {
  return (
    <>
      {/* Hero Card — ambient radial mesh */}
      <HeroCard>
        <HeroTitle>
          Welcome to <span>Meta Mover</span>
        </HeroTitle>
        <HeroSubtitle>
          Professional media organization suite for photographers and content creators. Organize,
          rename, and manage your media files with powerful automation and advanced metadata
          handling.
        </HeroSubtitle>

        {selectedFolder && (
          <FolderBanner>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent-teal)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            Selected: <span>{selectedFolder}</span>
          </FolderBanner>
        )}

        <ButtonGroup>
          <BtnPrimary onClick={onSelectFolder} disabled={status === 'processing'}>
            {status === 'processing' ? (
              <>
                <ProcessingSpinner />
                Selecting...
              </>
            ) : (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                Select Folder
              </>
            )}
          </BtnPrimary>
          <BtnSecondary>Learn More</BtnSecondary>
        </ButtonGroup>
      </HeroCard>

      {/* Stat Cards */}
      <StatGrid>
        <StatCard>
          <StatValue>{fileCount}</StatValue>
          <StatLabel>Files Queued</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>0</StatValue>
          <StatLabel>Processed</StatLabel>
        </StatCard>
        <StatCard>
          <StatValue>0</StatValue>
          <StatLabel>Duplicates Found</StatLabel>
        </StatCard>
      </StatGrid>

      {/* Feature Cards */}
      <ContentSection>
        <SectionHeader>Capabilities</SectionHeader>
        <FeatureGrid>
          <FeatureCard>
            <h3>
              <FeatureIcon>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                </svg>
              </FeatureIcon>
              Smart Organization
            </h3>
            <p>
              Organize media from defensible creation dates. Ambiguous files are isolated for review
              instead of being given a guessed timestamp.
            </p>
          </FeatureCard>
          <FeatureCard>
            <h3>
              <FeatureIcon>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                  <line x1="7" y1="7" x2="7.01" y2="7" />
                </svg>
              </FeatureIcon>
              Metadata Management
            </h3>
            <p>
              Read-only metadata extraction records every date candidate, source tag, confidence,
              and final resolution without changing source metadata.
            </p>
          </FeatureCard>
          <FeatureCard>
            <h3>
              <FeatureIcon>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </FeatureIcon>
              Duplicate Detection
            </h3>
            <p>
              SHA-256 content fingerprints identify exact duplicates while deterministic collision
              handling prevents destination overwrites.
            </p>
          </FeatureCard>
          <FeatureCard>
            <h3>
              <FeatureIcon>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </FeatureIcon>
              Batch Processing
            </h3>
            <p>
              Process large batches with bounded worker concurrency, SHA-256 verification, and
              transactional copy and move safety.
            </p>
          </FeatureCard>
        </FeatureGrid>
      </ContentSection>
    </>
  );
}
