import { readFile } from 'fs/promises';
import path from 'path';

describe('main-process production entry', () => {
  it('materializes only the canonical runtime without legacy bridges or sandbox bypasses', async () => {
    const source = await readFile(path.resolve('src/main/index.ts'), 'utf8');

    expect(source).toContain('new ElectronMain');
    expect(source).toContain('.start()');
    expect(source).not.toMatch(/electron-updater|autoUpdater/);
    expect(source).not.toMatch(/PythonProcessingBridge|DatabaseManager|ConfigManager|IPCHandler/);
    expect(source).not.toMatch(/appendSwitch\(['"]no-sandbox|--no-sandbox/);
    expect(source).not.toMatch(/developmentRendererUrl|127\.0\.0\.1/);
    expect(source).toContain("path.resolve(__dirname, '../../.build-tools')");
  });

  it('keeps every executable package script inside the Electron sandbox', async () => {
    const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['dev', 'start', 'start:prod']) {
      expect(manifest.scripts[name]).not.toContain('--no-sandbox');
    }
  });
});
