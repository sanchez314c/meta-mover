# Configuration

All configuration options for META Mover, where settings are stored, and how to change them.

## Where Settings Live

Settings are stored in the Electron `userData` directory under `config.json`:

- **macOS**: `~/Library/Application Support/META Mover/config.json`
- **Windows**: `%APPDATA%\META Mover\config.json`
- **Linux**: `~/.config/META Mover/config.json`

The file is managed by `ConfigManager` (`src/main/services/ConfigManager.ts`). You can edit it while the app is closed, or use the Settings view in the UI.

## Settings Reference

### Processing Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `datePreference` | string | `'MediaCreateDate'` | Primary metadata field for date extraction. Falls back through the priority chain if not found. |
| `conflictResolution` | string | `'skip'` | What to do when a file already exists at the destination: `skip`, `rename`, or `overwrite`. |
| `videoOrganization` | string | `'flat'` | `flat` = Videos/{year}/, `resolution` = Videos/{resolution}/{year}/ |
| `enableCorruptionDetection` | boolean | `true` | Run 4-phase corruption analysis on all files. |
| `dryRun` | boolean | `false` | Preview organization targets without moving any files. |
| `operationType` | string | `'move'` | `move` or `copy` — whether to move files or copy them. |
| `batchSize` | number | `100` | Files to process per batch. Lower this if you hit memory pressure. |
| `maxWorkers` | number | auto | Worker thread count. Defaults to the `optimizeCoreUsage()` formula based on CPU count. |

### Date Extraction Priority

The `datePreference` setting only controls the primary field. The full fallback chain is always applied in this order:

1. `MediaCreateDate`
2. `TrackCreateDate`
3. `ContentCreateDate`
4. `DateTimeOriginal`
5. `CreateDate`
6. `DateTime`, `DateCreated`, `DateTimeDigitized`
7. Filename patterns (`IMG_`, `VID_`, `YYYY-MM-DD_HH-MM-SS`, Screenshot formats)
8. Filesystem `ctime`

### UI Settings

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `theme` | string | `'system'` | `light`, `dark`, or `system` (follows OS setting). |
| `sidebarCollapsed` | boolean | `false` | Sidebar collapsed state. Saved on close. |
| `windowBounds` | object | — | Last known window size and position. Restored on launch. |

## IPC Access

The renderer reads and writes settings through IPC:

```typescript
// Read a value
const value = await window.electronAPI.getConfig('conflictResolution');

// Write a value
await window.electronAPI.setConfig('conflictResolution', 'rename');

// Reset to defaults
await window.electronAPI.resetConfig();
```

## ConfigManager API

From the main process, `ConfigManager` exposes:

```typescript
configManager.get<T>(key: keyof AppConfig, defaultValue?: T): T
configManager.set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void
configManager.watch(key: string, callback: (value: any) => void): void
```

## Build-Time Configuration

A few things are set at build time and can't be changed at runtime:

| Setting | Value | Where set |
|---------|-------|-----------|
| App ID | `com.speedheathens.metamover` | `package.json` → `build.appId` |
| Dev server port | `58594` | `config/webpack.renderer.config.js` |
| Auto-update provider | GitHub (`sanchez314c/meta-mover`) | `package.json` → `build.publish` |
| Worker restart limit | 3 | `src/shared/constants/index.ts` → `MAX_WORKER_RESTARTS` |
| FFprobe timeout | 30 seconds | `src/shared/constants/index.ts` → `FFPROBE_TIMEOUT` |
| FFmpeg playability timeout | 15 seconds | `src/shared/constants/index.ts` → `FFMPEG_PLAYABILITY_TIMEOUT` |
| Minimum acceptable bitrate | 10,000 bps | `src/shared/constants/index.ts` → `MIN_ACCEPTABLE_BITRATE` |

## Supported File Formats

Controlled by arrays in `src/shared/constants/index.ts`:

- **Images**: JPEG, PNG, TIFF, HEIC, RAW (CR2, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW, X3F, PTX), WebP, AVIF, MPO (renamed to .jpg on organize), BMP, GIF, SVG, WMF
- **Videos**: MP4, MOV, AVI, MKV, WebM, M4V, 3GP, WMV, FLV, TS, MPG, MPEG
- **Audio**: MP3, FLAC, WAV, AAC, OGG, ALAC (M4A), AIFF, WMA, CAF, AMR
- **Documents**: PDF, DOC, DOCX, TXT, XLS, XLSX, PPT, PPTX
- **Art**: PSD, AI, INDD, CDR, DWG, EPS

To add a format, append it to the relevant array in `constants/index.ts`. If it needs corruption detection, also add a magic byte validator in `CorruptionDetector.getHeaderValidators()`.
