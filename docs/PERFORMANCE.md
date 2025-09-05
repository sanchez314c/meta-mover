# Performance

How META Mover handles large media collections without running out of memory or grinding to a halt.

## Worker Threads

Heavy processing runs in worker threads, not the main process. `ProcessingEngine` spawns workers based on CPU count using `optimizeCoreUsage()`:

| CPU cores | Workers spawned |
|-----------|-----------------|
| >= 12     | 6               |
| >= 8      | 5               |
| >= 4      | 4               |
| < 4       | 2               |

Workers are monitored for health. If a worker exits unexpectedly, it restarts automatically — up to 3 times (`MAX_WORKER_RESTARTS`). After 3 restarts, the engine falls back to single-threaded processing rather than crashing.

If the worker JS bundle isn't found at `dist/workers/ProcessingWorker.js`, the engine also falls back to single-threaded mode silently.

## Batch Processing

Files are processed in batches of 100 by default (`batchSize` config option). Each batch runs through the 6-phase pipeline:

1. Discovery — scan source directories (skips dirs named "output")
2. Validation — stat each file, filter by supported format
3. Metadata extraction — EXIF/XMP via `exifr`, video via `ffprobe`
4. Corruption detection — 4-phase analysis (container, stream, bitstream, playability)
5. Organization — determine output path, move/copy file
6. Cleanup — remove empty source directories

Lower the batch size if you're running out of memory on large collections.

## Memory Recommendations

| Collection size | Recommended RAM |
|-----------------|-----------------|
| Up to 5,000 files | 4 GB minimum |
| 5,000–20,000 files | 8 GB recommended |
| 20,000+ files | 16 GB recommended |

If the app becomes unresponsive, increase Node.js heap size before launching:

```bash
export NODE_OPTIONS="--max-old-space-size=8192"
npm start
```

## Stream-Based File Operations

`FileSystemUtils` uses Node.js streams for file copies rather than loading entire files into memory. This means a 4 GB video file doesn't consume 4 GB of RAM during a copy operation.

For cross-device moves (e.g., moving from an external drive to an internal one), the implementation copies first, then verifies the copy size matches the source, then deletes the source. If sizes don't match, the bad destination copy is removed and the original is preserved.

## SQLite for Job History

Job history and file cache are stored in SQLite rather than a JSON file. This keeps lookups fast even with thousands of records. The file cache (`file_cache` table) stores file hashes so future runs can skip unchanged files.

Known limitation: job UUID lookups currently use `json_extract(metadata, '$.jobId')` which doesn't benefit from indexing. Adding a proper `uuid TEXT UNIQUE` column is listed in TODO.md and will improve performance with large job histories.

## Metadata Caching

`DatabaseManager` caches extracted metadata per file path. Subsequent runs skip re-extraction for files that haven't changed, based on content hash stored in `file_cache`.

## FFprobe Timeouts

All FFprobe calls have a 30-second timeout (`FFPROBE_TIMEOUT`). The playability test (phase 4 of corruption detection) uses a 15-second timeout (`FFMPEG_PLAYABILITY_TIMEOUT`) and only tests the first 5 seconds of video (`PLAYABILITY_TEST_DURATION`). This keeps corruption detection from hanging on files with deceptive headers.

## Bundle Size

Webpack is configured for production builds with minification (Terser), tree-shaking, and code splitting. Run the analyzer to see where bundle weight is going:

```bash
npm run bundle:analyze
```

To check for bloat issues:

```bash
npm run bloat-check
```

## Profiling

`PerformanceMonitor` (`src/main/utils/PerformanceMonitor.ts`) tracks processing metrics including per-file timing, memory usage, and throughput. In development mode, metrics are logged to the terminal. Check the logs directory for recorded metrics:

- **macOS**: `~/Library/Logs/META Mover/`
- **Windows**: `%APPDATA%\META Mover\logs\`
- **Linux**: `~/.config/META Mover/logs/`
