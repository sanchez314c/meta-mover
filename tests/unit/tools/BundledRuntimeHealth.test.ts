import * as childProcess from 'child_process';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import {
  developmentBrokerLaunchTrustPolicy,
  VerifiedHelperLaunchLeaseProvider,
} from '../../../src/main/native/NativeFilesystemHelperClient';
import { BundledRuntimeHealth } from '../../../src/main/tools/BundledRuntimeHealth';

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});

describe('BundledRuntimeHealth', () => {
  let resourcesRoot: string;
  let toolsRoot: string;
  let helperPath: string;
  let brokerPath: string;

  const rustTarget =
    process.platform === 'linux'
      ? process.arch === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : 'x86_64-unknown-linux-gnu'
      : process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin';
  const wrongRustTarget = rustTarget.includes('aarch64')
    ? 'x86_64-unknown-linux-gnu'
    : 'aarch64-unknown-linux-gnu';

  const validHelperScript = (
    overrides: {
      protocol?: number;
      build?: string;
      target?: string;
      identityKind?: 'unix' | 'windows';
      helloPadding?: number;
    } = {}
  ) =>
    [
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
      "    if (request.op === 'hello') result = " +
        JSON.stringify({
          outcome: 'applied',
          protocol: overrides.protocol ?? 1,
          build: overrides.build ?? '0.1.0',
          target: overrides.target ?? rustTarget,
          features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
        }) +
        ';',
      `    else if (request.op === 'bind_roots') result = { outcome: 'applied', roots: request.roots.map((root, index) => ({ name: root.name, kind: root.kind, identity: ${
        overrides.identityKind === 'windows'
          ? "{ kind: 'windows', volumeSerial: '1', fileId: String(index + 1), links: '1', size: '0', mtimeNs: '1' }"
          : "{ kind: 'unix', device: '1', inode: String(index + 1), links: '1', size: '0', mtimeNs: '1' }"
      } })), durability: { file: 'not-applicable', parents: [] } };`,
      "    else if (request.op === 'close') result = { outcome: 'applied', durability: { file: 'not-applicable', parents: [] } };",
      '    else process.exit(21);',
      `    const padding = request.op === 'hello' ? ' '.repeat(${overrides.helloPadding ?? 0}) : '';`,
      "    const response = JSON.stringify({ v: 1, id: request.id, ok: true, result }) + padding + '\\n';",
      "    if (request.op === 'close') process.stdout.write(response, () => process.exit(0));",
      '    else process.stdout.write(response);',
      '  }',
      '});',
    ].join('\n');

  const brokerScript = (
    helperSha256: string,
    overrides: Record<string, unknown> = {},
    relayPath = helperPath
  ) => {
    const identity = {
      brokerBuild: '0.1.0',
      brokerTarget: rustTarget,
      helperSha256,
      helperProtocol: 1,
      helperBuild: '0.1.0',
      helperTarget: `${process.platform}-${process.arch}`,
      releaseSigner: null,
      ...overrides,
    };
    return [
      '#!/bin/sh',
      'case "$1" in',
      `  --identity) printf '%s\\n' '${JSON.stringify(identity)}' ;;`,
      `  --stdio) exec '${relayPath}' --stdio ;;`,
      '  *) exit 64 ;;',
      'esac',
    ].join('\n');
  };

  const helperScriptForResponse = (response: unknown) =>
    [
      '#!/bin/sh',
      'IFS= read -r request',
      'test -n "$request" || exit 20',
      `printf '%s\\n' '${JSON.stringify(response)}'`,
    ].join('\n');

  const installHelper = async (script: string) => {
    await writeFile(helperPath, script);
    await chmod(helperPath, 0o755);
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const helperSha256 = createHash('sha256').update(script).digest('hex');
    manifest.tools.find((entry: { name: string }) => entry.name === 'fs-helper').sha256 =
      helperSha256;
    const broker = manifest.tools.find((entry: { name: string }) => entry.name === 'launch-broker');
    const brokerBytes = brokerScript(helperSha256);
    await writeFile(brokerPath, brokerBytes);
    await chmod(brokerPath, 0o755);
    broker.sha256 = createHash('sha256').update(brokerBytes).digest('hex');
    broker.helperSha256 = helperSha256;
    await writeFile(manifestPath, JSON.stringify(manifest));
  };

  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (condition()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for test interposition');
  };

  const fakeHelperProcess = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(() => true),
      pid: 424242,
      exitCode: null,
      signalCode: null,
    });
    return child;
  };

  const runtimeHealth = (
    root = resourcesRoot,
    platform: NodeJS.Platform = process.platform,
    probe: ConstructorParameters<typeof BundledRuntimeHealth>[4] = {}
  ) =>
    new BundledRuntimeHealth(root, platform, process.arch, () => Date.now(), {
      launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
      isPackaged: false,
      ...probe,
    });

  beforeEach(async () => {
    resourcesRoot = await mkdtemp(path.join(tmpdir(), 'meta-mover-runtime-'));
    toolsRoot = path.join(resourcesRoot, 'tools');
    await mkdir(path.join(toolsRoot, 'exiftool', 'lib'), { recursive: true });
    await mkdir(path.join(toolsRoot, 'perl-lib', '00'), { recursive: true });
    helperPath = path.join(
      toolsRoot,
      'fs-helper',
      `${process.platform}-${process.arch}`,
      'meta-mover-fs-helper'
    );
    brokerPath = path.join(
      toolsRoot,
      'launch-broker',
      `${process.platform}-${process.arch}`,
      'meta-mover-launch-broker'
    );
    await mkdir(path.dirname(helperPath), { recursive: true });
    await mkdir(path.dirname(brokerPath), { recursive: true });

    const executables = {
      exiftool: path.join(toolsRoot, 'exiftool', 'exiftool'),
      perl: path.join(toolsRoot, 'perl'),
    };
    await writeFile(executables.exiftool, '#!/bin/sh\necho exiftool-13.59\n');
    await writeFile(executables.perl, '#!/bin/sh\necho exiftool-13.59\n');
    const helperBytes = validHelperScript();
    const helperSha256 = createHash('sha256').update(helperBytes).digest('hex');
    const brokerBytes = brokerScript(helperSha256);
    await writeFile(helperPath, helperBytes);
    await writeFile(brokerPath, brokerBytes);
    const exifSupportContents = 'package Image; 1;';
    await writeFile(path.join(toolsRoot, 'exiftool', 'lib', 'Image.pm'), exifSupportContents);
    await Promise.all(
      [...Object.values(executables), helperPath, brokerPath].map((file) => chmod(file, 0o755))
    );

    const digest = async (file: string) =>
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    await writeFile(
      path.join(toolsRoot, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 3,
        platform: process.platform,
        arch: process.arch,
        tools: [
          {
            name: 'exiftool',
            path: 'exiftool/exiftool',
            version: 'exiftool-13.59',
            sha256: await digest(executables.exiftool),
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
          },
          {
            name: 'fs-helper',
            path: `fs-helper/${process.platform}-${process.arch}/meta-mover-fs-helper`,
            version: '0.1.0',
            sha256: await digest(helperPath),
            target: `${process.platform}-${process.arch}`,
            protocolVersion: 1,
            buildVersion: '0.1.0',
          },
          {
            name: 'launch-broker',
            path: `launch-broker/${process.platform}-${process.arch}/meta-mover-launch-broker`,
            version: '0.1.0',
            sha256: await digest(brokerPath),
            target: `${process.platform}-${process.arch}`,
            rustTarget,
            buildVersion: '0.1.0',
            helperSha256,
            helperProtocolVersion: 1,
            helperBuildVersion: '0.1.0',
            releaseSigner: null,
          },
          {
            name: 'perl',
            path: 'perl',
            version: 'exiftool-13.59',
            sha256: await digest(executables.perl),
          },
        ],
        perlLibs: [
          {
            path: 'perl-lib/00',
            sha256: createHash('sha256').digest('hex'),
            fileCount: 0,
          },
        ],
        runtimeCompatibility: {
          platform: process.platform,
          arch: process.arch,
          nativePlatformOnly: true,
          inspectedTool: 'perl',
          binaryFormat: 'ELF 64-bit test fixture',
          loader: '/lib64/ld-linux-x86-64.so.2',
          sharedLibraries: ['libc.so.6'],
        },
      })
    );
  });

  afterEach(async () => {
    jest
      .mocked(childProcess.spawn)
      .mockImplementation(
        jest.requireActual<typeof import('child_process')>('child_process').spawn
      );
    await rm(resourcesRoot, { recursive: true, force: true });
  });

  it('hashes and executes only manifest-bound tools under application resources', async () => {
    const runtime = runtimeHealth();

    const health = await runtime.getHealth();

    expect(health.ready).toBe(true);
    expect(health.dependencies).toEqual([
      expect.objectContaining({ name: 'exiftool', available: true, source: 'bundled' }),
      expect.objectContaining({ name: 'fs-helper', available: true, source: 'bundled' }),
    ]);
    await expect(runtime.check()).resolves.toEqual({ ready: true, reasons: [] });
    await expect(runtime.paths()).resolves.toMatchObject({
      exiftoolPath: path.join(toolsRoot, 'exiftool', 'exiftool'),
      fsHelperPath: helperPath,
      perlPath: path.join(toolsRoot, 'perl'),
      perlLibraryPaths: [path.join(toolsRoot, 'perl-lib', '00')],
    });
    expect(jest.mocked(childProcess.spawn).mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([['--identity'], ['--stdio']])
    );
    expect(jest.mocked(childProcess.spawn).mock.calls.map((call) => call[0])).not.toContain(
      helperPath
    );
  });

  it('shares the explicit broker trust policy and rejects unconfigured or packaged development launch', async () => {
    let health = await new BundledRuntimeHealth(resourcesRoot).getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/explicit.*trust policy/i),
    });

    health = await new BundledRuntimeHealth(
      resourcesRoot,
      process.platform,
      process.arch,
      () => Date.now(),
      {
        launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
        isPackaged: true,
      }
    ).getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/packaged.*development/i),
    });
  });

  it('fails closed when a binary hash or executable version differs', async () => {
    await writeFile(path.join(toolsRoot, 'exiftool', 'exiftool'), '#!/bin/sh\necho compromised\n');
    await chmod(path.join(toolsRoot, 'exiftool', 'exiftool'), 0o755);

    const health = await runtimeHealth().getHealth();

    expect(health.ready).toBe(false);
    expect(health.dependencies.find((entry) => entry.name === 'exiftool')).toMatchObject({
      available: false,
      error: expect.stringMatching(/digest/i),
    });
  });

  it('requires exactly ExifTool, Perl, fs-helper, and launch-broker on non-Windows', async () => {
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.tools = manifest.tools.filter((entry: { name: string }) => entry.name !== 'fs-helper');
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(runtimeHealth().paths()).rejects.toThrow(
      /exactly.*exiftool.*fs-helper.*launch-broker.*perl/i
    );

    manifest.tools.push({
      name: 'fs-helper',
      path: `fs-helper/${process.platform}-${process.arch}/meta-mover-fs-helper`,
      version: '0.1.0',
      sha256: '0'.repeat(64),
      target: `${process.platform}-${process.arch}`,
      protocolVersion: 1,
      buildVersion: '0.1.0',
    });
    manifest.tools.push({
      name: 'unexpected',
      path: 'unexpected',
      version: '1',
      sha256: '0'.repeat(64),
    });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(runtimeHealth().paths()).rejects.toThrow(/invalid|exactly/i);
  });

  it.each([
    ['wrong package target', (entry: Record<string, unknown>) => (entry.target = 'linux-arm64')],
    ['wrong protocol version', (entry: Record<string, unknown>) => (entry.protocolVersion = 2)],
    ['wrong build version', (entry: Record<string, unknown>) => (entry.buildVersion = '9.9.9')],
    ['wrong helper path', (entry: Record<string, unknown>) => (entry.path = 'fs-helper/wrong')],
  ])('rejects fs-helper manifest metadata: %s', async (_label, mutate) => {
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    mutate(manifest.tools.find((entry: { name: string }) => entry.name === 'fs-helper'));
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(runtimeHealth().paths()).rejects.toThrow(/helper|target/i);
  });

  it('rejects a helper whose bytes no longer match its manifest digest', async () => {
    await writeFile(helperPath, `${validHelperScript()}\n# tampered\n`);
    await chmod(helperPath, 0o755);

    const health = await runtimeHealth().getHealth();

    expect(health.ready).toBe(false);
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/digest/i),
    });
  });

  it('rejects broker tamper, helper-hash unbinding, and compiled identity mismatch', async () => {
    await writeFile(brokerPath, `${brokerScript('f'.repeat(64))}\n# tampered`);
    await chmod(brokerPath, 0o755);
    let health = await runtimeHealth().getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/broker.*digest/i),
    });

    await installHelper(validHelperScript());
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const broker = manifest.tools.find((entry: { name: string }) => entry.name === 'launch-broker');
    broker.helperSha256 = 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(runtimeHealth().paths()).rejects.toThrow(/broker|helper/i);

    await installHelper(validHelperScript());
    const rebound = JSON.parse(await readFile(manifestPath, 'utf8'));
    const reboundBroker = rebound.tools.find(
      (entry: { name: string }) => entry.name === 'launch-broker'
    );
    const identityMismatch = brokerScript(reboundBroker.helperSha256, {
      releaseSigner: 'unexpected signer',
    });
    await writeFile(brokerPath, identityMismatch);
    await chmod(brokerPath, 0o755);
    reboundBroker.sha256 = createHash('sha256').update(identityMismatch).digest('hex');
    await writeFile(manifestPath, JSON.stringify(rebound));
    health = await runtimeHealth().getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/identity|manifest/i),
    });
  });

  it('rejects a non-executable or multiply linked helper binary', async () => {
    await chmod(helperPath, 0o644);
    await expect(runtimeHealth().paths()).rejects.toThrow(/executable/i);

    await chmod(helperPath, 0o755);
    await link(helperPath, path.join(resourcesRoot, 'helper-alias'));
    await expect(runtimeHealth().paths()).rejects.toThrow(/hard.?link|singly/i);
  });

  it.each([
    ['crash', '#!/bin/sh\nexit 9\n', /failed|exit|EOF/i],
    ['malformed output', '#!/bin/sh\nread request\nprintf "not-json\\n"\n', /NDJSON|JSON|output/i],
    ['wrong runtime target', validHelperScript({ target: wrongRustTarget }), /target|manifest/i],
    ['wrong runtime protocol', validHelperScript({ protocol: 2 }), /protocol|manifest/i],
    ['wrong runtime build', validHelperScript({ build: '2.0.0' }), /build|manifest/i],
  ])('fails health when fs-helper hello has %s', async (_label, script, message) => {
    await installHelper(script);

    const health = await runtimeHealth().getHealth();

    expect(health.ready).toBe(false);
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(message),
    });
  });

  it('launches hello with --stdio and a sanitized environment', async () => {
    const script = validHelperScript().replace(
      "'use strict';",
      "'use strict';\nif (process.argv[2] !== '--stdio' || process.env.HOME !== undefined || process.env.PATH !== '') process.exit(22);"
    );
    await installHelper(script);

    await expect(runtimeHealth().paths()).resolves.toMatchObject({
      fsHelperPath: helperPath,
    });
  });

  it('bounds helper execution time and captured output', async () => {
    await installHelper('#!/bin/sh\nwhile :; do :; done\n');
    let health = await runtimeHealth().getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/timed out/i),
    });

    await installHelper(`#!/bin/sh\nprintf '%s\\n' '${'x'.repeat(65_537)}'\n`);
    health = await runtimeHealth().getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/65536|output limit/i),
    });
  }, 12_000);

  it('waits for owned-child termination, escalates, and stops capture before rejecting', async () => {
    const child = fakeHelperProcess();
    const spawn = jest.mocked(childProcess.spawn);
    spawn.mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
    let settled = false;
    const pending = runtimeHealth()
      .paths()
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        settled = true;
      });
    await waitFor(() => spawn.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await waitFor(() => child.kill.mock.calls.length === 2);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.emit('close', null, 'SIGKILL');
    await pending;
  }, 12_000);

  it.each(['stdout', 'stderr'] as const)(
    'turns a helper %s stream error into a controlled health failure',
    async (stream) => {
      const child = fakeHelperProcess();
      const spawn = jest.mocked(childProcess.spawn);
      spawn.mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
      const pending = runtimeHealth().paths();
      await waitFor(() => spawn.mock.calls.length === 1);

      expect(() => child[stream].emit('error', new Error(`${stream} exploded`))).not.toThrow();
      child.emit('close', null, 'SIGTERM');
      await expect(pending).rejects.toThrow(new RegExp(stream, 'i'));
    }
  );

  it.each([
    [
      'missing newline',
      (json: string) => `#!/bin/sh\nread request\nprintf '%s' '${json}'\n`,
      /newline|NDJSON|EOF/i,
    ],
    ['invalid UTF-8', () => "#!/bin/sh\nread request\nprintf '\\377\\n'\n", /UTF-?8/i],
    [
      'unterminated JSON string',
      () => `#!/bin/sh\nread request\nprintf '%s\\n' '{"v":"unterminated'\n`,
      /unterminated/i,
    ],
    [
      'trailing JSON data',
      (json: string) => `#!/bin/sh\nread request\nprintf '%s\\n' '${json} true'\n`,
      /trailing/i,
    ],
    [
      'duplicate JSON key',
      (json: string) =>
        `#!/bin/sh\nread request\nprintf '%s\\n' '${json.replace('"v":1', '"v":1,"v":1')}'\n`,
      /duplicate/i,
    ],
    [
      'excessive JSON depth',
      (json: string) =>
        `#!/bin/sh\nread request\nprintf '%s\\n' '${json.replace(
          '"features":[',
          `"features":${'['.repeat(17)}`
        )}${']'.repeat(16)}'\n`,
      /nesting|depth/i,
    ],
    [
      'excessive array length',
      (json: string) => {
        const response = JSON.parse(json);
        response.result.features = Array.from({ length: 257 }, () => 'sha256');
        return helperScriptForResponse(response);
      },
      /array.*limit|256/i,
    ],
  ])('rejects hello framing attack: %s', async (_label, scriptFor, message) => {
    const response = JSON.stringify({
      v: 1,
      id: '00000000-0000-4000-8000-000000000001',
      ok: true,
      result: {
        outcome: 'applied',
        protocol: 1,
        build: '0.1.0',
        target: rustTarget,
        features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
      },
    });
    await installHelper(scriptFor(response));

    const health = await runtimeHealth().getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(message),
    });
  });

  it('accepts a newline-terminated hello at the exact 65,536-byte protocol boundary', async () => {
    const response = JSON.stringify({
      v: 1,
      id: '00000000-0000-4000-8000-000000000001',
      ok: true,
      result: {
        outcome: 'applied',
        protocol: 1,
        build: '0.1.0',
        target: rustTarget,
        features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
      },
    });
    const paddingLength = 65_535 - Buffer.byteLength(response);
    await installHelper(validHelperScript({ helloPadding: paddingLength }));

    await expect(runtimeHealth().paths()).resolves.toMatchObject({
      fsHelperPath: helperPath,
    });
  });

  it('rejects multiple hello response records', async () => {
    const response = {
      v: 1,
      id: '00000000-0000-4000-8000-000000000001',
      ok: true,
      result: {
        outcome: 'applied',
        protocol: 1,
        build: '0.1.0',
        target: rustTarget,
        features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
      },
    };
    await installHelper(
      `#!/bin/sh\nread request\nprintf '%s\\n%s\\n' '${JSON.stringify(response)}' '${JSON.stringify(
        response
      )}'\n`
    );

    const health = await runtimeHealth().getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/NDJSON|output|unsolicited/i),
    });
  });

  it.each([
    [
      'unknown root field',
      {
        v: 1,
        id: '00000000-0000-4000-8000-000000000001',
        ok: true,
        result: {
          outcome: 'applied',
          protocol: 1,
          build: '0.1.0',
          target: rustTarget,
          features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
        },
        extra: true,
      },
    ],
    [
      'wrong response id',
      {
        v: 1,
        id: '00000000-0000-4000-8000-000000000099',
        ok: true,
        result: {
          outcome: 'applied',
          protocol: 1,
          build: '0.1.0',
          target: rustTarget,
          features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
        },
      },
    ],
    [
      'non-string feature',
      {
        v: 1,
        id: '00000000-0000-4000-8000-000000000001',
        ok: true,
        result: {
          outcome: 'applied',
          protocol: 1,
          build: '0.1.0',
          target: rustTarget,
          features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 1],
        },
      },
    ],
    [
      'incomplete feature set',
      {
        v: 1,
        id: '00000000-0000-4000-8000-000000000001',
        ok: true,
        result: {
          outcome: 'applied',
          protocol: 1,
          build: '0.1.0',
          target: rustTarget,
          features: ['capability-relative'],
        },
      },
    ],
    [
      'duplicated required feature',
      {
        v: 1,
        id: '00000000-0000-4000-8000-000000000001',
        ok: true,
        result: {
          outcome: 'applied',
          protocol: 1,
          build: '0.1.0',
          target: rustTarget,
          features: [
            'capability-relative',
            'no-follow',
            'no-replace',
            'sha256',
            'durable-sync',
            'sha256',
          ],
        },
      },
    ],
  ])('rejects malformed helper response: %s', async (_label, response) => {
    await installHelper(helperScriptForResponse(response));

    const health = await runtimeHealth().getHealth();
    expect(health.dependencies.find((entry) => entry.name === 'fs-helper')).toMatchObject({
      available: false,
      error: expect.stringMatching(/fields|malformed|feature|unknown keys|request ID|manifest/i),
    });
  });

  it('uses the staged Windows inventory and helper target contract without bundled Perl', async () => {
    const windowsRustTarget =
      process.arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : process.arch === 'ia32'
          ? 'i686-pc-windows-msvc'
          : 'x86_64-pc-windows-msvc';
    const windowsHelperPath = path.join(
      toolsRoot,
      'fs-helper',
      `win32-${process.arch}`,
      'meta-mover-fs-helper.exe'
    );
    const windowsBrokerPath = path.join(
      toolsRoot,
      'launch-broker',
      `win32-${process.arch}`,
      'meta-mover-launch-broker.exe'
    );
    const windowsHelper = validHelperScript({
      target: windowsRustTarget,
      identityKind: 'windows',
    });
    await mkdir(path.dirname(windowsHelperPath), { recursive: true });
    await mkdir(path.dirname(windowsBrokerPath), { recursive: true });
    await writeFile(windowsHelperPath, windowsHelper);
    await chmod(windowsHelperPath, 0o755);
    const windowsHelperSha256 = createHash('sha256').update(windowsHelper).digest('hex');
    const windowsBroker = brokerScript(
      windowsHelperSha256,
      {
        brokerTarget: windowsRustTarget,
        helperTarget: `win32-${process.arch}`,
      },
      windowsHelperPath
    );
    await writeFile(windowsBrokerPath, windowsBroker);
    await chmod(windowsBrokerPath, 0o755);

    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.platform = 'win32';
    manifest.tools = manifest.tools.filter((entry: { name: string }) => entry.name !== 'perl');
    delete manifest.perlLibs;
    delete manifest.tools.find((entry: { name: string }) => entry.name === 'exiftool')
      .supportDirectory;
    const helper = manifest.tools.find((entry: { name: string }) => entry.name === 'fs-helper');
    helper.path = `fs-helper/win32-${process.arch}/meta-mover-fs-helper.exe`;
    helper.target = `win32-${process.arch}`;
    helper.sha256 = windowsHelperSha256;
    const broker = manifest.tools.find((entry: { name: string }) => entry.name === 'launch-broker');
    broker.path = `launch-broker/win32-${process.arch}/meta-mover-launch-broker.exe`;
    broker.sha256 = createHash('sha256').update(windowsBroker).digest('hex');
    broker.target = `win32-${process.arch}`;
    broker.rustTarget = windowsRustTarget;
    broker.helperSha256 = windowsHelperSha256;
    manifest.runtimeCompatibility = {
      platform: 'win32',
      arch: process.arch,
      nativePlatformOnly: true,
      inspectedTool: 'exiftool',
      binaryFormat: 'PE32+ test fixture',
      loader: 'Windows PE loader',
      sharedLibraries: ['KERNEL32.dll'],
    };
    await writeFile(manifestPath, JSON.stringify(manifest));

    const launchLeaseProvider: VerifiedHelperLaunchLeaseProvider = {
      acquire: async (descriptor) => ({
        mechanism: 'authenticated-package',
        executablePath: descriptor.canonicalPath,
        authority: 'test:windows-package-boundary',
        release: async () => undefined,
      }),
    };

    await expect(
      runtimeHealth(resourcesRoot, 'win32', {
        launchTrustPolicy: developmentBrokerLaunchTrustPolicy(launchLeaseProvider),
      }).verified()
    ).resolves.toMatchObject({
      paths: {
        exiftoolPath: path.join(toolsRoot, 'exiftool', 'exiftool'),
        fsHelperPath: windowsHelperPath,
        launchBrokerPath: windowsBrokerPath,
        perlLibraryPaths: [],
      },
      versions: { exiftool: 'exiftool-13.59', 'fs-helper': '0.1.0' },
    });
  });

  it('rejects duplicate and unknown manifest schema keys', async () => {
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const raw = await readFile(manifestPath, 'utf8');
    await writeFile(
      manifestPath,
      raw.replace('"schemaVersion":3', '"schemaVersion":3,"schemaVersion":3')
    );
    await expect(runtimeHealth().paths()).rejects.toThrow(/duplicate/i);

    const manifest = JSON.parse(raw);
    for (const unknownValue of [false, null, {}, [], 'escaped\nvalue']) {
      manifest.unknown = unknownValue;
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(runtimeHealth().paths()).rejects.toThrow(/unknown.*key/i);
    }

    delete manifest.unknown;
    manifest.tools.find((entry: { name: string }) => entry.name === 'fs-helper').unknown = true;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(runtimeHealth().paths()).rejects.toThrow(/unknown.*key/i);
  });

  it('rejects special filesystem entries inside hashed support directories', async () => {
    if (process.platform === 'win32') return;
    const fifoPath = path.join(toolsRoot, 'exiftool', 'lib', 'special.fifo');
    childProcess.execFileSync('mkfifo', [fifoPath]);

    await expect(runtimeHealth().paths()).rejects.toThrow(/special|regular.*entry/i);
  });

  it('rejects manifest paths and Perl library roots that escape resources', async () => {
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.tools[0].path = '../../host-exiftool';
    manifest.perlLibs[0].path = '../../host-perl';
    await writeFile(manifestPath, JSON.stringify(manifest));

    const runtime = runtimeHealth();

    await expect(runtime.paths()).rejects.toThrow(/escapes|outside/i);
    expect((await runtime.getHealth()).ready).toBe(false);
  });

  it('rejects a manifest for another platform or architecture', async () => {
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.platform = process.platform === 'linux' ? 'darwin' : 'linux';
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(runtimeHealth().paths()).rejects.toThrow(/platform/i);
  });

  it('rejects a symlinked tools root even when every escaped tool matches the manifest', async () => {
    const escapedTools = path.join(resourcesRoot, 'host-tools');
    await rename(toolsRoot, escapedTools);
    await symlink(escapedTools, toolsRoot);

    await expect(runtimeHealth().paths()).rejects.toThrow(/tools root|symbolic/i);
  });

  it('rejects hard-linked executable files', async () => {
    await link(
      path.join(toolsRoot, 'exiftool', 'exiftool'),
      path.join(resourcesRoot, 'host-exiftool')
    );

    await expect(runtimeHealth().paths()).rejects.toThrow(/hard.?link|singly/i);
  });

  it('verifies Perl library file count and digest before returning runtime paths', async () => {
    await writeFile(path.join(toolsRoot, 'perl-lib', '00', 'Injected.pm'), 'package Injected; 1;');

    await expect(runtimeHealth().paths()).rejects.toThrow(/Perl library digest/i);
  });

  it.each([
    [
      'duplicate tool',
      (manifest: Record<string, unknown>) => {
        const tools = manifest.tools as unknown[];
        tools.push(tools[0]);
      },
    ],
    [
      'missing Perl libraries',
      (manifest: Record<string, unknown>) => {
        manifest.perlLibs = [];
      },
    ],
    [
      'invalid architecture',
      (manifest: Record<string, unknown>) => {
        manifest.arch = 'not-this-architecture';
      },
    ],
    [
      'missing runtime compatibility evidence',
      (manifest: Record<string, unknown>) => {
        delete manifest.runtimeCompatibility;
      },
    ],
    [
      'absolute ExifTool support path',
      (manifest: Record<string, unknown>) => {
        const tools = manifest.tools as Array<Record<string, unknown>>;
        (tools[0].supportDirectory as Record<string, unknown>).path = '/host/exiftool/lib';
      },
    ],
    [
      'invalid ExifTool support digest',
      (manifest: Record<string, unknown>) => {
        const tools = manifest.tools as Array<Record<string, unknown>>;
        (tools[0].supportDirectory as Record<string, unknown>).sha256 = 'not-a-digest';
      },
    ],
    [
      'empty ExifTool support tree',
      (manifest: Record<string, unknown>) => {
        const tools = manifest.tools as Array<Record<string, unknown>>;
        (tools[0].supportDirectory as Record<string, unknown>).fileCount = 0;
      },
    ],
    [
      'invalid tool version',
      (manifest: Record<string, unknown>) => {
        const tools = manifest.tools as Array<Record<string, unknown>>;
        tools[0].version = 13.59;
      },
    ],
    [
      'invalid tool digest',
      (manifest: Record<string, unknown>) => {
        const tools = manifest.tools as Array<Record<string, unknown>>;
        tools[0].sha256 = 'not-a-digest';
      },
    ],
    [
      'non-native compatibility marker',
      (manifest: Record<string, unknown>) => {
        (manifest.runtimeCompatibility as Record<string, unknown>).nativePlatformOnly = false;
      },
    ],
    [
      'missing compatibility loader',
      (manifest: Record<string, unknown>) => {
        (manifest.runtimeCompatibility as Record<string, unknown>).loader = '';
      },
    ],
    [
      'invalid shared-library evidence',
      (manifest: Record<string, unknown>) => {
        (manifest.runtimeCompatibility as Record<string, unknown>).sharedLibraries = [42];
      },
    ],
  ])('rejects malformed runtime manifests: %s', async (_label, mutate) => {
    const manifestPath = path.join(toolsRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    mutate(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(runtimeHealth().paths()).rejects.toThrow();
  });
});
