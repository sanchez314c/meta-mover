# Frequently Asked Questions

## Running the Application

**How do I run META Mover from source on Linux?**

```bash
npm install
npm run dev
```

If Electron crashes with a credentials/sandbox error, run:
```bash
sudo sysctl -w kernel.unprivileged_userns_clone=1
```

Or use `./run-source-linux.sh` which passes `--no-sandbox` automatically.

**The app builds but shows a blank window.**

Verify the webpack build completed without errors first:
```bash
npm run build:dev
```
Then run `npm start`. In development mode (`npm run dev`), DevTools open automatically — check the console tab for JS errors.

---

## File Organization

**What output folder structure does META Mover create?**

Files are placed in `{destination}/{type}/{year}/` by default:

```
Photos/2024/
Videos/2024/
Audio/2024/
Documents/2024/
Art/2024/
Screenshots/2024/    ← iOS/macOS screenshots
corrupt/Photos/2024/ ← MODERATE+ corruption
Error/Photos/2024/   ← Files that failed to process
```

**What filename format is used?**

`YYYY-MM-DD_HH-MM-SS[.sss].ext`

The subsecond component (`.sss`) is included when EXIF `SubSecTimeOriginal` is present. Conflicts get a zero-padded 2-digit counter: `2024-06-15_14-30-00_01.jpg`.

**What happens to files that fail during organization?**

They are moved to `{destination}/Error/{mediaFolder}/{year}/` and counted in `statistics.failedFiles`. The job continues processing remaining files.

**What is the Screenshots folder?**

iOS screenshots embed `"Screenshot"` in EXIF `UserComment`. macOS screenshots embed a CGRect string like `"{{0,0},{1440,900}}"`. `MetadataExtractor` detects both and sets `metadata.isScreenshot = true`, causing `FileOrganizer` to route those images to `Screenshots/` instead of `Photos/`.

**What happens to `.mpo` files?**

MPO (Multi Picture Object, used by some 3D cameras) files are renamed to `.jpg` during organization. The binary content is valid JPEG and opens in standard viewers.

---

## Metadata and Dates

**What is the date extraction priority?**

From highest to lowest priority (matching legacy v2.3.0):
1. `MediaCreateDate`
2. `TrackCreateDate`
3. `ContentCreateDate`
4. `DateTimeOriginal`
5. `CreateDate`
6. `DateTime`, `DateCreated`, `DateTimeDigitized`
7. Filename regex patterns (IMG_, VID_, Screenshot, `YYYY-MM-DD_HH-MM-SS` formats)
8. Filesystem `ctime`

**Why are some files getting wrong year values like 2112?**

This is the century correction working on a camera with a dead CMOS battery. When a camera's clock resets, it may stamp dates in year 1–1999. `DateExtractor.correctCentury()` adds 2000 to any year below 2000. A date stamped as year 112 becomes year 2112. Check whether the camera clock was set correctly.

**Does META Mover write back to the original files?**

After placing a file at its destination, `FileOrganizer.setExifCreateDateFromFilename()` does:
1. Sets filesystem `mtime`/`atime` to the date encoded in the filename via `fs.utimesSync()`
2. Runs `exiftool -CreateDate= -overwrite_original` as a best-effort EXIF write-back

The EXIF write-back only runs if `exiftool` is on PATH. It silently skips if not found. Filesystem timestamps are always updated.

---

## Corruption Detection

**Why is a playable file going to the `corrupt/` folder?**

The corruption detector runs four phases. Phase 3 (bitstream sampling) reads 1 KB samples at 100 evenly-spaced offsets and checks for statistical anomalies — it can flag valid files if they have unusual byte patterns. The VidBeast false-positive prevention rule should handle most cases: if `ffmpeg -v error -i file -t 5 -f null -` exits with code 0 and there is at most one minor issue, all corruption types are cleared and the level becomes NONE.

Only MODERATE and above actually routes files to `corrupt/`. MINOR and NONE both result in the file being organized normally.

**What counts as CATASTROPHIC?**

An empty file (0 bytes) is immediately classified as CATASTROPHIC with no further analysis. This is consistent with the original VidBeast behavior.

---

## Building and Distribution

**How do I build a signed macOS DMG?**

```bash
export CSC_LINK=/path/to/Developer-ID-Application.p12
export CSC_KEY_PASSWORD=your-password
npm run dist:mac
```

The `package.json` build config has `"notarize": false`. To enable notarization also export `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD`.

**Can I build all three platforms on Linux?**

Linux builds work on Linux. macOS DMG files require macOS toolchain. Windows installers can be cross-compiled but are not officially supported by electron-builder — use a Windows runner in CI for reliable results.

**Native module build failures on Windows?**

Install Visual Studio Build Tools (needed for `sharp` and `sqlite3`):
```bash
npm install --global windows-build-tools
```

Then:
```bash
npm rebuild
npm run build
```

---

## Development

**How do I add a new supported file format?**

Add the extension to the appropriate array in `src/shared/constants/index.ts` — `SUPPORTED_IMAGE_FORMATS`, `SUPPORTED_VIDEO_FORMATS`, etc. — and to `ALL_SUPPORTED_FORMATS`. If corruption detection is needed for the format, add a magic byte validator in `CorruptionDetector.getHeaderValidators()`.

**Where are logs written?**

`Logger` wraps `electron-log`. Log files land at:
- macOS: `~/Library/Logs/META Mover/`
- Windows: `%APPDATA%\META Mover\logs\`
- Linux: `~/.config/META Mover/logs/`

In development, logs also print to the terminal and DevTools console.

**How do I run only the unit tests?**

```bash
npm test                  # Run all Jest tests
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report in coverage/
```

Test files go next to source files as `*.test.ts` or in `__tests__/` directories (see `package.json` `jest.testMatch`).

**What are the TypeScript path aliases?**

- `@main/*` → `src/main/*`
- `@renderer/*` → `src/renderer/*`
- `@shared/*` → `src/shared/*`
- `@preload/*` → `src/preload/*`

These are configured in `config/tsconfig.json` and all three webpack configs.
