'use strict';

const fs = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const path = require('path');

const {
  hashDirectory,
  inspectNativeRuntime,
  verifyToolResources,
} = require('./package-integrity-lib');
const {
  buildNativeFilesystemHelper,
  electronTarget,
  helperFilename,
  probeFilesystemHelper,
} = require('./build-native-helper');
const {
  brokerFilename,
  buildNativeLaunchBroker,
  probeLaunchBrokerIdentity,
  probeLaunchBrokerRelay,
} = require('./build-launch-broker');

function portablePerlSources(platform, arch, root) {
  if (!['linux', 'darwin'].includes(platform)) {
    throw new Error(`Portable Perl is not used for ${platform}-${arch}`);
  }
  const expectedTarget = `${platform}-${arch}`;
  const expectedRoot = path.resolve(__dirname, '..', 'native', 'perl', expectedTarget);
  const portableRoot = path.resolve(root || expectedRoot);
  if (path.basename(portableRoot) !== expectedTarget) {
    throw new Error(`Portable Perl root does not match native target ${platform}-${arch}`);
  }
  return {
    perl: path.join(portableRoot, 'perl'),
    perlLibRoots: [path.join(portableRoot, 'lib')],
  };
}

async function defaultSources() {
  const { exiftoolPath } = require('exiftool-vendored');
  const nativeHelper = await buildNativeFilesystemHelper();
  const nativeBroker = await buildNativeLaunchBroker({ helper: nativeHelper });
  const sources = {
    exiftool: await exiftoolPath(),
    fsHelper: nativeHelper.executablePath,
    launchBroker: nativeBroker.executablePath,
  };
  if (process.platform !== 'win32') {
    Object.assign(sources, portablePerlSources(process.platform, process.arch));
  }
  return sources;
}

async function sha256(filename) {
  const contents = await fs.promises.readFile(filename);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function executableVersion(command, args, env) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    ...(env ? { env } : {}),
  });
  if (result.status !== 0) {
    throw new Error(`Version check failed for ${command}: ${result.stderr || result.error || ''}`);
  }
  const version = `${result.stdout || ''}\n${result.stderr || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!version) throw new Error(`Version check returned no output for ${command}`);
  return version;
}

async function stageBundledTools(options = {}) {
  const output = path.resolve(options.output || path.join(process.cwd(), '.build-tools', 'tools'));
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error('Tool staging must run on the native target OS and architecture');
  }
  const sources = options.sources || (await defaultSources());
  const parent = path.dirname(output);
  await fs.promises.mkdir(parent, { recursive: true });
  const stagingRoot = await fs.promises.mkdtemp(path.join(parent, '.tools-staging-'));
  const staging = path.join(stagingRoot, 'tools');
  await fs.promises.mkdir(staging);

  try {
    const exiftoolDirectory = path.dirname(sources.exiftool);
    const exiftoolDestination = path.join(staging, 'exiftool');
    await fs.promises.cp(exiftoolDirectory, exiftoolDestination, {
      recursive: true,
      dereference: false,
    });

    const toolPaths = {
      exiftool: path.join('exiftool', path.basename(sources.exiftool)),
      fsHelper: path.join('fs-helper', electronTarget(platform, arch), helperFilename(platform)),
      launchBroker: path.join(
        'launch-broker',
        electronTarget(platform, arch),
        brokerFilename(platform)
      ),
    };
    if (!sources.fsHelper || !path.isAbsolute(sources.fsHelper)) {
      throw new Error('An absolute native filesystem helper binary is required');
    }
    await fs.promises.mkdir(path.dirname(path.join(staging, toolPaths.fsHelper)), {
      recursive: true,
    });
    await fs.promises.copyFile(sources.fsHelper, path.join(staging, toolPaths.fsHelper));
    if (!sources.launchBroker || !path.isAbsolute(sources.launchBroker)) {
      throw new Error('An absolute native launch broker binary is required');
    }
    await fs.promises.mkdir(path.dirname(path.join(staging, toolPaths.launchBroker)), {
      recursive: true,
    });
    await fs.promises.copyFile(sources.launchBroker, path.join(staging, toolPaths.launchBroker));
    if (platform !== 'win32') {
      if (!sources.perl || !path.isAbsolute(sources.perl)) {
        throw new Error('An absolute build-host Perl interpreter is required');
      }
      toolPaths.perl = 'perl';
      await fs.promises.copyFile(sources.perl, path.join(staging, toolPaths.perl));
    }

    if (platform !== 'win32') {
      for (const relativePath of Object.values(toolPaths)) {
        await fs.promises.chmod(path.join(staging, relativePath), 0o755);
      }
    }

    const perlLibs = [];
    if (platform !== 'win32') {
      const perlInc = options.perlInc || sources.perlLibRoots;
      if (!Array.isArray(perlInc) || perlInc.length === 0) {
        throw new Error('A pinned bundled Perl library closure is required');
      }
      for (const [index, sourceDirectory] of perlInc.entries()) {
        const relativePath = path.join('perl-lib', String(index).padStart(2, '0'));
        const destination = path.join(staging, relativePath);
        await fs.promises.cp(sourceDirectory, destination, { recursive: true, dereference: true });
        const digest = await hashDirectory(destination);
        perlLibs.push({ path: relativePath.split(path.sep).join('/'), ...digest });
      }
    }

    const versionArguments = {
      perl: ['-v'],
    };
    const tools = [];
    const fsHelperProbe = options.fsHelperProbe || probeFilesystemHelper;
    const helperProbe = await fsHelperProbe(path.join(staging, toolPaths.fsHelper), {
      platform,
      arch,
    });
    const launchBrokerIdentityProbe =
      options.launchBrokerIdentityProbe || probeLaunchBrokerIdentity;
    const launchBrokerRelayProbe = options.launchBrokerRelayProbe || probeLaunchBrokerRelay;
    const brokerIdentity = await launchBrokerIdentityProbe(
      path.join(staging, toolPaths.launchBroker),
      { platform, arch }
    );
    const brokerRelay = await launchBrokerRelayProbe(path.join(staging, toolPaths.launchBroker), {
      platform,
      arch,
    });
    const helperDigest = await sha256(path.join(staging, toolPaths.fsHelper));
    if (
      brokerIdentity.helperSha256 !== helperDigest ||
      brokerIdentity.helperProtocol !== helperProbe.protocol ||
      brokerIdentity.helperBuild !== helperProbe.build ||
      brokerIdentity.helperTarget !== electronTarget(platform, arch) ||
      brokerRelay.protocol !== helperProbe.protocol ||
      brokerRelay.build !== helperProbe.build ||
      brokerRelay.target !== helperProbe.target
    ) {
      throw new Error('Launch broker evidence is not bound to the staged filesystem helper');
    }
    for (const [name, relativePath] of Object.entries(toolPaths)) {
      const executablePath = path.join(staging, relativePath);
      const version =
        name === 'fsHelper'
          ? helperProbe.build
          : name === 'launchBroker'
            ? brokerIdentity.brokerBuild
            : name === 'exiftool' && platform !== 'win32'
              ? executableVersion(path.join(staging, toolPaths.perl), [executablePath, '-ver'], {
                  LANG: 'C',
                  LC_ALL: 'C',
                  PATH: path.dirname(path.join(staging, toolPaths.perl)),
                  PERL5LIB: [
                    path.join(staging, 'exiftool', 'lib'),
                    ...perlLibs.map((entry) => path.join(staging, entry.path)),
                  ].join(path.delimiter),
                  PERL_USE_UNSAFE_INC: '0',
                })
              : executableVersion(executablePath, versionArguments[name] || ['-ver']);
      tools.push({
        name: name === 'fsHelper' ? 'fs-helper' : name === 'launchBroker' ? 'launch-broker' : name,
        path: relativePath.split(path.sep).join('/'),
        version,
        sha256: await sha256(executablePath),
        ...(name === 'fsHelper'
          ? {
              target: electronTarget(platform, arch),
              protocolVersion: helperProbe.protocol,
              buildVersion: helperProbe.build,
            }
          : {}),
        ...(name === 'launchBroker'
          ? {
              target: electronTarget(platform, arch),
              rustTarget: brokerIdentity.brokerTarget,
              buildVersion: brokerIdentity.brokerBuild,
              helperSha256: brokerIdentity.helperSha256,
              helperProtocolVersion: brokerIdentity.helperProtocol,
              helperBuildVersion: brokerIdentity.helperBuild,
              releaseSigner: brokerIdentity.releaseSigner,
            }
          : {}),
        ...(name === 'exiftool' && platform !== 'win32'
          ? {
              supportDirectory: {
                path: path.join('exiftool', 'lib').split(path.sep).join('/'),
                ...(await hashDirectory(path.join(staging, 'exiftool', 'lib'))),
              },
            }
          : {}),
      });
    }
    const manifest = {
      schemaVersion: 3,
      platform,
      arch,
      tools,
      ...(platform === 'win32' ? {} : { perlLibs }),
      runtimeCompatibility: await (options.runtimeInspector || inspectNativeRuntime)(
        path.join(staging, platform === 'win32' ? toolPaths.exiftool : toolPaths.perl),
        platform,
        arch
      ),
    };
    await fs.promises.writeFile(
      path.join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
    await verifyToolResources(staging, {
      platform,
      perlProbe: options.perlProbe,
      runtimeInspector: options.runtimeInspector,
      fsHelperProbe,
      launchBrokerIdentityProbe,
      launchBrokerRelayProbe,
      linuxStaticInspector: options.linuxStaticInspector,
    });
    await fs.promises.rm(output, { recursive: true, force: true });
    await fs.promises.rename(staging, output);
    return manifest;
  } finally {
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
  }
}

function assertNativeBuildContext(context) {
  const archNames = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];
  const targetPlatform = context?.electronPlatformName || process.platform;
  const targetArch =
    typeof context?.arch === 'number' ? archNames[context.arch] : context?.arch || process.arch;
  if (targetPlatform !== process.platform || targetArch !== process.arch) {
    throw new Error('Tool packaging must run on the native target OS and architecture');
  }
  return { platform: targetPlatform, arch: targetArch };
}

module.exports = async function electronBuilderBeforePack(context) {
  const target = assertNativeBuildContext(context);
  await stageBundledTools(target);
};
module.exports.assertNativeBuildContext = assertNativeBuildContext;
module.exports.portablePerlSources = portablePerlSources;
module.exports.stageBundledTools = stageBundledTools;

if (require.main === module) {
  stageBundledTools()
    .then((manifest) => {
      process.stdout.write(
        `Staged ${manifest.tools.length} tools for ${manifest.platform}-${manifest.arch}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
