import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsView } from '../../../src/renderer/components/views/SettingsView';

const config = {
  version: 3 as const,
  theme: 'system' as const,
  processing: {
    workerCount: 4,
    operation: 'copy' as const,
    verifyIntegrity: true as const,
  },
  organization: {
    folderStructure: 'year/month' as const,
    conflictPolicy: 'rename' as const,
    appendScreenshotSuffix: false,
  },
};

describe('SettingsView', () => {
  it('shows only real settings and persists a nested change before claiming success', async () => {
    const updateConfig = jest.fn().mockResolvedValue({
      success: true,
      data: { ...config, processing: { ...config.processing, workerCount: 6 } },
    });
    window.electronAPI = {
      getConfig: jest.fn().mockResolvedValue({ success: true, data: config }),
      updateConfig,
      resetConfig: jest.fn().mockResolvedValue({ success: true, data: config }),
    } as unknown as Window['electronAPI'];

    render(<SettingsView />);

    const workers = await screen.findByLabelText('Worker count');
    expect(screen.queryByText(/GPU/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/corruption/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /overwrite/i })).not.toBeInTheDocument();
    await userEvent.clear(workers);
    await userEvent.type(workers, '6');
    await userEvent.tab();

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ processing: { workerCount: 6 } })
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('surfaces persistence failure instead of displaying a false saved state', async () => {
    window.electronAPI = {
      getConfig: jest.fn().mockResolvedValue({ success: true, data: config }),
      updateConfig: jest.fn().mockResolvedValue({
        success: false,
        error: { code: 'WRITE_FAILED', message: 'Disk is read-only', recoverable: false },
      }),
      resetConfig: jest.fn(),
    } as unknown as Window['electronAPI'];

    render(<SettingsView />);
    const theme = await screen.findByLabelText('Theme');
    await userEvent.selectOptions(theme, 'dark');

    expect(await screen.findByText('Disk is read-only')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('shows and persists the screenshot filename toggle', async () => {
    const updateConfig = jest.fn().mockResolvedValue({
      success: true,
      data: {
        ...config,
        organization: { ...config.organization, appendScreenshotSuffix: true },
      },
    });
    window.electronAPI = {
      getConfig: jest.fn().mockResolvedValue({ success: true, data: config }),
      updateConfig,
      resetConfig: jest.fn().mockResolvedValue({ success: true, data: config }),
    } as unknown as Window['electronAPI'];

    render(<SettingsView />);
    const toggle = await screen.findByRole('checkbox', { name: 'Label screenshots in filenames' });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        organization: { appendScreenshotSuffix: true },
      })
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });
});
