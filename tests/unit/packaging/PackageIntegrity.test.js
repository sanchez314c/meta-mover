const fs = require('fs');
const childProcess = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const {
  assertPackageConfig,
  findForbiddenRuntimeReferences,
  findMissingNativeAbiReferencesInAsar,
  findUpdaterArtifacts,
  findPythonArtifactsInAsar,
  hashDirectory,
  inspectPortableExecutable,
  verifyToolResources,
} = require('../../../scripts/package-integrity-lib');
const {
  assertNativeBuildContext,
  stageBundledTools,
} = require('../../../scripts/stage-bundled-tools');
const {
  assertLinuxStaticExecutable,
  probeFilesystemHelper,
} = require('../../../scripts/build-native-helper');
const { BundledRuntimeHealth } = require('../../../src/main/tools/BundledRuntimeHealth');
const {
  developmentBrokerLaunchTrustPolicy,
} = require('../../../src/main/native/NativeFilesystemHelperClient');

const runtimeHealth = (resourcesRoot) =>
  new BundledRuntimeHealth(resourcesRoot, process.platform, process.arch, undefined, {
    launchTrustPolicy: developmentBrokerLaunchTrustPolicy(),
    isPackaged: false,
  });

describe('packaged runtime containment', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-mover-package-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('requires tools as application resources and rejects Python packaging', () => {
    const valid = {
      scripts: {
        build:
          'npm run clean:dist && npm run build:main && npm run build:preload && npm run build:renderer',
        'build:dev':
          'npm run clean:dist && npm run build:main:dev && npm run build:preload:dev && npm run build:renderer:dev',
      },
      build: {
        asar: true,
        publish: null,
        forceCodeSigning: true,
        files: ['dist/**/*', '!**/*.py', '!**/*.pyc', '!**/*.pyo'],
        extraResources: [{ from: '.build-tools/tools', to: 'tools', filter: ['**/*'] }],
        linux: {
          target: [
            { target: 'deb', arch: ['x64'] },
            { target: 'rpm', arch: ['x64'] },
          ],
        },
        mac: {
          notarize: true,
          target: [{ target: 'pkg', arch: ['x64', 'arm64'] }],
        },
        pkg: {
          allowAnywhere: false,
          allowCurrentUserHome: false,
          allowRootDirectory: true,
          installLocation: '/Applications',
        },
        win: {
          target: [{ target: 'nsis', arch: ['x64', 'arm64'] }],
          signAndEditExecutable: true,
          signExecutable: true,
          signExts: ['.dll'],
          verifyUpdateCodeSignature: true,
        },
        nsis: {
          perMachine: true,
          allowElevation: true,
          allowToChangeInstallationDirectory: false,
        },
      },
    };
    expect(() => assertPackageConfig(valid)).not.toThrow();
    expect(() =>
      assertPackageConfig({
        ...valid,
        build: { ...valid.build, extraFiles: [{ from: 'scripts', to: 'scripts' }] },
      })
    ).toThrow(/Python or scripts/i);
    expect(() =>
      assertPackageConfig({ ...valid, build: { ...valid.build, files: ['dist/**/*', '**/*.py'] } })
    ).toThrow(/Python or scripts/i);
    expect(() =>
      assertPackageConfig({ ...valid, build: { ...valid.build, files: ['**/*'] } })
    ).toThrow(/allow only production bundles/i);
    expect(() => assertPackageConfig({ ...valid, dependencies: { sqlite3: '5.1.7' } })).toThrow(
      /sqlite3/i
    );
    expect(() =>
      assertPackageConfig({
        ...valid,
        dependencies: { '@ffmpeg-installer/ffmpeg': '1.1.0' },
      })
    ).toThrow(/ffmpeg/i);
  });

  test('rejects updater manifests and blockmaps from final package contents', () => {
    const release = path.join(root, 'release');
    fs.mkdirSync(path.join(release, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(release, 'resources', 'app-update.yml'), 'provider: github');
    fs.writeFileSync(path.join(release, 'latest-linux.yml'), 'version: 1.0.0');
    fs.writeFileSync(path.join(release, 'meta.blockmap'), 'blockmap');
    expect(findUpdaterArtifacts(release).map((file) => path.basename(file)).sort()).toEqual([
      'app-update.yml',
      'latest-linux.yml',
      'meta.blockmap',
    ]);
  });

  test('detects Python artifacts inside the actual ASAR payload', async () => {
    const source = path.join(root, 'asar-source');
    const archive = path.join(root, 'app.asar');
    fs.mkdirSync(path.join(source, 'node_modules', 'native-build'), { recursive: true });
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = true;');
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { sqlite3: '5.1.7' } })
    );
    fs.writeFileSync(path.join(source, 'node_modules', 'native-build', 'gyp.py'), 'print("bad")');
    childProcess.execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { createPackage } from '@electron/asar'; await createPackage(process.argv[1], process.argv[2]);",
      source,
      archive,
    ]);

    expect(findPythonArtifactsInAsar(archive)).toEqual(['/node_modules/native-build/gyp.py']);
    expect(findMissingNativeAbiReferencesInAsar(archive)).toEqual(['sqlite3']);
  });

  test('rejects Python, PATH tools, and direct dependency binary resolution', () => {
    const source = path.join(root, 'src');
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, 'bad.js'),
      [
        "spawn('python3', args)",
        "spawn('ffmpeg', args)",
        "require('ffprobe-static')",
        "require('sqlite3')",
        "'media_organizer.py'",
      ].join('\n')
    );
    const failures = findForbiddenRuntimeReferences(source);
    expect(failures.map((failure) => failure.rule)).toEqual(
      expect.arrayContaining([
        'python-runtime',
        'host-tool',
        'dependency-binary',
        'native-sqlite',
        'python-artifact',
      ])
    );

    fs.writeFileSync(
      path.join(source, 'good.js'),
      "const tool = path.join(process.resourcesPath, 'tools', 'ffmpeg')"
    );
    expect(findForbiddenRuntimeReferences(path.join(source, 'good.js'))).toEqual([]);
  });

  test('does not treat dependency names inside bundled comments as executable imports', () => {
    const source = path.join(root, 'comments');
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, 'documentation.js'),
      ['/**', ' * import { exiftool } from "exiftool-vendored";', ' */'].join('\n')
    );
    expect(findForbiddenRuntimeReferences(source)).toEqual([]);

    fs.writeFileSync(
      path.join(source, 'executable-import.js'),
      'import { exiftool } from "exiftool-vendored";'
    );
    expect(findForbiddenRuntimeReferences(source)).toEqual([
      expect.objectContaining({ rule: 'dependency-binary' }),
    ]);
  });

  test('inspects Windows PE architecture and imported DLL evidence without host tools', async () => {
    const executable = path.join(root, 'fixture.exe');
    const bytes = Buffer.alloc(512);
    bytes.write('MZ', 0, 'ascii');
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write('PE\0\0', 0x80, 'binary');
    bytes.writeUInt16LE(0x8664, 0x84);
    bytes.writeUInt16LE(0x20b, 0x98);
    bytes.write('KERNEL32.dll\0USER32.dll\0', 0x120, 'ascii');
    fs.writeFileSync(executable, bytes);

    await expect(inspectPortableExecutable(executable, 'x64')).resolves.toMatchObject({
      platform: 'win32',
      arch: 'x64',
      nativePlatformOnly: true,
      binaryFormat: 'PE32+ x86-64',
      loader: 'Windows PE loader',
      sharedLibraries: ['KERNEL32.dll', 'USER32.dll'],
    });
    await expect(inspectPortableExecutable(executable, 'arm64')).rejects.toThrow(/architecture/i);
  });

  test('rejects a Linux helper that carries a dynamic interpreter', async () => {
    const executable = path.join(root, 'helper');
    const bytes = Buffer.alloc(128);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, 64);
    fs.writeFileSync(executable, bytes);
    await expect(assertLinuxStaticExecutable(executable)).resolves.toBeUndefined();
    bytes.writeUInt32LE(3, 64);
    fs.writeFileSync(executable, bytes);
    await expect(assertLinuxStaticExecutable(executable)).rejects.toThrow(/dynamic interpreter/i);
  });

  test.each([
    [
      'missing newline, unknown key, and extra reordered feature',
      `${JSON.stringify({
        v: 1,
        id: '00000000-0000-4000-8000-000000000001',
        ok: true,
        unknown: true,
        result: {
          outcome: 'applied',
          protocol: 1,
          build: '0.1.0',
          target:
            process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu',
          features: [
            'sha256',
            'capability-relative',
            'no-follow',
            'no-replace',
            'durable-sync',
            'extra',
          ],
        },
      })}`,
    ],
    [
      'duplicate key',
      '{"v":1,"v":1,"id":"00000000-0000-4000-8000-000000000001","ok":true,"result":{"outcome":"applied","protocol":1,"build":"0.1.0","target":"x86_64-unknown-linux-gnu","features":["capability-relative","no-follow","no-replace","sha256","durable-sync"]}}\n',
    ],
    ['invalid UTF-8', null],
  ])('rejects helper probe framing corruption: %s', async (_label, output) => {
    const helper = path.join(root, 'probe-helper');
    const script =
      output === null
        ? "#!/bin/sh\nread request\nprintf '\\377\\n'\n"
        : `#!/bin/sh\nread request\nprintf '%s' '${output}'\n`;
    fs.writeFileSync(helper, script, { mode: 0o755 });

    await expect(probeFilesystemHelper(helper)).rejects.toThrow(
      /NDJSON|UTF-?8|duplicate|unknown|feature|protocol/i
    );
  });

  test('rejects special entries instead of omitting them from package hashes', async () => {
    if (process.platform === 'win32') return;
    const directory = path.join(root, 'support');
    fs.mkdirSync(directory);
    childProcess.execFileSync('mkfifo', [path.join(directory, 'special.fifo')]);

    await expect(hashDirectory(directory)).rejects.toThrow(/special|regular.*entry/i);
  });

  test('stages ExifTool, Perl, helper, and launch broker with target-bound evidence', async () => {
    const dependencies = path.join(root, 'dependencies');
    const exifDirectory = path.join(dependencies, 'exiftool');
    const perlInc = path.join(dependencies, 'perl-inc');
    const output = path.join(root, 'resources', 'tools');
    fs.mkdirSync(path.join(exifDirectory, 'lib'), { recursive: true });
    fs.mkdirSync(perlInc, { recursive: true });
    const sources = {
      exiftool: path.join(exifDirectory, 'exiftool'),
      perl: path.join(dependencies, 'perl'),
      fsHelper: path.join(dependencies, 'meta-mover-fs-helper'),
      launchBroker: path.join(dependencies, 'meta-mover-launch-broker'),
    };
    for (const sourcePath of [sources.exiftool, sources.perl]) {
      fs.writeFileSync(sourcePath, '#!/bin/sh\necho test-version\n', { mode: 0o755 });
    }
    const helperRustTarget =
      process.platform === 'linux'
        ? `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-unknown-linux-gnu`
        : process.platform === 'darwin'
          ? `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-apple-darwin`
          : `${process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : 'i686'}-pc-windows-msvc`;
    fs.writeFileSync(
      sources.fsHelper,
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
        `    if (request.op === 'hello') result = ${JSON.stringify({
          outcome: 'applied',
          protocol: 1,
          build: 'test-version',
          target: helperRustTarget,
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
      ].join('\n'),
      { mode: 0o755 }
    );
    const helperSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(sources.fsHelper))
      .digest('hex');
    const stagedHelperPath = path.join(
      output,
      'fs-helper',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'meta-mover-fs-helper.exe' : 'meta-mover-fs-helper'
    );
    fs.writeFileSync(
      sources.launchBroker,
      [
        '#!/bin/sh',
        'case "$1" in',
        `  --identity) printf '%s\\n' '${JSON.stringify({
          brokerBuild: '0.1.0',
          brokerTarget: helperRustTarget,
          helperSha256,
          helperProtocol: 1,
          helperBuild: 'test-version',
          helperTarget: `${process.platform}-${process.arch}`,
          releaseSigner: null,
        })}' ;;`,
        `  --stdio) exec '${stagedHelperPath}' --stdio ;;`,
        '  *) exit 64 ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(exifDirectory, 'lib', 'Image.pm'), 'package Image;');
    fs.writeFileSync(path.join(perlInc, 'strict.pm'), 'package strict;');
    fs.writeFileSync(path.join(perlInc, 'Zed.pm'), 'package Zed;');
    fs.writeFileSync(path.join(perlInc, 'alpha.pm'), 'package alpha;');

    const perlProbe = async (probeRoot) => ({
      version: 'test-version',
      loadedModules: [path.join(probeRoot, 'perl-lib', '00', 'strict.pm')],
    });
    const runtimeCompatibility = {
      platform: process.platform,
      arch: process.arch,
      nativePlatformOnly: true,
      inspectedTool: 'perl',
      binaryFormat: 'ELF 64-bit test fixture',
      loader: '/lib64/ld-linux-x86-64.so.2',
      sharedLibraries: ['libc.so.6'],
    };
    const runtimeInspector = async () => runtimeCompatibility;
    const fsHelperProbe = async () => ({
      protocol: 1,
      build: 'test-version',
      target: helperRustTarget,
      features: ['capability-relative', 'no-follow', 'no-replace', 'sha256', 'durable-sync'],
    });
    const launchBrokerIdentityProbe = async () => ({
      brokerBuild: '0.1.0',
      brokerTarget: helperRustTarget,
      helperSha256,
      helperProtocol: 1,
      helperBuild: 'test-version',
      helperTarget: `${process.platform}-${process.arch}`,
      releaseSigner: null,
    });
    const launchBrokerRelayProbe = async (executablePath) => {
      expect(executablePath.split(path.sep).slice(-4)).toEqual([
        'tools',
        'launch-broker',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'meta-mover-launch-broker.exe' : 'meta-mover-launch-broker',
      ]);
      return fsHelperProbe();
    };
    const linuxStaticInspector = async () => undefined;
    const verificationOptions = {
      platform: process.platform,
      perlProbe,
      runtimeInspector,
      fsHelperProbe,
      launchBrokerIdentityProbe,
      launchBrokerRelayProbe,
      linuxStaticInspector,
    };
    await stageBundledTools({
      output,
      sources,
      perlInc: [perlInc],
      perlProbe,
      platform: process.platform,
      arch: process.arch,
      runtimeInspector,
      fsHelperProbe,
      launchBrokerIdentityProbe,
      launchBrokerRelayProbe,
      linuxStaticInspector,
    });

    expect(fs.existsSync(path.join(output, 'exiftool', 'lib', 'Image.pm'))).toBe(true);
    const bundledStrict = path.join(output, 'perl-lib', '00', 'strict.pm');
    await expect(verifyToolResources(output, verificationOptions)).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'exiftool' }),
        expect.objectContaining({ name: 'perl' }),
        expect.objectContaining({
          name: 'launch-broker',
          target: `${process.platform}-${process.arch}`,
          helperSha256,
          helperProtocolVersion: 1,
          helperBuildVersion: 'test-version',
          releaseSigner: null,
        }),
        expect.objectContaining({
          name: 'fs-helper',
          target: `${process.platform}-${process.arch}`,
          protocolVersion: 1,
          buildVersion: 'test-version',
        }),
      ]),
      runtimeCompatibility,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    for (const tool of manifest.tools) {
      expect(tool.version).toBe(tool.name === 'launch-broker' ? '0.1.0' : 'test-version');
      expect(tool.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(manifest.perlLibs).toEqual([
      expect.objectContaining({
        path: 'perl-lib/00',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(manifest.schemaVersion).toBe(3);
    await expect(runtimeHealth(path.dirname(output)).getHealth()).resolves.toMatchObject({
      ready: true,
    });

    const manifestPath = path.join(output, 'manifest.json');
    const exactManifest = fs.readFileSync(manifestPath, 'utf8');
    fs.writeFileSync(manifestPath, exactManifest.replace('{', '{"schemaVersion":3,'));
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(/duplicate/i);
    fs.writeFileSync(manifestPath, exactManifest);

    const unknownNestedManifest = JSON.parse(exactManifest);
    unknownNestedManifest.tools.find((tool) => tool.name === 'fs-helper').unknown = true;
    fs.writeFileSync(manifestPath, JSON.stringify(unknownNestedManifest));
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(/unknown/i);
    fs.writeFileSync(manifestPath, exactManifest);
    for (const mutate of [
      (value) => {
        value.tools.find((tool) => tool.name === 'exiftool').unknown = true;
      },
      (value) => {
        value.tools.find((tool) => tool.name === 'exiftool').supportDirectory.unknown = true;
      },
      (value) => {
        value.tools.find((tool) => tool.name === 'perl').unknown = true;
      },
      (value) => {
        value.perlLibs[0].unknown = true;
      },
      (value) => {
        value.runtimeCompatibility.unknown = true;
      },
    ]) {
      const unknownRecord = JSON.parse(exactManifest);
      mutate(unknownRecord);
      fs.writeFileSync(manifestPath, JSON.stringify(unknownRecord));
      await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(/unknown/i);
    }
    fs.writeFileSync(manifestPath, exactManifest);

    const bundledHelper = path.join(
      output,
      'fs-helper',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'meta-mover-fs-helper.exe' : 'meta-mover-fs-helper'
    );
    const originalHelper = fs.readFileSync(bundledHelper);
    fs.appendFileSync(bundledHelper, 'tampered');
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /fs-helper.*SHA-256|digest/i
    );
    fs.writeFileSync(bundledHelper, originalHelper, { mode: 0o755 });

    const helperManifestPath = path.join(output, 'manifest.json');
    const wrongTargetManifest = JSON.parse(fs.readFileSync(helperManifestPath, 'utf8'));
    wrongTargetManifest.tools.find((tool) => tool.name === 'fs-helper').target =
      process.platform === 'linux' ? 'darwin-x64' : 'linux-x64';
    fs.writeFileSync(helperManifestPath, JSON.stringify(wrongTargetManifest));
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /filesystem helper manifest/i
    );
    wrongTargetManifest.tools.find((tool) => tool.name === 'fs-helper').target =
      `${process.platform}-${process.arch}`;
    fs.writeFileSync(helperManifestPath, JSON.stringify(wrongTargetManifest));

    const bundledBroker = path.join(
      output,
      'launch-broker',
      `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'meta-mover-launch-broker.exe' : 'meta-mover-launch-broker'
    );
    const originalBroker = fs.readFileSync(bundledBroker);
    fs.appendFileSync(bundledBroker, 'tampered');
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /launch-broker.*SHA-256|digest/i
    );
    fs.writeFileSync(bundledBroker, originalBroker, { mode: 0o755 });

    const wrongBrokerManifest = JSON.parse(fs.readFileSync(helperManifestPath, 'utf8'));
    wrongBrokerManifest.tools.find((tool) => tool.name === 'launch-broker').helperSha256 =
      'b'.repeat(64);
    fs.writeFileSync(helperManifestPath, JSON.stringify(wrongBrokerManifest));
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /launch broker manifest/i
    );
    wrongBrokerManifest.tools.find((tool) => tool.name === 'launch-broker').helperSha256 =
      helperSha256;
    fs.writeFileSync(helperManifestPath, JSON.stringify(wrongBrokerManifest));

    const bundledExifModule = path.join(output, 'exiftool', 'lib', 'Image.pm');
    fs.appendFileSync(bundledExifModule, 'tampered');
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /ExifTool|support|digest/i
    );
    await expect(runtimeHealth(path.dirname(output)).getHealth()).resolves.toMatchObject({
      ready: false,
    });
    fs.writeFileSync(bundledExifModule, 'package Image;');

    const redirectedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const originalSupport = redirectedManifest.tools.find(
      (tool) => tool.name === 'exiftool'
    ).supportDirectory;
    redirectedManifest.tools.find((tool) => tool.name === 'exiftool').supportDirectory =
      redirectedManifest.perlLibs[0];
    fs.writeFileSync(manifestPath, JSON.stringify(redirectedManifest));
    fs.appendFileSync(bundledExifModule, 'redirect-bypass');
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /ExifTool support directory|expected/i
    );
    await expect(runtimeHealth(path.dirname(output)).getHealth()).resolves.toMatchObject({
      ready: false,
    });
    redirectedManifest.tools.find((tool) => tool.name === 'exiftool').supportDirectory =
      originalSupport;
    fs.writeFileSync(manifestPath, JSON.stringify(redirectedManifest));
    fs.writeFileSync(bundledExifModule, 'package Image;');

    const bundledExifLauncher = path.join(output, 'exiftool', 'exiftool');
    const realExifLauncher = path.join(output, 'exiftool', 'exiftool.real');
    fs.renameSync(bundledExifLauncher, realExifLauncher);
    fs.symlinkSync('exiftool.real', bundledExifLauncher);
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /symbolic|symlink/i
    );
    fs.unlinkSync(bundledExifLauncher);
    fs.renameSync(realExifLauncher, bundledExifLauncher);

    await expect(
      verifyToolResources(output, {
        ...verificationOptions,
        perlProbe: async () => ({
          version: 'test-version',
          loadedModules: ['/usr/share/perl/strict.pm'],
        }),
      })
    ).rejects.toThrow(/outside bundled Perl roots/i);

    fs.appendFileSync(bundledStrict, 'tampered');
    await expect(verifyToolResources(output, verificationOptions)).rejects.toThrow(
      /Perl library digest does not match/i
    );
  });

  test('rejects cross-platform and cross-architecture package targets before staging', () => {
    const otherPlatform = process.platform === 'linux' ? 'darwin' : 'linux';
    const otherArch = process.arch === 'x64' ? 'arm64' : 'x64';

    expect(() =>
      assertNativeBuildContext({ electronPlatformName: otherPlatform, arch: process.arch })
    ).toThrow(/native target/i);
    expect(() =>
      assertNativeBuildContext({ electronPlatformName: process.platform, arch: otherArch })
    ).toThrow(/native target/i);
    expect(() =>
      assertNativeBuildContext({ electronPlatformName: process.platform, arch: process.arch })
    ).not.toThrow();
  });

  test('requires a native portable Perl root on macOS instead of falling back to host Perl', async () => {
    const macRoot = path.join(root, 'darwin-x64');
    const sources = require('../../../scripts/stage-bundled-tools').portablePerlSources(
      'darwin',
      'x64',
      macRoot
    );
    expect(sources).toEqual({
      perl: path.join(macRoot, 'perl'),
      perlLibRoots: [path.join(macRoot, 'lib')],
    });
    expect(() =>
      require('../../../scripts/stage-bundled-tools').portablePerlSources(
        'darwin',
        'arm64',
        macRoot
      )
    ).toThrow(/target/i);
  });

  test('pins the macOS Perl source and derives only native target output', () => {
    const { portablePerlBuildPlan } = require('../../../scripts/build-portable-perl');
    expect(portablePerlBuildPlan('darwin', 'arm64')).toMatchObject({
      version: '5.42.3',
      sha256: '1137740985837b5cdf15f0cfab932279dcb4352f912fed6fc144e8b4f0823627',
      target: 'darwin-arm64',
      output: expect.stringMatching(/native\/perl\/darwin-arm64$/),
    });
    expect(() => portablePerlBuildPlan('win32', 'x64')).toThrow(/Linux\/macOS/i);
  });

  test('fails when a staged tool is missing, non-executable, or escapes resources', async () => {
    const tools = path.join(root, 'tools');
    fs.mkdirSync(tools);
    fs.writeFileSync(
      path.join(tools, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 3,
        platform: 'linux',
        arch: 'x64',
        tools: [
          { name: 'exiftool', path: 'missing' },
          {
            name: 'fs-helper',
            path: 'fs-helper/linux-x64/meta-mover-fs-helper',
            version: '0.1.0',
            sha256: '0'.repeat(64),
            target: 'linux-x64',
            protocolVersion: 1,
            buildVersion: '0.1.0',
          },
          {
            name: 'launch-broker',
            path: 'launch-broker/linux-x64/meta-mover-launch-broker',
            version: '0.1.0',
            sha256: '0'.repeat(64),
            target: 'linux-x64',
            rustTarget: 'x86_64-unknown-linux-musl',
            buildVersion: '0.1.0',
            helperSha256: '0'.repeat(64),
            helperProtocolVersion: 1,
            helperBuildVersion: '0.1.0',
            releaseSigner: null,
          },
          { name: 'perl', path: 'perl' },
        ],
        runtimeCompatibility: {},
      })
    );
    fs.writeFileSync(path.join(tools, 'perl'), 'binary', { mode: 0o644 });

    await expect(verifyToolResources(tools, { platform: 'linux' })).rejects.toThrow(
      /missing|escapes|executable/i
    );
  });
});
