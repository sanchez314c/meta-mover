import React, { useEffect, useCallback, Component, ErrorInfo, ReactNode } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from './store';
import { initializeApp } from './store/slices/appSlice';
import { applyProcessingEvent } from './store/slices/jobsSlice';
import type { ProcessingEvent } from '../shared/types/processing';

// Error Boundary to catch rendering crashes
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React Error Boundary caught:', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 32,
            color: '#ef4444',
            background: '#1a1a2e',
            height: '100%',
            fontFamily: 'monospace',
            overflow: 'auto',
          }}
        >
          <h2 style={{ color: '#14b8a6' }}>META Mover crashed</h2>
          <pre style={{ color: '#e2e8f0', whiteSpace: 'pre-wrap', marginTop: 16 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ color: '#94a3b8', whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16,
              padding: '8px 16px',
              background: '#14b8a6',
              color: '#0f0f23',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import { setActiveView, openModal, closeModal, removeNotification } from './store/slices/uiSlice';
import { setTheme } from './store/slices/settingsSlice';
// @ts-expect-error — no type declarations for PNG import
import appIconSrc from './icon-titlebar.png';

import { AppContainer, AppBody, MainContent } from './styles/components';
import { TitleBarComponent } from './components/TitleBar';
import { SidebarComponent, NavTab } from './components/Sidebar';
import { ProcessingLauncher } from './components/ProcessingLauncher';
import { StatusBarComponent } from './components/StatusBar';
import { AboutModalComponent } from './components/AboutModal';
import { SettingsView } from './components/views/SettingsView';
import { ProcessingView } from './components/views/ProcessingView';
import { MetadataView } from './components/views/MetadataView';
import { ReviewView } from './components/views/ReviewView';

function App() {
  const dispatch = useDispatch<AppDispatch>();

  // Redux state
  const isLoading = useSelector((state: RootState) => state.app.isLoading);
  const appError = useSelector((state: RootState) => state.app.error);
  const activeView = useSelector((state: RootState) => state.ui.activeView);
  const aboutOpen = useSelector((state: RootState) => state.ui.modals.about);
  const isProcessing = useSelector((state: RootState) => state.jobs.isProcessing);
  const notifications = useSelector((state: RootState) => state.ui.notifications);

  // Derive status from Redux state
  const status: 'ready' | 'processing' | 'error' = appError
    ? 'error'
    : isLoading || isProcessing
      ? 'processing'
      : 'ready';

  // Initialize app on mount
  useEffect(() => {
    dispatch(initializeApp());
  }, [dispatch]);

  // Load settings on mount
  useEffect(() => {
    async function loadSettings() {
      if (!window.electronAPI) return;
      try {
        const response = await window.electronAPI.getConfig();
        if (response.success && response.data) {
          dispatch(setTheme(response.data.theme));
        }
      } catch {
        // Settings load failure is non-fatal; defaults remain in place
      }
    }
    loadSettings();
  }, [dispatch]);

  // Processing events are global application state. Keeping the only renderer
  // subscription here preserves progress when the user changes views and makes
  // listener cleanup deterministic.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const handleProcessingEvent = (event: ProcessingEvent) => {
      dispatch(applyProcessingEvent(event));
    };

    return api.onProcessingEvent(handleProcessingEvent);
  }, [dispatch]);

  // Keyboard handler for closing about modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch(closeModal('about'));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch]);

  // Auto-dismiss notifications that have a duration
  useEffect(() => {
    if (notifications.length === 0) return;
    const timers = notifications
      .filter((n) => typeof n.duration === 'number' && n.duration > 0)
      .map((n) =>
        setTimeout(() => {
          dispatch(removeNotification(n.id));
        }, n.duration)
      );
    return () => timers.forEach(clearTimeout);
  }, [notifications, dispatch]);

  const handleOpenGithub = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const url = 'https://github.com/sanchez314c/meta-mover';
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }, []);

  const statusText =
    status === 'ready' ? 'Ready' : status === 'processing' ? 'Processing...' : 'Error';

  const renderSecondaryContent = () => {
    switch (activeView) {
      case 'processing':
        return <ProcessingView />;
      case 'metadata':
        return <MetadataView />;
      case 'review':
        return <ReviewView />;
      case 'settings':
        return <SettingsView />;
      case 'organize':
      default:
        return null;
    }
  };

  return (
    <ErrorBoundary>
      <AppContainer>
        <TitleBarComponent
          appIconSrc={appIconSrc}
          onAboutOpen={() => dispatch(openModal('about'))}
          onSettingsOpen={() => dispatch(setActiveView('settings'))}
          onMinimize={() => window.electronAPI?.windowMinimize()}
          onMaximize={() => window.electronAPI?.windowMaximize()}
          onClose={() => window.electronAPI?.windowClose()}
        />

        <AppBody>
          <SidebarComponent
            activeTab={activeView as NavTab}
            onTabChange={(tab) => dispatch(setActiveView(tab))}
          />
          <MainContent>
            <div hidden={activeView !== 'organize'}>
              <ProcessingLauncher />
            </div>
            {renderSecondaryContent()}
          </MainContent>
        </AppBody>

        <StatusBarComponent status={status} statusText={statusText} itemCountText="" />

        <AboutModalComponent
          isOpen={aboutOpen}
          onClose={() => dispatch(closeModal('about'))}
          onOpenGithub={handleOpenGithub}
          appIconSrc={appIconSrc}
        />
      </AppContainer>
    </ErrorBoundary>
  );
}

export default App;
