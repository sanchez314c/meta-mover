import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

export class WindowManager {
  private static instance: WindowManager;
  private mainWindow: BrowserWindow | null = null;
  private splashWindow: BrowserWindow | null = null;

  private constructor() {}

  static getInstance(): WindowManager {
    if (!WindowManager.instance) {
      WindowManager.instance = new WindowManager();
    }
    return WindowManager.instance;
  }

  createMainWindow(): BrowserWindow {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    this.mainWindow = new BrowserWindow({
      width: Math.min(1400, width * 0.9),
      height: Math.min(900, height * 0.9),
      minWidth: 1024,
      minHeight: 600,
      show: false,
      frame: process.platform === 'darwin',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/index.js'),
      },
      icon: path.join(__dirname, '../../resources/icon.png'),
    });

    this.mainWindow.once('ready-to-show', () => {
      if (this.splashWindow) {
        setTimeout(() => {
          this.splashWindow?.close();
          this.mainWindow?.show();
        }, 1500);
      } else {
        this.mainWindow?.show();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    return this.mainWindow;
  }

  createSplashWindow(): BrowserWindow {
    this.splashWindow = new BrowserWindow({
      width: 500,
      height: 300,
      frame: false,
      alwaysOnTop: true,
      transparent: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    this.splashWindow.loadFile(path.join(__dirname, '../../resources/splash.html'));

    this.splashWindow.on('closed', () => {
      this.splashWindow = null;
    });

    return this.splashWindow;
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  focusMainWindow(): void {
    if (this.mainWindow) {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.focus();
    }
  }

  closeAllWindows(): void {
    if (this.splashWindow) {
      this.splashWindow.close();
    }
    if (this.mainWindow) {
      this.mainWindow.close();
    }
  }
}
