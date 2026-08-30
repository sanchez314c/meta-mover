# Contributing

Read [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) before changing processing, metadata, filesystem, or package code.

```bash
npm ci
npm run verify
npm run build
npm run package:integrity
```

New behavior starts with a failing test. Processing and transaction changes must preserve the preview, root-binding, no-clobber, source-conservation, and immutable-evidence contracts. Never add a host tool lookup or runtime installer.

Report security issues privately as described in [SECURITY.md](SECURITY.md).
