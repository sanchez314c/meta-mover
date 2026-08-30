# META Mover

META Mover is a local Electron app for sorting mixed media by the best available creation-date evidence. It reads embedded metadata, filename dates, and filesystem timestamps, then shows the proposed result before touching media.

It does not rewrite metadata or declare an uncertain timestamp to be fact. Ambiguous files go to `_Needs Review` with their evidence and warnings intact.

Inventory covers every regular file in the selected source folders. Recognized formats enter metadata planning. Unsupported or unrecognized files remain unchanged and appear as explicit skipped `Needs Review` rows instead of disappearing from the report.

## Safety model

- Preview is required and does not mutate media.
- Copy is the default. Move requires an explicit acknowledgement.
- Source and destination roots must be separate, canonical directories.
- One or more source folders can be added, reviewed, and removed before preview.
- Targets are reserved without overwrite. Conflicts can be skipped or renamed.
- Every copy is staged, byte-counted, SHA-256 checked, and published atomically.
- Move deletes the source only after the verified destination and journal record are durable.
- Jobs, evidence, and recovery records use JSONL files. No media metadata is changed.

## Self-contained runtime

Release packages carry ExifTool, a bundled Perl runtime where needed, a Rust filesystem helper, and a Rust launch broker. META Mover does not install Python, FFmpeg, ExifTool, or other host tools while it runs.

The current local package proof covers Linux x64 `deb` and `rpm` builds. macOS and Windows have native CI gates, but release support remains blocked until signed packages and platform attestors are proved on those systems. AppImage and portable packages are not supported.

## Build from source

Requirements: Node.js 22.12 or newer, npm 10.9, Rust 1.85.1, Git, and the native compiler toolchain for the current OS.

```bash
npm ci
npm run package:stage-tools
npm run dev
```

Run the full source gate:

```bash
npm run verify
npm run build
npm run package:integrity
```

See [Quick Start](docs/QUICK_START.md), [Architecture](docs/ARCHITECTURE.md), and the [documentation index](docs/DOCUMENTATION_INDEX.md).

## License

MIT. See [LICENSE](LICENSE).
