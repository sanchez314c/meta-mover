import { render, screen } from '@testing-library/react';

import { HeroCardSection } from '../../../src/renderer/components/HeroCard';

describe('HeroCardSection capability copy', () => {
  it('describes only active safe processing capabilities', () => {
    render(
      <HeroCardSection
        status="ready"
        selectedFolder={null}
        fileCount={0}
        onSelectFolder={() => undefined}
      />
    );

    expect(screen.queryByText(/corruption detection/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/repair corrupted tags/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sync timestamps/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/perceptual hashing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/read-only metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/sha-256 content fingerprints/i)).toBeInTheDocument();
    expect(screen.getByText(/transactional copy and move safety/i)).toBeInTheDocument();
  });
});
