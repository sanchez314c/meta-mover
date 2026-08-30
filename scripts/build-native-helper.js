'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const HELPER_MANIFEST = path.resolve(__dirname, '..', 'native', 'fs-helper', 'Cargo.toml');
const REQUIRED_FEATURES = Object.freeze([
  'capability-relative',
  'no-follow',
  'no-replace',
  'sha256',
  'durable-sync',
]);
const MAX_LINE_BYTES = 65_536;
const MAX_JSON_DEPTH = 16;
const MAX_ARRAY_ITEMS = 256;

class StrictJsonScanner {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  scan() {
    this.skipWhitespace();
    this.value(1);
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new Error('JSON contains trailing data');
  }

  value(depth) {
    if (depth > MAX_JSON_DEPTH) throw new Error('JSON nesting exceeds protocol depth limit');
    const character = this.text[this.index];
    if (character === '{') return this.object(depth);
    if (character === '[') return this.array(depth);
    if (character === '"') return this.string();
    if (this.text.startsWith('true', this.index)) return void (this.index += 4);
    if (this.text.startsWith('false', this.index)) return void (this.index += 5);
    if (this.text.startsWith('null', this.index)) return void (this.index += 4);
    this.integer();
  }

  object(depth) {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.text[this.index] !== '"') throw new Error('JSON object key must be a string');
      const key = this.string();
      if (keys.has(key)) throw new Error(`JSON contains duplicate key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') throw new Error('JSON object key has no value');
      this.index += 1;
      this.skipWhitespace();
      this.value(depth + 1);
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') throw new Error('JSON object is malformed');
      this.index += 1;
      this.skipWhitespace();
    }
  }

  array(depth) {
    this.index += 1;
    this.skipWhitespace();
    let items = 0;
    if (this.text[this.index] === ']') {
      this.index += 1;
      return;
    }
    while (true) {
      items += 1;
      if (items > MAX_ARRAY_ITEMS) throw new Error('JSON array exceeds 256-item limit');
      this.value(depth + 1);
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return;
      }
      if (this.text[this.index] !== ',') throw new Error('JSON array is malformed');
      this.index += 1;
      this.skipWhitespace();
    }
  }

  string() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index));
      }
      if (character === '\\') this.index += 2;
      else {
        if (character < ' ') throw new Error('JSON string contains a control character');
        this.index += 1;
      }
    }
    throw new Error('JSON string is unterminated');
  }

  integer() {
    const start = this.index;
    while (this.index < this.text.length && !/[\s,\]}]/.test(this.text[this.index])) {
      this.index += 1;
    }
    const token = this.text.slice(start, this.index);
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(token)) {
      throw new Error('JSON numbers must be integers');
    }
  }

  skipWhitespace() {
    while (/\s/.test(this.text[this.index] || '')) this.index += 1;
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} has missing or unknown keys`);
  }
}

function electronTarget(platform = process.platform, arch = process.arch) {
  const supported =
    ((platform === 'linux' || platform === 'darwin') && ['x64', 'arm64'].includes(arch)) ||
    (platform === 'win32' && ['x64', 'arm64', 'ia32'].includes(arch));
  if (!supported) throw new Error(`Unsupported native helper target: ${platform}-${arch}`);
  return `${platform}-${arch}`;
}

function validRustTargets(platform = process.platform, arch = process.arch) {
  const targets = {
    'linux-x64': ['x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl'],
    'linux-arm64': ['aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl'],
    'darwin-x64': ['x86_64-apple-darwin'],
    'darwin-arm64': ['aarch64-apple-darwin'],
    'win32-x64': ['x86_64-pc-windows-msvc'],
    'win32-arm64': ['aarch64-pc-windows-msvc'],
    'win32-ia32': ['i686-pc-windows-msvc'],
  };
  return targets[electronTarget(platform, arch)] || [];
}

function helperFilename(platform = process.platform) {
  return platform === 'win32' ? 'meta-mover-fs-helper.exe' : 'meta-mover-fs-helper';
}

function parseProbeLine(stdout) {
  if (
    !Buffer.isBuffer(stdout) ||
    stdout.length < 2 ||
    stdout.length > MAX_LINE_BYTES ||
    stdout[stdout.length - 1] !== 0x0a ||
    stdout.subarray(0, stdout.length - 1).includes(0x0a)
  ) {
    throw new Error('Filesystem helper hello probe returned invalid newline-terminated NDJSON');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout.subarray(0, -1));
  } catch (error) {
    throw new Error(`Filesystem helper hello probe is not valid UTF-8: ${error.message}`);
  }
  new StrictJsonScanner(text).scan();
  const response = JSON.parse(text);
  exactKeys(response, ['v', 'id', 'ok', 'result'], 'Filesystem helper hello response');
  const result = response && response.result;
  exactKeys(
    result,
    ['outcome', 'protocol', 'build', 'target', 'features'],
    'Filesystem helper hello result'
  );
  if (
    response.v !== 1 ||
    response.id !== '00000000-0000-4000-8000-000000000001' ||
    response.ok !== true ||
    !result ||
    result.outcome !== 'applied' ||
    result.protocol !== 1 ||
    typeof result.build !== 'string' ||
    result.build.length === 0 ||
    typeof result.target !== 'string' ||
    !Array.isArray(result.features) ||
    result.features.length !== REQUIRED_FEATURES.length ||
    result.features.some((feature, index) => feature !== REQUIRED_FEATURES[index])
  ) {
    throw new Error('Filesystem helper hello probe does not match protocol v1');
  }
  return {
    protocol: result.protocol,
    build: result.build,
    target: result.target,
    features: [...result.features],
  };
}

async function assertLinuxStaticExecutable(executablePath) {
  const bytes = await fs.promises.readFile(executablePath);
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes.toString('ascii', 1, 4) !== 'ELF' ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    throw new Error('Linux filesystem helper must be a little-endian ELF64 binary');
  }
  const programOffset = Number(bytes.readBigUInt64LE(32));
  const entrySize = bytes.readUInt16LE(54);
  const entryCount = bytes.readUInt16LE(56);
  if (
    !Number.isSafeInteger(programOffset) ||
    entrySize < 4 ||
    entryCount < 1 ||
    programOffset + entrySize * entryCount > bytes.length
  ) {
    throw new Error('Linux filesystem helper has an invalid program-header table');
  }
  let hasLoadSegment = false;
  for (let index = 0; index < entryCount; index += 1) {
    const type = bytes.readUInt32LE(programOffset + entrySize * index);
    if (type === 3) {
      throw new Error('Linux filesystem helper must not contain a dynamic interpreter');
    }
    if (type === 1) hasLoadSegment = true;
  }
  if (!hasLoadSegment) throw new Error('Linux filesystem helper has no loadable segment');
}

async function probeFilesystemHelper(executablePath, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Filesystem helper probe must run on the native target OS and architecture');
  }
  const request = '{"v":1,"id":"00000000-0000-4000-8000-000000000001","op":"hello"}\n';
  const result = childProcess.spawnSync(executablePath, ['--stdio'], {
    input: request,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: MAX_LINE_BYTES,
  });
  if (result.status !== 0) {
    throw new Error(
      `Filesystem helper hello probe failed: ${String(result.stderr || result.error || '')}`
    );
  }
  const probe = parseProbeLine(result.stdout || Buffer.alloc(0));
  if (!validRustTargets(platform, arch).includes(probe.target)) {
    throw new Error(`Filesystem helper Rust target does not match ${platform}-${arch}`);
  }
  return probe;
}

async function buildNativeFilesystemHelper(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  electronTarget(platform, arch);
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Filesystem helper must be built on the native target OS and architecture');
  }
  const cargo = options.cargo || process.env.CARGO || 'cargo';
  const targetDirectory = path.resolve(
    options.targetDirectory || path.join(path.dirname(HELPER_MANIFEST), 'target')
  );
  const cargoArguments = [
    platform === 'linux' ? 'rustc' : 'build',
    '--release',
    '--locked',
    '--manifest-path',
    HELPER_MANIFEST,
    '--target-dir',
    targetDirectory,
    ...(platform === 'linux'
      ? ['--bin', 'meta-mover-fs-helper', '--', '-C', 'target-feature=+crt-static']
      : []),
  ];
  const result = childProcess.spawnSync(cargo, cargoArguments, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Filesystem helper build failed: ${result.stderr || result.error || ''}`);
  }
  const executablePath = path.join(targetDirectory, 'release', helperFilename(platform));
  const stats = await fs.promises.lstat(executablePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Filesystem helper build did not produce a regular binary');
  }
  if (platform === 'linux') await assertLinuxStaticExecutable(executablePath);
  if (platform !== 'win32') await fs.promises.chmod(executablePath, 0o755);
  const probe = await (options.probe || probeFilesystemHelper)(executablePath, {
    platform,
    arch,
  });
  return { executablePath, probe };
}

module.exports = {
  StrictJsonScanner,
  assertLinuxStaticExecutable,
  buildNativeFilesystemHelper,
  electronTarget,
  exactKeys,
  helperFilename,
  parseProbeLine,
  probeFilesystemHelper,
  validRustTargets,
};

if (require.main === module) {
  buildNativeFilesystemHelper()
    .then(({ executablePath, probe }) => {
      process.stdout.write(
        `Built filesystem helper ${probe.build} (${probe.target}) at ${executablePath}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
