import React from 'react';
import styled from 'styled-components';

const ViewContainer = styled.div`
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
  margin: 0 0 10px;
  color: var(--text-heading);
  font-size: 18px;
`;
const Intro = styled.p`
  max-width: 720px;
  margin: 0 0 22px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.6;
`;
const EvidenceGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
`;
const EvidenceCard = styled.div`
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  h4 {
    margin: 0 0 7px;
    color: var(--accent-teal);
    font-size: 13px;
  }
  p {
    margin: 0;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.55;
  }
`;
const TruthNote = styled.div`
  margin-top: 18px;
  padding: 13px 15px;
  color: var(--text-secondary);
  background: rgba(20, 184, 166, 0.07);
  border: 1px solid rgba(20, 184, 166, 0.22);
  border-radius: var(--radius-md);
  font-size: 12px;
  line-height: 1.55;
`;

export function MetadataView() {
  return (
    <ViewContainer>
      <Card>
        <Title>Metadata evidence</Title>
        <Intro>
          Each file&apos;s creation-date evidence appears in the Organize preview before any copy or
          move begins. The preview shows the selected date, its source, confidence, warnings, and
          exact destination path.
        </Intro>
        <EvidenceGrid>
          <EvidenceCard>
            <h4>Embedded metadata</h4>
            <p>
              Camera, image, video, and container date fields are evaluated without rewriting the
              original file.
            </p>
          </EvidenceCard>
          <EvidenceCard>
            <h4>Filename evidence</h4>
            <p>
              Recognized date patterns can support a result when embedded metadata is absent or
              conflicting.
            </p>
          </EvidenceCard>
          <EvidenceCard>
            <h4>Filesystem birth time</h4>
            <p>
              Creation time is lower-confidence supporting evidence. Modified time is not treated as
              ground truth.
            </p>
          </EvidenceCard>
        </EvidenceGrid>
        <TruthNote>
          Files with unresolved or conflicting dates stay visible as warnings in the preview and are
          routed for review. Metadata writeback is disabled, so the organizer does not stamp an
          inferred date into the source media.
        </TruthNote>
      </Card>
    </ViewContainer>
  );
}
