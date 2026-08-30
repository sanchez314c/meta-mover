# Build resources

This directory contains package assets referenced by `package.json`.

- `icons/`: Electron Builder icons
- `entitlements.mac.plist`: macOS hardened-runtime entitlements
- `entitlements.mac.inherit.plist`: retained legacy entitlement file, not the active inherited entitlement path
- `license.txt`: installer license text
- `resources/main-app-window.png`: application screenshot asset
- `generate-placeholder-icons.sh`: local icon helper

Executable processing tools are not stored here. `scripts/stage-bundled-tools.js` builds `.build-tools/tools` from the locked dependency graph and pinned Rust sources, then writes a strict schema-3 manifest.

The existing icons must be reviewed as release assets. Their presence is not proof of finished branding.

Package status:

- Linux x64 `deb` and `rpm`: current local proof
- macOS PKG: requires signed native package and attestor proof
- Windows NSIS: requires signed native package and attestor proof
- AppImage, Snap, archives, portable, and user-scoped installs: unsupported
