import { createGlobalStyle } from 'styled-components';

export const GlobalStyles = createGlobalStyle`
  /* ── CSS Custom Property Token System ──────────────────────────────────── */
  :root {
    /* Backgrounds */
    --bg-void: #0a0b0e;
    --bg-surface: #111214;
    --bg-card: #141518;
    --bg-card-hover: #1a1b1f;
    --bg-sidebar: #0d0e10;
    --bg-tertiary: #18191c;
    --bg-input: #18191c;
    --bg-modal: rgba(10, 11, 14, 0.94);

    /* Typography */
    --text-primary: #e8e8ec;
    --text-secondary: #9a9aa6;
    --text-muted: #5c5c6a;
    --text-dim: #44444e;
    --text-heading: #f4f4f7;

    /* Accent — Teal */
    --accent-teal: #14b8a6;
    --accent-teal-dim: rgba(20, 184, 166, 0.12);
    --accent-teal-glow: rgba(20, 184, 166, 0.25);
    --accent-teal-hover: #0d9488;
    --accent-blue: #06b6d4;
    --accent-purple: #8b5cf6;

    /* Borders */
    --border-subtle: #1e1e24;
    --border-light: #2a2a30;
    --border-glow: rgba(20, 184, 166, 0.25);
    --border-focus: #14b8a6;

    /* Glass */
    --glass-bg: rgba(255, 255, 255, 0.03);
    --glass-border: rgba(255, 255, 255, 0.05);
    --glass-highlight: rgba(255, 255, 255, 0.06);

    /* Gradients */
    --gradient-card: linear-gradient(145deg, #141518, #18191c);
    --gradient-sidebar: linear-gradient(180deg, #0d0e10, #0a0b0e);
    --gradient-bg: linear-gradient(160deg, #0a0b0e, #0f1012);
    --gradient-button: linear-gradient(135deg, #14b8a6, #0d9488);

    /* Layered Shadows */
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.2), 0 2px 4px rgba(0,0,0,0.15);
    --shadow-md: 0 2px 4px rgba(0,0,0,0.2), 0 4px 8px rgba(0,0,0,0.2), 0 8px 16px rgba(0,0,0,0.15);
    --shadow-lg: 0 4px 8px rgba(0,0,0,0.2), 0 8px 16px rgba(0,0,0,0.2), 0 16px 32px rgba(0,0,0,0.2);
    --shadow-xl: 0 4px 8px rgba(0,0,0,0.15), 0 8px 16px rgba(0,0,0,0.15), 0 16px 32px rgba(0,0,0,0.2), 0 32px 64px rgba(0,0,0,0.25);
    --shadow-card: 0 2px 4px rgba(0,0,0,0.15), 0 4px 12px rgba(0,0,0,0.2), 0 8px 24px rgba(0,0,0,0.15);
    --shadow-card-hover: 0 4px 8px rgba(0,0,0,0.2), 0 8px 24px rgba(0,0,0,0.25), 0 16px 44px rgba(0,0,0,0.2);
    --shadow-glow: 0 0 16px rgba(20,184,166,0.15);
    --shadow-glow-strong: 0 0 24px rgba(20,184,166,0.25);

    /* Status */
    --success: #10b981;
    --warning: #f59e0b;
    --error: #ef4444;
    --status-success: #10b981;
    --status-warning: #f59e0b;
    --status-error: #ef4444;
    --status-info: #06b6d4;

    /* Text extras */
    --text-accent: #14b8a6;
    --text-inverse: #0a0b0e;

    /* Radius */
    --radius-sm: 6px;
    --radius-md: 10px;
    --radius-card: 14px;
    --radius-button: 10px;
    --radius-input: 10px;
    --radius-xl: 20px;
    --radius-full: 9999px;

    /* Spacing */
    --space-xs: 4px;
    --space-sm: 8px;
    --space-md: 16px;
    --space-lg: 24px;
    --space-xl: 32px;

    /* Transitions */
    --transition-fast: 150ms ease;
    --transition-normal: 250ms ease;
  }

  /* ── Reset ──────────────────────────────────────────────────────────────── */
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  html, body {
    background: transparent !important;
    margin: 0;
  }

  body {
    padding: 20px;
    height: 100vh;
    box-sizing: border-box;
    overflow: hidden;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', Roboto, sans-serif;
    font-size: 14px;
    line-height: 1.6;
    color: var(--text-primary);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    -webkit-app-region: drag;
  }

  /* Rounded window shadow — body::before mirrors .app-container shape.
     border-radius LARGER than --radius-xl so corners stay round as shadow diffuses outward. */
  body::before {
    content: '';
    position: fixed;
    inset: 20px;
    border-radius: 36px;
    box-shadow:
      0 4px 8px  rgba(0,0,0,0.4),
      0 8px 20px rgba(0,0,0,0.45),
      0 14px 36px rgba(0,0,0,0.35);
    pointer-events: none;
    z-index: -1;
  }

  #root {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  a {
    color: var(--accent-teal);
    text-decoration: none;
    &:hover {
      text-decoration: underline;
    }
  }

  button {
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    &:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
  }

  input, textarea, select {
    font-family: inherit;
    font-size: inherit;
  }

  /* ── Scrollbars: invisible at rest, visible on hover ────────────────────── */
  * {
    scrollbar-width: thin;
    scrollbar-color: rgba(42, 42, 50, 0) transparent;
  }
  *:hover {
    scrollbar-color: #2a2a32 transparent;
  }

  *::-webkit-scrollbar { width: 6px; height: 6px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb {
    background: rgba(42, 42, 50, 0);
    border-radius: 3px;
    transition: background var(--transition-fast);
  }
  *:hover::-webkit-scrollbar-thumb { background: #2a2a32; }
  *::-webkit-scrollbar-thumb:hover { background: #3a3a44; }
  *::-webkit-scrollbar-corner { background: transparent; }

  /* ── Selection ──────────────────────────────────────────────────────────── */
  ::selection {
    background: var(--accent-teal-dim);
    color: var(--text-heading);
  }

  /* ── Drag regions ───────────────────────────────────────────────────────── */
  .app-container {
    -webkit-app-region: no-drag;
  }
  button, input, select, a, .nav-item, .sidebar {
    -webkit-app-region: no-drag;
  }
`;
