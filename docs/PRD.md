# Product requirements

## Product goal

Turn mixed, renamed, and disordered media into a predictable archive without converting weak timestamps into false facts or risking source loss.

## Required workflow

1. User selects one or more source roots and a separate destination.
2. App inventories every regular file without following links. Unsupported or unrecognized formats remain unchanged and receive an explicit skipped `Needs Review` row.
3. App extracts metadata locally and records every date candidate.
4. Resolver ranks capture-time evidence by meaning, source, offset, precision, and consistency.
5. App shows a non-mutating preview with date provenance, warnings, target, conflict action, and source fingerprint.
6. High- or medium-confidence dates produce dated names and folders. Everything else targets `_Needs Review`.
7. Copy is the default. Move requires explicit acknowledgement.
8. Execution revalidates the preview, stages bytes, verifies SHA-256, and publishes without overwrite.
9. Move deletes only the exact source identity after durable destination and delete-intent evidence.
10. History, evidence, and recovery state remain inspectable after restart.

## Product rules

- No media metadata or timestamps are rewritten.
- No corruption diagnosis is claimed.
- No target overwrite exists.
- Source and destination roots cannot overlap.
- Changed inputs fail closed.
- Cancellation stops new admission and lets the current atomic operation settle.
- Every admitted file ends in a durable terminal or recoverable pending state.
- Every non-OS runtime dependency ships inside the platform package.
- Production packages require an authenticated, non-user-writable install root.

## Output

Trusted dates use `YYYY-MM-DD_HH-MM-SS[.fraction].ext` and one of:

- `{year}/{month}/`
- `{year}-{month}/`
- flat destination

Weak or missing dates retain a sanitized original basename under `_Needs Review`.

## Release acceptance

- Clean registry-only install
- Formatting, lint, strict typecheck, coverage, Rust, build, and package policy green
- 1,000-file same-timestamp conservation proof
- Real staged preview-to-copy integration through IPC and native helper
- Native installer and immutable-root proof on every claimed OS

Current local release proof: Linux x64 `deb` and `rpm`. macOS and Windows remain native signed-package gates. AppImage and portable formats are out of scope.
