'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');

const {
  StrictJsonScanner,
  assertLinuxStaticExecutable,
  buildNativeFilesystemHelper,
  electronTarget,
  exactKeys,
  probeFilesystemHelper,
  validRustTargets,
} = require('./build-native-helper');

const BROKER_MANIFEST = path.resolve(__dirname, '..', 'native', 'launch-broker', 'Cargo.toml');
const MAX_LINE_BYTES = 65_536;

function brokerFilename(platform = process.platform) {
  return platform === 'win32' ? 'meta-mover-launch-broker.exe' : 'meta-mover-launch-broker';
}

async function sha256(filename) {
  return crypto
    .createHash('sha256')
    .update(await fs.promises.readFile(filename))
    .digest('hex');
}

function parseBrokerIdentityLine(stdout) {
  if (
    !Buffer.isBuffer(stdout) ||
    stdout.length < 2 ||
    stdout.length > MAX_LINE_BYTES ||
    stdout[stdout.length - 1] !== 0x0a ||
    stdout.subarray(0, -1).includes(0x0a)
  ) {
    throw new Error('Launch broker identity returned invalid newline-terminated JSON');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout.subarray(0, -1));
  } catch (error) {
    throw new Error(`Launch broker identity is not valid UTF-8: ${error.message}`);
  }
  new StrictJsonScanner(text).scan();
  const identity = JSON.parse(text);
  exactKeys(
    identity,
    [
      'brokerBuild',
      'brokerTarget',
      'helperSha256',
      'helperProtocol',
      'helperBuild',
      'helperTarget',
      'releaseSigner',
    ],
    'Launch broker identity'
  );
  if (
    typeof identity.brokerBuild !== 'string' ||
    identity.brokerBuild.length === 0 ||
    typeof identity.brokerTarget !== 'string' ||
    !/^[a-f0-9]{64}$/.test(identity.helperSha256 || '') ||
    identity.helperProtocol !== 1 ||
    typeof identity.helperBuild !== 'string' ||
    identity.helperBuild.length === 0 ||
    typeof identity.helperTarget !== 'string' ||
    !(
      identity.releaseSigner === null ||
      (typeof identity.releaseSigner === 'string' &&
        identity.releaseSigner.length > 0 &&
        !/[\0\r\n]/.test(identity.releaseSigner))
    )
  ) {
    throw new Error('Launch broker identity does not match contract v1');
  }
  return identity;
}

async function probeLaunchBrokerIdentity(executablePath, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Launch broker identity probe must run on the native target');
  }
  const result = childProcess.spawnSync(executablePath, ['--identity'], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: MAX_LINE_BYTES,
  });
  if (result.status !== 0) {
    throw new Error(
      `Launch broker identity probe failed: ${String(result.stderr || result.error || '')}`
    );
  }
  const identity = parseBrokerIdentityLine(result.stdout || Buffer.alloc(0));
  if (!validRustTargets(platform, arch).includes(identity.brokerTarget)) {
    throw new Error(`Launch broker Rust target does not match ${platform}-${arch}`);
  }
  if (identity.helperTarget !== electronTarget(platform, arch)) {
    throw new Error('Launch broker helper target does not match its package target');
  }
  return identity;
}

async function probeLaunchBrokerRelay(executablePath, options = {}) {
  return probeFilesystemHelper(executablePath, options);
}

async function stageBrokerRelayProof(brokerPath, helperPath, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = electronTarget(platform, arch);
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meta-mover-broker-proof-'));
  const broker = path.join(root, 'tools', 'launch-broker', target, brokerFilename(platform));
  const helper = path.join(
    root,
    'tools',
    'fs-helper',
    target,
    platform === 'win32' ? 'meta-mover-fs-helper.exe' : 'meta-mover-fs-helper'
  );
  try {
    await fs.promises.mkdir(path.dirname(broker), { recursive: true });
    await fs.promises.mkdir(path.dirname(helper), { recursive: true });
    await fs.promises.copyFile(brokerPath, broker);
    await fs.promises.copyFile(helperPath, helper);
    if (platform !== 'win32') {
      await fs.promises.chmod(broker, 0o755);
      await fs.promises.chmod(helper, 0o755);
    }
    return await probeLaunchBrokerRelay(broker, { platform, arch });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

async function buildNativeLaunchBroker(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = electronTarget(platform, arch);
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Launch broker must be built on the native target OS and architecture');
  }
  const helper = options.helper || (await buildNativeFilesystemHelper({ platform, arch }));
  const helperSha256 = await sha256(helper.executablePath);
  const cargo = options.cargo || process.env.CARGO || 'cargo';
  const targetDirectory = path.resolve(
    options.targetDirectory || path.join(path.dirname(BROKER_MANIFEST), 'target')
  );
  const cargoArguments = [
    platform === 'linux' ? 'rustc' : 'build',
    '--release',
    '--locked',
    '--manifest-path',
    BROKER_MANIFEST,
    '--target-dir',
    targetDirectory,
    ...(platform === 'linux'
      ? ['--bin', 'meta-mover-launch-broker', '--', '-C', 'target-feature=+crt-static']
      : []),
  ];
  const env = {
    ...process.env,
    META_MOVER_EXPECTED_HELPER_SHA256: helperSha256,
    META_MOVER_EXPECTED_HELPER_PROTOCOL: String(helper.probe.protocol),
    META_MOVER_EXPECTED_HELPER_BUILD: helper.probe.build,
    META_MOVER_EXPECTED_HELPER_TARGET: target,
    META_MOVER_RELEASE_SIGNER: options.releaseSigner || process.env.META_MOVER_RELEASE_SIGNER || '',
  };
  const result = childProcess.spawnSync(cargo, cargoArguments, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env,
  });
  if (result.status !== 0) {
    throw new Error(`Launch broker build failed: ${result.stderr || result.error || ''}`);
  }
  const executablePath = path.join(targetDirectory, 'release', brokerFilename(platform));
  const stats = await fs.promises.lstat(executablePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Launch broker build did not produce a regular binary');
  }
  if (platform === 'linux') await assertLinuxStaticExecutable(executablePath);
  if (platform !== 'win32') await fs.promises.chmod(executablePath, 0o755);
  const identity = await (options.identityProbe || probeLaunchBrokerIdentity)(executablePath, {
    platform,
    arch,
  });
  if (
    identity.helperSha256 !== helperSha256 ||
    identity.helperProtocol !== helper.probe.protocol ||
    identity.helperBuild !== helper.probe.build ||
    identity.helperTarget !== target ||
    identity.releaseSigner !== (env.META_MOVER_RELEASE_SIGNER || null)
  ) {
    throw new Error('Launch broker compiled identity does not match the built helper');
  }
  const relay = await (options.relayProof || stageBrokerRelayProof)(
    executablePath,
    helper.executablePath,
    { platform, arch }
  );
  if (relay.protocol !== helper.probe.protocol || relay.build !== helper.probe.build) {
    throw new Error('Launch broker relay evidence does not match the built helper');
  }
  return { executablePath, identity, relay, helper };
}

module.exports = {
  brokerFilename,
  buildNativeLaunchBroker,
  parseBrokerIdentityLine,
  probeLaunchBrokerIdentity,
  probeLaunchBrokerRelay,
  stageBrokerRelayProof,
};

if (require.main === module) {
  buildNativeLaunchBroker()
    .then(({ executablePath, identity }) => {
      process.stdout.write(
        `Built launch broker ${identity.brokerBuild} (${identity.brokerTarget}) at ${executablePath}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
