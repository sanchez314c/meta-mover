/**
 * META_Mover Main Process Entry Point
 *
 * This is the main Electron process that manages the application lifecycle,
 * creates windows, and handles system-level operations.
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';

import { Logger } from './utils/Logger';
import { ConfigManager } from './services/ConfigManager';
import { PythonProcessingBridge } from './services/PythonProcessingBridge';
import { DatabaseManager } from './services/DatabaseManager';
import { IPCHandler } from './services/IPCHandler';
// import { MenuBuilder } from './utils/MenuBuilder';
import { APP_NAME, APP_VERSION, IPC_CHANNELS } from '@shared/constants/index';

// Linux transparency and sandbox fixes — must run before app.whenReady()
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// Global references
let mainWindow: BrowserWindow | null = null;
let pythonBridge: PythonProcessingBridge | null = null;
let configManager: ConfigManager | null = null;
let databaseManager: DatabaseManager | null = null;
let _ipcHandler: IPCHandler | null = null;

const logger = Logger.getInstance();
// isDevelopment: check CLI --dev flag (more reliable than NODE_ENV which webpack may bake in at build time)
const isDevelopment = process.argv.includes('--dev');
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/**
 * Initialize the application
 */
async function initializeApp(): Promise<void> {
  try {
    logger.info('Initializing META_Mover application...', { version: APP_VERSION });

    // Initialize core services
    configManager = ConfigManager.getInstance();

    databaseManager = DatabaseManager.getInstance();

    pythonBridge = PythonProcessingBridge.getInstance();

    // Initialize IPC handlers
    _ipcHandler = new IPCHandler();

    logger.info('Application services initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize application services', { error });
    throw error;
  }
}

/**
 * Create the main application window
 */
async function createMainWindow(): Promise<BrowserWindow> {
  const config = configManager?.getConfig();

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: config?.windowBounds?.width || 1280,
    height: config?.windowBounds?.height || 883,
    minWidth: 900,
    minHeight: 600,
    x: config?.windowBounds?.x ?? undefined,
    y: config?.windowBounds?.y ?? undefined,
    title: APP_NAME,
    icon: path.join(__dirname, '../../resources/icons/icon.png'),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    roundedCorners: true,
    show: false,
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };

  const window = new BrowserWindow(windowOptions);

  // Load the renderer
  if (isDevelopment) {
    await window.loadURL('http://localhost:58594');
  } else {
    await window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Window event handlers
  let shown = false;
  window.once('ready-to-show', () => {
    if (!shown) {
      shown = true;
      window.show();
    }

    if (isDevelopment) {
      window.webContents.openDevTools();
    }
  });

  // Fallback: force-show after 3s if ready-to-show never fires (Linux transparency edge case)
  setTimeout(() => {
    if (!shown && !window.isDestroyed()) {
      shown = true;
      logger.warn('ready-to-show did not fire within 3s, forcing window visible');
      window.show();
    }
  }, 3000);

  window.on('closed', () => {
    mainWindow = null;
  });

  window.on('moved', saveWindowBounds);
  window.on('resized', saveWindowBounds);

  // Handle external links
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Security: prevent navigation to external URLs
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  logger.info('Main window created successfully');
  return window;
}

/**
 * Save window bounds to config
 */
function saveWindowBounds(): void {
  if (mainWindow && configManager) {
    const bounds = mainWindow.getBounds();
    configManager.updateConfig({
      windowBounds: bounds,
    });
  }
}

/**
 * Application event handlers
 */
function setupAppEventHandlers(): void {
  // App ready
  app.whenReady().then(async () => {
    try {
      // Linux requires a delay after ready for transparent visuals to initialize
      if (process.platform === 'linux') {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      await initializeApp();
      mainWindow = await createMainWindow();

      // Window manager already tracks the main window internally

      // Application menu is managed by the OS default; no custom menu needed for this release.

      // Setup auto-updater if in production
      if (!isDevelopment) {
        setupAutoUpdater();
      }

      logger.info('Application ready and main window created');
    } catch (error) {
      logger.error('Failed to create main window', { error });
      app.quit();
    }
  });

  // All windows closed
  app.on('window-all-closed', () => {
    if (!isMac) {
      app.quit();
    }
  });

  // App activated (macOS)
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) {
      mainWindow = await createMainWindow();
    }
  });

  // Before quit
  app.on('before-quit', async (event) => {
    if (pythonBridge?.hasActiveJob()) {
      event.preventDefault();

      const result = await dialog.showMessageBox(
        mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
        {
          type: 'question',
          buttons: ['Cancel', 'Force Quit'],
          defaultId: 0,
          title: 'Jobs in Progress',
          message: 'There are active processing jobs. Are you sure you want to quit?',
          detail: 'All progress will be lost if you force quit now.',
        }
      );

      if (result.response === 1) {
        await pythonBridge.shutdown();
        app.quit();
      }
    }
  });

  // App will quit
  app.on('will-quit', async () => {
    try {
      logger.info('Application shutting down...');

      // Cleanup services
      if (pythonBridge) {
        await pythonBridge.shutdown();
      }

      if (databaseManager) {
        await databaseManager.close();
      }

      logger.info('Application shutdown complete');
    } catch (error) {
      logger.error('Error during application shutdown', { error });
    }
  });
}

/**
 * Setup auto-updater for production builds
 */
function setupAutoUpdater(): void {
  autoUpdater.checkForUpdatesAndNotify();

  autoUpdater.on('update-available', () => {
    logger.info('Update available');
  });

  autoUpdater.on('update-downloaded', async () => {
    const result = await dialog.showMessageBox(
      mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0],
      {
        type: 'info',
        title: 'Update Ready',
        message: 'A new version has been downloaded. Restart now to apply the update?',
        buttons: ['Restart Now', 'Later'],
      }
    );

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
}

/**
 * Handle IPC messages for core functionality
 */
function setupCoreIPC(): void {
  // Window management
  ipcMain.handle(IPC_CHANNELS.MINIMIZE_WINDOW, () => {
    if (mainWindow) {
      mainWindow.minimize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.MAXIMIZE_WINDOW, () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.CLOSE_WINDOW, () => {
    if (mainWindow) {
      mainWindow.close();
    }
  });

  // External URL opener with protocol validation
  ipcMain.handle('open-external', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        await shell.openExternal(url);
      }
    } catch {
      // Invalid URL — silently ignore
    }
  });

  // Development tools
  if (isDevelopment) {
    ipcMain.handle(IPC_CHANNELS.OPEN_DEVTOOLS, () => {
      if (mainWindow) {
        mainWindow.webContents.openDevTools();
      }
    });

    ipcMain.handle(IPC_CHANNELS.RELOAD_APP, () => {
      if (mainWindow) {
        mainWindow.reload();
      }
    });
  }
}

/**
 * Main application startup
 */
function main(): void {
  // Set app user model ID for Windows
  if (isWindows) {
    app.setAppUserModelId('com.speedheathens.metamover');
  }

  // Ensure single instance
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  // Security: prevent new window creation globally.
  // Navigation is guarded per-window in createMainWindow via will-navigate.
  app.on('web-contents-created', (_, contents) => {
    contents.setWindowOpenHandler(() => {
      return { action: 'deny' };
    });
  });

  // Setup event handlers
  setupAppEventHandlers();
  setupCoreIPC();

  logger.info('META_Mover main process started', {
    version: APP_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
  });
}

// Catch unhandled errors so the app doesn't silently vanish
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in main process', { error: error.message, stack: error.stack });
  console.error('UNCAUGHT EXCEPTION:', error);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection in main process', { reason: String(reason) });
  console.error('UNHANDLED REJECTION:', reason);
});

// Start the application
main();
