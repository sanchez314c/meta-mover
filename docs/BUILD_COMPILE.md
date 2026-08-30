# Build and compile

## Requirements

- Node.js 22.12 or newer
- npm 10.9
- Rust 1.85.1
- Native compiler and linker for the current OS

## Source build

```bash
npm ci
npm run package:stage-tools
npm run build
```

Webpack writes separate main, preload, and renderer bundles under `dist/`. No worker bundle exists.

## Native binaries

```bash
npm run native:verify
npm run native:broker:build
```

The filesystem helper and launch broker use pinned Cargo lockfiles. Formatting and clippy warnings are hard failures.

## Package staging

```bash
npm run package:integrity:source
npm run package:stage-tools
npm run package:integrity
```

Staging builds the current-platform Rust binaries, copies ExifTool and Perl support files, writes the schema-3 manifest, and performs identity probes. It does not download or install host tools.

## Linux packages

```bash
npm run dist:linux:deb
npm run dist:linux:rpm
```

The supported Linux target is x64. Build on Linux and verify the unpacked package before producing the installer. Cross-host all-platform packaging is intentionally absent.
