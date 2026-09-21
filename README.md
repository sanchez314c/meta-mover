# META Mover

META Mover is a local Electron app for sorting mixed media by the best available creation-date evidence. It reads embedded metadata and filename dates, then shows the proposed result before touching media.

It never rewrites source metadata or hides uncertainty. Date selection evaluates valid creation, capture, recording, container, and filename claims with their source, precision, timezone, confidence, and corroboration intact. Filesystem modification time is not creation evidence and cannot rename a file. Genuinely conflicting or dateless files go to `_Needs Review` with their evidence and warnings intact. An optional setting can normalize writable date fields on successfully committed destination files from the resolved creation date.

Inventory covers every regular file in the selected source folders. Recognized formats enter metadata planning. Unsupported or unrecognized files remain unchanged and appear as explicit skipped `Needs Review` rows instead of disappearing from the report.

For large-collection validation, Settings includes an explicit Test Mode toggle. When enabled, the Organize view displays a persistent warning and replaces normal preview with `Gather & Build Test Preview`. META Mover copies 15,000 random files into an app-owned staging root beside the selected destination, automatically builds the normal preview from those copies, and never processes the original collection. The UI reports scan count, copy count, percentage, current filename, and exposes Stop Test Run. Copy-on-write cloning is attempted before a regular copy. A fully successful run removes the temporary corpus. Failed processing retains it and reports the path.

## Safety model

- Preview is required and does not mutate media.
- Preview shows live discovery and per-file metadata progress, including the current path.
- Stop Preview cancels analysis during discovery or metadata work. It never changes source files.
- Copy is the default. Move requires an explicit acknowledgement.
- Source and destination roots must be separate, canonical directories.
- One or more source folders can be added, reviewed, and removed before preview.
- Folder structure can include month subfolders (`Type/Year/Month`) or place resolved assets directly in year folders (`Type/Year`).
- Targets are reserved without overwrite. Conflicts can be skipped or renamed.
- Optional screenshot labeling appends `-screen-shot` before the extension only when an image filename or verified metadata explicitly identifies a screenshot. It is disabled by default.
- Optional destination date normalization removes writable date fields and replaces them with the selected resolved creation date after a successful copy or move. It is disabled by default and preserves non-date metadata. ExifTool must rewrite the committed destination, so this optional post-processing step can take time for large videos.
- Preview sends ExifTool a seekable, identity-bound source path. It does not copy or hash complete video files during analysis.
- Filesystem modification, access, inode-change, metadata-modification, and ICC profile dates cannot become creation truth.
- Every copy is staged, byte-counted, SHA-256 checked, and published atomically.
- Move deletes the source only after the verified destination and journal record are durable.
- Jobs, evidence, and recovery records use JSONL files. Source metadata is never changed.

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
