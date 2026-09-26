import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import { ExifToolStayOpenPool } from '../../../src/main/tools/ExifToolStayOpenPool';

describe('bundled ExifTool stay-open framing', () => {
  it('keeps concurrent metadata reads separate, survives a bad file, and closes workers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-stay-open-'));
    const exiftool = path.resolve('.build-tools/tools/exiftool/exiftool');
    const perl = path.resolve('.build-tools/tools/perl');
    const perlLibrary = path.resolve('.build-tools/tools/perl-lib/00');
    const children: number[] = [];
    const pool = new ExifToolStayOpenPool(
      (command, args, options) => {
        const child = spawn(command, args, options);
        if (child.pid) children.push(child.pid);
        return child;
      },
      perl,
      [exiftool],
      {
        detached: false,
        shell: false,
        stdio: 'pipe',
        env: {
          EXIFTOOL_HOME: path.dirname(exiftool),
          LANG: 'C',
          LC_ALL: 'C',
          PATH: path.dirname(perl),
          PERL5LIB: [path.join(path.dirname(exiftool), 'lib'), perlLibrary].join(path.delimiter),
          PERL_USE_UNSAFE_INC: '0',
        },
      },
      'linux',
      2
    );
    try {
      const a = path.join(root, 'a.txt');
      const b = path.join(root, 'b.txt');
      await writeFile(a, 'one unique word');
      await writeFile(b, 'two very different words');
      const [first, second] = await Promise.all([pool.read(a), pool.read(b)]);
      expect(JSON.parse(first.toString('utf8'))[0]['File:WordCount']).toBe(3);
      expect(JSON.parse(second.toString('utf8'))[0]['File:WordCount']).toBe(4);
      await expect(pool.read(path.join(root, 'missing.txt'))).rejects.toThrow();
      const again = JSON.parse((await pool.read(a)).toString('utf8'))[0];
      expect(again['File:FileType']).toBe('TXT');
      expect(children.length).toBeLessThanOrEqual(3);
    } finally {
      await pool.close();
      await expect(pool.read(path.join(root, 'a.txt'))).rejects.toThrow(/closed/);
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('cancels a stalled request, closes the exact worker, and rejects queued work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-stay-open-abort-'));
  const file = path.join(root, 'image.jpg');
  await writeFile(file, 'fixture');
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  const kill = jest.fn((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  });
  child.kill = kill as ChildProcess['kill'];
  const pool = new ExifToolStayOpenPool(
    () => child,
    '/fake/perl',
    ['/fake/exiftool'],
    { stdio: 'pipe' },
    'linux',
    1
  );
  try {
    const controller = new AbortController();
    const pending = pool.read(file, controller.signal);
    controller.abort('operator cancelled');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await pool.close();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await expect(pool.read(file)).rejects.toThrow(/closed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('recovers from an asynchronous worker spawn error without crashing the process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-stay-open-spawn-'));
  const file = path.join(root, 'image.jpg');
  await writeFile(file, 'fixture');
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  child.kill = jest.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  const pool = new ExifToolStayOpenPool(
    () => {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    },
    '/fake/perl',
    ['/fake/exiftool'],
    { stdio: 'pipe' },
    'linux',
    1
  );
  try {
    await expect(pool.read(file)).rejects.toThrow(/spawn ENOENT|worker closed/);
  } finally {
    await pool.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('discards a cancelled worker and reads the next file on a fresh process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-stay-open-recover-'));
  const file = path.join(root, 'image.jpg');
  await writeFile(file, 'fixture');
  let spawnCount = 0;
  let firstCommand: (() => void) | undefined;
  const pool = new ExifToolStayOpenPool(
    () => {
      const child = new EventEmitter() as ChildProcess;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
      child.kill = jest.fn((signal: NodeJS.Signals) => {
        child.signalCode = signal;
        queueMicrotask(() => child.emit('close', null, signal));
        return true;
      });
      const index = ++spawnCount;
      stdin.on('data', (chunk: Buffer) => {
        const match = chunk.toString('utf8').match(/-execute(\d+)\n/);
        if (!match) return;
        if (index === 1) firstCommand?.();
        else {
          stdout.write(`[{}]\n{ready${match[1]}}\n`);
          stderr.write(`MMERR${match[1]}:0\n`);
        }
      });
      return child;
    },
    '/fake/perl',
    ['/fake/exiftool'],
    { stdio: 'pipe' },
    'linux',
    1
  );
  try {
    const controller = new AbortController();
    const sent = new Promise<void>((resolve) => {
      firstCommand = resolve;
    });
    const pending = pool.read(file, controller.signal);
    await sent;
    controller.abort('cancel while running');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pool.read(file)).resolves.toEqual(Buffer.from('[{}]'));
    expect(spawnCount).toBe(2);
  } finally {
    await pool.close();
    await rm(root, { recursive: true, force: true });
  }
});
