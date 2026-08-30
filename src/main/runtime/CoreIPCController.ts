import path from 'path';

import type { IpcRegistrarPort } from '../services/ProcessingIPCController';

export const CORE_IPC_CHANNELS = Object.freeze([
  'system:info',
  'dialog:openDirectory',
  'window:minimize',
  'window:maximize',
  'window:close',
  'open-external',
  'system:openPath',
  'system:getPath',
] as const);

type CoreIpcChannel = (typeof CORE_IPC_CHANNELS)[number];

export interface CoreWindowPort {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  close(): void;
  isDestroyed(): boolean;
}

export interface CoreDialogPort {
  showOpenDialog(
    window: CoreWindowPort,
    options: Readonly<{ properties: readonly ['openDirectory'] }>
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
  showOpenDialog(
    options: Readonly<{ properties: readonly ['openDirectory'] }>
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface CoreShellPort {
  openExternal(url: string): Promise<void> | void;
  showItemInFolder(filePath: string): void;
}

export interface CoreAppPort {
  getPath(name: string): string;
  getVersion(): string;
}

export interface CoreSystemPort {
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  electronVersion: string;
  cpuCount(): number;
  totalMemory(): number;
  freeMemory(): number;
}

export interface CoreIPCDependencies {
  ipc: IpcRegistrarPort;
  getWindow(): CoreWindowPort | null;
  dialog: CoreDialogPort;
  shell: CoreShellPort;
  app: CoreAppPort;
  system: CoreSystemPort;
}

export class CoreIPCCleanupError extends Error {
  constructor(
    message: string,
    public readonly failures: readonly unknown[]
  ) {
    super(message);
    this.name = 'CoreIPCCleanupError';
  }
}

const ALLOWED_APP_PATHS = new Set([
  'home',
  'appData',
  'userData',
  'sessionData',
  'temp',
  'desktop',
  'documents',
  'downloads',
  'music',
  'pictures',
  'videos',
  'logs',
]);

function responseError(message: string) {
  return {
    success: false,
    error: { code: 'INVALID_IPC_REQUEST', message, recoverable: true },
  } as const;
}

export function validatedExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function canonicalAbsolutePath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !path.isAbsolute(value)
  ) {
    return null;
  }
  const normalized = path.normalize(value);
  return normalized === value ? normalized : null;
}

export class CoreIPCController {
  private readonly ownedChannels = new Set<CoreIpcChannel>();
  private registered = false;

  constructor(private readonly dependencies: CoreIPCDependencies) {}

  register(): void {
    if (this.registered || this.ownedChannels.size > 0) {
      throw new Error('Core IPC controller is already registered');
    }
    try {
      this.handle('system:info', () => ({
        platform: this.dependencies.system.platform,
        arch: this.dependencies.system.architecture,
        nodeVersion: this.dependencies.system.nodeVersion,
        electronVersion: this.dependencies.system.electronVersion,
        appVersion: this.dependencies.app.getVersion(),
        cpuCount: this.dependencies.system.cpuCount(),
        totalMemory: this.dependencies.system.totalMemory(),
        freeMemory: this.dependencies.system.freeMemory(),
      }));
      this.handle('dialog:openDirectory', async () => {
        const options = { properties: ['openDirectory'] as const };
        const window = this.liveWindow();
        const result = window
          ? await this.dependencies.dialog.showOpenDialog(window, options)
          : await this.dependencies.dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      });
      this.handle('window:minimize', () => this.liveWindow()?.minimize());
      this.handle('window:maximize', () => {
        const window = this.liveWindow();
        if (!window) return;
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      });
      this.handle('window:close', () => this.liveWindow()?.close());
      this.handle('open-external', async (value) => {
        const url = validatedExternalUrl(value);
        if (!url) return responseError('External URL is invalid or uses a forbidden protocol');
        await this.dependencies.shell.openExternal(url);
        return { success: true } as const;
      });
      this.handle('system:openPath', (value) => {
        const filePath = canonicalAbsolutePath(value);
        if (!filePath) return responseError('File path must be canonical and absolute');
        this.dependencies.shell.showItemInFolder(filePath);
        return { success: true } as const;
      });
      this.handle('system:getPath', (value) => {
        if (typeof value !== 'string' || !ALLOWED_APP_PATHS.has(value)) return null;
        return this.dependencies.app.getPath(value);
      });
      this.registered = true;
    } catch (error) {
      const failures = this.removeOwnedHandlers();
      if (failures.length > 0) {
        throw new CoreIPCCleanupError('Core IPC registration rollback failed', [
          error,
          ...failures,
        ]);
      }
      throw error;
    }
  }

  dispose(): void {
    if (!this.registered && this.ownedChannels.size === 0) return;
    this.registered = false;
    const failures = this.removeOwnedHandlers();
    if (failures.length > 0) throw new CoreIPCCleanupError('Core IPC cleanup failed', failures);
  }

  private handle(
    channel: CoreIpcChannel,
    handler: (...args: unknown[]) => unknown | Promise<unknown>
  ): void {
    this.dependencies.ipc.handle(channel, (_event, ...args) => handler(...args));
    this.ownedChannels.add(channel);
  }

  private liveWindow(): CoreWindowPort | null {
    const window = this.dependencies.getWindow();
    return !window || window.isDestroyed() ? null : window;
  }

  private removeOwnedHandlers(): unknown[] {
    const failures: unknown[] = [];
    for (const channel of [...this.ownedChannels]) {
      try {
        this.dependencies.ipc.removeHandler(channel);
        this.ownedChannels.delete(channel);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}
