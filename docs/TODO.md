# TODO

Outstanding work for META Mover v1.0 and beyond.

## Immediate (v1.0 Completeness)

### UI Wiring
- [ ] Build `JobCreationForm` component — source/destination path selectors, options panel
- [ ] Build `JobProgressView` component — connect to `processing:progress` IPC event
- [ ] Build `JobHistoryView` component — read from `jobsSlice.history`
- [ ] Replace `App.tsx` local state status dot with `selectIsLoading` Redux selector
- [ ] Wire `useSelector(selectIsDarkMode)` from `appSlice` to `ThemeProvider`

### IPC Alignment
- [ ] `src/preload/index.ts` exposes `getSystemInfo`, `selectDirectory`, `startProcessing`, `stopProcessing`, `onProgress`, `removeProgressListener` — align with full `IPC_CHANNELS` set registered in `IPCHandler`
- [ ] Add `invoke` passthrough to preload for job management channels (`job:create`, `job:pause`, `job:cancel`, etc.)

### Database
- [ ] Add a proper `uuid TEXT UNIQUE` column to the `jobs` table with an index — current approach uses `json_extract(metadata, '$.jobId')` which is slow at scale
- [ ] Wrap `DatabaseManager.close()` in a Promise so `await databaseManager.close()` in `index.ts` is semantically correct

### MenuBuilder
- [ ] Enable `MenuBuilder` in `src/main/index.ts` (currently commented out) — wire File, Edit, View, Help menu actions to IPC handlers

## Testing (High Priority)

- [ ] Unit tests for `DateExtractor` — century correction, all 4 filename regex patterns, `isAlreadyProcessed()`, `formatFilenameWithDate()`
- [ ] Unit tests for `FileOrganizer` — `determineOutputPath()` with each media type and corruption level, `sanitizeFilename()` edge cases, conflict counter wraparound
- [ ] Unit tests for `CorruptionDetector` — empty file → CATASTROPHIC, VidBeast false-positive clear rule, MINOR→NONE final decision
- [ ] Unit tests for `MetadataExtractor` — date field priority order, century correction applied to EXIF, screenshot detection patterns
- [ ] Integration test for `ProcessingEngine` — full 6-phase pipeline on a small fixture set
- [ ] Renderer component tests for `App.tsx`, `ErrorBoundary.tsx`, `LoadingSpinner.tsx`
- [ ] Reach 80% coverage target across `src/main/core/` and `src/main/utils/`

## v1.1 Features

- [ ] Processing preview mode — show `organizeFile()` targets without moving files
- [ ] Backup manifest creation before destructive operations (call `FileOrganizer.createBackup()`)
- [ ] Report generation — HTML/CSV output summarizing processed files, errors, and corruption findings
- [ ] Incremental processing — populate `file_cache` table with hash + metadata after processing; skip on re-run if unchanged
- [ ] Settings persistence UI — expose `organizationOptions` from `ConfigManager` in a settings panel
- [ ] Multiple source paths — `ProcessingJob.sourcePaths` is already an array; the UI should allow adding multiple sources

## v1.2 Features

- [ ] Processing profiles — save/load named `ProcessingOptions` configurations
- [ ] GPU acceleration — integrate `sharp` GPU pipeline for image processing on compatible hardware
- [ ] Duplicate detection — hash-based deduplication using `file_cache`; report duplicates before processing
- [ ] Auto-update UI — show update prompt when `electron-updater` fires `update-downloaded`

## Technical Debt

- [ ] `LegacyMigration.ts` service exists but is not invoked anywhere — wire it to app initialization to detect and migrate v2.x Python settings
- [ ] `WindowManager.ts` creates a new `BrowserWindow` internally but `src/main/index.ts` also creates one directly in `createMainWindow()` — consolidate to avoid duplication
- [ ] `simple.ts` in `src/main/` appears to be an unused stub — remove or integrate
- [ ] `src/renderer/i18n.ts` sets up i18next but translations are not loaded — add at least an `en` locale JSON file
- [ ] `src/shared/constants.ts` at root level vs `src/shared/constants/index.ts` — there appear to be two constants files; audit and consolidate

## Documentation Gaps

- [ ] API.md — update to reflect actual public method signatures (current signatures differ from actual code)
- [ ] Add JSDoc comments to all public methods in `ProcessingEngine`, `MetadataExtractor`, `FileOrganizer`
- [ ] Document all `IPC_CHANNELS` values with expected payload types
