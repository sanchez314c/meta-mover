import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { renameSync, unlinkSync, writeFileSync } from 'fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { PassThrough, Writable } from 'stream';

import type { BrokerLaunchTrustPolicy } from '../../../src/main/native/NativeFilesystemHelperClient';
import { BundledExifToolAdapter } from '../../../src/main/tools/BundledExifToolAdapter';

const selectedDate = {
  localIso: '2024-03-04T05:06:07',
  instantUtc: '2024-03-04T10:06:07.000Z',
  offsetMinutes: -300,
  zoneBasis: 'explicit-offset' as const,
  precision: 'second' as const,
};

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

function harness() {
  const spawnProcess: jest.MockedFunction<SpawnProcess> = jest.fn(
    (_command: string, _args: string[], _options: SpawnOptions) => ({ pid: 1234 }) as ChildProcess
  );
  return { spawnProcess };
}

function successfulFakeChild(tags: Record<string, unknown>): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: jest.fn(() => true),
  });
  stdin.once('finish', () => {
    stdout.end(Buffer.from(JSON.stringify([tags])));
    (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
    process.nextTick(() => child.emit('close', 0, null));
  });
  return child;
}

function successfulStayOpenChild(...responses: Record<string, unknown>[]): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  let responseIndex = 0;
  Object.assign(child, { stdin, stdout, stderr, exitCode: null, signalCode: null });
  child.kill = jest.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8');
    const match = input.match(/-execute(\d+)\n/);
    if (!match) return;
    input = input.slice(match.index! + match[0].length);
    const tags = responses[Math.min(responseIndex++, responses.length - 1)];
    stdout.write(`${JSON.stringify([tags])}\n{ready${match[1]}}\n`);
    stderr.write(`MMERR${match[1]}:0\n`);
  });
  return child;
}

function successfulWriteChild(stdoutText = '    1 image files updated\n'): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: jest.fn(() => true),
  });
  stdin.once('finish', () => {
    stdout.end(Buffer.from(stdoutText));
    (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
    process.nextTick(() => child.emit('close', 0, null));
  });
  return child;
}

async function writeManifest(resourcesRoot: string): Promise<void> {
  const toolsRoot = path.join(resourcesRoot, 'tools');
  const target = `linux-${process.arch}`;
  const helperRelativePath = path.join('fs-helper', target, 'meta-mover-fs-helper');
  const brokerRelativePath = path.join('launch-broker', target, 'meta-mover-launch-broker');
  const helperTarget =
    process.arch === 'x64'
      ? 'x86_64-unknown-linux-gnu'
      : process.arch === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : (() => {
            throw new Error(`Unsupported test architecture: ${process.arch}`);
          })();
  const helperScript = [
    `#!${process.execPath}`,
    "'use strict';",
    "let buffered = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    '  buffered += chunk;',
    "  while (buffered.includes('\\n')) {",
    "    const newline = buffered.indexOf('\\n');",
    '    const line = buffered.slice(0, newline);',
    '    buffered = buffered.slice(newline + 1);',
    '    if (!line) continue;',
    '    const request = JSON.parse(line);',
    '    let result;',
    `    if (request.op === 'hello') result = ${JSON.stringify({
      outcome: 'applied',
      protocol: 1,
      build: '0.1.0',
      target: helperTarget,
      features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
    })};`,
    "    else if (request.op === 'bind_roots') result = { outcome: 'applied', roots: request.roots.map((root, index) => ({ name: root.name, kind: root.kind, identity: { kind: 'unix', device: '1', inode: String(index + 1), links: '1', size: '0', mtimeNs: '1' } })), durability: { file: 'not-applicable', parents: [] } };",
    "    else if (request.op === 'close') result = { outcome: 'applied', durability: { file: 'not-applicable', parents: [] } };",
    '    else process.exit(21);',
    "    const response = JSON.stringify({ v: 1, id: request.id, ok: true, result }) + '\\n';",
    "    if (request.op === 'close') process.stdout.write(response, () => process.exit(0));",
    '    else process.stdout.write(response);',
    '  }',
    '});',
  ].join('\n');
  const relativePaths = {
    exiftool: path.join('exiftool', 'exiftool'),
    'fs-helper': helperRelativePath,
    'launch-broker': brokerRelativePath,
    perl: 'perl',
  } as const;
  await mkdir(path.dirname(path.join(toolsRoot, helperRelativePath)), { recursive: true });
  await writeFile(path.join(toolsRoot, helperRelativePath), helperScript, { mode: 0o700 });
  await chmod(path.join(toolsRoot, helperRelativePath), 0o700);
  const helperSha256 = createHash('sha256').update(helperScript).digest('hex');
  const brokerIdentity = JSON.stringify({
    brokerBuild: '0.1.0',
    brokerTarget: helperTarget,
    helperSha256,
    helperProtocol: 1,
    helperBuild: '0.1.0',
    helperTarget: target,
    releaseSigner: null,
  });
  const brokerScript = [
    '#!/bin/sh',
    'case "$1" in',
    `  --identity) printf '%s\\n' '${brokerIdentity}' ;;`,
    `  --stdio) exec '${path.join(toolsRoot, helperRelativePath)}' --stdio ;;`,
    '  *) exit 64 ;;',
    'esac',
  ].join('\n');
  await mkdir(path.dirname(path.join(toolsRoot, brokerRelativePath)), { recursive: true });
  await writeFile(path.join(toolsRoot, brokerRelativePath), brokerScript, { mode: 0o700 });
  await chmod(path.join(toolsRoot, brokerRelativePath), 0o700);
  await mkdir(path.join(toolsRoot, 'perl-lib', '00'), { recursive: true });
  const exifSupportContents = 'package Image; 1;';
  await mkdir(path.join(toolsRoot, 'exiftool', 'lib'), { recursive: true });
  await writeFile(path.join(toolsRoot, 'exiftool', 'lib', 'Image.pm'), exifSupportContents);
  const tools = await Promise.all(
    Object.entries(relativePaths).map(async ([name, relativePath]) => ({
      name,
      path: relativePath.split(path.sep).join('/'),
      version: name === 'fs-helper' || name === 'launch-broker' ? '0.1.0' : `${name}-test`,
      sha256: createHash('sha256')
        .update(await readFile(path.join(toolsRoot, relativePath)))
        .digest('hex'),
      ...(name === 'exiftool'
        ? {
            supportDirectory: {
              path: 'exiftool/lib',
              sha256: createHash('sha256')
                .update('Image.pm')
                .update('\0')
                .update(exifSupportContents)
                .update('\0')
                .digest('hex'),
              fileCount: 1,
            },
          }
        : name === 'fs-helper'
          ? {
              target,
              protocolVersion: 1,
              buildVersion: '0.1.0',
            }
          : name === 'launch-broker'
            ? {
                target,
                rustTarget: helperTarget,
                buildVersion: '0.1.0',
                helperSha256,
                helperProtocolVersion: 1,
                helperBuildVersion: '0.1.0',
                releaseSigner: null,
              }
            : {}),
    }))
  );
  await writeFile(
    path.join(toolsRoot, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 3,
      platform: 'linux',
      arch: process.arch,
      tools,
      perlLibs: [
        {
          path: 'perl-lib/00',
          sha256: createHash('sha256').digest('hex'),
          fileCount: 0,
        },
      ],
      runtimeCompatibility: {
        platform: 'linux',
        arch: process.arch,
        nativePlatformOnly: true,
        inspectedTool: 'perl',
        binaryFormat: 'ELF 64-bit test fixture',
        loader: '/lib64/ld-linux-x86-64.so.2',
        sharedLibraries: ['libc.so.6'],
      },
    })
  );
}

function productionPolicy(platform: NodeJS.Platform = 'linux'): BrokerLaunchTrustPolicy {
  return {
    mode: 'production',
    attestedPlatform: platform,
    acquire: jest.fn(async (descriptor) => ({
      mechanism: 'authenticated-package',
      executablePath: descriptor.canonicalPath,
      authority: `test-${platform}-package-attestor`,
      release: async () => undefined,
    })),
  };
}

describe('BundledExifToolAdapter', () => {
  it.each(['linux', 'darwin'] as const)(
    'opens the media path directly so ExifTool can seek without streaming the whole file on %s',
    async (platform) => {
      const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-exif-command-'));
      try {
        const snapshotPath = path.join(root, 'snapshot.jpg');
        await writeFile(snapshotPath, 'exact-input');
        const perlPath = '/opt/META Mover/resources/tools/perl';
        const exiftoolPath = '/opt/META Mover/resources/tools/exiftool/exiftool';
        const perlLibraryPaths = ['/opt/META Mover/resources/tools/perl-lib/00'];
        const spawnProcess = jest.fn(() =>
          successfulStayOpenChild({ 'EXIF:DateTimeOriginal': '2024:01:02 03:04:05' })
        );
        const adapter = new BundledExifToolAdapter(
          { platform, perlPath, exiftoolPath, perlLibraryPaths },
          { spawnProcess }
        );

        await expect(adapter.readRaw(snapshotPath)).resolves.toEqual({
          'EXIF:DateTimeOriginal': '2024:01:02 03:04:05',
        });
        expect(spawnProcess).toHaveBeenCalledWith(
          perlPath,
          [exiftoolPath, '-stay_open', 'True', '-@', '-'],
          {
            detached: false,
            env: {
              EXIFTOOL_HOME: path.dirname(exiftoolPath),
              LANG: 'C',
              LC_ALL: 'C',
              PATH: path.dirname(perlPath),
              PERL5LIB: [path.join(path.dirname(exiftoolPath), 'lib'), ...perlLibraryPaths].join(
                path.delimiter
              ),
              PERL_USE_UNSAFE_INC: '0',
            },
            shell: false,
            stdio: 'pipe',
          }
        );
        await adapter.close();
        await adapter.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('runs one-shot verified reads through the absolute bundled Windows executable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-exif-windows-command-'));
    try {
      const snapshotPath = path.join(root, 'snapshot.jpg');
      await writeFile(snapshotPath, 'exact-input');
      const exiftoolPath =
        'C:\\Program Files\\META Mover\\resources\\tools\\exiftool\\exiftool.exe';
      const spawnProcess = jest.fn(() => successfulStayOpenChild({ FileType: 'JPEG' }));
      const adapter = new BundledExifToolAdapter(
        { platform: 'win32', exiftoolPath },
        { spawnProcess }
      );

      await expect(adapter.readRaw(snapshotPath)).resolves.toEqual({ FileType: 'JPEG' });
      expect(spawnProcess).toHaveBeenCalledWith(
        exiftoolPath,
        ['-stay_open', 'True', '-@', '-'],
        expect.objectContaining({ shell: false, stdio: 'pipe' })
      );
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('normalizes only format-scoped creation tags and verifies the readback snapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-exif-write-'));
    try {
      const destinationPath = path.join(root, 'organized.jpg');
      await writeFile(destinationPath, 'destination-bytes');
      const exiftoolPath = '/opt/META Mover/resources/tools/exiftool/exiftool';
      const perlPath = '/opt/META Mover/resources/tools/perl';
      const before = {
        'ExifIFD:DateTimeOriginal': '2023:01:01 00:00:00',
        'EXIF:Make': 'Canon',
        'GPS:GPSDateStamp': '2023:01:01',
        'XMP-xmp:History': 'kept',
      };
      const after = {
        ...before,
        'ExifIFD:DateTimeOriginal': '2024:03:04 05:06:07',
        'ExifIFD:CreateDate': '2024:03:04 05:06:07',
        'ExifIFD:OffsetTimeOriginal': '-05:00',
        'ExifIFD:OffsetTimeDigitized': '-05:00',
        'XMP-exif:DateTimeOriginal': '2024:03:04 05:06:07',
        'XMP-photoshop:DateCreated': '2024:03:04 05:06:07',
        'XMP-xmp:CreateDate': '2024:03:04 05:06:07',
        'IPTC:DateCreated': '2024:03:04',
      };
      const spawnProcess = jest
        .fn()
        .mockImplementationOnce(() => successfulStayOpenChild(before, after))
        .mockImplementationOnce(() => successfulWriteChild());
      const adapter = new BundledExifToolAdapter(
        {
          platform: 'linux',
          perlPath,
          exiftoolPath,
          perlLibraryPaths: ['/opt/META Mover/resources/tools/perl-lib/00'],
        },
        { spawnProcess }
      );

      await expect(
        adapter.normalizeDateMetadata({
          filePath: destinationPath,
          selectedDate: {
            localIso: '2024-03-04T05:06:07',
            instantUtc: '2024-03-04T10:06:07.000Z',
            offsetMinutes: -300,
            zoneBasis: 'explicit-offset',
            precision: 'second',
          },
        })
      ).resolves.toMatchObject({ family: 'jpeg', idempotent: false, verified: true });

      const args = spawnProcess.mock.calls[1][1];
      expect(args).toEqual(
        expect.arrayContaining([
          exiftoolPath,
          '-overwrite_original_in_place',
          '-ExifIFD:DateTimeOriginal=2024:03:04 05:06:07',
          '-ExifIFD:CreateDate=2024:03:04 05:06:07',
          '-ExifIFD:OffsetTimeOriginal=-05:00',
          '-ExifIFD:OffsetTimeDigitized=-05:00',
          '-IPTC:DateCreated=2024:03:04',
          '--',
          destinationPath,
        ])
      );
      expect(args.join('\n')).not.toMatch(/Time:All|AllDates|ModifyDate|QuickTime:/);
      expect(args).not.toContain('/source/original.jpg');
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips the write and reports idempotence when every planned field already matches', async () => {
    const snapshotPath = '/tmp/already-clean.png';
    await writeFile(snapshotPath, 'test image');
    const tags = {
      'PNG:CreateDate': '2024:03:04 05:06:07',
      'XMP-xmp:CreateDate': '2024:03:04 05:06:07',
    };
    const spawnProcess = jest.fn(() => successfulStayOpenChild(tags));
    const adapter = new BundledExifToolAdapter(
      {
        platform: 'linux',
        perlPath: '/opt/tools/perl',
        exiftoolPath: '/opt/tools/exiftool',
        perlLibraryPaths: ['/opt/tools/lib'],
      },
      { spawnProcess }
    );

    await expect(
      adapter.normalizeDateMetadata({ filePath: snapshotPath, selectedDate })
    ).resolves.toMatchObject({ idempotent: true, verified: true, family: 'png' });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await adapter.close();
    await rm(snapshotPath, { force: true });
  });

  it('streams verified bytes from a held descriptor across snapshot pathname swap and restoration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-exif-held-stream-'));
    try {
      const exiftoolPath = path.join(root, 'fake-exiftool.js');
      const snapshotPath = path.join(root, 'snapshot.jpg');
      const displacedPath = path.join(root, 'snapshot-original.jpg');
      const originalBytes = 'inventoried-ground-truth-bytes';
      const replacementBytes = 'concurrent-path-replacement';
      await writeFile(
        exiftoolPath,
        [
          "'use strict';",
          'const chunks = [];',
          "process.stdin.on('data', chunk => chunks.push(chunk));",
          "process.stdin.on('end', () => {",
          "  const input = Buffer.concat(chunks).toString('utf8');",
          "  const value = input === 'inventoried-ground-truth-bytes'",
          "    ? '2024:03:04 05:06:07+00:00'",
          "    : '2035:01:02 03:04:05+00:00';",
          "  process.stdout.write(JSON.stringify([{ 'EXIF:DateTimeOriginal': value }]));",
          '});',
        ].join('\n')
      );
      await writeFile(snapshotPath, originalBytes);
      const spawnProcess: SpawnProcess = (command, args, options) => {
        renameSync(snapshotPath, displacedPath);
        writeFileSync(snapshotPath, replacementBytes);
        const child = spawn(command, args, options);
        unlinkSync(snapshotPath);
        renameSync(displacedPath, snapshotPath);
        return child;
      };
      const adapter = new BundledExifToolAdapter(
        {
          platform: 'linux',
          perlPath: process.execPath,
          exiftoolPath,
          perlLibraryPaths: [root],
        },
        { spawnProcess }
      );

      const result = await adapter.readRawVerified(snapshotPath);

      expect(result).toEqual({
        tags: { 'EXIF:DateTimeOriginal': '2024:03:04 05:06:07+00:00' },
        sha256: createHash('sha256').update(originalBytes).digest('hex'),
        bytes: Buffer.byteLength(originalBytes),
      });
      expect(await readFile(snapshotPath, 'utf8')).toBe(originalBytes);
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates and rethrows cancellation for one-shot verified extraction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-exif-held-abort-'));
    try {
      const exiftoolPath = path.join(root, 'slow-exiftool.js');
      const snapshotPath = path.join(root, 'snapshot.jpg');
      await writeFile(
        exiftoolPath,
        [
          "'use strict';",
          'process.stdin.resume();',
          "process.stdin.on('end', () => setTimeout(() => {",
          "  process.stdout.write('{}');",
          '}, 5000));',
        ].join('\n')
      );
      await writeFile(snapshotPath, 'inventoried-ground-truth-bytes');
      const controller = new AbortController();
      const spawnProcess: SpawnProcess = (command, args, options) => {
        const child = spawn(command, args, options);
        void Promise.resolve().then(() => controller.abort('operator cancelled metadata'));
        return child;
      };
      const adapter = new BundledExifToolAdapter(
        {
          platform: 'linux',
          perlPath: process.execPath,
          exiftoolPath,
          perlLibraryPaths: [root],
        },
        { spawnProcess }
      );

      await expect(adapter.readRawVerified(snapshotPath, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('escalates every failed verified child from TERM to KILL after the bound', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-exif-held-failure-kill-'));
    try {
      const exiftoolPath = path.join(root, 'oversized-exiftool.js');
      const snapshotPath = path.join(root, 'snapshot.jpg');
      await writeFile(
        exiftoolPath,
        [
          "'use strict';",
          "process.on('SIGTERM', () => {});",
          'process.stdin.resume();',
          "process.stdin.on('end', () => {",
          '  process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));',
          '  setInterval(() => {}, 1000);',
          '});',
        ].join('\n')
      );
      await writeFile(snapshotPath, 'inventoried-ground-truth-bytes');
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const spawnProcess: SpawnProcess = (command, args, options) => {
        const child = spawn(command, args, options);
        const originalKill = child.kill.bind(child);
        child.kill = ((signal?: NodeJS.Signals | number) => {
          signals.push(signal);
          return originalKill(signal);
        }) as ChildProcess['kill'];
        return child;
      };
      const adapter = new BundledExifToolAdapter(
        {
          platform: 'linux',
          perlPath: process.execPath,
          exiftoolPath,
          perlLibraryPaths: [root],
        },
        { spawnProcess }
      );

      await expect(adapter.readRawVerified(snapshotPath)).rejects.toThrow(/exceeded 16 MiB/i);
      expect(signals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes stdin streaming failure through bounded TERM-to-KILL escalation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-exif-stdin-failure-'));
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshotPath = path.join(root, 'snapshot.jpg');
      await writeFile(snapshotPath, 'inventoried-ground-truth-bytes');
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const spawnProcess: SpawnProcess = () => {
        const child = new EventEmitter() as ChildProcess;
        const stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('deterministic stdin failure'));
          },
        });
        stdin.on('error', () => undefined);
        Object.assign(child, {
          stdin,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null,
          signalCode: null,
        });
        child.kill = ((signal?: NodeJS.Signals | number) => {
          signals.push(signal);
          if (signal === 'SIGKILL') {
            child.signalCode = 'SIGKILL';
            queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
          }
          return true;
        }) as ChildProcess['kill'];
        fallback = setTimeout(() => child.emit('close', null, 'SIGTERM'), 750);
        return child;
      };
      const adapter = new BundledExifToolAdapter(
        {
          platform: 'linux',
          perlPath: process.execPath,
          exiftoolPath: path.join(root, 'fake-exiftool.js'),
          perlLibraryPaths: [root],
        },
        { spawnProcess }
      );

      await expect(adapter.readRawVerified(snapshotPath)).rejects.toThrow(
        /deterministic stdin failure/i
      );
      expect(signals).toEqual(expect.arrayContaining(['SIGTERM', 'SIGKILL']));
      await adapter.close();
    } finally {
      if (fallback) clearTimeout(fallback);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { platform: 'linux', exiftoolPath: 'tools/exiftool/exiftool', perlPath: '/tools/perl' },
    { platform: 'linux', exiftoolPath: '/tools/exiftool/exiftool', perlPath: 'perl' },
    {
      platform: 'linux',
      exiftoolPath: '/tools/exiftool/exiftool',
      perlPath: '/tools/perl',
      perlLibraryPaths: ['perl-lib/00'],
    },
    { platform: 'win32', exiftoolPath: 'exiftool.exe' },
  ] as const)('rejects non-absolute injected paths', (paths) => {
    expect(() => new BundledExifToolAdapter(paths, harness())).toThrow(/absolute/i);
  });

  it('rejects unsupported platforms and missing Unix Perl libraries', () => {
    expect(
      () =>
        new BundledExifToolAdapter(
          { platform: 'freebsd', exiftoolPath: '/tools/exiftool' },
          harness()
        )
    ).toThrow(/unsupported/i);
    expect(
      () =>
        new BundledExifToolAdapter(
          { platform: 'linux', exiftoolPath: '/tools/exiftool', perlPath: '/tools/perl' },
          harness()
        )
    ).toThrow(/library paths/i);
  });

  it('rejects packaged tool symlink escapes and missing resource roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-bundled-exif-'));
    try {
      const resourcesRoot = path.join(root, 'resources');
      const outside = path.join(root, 'outside-perl');
      const exiftoolPath = path.join(resourcesRoot, 'tools', 'exiftool', 'exiftool');
      await mkdir(path.dirname(exiftoolPath), { recursive: true });
      await writeFile(outside, 'perl', { mode: 0o700 });
      await chmod(outside, 0o700);
      await writeFile(exiftoolPath, 'script', { mode: 0o700 });
      await chmod(exiftoolPath, 0o700);
      await symlink(outside, path.join(resourcesRoot, 'tools', 'perl'));
      await writeManifest(resourcesRoot);

      await expect(
        BundledExifToolAdapter.createPackaged(resourcesRoot, 'linux', harness(), {
          isPackaged: false,
        })
      ).rejects.toThrow(/escapes|singly|symbolic/i);
      await expect(
        BundledExifToolAdapter.createPackaged(path.join(root, 'missing'), 'linux', harness(), {
          isPackaged: false,
        })
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves both Unix executables from the packaged tools resource layout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-packaged-exif-'));
    try {
      const resourcesRoot = path.join(root, 'resources');
      const perlPath = path.join(resourcesRoot, 'tools', 'perl');
      const exiftoolPath = path.join(resourcesRoot, 'tools', 'exiftool', 'exiftool');
      await mkdir(path.dirname(exiftoolPath), { recursive: true });
      await writeFile(perlPath, '#!/bin/sh\necho exiftool-test\n', { mode: 0o700 });
      await writeFile(exiftoolPath, 'script', { mode: 0o700 });
      await chmod(perlPath, 0o700);
      await chmod(exiftoolPath, 0o700);
      await writeManifest(resourcesRoot);
      const test = harness();

      const adapter = await BundledExifToolAdapter.createPackaged(resourcesRoot, 'linux', test, {
        isPackaged: false,
      });
      expect(test.spawnProcess).not.toHaveBeenCalled();
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses to create a packaged client until manifest hashes and versions are verified', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-packaged-verification-'));
    try {
      const resourcesRoot = path.join(root, 'resources');
      const perlPath = path.join(resourcesRoot, 'tools', 'perl');
      const exiftoolPath = path.join(resourcesRoot, 'tools', 'exiftool', 'exiftool');
      await mkdir(path.dirname(exiftoolPath), { recursive: true });
      await writeFile(perlPath, '#!/bin/sh\necho exiftool-test\n', { mode: 0o700 });
      await writeFile(exiftoolPath, 'original', { mode: 0o700 });
      await chmod(perlPath, 0o700);
      await chmod(exiftoolPath, 0o700);
      await writeManifest(resourcesRoot);
      await writeFile(exiftoolPath, 'tampered', { mode: 0o700 });
      const test = harness();

      await expect(
        BundledExifToolAdapter.createPackaged(resourcesRoot, 'linux', test, {
          isPackaged: false,
        })
      ).rejects.toThrow(/digest/i);
      expect(test.spawnProcess).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the built-in immutable Linux trust policy for packaged launches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-packaged-linux-policy-'));
    try {
      const resourcesRoot = path.join(root, 'resources');
      const sideEffectPath = path.join(root, 'untrusted-perl-executed');
      const perlPath = path.join(resourcesRoot, 'tools', 'perl');
      const exiftoolPath = path.join(resourcesRoot, 'tools', 'exiftool', 'exiftool');
      await mkdir(path.dirname(exiftoolPath), { recursive: true });
      await writeFile(
        perlPath,
        `#!/bin/sh\nprintf compromised > '${sideEffectPath}'\necho exiftool-test\n`,
        { mode: 0o700 }
      );
      await writeFile(exiftoolPath, 'script', { mode: 0o700 });
      await writeManifest(resourcesRoot);

      await expect(
        BundledExifToolAdapter.createPackaged(resourcesRoot, 'linux', harness())
      ).rejects.toThrow(/allowed system install root/i);
      await expect(readFile(sideEffectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['darwin', 'win32'] as const)(
    'selects the built-in native package attestor for packaged %s launches',
    async (platform) => {
      await expect(
        BundledExifToolAdapter.createPackaged('/Applications/META Mover/resources', platform)
      ).rejects.toThrow(/ENOENT/i);
    }
  );

  it('passes an injected production policy through the packaged runtime graph', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-packaged-policy-injection-'));
    try {
      const resourcesRoot = path.join(root, 'resources');
      const perlPath = path.join(resourcesRoot, 'tools', 'perl');
      const exiftoolPath = path.join(resourcesRoot, 'tools', 'exiftool', 'exiftool');
      await mkdir(path.dirname(exiftoolPath), { recursive: true });
      await writeFile(perlPath, '#!/bin/sh\necho exiftool-test\n', { mode: 0o700 });
      await writeFile(exiftoolPath, 'script', { mode: 0o700 });
      await writeManifest(resourcesRoot);
      const policy = productionPolicy();
      const test = harness();

      const adapter = await BundledExifToolAdapter.createPackaged(resourcesRoot, 'linux', test, {
        launchTrustPolicy: policy,
      });

      expect(policy.acquire).toHaveBeenCalledTimes(2);
      await adapter.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects development trust when the caller declares a packaged launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'meta-mover-packaged-development-policy-'));
    try {
      const policy: BrokerLaunchTrustPolicy = {
        mode: 'development',
        attestedPlatform: 'development-any',
        acquire: jest.fn(),
      };

      await expect(
        BundledExifToolAdapter.createPackaged(root, 'linux', harness(), {
          launchTrustPolicy: policy,
        })
      ).rejects.toThrow(/development/i);
      expect(policy.acquire).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
