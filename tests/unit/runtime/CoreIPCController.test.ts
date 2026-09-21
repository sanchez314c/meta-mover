import path from 'path';

import { CORE_IPC_CHANNELS, CoreIPCController } from '../../../src/main/runtime/CoreIPCController';

describe('CoreIPCController', () => {
  function harness() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const window = {
      minimize: jest.fn(),
      maximize: jest.fn(),
      unmaximize: jest.fn(),
      isMaximized: jest.fn().mockReturnValue(false),
      close: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
    };
    const dependencies = {
      ipc: {
        handle: jest.fn(
          (channel: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
            handlers.set(channel, handler)
        ),
        removeHandler: jest.fn((channel: string) => handlers.delete(channel)),
      },
      getWindow: () => window,
      dialog: { showOpenDialog: jest.fn() },
      shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
      app: { getPath: jest.fn((name: string) => `/allowed/${name}`), getVersion: () => '1.0.0' },
      testRuns: {
        gather: jest.fn().mockResolvedValue({
          temporarySourcePath: '/tmp/meta-mover-test-runs/run/source',
          copiedFiles: 15000,
          scannedFiles: 900000,
        }),
        discard: jest.fn().mockResolvedValue(undefined),
        cancel: jest.fn().mockReturnValue(true),
      },
      publishTestRunProgress: jest.fn(),
      system: {
        platform: 'linux' as NodeJS.Platform,
        architecture: 'x64',
        nodeVersion: 'v20.0.0',
        electronVersion: '38.8.6',
        cpuCount: () => 8,
        totalMemory: () => 1024,
        freeMemory: () => 512,
      },
    };
    const controller = new CoreIPCController(dependencies);
    controller.register();
    const invoke = (channel: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.({}, ...args));
    return { controller, dependencies, handlers, invoke, window };
  }

  it('owns the complete preload core IPC surface and removes it on disposal', async () => {
    const test = harness();
    expect([...test.handlers.keys()].sort()).toEqual([...CORE_IPC_CHANNELS].sort());

    await test.invoke('window:minimize');
    await test.invoke('window:maximize');
    test.window.isMaximized.mockReturnValue(true);
    await test.invoke('window:maximize');
    await test.invoke('window:close');

    expect(test.window.minimize).toHaveBeenCalledTimes(1);
    expect(test.window.maximize).toHaveBeenCalledTimes(1);
    expect(test.window.unmaximize).toHaveBeenCalledTimes(1);
    expect(test.window.close).toHaveBeenCalledTimes(1);

    test.controller.dispose();
    expect(test.handlers.size).toBe(0);
  });

  it('returns canonical dialog and system responses with a strict path-name allowlist', async () => {
    const test = harness();
    test.dependencies.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/media/source'],
    });

    await expect(test.invoke('dialog:openDirectory')).resolves.toBe('/media/source');
    await expect(test.invoke('system:getPath', 'userData')).resolves.toBe('/allowed/userData');
    await expect(test.invoke('system:getPath', 'crashDumps')).resolves.toBeNull();
    await expect(test.invoke('system:info')).resolves.toEqual({
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v20.0.0',
      electronVersion: '38.8.6',
      appVersion: '1.0.0',
      cpuCount: 8,
      totalMemory: 1024,
      freeMemory: 512,
    });
  });

  it('opens only canonical absolute paths and http, https, or mailto URLs', async () => {
    const test = harness();
    const filePath = path.resolve('/tmp/media/photo.jpg');

    await expect(test.invoke('system:openPath', filePath)).resolves.toEqual({ success: true });
    await expect(test.invoke('system:openPath', '../photo.jpg')).resolves.toMatchObject({
      success: false,
    });
    await expect(test.invoke('open-external', 'https://example.com/path')).resolves.toEqual({
      success: true,
    });
    await expect(test.invoke('open-external', 'file:///etc/passwd')).resolves.toMatchObject({
      success: false,
    });
    await expect(
      test.invoke('open-external', 'https://user:secret@example.com')
    ).resolves.toMatchObject({
      success: false,
    });

    expect(test.dependencies.shell.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(test.dependencies.shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it('gathers and discards only validated test-run requests', async () => {
    const test = harness();
    await expect(
      test.invoke('test-run:gather', {
        sourcePath: '/media/source',
        destinationPath: '/media/destination',
        fileCount: 15000,
      })
    ).resolves.toMatchObject({ success: true, data: { copiedFiles: 15000 } });
    await expect(
      test.invoke('test-run:discard', '/tmp/meta-mover-test-runs/run/source')
    ).resolves.toEqual({ success: true });
    await expect(
      test.invoke('test-run:gather', { sourcePath: '../source' })
    ).resolves.toMatchObject({
      success: false,
    });
  });

  it('rolls back every owned handler when registration fails partway through', () => {
    const handlers = new Map<string, unknown>();
    const removeHandler = jest.fn((channel: string) => handlers.delete(channel));
    const controller = new CoreIPCController({
      ipc: {
        handle: jest.fn((channel: string, handler: unknown) => {
          if (channel === 'window:minimize') throw new Error('registration failed');
          handlers.set(channel, handler);
        }),
        removeHandler,
      },
      getWindow: () => null,
      dialog: { showOpenDialog: jest.fn() },
      shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
      app: { getPath: jest.fn(), getVersion: jest.fn() },
      testRuns: { gather: jest.fn(), discard: jest.fn(), cancel: jest.fn() },
      publishTestRunProgress: jest.fn(),
      system: {
        platform: 'linux',
        architecture: 'x64',
        nodeVersion: 'v20',
        electronVersion: '38',
        cpuCount: () => 1,
        totalMemory: () => 1,
        freeMemory: () => 1,
      },
    });

    expect(() => controller.register()).toThrow(/registration failed/i);
    expect(handlers.size).toBe(0);
    expect(removeHandler).toHaveBeenCalledTimes(2);
  });

  it('handles cancelled dialogs, destroyed windows, and idempotent disposal without side effects', async () => {
    const test = harness();
    test.dependencies.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    test.window.isDestroyed.mockReturnValue(true);

    await expect(test.invoke('dialog:openDirectory')).resolves.toBeNull();
    await test.invoke('window:minimize');
    await test.invoke('window:close');
    expect(test.window.minimize).not.toHaveBeenCalled();
    expect(test.window.close).not.toHaveBeenCalled();

    test.controller.dispose();
    expect(() => test.controller.dispose()).not.toThrow();
  });

  it('rejects malformed URL and path edge cases and duplicate registration', async () => {
    const test = harness();

    await expect(test.invoke('open-external', 'not a url')).resolves.toMatchObject({
      success: false,
    });
    await expect(test.invoke('open-external', 'mailto:user@example.com')).resolves.toEqual({
      success: true,
    });
    await expect(test.invoke('system:openPath', '/tmp/../etc/passwd')).resolves.toMatchObject({
      success: false,
    });
    await expect(test.invoke('system:openPath', '/tmp/bad\0path')).resolves.toMatchObject({
      success: false,
    });
    expect(() => test.controller.register()).toThrow(/already registered/i);
  });
});
