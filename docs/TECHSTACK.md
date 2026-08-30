# Technology stack

## Application

- Electron 38
- React 19
- TypeScript
- Redux Toolkit
- styled-components
- Webpack 5

## Processing and persistence

- `exiftool-vendored` as a build-time source for staged ExifTool files
- Static Perl runtime on platforms that require it
- Rust filesystem helper for capability-relative, no-clobber mutations
- Rust launch broker for authenticated immutable helper execution
- Node crypto SHA-256
- Strict JSON and append-only JSONL persistence

## Quality and packaging

- Jest and Testing Library
- ESLint and Prettier
- Cargo fmt, clippy, and native tests
- electron-builder
- npm lockfile with registry-only provenance checks

There is no Python, SQLite, FFmpeg, ffprobe, Sharp, Exifr, auto-updater, or runtime package installer in the active package.

Dependency versions are authoritative in `package.json`, both Cargo manifests, and their lockfiles. Platform support is authoritative in [Deployment](DEPLOYMENT.md), not inferred from a dependency's advertised portability.
