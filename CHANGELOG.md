# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-03-28 00:34

### Added (Python Processing Bridge — Full Pipeline)
- Created `scripts/media_organizer.py` — headless/JSON-progress mode for the proven Python media organizer
- Created `src/main/services/PythonProcessingBridge.ts` — subprocess wrapper that spawns Python script and bridges JSON stdout into Electron IPC events
- Created `src/renderer/components/ProcessingLauncher.tsx` — new default "Organize" tab with source/dest folder pickers, live progress bar, completion summary, dependency check
- Added `checkDependencies` IPC channel (`system:checkDependencies`) — checks python3 and exiftool availability
- Added `checkDependencies` to preload bridge and ElectronAPI type definition

### Changed
- Rewired `IPCHandler.ts` to use `PythonProcessingBridge` instead of broken `ProcessingEngine`
- Rewired `main/index.ts` lifecycle (before-quit, will-quit) to use `PythonProcessingBridge`
- Replaced decorative HeroCard landing page with functional ProcessingLauncher
- Simplified `ProcessingView.tsx` to job history only (removed duplicate folder pickers and IPC listeners)
- Cleaned dead state/callbacks from `App.tsx` (selectedFolder, fileCount, handleSelectFolder, dual IPC listeners)

### Fixed
- Resolved dual IPC listener registration issue (App.tsx and ProcessingView.tsx both registered progress/complete/error listeners)

## [1.0.11] - 2026-03-27 13:45

### Changed (Neo-Noir Glass Monitor Restyle — Step 9)
- Applied Neo-Noir Glass Monitor design system across all UI components
- Added `disable-gpu-compositing` Linux flag to main process (correct flag per spec — NOT disable-gpu)
- Added `body::before` pseudo-element for rounded window shadow (replaces flat OS shadow)
- Updated body padding from 16px to 20px to match shadow inset and create float effect
- Added glass border (`rgba(255,255,255,0.03)`) and `box-shadow: none` to AppContainer
- Added `-webkit-app-region: drag` to TitleBar styled component (enables window drag)
- Added complete CSS token set: `--success`, `--warning`, `--error`, `--text-accent`, `--text-inverse`, `--radius-input`
- Fixed StatusBar left side: removed duplicate unicode dot `&#x25CF;` prefix — StatusDot component already renders the indicator dot
- Updated index.html loading screen body padding to 20px and added body::before window shadow
- Added glass border to loading screen container
- All cards already have: gradient backgrounds, glass-border, `::before` inner highlight, hover lift + shadow escalation
- Sidebar already correct: no logo section, nav items at top, teal active state
- TitleBar already correct: flat About/Settings icons, circular 28px window controls, IPC-wired
- AboutModal already correct: layered shadow, glass styling, GitHub badge, license text
- StatusBar already correct: version-only right side, status+count left

## [1.0.10] - 2026-03-27

### Fixed (Wire Audit — Step 8)
- **DuplicatesView**: Removed fake progress bar animation (`setInterval` simulating scan progress with no backend call). Replaced with honest "Feature coming soon" banner. Folder selection IPC wire (`selectDirectory`) retained.
- **BatchView**: All 4 operation cards (Batch Rename, Date Correction, Format Conversion, Tag Management) now correctly marked `$disabled` with "Coming Soon" badges. Previously Rename and Date Correction appeared interactive (hover transform, pointer cursor) but had no onClick handlers or backend connections.
- **Notification memory leak**: Added auto-dismiss `useEffect` in App.tsx — notifications with a `duration` field are now automatically removed from Redux state after their timeout expires. Previously `addNotification` was dispatched but `removeNotification` was never called, causing unbounded accumulation.
- **Dead modal state**: Removed `settings` and `jobDetails` keys from `UIState.modals` in uiSlice. `openModal('settings')` was never dispatched anywhere (TitleBar settings button uses `setActiveView('settings')` instead). `openModal('jobDetails')` was never dispatched. The `about` modal is the only one in use.
- **SettingsView dead field**: Removed `batchSize` from `LocalSettings` interface and UI. The field was stored in local state and rendered in a NumberInput but was never mapped to any config key in `saveProcessingOptions` — saves were silently dropped.

### Verified (No Dead Wires Found)
- All 22 `window.electronAPI.*` calls in renderer trace cleanly through preload → IPCHandler → backend
- All window control IPC channels (`window:minimize`, `window:maximize`, `window:close`) handled in main/index.ts setupCoreIPC
- `open-external` handler present in main/index.ts with protocol validation

## [1.0.9] - 2026-03-27

### Removed (Dead Code Cleanup)
- Deleted `LegacyMigration.ts` - exported class with no active callers (Python-era migration never triggered)
- Deleted `MenuBuilder.ts` - entire file was commented out at its only import site
- Deleted `LoadingSpinner.tsx` - component never imported anywhere in renderer
- Deleted `ErrorBoundary.tsx` - class exported but never used in index.tsx or App.tsx
- Removed `saveProfile`, `saveHistoricalJob`, `getProfiles` stub methods from DatabaseManager (only LegacyMigration called them)
- Removed `removeProgressListener` from preload/index.ts and electron.d.ts (never called from renderer)
- Removed 8 unused Redux selectors from appSlice.ts (selectApp, selectIsInitialized, selectIsLoading, selectError, selectSystemInfo, selectActiveJobsCount, selectConnectionStatus, selectSidebarCollapsed)
- Removed 8 dead exported constants from shared/constants: APP_DESCRIPTION, FILE_TYPES, VIDEO_RESOLUTIONS, PROCESSING_STATUS, JOB_TYPES, LOG_LEVELS, DATE_PATTERNS, METADATA_FIELD_MAPPINGS (defined but never imported)

## [1.0.8] - 2026-03-27

### Fixed
- GPU acceleration default aligned: settingsSlice initialState now matches ConfigManager and DEFAULT_CONFIG (both false)
- SettingsView config key mismatch: now reads/writes correct nested keys (processingOptions.maxConcurrentJobs, organizationOptions.folderStructure, etc.) instead of non-existent flat keys
- ProcessingView is now reachable from sidebar navigation (Processing tab added)
- ProcessingView wired into App.tsx renderContent switch
- Removed dead WindowManager import and instantiation from main/index.ts (window created inline)
- Removed 20 unregistered IPC channel constants from IPC_CHANNELS that had no backend handlers
- Removed duplicate web-contents-created setWindowOpenHandler registration
- Removed unconditional will-navigate preventDefault that broke dev server HMR navigation
- Fixed listener accumulation memory leak in preload: onProgress/onProcessingComplete/onProcessingError now replace previous listener before adding new one
- Fixed timer leak in DuplicatesView: setInterval is now cleared on component unmount
- Tightened CSP: removed unsafe-inline from script-src (styles still allow it for styled-components)
- DatabaseManager stub methods now log warnings instead of silently swallowing calls
- Removed 4 stale .backup.* files from src/ tree

## [1.0.7] - 2026-03-17

### Fixed
- Fixed 7 of 8 broken IPC channels (preload/main channel name mismatches)
- Fixed SQL injection surface in DatabaseManager column name interpolation
- Fixed dialog:openDirectory cancel handling (returned undefined instead of null)
- Added 30-second timeout to all ffprobe spawn calls (prevents hanging on corrupt files)
- Fixed ErrorBoundary crash when styled-components ThemeProvider is absent
- Removed duplicate IPC handler registrations between index.ts and IPCHandler.ts

### Added
- Worker thread implementation (ProcessingWorker.ts) with webpack build pipeline
- Worker health monitoring with max 3 restarts per worker, graceful fallback
- File cache system for incremental processing (skips unchanged files on re-run)
- Processing Dashboard view with source/destination selection and job history
- Settings view with real-time config read/write via IPC
- Metadata browser view (read-only, v1.0 placeholder)
- Duplicates scanner view (v1.0 placeholder)
- Batch processing view (v1.0 placeholder)
- Redux store fully wired to UI (appSlice, jobsSlice, settingsSlice, uiSlice)
- CSP updated to allow GitHub auto-updater connections

### Removed
- Dead code: simple.ts (61 lines), themes.ts (188 lines), i18n.ts (57 lines)
- Duplicate constants file consolidated into single source
- ThemeProvider wrapper (all styles use CSS variables)
- Unused i18n module (no component used useTranslation)

### Changed
- App.tsx decomposed from 979 lines to 129 lines (7 extracted components)
- IPC channels standardized to namespace:action convention
- Preload bridge expanded with complete API surface (config, jobs, processing control)
- Constants consolidated from two files into single canonical source

## [1.0.6] - 2026-03-14 20:10:00

### Neo-Noir Glass Monitor Design System — Full Restyle

#### Renderer / UI
- `src/renderer/styles/GlobalStyles.ts` — Added complete `:root` CSS custom property token system (50+ tokens: backgrounds, typography, accents, borders, glass, gradients, layered shadows, radius, spacing, transitions). Replaced all hardcoded hex values with CSS variables.
- `src/renderer/App.tsx` — Replaced all hardcoded color/shadow values throughout every styled-component with CSS variables (`var(--*)`). Hero card now uses ambient radial-gradient mesh (`::after`). Glass card `::before` inner highlight uses `var(--glass-highlight)`. All hover shadows use layered `--shadow-card-hover`. Status bar left side uses `● Ready` dot indicator. About modal wired to `software@jasonpaulmichaels.co` and GitHub pill badge linking `sanchez314c/meta-mover`. About modal closes on X, overlay click, and Escape key. Sidebar has no logo section — nav items start at `margin-top: 4px`. Window controls are circular 28px. TitleBar controls z-index: 200, drag handle z-index: 50.
- `src/renderer/index.html` — Loading screen now uses `:root` CSS variables, matching the full token system.

#### Main Process (already compliant — verified)
- `src/main/index.ts` — `frame: false`, `transparent: true`, `backgroundColor: '#00000000'`, `hasShadow: false`, `resizable: true` confirmed. Linux flags (`enable-transparent-visuals`, `disable-gpu-compositing`, `no-sandbox`) confirmed present before `app.whenReady()`.

## [1.0.5] - 2026-03-14 17:13:14

### Forensic Code Quality Audit — Full Fix Pass

#### Security (CRITICAL)
- `src/main/services/IPCHandler.ts` — fixed path traversal validation that was a complete no-op (resolved path always starts with itself). Now checks for null bytes and verifies absolute paths
- `src/main/services/IPCHandler.ts` — added whitelist for `system:getPath` IPC channel to prevent arbitrary app path disclosure from renderer
- `src/main/services/IPCHandler.ts` — added null byte and type validation to `system:openPath` before passing path to shell
- `src/main/services/IPCHandler.ts` — moved misplaced `import { app }` from bottom of file to top-level import (was a hoisting hazard)

#### Data Safety (CRITICAL)
- `src/main/core/FileOrganizer.ts` — fixed data loss bug where `verifyFileIntegrity(file.path, finalPath)` was called after a move, reading a path that no longer exists. Now correctly validates destination size for moves vs SHA-256 comparison for copies
- `src/main/utils/FileSystemUtils.ts` — fixed cross-device move race condition: now verifies copy size matches source before deleting source. Removes bad destination copy if sizes don't match, preserving the original

#### TypeScript / Type Safety (HIGH + MEDIUM)
- `src/main/utils/JobQueue.ts` — removed broken generic `JobQueue<T>` which had 10+ type errors due to unconstrained `T`. Replaced with concrete `Job` types
- `src/main/services/ConfigManager.ts` — changed `get()`/`set()` from `any` to proper generic `K extends keyof AppConfig` signatures
- `src/main/services/DatabaseManager.ts` — added definite assignment assertion to `db` property; changed `close()` from `void` to `Promise<void>` with proper callback
- `src/main/services/DatabaseManager.ts` — added stub `saveProfile()`, `saveHistoricalJob()`, `getProfiles()` methods referenced by `LegacyMigration`
- `src/renderer/store/index.ts` — fixed slice vs reducer mismatch (`appSlice` used as reducer directly, now uses `appSlice.reducer`)
- `src/renderer/store/index.ts` — fixed listenerMiddleware type incompatibility with `as any` cast
- `src/renderer/store/slices/appSlice.ts` — exported `AppState` interface (required for declaration emit)
- `src/renderer/store/slices/jobsSlice.ts` — exported `JobsState` interface
- `src/renderer/store/slices/settingsSlice.ts` — exported `SettingsState` interface
- `src/renderer/store/slices/uiSlice.ts` — exported `UIState` interface
- `src/main/core/CorruptionDetector.ts` — added missing `[MediaType.ART]` entry in header validators map
- `src/main/core/FileOrganizer.ts` — fixed stream callback type from `Buffer` to `string | Buffer`
- `src/main/services/LegacyMigration.ts` — fixed `DuplicateHandling` string literal vs enum, `CorruptionLevel` cast, and `AppConfig` intermediate type
- `src/main/index.ts` — replaced `mainWindow!` non-null assertions in `before-quit` and `update-downloaded` dialogs with safe fallback chain
- `src/main/core/ProcessingEngine.ts` — fixed unreachable `CANCELLED` comparison with explicit cast

#### Constants / Import Fixes (HIGH)
- `src/main/core/ProcessingEngine.ts` — fixed import to use `@shared/constants/index` (full constants with `MAX_WORKER_COUNT`, processing limits)
- `src/main/core/CorruptionDetector.ts` — fixed import to use `@shared/constants/index` (full constants with `PLAYABILITY_TEST_DURATION`, `FFMPEG_PLAYABILITY_TIMEOUT`, `MIN_ACCEPTABLE_BITRATE`)
- `src/main/core/FileOrganizer.ts` — fixed import to use `@shared/constants/index`
- `src/main/core/MetadataExtractor.ts` — fixed import to use `@shared/constants/index`
- `src/main/services/LegacyMigration.ts` — fixed import to use `@shared/constants/index`

#### Media Extraction (HIGH)
- `src/main/utils/FFProbeWrapper.ts` — fixed false negatives: ffprobe writes informational messages to stderr even for valid files. Changed `if (code !== 0 || error)` to `if (code !== 0)` in both metadata methods

#### Code Quality (LOW)
- `src/main/services/ConfigManager.ts` — fixed `loadConfig()` to merge loaded config over defaults (prevents missing-key runtime errors on config version upgrades)
- `src/main/utils/TemplateEngine.ts` — replaced inline `require('fs')` with top-level `import * as fs from 'fs'`

#### Dependencies
- Ran `npm audit fix` — resolved ajv ReDoS, node-forge ASN.1, qs DoS, webpack SSRF, svgo Billion Laughs, express/body-parser issues
- Remaining vulnerabilities are build-tool-only (electron-builder, @electron/rebuild chain) and do not affect the running application

#### Verification
- `npm run typecheck` — exits 0, zero errors after all fixes
- All shell scripts pass `bash -n` syntax validation

#### Documentation
- `AUDIT_REPORT.md` — full forensic audit report written to project root

## [1.0.4] - 2026-03-14 UTC

### Repository Compliance Audit — Full Mode

#### Changed
- `src/main/index.ts` — injected Linux transparency/sandbox switches (`enable-transparent-visuals`, `disable-gpu-compositing`, `no-sandbox`) before `app.whenReady()`. Updated dev server port from 3000 to 58594
- `config/webpack.renderer.config.js` — updated devServer port from 8080 to 58594
- `.nvmrc` — updated Node version from 18 to 24
- `AGENTS.md` — synced from CLAUDE.md
- `run-source-linux.sh` — full rewrite with port management (58594/62340/63004), zombie kill, sandbox fix, port cleanup
- `run-source-mac.sh` — full rewrite with port management, zombie kill, port cleanup
- `run-source-windows.bat` — full rewrite with port management, zombie kill, port cleanup

#### Verified Compliant (no changes needed)
- `package.json` — author, scripts, GitHub URLs all correct
- `.gitignore` — all required entries present
- `archive/`, `docs/`, `resources/icons/`, `tests/`, `legacy/` — all directories exist
- `.editorconfig`, `VERSION_MAP.md` — present and valid

## [1.0.3] - 2026-03-14 UTC

### Documentation Standardization — 27-File Standard

#### Added
- `CODE_OF_CONDUCT.md` at repository root (Contributor Covenant v2.1, moved from `docs/`)
- `docs/DEPLOYMENT.md` — platform toolchain setup, artifact listing, release checklist, auto-update config
- `docs/PRD.md` — full product requirements with processing pipeline details, business rules, format list
- `docs/LEARNINGS.md` — architecture decisions, Python-to-TypeScript porting notes, known issues
- `docs/TODO.md` — UI wiring tasks, test coverage gaps, technical debt tracking

#### Changed
- `SECURITY.md` — updated supported versions (1.0.x), real contact email, documented actual security architecture (contextIsolation, InputValidator, path traversal prevention, navigation lock)
- `AGENTS.md` — complete rewrite with real codebase content: full directory map, all development commands, IPC channel reference, processing pipeline phases, key business rules
- `LICENSE` — updated copyright to "Copyright (c) 2026 Jason Paul Michaels"
- `docs/README.md` — rebuilt to index all 15 docs files with descriptions and key source file table
- `docs/FAQ.md` — rewritten with answers that reference actual code paths and real behavior
- `docs/INSTALLATION.md` — fixed all GitHub URLs (spacewelder314 → sanchez314c, META_Mover → meta-mover), fixed version (3.0 → 1.0)
- `docs/TECHSTACK.md` — fixed version header (3.0.0 → 1.0.0, September 2025 → March 2026)
- `README.md` — fixed all GitHub URLs (spacewelder314 → sanchez314c, META_Mover → meta-mover)
- `.github/ISSUE_TEMPLATE/bug_report.md` — fixed version example (3.0.0 → 1.0.0)
- `VERSION_MAP.md` — updated last-updated date

## [1.0.2] - 2026-02-08 11:39 UTC

### Repository Compliance Audit (FULL mode)

#### Changed
- **Flattened** `v1.0.01/` version folder to repository root (renamed to v1.0.0)
- **Renamed** `build-resources/` to `resources/` (standard convention)
- **Updated** all `build-resources` path references in package.json build config
- **Updated** package.json: author to "J. Michaels", GitHub URLs to sanchez314c/meta-mover
- **Updated** Electron scripts: added `--no-sandbox` to start/dev/start:prod, added `--dev` to dev script
- **Updated** .gitignore: added `legacy/`, `*.tsbuildinfo`, `dist_electron/`, `.cache/`, `.serena/cache/`
- **Consolidated** `versions/Python-Legacy/` into `legacy/Python-Legacy/`

#### Added
- `AGENTS.md` (copied from CLAUDE.md)
- `.nvmrc` (Node.js 18)
- `VERSION_MAP.md` (complete version inventory)
- `run-source-linux.sh`, `run-source-mac.sh`, `run-source-windows.bat` at project root
- `tests/` directory with `.gitkeep`
- **Documentation Suite**: ARCHITECTURE.md, BUILD_COMPILE.md, DEVELOPMENT.md, QUICK_START.md, DOCUMENTATION_INDEX.md, FAQ.md, TROUBLESHOOTING.md, WORKFLOW.md
- `archive/20260208_113948.tar.gz` (pre-audit backup)

#### Removed
- OS junk files (`._*` macOS resource forks)
- Empty `logs/` directory
- `v1.0.01/` version folder (flattened to root)
- `versions/` directory (consolidated into legacy/)

## [1.0.1] - 2026-02-08 11:43 UTC

### Added
- **Documentation Suite**: Created DEVELOPMENT.md, QUICK_START.md, and WORKFLOW.md in docs/ directory

### Changed
- Version bump: All version references changed from 3.0.0 to 1.0.0 across package.json, constants, App.tsx, FileOrganizer, ConfigManager, LegacyMigration, Logger, CLAUDE.md, CHANGELOG.md

## [1.0.0] - 2026-02-07 22:00 UTC

### Legacy Logic Port - Complete alignment with media-organizer-enhanced-v2.3.0-safe-optimized.py

#### Added
- **ART media type**: New `MediaType.ART` enum value with support for `.psd`, `.ai`, `.indd`, `.cdr`, `.dwg`, `.eps` formats (`media.ts`, `constants/index.ts`)
- **Subsecond metadata**: `subsecond` and `isScreenshot` fields on `MediaMetadata` interface (`media.ts`)
- **`artFiles` counter**: Added to `ProcessingStatistics` interface for ART media type breakdown (`media.ts`)
- **Screenshot detection**: EXIF UserComment-based iOS/macOS screenshot detection in MetadataExtractor — iOS: `UserComment == "Screenshot"`, macOS: starts with `{{` and contains `},` (CGRect pattern)
- **EXIF write-back**: `setExifCreateDateFromFilename()` in FileOrganizer — writes CreateDate + SubSecTimeOriginal back via exiftool after move, syncs filesystem mtime/atime
- **Empty directory cleanup**: `removeEmptyDirectories()` in FileOrganizer — recursive removal of empty dirs after processing (matches legacy `remove_empty_directories()`)
- **Disk space check**: `checkDiskSpace()` in FileOrganizer using `statfsSync`
- **Final sweep**: `performFinalSweep()` in ProcessingEngine — re-scans source directories for remaining files after initial pass (matches legacy `perform_final_sweep()`)
- **Worker optimization**: `optimizeCoreUsage()` in ProcessingEngine — matches legacy formula: >=12 cores: 6 workers, >=8: 5, >=4: 4, else: 2
- **Output directory exclusion**: FileDiscovery now skips directories named 'output' (case-insensitive), matching legacy `dirs[:] = [d for d in dirs if d.lower() != 'output']`
- **MPO to JPEG conversion**: FileOrganizer renames `.mpo` files to `.jpg` during organization

#### Changed
- **DateExtractor**: Complete rewrite with all legacy patterns:
  - Century correction: years 1000-1999 → last 2 digits + 2000; 100-999 → +2000; 1-99 → +2000
  - Date validation bounds: 1990-01-01 to current year Dec 31
  - 4 filename patterns: IMG/VID/PIC/PHOTO prefix, YYYY-MM-DD_HH-MM-SS, YYYYMMDD_HHMMSS, Screenshot format
  - `isAlreadyProcessed()`: Detects legacy processed filenames, rejects all-zero subseconds
  - `formatFilenameWithDate()`: YYYY-MM-DD_HH-MM-SS[.sss].ext format
- **MetadataExtractor date priority**: Now matches legacy order — MediaCreateDate > TrackCreateDate > ContentCreateDate > DateTimeOriginal > CreateDate > DateTime > DateCreated > DateTimeDigitized (was previously DateTimeOriginal-first)
- **MetadataExtractor resolution**: Video resolution now uses shorter side (orientation-aware) — `min(width, height)` for resolution category (matches legacy)
- **MetadataExtractor subsecond**: Extracts SubSecTimeOriginal/SubSecTime from EXIF data
- **MetadataExtractor century correction**: Applied to all extracted dates (EXIF, video tags, fallback)
- **FileOrganizer**: Complete rewrite with legacy organization logic:
  - Output path: `{mediaFolder}/{year}`, Screenshots → `Screenshots/{year}`, Corrupt → `corrupt/{mediaFolder}/{year}`, Error → `Error/{mediaFolder}/{year}`
  - Filename: YYYY-MM-DD_HH-MM-SS[.sss].ext with 2-digit zero-padded conflict counters (`_01`, `_02`)
  - `sanitizeFilename()`: Removes control chars, replaces `<>:"|?*`, limits to 250 chars
  - Media folder map matches legacy: image→Photos, video→Videos, audio→Audio, document→Documents, art→Art
- **CorruptionDetector VidBeast logic**:
  - Empty file (0 bytes) → immediate CATASTROPHIC
  - If video plays fine with ≤1 minor issues → clear all corruption types to NONE
  - Bitrate sanity check: < 10000 bps → MODERATE
  - Final decision: NONE/MINOR → treated as NONE (only MODERATE+ counts as corrupted)
  - Playability test: 5-second duration (was 10), 15s timeout, legacy ffmpeg arg order
- **ProcessingEngine**: Uses `optimizeCoreUsage()` for worker count and batch sizes instead of raw CPU count
- **ProcessingEngine**: Discovery now properly stats files for size and passes `excludeOutputDirs: true`
- **ProcessingEngine**: Cleanup phase now removes empty directories from source paths
- **Constants**: All format arrays updated to match legacy — added `.mpo`, `.ptx`, `.svg`, `.mpg`, `.mpeg`, `.caf`, `.amr`, `.wmf`, `.xls`, `.xlsx`, `.ppt`, `.pptx`
- **Constants**: Processing limits updated — `FFPROBE_TIMEOUT: 30`, `FFMPEG_PLAYABILITY_TIMEOUT: 15`, `EXIFTOOL_TIMEOUT: 30`, `PLAYABILITY_TEST_DURATION: 5`, `MIN_ACCEPTABLE_BITRATE: 10000`

#### Files Modified
- `src/shared/types/media.ts`
- `src/shared/constants/index.ts`
- `src/main/utils/DateExtractor.ts`
- `src/main/core/MetadataExtractor.ts`
- `src/main/core/FileOrganizer.ts`
- `src/main/core/CorruptionDetector.ts`
- `src/main/core/FileDiscovery.ts`
- `src/main/core/ProcessingEngine.ts`

## [0.9.0] - 2024-09-XX

### Added
- Initial TypeScript/React rewrite from legacy Python
- Modern Electron architecture
- Professional media organization features
- Cross-platform support (macOS, Windows, Linux)
- Redux state management
- Styled Components for UI
- Internationalization support

### Changed
- Migrated from Python legacy versions to TypeScript
- Improved performance and stability
- Enhanced user interface

### Removed
- Legacy Python implementations (kept in versions/ for reference)

## [2.0.0] - 2024-XX-XX

### Added
- Enhanced media processing capabilities
- GPU acceleration support
- Advanced metadata extraction

### Changed
- Improved file organization algorithms
- Better error handling

## [1.9.4] - 2024-XX-XX

### Fixed
- Various bug fixes in media organization
- Improved date extraction accuracy

## [1.9.0] - 2024-XX-XX

### Added
- New media formats support
- Enhanced reporting features

### Changed
- Performance optimizations

## [1.8.3] - 2024-XX-XX

### Fixed
- Critical bugs in file processing
- Memory usage improvements

## [1.8.1] - 2024-XX-XX

### Added
- Basic video processing
- Audio organization features

## [1.7.0] - 2024-XX-XX

### Added
- Initial media organization features
- Basic file moving capabilities
- Metadata extraction

### Changed
- Improved file discovery algorithms

## [1.0.0] - 2024-XX-XX

### Added
- Initial release
- Basic media file organization
- Python-based implementation