# Six-digit subsecond padding override

`repair_subsecond_padding.py` is a Python 3 script using the installed ExifTool. It recursively inspects regular files regardless of extension, detects actual image MIME/type, and records an outcome for each. It has bounded queues, one persistent ExifTool process per worker, progress output, and no app integration. The adjacent `repair_heif_integrity.py` helper validates HEIF item storage. Pillow is required only for GIF all-frame checks.

Start with copies and a dry run:

```bash
python3 tools/repair_subsecond_padding.py /path/to/test/input --workers 8 --audit /path/to/dry-run.jsonl
python3 tools/repair_subsecond_padding.py /path/to/test/input --workers 8 --audit /path/to/apply.jsonl --apply
```

The default is a dry run. `--apply` executes the user's explicit library-specific override: remove leading zeros from exactly six ASCII digits representing subseconds, preserving trailing zeros. `000065` becomes `65`, `001200` becomes `1200`, and `000000` becomes `0`. Six digits without leading zeros and all other lengths stay unchanged. No corroboration or confidence check is required. This is a manual correction policy for the library's history, not an industry standard or proof of the real capture instant.

Targets include existing `SubSecTime*` fields, including modification subseconds, and fractional portions of scalar embedded date/time tags. Whole dates, seconds, timezone suffixes and filenames stay unchanged. Semantic date/time and writable tags come from the installed ExifTool XML registry, loaded once at startup. Arbitrary six-digit IDs, descriptions, filesystem dates and calculated Composite fields are excluded.

Read-only tags, structured/list dates, and genuinely duplicated tag instances are explicit unsupported targets. Flattened XMP history edits could detach dates from events, so these stay untouched. A unique ExifTool CopyN label is normalized to its writable family/tag name. Supported fields may be repaired while unsupported fields remain, yielding `repaired_partial` and a nonzero exit status.

Actual writable image formats come from ExifTool capabilities, including aliases such as Extended WEBP. Non-images get `not_image`; missing writers or integrity methods get `unsupported`. There is no promise that every existing or future image format is writable. Incorrect filename extensions do not prevent inspection.

Candidates are copied to private staging files and rewritten there. All extracted embedded metadata and binary previews must remain equal except intended time changes and recognized physical storage pointers. ExifTool native SHA-256 protects supported image data, including TIFF strips/tiles and common RAW formats. JPEG additionally checks coding tables, frame headers and scan bytes; HEIC/AVIF additionally validate HEIF item storage. GIF checks every frame's pixels, palette, dimensions, timing and disposal through Pillow. Unsupported layouts remain explicit failures.

Thumbnail/preview/MP-image pointers, including IFD/SubIFD preview locations in RAW files, may relocate only when their extracted binary content remains equal. TIFF strip/tile pointers require the native image-data hash to remain equal. HEIF media-data box size/offset can change because the box also stores metadata; native and all-item helper hashes still protect its images and interpretation structures. A failed check leaves the source unchanged. Successful verification creates an exclusive adjacent `_original` backup of the original inode, atomically publishes the stage and syncs the directory. Keep inputs idle and do not run concurrent writers on the same tree. Repaired outputs require additional space approximately equal to repaired file sizes.

Warnings are not globally ignored. The exact stale IPTCDigest warning remains in the audit; it describes a checksum mismatch rather than damaged image storage. The exact large-array decoding warning triggers a conditional full-array read only after preflight finds no other problem, then complete values are compared. Other warnings and errors remain visible failures. No digest or unrelated metadata is silently corrected.

Reruns re-read files; corrected values no longer match. Backups and private stages get `artifact` records and are never processed. Existing backups block writes. JSONL records the policy, exact old/new values, warnings, unsupported targets and integrity results. Keep the `.jsonl` audit outside the input tree without symlink/hardlink aliases. It flushes every second and syncs on completion. Abrupt machine failure can lose final log records or leave a private stage; original backups prevent blind overwrites. Symlinks are not followed. Newline/carriage-return filenames fail visibly because ExifTool's line protocol cannot represent them safely.

`--workers` defaults to at most 16 and accepts 1 through 256. Benchmark 4, 8 and 16 on spinning RAID; extra outstanding seeks can reduce throughput. `--limit N` bounds file discovery; `--timeout SECONDS` limits each ExifTool operation. Progress reports counts, queued work, elapsed time, rate and latest completed filename. Errors, blocked files, unsupported formats/targets and partial repairs return nonzero. Tests operate on copies, not the original library.

Tests:

```bash
python3 -m unittest discover -s tests/python -v
```
