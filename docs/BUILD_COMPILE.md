# META Mover Build and Compilation Guide

## Prerequisites

### Required Software

**Node.js 18.x or higher**
- Download from https://nodejs.org/
- Verify installation: `node --version`

**npm 9.x or higher**
- Included with Node.js
- Verify installation: `npm --version`

### Platform-Specific Requirements

**macOS**
- Xcode Command Line Tools: `xcode-select --install`
- For code signing: Apple Developer account and certificates

**Windows**
- Windows SDK (for building native modules)
- Visual Studio Build Tools or Visual Studio 2019/2022

**Linux**
- Build essentials: `sudo apt-get install build-essential`
- For AppImage: `libfuse2` or `libfuse3`
- For snapcraft: `snapd` and `snapcraft`

## Installation

Install all project dependencies:

```bash
npm install
```

This installs:
- Electron framework
- React 19 and dependencies
- Redux Toolkit
- TypeScript compiler
- Webpack and loaders
- electron-builder for packaging
- Development tools and linters

## Development Build

Build the application for development with source maps and debugging enabled:

```bash
npm run build:dev
```

This command:
1. Compiles TypeScript to JavaScript
2. Bundles Main, Preload, and Renderer processes separately
3. Generates source maps for debugging
4. Outputs to `dist/` directory

Individual process builds:
```bash
npm run build:main       # Main process only
npm run build:preload    # Preload script only
npm run build:renderer   # Renderer (React app) only
```

## Production Build

Build optimized production bundles:

```bash
npm run build
```

Production optimizations include:
- Minification and tree-shaking
- Dead code elimination
- Asset optimization
- No source maps (smaller bundle size)

## Distribution Packages

### All Platforms

Build installers for all supported platforms:

```bash
npm run dist
```

This creates installers in the `release/` directory for:
- macOS (DMG, PKG)
- Windows (NSIS, MSI, AppX)
- Linux (AppImage, DEB, RPM, Snap)

### Platform-Specific Builds

**macOS**
```bash
npm run dist:mac
```
Generates:
- DMG installer (universal binary for Intel and Apple Silicon)
- PKG installer (for enterprise deployment)

**Windows**
```bash
npm run dist:win
```
Generates:
- NSIS installer (default, recommended)
- MSI installer (enterprise deployment)
- AppX package (Microsoft Store)

**Linux**
```bash
npm run dist:linux
```
Generates:
- AppImage (portable, distribution-agnostic)
- DEB package (Debian/Ubuntu)
- RPM package (Fedora/RHEL/CentOS)
- Snap package (cross-distribution)

### Individual Package Formats

**Linux Formats:**
```bash
npm run dist:appimage    # Portable AppImage
npm run dist:deb         # Debian/Ubuntu package
npm run dist:rpm         # Fedora/RHEL package
npm run dist:snap        # Snap package
```

**macOS Formats:**
```bash
npm run dist:dmg         # Disk image installer
npm run dist:pkg         # Installer package
```

**Windows Formats:**
```bash
npm run dist:nsis        # NSIS installer
npm run dist:msi         # Windows Installer package
npm run dist:appx        # Microsoft Store package
```

## Clean Commands

Remove build artifacts and caches:

```bash
npm run clean            # Clean dist/ directory
npm run clean:dist       # Clean release/ directory
npm run clean:release    # Same as clean:dist
npm run clean:all        # Clean all build outputs
```

Manual cleanup:
```bash
rm -rf dist/             # Remove build output
rm -rf release/          # Remove distribution packages
rm -rf node_modules/     # Remove dependencies (requires npm install)
```

## Build Scripts

Custom build scripts are located in the `scripts/` directory:

**scripts/build.js**
- Main build orchestration script
- Runs Webpack for all processes
- Handles pre-build and post-build tasks

**scripts/package.js**
- Invokes electron-builder with platform-specific configurations
- Manages code signing and notarization (macOS)
- Generates checksums for release artifacts

**scripts/clean.js**
- Cleanup utility for build artifacts
- Safe deletion with confirmations

## Webpack Build Pipeline

### Main Process (`config/webpack.main.config.js`)

Compiles `src/main/index.ts` and all Main process dependencies:
- Target: `electron-main`
- Output: `dist/main.js`
- TypeScript compilation via ts-loader
- Source maps in development mode

### Preload Script (`config/webpack.preload.config.js`)

Compiles `src/preload/index.ts`:
- Target: `electron-preload`
- Output: `dist/preload.js`
- Isolated bundle (no shared modules with Main or Renderer)

### Renderer Process (`config/webpack.renderer.config.js`)

Compiles React application:
- Target: `electron-renderer`
- Output: `dist/renderer.js`, `dist/index.html`
- CSS processing via css-loader and style-loader
- Hot Module Replacement (HMR) in development
- Production optimizations (minification, code splitting)

## electron-builder Configuration

Configuration is defined in the `"build"` section of `package.json`:

```json
{
  "build": {
    "appId": "com.metamover.app",
    "productName": "META Mover",
    "directories": {
      "output": "release",
      "buildResources": "resources"
    },
    "files": [
      "dist/**/*",
      "package.json"
    ],
    "mac": {
      "target": ["dmg", "pkg"],
      "category": "public.app-category.utilities",
      "icon": "resources/icons/icon.icns"
    },
    "win": {
      "target": ["nsis", "msi"],
      "icon": "resources/icons/icon.ico"
    },
    "linux": {
      "target": ["AppImage", "deb", "rpm", "snap"],
      "category": "Utility",
      "icon": "resources/icons/"
    }
  }
}
```

### Key Configuration Options

**appId**
- Unique application identifier
- Used for system integration and updates

**productName**
- Human-readable application name
- Displayed in installers and application menus

**directories.output**
- Where distribution packages are saved
- Default: `release/`

**directories.buildResources**
- Location of icons, entitlements, and platform-specific resources
- Default: `resources/`

**files**
- Files to include in the packaged application
- Must include compiled `dist/` directory and `package.json`

## Resources Directory

The `resources/` directory contains platform-specific build assets:

**resources/icons/**
- `icon.icns` - macOS application icon
- `icon.ico` - Windows application icon
- `icon.png` (various sizes) - Linux application icons

**resources/entitlements/**
- `entitlements.mac.plist` - macOS entitlements for hardened runtime
- `entitlements.mas.plist` - Mac App Store specific entitlements

**resources/dmg/**
- `background.png` - DMG installer background image
- `dmg-spec.json` - DMG layout configuration

**resources/installer/**
- `installer.nsh` - Custom NSIS installer script (Windows)
- `license.txt` - License agreement shown during installation

## Code Signing and Notarization

### macOS

Set environment variables for code signing:

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=certificate_password
export APPLE_ID=your_apple_id@example.com
export APPLE_APP_SPECIFIC_PASSWORD=app_specific_password
```

Build and notarize:
```bash
npm run dist:mac
```

electron-builder automatically handles:
- Code signing with Developer ID certificate
- Notarization via Apple's notary service
- Stapling notarization ticket to DMG

### Windows

Set environment variables for code signing:

```bash
export CSC_LINK=/path/to/certificate.pfx
export CSC_KEY_PASSWORD=certificate_password
```

Build signed installer:
```bash
npm run dist:win
```

## Continuous Integration

### GitHub Actions Example

```yaml
name: Build and Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run build
      - run: npm run dist
      - uses: actions/upload-artifact@v3
        with:
          name: ${{ matrix.os }}-release
          path: release/
```

## Troubleshooting

### Build Fails on Native Modules

Rebuild native modules for Electron:
```bash
npm rebuild --runtime=electron --disturl=https://electronjs.org/headers
```

### Out of Memory Errors

Increase Node.js heap size:
```bash
export NODE_OPTIONS=--max_old_space_size=4096
npm run build
```

### Linux AppImage Not Running

Install FUSE:
```bash
# Ubuntu/Debian
sudo apt install libfuse2

# Fedora
sudo dnf install fuse-libs
```

Make AppImage executable:
```bash
chmod +x META-Mover-*.AppImage
```

### Windows Build Fails with MSBuild Errors

Install Visual Studio Build Tools:
```bash
npm install --global windows-build-tools
```

### macOS Code Signing Fails

Verify certificate is installed:
```bash
security find-identity -v -p codesigning
```

Check entitlements file is valid:
```bash
plutil -lint resources/entitlements/entitlements.mac.plist
```

## Build Performance Tips

1. **Use build cache:** Do not delete `node_modules/.cache/` between builds
2. **Parallel builds:** electron-builder builds platforms in parallel by default
3. **Incremental compilation:** Use `npm run build:dev` during development
4. **Exclude unnecessary files:** Update `files` in package.json build config
5. **Multi-core compilation:** Webpack uses available CPU cores automatically

## Release Checklist

Before building a release:

1. Update version in `package.json`
2. Update CHANGELOG.md with release notes
3. Run full test suite: `npm test`
4. Clean previous builds: `npm run clean:all`
5. Build production bundles: `npm run build`
6. Build distribution packages: `npm run dist`
7. Test installers on target platforms
8. Create git tag: `git tag v1.0.0`
9. Push tag: `git push origin v1.0.0`
10. Upload release artifacts to GitHub Releases or distribution platform

## Output Artifacts

After a successful build, expect the following in `release/`:

**macOS:**
- `META-Mover-{version}.dmg` - Disk image installer
- `META-Mover-{version}.pkg` - Package installer
- `META-Mover-{version}-mac.zip` - Application bundle (for updates)

**Windows:**
- `META-Mover-Setup-{version}.exe` - NSIS installer
- `META-Mover-{version}.msi` - MSI installer
- `META-Mover-{version}.appx` - AppX package

**Linux:**
- `META-Mover-{version}.AppImage` - Portable executable
- `meta-mover_{version}_amd64.deb` - Debian package
- `meta-mover-{version}.x86_64.rpm` - RPM package
- `meta-mover_{version}_amd64.snap` - Snap package

All artifacts include checksums in `latest-*.yml` files for auto-update functionality.
