# Learnings & Technical Notes

Lessons learned and notable decisions made during the development of META Mover v1.0.

## Architecture Decisions

### Why Electron (not Tauri or native)

The legacy Python scripts used PIL, ExifTool, and ffprobe — all of which have well-maintained Node.js equivalents (`sharp`, `exifr`, `ffprobe-static`). Electron lets us keep the processing logic in the same runtime as the UI, simplifying the IPC surface. Tauri was considered but rejected because Rust bindings for exifr and sharp would have added significant porting work with no user-facing benefit at this stage.

### Three Separate Webpack Bundles

Electron requires the main process, preload script, and renderer to be bundled separately with different `target` settings (`electron-main`, `electron-preload`, `electron-renderer`). Attempting to share a single bundle causes `require()` issues in the renderer. The three-config approach in `config/webpack.*.config.js` was the cleanest solution found.

### SQLite over electron-store

`electron-store` was initially used for job history, but it stores everything in a single JSON file which becomes a performance problem with thousands of job records and file cache entries. SQLite with parameterized queries and `json_extract()` for UUID lookups was significantly faster and gave us proper indexing.

### UUID in JSON Blob

The database `jobs` table uses SQLite's `json_extract(metadata, '$.jobId')` to look up records by UUID because the legacy integer auto-increment ID does not map cleanly to the UUID-based `ProcessingJob` type used throughout the TypeScript code. This is a known workaround — a future migration should add a proper `uuid` column with an index.

## Porting Python Logic to TypeScript

### Century Correction

The original Python code corrected dates where cameras with dead CMOS batteries reset to year 2000 or earlier. The TypeScript port in `DateExtractor.correctCentury()` matches the Python logic exactly: years 1–1999 are remapped to 2000+. The validation window is 1990-01-01 to the current year, matching the Python bounds.

### VidBeast Corruption Detection

The hardest part of the port was matching the false-positive prevention logic. The Python code had a specific rule: if the video plays and has at most one minor issue, clear all corruption flags. This is implemented in `CorruptionDetector.analyzeFile()` with the comment "LEGACY VidBeast logic". Getting this wrong caused either over-quarantining (moves of playable files to `corrupt/`) or under-quarantining (genuinely corrupted files passed through).

### Screenshot Detection

iOS screenshots embed `"Screenshot"` in EXIF `UserComment`. macOS screenshots embed a CGRect like `"{{0,0},{1440,900}}"`. Both patterns were discovered by examining actual screenshots with exiftool; neither is documented in official EXIF specs. The detection in `MetadataExtractor` uses:
```typescript
if (userComment === 'Screenshot' ||
    (userComment.startsWith('{{') && userComment.includes('},'))) {
  metadata.isScreenshot = true;
}
```

### MPO Files

MPO (Multi Picture Object) is a stereoscopic 3D JPEG format used by some Nintendo and Fujifilm cameras. Most organizing tools ignore them or fail silently. META Mover renames the extension from `.mpo` to `.jpg` during organization since the binary format is valid JPEG and most viewers open it correctly. This preserves the files rather than skipping or erroring.

### 2-Digit Conflict Counter

The Python scripts used `_01`, `_02` conflict suffixes. The TypeScript port matches this exactly with `.padStart(2, '0')`. Going beyond 99 raises an error. This was a deliberate decision — more than 99 files with the same timestamp is unusual enough that it warrants manual attention.

## IPC Design

### Why InputValidator in IPCHandler

The renderer cannot be trusted. Even with `contextIsolation: true`, a XSS vulnerability in the renderer could allow injected code to call `window.electronAPI` methods. `InputValidator` in `IPCHandler` sanitizes job IDs, config keys, and processing options before they reach `ProcessingEngine` or `DatabaseManager`. Job IDs are restricted to `[a-zA-Z0-9_-]` and capped at 100 chars to prevent injection via SQLite queries.

### Progress Event Bus

`ProcessingEngine` extends `EventEmitter` and emits `job-progress`, `job-completed`, `job-failed`, etc. `IPCHandler` subscribes to these events and forwards them to all renderer windows via `window.webContents.send('processing:progress', data)`. This keeps the engine decoupled from Electron's IPC layer and makes it testable without a browser window.

## Build System Notes

### electron-builder and Linux Sandbox

On Linux, Electron's `--no-sandbox` flag is required when `kernel.unprivileged_userns_clone` is 0 (default on some distros). All run scripts and the `package.json` `start`/`dev` commands include `--no-sandbox`. The alternative is `sudo sysctl -w kernel.unprivileged_userns_clone=1` at the system level.

### Native Module Rebuilds

`sharp` and `sqlite3` are native Node.js addons. They must be rebuilt for the specific Electron ABI version. `electron-builder` runs `electron-builder install-app-deps` during `postinstall` (see `package.json`) which handles this automatically on `npm install`. If you see `NODE_MODULE_VERSION` mismatch errors, run `npm run rebuild` or `npm install` again.

### Conda + Node Hybrid Environment

The `scripts/setup-hybrid.sh` creates a Conda environment (`metamover-dev`) that includes `ffmpeg` and `exiftool` as system tools, then installs Node.js via nvm. This ensures `ffprobe` and `exiftool` are on PATH without requiring system-level installation. The `scripts/activate-dev.sh` script activates this environment. If you skip Conda setup, `ffprobe` must be available on PATH separately (`ffprobe-static` npm package provides a bundled binary as fallback).

## Known Issues and Workarounds

### MenuBuilder is Commented Out

`MenuBuilder` in `src/main/utils/MenuBuilder.ts` is fully implemented but commented out in `src/main/index.ts`. This is intentional — the menu needs to be wired to actual UI actions before enabling. Do not delete the class.

### DatabaseManager.close() Returns void

`DatabaseManager.close()` calls `this.db.close()` without returning a Promise, but the caller in `src/main/index.ts` uses `await databaseManager.close()`. The `sqlite3.Database.close()` method accepts an optional callback but the TypeScript type marks return as `void`. This works in practice (the await resolves immediately) but should be wrapped in a Promise for correctness.

### Renderer Uses local State for Status

`App.tsx` uses local `useState` for the status dot (`'ready' | 'processing' | 'error'`) rather than the Redux `appSlice`. When the full job management UI is wired up, this should be replaced with `useSelector(selectIsLoading)` and the appropriate job status selector.

## Testing Gaps

The `tests/` directory contains only `.gitkeep`. Unit tests for `DateExtractor`, `FileOrganizer`, and `CorruptionDetector` are the highest-priority gap. The century correction logic, conflict counter, and VidBeast false-positive rule are all candidates for regression tests given how precisely they mirror the Python legacy behavior.
