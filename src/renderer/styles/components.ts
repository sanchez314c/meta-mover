import styled, { keyframes } from 'styled-components';

// ─── Animations ─────────────────────────────────────────────────────────────
export const fadeIn = keyframes`from { opacity: 0; } to { opacity: 1; }`;
export const spin = keyframes`0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); }`;

// ─── Window Frame ────────────────────────────────────────────────────────────
export const AppContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--gradient-bg);
  border-radius: var(--radius-xl);
  overflow: hidden;
  position: relative;
  border: 1px solid var(--glass-border);
  box-shadow: none;
`;

// ─── Drag Handle ─────────────────────────────────────────────────────────────
export const DragHandle = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 48px;
  -webkit-app-region: drag;
  z-index: 50;
  pointer-events: none;
`;

// ─── Title Bar ───────────────────────────────────────────────────────────────
export const TitleBar = styled.div`
  display: flex;
  align-items: center;
  height: 48px;
  padding: 0 var(--space-md);
  position: relative;
  z-index: 100;
  background: transparent;
  flex-shrink: 0;
  -webkit-app-region: drag;
`;

export const AppIcon = styled.img`
  height: 18px;
  width: auto;
  object-fit: contain;
  margin-right: 10px;
  -webkit-app-region: no-drag;
  border-radius: 3px;
`;

export const AppName = styled.span`
  font-size: 15px;
  font-weight: 600;
  color: var(--accent-teal);
  margin-right: 10px;
  white-space: nowrap;
`;

export const AppTagline = styled.span`
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const TitleBarSpacer = styled.div`
  flex: 1;
`;

export const TitleBarControls = styled.div`
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
  z-index: 200;
`;

export const TitleBarActions = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  margin-right: 10px;
`;

export const TitleBarAction = styled.button<{ $isAbout?: boolean }>`
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-xs);
  transition: color var(--transition-fast);
  -webkit-app-region: no-drag;

  &:hover {
    color: ${({ $isAbout }) => ($isAbout ? 'var(--accent-teal)' : 'var(--text-primary)')};
  }
`;

export const WindowControls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`;

export const WindowCtrlBtn = styled.button<{ $isClose?: boolean }>`
  width: 28px;
  height: 28px;
  background: var(--glass-highlight);
  border: none;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;

  &:hover {
    background: ${({ $isClose }) => ($isClose ? 'var(--status-error)' : 'rgba(255,255,255,0.12)')};
    color: ${({ $isClose }) => ($isClose ? '#ffffff' : 'var(--text-primary)')};
  }
`;

// ─── App Body ─────────────────────────────────────────────────────────────────
export const AppBody = styled.div`
  display: flex;
  flex: 1;
  overflow: hidden;
`;

// ─── Sidebar ─────────────────────────────────────────────────────────────────
export const Sidebar = styled.div`
  width: 220px;
  min-width: 220px;
  background: var(--gradient-sidebar);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

export const NavSection = styled.div`
  margin-top: 4px;
`;

export const NavSectionTitle = styled.div`
  text-transform: uppercase;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.5px;
  color: var(--text-dim);
  padding: 16px 20px 8px;
`;

export const NavItem = styled.div<{ $active?: boolean }>`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  color: ${({ $active }) => ($active ? 'var(--accent-teal)' : 'var(--text-secondary)')};
  cursor: pointer;
  transition: all var(--transition-fast);
  font-size: 13.5px;
  border-left: 3px solid ${({ $active }) => ($active ? 'var(--accent-teal)' : 'transparent')};
  background: ${({ $active }) => ($active ? 'var(--accent-teal-dim)' : 'transparent')};
  -webkit-app-region: no-drag;

  &:hover {
    background: ${({ $active }) => ($active ? 'var(--accent-teal-dim)' : 'rgba(255,255,255,0.03)')};
    color: ${({ $active }) => ($active ? 'var(--accent-teal)' : 'var(--text-primary)')};
  }

  svg {
    flex-shrink: 0;
    opacity: ${({ $active }) => ($active ? '1' : '0.6')};
  }
`;

// ─── Main Content ─────────────────────────────────────────────────────────────
export const MainContent = styled.main`
  flex: 1;
  overflow-y: auto;
  padding: var(--space-lg);
  position: relative;
`;

export const ContentSection = styled.div`
  margin-bottom: 28px;
`;

export const SectionHeader = styled.h2`
  font-size: 16px;
  font-weight: 600;
  color: var(--text-heading);
  margin-bottom: 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-subtle);
`;

// ─── Glass Card Mixin (Hero with ambient mesh) ────────────────────────────────
export const HeroCard = styled.div`
  background:
    radial-gradient(ellipse at 80% 80%, rgba(20, 184, 166, 0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 20% 20%, rgba(139, 92, 246, 0.06) 0%, transparent 50%),
    var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  padding: 28px 32px;
  position: relative;
  overflow: hidden;
  margin-bottom: 24px;
  box-shadow: var(--shadow-card);
  transition: all var(--transition-normal);

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

  &::after {
    content: '';
    position: absolute;
    inset: 0;
    background-image: radial-gradient(circle, rgba(255, 255, 255, 0.06) 1px, transparent 1px);
    background-size: 24px 24px;
    opacity: 0.3;
    pointer-events: none;
  }

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-card-hover);
  }
`;

export const HeroTitle = styled.h1`
  font-size: 26px;
  font-weight: 700;
  color: var(--text-heading);
  margin-bottom: 8px;
  position: relative;
  z-index: 1;

  span {
    color: var(--accent-teal);
  }
`;

export const HeroSubtitle = styled.p`
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 24px;
  position: relative;
  z-index: 1;
  max-width: 500px;
  line-height: 1.6;
`;

export const ButtonGroup = styled.div`
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  position: relative;
  z-index: 1;
`;

export const BtnPrimary = styled.button`
  background: var(--gradient-button);
  color: var(--bg-void);
  border: none;
  padding: 11px 22px;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: var(--space-sm);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-glow-strong);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }
`;

export const BtnSecondary = styled.button`
  background: var(--glass-bg);
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
  padding: 11px 22px;
  border-radius: var(--radius-button);
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;

  &:hover {
    background: var(--bg-card-hover);
    color: var(--text-primary);
  }
`;

// ─── Stat Cards ───────────────────────────────────────────────────────────────
export const StatGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 24px;
`;

export const StatCard = styled.div`
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-left: 2px solid var(--accent-teal);
  border-radius: var(--radius-card);
  padding: 20px;
  text-align: center;
  position: relative;
  overflow: hidden;
  transition: all var(--transition-normal);
  box-shadow: var(--shadow-card);

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

  &:hover {
    border-color: var(--glass-border);
    border-left-color: var(--accent-teal);
    transform: translateY(-2px);
    box-shadow: var(--shadow-card-hover);
  }
`;

export const StatValue = styled.div`
  font-size: 2rem;
  font-weight: 700;
  color: var(--accent-teal);
  margin-bottom: 4px;
`;

export const StatLabel = styled.div`
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.8px;
`;

// ─── Feature Grid ─────────────────────────────────────────────────────────────
export const FeatureGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
`;

export const FeatureCard = styled.div`
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  padding: 20px;
  position: relative;
  overflow: hidden;
  transition: all var(--transition-normal);
  box-shadow: var(--shadow-card);

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

  &:hover {
    border-color: var(--border-light);
    transform: translateY(-2px);
    box-shadow: var(--shadow-card-hover);
  }

  h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-heading);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  p {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.55;
  }
`;

export const FeatureIcon = styled.div`
  width: 32px;
  height: 32px;
  background: var(--accent-teal-dim);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-teal);
  flex-shrink: 0;
`;

// ─── Selected Folder Banner ───────────────────────────────────────────────────
export const FolderBanner = styled.div`
  background: rgba(20, 184, 166, 0.08);
  border: 1px solid rgba(20, 184, 166, 0.2);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
  z-index: 1;

  span {
    color: var(--accent-teal);
    font-weight: 500;
    word-break: break-all;
  }
`;

// ─── Status Bar (28px) ────────────────────────────────────────────────────────
export const StatusBar = styled.footer`
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 var(--space-md);
  background: var(--bg-void);
  border-top: 1px solid var(--border-subtle);
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
`;

export const StatusLeft = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
`;

export const StatusRight = styled.div`
  display: flex;
  align-items: center;
`;

export const StatusDot = styled.span<{ $status: 'ready' | 'processing' | 'error' }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
  background: ${({ $status }) =>
    $status === 'ready'
      ? 'var(--status-success)'
      : $status === 'processing'
        ? 'var(--status-warning)'
        : 'var(--status-error)'};
  box-shadow: ${({ $status }) =>
    $status === 'ready'
      ? '0 0 8px var(--status-success)'
      : $status === 'processing'
        ? '0 0 8px var(--status-warning)'
        : '0 0 8px var(--status-error)'};
`;

export const StatusDivider = styled.span`
  color: var(--text-dim);
`;

export const AppVersion = styled.span`
  color: var(--accent-teal);
  font-weight: 500;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
`;

// ─── Spinner ──────────────────────────────────────────────────────────────────
export const ProcessingSpinner = styled.div`
  width: 14px;
  height: 14px;
  border: 2px solid var(--accent-teal-dim);
  border-radius: 50%;
  border-top-color: var(--accent-teal);
  animation: ${spin} 0.8s ease-in-out infinite;
  flex-shrink: 0;
`;

// ─── About Modal ──────────────────────────────────────────────────────────────
export const AboutOverlay = styled.div<{ $active: boolean }>`
  position: fixed;
  inset: 0;
  background: var(--bg-modal);
  backdrop-filter: blur(10px);
  z-index: 999;
  display: ${({ $active }) => ($active ? 'flex' : 'none')};
  align-items: center;
  justify-content: center;
  animation: ${({ $active }) => ($active ? fadeIn : 'none')} 200ms ease;
`;

export const AboutModal = styled.div`
  background: var(--gradient-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-card);
  padding: 32px 40px;
  min-width: 360px;
  max-width: 440px;
  text-align: center;
  position: relative;
  overflow: hidden;
  box-shadow: var(--shadow-xl);

  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
    pointer-events: none;
  }
`;

export const AboutCloseBtn = styled.button`
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  background: var(--glass-highlight);
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all var(--transition-fast);
  z-index: 1;

  &:hover {
    background: var(--status-error);
    color: #fff;
  }
`;

export const AboutAppIcon = styled.img`
  width: 64px;
  height: 64px;
  border-radius: 12px;
  margin: 0 auto 16px;
  display: block;
`;

export const AboutAppName = styled.h2`
  font-size: 22px;
  font-weight: 700;
  color: var(--text-heading);
  margin: 0 0 4px;
`;

export const AboutVersion = styled.div`
  font-size: 14px;
  color: var(--accent-teal);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  margin-bottom: 12px;
`;

export const AboutDesc = styled.div`
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 12px;
`;

export const AboutLicense = styled.div`
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 16px;
`;

export const AboutGithubBadge = styled.a`
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
  background: var(--gradient-button);
  color: var(--bg-void);
  padding: 10px 24px;
  border-radius: var(--radius-full);
  font-weight: 600;
  font-size: 14px;
  text-decoration: none;
  margin-bottom: 12px;
  box-shadow: var(--shadow-glow);
  transition: all var(--transition-fast);
  cursor: pointer;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-glow-strong);
    text-decoration: none;
  }
`;

export const AboutEmail = styled.div`
  font-size: 12px;
  color: var(--text-muted);
`;
