# Deployment

How to build and distribute META Mover across all three platforms.

## Prerequisites

- Node.js 18+ and npm 9+
- Platform-specific toolchains (see below)
- All dependencies installed: `npm install`

## Build Outputs

All distribution artifacts land in `release/` after a successful `npm run dist` run.

## Platform Toolchain Requirements

### macOS

```bash
xcode-select --install
```

For signed and notarized builds, export these environment variables before running `npm run dist:mac`:

```bash
export CSC_LINK=/path/to/Developer-ID.p12
export CSC_KEY_PASSWORD=your-cert-password
export APPLE_ID=your@apple-id.com
export APPLE_APP_SPECIFIC_PASSWORD=app-specific-password
```

The `package.json` build config sets `"notarize": false` by default. Enable it by setting `"notarize": true` in the `mac` block and providing the credentials above.

### Windows

Install Visual Studio Build Tools 2019 or 2022 (needed for `sharp` and `sqlite3` native module compilation). On machines without full Visual Studio:

```bash
npm install --global windows-build-tools
```

For code-signed Windows builds:

```bash
export CSC_LINK=/path/to/code-signing.pfx
export CSC_KEY_PASSWORD=cert-password
```

### Linux

```bash
sudo apt-get install build-essential libgtk-3-dev libnotify-dev \
  libnss3-dev libasound2-dev libdrm2 libxcomposite1 \
  libxdamage1 libxrandr2 libgbm1 xdg-utils
```

For Snap packaging:
```bash
sudo apt install snapd snapcraft
```

For AppImage on build machines:
```bash
sudo apt install libfuse2
```

## Build Commands

```bash
# Full production webpack build (all 4 webpack targets: main, preload, renderer, worker)
npm run build

# All platforms (requires macOS for .dmg, Windows for .exe/.msi)
npm run dist

# Platform-specific
npm run dist:mac          # DMG + PKG + ZIP (x64, arm64, universal)
npm run dist:win          # NSIS + MSI + AppX + portable + ZIP (x64, ia32, arm64)
npm run dist:linux        # AppImage + DEB + RPM + Snap + tar.gz (x64, arm64)

# Specific format overrides
npm run dist:mac:dmg
npm run dist:win:nsis
npm run dist:linux:appimage
npm run dist:linux:deb
npm run dist:linux:rpm
```

## Output Artifacts

After `npm run dist`, the `release/` directory contains:

**macOS:**
- `META Mover-1.0.0-x64.dmg`
- `META Mover-1.0.0-arm64.dmg`
- `META Mover-1.0.0-universal.dmg`
- `META Mover-1.0.0-x64.pkg`
- `META Mover-1.0.0-mac.zip`
- `latest-mac.yml` (auto-update manifest)

**Windows:**
- `META Mover-1.0.0-x64.exe` (NSIS)
- `META Mover-1.0.0-ia32.exe`
- `META Mover-1.0.0-x64.msi`
- `META Mover-1.0.0-x64.appx`
- `META Mover-1.0.0-x64-win.zip`
- `latest.yml` (auto-update manifest)

**Linux:**
- `META Mover-1.0.0-x64.AppImage`
- `meta-mover_1.0.0_amd64.deb`
- `meta-mover-1.0.0.x86_64.rpm`
- `meta-mover_1.0.0_amd64.snap`
- `META Mover-1.0.0-x64.tar.gz`
- `latest-linux.yml` (auto-update manifest)

## Auto-Updates

`electron-updater` is initialized in `src/main/index.ts` via `setupAutoUpdater()`, which calls `autoUpdater.checkForUpdatesAndNotify()`. This only runs in production (`!isDevelopment`). The update feed is configured in the `publish` block of `package.json`:

```json
"publish": [{
  "provider": "github",
  "owner": "sanchez314c",
  "repo": "meta-mover"
}]
```

To trigger an update release, tag the commit and push:

```bash
git tag v1.0.1
git push origin v1.0.1
```

GitHub Actions (`.github/workflows/release.yml`) picks up the tag and runs the dist build.

## Clean Build

Before a release build, clean all prior artifacts:

```bash
npm run clean:all   # Removes dist/, release/, node_modules/, package-lock.json
npm install
npm run build
npm run dist
```

## Electron Sandbox on Linux

The app launches with `--no-sandbox` (see `package.json` `scripts.start` and `scripts.dev`). This is required on Linux hosts where `kernel.unprivileged_userns_clone` is 0. If running in a CI environment that supports user namespaces:

```bash
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

## Release Checklist

1. Update `version` in `package.json`
2. Add entry to `CHANGELOG.md`
3. Run `npm run test` — all tests pass
4. Run `npm run typecheck` — no type errors
5. Run `npm run lint:check` — no lint errors
6. Run `npm run clean:all && npm install && npm run build`
7. Smoke test with `npm start`
8. Run `npm run dist` for target platform(s)
9. Test the generated installer on a clean machine
10. Tag: `git tag v1.x.x && git push origin v1.x.x`
