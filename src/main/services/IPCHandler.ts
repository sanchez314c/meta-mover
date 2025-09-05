import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron';
import { PythonProcessingBridge } from './PythonProcessingBridge';
import { DatabaseManager } from './DatabaseManager';
import { ConfigManager, AppConfig } from './ConfigManager';
import { Logger } from '../utils/Logger';
import * as path from 'path';
import * as os from 'os';

interface ValidationResult {
  isValid: boolean;
  error?: string;
}

class InputValidator {
  static validateProcessingOptions(options: unknown): ValidationResult {
    if (!options || typeof options !== 'object') {
      return { isValid: false, error: 'Options must be an object' };
    }

    const opts = options as Record<string, unknown>;

    if (!opts.sourcePath || typeof opts.sourcePath !== 'string') {
      return { isValid: false, error: 'sourcePath is required and must be a string' };
    }

    if (!opts.destinationPath || typeof opts.destinationPath !== 'string') {
      return { isValid: false, error: 'destinationPath is required and must be a string' };
    }

    // Validate path strings are safe (no null bytes or control chars)
    try {
      const sourcePath = path.resolve(opts.sourcePath);
      const destPath = path.resolve(opts.destinationPath);

      // Reject paths containing null bytes (path traversal / injection vector)
      if (opts.sourcePath.includes('\0') || opts.destinationPath.includes('\0')) {
        return { isValid: false, error: 'Path contains null bytes' };
      }

      // Ensure resolved paths are absolute (normalize catches ../ traversal)
      if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destPath)) {
        return { isValid: false, error: 'Path must be absolute' };
      }
    } catch (error) {
      return { isValid: false, error: 'Invalid path format' };
    }

    return { isValid: true };
  }

  static validateJobId(jobId: unknown): ValidationResult {
    if (!jobId || typeof jobId !== 'string') {
      return { isValid: false, error: 'Job ID must be a non-empty string' };
    }

    if (jobId.length > 100) {
      return { isValid: false, error: 'Job ID too long' };
    }

    // Basic sanitization - only allow alphanumeric, hyphens, underscores
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      return { isValid: false, error: 'Job ID contains invalid characters' };
    }

    return { isValid: true };
  }

  static validateConfigKey(key: unknown): ValidationResult {
    if (!key || typeof key !== 'string') {
      return { isValid: false, error: 'Config key must be a non-empty string' };
    }

    if (key.length > 50) {
      return { isValid: false, error: 'Config key too long' };
    }

    // Allow only safe characters for config keys
    if (!/^[a-zA-Z0-9_.]+$/.test(key)) {
      return { isValid: false, error: 'Config key contains invalid characters' };
    }

    return { isValid: true };
  }
}

export class IPCHandler {
  private pythonBridge: PythonProcessingBridge;
  private databaseManager: DatabaseManager;
  private configManager: ConfigManager;
  private logger: Logger;

  constructor() {
    this.pythonBridge = PythonProcessingBridge.getInstance();
    this.databaseManager = DatabaseManager.getInstance();
    this.configManager = ConfigManager.getInstance();
    this.logger = Logger.getInstance();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // System info
    ipcMain.handle('system:info', () => {
      return {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appVersion: app.getVersion(),
        cpuCount: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        homeDir: os.homedir(),
        tempDir: os.tmpdir(),
      };
    });

    // File selection dialogs
    ipcMain.handle('dialog:openDirectory', async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('dialog:openFiles', async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Media Files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'mp4', 'mov', 'avi'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      return result.canceled ? null : result.filePaths;
    });

    // Processing operations
    ipcMain.handle('processing:start', async (event, options) => {
      try {
        const validation = InputValidator.validateProcessingOptions(options);
        if (!validation.isValid) {
          return { success: false, error: validation.error };
        }

        const jobId = this.pythonBridge.startJob(options.sourcePath, options.destinationPath);
        return { success: true, jobId };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });

    ipcMain.handle('processing:pause', async (_event, _jobId) => {
      return { success: false, error: 'Pause not supported in Python bridge mode' };
    });

    ipcMain.handle('processing:resume', async (_event, _jobId) => {
      return { success: false, error: 'Resume not supported in Python bridge mode' };
    });

    ipcMain.handle('processing:cancel', async (event, jobId) => {
      const validation = InputValidator.validateJobId(jobId);
      if (!validation.isValid) {
        return { success: false, error: validation.error };
      }
      this.pythonBridge.cancelJob(jobId);
      return { success: true };
    });

    // Database operations
    ipcMain.handle('db:getJobs', async (event, limit) => {
      return await this.databaseManager.getJobs(limit);
    });

    ipcMain.handle('db:getJob', async (event, id) => {
      return await this.databaseManager.getJob(id);
    });

    // Configuration
    ipcMain.handle('config:get', async (event, key) => {
      if (key) {
        const validation = InputValidator.validateConfigKey(key);
        if (!validation.isValid) {
          return { success: false, error: validation.error };
        }
        return this.configManager.get(key as keyof AppConfig);
      }
      return this.configManager.getAll();
    });

    ipcMain.handle('config:set', async (event, key, value) => {
      const validation = InputValidator.validateConfigKey(key);
      if (!validation.isValid) {
        return { success: false, error: validation.error };
      }
      this.configManager.set(key as keyof AppConfig, value as AppConfig[keyof AppConfig]);
      return { success: true };
    });

    ipcMain.handle('config:reset', async () => {
      this.configManager.reset();
      return { success: true };
    });

    // System operations
    ipcMain.handle('system:openPath', async (event, filePath) => {
      // Validate path before passing to shell
      if (!filePath || typeof filePath !== 'string' || filePath.includes('\0')) {
        return { success: false, error: 'Invalid file path' };
      }
      const resolvedPath = path.resolve(filePath);
      shell.showItemInFolder(resolvedPath);
      return { success: true };
    });

    // Whitelist of allowed app path names to prevent arbitrary path disclosure
    const ALLOWED_APP_PATHS = new Set([
      'home',
      'appData',
      'userData',
      'sessionData',
      'temp',
      'exe',
      'module',
      'desktop',
      'documents',
      'downloads',
      'music',
      'pictures',
      'videos',
      'logs',
    ]);

    ipcMain.handle('system:getPath', async (event, name) => {
      if (!name || !ALLOWED_APP_PATHS.has(name)) {
        return null;
      }
      return app.getPath(name as Parameters<typeof app.getPath>[0]);
    });

    ipcMain.handle('system:checkDependencies', async () => PythonProcessingBridge.checkDependencies());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.pythonBridge.on('job-progress', (data: any) => {
      const progressData = {
        jobId: data.id,
        phase: data.progress.phase,
        filesProcessed: data.progress.filesProcessed,
        totalFiles: data.progress.totalFiles,
        percentage: data.progress.percentage,
        corruptFiles: data.progress.corruptFiles,
        errors: data.progress.errors,
        currentFile: data.progress.currentFile,
      };
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('processing:progress', progressData);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.pythonBridge.on('job-completed', (data: any) => {
      const completeData = {
        jobId: data.id,
        statistics: data.statistics,
      };
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('processing:complete', completeData);
      });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.pythonBridge.on('job-failed', (data: any, error: Error) => {
      const errorData = {
        jobId: data.id,
        message: error.message,
      };
      BrowserWindow.getAllWindows().forEach((win) => {
        win.webContents.send('processing:error', errorData);
      });
    });
  }
}
