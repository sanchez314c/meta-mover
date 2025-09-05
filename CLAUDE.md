# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

META Mover v1.0 is a desktop media organizer for photographers. It scans source folders, extracts metadata from photos/videos/audio, and moves them into a `{type}/{year}/YYYY-MM-DD_HH-MM-SS.ext` structure. Handles corrupted files, filename conflicts, iOS/macOS screenshots, MPO files, and cameras with dead CMOS batteries.

**Stack**: Electron 38 + React 19 + TypeScript + Redux Toolkit + Webpack + styled-components

**Origin**: Ported from a legacy Python script (`media-organizer-enhanced-v2.3.0-safe-optimized.py`), preserved in `legacy/`.

## Development Commands

```bash
# Run from source (Linux) — preferred local dev workflow
./run-source-linux.sh              # builds dev + launches Electron (no --dev flag, loads from dist/)

# Standard npm commands
npm run dev                        # build:dev + electron --dev --no-sandbox
npm run build                      # production build (main + preload + renderer + worker)
npm run build:dev                  # development build (all 4 targets)
npm run start                      # run already-built app (requires prior build)
npm run watch                      # concurrent watch on main + renderer + auto-launch

# Quality
npm run lint                       # ESLint with auto-fix
npm run lint:check                 # ESLint check only (CI uses this)
npm run format                     # Prettier write
npm run format:check               # Prettier check only (CI uses this)
npm run typecheck                  # tsc --noEmit

# Tests
npm run test                       # Jest (jsdom environment)
npm run test:watch                 # Jest watch mode
npm run test:coverage              # Jest with coverage (80% threshold enforced)
npx jest path/to/file.test.ts      # run a single test file

# Distribution
npm run dist:linux                 # Linux (AppImage, deb, rpm, snap, tar.gz, tar.xz)
npm run dist:mac                   # macOS (dmg, pkg, zip — x64 + arm64 + universal)
npm run dist:win                   # Windows (nsis, msi, appx, portable, zip)
./scripts/compile-build-dist.sh    # full pipeline: clean → install → test → lint → build → package
```

## Architecture

### Electron 3-Process Model

```
Main Process (Node.js)
  src/main/index.ts           App lifecycle, window creation, core IPC
  src/main/core/              Processing engines (the business logic)
  src/main/services/          DB, Config, IPC handler, WindowManager
  src/main/utils/             DateExtractor, FFProbeWrapper, JobQueue, etc.
  src/main/workers/           Worker thread (compiled separately, target: node)
        │
        │ contextBridge (IPC)
        │
  src/preload/index.ts        Typed bridge → window.electronAPI
        │
Renderer Process (React)
  src/renderer/App.tsx        Root component, IPC listener hub, view router
  src/renderer/components/    UI components + views/ subfolder
  src/renderer/store/         Redux Toolkit (4 slices: app, jobs, settings, ui)
  src/renderer/styles/        GlobalStyles (CSS custom properties), shared styled-components
```

### Processing Pipeline (6 phases, sequential)

```
processJob(job):
  Phase 1 DISCOVERY      → FileDiscovery.discover() → builds job.files[]
  Phase 2 METADATA       → MetadataExtractor in batched Promise.all(), SQLite cache-first
  Phase 3 CORRUPTION     → CorruptionDetector, images + videos only, half batch size
  Phase 4 ORGANIZATION   → FileOrganizer, skips QUARANTINED/FAILED files
  Phase 5 VERIFICATION   → re-scans source dirs for missed files
  Phase 6 CLEANUP        → removes empty source directories
```

`ProcessingEngine` is an `EventEmitter` singleton. `IPCHandler` subscribes to engine events and fans them out to ALL browser windows via `webContents.send()`.

### IPC Flow

**Renderer → Main** (invoke/handle): `processing:start`, `processing:pause/resume/cancel`, `config:get/set/reset`, `dialog:openDirectory/openFiles`, `db:getJobs/getJob`, `system:info/openPath/getPath`, `window:minimize/maximize/close`

**Main → Renderer** (push via send/on): `processing:progress`, `processing:complete`, `processing:error`

Channel naming convention: `domain:action`. Canonical names in `src/shared/constants/index.ts` (`IPC_CHANNELS`), though some channels are registered as string literals in `IPCHandler`.

`processing:start` is **fire-and-forget** — returns `{ success, jobId }` immediately, then streams progress via push events.

### Output Directory Structure

```
{destination}/Photos/{year}/            images
{destination}/Videos/{year}/            video
{destination}/Audio/{year}/             audio
{destination}/Screenshots/{year}/       images with isScreenshot=true
{destination}/corrupt/{media}/{year}/   MODERATE+ corruption
{destination}/Error/{media}/{year}/     organization failures
```

### Date Detection Priority

EXIF fields (in order): `MediaCreateDate > TrackCreateDate > ContentCreateDate > DateTimeOriginal > CreateDate > DateTime > DateCreated > DateTimeDigitized` → filename regex patterns → filesystem `birthtime`/`ctime` fallback. Century correction applied to all dates.

### Corruption Detection (4-phase, weighted)

1. **Container** (0.25) — magic bytes + structure check
2. **Stream** (0.25) — codec/duration/timestamp validity
3. **Bitstream** (0.30) — entropy analysis, null byte ratio, sync pattern search
4. **Playability** (0.20) — ffprobe + 5-second ffmpeg decode test

If video plays fine and has <=1 issue, score overrides to 0 (prevents false positives). Only MODERATE+ corruption is actionable.

## Key Patterns

### Renderer ↔ Main State Sync

No automatic sync or Redux middleware. All communication is event-driven:
- On mount: `initializeApp` thunk calls `system:info` IPC
- On processing start: renderer invokes `startProcessing()`, gets `jobId`, dispatches `addJob()`
- During processing: main pushes progress → renderer dispatches `updateJob()`
- On complete/error: main pushes status → renderer dispatches status update + `setActiveJob(null)`

### Navigation

No router. View switching is pure Redux: `dispatch(setActiveView('organize'))`. App.tsx does a `switch` on `state.ui.activeView` to render the active view component. Views fully mount/unmount on tab change.

### Styling

CSS custom properties on `:root` (defined in `GlobalStyles.ts`). Dark "neo-noir" theme with teal accent (`--accent-teal: #14b8a6`). styled-components throughout with transient `$` prefix props (e.g., `$active`, `$status`, `$disabled`). Glass shimmer effect via `::before` pseudo-elements on cards.

### Dev Mode Detection

`isDevelopment` checks `process.argv.includes('--dev')`, **not** `NODE_ENV`. `npm run dev` passes `--dev`; `run-source-linux.sh` does not.

### Singleton Services

`ProcessingEngine`, `DatabaseManager`, `ConfigManager` are all singletons. `ProcessingEngine` uses a dual-mode pattern: `createInstance()` (force-creates, called from `main/index.ts`) and `getInstance()` (returns existing or creates default, called from `IPCHandler`).

### Preload Safety

Preload calls `ipcRenderer.removeAllListeners(channel)` before re-registering each push listener. Prevents listener stacking on component re-mounts.

### Security (IPCHandler)

`IPCHandler` has an internal `InputValidator`: path traversal checks (null bytes, absolute path enforcement), job ID format regex, config key validation, and a whitelist for `system:getPath` names.

## Build System

4 webpack configs in `config/`:

| Config | Target | Entry | Output |
|--------|--------|-------|--------|
| `webpack.main.config.js` | `electron-main` | `src/main/index.ts` | `dist/main/` |
| `webpack.preload.config.js` | `electron-preload` | `src/preload/index.ts` | `dist/preload/` |
| `webpack.renderer.config.js` | `electron-renderer` | `src/renderer/index.tsx` | `dist/renderer/` |
| `webpack.worker.config.js` | `node` | `src/main/workers/ProcessingWorker.ts` | `dist/workers/` |

**Native module externals**: `sharp`, `sqlite3`, `better-sqlite3` are externalized as `commonjs` in both main and worker configs. They cannot be bundled by webpack (compiled `.node` binaries).

**Path aliases**: `@main/*`, `@renderer/*`, `@shared/*`, `@preload/*` — configured in `tsconfig.json`, mirrored in webpack aliases and Jest `moduleNameMapper`.

**Dev server port**: 58594 (hardcoded in webpack.renderer.config.js and run-source-linux.sh).

## Testing

- **Framework**: Jest + ts-jest, jsdom environment
- **Setup**: `src/setupTests.ts` (imports `@testing-library/jest-dom`)
- **Electron mocks**: `setupTests.ts` mocks the `electron` module (`ipcRenderer`, `contextBridge`). Individual tests must also mock `window.electronAPI` for preload bridge calls.
- **Coverage thresholds**: 80% on branches, functions, lines, statements (enforced in jest config)
- **Test location**: `tests/` directory (pattern: `tests/**/*.test.{ts,tsx}`)

## CI/CD

**CI** (`.github/workflows/ci.yml`): Runs on push/PR to main/master/develop. Matrix: 3 OS x 2 Node versions (18, 20). Steps: `npm ci` → `lint:check` → `typecheck` → `test:ci` → `build`.

**Release** (`.github/workflows/release.yml`): Triggered on `v*.*.*` tags. Builds on all 3 OSes → uploads artifacts → creates GitHub Release.

## Known Architectural Gaps

These exist in the codebase and are important context for future work:

- **Worker threads created but unused**: `ProcessingEngine` initializes a worker pool but `processJob()` calls core classes in-process via `Promise.all()`. The workers in `ProcessingWorker.ts` are correct and ready but never receive dispatched tasks.
- **Dual AppConfig types**: `shared/types/media.ts` defines `AppConfig` with `defaultProcessingOptions` (~20 fields). `ConfigManager.ts` defines its own `AppConfig` with `processingOptions` (4 fields) + `organizationOptions`. `IPCHandler` imports from `ConfigManager`. These are not unified.
- **WindowManager is dead code**: Class exists in `services/WindowManager.ts` but `main/index.ts` creates windows directly without using it.
- **TemplateEngine not wired in**: `utils/TemplateEngine.ts` exists but `FileOrganizer` uses `DateExtractor.formatFilenameWithDate()` and hardcoded `{mediaFolder}/{year}` paths instead.
- **Dual IPC listener registration**: Both `App.tsx` and `ProcessingView.tsx` independently register `onProgress`/`onProcessingComplete`/`onProcessingError` listeners. When ProcessingView is mounted, there are two active listeners for each event.
- **Jest config typo**: `config/jest.config.js` uses `moduleNameMapping` instead of `moduleNameMapper`, which means path aliases and asset mocks won't resolve during tests.

## Platform Notes

- **Linux**: Requires `--no-sandbox` flag for Electron, or `kernel.unprivileged_userns_clone=1`. `run-source-linux.sh` handles both.
- **macOS**: 10.15+ (Intel + Apple Silicon + Universal builds)
- **Windows**: 10+ (x64, ia32, arm64)
- **Node.js**: 18+ (`.nvmrc` pins to 18, CI also tests 20)
- **Electron sandbox**: On Linux with hardened kernels, the sandbox fails. The run script applies the sysctl fix and falls back to `--no-sandbox`.

## Supported Formats

- **Images**: JPEG, PNG, TIFF, HEIC, RAW (CR2, NEF, ARW, DNG), WebP, AVIF
- **Videos**: MP4, MOV, AVI, MKV, WebM, ProRes, H.265/HEVC
- **Audio**: MP3, FLAC, WAV, AAC, OGG, ALAC

Full format lists with extensions in `src/shared/constants/index.ts`.

## Code Conventions

- **Components**: PascalCase files (`LoadingSpinner.tsx`)
- **Styled-components**: Transient props use `$` prefix (`$active`, `$disabled`)
- **IPC channels**: `domain:action` format
- **Prettier**: single quotes, 2-space indent, 100 char width, trailing commas (es5)
- **ESLint**: `@typescript-eslint/recommended` + `react` + `react-hooks` + `jsx-a11y` + `prettier`
- **Unused vars**: `_` prefix pattern allowed (`varsIgnorePattern: "^_"`)
