# Deployment

## Release gate

```bash
npm ci
npm run verify
npm run build
npm run package:integrity
npm exec --offline -- electron-builder --dir --linux --x64 --publish never
npm run package:integrity:release
```

Build the native installer only after the unpacked package passes containment checks.

## Current artifacts

The automated release workflow builds Linux x64 `deb` and `rpm` packages on Linux, checks the unpacked application, writes SHA-256 sums, and publishes only tested artifacts.

```bash
npm run dist:linux:deb
npm run dist:linux:rpm
```

There is no updater feed. A release is a new signed or administrator-installed package.

## Platform status

- Linux x64: local staging, broker relay, unpacked package, `deb`, and `rpm` proof
- macOS: native CI gates exist; signed notarized PKG and attestor proof still required
- Windows: native CI gates exist; signed per-machine NSIS and attestor proof still required

Do not publish AppImage, Snap, archive, portable, user-scoped, or unsigned signable builds.

## Release checklist

1. Match the Git tag to `package.json` version.
2. Install from the locked npm registry graph.
3. Pass source, Rust, coverage, build, and package integrity gates.
4. Test the native installer on its target OS.
5. Prove the installed root is authenticated and not user-writable.
6. Run preview and copy smoke tests from the installed app.
7. Publish the artifact and SHA-256 sum together.
