'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveArtifactType(artifact, requestedType) {
  if (!requestedType) throw new Error('Native package type is required');
  const type = String(requestedType).toLowerCase();
  if (!['deb', 'rpm'].includes(type)) throw new Error('Native package type must be deb or rpm');
  if (path.extname(artifact).toLowerCase() !== `.${type}`) {
    throw new Error(`Native package extension does not match type ${type}`);
  }
  return type;
}

function waitFor(child, label) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with status ${code}`));
    });
  });
}

async function extractPackage(artifact, type, destination) {
  if (type === 'deb') {
    const result = childProcess.spawnSync('dpkg-deb', ['-x', artifact, destination], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`dpkg-deb extraction failed: ${result.stderr || result.error || ''}`);
    }
    return;
  }
  const converter = childProcess.spawn('rpm2cpio', [artifact], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const extractor = childProcess.spawn('cpio', ['-idm', '--quiet'], {
    cwd: destination,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  converter.stdout.pipe(extractor.stdin);
  await Promise.all([waitFor(converter, 'rpm2cpio'), waitFor(extractor, 'cpio')]);
}

async function verifyNativePackage(artifact, requestedType) {
  const resolved = path.resolve(artifact);
  const type = resolveArtifactType(resolved, requestedType);
  const stats = await fs.promises.stat(resolved);
  if (!stats.isFile()) throw new Error('Native package artifact is not a regular file');
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meta-mover-package-'));
  try {
    await extractPackage(resolved, type, temporaryRoot);
    const verifier = path.resolve(__dirname, 'verify-package-integrity.js');
    const result = childProcess.spawnSync(
      process.execPath,
      [verifier, '--packaged-release', temporaryRoot],
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', stdio: 'inherit' }
    );
    if (result.status !== 0) throw new Error(`Extracted ${type} package failed integrity verification`);
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

module.exports = { extractPackage, resolveArtifactType, verifyNativePackage };

if (require.main === module) {
  verifyNativePackage(argumentValue('--artifact'), argumentValue('--type'))
    .then(() => process.stdout.write('Native package integrity verified\n'))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
