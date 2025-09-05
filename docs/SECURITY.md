# Security

Security policy and architecture details for META Mover.

See the root [SECURITY.md](../SECURITY.md) for the vulnerability reporting process.

## Security Architecture

META Mover is a local desktop application — it does not send files or metadata to any remote server. All processing happens on-device.

### Context Isolation

`contextIsolation: true` and `nodeIntegration: false` are enforced in `src/main/index.ts`. The renderer process (React UI) has no direct access to Node.js APIs.

### Preload Bridge

`src/preload/index.ts` uses `contextBridge.exposeInMainWorld('electronAPI', ...)` to expose a narrow, typed API to the renderer. The renderer can only call methods explicitly listed in the preload — no arbitrary IPC is possible.

### IPC Input Validation

`InputValidator` in `src/main/services/IPCHandler.ts` sanitizes all renderer-originated input before it reaches processing logic:

- Job IDs are validated against `/^[a-zA-Z0-9_-]+$/` and capped at 100 characters
- Config keys are validated against the `AppConfig` schema
- File paths are resolved and checked for null bytes before use

### Path Traversal Prevention

`src/main/core/FileDiscovery.ts` resolves all paths with `path.resolve()` and verifies each entry stays within the scanned directory root before adding it to results. Paths containing null bytes are rejected.

### Navigation Lock

`src/main/index.ts` calls `event.preventDefault()` on `will-navigate` and sets `setWindowOpenHandler` to `deny`. This prevents the renderer from navigating to external URLs, which is a common Electron attack vector.

### No Remote Code

META Mover makes no network requests during media processing. The only network activity is auto-update checks via `electron-updater`, which only runs in production mode and only communicates with the GitHub releases endpoint.

## Attack Surface

| Surface | Mitigation |
|---------|------------|
| Malicious media files | Errors in `MetadataExtractor` and `CorruptionDetector` are caught and logged — corrupt files are quarantined rather than crashing the process |
| Path traversal via file input | `FileDiscovery` validates all resolved paths stay within source root; `IPCHandler` rejects null bytes |
| IPC injection from renderer | `InputValidator` sanitizes all renderer input |
| External URL navigation | Blocked via `will-navigate` event handler |
| SQL injection | Column names in `DatabaseManager` are validated against a whitelist before interpolation; values use parameterized queries |

## Dependencies

Run a security audit against current dependencies:

```bash
npm run security:audit
```

Auto-fix non-breaking vulnerabilities:

```bash
npm run security:audit:fix
```

Some vulnerabilities in the build tool chain (`electron-builder`, `@electron/rebuild`) do not affect the running application and are tracked separately.
