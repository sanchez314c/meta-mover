import { configureStore } from '@reduxjs/toolkit';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';

jest.mock('../../../src/renderer/icon-titlebar.png', () => 'icon-titlebar.png');
jest.mock('../../../src/renderer/components/TitleBar', () => ({
  TitleBarComponent: () => <div data-testid="title-bar" />,
}));
jest.mock('../../../src/renderer/components/Sidebar', () => ({
  SidebarComponent: () => <div data-testid="sidebar" />,
}));
jest.mock('../../../src/renderer/components/StatusBar', () => ({
  StatusBarComponent: () => <div data-testid="status-bar" />,
}));
jest.mock('../../../src/renderer/components/AboutModal', () => ({
  AboutModalComponent: () => null,
}));
jest.mock('../../../src/renderer/components/ProcessingLauncher', () => ({
  ProcessingLauncher: () => <div data-testid="launcher" />,
}));
jest.mock('../../../src/renderer/components/views/SettingsView', () => ({
  SettingsView: () => <div data-testid="settings-view" />,
}));

import App from '../../../src/renderer/App';
import appSlice from '../../../src/renderer/store/slices/appSlice';
import jobsReducer from '../../../src/renderer/store/slices/jobsSlice';
import settingsSlice from '../../../src/renderer/store/slices/settingsSlice';
import uiSlice from '../../../src/renderer/store/slices/uiSlice';
import { setActiveView } from '../../../src/renderer/store/slices/uiSlice';
import type { ProcessingEvent } from '../../../src/shared/types/processing';

describe('App processing event bridge', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it('uses one global subscription, maps events into Redux, and unsubscribes on unmount', async () => {
    const unsubscribe = jest.fn();
    let listener: ((event: ProcessingEvent) => void) | undefined;
    const onProcessingEvent = jest.fn((callback: (event: ProcessingEvent) => void) => {
      listener = callback;
      return unsubscribe;
    });
    window.electronAPI = {
      getSystemInfo: jest.fn().mockResolvedValue({}),
      getConfig: jest.fn().mockResolvedValue({
        success: true,
        data: {
          version: 2,
          theme: 'dark',
          processing: {
            workerCount: 4,
            operation: 'copy',
            verifyIntegrity: true,
          },
          organization: {
            folderStructure: 'year/month',
            conflictPolicy: 'rename',
            appendScreenshotSuffix: false,
          },
        },
      }),
      onProcessingEvent,
    } as unknown as Window['electronAPI'];
    const store = configureStore({
      reducer: {
        app: appSlice.reducer,
        jobs: jobsReducer,
        settings: settingsSlice,
        ui: uiSlice,
      },
    });

    const view = render(
      <Provider store={store}>
        <App />
      </Provider>
    );
    await waitFor(() => expect(listener).toBeDefined());
    expect(onProcessingEvent).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(store.getState().settings.theme).toBe('dark'));

    act(() => {
      listener!({
        kind: 'job-queued',
        jobId: 'job-9',
        sequence: 1,
        emittedAt: '2026-08-29T20:00:00.000Z',
        payload: {
          previewId: 'preview-9',
          effectiveOptions: {
            operation: 'copy',
            conflictPolicy: 'rename',
            folderStructure: 'year/month',
            workerCount: 4,
            verifyIntegrity: true,
            appendScreenshotSuffix: false,
            writeMetadataDates: false,
          },
        },
      });
      listener!({
        kind: 'job-progress',
        jobId: 'job-9',
        sequence: 2,
        emittedAt: '2026-08-29T20:00:01.000Z',
        payload: {
          phase: 'organization',
          filesProcessed: 3,
          totalFiles: 4,
          percentage: 75,
          currentFile: '/media/source/a.jpg',
        },
      });
      listener!({
        kind: 'job-completed',
        jobId: 'job-9',
        sequence: 3,
        emittedAt: '2026-08-29T20:00:02.000Z',
        payload: {
          statistics: {
            totalFiles: 4,
            processedFiles: 4,
            skippedFiles: 0,
            failedFiles: 0,
            totalBytes: 100,
            processedBytes: 100,
            durationMs: 2000,
          },
        },
      });
    });

    expect(store.getState().jobs.jobs).toEqual([
      expect.objectContaining({
        id: 'job-9',
        status: 'completed',
        progress: 100,
        filesProcessed: 4,
        totalFiles: 4,
      }),
    ]);
    expect(store.getState().jobs.activeJobId).toBeNull();

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the organizer mounted while another view is active', async () => {
    window.electronAPI = {
      getSystemInfo: jest.fn().mockResolvedValue({}),
      getConfig: jest.fn().mockResolvedValue({ success: false }),
      onProcessingEvent: jest.fn(() => jest.fn()),
    } as unknown as Window['electronAPI'];
    const store = configureStore({
      reducer: {
        app: appSlice.reducer,
        jobs: jobsReducer,
        settings: settingsSlice,
        ui: uiSlice,
      },
    });
    render(
      <Provider store={store}>
        <App />
      </Provider>
    );

    const launcher = screen.getByTestId('launcher');
    expect(launcher.parentElement).not.toHaveAttribute('hidden');
    act(() => {
      store.dispatch(setActiveView('settings'));
    });
    expect(screen.getByTestId('settings-view')).toBeInTheDocument();
    expect(launcher).toBeInTheDocument();
    expect(launcher.parentElement).toHaveAttribute('hidden');
  });
});
