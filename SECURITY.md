# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security flaw. Email `sanchez314c@speedheathens.com` with the affected version, reproduction steps, expected impact, and any safe proof. Do not include private media.

## Supported release state

Security fixes apply to the current `1.0.x` line. Linux x64 `deb` and `rpm` are the only release formats with current local package proof. macOS and Windows are not claimed as verified release targets until their signed native package gates pass.

## Security boundaries

- The renderer has context isolation, sandboxing, and no Node integration.
- The preload exposes named methods only. Main-process handlers validate exact DTO keys.
- Navigation and new-window creation are denied by default.
- Processing is local. There is no updater or media upload path.
- Source and destination roots are canonicalized, disjoint, and bound before work starts.
- Symlinks, hard-linked source media, path escapes, special files, and changed preview inputs fail closed.
- Packaged tools are hash-bound to a strict manifest. The launch broker verifies the helper again before execution.
- Production packages must live under an authenticated, non-user-writable install root.
- No operation falls back to system Python, Perl, ExifTool, FFmpeg, or a `PATH` lookup.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and package trust requirements.
