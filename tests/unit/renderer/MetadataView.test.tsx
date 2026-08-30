import { render, screen } from '@testing-library/react';

import { MetadataView } from '../../../src/renderer/components/views/MetadataView';

describe('MetadataView', () => {
  it('describes the real preview evidence flow without fake inspector controls', () => {
    render(<MetadataView />);

    expect(screen.getByText('Metadata evidence')).toBeInTheDocument();
    expect(
      screen.getByText(/creation-date evidence appears in the Organize preview/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Embedded metadata' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/coming in a future update/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Select Files/i)).not.toBeInTheDocument();
  });
});
