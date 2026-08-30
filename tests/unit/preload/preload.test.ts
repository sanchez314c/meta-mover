const exposeInMainWorld = jest.fn();
const invoke = jest.fn().mockResolvedValue(undefined);
const on = jest.fn();
const removeListener = jest.fn();

jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

describe('preload processing API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => require('../../../src/preload/index'));
  });

  function api(): Record<string, (...args: unknown[]) => unknown> {
    expect(exposeInMainWorld).toHaveBeenCalledWith('electronAPI', expect.any(Object));
    return exposeInMainWorld.mock.calls[0][1];
  }

  it('maps the two-step processing and durable settings API to fixed channels', async () => {
    const bridge = api();
    const preview = { sourcePaths: ['/source'], destinationPath: '/destination', options: {} };
    const start = { previewId: 'preview-1', acknowledgeDestructiveOperation: false };

    await bridge.previewProcessing(preview);
    await bridge.startProcessing(start);
    await bridge.cancelProcessing({ jobId: 'job-1' });
    await bridge.getProcessingHealth();
    await bridge.getJobHistory(25);
    await bridge.updateConfig({ theme: 'dark' });

    expect(invoke.mock.calls).toEqual(
      expect.arrayContaining([
        ['processing:preview', preview],
        ['processing:start', start],
        ['processing:cancel', { jobId: 'job-1' }],
        ['processing:health'],
        ['processing:history', 25],
        ['config:update', { theme: 'dark' }],
      ])
    );
  });

  it('subscribes to one canonical event channel and removes only its own listener', () => {
    const bridge = api();
    const callback = jest.fn();
    const unsubscribe = bridge.onProcessingEvent(callback) as () => void;
    const wrapped = on.mock.calls[0][1];
    const event = { kind: 'job-started' };

    wrapped({}, event);
    expect(callback).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('processing:event', wrapped);
  });

  it('does not expose listener-wide removal, pause, resume, or database escape hatches', () => {
    const bridge = api();
    expect(bridge).not.toHaveProperty('removeProcessingListeners');
    expect(bridge).not.toHaveProperty('pauseProcessing');
    expect(bridge).not.toHaveProperty('resumeProcessing');
    expect(bridge).not.toHaveProperty('getJob');
  });
});
