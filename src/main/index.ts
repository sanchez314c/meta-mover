import { cpus, freemem, totalmem } from 'os';
import path from 'path';

import { app, BrowserWindow, dialog, ipcMain, OpenDialogOptions, shell } from 'electron';

import { CoreDialogPort, CoreShellPort } from './runtime/CoreIPCController';
import {
  defaultElectronMainFactories,
  ElectronAppPort,
  ElectronMain,
  ElectronWindowPort,
} from './runtime/ElectronMain';
import type { IpcRegistrarPort } from './services/ProcessingIPCController';
import { Logger } from './utils/Logger';

const logger = Logger.getInstance();
const appPort = app as unknown as ElectronAppPort;
const ipcPort = ipcMain as unknown as IpcRegistrarPort;
const dialogPort: CoreDialogPort = {
  showOpenDialog: ((
    first: Parameters<CoreDialogPort['showOpenDialog']>[0],
    second?: OpenDialogOptions
  ) => {
    if (second === undefined) {
      return dialog.showOpenDialog(first as unknown as OpenDialogOptions);
    }
    return dialog.showOpenDialog(first as unknown as BrowserWindow, second);
  }) as CoreDialogPort['showOpenDialog'],
};
const shellPort: CoreShellPort = {
  openExternal: (url) => shell.openExternal(url),
  showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
};

const main = new ElectronMain({
  app: appPort,
  createWindow: (options) =>
    new BrowserWindow(
      options as Electron.BrowserWindowConstructorOptions
    ) as unknown as ElectronWindowPort,
  getAllWindows: () => BrowserWindow.getAllWindows() as unknown as ElectronWindowPort[],
  ipc: ipcPort,
  dialog: dialogPort,
  shell: shellPort,
  platform: process.platform,
  architecture: process.arch,
  resourcesRoot: app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '../../.build-tools'),
  preloadPath: path.join(__dirname, '../preload/index.js'),
  rendererPath: path.join(__dirname, '../renderer/index.html'),
  createRuntime: defaultElectronMainFactories.createRuntime,
  createCoreIpc: defaultElectronMainFactories.createCoreIpc,
  logger,
  system: {
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? 'unknown',
    cpuCount: () => cpus().length,
    totalMemory: totalmem,
    freeMemory: freemem,
  },
});

main.start();
