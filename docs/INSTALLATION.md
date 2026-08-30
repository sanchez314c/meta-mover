# Installation

## Verified release status

Linux x64 `deb` and `rpm` packages are the current locally proved targets. They install under an administrator-controlled system location and carry all non-OS processing tools.

```bash
sudo dpkg -i META-Mover-1.0.0-x64.deb
# or
sudo rpm -i META-Mover-1.0.0-x64.rpm
```

Do not relocate or unpack the installed application into a user-writable directory. Runtime health rejects a writable or unauthenticated production tool tree.

AppImage, Snap, archive, and portable targets are not supported. They cannot satisfy the current immutable-root trust contract.

## macOS and Windows

The repository contains native helper and broker CI gates plus package configuration for signed system installs. This Linux-host refit does not claim native runtime proof for either platform.

- macOS requires a signed, notarized PKG installed under `/Applications` and a platform attestor.
- Windows requires a signed, per-machine NSIS install under Program Files and a platform attestor.

Do not distribute unsigned builds as supported releases.

## Source setup

```bash
npm ci
npm run package:stage-tools
npm run dev
```

Source development requires Node.js 22.12+, npm 10.9, Rust 1.85.1, and the current platform compiler toolchain. It does not require Python, SQLite, FFmpeg, or a system ExifTool installation.
