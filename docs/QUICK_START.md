# Quick start

## From source

Install Node.js 22.12 or newer, npm 10.9, Rust 1.85.1, Git, and the native compiler tools for your OS.

```bash
git clone https://github.com/sanchez314c/meta-mover.git
cd meta-mover
npm ci
npm run package:stage-tools
npm run dev
```

`npm ci` uses the locked registry graph. Tool staging copies package-managed ExifTool plus the current-platform Rust binaries into `.build-tools/tools`. It does not install system packages.

## First run

1. Select one or more source folders.
2. Select a separate destination folder.
3. Keep Copy selected unless source deletion is intended.
4. Choose Skip or Rename for destination conflicts.
5. Generate the preview.
6. Review the chosen date, provenance, warnings, and target for every row.
7. Start the job. Move requires an explicit destructive-operation acknowledgement.

Uncertain dates target `_Needs Review`. The app does not rewrite the file to make an inferred date look authoritative.

Unsupported or unrecognized regular files are not hidden. They appear as skipped `Needs Review` rows and remain unchanged at the source.

## Verify the checkout

```bash
npm run verify
npm run build
npm run package:integrity
```

The current verified package path is Linux x64 `deb` or `rpm`. AppImage and portable builds are intentionally unsupported.
