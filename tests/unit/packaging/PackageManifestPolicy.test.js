const fs = require('fs');
const childProcess = require('child_process');
const path = require('path');

const { assertPackageConfig } = require('../../../scripts/package-integrity-lib');

const root = path.resolve(__dirname, '../../..');
const packageJson = require('../../../package.json');

describe('release package policy', () => {
  test('pins the audited build stack to fixed upstream releases', () => {
    expect(packageJson.devDependencies.electron).toBe('44.0.0');
    expect(packageJson.devDependencies['electron-builder']).toBe('26.15.3');
    expect(packageJson.devDependencies['styled-components']).toBe('6.5.3');
    expect(packageJson.devDependencies.jest).toBe('30.5.0');
    expect(packageJson.devDependencies['jest-environment-jsdom']).toBe('30.5.0');
    expect(packageJson.devDependencies['ts-jest']).toBe('29.4.12');
    expect(packageJson.devDependencies['ts-node']).toBe('10.9.2');
    expect(packageJson.devDependencies['wait-on']).toBe('9.1.0');
    expect(packageJson.devDependencies.winston).toBe('3.19.0');
  });

  test('contains no retired runtime or build-only dependencies', () => {
    const retired = [
      '@electron/notarize',
      '@electron/rebuild',
      '@types/lodash',
      '@types/sharp',
      '@types/uuid',
      '@types/winston',
      'copy-webpack-plugin',
      'css-minimizer-webpack-plugin',
      'dmg-builder',
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
      'webpack-merge',
      '7zip-bin',
      'dmg-license',
    ];
    const declared = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.optionalDependencies,
    };
    expect(retired.filter((name) => declared[name])).toEqual([]);
    expect(packageJson.dependencies).toEqual({});
    expect(packageJson.devDependencies).toMatchObject({
      '@reduxjs/toolkit': expect.any(String),
      react: expect.any(String),
      'react-dom': expect.any(String),
      'react-redux': expect.any(String),
    });
  });

  test('builds only the active main, preload, and renderer bundles', () => {
    expect(packageJson.scripts.build).toBe(
      'npm run clean:dist && npm run build:main && npm run build:preload && npm run build:renderer'
    );
    expect(packageJson.scripts['build:dev']).toBe(
      'npm run clean:dist && npm run build:main:dev && npm run build:preload:dev && npm run build:renderer:dev'
    );
    expect(Object.keys(packageJson.scripts)).not.toEqual(
      expect.arrayContaining([
        'build:worker',
        'build:worker:dev',
        'postinstall',
        'dist:linux:appimage',
        'dist:linux:snap',
        'dist:win:portable',
      ])
    );
    expect(fs.existsSync(path.join(root, 'config/webpack.worker.config.js'))).toBe(false);
  });

  test('ships only root-installed native package formats', () => {
    expect(packageJson.desktopName).toBe('com.speedheathens.metamover');
    expect(packageJson.build.publish).toBeNull();
    expect(packageJson.build.directories.app).toBeUndefined();
    expect(packageJson.build.npmRebuild).toBe(false);
    expect(packageJson.build.detectUpdateChannel).toBeUndefined();
    expect(packageJson.build.generateUpdatesFilesForAllChannels).toBeUndefined();
    expect(packageJson.build.linux.target).toEqual([
      { target: 'deb', arch: ['x64'] },
      { target: 'rpm', arch: ['x64'] },
    ]);
    expect(packageJson.build.deb.packageName).toBe('meta-mover');
    expect(packageJson.build.rpm.packageName).toBe('meta-mover');
    expect(packageJson.build.mac.target).toEqual([{ target: 'pkg', arch: ['x64', 'arm64'] }]);
    expect(packageJson.build.mac.identity).not.toBeNull();
    expect(packageJson.build.mac.notarize).not.toBe(false);
    expect(packageJson.build.pkg).toMatchObject({
      allowAnywhere: false,
      allowCurrentUserHome: false,
      allowRootDirectory: true,
      installLocation: '/Applications',
    });
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64', 'arm64'] }]);
    expect(packageJson.build.win.signAndEditExecutable).toBe(true);
    expect(packageJson.build.win.signExecutable).toBe(true);
    expect(packageJson.build.win.signExts).toContain('.dll');
    expect(packageJson.build.win.verifyUpdateCodeSignature).toBe(true);
    expect(packageJson.build.linux.desktop).toHaveProperty('entry.Name', 'META Mover');
    expect(packageJson.build.linux.desktop).toHaveProperty(
      'entry.StartupWMClass',
      packageJson.desktopName
    );
    expect(packageJson.build.linux.syncDesktopName).toBe(true);
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false,
      perMachine: true,
      allowElevation: true,
      allowToChangeInstallationDirectory: false,
    });
    expect(packageJson.build.dmg).toBeUndefined();
    expect(packageJson.build.snap).toBeUndefined();
    expect(packageJson.build.msi).toBeUndefined();
    expect(packageJson.build.appx).toBeUndefined();
    expect(packageJson.scripts['pack:mac']).toBeUndefined();
    expect(packageJson.scripts['pack:win']).toBeUndefined();
    expect(packageJson.scripts['dist:mac']).toBeUndefined();
    expect(packageJson.scripts['dist:win']).toBeUndefined();
    expect(packageJson.scripts['dist']).toBeUndefined();
  });

  test('passes the executable package-integrity policy', () => {
    expect(() => assertPackageConfig(packageJson)).not.toThrow();
    const portableLinux = JSON.parse(JSON.stringify(packageJson));
    portableLinux.build.linux.target.push({ target: 'AppImage', arch: ['x64'] });
    expect(() => assertPackageConfig(portableLinux)).toThrow(/Linux.*deb.*rpm/i);

    const unsignedWindows = JSON.parse(JSON.stringify(packageJson));
    unsignedWindows.build.win.signAndEditExecutable = false;
    expect(() => assertPackageConfig(unsignedWindows)).toThrow(/signed/i);

    const publishingRuntime = JSON.parse(JSON.stringify(packageJson));
    publishingRuntime.build.publish = [{ provider: 'github' }];
    expect(() => assertPackageConfig(publishingRuntime)).toThrow(/publish|updat/i);
  });

  test('stages the self-contained runtime before tests in clean validation', () => {
    expect(packageJson.scripts['test:ci']).toMatch(
      /^npm run package:stage-tools && jest --config config\/jest\.config\.js --ci /
    );
    expect(packageJson.scripts.verify.split(' && ')).toContain('npm run test:ci');

    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    const testStep = ci.indexOf('run: npm run test:ci');
    const installStep = ci.indexOf('run: npm ci');
    expect(testStep).toBeGreaterThan(installStep);
  });
});

describe('Linux source launcher policy', () => {
  const launcherPath = path.join(root, 'run-source-linux.sh');
  const launcher = fs.readFileSync(launcherPath, 'utf8');

  test('stages self-contained tools and preserves Electron sandboxing', () => {
    expect(launcher).toContain('set -euo pipefail');
    expect(launcher).toContain('npm run package:stage-tools');
    expect(launcher).toContain('npm run build:dev');
    expect(launcher).toContain('exec ./node_modules/.bin/electron .');
    expect(launcher).not.toMatch(/--no-sandbox|ELECTRON_DISABLE_(?:GPU_)?SANDBOX|sysctl|sudo/);
  });

  test('never kills ambient processes or installs dependencies implicitly', () => {
    expect(launcher).not.toMatch(/\b(?:pkill|killall|taskkill|kill\s+-9|xargs\s+kill)\b/);
    expect(launcher).not.toMatch(/^\s*npm\s+(?:install|ci)\b/m);
  });
});

describe('bundled Linux Perl policy', () => {
  test('uses the pinned static runtime and a complete symlink-free Perl core closure', () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') return;
    const perl = path.join(root, 'native/perl/linux-x64/perl');
    expect(fs.existsSync(perl)).toBe(true);
    expect(childProcess.execFileSync('/usr/bin/file', ['-b', perl], { encoding: 'utf8' })).toMatch(
      /x86-64.*statically linked/i
    );
    expect(childProcess.execFileSync('/usr/bin/readelf', ['-l', perl], { encoding: 'utf8' })).not.toMatch(
      /Requesting program interpreter/
    );
    expect(childProcess.execFileSync('/usr/bin/readelf', ['-d', perl], { encoding: 'utf8' })).not.toMatch(
      /NEEDED/
    );
    const libraryRoot = path.join(root, 'native/perl/linux-x64/lib');
    const files = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else files.push(path.relative(libraryRoot, absolute).split(path.sep).join('/'));
      }
    };
    walk(libraryRoot);
    expect(files).toHaveLength(2_201);
    expect(files).toEqual(
      expect.arrayContaining([
        'Exporter.pm',
        'Exporter/Heavy.pm',
        'File/Basename.pm',
        'Time/Local.pm',
        'XSLoader.pm',
        'strict.pm',
        'warnings.pm',
        'x86_64-linux/File/Glob.pm',
      ])
    );
    expect(files.some((file) => /\.(?:so|dylib)$/i.test(file))).toBe(false);
    expect(
      childProcess.execFileSync('/usr/bin/find', [libraryRoot, '-type', 'l', '-print'], {
        encoding: 'utf8',
      })
    ).toBe('');
  });
});
