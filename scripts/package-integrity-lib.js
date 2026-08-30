'use strict';

const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const path = require('path');
const os = require('os');
const { StrictJsonScanner, exactKeys } = require('./build-native-helper');

const BASE_TOOLS = Object.freeze(['exiftool', 'fs-helper', 'launch-broker']);
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json']);
const FORBIDDEN_RULES = Object.freeze([
  {
    rule: 'python-runtime',
    pattern: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"`]python(?:3|\.exe)?['"`]/g,
  },
  {
    rule: 'host-tool',
    pattern:
      /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"`](?:ffmpeg|ffprobe|exiftool)(?:\.exe)?['"`]/g,
  },
  {
    rule: 'dependency-binary',
    pattern:
      /(?:\b(?:require|import)\s*\(\s*['"`](?:ffprobe-static|@ffmpeg-installer\/ffmpeg|exiftool-vendored)['"`]\s*\)|^\s*(?:import|export)\b[^\n;]*\bfrom\s+['"`](?:ffprobe-static|@ffmpeg-installer\/ffmpeg|exiftool-vendored)['"`])/gm,
  },
  {
    rule: 'native-sqlite',
    pattern:
      /(?:require\s*\(\s*|from\s+|['"`]\s*:\s*['"`](?:commonjs\s+)?)['"`]?(?:sqlite3|better-sqlite3)['"`]/g,
  },
  { rule: 'python-artifact', pattern: /(?:media_organizer\.py|['"`][^'"`\n]*\.py['"`])/g },
]);
const RETIRED_DEPENDENCIES = Object.freeze([
  '@electron/notarize',
  '@electron/rebuild',
  '@types/lodash',
  '@types/sharp',
  '@types/uuid',
  '@types/winston',
  '7zip-bin',
  'copy-webpack-plugin',
  'css-minimizer-webpack-plugin',
  'dmg-builder',
  'dmg-license',
  'electron-builder-notarize',
  'electron-devtools-installer',
  'electron-log',
  'electron-store',
  'electron-updater',
  'exifr',
  'fork-ts-checker-webpack-plugin',
  'i18next',
  'lodash',
  'mini-css-extract-plugin',
  'npm-check-updates',
  'react-i18next',
  'redux',
  'sass',
  'sass-loader',
  'sharp',
  'source-map-loader',
  'sqlite3',
  'terser-webpack-plugin',
  'url-loader',
  'webpack-bundle-analyzer',
  'webpack-dev-server',
  'webpack-merge',
]);

const ACTIVE_BUILD_COMMAND =
  'npm run clean:dist && npm run build:main && npm run build:preload && npm run build:renderer';
const ACTIVE_DEV_BUILD_COMMAND =
  'npm run clean:dist && npm run build:main:dev && npm run build:preload:dev && npm run build:renderer:dev';

function normalizedEntries(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function entryText(entry) {
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

function exactJson(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function assertPackageConfig(packageJson) {
  const build = packageJson && packageJson.build;
  if (!build || build.asar !== true) {
    throw new Error('Package build must explicitly enable ASAR');
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const dependency of [
      ...RETIRED_DEPENDENCIES,
      'better-sqlite3',
      '@ffmpeg-installer/ffmpeg',
      'ffprobe-static',
    ]) {
      if (packageJson[section] && packageJson[section][dependency]) {
        throw new Error(`Package must not depend on forbidden runtime module ${dependency}`);
      }
    }
  }
  if (
    packageJson.scripts?.build !== ACTIVE_BUILD_COMMAND ||
    packageJson.scripts?.['build:dev'] !== ACTIVE_DEV_BUILD_COMMAND ||
    ['build:worker', 'build:worker:dev', 'postinstall'].some(
      (script) => packageJson.scripts?.[script] !== undefined
    )
  ) {
    throw new Error(
      'Package scripts must build only the active main, preload, and renderer bundles'
    );
  }
  if (
    build.publish !== null ||
    build.detectUpdateChannel !== undefined ||
    build.generateUpdatesFilesForAllChannels !== undefined
  ) {
    throw new Error('Package config must not contain updater publish metadata');
  }
  if (build.forceCodeSigning !== true) {
    throw new Error(
      'Package config must fail closed unless signable platform artifacts are signed'
    );
  }
  if (
    !exactJson(build.linux?.target, [
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
    ])
  ) {
    throw new Error('Linux package targets must be exactly root-installed x64 deb and rpm');
  }
  if (!exactJson(build.mac?.target, [{ target: 'pkg', arch: ['x64', 'arm64'] }])) {
    throw new Error('macOS package targets must be exactly signed root-installed pkg');
  }
  if (build.mac?.identity === null || build.mac?.notarize !== true) {
    throw new Error(
      'macOS package configuration must require signing and notarization'
    );
  }
  if (
    build.pkg?.allowAnywhere !== false ||
    build.pkg?.allowCurrentUserHome !== false ||
    build.pkg?.allowRootDirectory !== true ||
    build.pkg?.installLocation !== '/Applications'
  ) {
    throw new Error('macOS pkg must install only to /Applications');
  }
  if (!exactJson(build.win?.target, [{ target: 'nsis', arch: ['x64', 'arm64'] }])) {
    throw new Error('Windows package target must be exactly signed per-machine NSIS');
  }
  if (
    build.win?.signAndEditExecutable !== true ||
    build.win?.signExecutable !== true ||
    !Array.isArray(build.win?.signExts) ||
    !build.win.signExts.includes('.dll') ||
    build.win?.verifyUpdateCodeSignature !== true
  ) {
    throw new Error('Windows package configuration must require signed executables and DLLs');
  }
  if (
    build.nsis?.perMachine !== true ||
    build.nsis?.allowElevation !== true ||
    build.nsis?.allowToChangeInstallationDirectory !== false
  ) {
    throw new Error('Windows NSIS must be elevated, per-machine, and root-installed');
  }
  for (const obsolete of ['dmg', 'snap', 'msi', 'appx']) {
    if (build[obsolete] !== undefined) {
      throw new Error(`Package config contains obsolete ${obsolete} target settings`);
    }
  }

  const positiveFilePatterns = normalizedEntries(build.files).filter(
    (entry) => typeof entry === 'string' && !entry.startsWith('!')
  );
  const packageInputs = [...positiveFilePatterns, ...normalizedEntries(build.extraFiles)];
  if (packageInputs.some((entry) => /scripts|\.py(?:$|[^a-z])/i.test(entryText(entry)))) {
    throw new Error('Package config must not ship Python or scripts');
  }
  if (
    positiveFilePatterns.length !== 1 ||
    !['dist/**/*', 'dist/**/**'].includes(positiveFilePatterns[0])
  ) {
    throw new Error('Package files must allow only production bundles from dist');
  }
  const filePatterns = normalizedEntries(build.files);
  for (const exclusion of ['!**/*.py', '!**/*.pyc', '!**/*.pyo']) {
    if (!filePatterns.includes(exclusion)) {
      throw new Error(`Package files must exclude Python artifacts with ${exclusion}`);
    }
  }

  const resourceMappings = normalizedEntries(build.extraResources);
  const toolMapping = resourceMappings.find(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      entry.from === '.build-tools/tools' &&
      entry.to === 'tools'
  );
  if (!toolMapping) {
    throw new Error('Package config must copy staged tools into application resources/tools');
  }
  return true;
}

function walkFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stats = fs.lstatSync(target);
  if (stats.isFile()) return [target];
  if (!stats.isDirectory()) return [];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function findForbiddenRuntimeReferences(target) {
  const failures = [];
  for (const filename of walkFiles(target)) {
    if (!SOURCE_EXTENSIONS.has(path.extname(filename).toLowerCase())) continue;
    const contents = fs.readFileSync(filename, 'utf8');
    for (const { rule, pattern } of FORBIDDEN_RULES) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(contents)) !== null) {
        const line = contents.slice(0, match.index).split('\n').length;
        failures.push({ file: filename, line, rule, match: match[0] });
        if (match[0].length === 0) pattern.lastIndex += 1;
      }
    }
  }
  return failures;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function expectedTools(platform) {
  return platform === 'win32' ? [...BASE_TOOLS] : [...BASE_TOOLS, 'perl'];
}

function electronTarget(platform, arch) {
  return `${platform}-${arch}`;
}

function runInspection(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `Runtime compatibility inspection failed: ${command}: ${result.stderr || result.error || ''}`
    );
  }
  return (result.stdout || '').trim();
}

async function inspectPortableExecutable(executablePath, arch) {
  const bytes = await fs.promises.readFile(executablePath);
  if (bytes.length < 0x100 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Windows runtime is not a valid DOS-wrapped PE binary');
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (
    peOffset > bytes.length - 26 ||
    bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error('Windows runtime has no valid PE signature');
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const machineArchitectures = new Map([
    [0x014c, 'ia32'],
    [0x8664, 'x64'],
    [0xaa64, 'arm64'],
  ]);
  const actualArch = machineArchitectures.get(machine);
  if (!actualArch || actualArch !== arch) {
    throw new Error(`Native runtime architecture evidence does not match ${arch}`);
  }
  const optionalMagic = bytes.readUInt16LE(peOffset + 24);
  const peKind = optionalMagic === 0x20b ? 'PE32+' : optionalMagic === 0x10b ? 'PE32' : null;
  if (!peKind) throw new Error('Windows runtime has an invalid PE optional header');
  const machineName = actualArch === 'x64' ? 'x86-64' : actualArch === 'arm64' ? 'ARM64' : 'i386';
  const libraries = [
    ...new Set(
      [...bytes.toString('latin1').matchAll(/([A-Za-z0-9_.-]+\.dll)\0/gi)].map((match) => match[1])
    ),
  ];
  if (libraries.length === 0) {
    throw new Error('Windows runtime has no recorded DLL import-name evidence');
  }
  return {
    platform: 'win32',
    arch,
    nativePlatformOnly: true,
    inspectedTool: 'exiftool',
    binaryFormat: `${peKind} ${machineName}`,
    loader: 'Windows PE loader',
    sharedLibraries: libraries,
  };
}

async function inspectNativeRuntime(executablePath, platform, arch) {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      'Bundled runtime staging and inspection must run on the native target OS and architecture'
    );
  }
  if (platform === 'linux') {
    const binaryFormat = runInspection('/usr/bin/file', ['-b', executablePath]);
    const architecturePattern = arch === 'x64' ? /x86-64|x86_64/i : /aarch64|arm64/i;
    if (!architecturePattern.test(binaryFormat)) {
      throw new Error(`Native runtime architecture evidence does not match ${arch}`);
    }
    const programHeaders = runInspection('/usr/bin/readelf', ['-l', executablePath]);
    const dynamicSection = runInspection('/usr/bin/readelf', ['-d', executablePath]);
    const loader = programHeaders.match(/Requesting program interpreter:\s*([^\]]+)/)?.[1]?.trim();
    const sharedLibraries = [...dynamicSection.matchAll(/Shared library:\s*\[([^\]]+)\]/g)].map(
      (match) => match[1]
    );
    const staticRuntime = !loader && sharedLibraries.length === 0 && /statically linked/i.test(binaryFormat);
    if ((!loader || sharedLibraries.length === 0) && !staticRuntime) {
      throw new Error('Linux runtime has incomplete ELF loader or shared-library evidence');
    }
    return {
      platform,
      arch,
      nativePlatformOnly: true,
      inspectedTool: 'perl',
      binaryFormat,
      loader: staticRuntime ? 'static ELF' : loader,
      sharedLibraries: staticRuntime ? ['statically linked'] : sharedLibraries,
    };
  }
  if (platform === 'darwin') {
    const binaryFormat = runInspection('/usr/bin/file', ['-b', executablePath]);
    const architecturePattern = arch === 'x64' ? /x86_64/i : /arm64/i;
    if (!architecturePattern.test(binaryFormat)) {
      throw new Error(`Native runtime architecture evidence does not match ${arch}`);
    }
    const libraries = runInspection('/usr/bin/otool', ['-L', executablePath])
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    if (libraries.length === 0) throw new Error('macOS runtime has no shared-library evidence');
    return {
      platform,
      arch,
      nativePlatformOnly: true,
      inspectedTool: 'perl',
      binaryFormat,
      loader: 'dyld',
      sharedLibraries: libraries,
    };
  }
  if (platform === 'win32') {
    return inspectPortableExecutable(executablePath, arch);
  }
  throw new Error(
    `Runtime compatibility inspection is unsupported for ${platform}; refusing artifact`
  );
}

async function sha256(filename) {
  const contents = await fs.promises.readFile(filename);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function hashDirectory(directory) {
  const digest = crypto.createHash('sha256');
  let fileCount = 0;

  async function visit(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const stats = await fs.promises.lstat(entryPath);
      if (stats.isSymbolicLink())
        throw new Error(`Bundled Perl library contains a symlink: ${entryPath}`);
      if (stats.isDirectory()) {
        await visit(entryPath);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw new Error(`Bundled support directory contains a hard link: ${entryPath}`);
        }
        const relative = path.relative(directory, entryPath).split(path.sep).join('/');
        digest.update(relative);
        digest.update('\0');
        digest.update(await fs.promises.readFile(entryPath));
        digest.update('\0');
        fileCount += 1;
      } else {
        throw new Error(
          `Bundled support directory contains a special non-regular entry: ${entryPath}`
        );
      }
    }
  }

  await visit(directory);
  return { sha256: digest.digest('hex'), fileCount };
}

async function probePerlExifTool(toolsRoot, manifest) {
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  const perl = path.join(toolsRoot, byName.get('perl').path);
  const exiftool = path.join(toolsRoot, byName.get('exiftool').path);
  const perlLibs = manifest.perlLibs.map((entry) => path.join(toolsRoot, entry.path));
  const exiftoolLib = path.join(path.dirname(exiftool), 'lib');
  const marker = '__META_MOVER_PERL_INC__';
  const program = [
    'my $script = shift @ARGV;',
    `END { for my $key (sort keys %INC) { my $value = $INC{$key}; print STDERR "${marker}$value\\n" if defined $value && length $value; } }`,
    'my $result = do $script;',
    'die $@ if $@;',
    'die $! unless defined $result;',
  ].join(' ');
  const environment = {
    LANG: 'C',
    LC_ALL: 'C',
    PATH: toolsRoot,
    PERL5LIB: [exiftoolLib, ...perlLibs].join(path.delimiter),
    PERL_USE_UNSAFE_INC: '0',
  };
  const result = childProcess.spawnSync(perl, ['-e', program, exiftool, '-ver'], {
    cwd: toolsRoot,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `Bundled Perl plus ExifTool probe failed: ${result.stderr || result.error || ''}`
    );
  }
  const version = (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const loadedModules = (result.stderr || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker))
    .map((line) => line.slice(marker.length));
  if (!version || loadedModules.length === 0) {
    throw new Error('Bundled Perl plus ExifTool probe produced no version or module trace');
  }
  const corpusRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meta-mover-exif-corpus-'));
  try {
    const fixtures = new Map([
      ['sample.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
      ['sample.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ['sample.tiff', Buffer.from('49492a000800000000000000', 'hex')],
      ['sample.heic', Buffer.from('0000001866747970686569630000000068656963', 'hex')],
      ['sample.mov', Buffer.from('0000001466747970717420200000000071742020', 'hex')],
      ['sample.mp4', Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex')],
      ['sample.pdf', Buffer.from('%PDF-1.4\n%%EOF\n')],
      ['sample.mp3', Buffer.from('49443304000000000000', 'hex')],
      ['sample.wav', Buffer.from('524946460400000057415645', 'hex')],
    ]);
    const files = [];
    for (const [name, bytes] of fixtures) {
      const filename = path.join(corpusRoot, name);
      await fs.promises.writeFile(filename, bytes, { flag: 'wx', mode: 0o400 });
      files.push(filename);
    }
    const corpus = childProcess.spawnSync(
      perl,
      ['-e', program, exiftool, '-j', ...files],
      {
        cwd: toolsRoot,
        encoding: 'utf8',
        env: environment,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    if (corpus.status !== 0) {
      throw new Error(`Bundled Perl media-format corpus failed: ${corpus.stderr || corpus.error || ''}`);
    }
    const records = JSON.parse(corpus.stdout || 'null');
    if (!Array.isArray(records) || records.length !== fixtures.size) {
      throw new Error('Bundled Perl media-format corpus returned incomplete ExifTool evidence');
    }
    loadedModules.push(
      ...(corpus.stderr || '')
        .split(/\r?\n/)
        .filter((line) => line.startsWith(marker))
        .map((line) => line.slice(marker.length))
    );
  } finally {
    await fs.promises.rm(corpusRoot, { recursive: true, force: true });
  }
  return { version, loadedModules: [...new Set(loadedModules)] };
}

async function verifyToolResources(toolsRoot, options = {}) {
  const platform = options.platform || process.platform;
  const canonicalRoot = await fs.promises.realpath(toolsRoot);
  const manifestPath = path.join(canonicalRoot, 'manifest.json');
  const manifestText = await fs.promises.readFile(manifestPath, 'utf8');
  new StrictJsonScanner(manifestText).scan();
  const manifest = JSON.parse(manifestText);
  if (manifest.schemaVersion !== 3 || manifest.platform !== platform) {
    throw new Error(`Tool manifest does not match ${platform}`);
  }
  exactKeys(
    manifest,
    [
      'schemaVersion',
      'platform',
      'arch',
      'tools',
      'runtimeCompatibility',
      ...(platform === 'win32' ? [] : ['perlLibs']),
    ],
    'Tool manifest'
  );
  const requiredTools = expectedTools(platform);
  const names = Array.isArray(manifest.tools) ? manifest.tools.map((tool) => tool.name) : [];
  if (
    names.length !== requiredTools.length ||
    requiredTools.some((name) => names.filter((candidate) => candidate === name).length !== 1)
  ) {
    throw new Error(`Tool manifest must contain exactly: ${requiredTools.join(', ')}`);
  }

  for (const tool of manifest.tools) {
    const keysByName = {
      exiftool: [
        'name',
        'path',
        'version',
        'sha256',
        ...(platform === 'win32' ? [] : ['supportDirectory']),
      ],
      'fs-helper': [
        'name',
        'path',
        'version',
        'sha256',
        'target',
        'protocolVersion',
        'buildVersion',
      ],
      'launch-broker': [
        'name',
        'path',
        'version',
        'sha256',
        'target',
        'rustTarget',
        'buildVersion',
        'helperSha256',
        'helperProtocolVersion',
        'helperBuildVersion',
        'releaseSigner',
      ],
      perl: ['name', 'path', 'version', 'sha256'],
    };
    exactKeys(tool, keysByName[tool.name], `${tool.name} manifest entry`);
  }

  for (const tool of manifest.tools) {
    if (!tool.path || path.isAbsolute(tool.path)) {
      throw new Error(`${tool.name} path must be relative to application resources`);
    }
    const candidate = path.resolve(canonicalRoot, tool.path);
    if (!isWithin(canonicalRoot, candidate)) {
      throw new Error(`${tool.name} escapes application resources`);
    }
    let visibleBefore;
    let canonicalTool;
    try {
      visibleBefore = await fs.promises.lstat(candidate);
      if (!visibleBefore.isFile() || visibleBefore.isSymbolicLink() || visibleBefore.nlink !== 1) {
        throw new Error(`${tool.name} must be a singly-linked regular file, not a symbolic link`);
      }
      canonicalTool = await fs.promises.realpath(candidate);
    } catch (error) {
      if (error instanceof Error && /singly-linked|symbolic/.test(error.message)) throw error;
      throw new Error(`${tool.name} is missing from application resources`);
    }
    if (!isWithin(canonicalRoot, canonicalTool)) {
      throw new Error(`${tool.name} escapes application resources`);
    }
    const stats = await fs.promises.lstat(canonicalTool);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.dev !== visibleBefore.dev ||
      stats.ino !== visibleBefore.ino
    ) {
      throw new Error(`${tool.name} is not the manifest-bound regular file`);
    }
    if (typeof tool.version !== 'string' || tool.version.trim() === '') {
      throw new Error(`${tool.name} has no verified version`);
    }
    if (!/^[a-f0-9]{64}$/.test(tool.sha256 || '')) {
      throw new Error(`${tool.name} has no valid SHA-256 digest`);
    }
    const actualDigest = await sha256(canonicalTool);
    const visibleAfter = await fs.promises.lstat(candidate);
    if (
      visibleAfter.isSymbolicLink() ||
      !visibleAfter.isFile() ||
      visibleAfter.nlink !== 1 ||
      visibleAfter.dev !== visibleBefore.dev ||
      visibleAfter.ino !== visibleBefore.ino ||
      visibleAfter.size !== visibleBefore.size ||
      visibleAfter.mtimeMs !== visibleBefore.mtimeMs
    ) {
      throw new Error(`${tool.name} identity changed during verification`);
    }
    if (actualDigest !== tool.sha256) {
      throw new Error(`${tool.name} SHA-256 digest does not match`);
    }
    if (platform !== 'win32') {
      try {
        await fs.promises.access(canonicalTool, fs.constants.X_OK);
      } catch {
        throw new Error(`${tool.name} is not executable`);
      }
    }
  }

  const helper = manifest.tools.find((tool) => tool.name === 'fs-helper');
  const expectedHelperTarget = electronTarget(platform, manifest.arch);
  const expectedHelperPath = path.posix.join(
    'fs-helper',
    expectedHelperTarget,
    platform === 'win32' ? 'meta-mover-fs-helper.exe' : 'meta-mover-fs-helper'
  );
  if (
    !helper ||
    helper.path !== expectedHelperPath ||
    helper.target !== expectedHelperTarget ||
    helper.protocolVersion !== 1 ||
    helper.buildVersion !== helper.version
  ) {
    throw new Error('Filesystem helper manifest entry does not match the native package target');
  }
  const helperProbe =
    options.fsHelperProbe || require('./build-native-helper').probeFilesystemHelper;
  if (platform === 'linux') {
    const staticInspector =
      options.linuxStaticInspector || require('./build-native-helper').assertLinuxStaticExecutable;
    await staticInspector(path.join(canonicalRoot, helper.path));
  }
  const helperEvidence = await helperProbe(path.join(canonicalRoot, helper.path), {
    platform,
    arch: manifest.arch,
  });
  if (
    helperEvidence.protocol !== helper.protocolVersion ||
    helperEvidence.build !== helper.buildVersion
  ) {
    throw new Error('Filesystem helper runtime evidence does not match its manifest');
  }

  const broker = manifest.tools.find((tool) => tool.name === 'launch-broker');
  const expectedBrokerPath = path.posix.join(
    'launch-broker',
    expectedHelperTarget,
    platform === 'win32' ? 'meta-mover-launch-broker.exe' : 'meta-mover-launch-broker'
  );
  if (
    !broker ||
    broker.path !== expectedBrokerPath ||
    broker.target !== expectedHelperTarget ||
    broker.buildVersion !== broker.version ||
    broker.helperSha256 !== helper.sha256 ||
    broker.helperProtocolVersion !== helper.protocolVersion ||
    broker.helperBuildVersion !== helper.buildVersion ||
    !(
      broker.releaseSigner === null ||
      (typeof broker.releaseSigner === 'string' &&
        broker.releaseSigner.length > 0 &&
        !/[\0\r\n]/.test(broker.releaseSigner))
    )
  ) {
    throw new Error('Launch broker manifest entry does not match the native filesystem helper');
  }
  if (platform === 'linux') {
    const staticInspector =
      options.linuxStaticInspector || require('./build-native-helper').assertLinuxStaticExecutable;
    await staticInspector(path.join(canonicalRoot, broker.path));
  }
  const brokerIdentityProbe =
    options.launchBrokerIdentityProbe || require('./build-launch-broker').probeLaunchBrokerIdentity;
  const brokerIdentity = await brokerIdentityProbe(path.join(canonicalRoot, broker.path), {
    platform,
    arch: manifest.arch,
  });
  if (
    brokerIdentity.brokerBuild !== broker.buildVersion ||
    brokerIdentity.brokerTarget !== broker.rustTarget ||
    brokerIdentity.helperSha256 !== broker.helperSha256 ||
    brokerIdentity.helperProtocol !== broker.helperProtocolVersion ||
    brokerIdentity.helperBuild !== broker.helperBuildVersion ||
    brokerIdentity.helperTarget !== broker.target ||
    brokerIdentity.releaseSigner !== broker.releaseSigner
  ) {
    throw new Error('Launch broker compiled identity does not match its manifest');
  }
  const brokerRelayProbe =
    options.launchBrokerRelayProbe || require('./build-launch-broker').probeLaunchBrokerRelay;
  const brokerRelay = await brokerRelayProbe(path.join(canonicalRoot, broker.path), {
    platform,
    arch: manifest.arch,
  });
  if (
    brokerRelay.protocol !== helperEvidence.protocol ||
    brokerRelay.build !== helperEvidence.build ||
    brokerRelay.target !== helperEvidence.target ||
    JSON.stringify(brokerRelay.features) !== JSON.stringify(helperEvidence.features)
  ) {
    throw new Error('Launch broker relay evidence does not match the filesystem helper');
  }

  if (platform !== 'win32') {
    const exiftool = manifest.tools.find((tool) => tool.name === 'exiftool');
    const support = exiftool.supportDirectory;
    exactKeys(support, ['path', 'sha256', 'fileCount'], 'ExifTool support directory');
    const expectedSupportPath = path.posix.join(path.posix.dirname(exiftool.path), 'lib');
    if (
      !support ||
      typeof support.path !== 'string' ||
      support.path !== expectedSupportPath ||
      path.isAbsolute(support.path) ||
      !/^[a-f0-9]{64}$/.test(support.sha256 || '') ||
      !Number.isSafeInteger(support.fileCount) ||
      support.fileCount < 1
    ) {
      throw new Error(`ExifTool support directory must be ${expectedSupportPath}`);
    }
    const supportPath = path.resolve(canonicalRoot, support.path);
    if (!isWithin(canonicalRoot, supportPath)) {
      throw new Error('ExifTool support directory escapes application resources');
    }
    const visibleSupport = await fs.promises.lstat(supportPath);
    if (!visibleSupport.isDirectory() || visibleSupport.isSymbolicLink()) {
      throw new Error('ExifTool support directory is not a regular directory');
    }
    const canonicalSupport = await fs.promises.realpath(supportPath);
    if (!isWithin(canonicalRoot, canonicalSupport)) {
      throw new Error('ExifTool support directory escapes application resources');
    }
    const actualSupport = await hashDirectory(canonicalSupport);
    if (actualSupport.sha256 !== support.sha256 || actualSupport.fileCount !== support.fileCount) {
      throw new Error('ExifTool support directory digest does not match');
    }
  }

  const inspectedTool = platform === 'win32' ? 'exiftool' : 'perl';
  const inspectedEntry = manifest.tools.find((tool) => tool.name === inspectedTool);
  const runtimeInspector = options.runtimeInspector || inspectNativeRuntime;
  const actualCompatibility = await runtimeInspector(
    path.join(canonicalRoot, inspectedEntry.path),
    platform,
    manifest.arch
  );
  exactKeys(
    manifest.runtimeCompatibility,
    [
      'platform',
      'arch',
      'nativePlatformOnly',
      'inspectedTool',
      'binaryFormat',
      'loader',
      'sharedLibraries',
    ],
    'Runtime compatibility evidence'
  );
  if (JSON.stringify(manifest.runtimeCompatibility) !== JSON.stringify(actualCompatibility)) {
    throw new Error('Runtime compatibility evidence does not match the staged native binary');
  }

  if (platform !== 'win32') {
    if (!Array.isArray(manifest.perlLibs) || manifest.perlLibs.length === 0) {
      throw new Error('Tool manifest has no bundled Perl library roots');
    }
    for (const entry of manifest.perlLibs) {
      exactKeys(entry, ['path', 'sha256', 'fileCount'], 'Bundled Perl library entry');
      if (!entry.path || path.isAbsolute(entry.path)) {
        throw new Error('Bundled Perl library path must be relative');
      }
      const directory = path.resolve(canonicalRoot, entry.path);
      if (!isWithin(canonicalRoot, directory))
        throw new Error('Bundled Perl library escapes resources');
      const stats = await fs.promises.lstat(directory);
      if (!stats.isDirectory()) throw new Error('Bundled Perl library root is not a directory');
      const actual = await hashDirectory(directory);
      if (actual.sha256 !== entry.sha256 || actual.fileCount !== entry.fileCount) {
        throw new Error(`Perl library digest does not match: ${entry.path}`);
      }
    }

    const perlProbe = options.perlProbe || probePerlExifTool;
    const probe = await perlProbe(canonicalRoot, manifest);
    const exiftoolVersion = manifest.tools.find((tool) => tool.name === 'exiftool').version;
    if (probe.version !== exiftoolVersion) {
      throw new Error('Bundled Perl plus ExifTool version does not match manifest');
    }
    for (const loadedModule of probe.loadedModules) {
      const absolute = path.isAbsolute(loadedModule)
        ? path.resolve(loadedModule)
        : path.resolve(canonicalRoot, loadedModule);
      if (!isWithin(canonicalRoot, absolute)) {
        throw new Error(`Perl module loaded outside bundled Perl roots: ${loadedModule}`);
      }
    }
  }
  return manifest;
}

function findPackagedToolRoots(releaseRoot) {
  return walkFiles(releaseRoot)
    .filter((filename) => filename.endsWith(`${path.sep}tools${path.sep}manifest.json`))
    .map((filename) => path.dirname(filename));
}

function findUpdaterArtifacts(releaseRoot) {
  return walkFiles(releaseRoot).filter((filename) => {
    const basename = path.basename(filename).toLowerCase();
    return (
      basename === 'app-update.yml' ||
      /^latest(?:-[^.]+)?\.ya?ml$/.test(basename) ||
      basename.endsWith('.blockmap')
    );
  });
}

function inspectAsarPayload(archivePath) {
  const program = [
    "import { extractFile, listPackage } from '@electron/asar';",
    "const archive=process.argv[1]; const entries=listPackage(archive); const packageJson=JSON.parse(extractFile(archive,'package.json').toString());",
    'process.stdout.write(JSON.stringify({entries,packageJson}));',
  ].join(' ');
  const result = childProcess.spawnSync(
    process.execPath,
    ['--input-type=module', '-e', program, archivePath],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`Could not inspect ASAR payload: ${result.stderr || result.error || ''}`);
  }
  return JSON.parse(result.stdout);
}

function findPythonArtifactsInAsar(archivePath) {
  return inspectAsarPayload(archivePath).entries.filter((entry) => /\.py[co]?$/i.test(entry));
}

function findMissingNativeAbiReferencesInAsar(archivePath) {
  const { entries, packageJson } = inspectAsarPayload(archivePath);
  const dependencies = packageJson.dependencies || {};
  const nativeModules = {
    sqlite3: /node_sqlite3\.node$/,
    'better-sqlite3': /better_sqlite3\.node$/,
    sharp: /sharp[^/]*\.node$/,
  };
  return Object.entries(nativeModules)
    .filter(([name, binary]) => dependencies[name] && !entries.some((entry) => binary.test(entry)))
    .map(([name]) => name);
}

module.exports = {
  assertPackageConfig,
  expectedTools,
  findForbiddenRuntimeReferences,
  findMissingNativeAbiReferencesInAsar,
  findPackagedToolRoots,
  findPythonArtifactsInAsar,
  findUpdaterArtifacts,
  hashDirectory,
  inspectNativeRuntime,
  inspectPortableExecutable,
  probePerlExifTool,
  verifyToolResources,
  walkFiles,
};
