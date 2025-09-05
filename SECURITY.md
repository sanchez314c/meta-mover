# Security Policy

## Supported Versions

We actively maintain the following version with security updates:

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in META Mover, please do the following:

1. **Do not** create a public GitHub issue for it
2. Email the maintainer at: sanchez314c@speedheathens.com
3. Include a description of the issue, steps to reproduce, and the potential impact
4. Allow up to 14 days for an initial response before public disclosure

## Security Architecture

META Mover is an Electron desktop application that processes local media files. The security model is:

**Context Isolation** — `contextIsolation: true` and `nodeIntegration: false` are enforced in `src/main/index.ts`. The renderer process has no direct Node.js access.

**Preload Bridge** — `src/preload/index.ts` uses `contextBridge.exposeInMainWorld('electronAPI', ...)` to expose a narrow, typed API surface to the renderer. No arbitrary IPC is possible from the renderer.

**IPC Validation** — `src/main/services/IPCHandler.ts` uses `InputValidator` to sanitize job IDs, config keys, and processing options before they reach the engine. Job IDs are validated against `/^[a-zA-Z0-9_-]+$/` and capped at 100 characters.

**Path Traversal Prevention** — `src/main/core/FileDiscovery.ts` resolves all paths with `path.resolve()` and verifies each entry stays within the scanned directory root before adding it to results.

**Navigation Lock** — `src/main/index.ts` calls `event.preventDefault()` on `will-navigate` and sets `setWindowOpenHandler` to `deny` to prevent the renderer from navigating to external URLs.

**No Remote Code** — All processing is local. META Mover makes no network requests during media organization. The only network activity is auto-update checks via `electron-updater`, which are disabled in development mode.

## Attack Surface

| Surface | Mitigation |
| ------- | ---------- |
| Malicious media files | Errors in `MetadataExtractor` / `CorruptionDetector` are caught and logged; corrupt files are quarantined rather than crashing the process |
| Path traversal via file input | `FileDiscovery` validates all resolved paths stay within source root |
| IPC injection from renderer | `InputValidator` in `IPCHandler` sanitizes all renderer-originated input |
| External URL navigation | Blocked via `will-navigate` event handler in `src/main/index.ts` |

## Responsible Disclosure

Please do not perform denial-of-service testing, access other users' data, or disclose a vulnerability publicly before we have had a chance to address it. We appreciate responsible disclosure and will credit researchers who follow this policy.
