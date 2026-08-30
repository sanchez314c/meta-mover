import path from 'path';

import type { AppConfig } from '../services/AppConfigStore';
import type { BrokerLaunchTrustPolicy } from '../native/NativeFilesystemHelperClient';
import type { IpcRegistrarPort } from '../services/ProcessingIPCController';
import {
  CoreAppPort,
  CoreDialogPort,
  CoreIPCController,
  CoreIPCDependencies,
  CoreShellPort,
  CoreSystemPort,
  validatedExternalUrl,
} from './CoreIPCController';
import {
  createProductionApplicationRuntime,
  ProductionRuntimeOptions,
} from './ProductionApplicationRuntime';
import type { ProcessingEvent } from '../../shared/types/processing';

export interface ElectronQuitEventPort {
  preventDefault(): void;
}

export interface ElectronNavigationEventPort {
  preventDefault(): void;
}

export interface ElectronAppPort extends CoreAppPort {
  readonly isPackaged: boolean;
  whenReady(): Promise<void>;
  requestSingleInstanceLock(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  quit(): void;
  setAppUserModelId(id: string): void;
}

export interface ElectronWebContentsPort {
  send(channel: string, value: unknown): void;
  getURL(): string;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(
    event: 'will-navigate',
    listener: (event: ElectronNavigationEventPort, url: string) => void
  ): void;
}

export interface ElectronWindowPort {
  loadFile(filePath: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  once(event: string, listener: () => void): void;
  on(event: string, listener: () => void): void;
  show(): void;
  close(): void;
  focus(): void;
  restore(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  webContents: ElectronWebContentsPort;
}

export interface ElectronWindowOptions {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  x?: number;
  y?: number;
  title: string;
  frame: boolean;
  transparent: boolean;
  backgroundColor: string;
  resizable: boolean;
  show: boolean;
  webPreferences: {
    nodeIntegration: false;
    contextIsolation: true;
    sandbox: true;
    webSecurity: true;
    allowRunningInsecureContent: false;
    preload: string;
  };
}

export interface ElectronRuntimePort {
  components: Readonly<{
    config: Pick<AppConfigStoreLike, 'getAll'>;
  }>;
  shutdown(): Promise<void>;
}

interface AppConfigStoreLike {
  getAll(): Pick<AppConfig, 'windowBounds'>;
}

export interface ElectronCoreIpcPort {
  register(): void;
  dispose(): void;
}

export interface ElectronLoggerPort {
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
}

export interface ElectronMainDependencies {
  app: ElectronAppPort;
  createWindow(options: ElectronWindowOptions): ElectronWindowPort;
  getAllWindows(): ElectronWindowPort[];
  ipc: IpcRegistrarPort;
  dialog: CoreDialogPort;
  shell: CoreShellPort;
  platform: NodeJS.Platform;
  architecture: string;
  resourcesRoot: string;
  preloadPath: string;
  rendererPath: string;
  launchTrustPolicy?: BrokerLaunchTrustPolicy;
  developmentRendererUrl?: string;
  createRuntime(options: ProductionRuntimeOptions): Promise<ElectronRuntimePort>;
  createCoreIpc(dependencies: CoreIPCDependencies): ElectronCoreIpcPort;
  logger: ElectronLoggerPort;
  system: Omit<CoreSystemPort, 'platform' | 'architecture'>;
}

export class ElectronMainShutdownError extends Error {
  constructor(public readonly failures: readonly unknown[]) {
    super('Main-process shutdown failed');
    this.name = 'ElectronMainShutdownError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validDevelopmentRendererUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export class ElectronMain {
  private mainWindow: ElectronWindowPort | null = null;
  private runtime?: ElectronRuntimePort;
  private coreIpc?: ElectronCoreIpcPort;
  private startupPromise?: Promise<void>;
  private runtimeAcquisitionPromise?: Promise<ElectronRuntimePort>;
  private shutdownPromise?: Promise<void>;
  private quitShutdownPromise?: Promise<void>;
  private shutdownRequested = false;
  private allowQuit = false;

  constructor(private readonly dependencies: ElectronMainDependencies) {}

  start(): void {
    if (this.startupPromise) throw new Error('Electron main process is already started');
    if (!this.dependencies.app.requestSingleInstanceLock()) {
      this.startupPromise = Promise.resolve();
      this.beginQuitShutdown();
      return;
    }

    if (this.dependencies.platform === 'win32') {
      this.dependencies.app.setAppUserModelId('com.speedheathens.metamover');
    }
    this.registerLifecycle();
    this.startupPromise = this.dependencies.app.whenReady().then(() => this.initialize());
    void this.startupPromise.catch((error) => {
      this.reportError('Main-process startup failed', error);
      this.beginQuitShutdown();
    });
  }

  whenStarted(): Promise<void> {
    return this.startupPromise ?? Promise.reject(new Error('Electron main process is not started'));
  }

  whenShutdown(): Promise<void> {
    return this.quitShutdownPromise ?? this.shutdownPromise ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private registerLifecycle(): void {
    this.dependencies.app.on('second-instance', () => {
      const window = this.liveWindow();
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.focus();
    });
    this.dependencies.app.on('window-all-closed', () => {
      if (this.dependencies.platform !== 'darwin') this.beginQuitShutdown();
    });
    this.dependencies.app.on('activate', () => {
      if (
        !this.shutdownRequested &&
        !this.liveWindow() &&
        this.dependencies.getAllWindows().length === 0
      ) {
        void this.createWindow().catch((error) => {
          this.reportError('Window recreation failed', error);
          this.beginQuitShutdown();
        });
      }
    });
    this.dependencies.app.on('before-quit', (rawEvent) => {
      if (this.allowQuit) return;
      (rawEvent as ElectronQuitEventPort).preventDefault();
      this.beginQuitShutdown();
    });
    this.dependencies.app.on('web-contents-created', (_event, rawContents) => {
      const contents = rawContents as ElectronWebContentsPort;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    });
  }

  private async initialize(): Promise<void> {
    if (this.shutdownRequested) return;
    const userDataRoot = this.dependencies.app.getPath('userData');
    this.runtimeAcquisitionPromise = this.dependencies
      .createRuntime({
        resourcesRoot: this.dependencies.resourcesRoot,
        configPath: path.join(userDataRoot, 'config.json'),
        historyPath: path.join(userDataRoot, 'job-history.jsonl'),
        evidenceRoot: path.join(userDataRoot, 'evidence'),
        evidencePolicyVersion: 'date-resolution/1',
        platform: this.dependencies.platform,
        architecture: this.dependencies.architecture,
        isPackaged: this.dependencies.app.isPackaged,
        ...(this.dependencies.launchTrustPolicy
          ? { launchTrustPolicy: this.dependencies.launchTrustPolicy }
          : {}),
        ipc: this.dependencies.ipc,
        publishEvent: (event: Readonly<ProcessingEvent>) => {
          const window = this.liveWindow();
          if (window) window.webContents.send('processing:event', event);
        },
      })
      .then((runtime) => {
        this.runtime = runtime;
        return runtime;
      });
    await this.runtimeAcquisitionPromise;
    if (this.shutdownRequested) return;
    await this.createWindow();
    if (this.shutdownRequested) return;
    this.dependencies.logger.info('Canonical application runtime started');
  }

  private async createWindow(): Promise<void> {
    if (!this.runtime) throw new Error('Application runtime must exist before the renderer window');
    const bounds = this.runtime.components.config.getAll().windowBounds;
    const window = this.dependencies.createWindow({
      width: bounds?.width ?? 1280,
      height: bounds?.height ?? 883,
      minWidth: 900,
      minHeight: 600,
      ...(bounds?.x === undefined ? {} : { x: bounds.x }),
      ...(bounds?.y === undefined ? {} : { y: bounds.y }),
      title: 'META Mover',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        preload: this.dependencies.preloadPath,
      },
    });
    this.mainWindow = window;
    window.once('ready-to-show', () => this.liveWindow()?.show());
    window.on('closed', () => {
      if (this.mainWindow === window) this.mainWindow = null;
      if (this.dependencies.platform !== 'darwin') this.beginQuitShutdown();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      const external = validatedExternalUrl(url);
      if (external) void Promise.resolve(this.dependencies.shell.openExternal(external));
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url === window.webContents.getURL()) return;
      event.preventDefault();
      const external = validatedExternalUrl(url);
      if (external) void Promise.resolve(this.dependencies.shell.openExternal(external));
    });

    if (!this.coreIpc) {
      this.coreIpc = this.dependencies.createCoreIpc(this.coreIpcDependencies());
      this.coreIpc.register();
    }

    const developmentUrl = this.dependencies.developmentRendererUrl;
    if (developmentUrl !== undefined) {
      if (this.dependencies.app.isPackaged || !validDevelopmentRendererUrl(developmentUrl)) {
        throw new Error('Development renderer URL is forbidden in this runtime');
      }
      await window.loadURL(developmentUrl);
    } else {
      await window.loadFile(this.dependencies.rendererPath);
    }
  }

  private coreIpcDependencies(): CoreIPCDependencies {
    return {
      ipc: this.dependencies.ipc,
      getWindow: () => this.liveWindow(),
      dialog: this.dependencies.dialog,
      shell: this.dependencies.shell,
      app: this.dependencies.app,
      system: {
        platform: this.dependencies.platform,
        architecture: this.dependencies.architecture,
        ...this.dependencies.system,
      },
    };
  }

  private liveWindow(): ElectronWindowPort | null {
    return !this.mainWindow || this.mainWindow.isDestroyed() ? null : this.mainWindow;
  }

  private beginQuitShutdown(): void {
    if (this.quitShutdownPromise) return;
    this.quitShutdownPromise = this.shutdown()
      .catch((error) => {
        this.reportError('Main-process shutdown completed with failures', error);
      })
      .then(() => this.closeProcessLogger())
      .finally(() => {
        this.allowQuit = true;
        this.dependencies.app.quit();
      });
  }

  private async closeProcessLogger(): Promise<void> {
    try {
      await this.dependencies.logger.close();
    } catch (error) {
      this.reportError('Process logger shutdown failed', error);
    }
  }

  private reportError(message: string, error: unknown): void {
    try {
      this.dependencies.logger.error(message, { error: errorMessage(error) });
    } catch {
      // Telemetry cannot own application lifecycle progress.
    }
  }

  private async shutdownOnce(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.runtimeAcquisitionPromise;
    } catch {
      // Startup reports acquisition failures. Shutdown still drains any owner that was acquired.
    }
    try {
      await Promise.resolve().then(() => this.coreIpc?.dispose());
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.runtime?.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new ElectronMainShutdownError(failures);
  }
}

export const defaultElectronMainFactories = {
  createRuntime: createProductionApplicationRuntime,
  createCoreIpc: (dependencies: CoreIPCDependencies) => new CoreIPCController(dependencies),
};
