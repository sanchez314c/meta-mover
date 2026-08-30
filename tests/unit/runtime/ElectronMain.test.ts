import { ElectronMain, ElectronMainDependencies } from '../../../src/main/runtime/ElectronMain';

describe('ElectronMain', () => {
  function harness(options: { lock?: boolean; packaged?: boolean } = {}) {
    const appListeners = new Map<string, (...args: unknown[]) => void>();
    const windowListeners = new Map<string, (...args: unknown[]) => void>();
    const webListeners = new Map<string, (...args: unknown[]) => void>();
    const window = {
      loadFile: jest.fn().mockResolvedValue(undefined),
      loadURL: jest.fn().mockResolvedValue(undefined),
      once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
        windowListeners.set(event, listener);
      }),
      on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
        windowListeners.set(event, listener);
      }),
      show: jest.fn(),
      close: jest.fn(),
      focus: jest.fn(),
      restore: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
      isMinimized: jest.fn().mockReturnValue(false),
      minimize: jest.fn(),
      maximize: jest.fn(),
      unmaximize: jest.fn(),
      isMaximized: jest.fn().mockReturnValue(false),
      webContents: {
        send: jest.fn(),
        getURL: jest.fn().mockReturnValue('file:///app/renderer/index.html'),
        setWindowOpenHandler: jest.fn(),
        on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
          webListeners.set(event, listener);
        }),
      },
    };
    const runtime = {
      components: {
        config: {
          getAll: () => ({
            windowBounds: { width: 1280, height: 800, x: 10, y: 20 },
          }),
        },
      },
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    const core = { register: jest.fn(), dispose: jest.fn() };
    const dependencies: ElectronMainDependencies = {
      app: {
        isPackaged: options.packaged ?? true,
        whenReady: jest.fn().mockResolvedValue(undefined),
        requestSingleInstanceLock: jest.fn().mockReturnValue(options.lock ?? true),
        on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
          appListeners.set(event, listener);
        }),
        quit: jest.fn(),
        setAppUserModelId: jest.fn(),
        getPath: jest.fn().mockReturnValue('/var/lib/meta-mover'),
        getVersion: jest.fn().mockReturnValue('1.0.0'),
      },
      createWindow: jest.fn().mockReturnValue(window),
      getAllWindows: jest.fn().mockReturnValue([window]),
      ipc: { handle: jest.fn(), removeHandler: jest.fn() },
      dialog: { showOpenDialog: jest.fn() },
      shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
      platform: 'linux',
      architecture: 'x64',
      resourcesRoot: '/opt/meta-mover/resources',
      preloadPath: '/opt/meta-mover/app/preload/index.js',
      rendererPath: '/opt/meta-mover/app/renderer/index.html',
      createRuntime: jest.fn().mockResolvedValue(runtime),
      createCoreIpc: jest.fn().mockReturnValue(core),
      logger: { info: jest.fn(), error: jest.fn(), close: jest.fn().mockResolvedValue(undefined) },
      system: {
        nodeVersion: 'v20.0.0',
        electronVersion: '38.8.6',
        cpuCount: () => 8,
        totalMemory: () => 1024,
        freeMemory: () => 512,
      },
    };
    const main = new ElectronMain(dependencies);
    return {
      main,
      dependencies,
      appListeners,
      windowListeners,
      webListeners,
      window,
      runtime,
      core,
    };
  }

  it('creates only a sandboxed, isolated renderer after the canonical runtime is ready', async () => {
    const test = harness();
    test.main.start();
    await test.main.whenStarted();

    expect(test.dependencies.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        resourcesRoot: '/opt/meta-mover/resources',
        configPath: '/var/lib/meta-mover/config.json',
        historyPath: '/var/lib/meta-mover/job-history.jsonl',
        evidenceRoot: '/var/lib/meta-mover/evidence',
        isPackaged: true,
      })
    );
    expect(test.dependencies.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1280,
        height: 800,
        show: false,
        webPreferences: expect.objectContaining({
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
        }),
      })
    );
    expect(test.core.register).toHaveBeenCalledTimes(1);
    expect(test.window.loadFile).toHaveBeenCalledWith('/opt/meta-mover/app/renderer/index.html');
    expect(test.core.register.mock.invocationCallOrder[0]).toBeLessThan(
      test.window.loadFile.mock.invocationCallOrder[0]
    );
  });

  it('blocks new windows and external navigation except validated web/mail links', async () => {
    const test = harness();
    test.main.start();
    await test.main.whenStarted();
    const openHandler = test.window.webContents.setWindowOpenHandler.mock.calls[0][0];

    expect(openHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    expect(test.dependencies.shell.openExternal).toHaveBeenCalledWith('https://example.com/');

    const navigate = test.webListeners.get('will-navigate')!;
    const event = { preventDefault: jest.fn() };
    navigate(event, 'file:///etc/passwd');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('prevents quit until one failure-complete asynchronous shutdown settles', async () => {
    const test = harness();
    let release!: () => void;
    test.runtime.shutdown.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    test.main.start();
    await test.main.whenStarted();
    const beforeQuit = test.appListeners.get('before-quit')!;
    const first = { preventDefault: jest.fn() };

    beforeQuit(first);
    beforeQuit({ preventDefault: jest.fn() });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).not.toHaveBeenCalled();

    release();
    await test.main.whenShutdown();
    expect(test.core.dispose).toHaveBeenCalledTimes(1);
    expect(test.dependencies.logger.close).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('drains the process logger after runtime owners and before final quit', async () => {
    const test = harness();
    let releaseLogger!: () => void;
    test.dependencies.logger.close = jest.fn(
      () => new Promise<void>((resolve) => (releaseLogger = resolve))
    );
    test.main.start();
    await test.main.whenStarted();

    test.appListeners.get('before-quit')!({ preventDefault: jest.fn() });
    await new Promise<void>((resolve) => process.nextTick(resolve));

    expect(test.core.dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.logger.close).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      test.dependencies.logger.close.mock.invocationCallOrder[0]
    );
    expect(test.dependencies.app.quit).not.toHaveBeenCalled();

    releaseLogger();
    await test.main.whenShutdown();
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('reports logger-drain failure without blocking final quit', async () => {
    const test = harness();
    test.dependencies.logger.close = jest.fn().mockRejectedValue(new Error('logger close failed'));
    test.main.start();
    await test.main.whenStarted();

    test.appListeners.get('before-quit')!({ preventDefault: jest.fn() });
    await test.main.whenShutdown();

    expect(test.dependencies.logger.error).toHaveBeenCalledWith(
      'Process logger shutdown failed',
      expect.objectContaining({ error: expect.stringMatching(/logger close failed/i) })
    );
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('enters the shutdown barrier directly when the last Linux window closes', async () => {
    const test = harness();
    let release!: () => void;
    test.runtime.shutdown.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    test.main.start();
    await test.main.whenStarted();

    test.appListeners.get('window-all-closed')!();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).not.toHaveBeenCalled();

    release();
    await test.main.whenShutdown();
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('starts graceful shutdown from the concrete Linux window close event', async () => {
    const test = harness();
    let release!: () => void;
    test.runtime.shutdown.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    test.main.start();
    await test.main.whenStarted();

    test.windowListeners.get('closed')!();
    test.appListeners.get('window-all-closed')!();
    const repeatedQuit = { preventDefault: jest.fn() };
    test.appListeners.get('before-quit')!(repeatedQuit);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).not.toHaveBeenCalled();
    expect(repeatedQuit.preventDefault).toHaveBeenCalledTimes(1);

    release();
    await test.main.whenShutdown();
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('still permits one final quit when shutdown fails and error reporting throws', async () => {
    const test = harness();
    test.runtime.shutdown.mockRejectedValue(new Error('runtime shutdown failed'));
    test.dependencies.logger.error = jest.fn(() => {
      throw new Error('logger failed');
    });
    test.main.start();
    await test.main.whenStarted();

    test.windowListeners.get('closed')!();
    await test.main.whenShutdown().catch(() => undefined);

    expect(test.core.dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.logger.error).toHaveBeenCalledWith(
      'Main-process shutdown completed with failures',
      expect.objectContaining({ error: expect.stringMatching(/shutdown/i) })
    );
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight runtime acquisition, drains it, and never creates a window after quit', async () => {
    const test = harness();
    let releaseRuntime!: (runtime: typeof test.runtime) => void;
    test.dependencies.createRuntime = jest.fn(
      () => new Promise<typeof test.runtime>((resolve) => (releaseRuntime = resolve))
    );
    test.main.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(test.dependencies.createRuntime).toHaveBeenCalledTimes(1);

    const event = { preventDefault: jest.fn() };
    test.appListeners.get('before-quit')!(event);
    await Promise.resolve();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).not.toHaveBeenCalled();

    releaseRuntime(test.runtime);
    await test.main.whenStarted();
    await test.main.whenShutdown();

    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.createWindow).not.toHaveBeenCalled();
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('quits without constructing owners when another instance holds the lock', async () => {
    const test = harness({ lock: false });
    test.main.start();
    await test.main.whenStarted();
    await test.main.whenShutdown();

    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
    expect(test.dependencies.logger.close).toHaveBeenCalledTimes(1);
    expect(test.dependencies.createRuntime).not.toHaveBeenCalled();
    expect(test.dependencies.createWindow).not.toHaveBeenCalled();
  });

  it('still drains the application runtime and quits when core cleanup fails', async () => {
    const test = harness();
    test.core.dispose.mockImplementation(() => {
      throw new Error('core cleanup failed');
    });
    test.main.start();
    await test.main.whenStarted();

    test.appListeners.get('before-quit')!({ preventDefault: jest.fn() });
    await test.main.whenShutdown();

    expect(test.core.dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.logger.error).toHaveBeenCalledWith(
      'Main-process shutdown completed with failures',
      expect.objectContaining({ error: expect.stringMatching(/shutdown/i) })
    );
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('restores the retained window for a second instance and quits on the last Linux window', async () => {
    const test = harness();
    test.window.isMinimized.mockReturnValue(true);
    test.main.start();
    await test.main.whenStarted();

    test.appListeners.get('second-instance')!();
    expect(test.window.restore).toHaveBeenCalledTimes(1);
    expect(test.window.focus).toHaveBeenCalledTimes(1);
    test.appListeners.get('window-all-closed')!();
    await test.main.whenShutdown();
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('recreates a closed macOS window without re-registering process-wide IPC', async () => {
    const test = harness();
    test.dependencies.platform = 'darwin';
    test.dependencies.getAllWindows.mockReturnValue([]);
    test.main.start();
    await test.main.whenStarted();
    test.windowListeners.get('closed')!();

    test.appListeners.get('window-all-closed')!();
    expect(test.dependencies.app.quit).not.toHaveBeenCalled();
    test.appListeners.get('activate')!();
    await Promise.resolve();
    await Promise.resolve();

    expect(test.dependencies.createWindow).toHaveBeenCalledTimes(2);
    expect(test.core.register).toHaveBeenCalledTimes(1);
  });

  it('loads only an explicit local development renderer in an unpackaged runtime', async () => {
    const test = harness({ packaged: false });
    test.dependencies.developmentRendererUrl = 'http://localhost:58594';
    test.main.start();
    await test.main.whenStarted();

    expect(test.window.loadURL).toHaveBeenCalledWith('http://localhost:58594');
    expect(test.window.loadFile).not.toHaveBeenCalled();
  });

  it('rolls back runtime and core owners after a renderer load failure', async () => {
    const test = harness();
    test.window.loadFile.mockRejectedValue(new Error('renderer load failed'));
    test.main.start();

    await expect(test.main.whenStarted()).rejects.toThrow(/renderer load failed/i);
    await Promise.resolve();
    await test.main.whenShutdown();
    expect(test.core.dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('still drains startup owners when startup error reporting throws', async () => {
    const test = harness();
    test.window.loadFile.mockRejectedValue(new Error('renderer load failed'));
    test.dependencies.logger.error = jest.fn(() => {
      throw new Error('logger failed');
    });
    test.main.start();

    await expect(test.main.whenStarted()).rejects.toThrow(/renderer load failed/i);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    await test.main.whenShutdown();

    expect(test.core.dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('drains the retained runtime when macOS window recreation and reporting fail', async () => {
    const test = harness();
    test.dependencies.platform = 'darwin';
    test.dependencies.getAllWindows.mockReturnValue([]);
    test.main.start();
    await test.main.whenStarted();
    test.windowListeners.get('closed')!();
    test.window.loadFile.mockRejectedValueOnce(new Error('recreation failed'));
    test.dependencies.logger.error = jest.fn(() => {
      throw new Error('logger failed');
    });

    test.appListeners.get('activate')!();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    await test.main.whenShutdown();

    expect(test.dependencies.createWindow).toHaveBeenCalledTimes(2);
    expect(test.core.dispose).toHaveBeenCalledTimes(1);
    expect(test.runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(test.dependencies.app.quit).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe development URLs and duplicate or premature lifecycle access', async () => {
    const test = harness({ packaged: false });
    await expect(test.main.whenStarted()).rejects.toThrow(/not started/i);
    test.dependencies.developmentRendererUrl = 'https://example.com';
    test.main.start();
    expect(() => test.main.start()).toThrow(/already started/i);
    await expect(test.main.whenStarted()).rejects.toThrow(/development renderer URL/i);
    await Promise.resolve();
    await test.main.whenShutdown();
  });

  it('sets the Windows application identity before owner construction', async () => {
    const test = harness();
    test.dependencies.platform = 'win32';
    test.main.start();
    await test.main.whenStarted();

    expect(test.dependencies.app.setAppUserModelId).toHaveBeenCalledWith(
      'com.speedheathens.metamover'
    );
  });
});
