'use strict';

const fs = require('fs');
const path = require('path');

const {
  assertPackageConfig,
  findForbiddenRuntimeReferences,
  findMissingNativeAbiReferencesInAsar,
  findPackagedToolRoots,
  findPythonArtifactsInAsar,
  findUpdaterArtifacts,
  verifyToolResources,
  walkFiles,
} = require('./package-integrity-lib');

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assertPackageConfig(packageJson);

  const scanTargets = [
    argumentValue('--source'),
    argumentValue('--config'),
    argumentValue('--dist'),
  ].filter(Boolean);
  const failures = scanTargets.flatMap((target) => findForbiddenRuntimeReferences(path.resolve(target)));
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure.rule}: ${failure.file}:${failure.line}: ${failure.match}\n`);
    }
    throw new Error(`Found ${failures.length} forbidden packaged-runtime reference(s)`);
  }

  const resources = argumentValue('--resources');
  if (resources) await verifyToolResources(path.resolve(resources));

  const release = argumentValue('--packaged-release');
  if (release) {
    const releaseRoot = path.resolve(release);
    const pythonArtifacts = walkFiles(releaseRoot).filter((filename) => /\.py[co]?$/i.test(filename));
    if (pythonArtifacts.length > 0) {
      throw new Error(`Packaged output contains Python artifacts: ${pythonArtifacts.join(', ')}`);
    }
    const updaterArtifacts = findUpdaterArtifacts(releaseRoot);
    if (updaterArtifacts.length > 0) {
      throw new Error(`Packaged output contains updater metadata: ${updaterArtifacts.join(', ')}`);
    }
    for (const archive of walkFiles(releaseRoot).filter((filename) => filename.endsWith('app.asar'))) {
      const archivedPython = findPythonArtifactsInAsar(archive);
      if (archivedPython.length > 0) {
        throw new Error(`Packaged ASAR contains Python artifacts: ${archivedPython.join(', ')}`);
      }
      const missingNativeModules = findMissingNativeAbiReferencesInAsar(archive);
      if (missingNativeModules.length > 0) {
        throw new Error(`Packaged ASAR has missing native ABI payloads: ${missingNativeModules.join(', ')}`);
      }
    }
    const toolRoots = findPackagedToolRoots(releaseRoot);
    if (toolRoots.length === 0) throw new Error('Packaged output has no application resources/tools manifest');
    for (const toolRoot of toolRoots) await verifyToolResources(toolRoot);
  }

  process.stdout.write('Package integrity verified\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
