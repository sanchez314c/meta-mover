'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PERL_VERSION = '5.42.3';
const PERL_SHA256 = '1137740985837b5cdf15f0cfab932279dcb4352f912fed6fc144e8b4f0823627';
const PERL_URL = `https://www.cpan.org/src/5.0/perl-${PERL_VERSION}.tar.gz`;

function portablePerlBuildPlan(platform = process.platform, arch = process.arch) {
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Portable Perl materialization supports native Linux/macOS x64/arm64 only: ${platform}-${arch}`);
  }
  const target = `${platform}-${arch}`;
  return {
    version: PERL_VERSION,
    sha256: PERL_SHA256,
    url: PERL_URL,
    target,
    output: path.resolve(__dirname, '..', 'native', 'perl', target),
  };
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.stderr || result.error || ''}`);
  }
  return result.stdout || '';
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function buildPortablePerl(options = {}) {
  const basePlan = portablePerlBuildPlan(options.platform, options.arch);
  const plan = { ...basePlan, output: path.resolve(options.output || basePlan.output) };
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meta-mover-perl-'));
  const archive = path.join(temporaryRoot, `perl-${plan.version}.tar.gz`);
  const source = path.join(temporaryRoot, `perl-${plan.version}`);
  const install = path.join(temporaryRoot, 'install');
  const staged = path.join(temporaryRoot, plan.target);
  try {
    run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--output', archive, plan.url]);
    const digest = crypto.createHash('sha256').update(await fs.promises.readFile(archive)).digest('hex');
    if (digest !== plan.sha256) throw new Error('Portable Perl source SHA-256 does not match the pin');
    run('/usr/bin/tar', ['-xzf', archive, '-C', temporaryRoot]);
    run(path.join(source, 'Configure'), [
      '-des',
      `-Dprefix=${install}`,
      '-Uuseshrplib',
      '-Uusedl',
      '-Ddefault_inc_excludes_dot',
      ...(plan.target.startsWith('linux-')
        ? ['-Dldflags=-static', '-Dccflags=-O2', '-Doptimize=-O2']
        : []),
    ], { cwd: source });
    run('/usr/bin/make', ['-j', String(Math.max(1, os.cpus().length))], { cwd: source });
    run('/usr/bin/make', ['install'], { cwd: source });

    const perl = path.join(install, 'bin', 'perl');
    const exiftool = require('exiftool-vendored').exiftoolPath;
    const exiftoolPath = await exiftool();
    const incRoots = run(perl, ['-e', 'print join("\\n", @INC)'])
      .split(/\r?\n/)
      .filter((candidate) => path.isAbsolute(candidate) && isWithin(install, candidate));
    await fs.promises.mkdir(path.join(staged, 'lib'), { recursive: true });
    await fs.promises.copyFile(perl, path.join(staged, 'perl'));
    await fs.promises.chmod(path.join(staged, 'perl'), 0o755);
    const coreRoot = incRoots.find((candidate) => fs.existsSync(path.join(candidate, 'strict.pm')));
    if (!coreRoot) throw new Error('Portable Perl installation has no complete core library root');
    await fs.promises.cp(coreRoot, path.join(staged, 'lib'), { recursive: true, dereference: true });
    for (const candidate of incRoots.filter((root) => root !== coreRoot && isWithin(install, root))) {
      await fs.promises.cp(candidate, path.join(staged, 'lib'), { recursive: true, dereference: true });
    }
    for (const required of ['strict.pm', 'warnings.pm', 'Time/Local.pm', 'File/Basename.pm']) {
      if (!fs.existsSync(path.join(staged, 'lib', required))) {
        throw new Error(`Portable Perl core closure is missing ${required}`);
      }
    }
    await fs.promises.mkdir(path.dirname(plan.output), { recursive: true });
    await fs.promises.rename(staged, plan.output);
    return plan;
  } finally {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
  }
}

module.exports = { buildPortablePerl, portablePerlBuildPlan };

if (require.main === module) {
  buildPortablePerl()
    .then((plan) => process.stdout.write(`Materialized portable Perl ${plan.version} for ${plan.target}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
