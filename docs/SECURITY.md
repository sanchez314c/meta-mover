# Security architecture

See the root [security policy](../SECURITY.md) for private reporting.

## Threat model

META Mover accepts attacker-controlled filenames, metadata, directory contents, and renderer input. It assumes the signed application package and OS account are trusted. It does not assume media metadata is true.

## Controls

- Renderer: sandboxed, context isolated, no Node integration, no insecure content
- IPC: named preload methods, strict DTO keys, bounded values, serializable plain objects
- Navigation: denied unless the main process explicitly opens an allowed external URL
- Roots: canonical, disjoint, no-follow, identity-bound
- Inputs: regular files only; symlinks, hard links, special files, aliases, and path escapes fail closed
- Preview: source fingerprints and destination observations are revalidated before execution
- Publication: staged, synced, SHA-256 verified, exclusive, and no-clobber
- Move: receipt-backed deletion of the exact validated source identity
- Recovery: ambiguous state stays visible and preserves objects
- Tools: exact schema-3 manifest, SHA-256 checks, strict identity probe, immutable broker launch
- Environment: empty tool `PATH`; no host executable fallback or runtime installation

## Package trust

Hashes prove package integrity after a trust root is established. They do not authenticate a writable package tree.

- Linux production accepts protected root-owned installs under system locations used by `deb` and `rpm` packages.
- macOS needs a signed, notarized `/Applications` install plus a native signing and ACL attestor.
- Windows needs a signed per-machine Program Files install plus WinVerifyTrust and ACL evidence.

User-writable extraction, AppImage, archive, and portable layouts are rejected.

## Data handling

Media and metadata stay local. META Mover does not upload files, check for updates, or rewrite embedded metadata. Evidence and history can contain full local paths and metadata, so treat the application data directory as sensitive.
