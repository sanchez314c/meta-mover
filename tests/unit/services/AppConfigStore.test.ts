import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { renameSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  AppConfigStore,
  AppConfigValidationError,
  DEFAULT_APP_CONFIG,
} from '../../../src/main/services/AppConfigStore';

describe('AppConfigStore', () => {
  let root: string;
  let configPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'meta-mover-config-'));
    configPath = path.join(root, 'nested', 'config.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads defaults and deep-merges a valid partial persisted configuration', async () => {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        theme: 'dark',
        processing: { workerCount: 7 },
        organization: { folderStructure: 'flat' },
        ignoredUnknown: true,
      })
    );

    const store = await AppConfigStore.open(configPath);

    expect(store.getAll()).toEqual({
      ...DEFAULT_APP_CONFIG,
      theme: 'dark',
      processing: { ...DEFAULT_APP_CONFIG.processing, workerCount: 7 },
      organization: { ...DEFAULT_APP_CONFIG.organization, folderStructure: 'flat' },
    });
  });

  it('validates updates, deep-merges nested fields, and returns defensive copies', async () => {
    const store = await AppConfigStore.open(configPath);

    await store.update({ processing: { workerCount: 5 } });
    const first = store.getAll();
    first.processing.workerCount = 1;

    expect(store.getAll().processing).toEqual({
      ...DEFAULT_APP_CONFIG.processing,
      workerCount: 5,
    });
    await expect(store.update({ processing: { workerCount: 99 } })).rejects.toBeInstanceOf(
      AppConfigValidationError
    );
    await expect(
      store.update({ organization: { conflictPolicy: 'overwrite' as 'rename' } })
    ).rejects.toBeInstanceOf(AppConfigValidationError);
  });

  it('persists atomically with a private file and serializes concurrent updates', async () => {
    const store = await AppConfigStore.open(configPath);

    await Promise.all([
      store.update({ theme: 'dark' }),
      store.update({ processing: { workerCount: 3 } }),
      store.update({ organization: { folderStructure: 'year-month' } }),
    ]);

    const persisted = JSON.parse(await readFile(configPath, 'utf8'));
    expect(persisted).toMatchObject({
      theme: 'dark',
      processing: { workerCount: 3 },
      organization: { folderStructure: 'year-month' },
    });
    expect((await lstat(configPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
  });

  it('does not chmod a pre-existing parent directory', async () => {
    await mkdir(path.dirname(configPath), { recursive: true });
    await chmod(path.dirname(configPath), 0o755);

    const store = await AppConfigStore.open(configPath);
    await store.update({ theme: 'light' });

    expect((await lstat(path.dirname(configPath))).mode & 0o777).toBe(0o755);
  });

  it('rejects symlinked and hard-linked configuration files', async () => {
    await mkdir(path.dirname(configPath), { recursive: true });
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, '{}');
    await symlink(outside, configPath);

    await expect(AppConfigStore.open(configPath)).rejects.toThrow(/symbolic link/i);
    await unlink(configPath);
    await link(outside, configPath);
    await expect(AppConfigStore.open(configPath)).rejects.toThrow(/singly-linked/i);
  });

  it('resets every field to safe defaults and persists the reset', async () => {
    const store = await AppConfigStore.open(configPath);
    await store.update({
      theme: 'dark',
      processing: { operation: 'move', workerCount: 8 },
      organization: { folderStructure: 'flat', conflictPolicy: 'skip' },
    });

    await expect(store.reset()).resolves.toEqual(DEFAULT_APP_CONFIG);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(DEFAULT_APP_CONFIG);
  });

  it('falls back to defaults for malformed persisted values without silently blessing them', async () => {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"processing":{"workerCount":0}}');

    const warnings: string[] = [];
    const store = await AppConfigStore.open(configPath, (warning) => warnings.push(warning));

    expect(store.getAll()).toEqual(DEFAULT_APP_CONFIG);
    expect(warnings).toEqual([expect.stringMatching(/invalid/i)]);
    expect(await readFile(configPath, 'utf8')).toBe('{"processing":{"workerCount":0}}');
  });

  it('snapshots data properties once and rejects accessor-bearing updates', async () => {
    const store = await AppConfigStore.open(configPath);
    let reads = 0;
    const update = Object.defineProperty({}, 'theme', {
      enumerable: true,
      get: () => (++reads === 1 ? 'dark' : 'corrupt'),
    });

    await expect(store.update(update)).rejects.toThrow(/accessor/i);
    expect(store.getAll().theme).toBe('system');
  });

  it('does not follow a replacement parent directory into an outside location', async () => {
    const store = await AppConfigStore.open(configPath);
    const originalParent = path.dirname(configPath);
    const movedParent = path.join(root, 'moved-parent');
    const outsideParent = path.join(root, 'outside-parent');
    await mkdir(outsideParent);
    await rename(originalParent, movedParent);
    await symlink(outsideParent, originalParent);

    await expect(store.update({ theme: 'dark' })).rejects.toThrow(/identity|symbolic/i);
    await expect(readFile(path.join(outsideParent, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a symlinked ancestor before creating any outside directory', async () => {
    const outsideParent = path.join(root, 'outside-parent');
    const alias = path.join(root, 'alias');
    await mkdir(outsideParent);
    await symlink(outsideParent, alias, 'dir');

    await expect(
      AppConfigStore.open(path.join(alias, 'must-not-exist', 'config.json'))
    ).rejects.toThrow(/symbolic|ancestor/i);
    await expect(lstat(path.join(outsideParent, 'must-not-exist'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('syncs each containing directory after creating a path component', async () => {
    const synced: string[] = [];
    const deepPath = path.join(root, 'one', 'two', 'config.json');

    await AppConfigStore.open(deepPath, undefined, {
      onDirectorySynced: (directoryPath) => synced.push(directoryPath),
    });

    expect(synced).toEqual(expect.arrayContaining([root, path.join(root, 'one')]));
  });

  it('reads through a no-follow handle and rejects a replaced leaf identity', async () => {
    await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ theme: 'dark' }), { mode: 0o600 });
    const moved = path.join(root, 'moved-config.json');
    const replacement = path.join(root, 'replacement.json');
    await writeFile(replacement, JSON.stringify({ theme: 'light' }), { mode: 0o600 });

    await expect(
      AppConfigStore.open(configPath, undefined, {
        beforeConfigRead: async () => {
          await rename(configPath, moved);
          await symlink(replacement, configPath);
        },
      })
    ).rejects.toThrow(/identity|symbolic/i);
  });

  it('keeps the validated parent anchored while opening the configuration file', async () => {
    const originalParent = path.dirname(configPath);
    const movedParent = path.join(root, 'moved-parent');
    const outsideParent = path.join(root, 'outside-parent');
    await mkdir(originalParent, { recursive: true, mode: 0o700 });
    await mkdir(outsideParent, { mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ theme: 'dark' }), { mode: 0o600 });
    await writeFile(path.join(outsideParent, 'config.json'), JSON.stringify({ theme: 'light' }), {
      mode: 0o600,
    });

    await expect(
      AppConfigStore.open(configPath, undefined, {
        afterParentPrepared: async () => {
          await rename(originalParent, movedParent);
          await symlink(outsideParent, originalParent, 'dir');
        },
      })
    ).rejects.toThrow(/parent identity|symbolic/i);
  });

  it('does not create through a swapped ancestor on the portable path fallback', async () => {
    const victim = path.join(root, 'victim');
    const movedVictim = path.join(root, 'moved-victim');
    const outside = path.join(root, 'outside');
    const portableConfigPath = path.join(victim, 'one', 'two', 'config.json');
    await mkdir(victim);
    await mkdir(outside);
    let swapped = false;

    await expect(
      AppConfigStore.open(portableConfigPath, undefined, {
        platform: 'darwin',
        onDirectorySynced: (directoryPath) => {
          if (directoryPath !== victim || swapped) return;
          swapped = true;
          renameSync(victim, movedVictim);
          symlinkSync(outside, victim, 'dir');
        },
      })
    ).rejects.toThrow(/identity|symbolic|ancestor/i);

    expect(swapped).toBe(true);
    await expect(lstat(path.join(outside, 'one'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects accessor-bearing arrays without invoking their getters', async () => {
    const store = await AppConfigStore.open(configPath);
    let reads = 0;
    const hostile = Object.defineProperty([], '0', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'dark';
      },
    });

    await expect(store.update(hostile as unknown as object)).rejects.toThrow(/array|object/i);
    expect(reads).toBe(0);
  });

  it.each([
    [{ theme: 'neon' }, /theme/i],
    [{ windowBounds: { width: 899, height: 600 } }, /width/i],
    [{ processing: { operation: 'delete' } }, /operation/i],
    [{ processing: { verifyIntegrity: false } }, /verifyIntegrity/i],
    [{ processing: { corruptionDetection: true } }, /corruptionDetection|unknown/i],
    [{ organization: { folderStructure: 'daily' } }, /folderStructure/i],
    [{ organization: { conflictPolicy: 'overwrite' } }, /conflictPolicy/i],
    [{ processing: { workerCount: 2, command: 'erase' } }, /unknown/i],
  ])('rejects invalid strict update %j', async (update, message) => {
    const store = await AppConfigStore.open(configPath);
    await expect(store.update(update as never)).rejects.toThrow(message);
  });

  it('migrates version 2 corruption settings out and cannot enable the retired behavior', async () => {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 2,
        processing: { workerCount: 6, corruptionDetection: true },
      })
    );

    const store = await AppConfigStore.open(configPath);
    expect(store.getAll()).toMatchObject({ version: 3, processing: { workerCount: 6 } });
    expect(store.getAll().processing).not.toHaveProperty('corruptionDetection');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(store.getAll());
    await expect(
      store.update({ processing: { corruptionDetection: true } } as never)
    ).rejects.toThrow(/corruptionDetection|unknown/i);
  });

  it('rejects rather than silently stripping a retired field from version 3 config', async () => {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 3,
        theme: 'dark',
        processing: { corruptionDetection: true },
      })
    );
    const warnings: string[] = [];

    const store = await AppConfigStore.open(configPath, (warning) => warnings.push(warning));

    expect(store.getAll()).toEqual(DEFAULT_APP_CONFIG);
    expect(warnings).toEqual([expect.stringMatching(/corruptionDetection|unknown/i)]);
  });

  it('validates optional window coordinates and persists a complete bounds snapshot', async () => {
    const store = await AppConfigStore.open(configPath);

    await expect(
      store.update({ windowBounds: { width: 1200, height: 800, x: -50, y: 75 } })
    ).resolves.toMatchObject({
      windowBounds: { width: 1200, height: 800, x: -50, y: 75 },
    });
    await expect(
      store.update({ windowBounds: { width: 1200, height: 800, x: 100_001 } })
    ).rejects.toThrow(/windowBounds.x/i);
  });

  it('seals write admission, drains admitted writes, and returns one stable close promise', async () => {
    let persistStarted!: () => void;
    let releasePersist!: () => void;
    const started = new Promise<void>((resolve) => {
      persistStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const store = await AppConfigStore.open(configPath, undefined, {
      beforePersist: async () => {
        persistStarted();
        await blocked;
      },
    });
    const admittedUpdate = store.update({ theme: 'dark' });
    const secondAdmittedUpdate = store.update({ processing: { workerCount: 6 } });
    await started;

    const firstClose = store.close();
    const secondClose = store.close();
    let closeSettled = false;
    void firstClose.then(() => {
      closeSettled = true;
    });

    expect(firstClose).toBe(secondClose);
    expect(closeSettled).toBe(false);
    await expect(store.update({ theme: 'light' })).rejects.toThrow(/closing|closed/i);
    await expect(store.reset()).rejects.toThrow(/closing|closed/i);
    expect(store.getAll().theme).toBe('system');

    releasePersist();
    await expect(admittedUpdate).resolves.toMatchObject({ theme: 'dark' });
    await expect(secondAdmittedUpdate).resolves.toMatchObject({
      theme: 'dark',
      processing: expect.objectContaining({ workerCount: 6 }),
    });
    await expect(firstClose).resolves.toBeUndefined();
    expect(store.close()).toBe(firstClose);
    expect(store.getAll().theme).toBe('dark');
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      theme: 'dark',
      processing: { workerCount: 6 },
    });
  });
});
