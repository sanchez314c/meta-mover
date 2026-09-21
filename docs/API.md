# API

## Test-run corpus IPC

- `test-run:gather` accepts canonical absolute source and destination paths plus `fileCount: 15000`. It stages beside the destination, publishes `test-run:progress` scan/copy events, and returns the private temporary source path plus scanned and copied counts.
- `test-run:discard` accepts only a corpus source path owned by META Mover's temporary root. Arbitrary paths are rejected.
- `test-run:cancel` stops further scan or copy admission. An incomplete app-owned corpus is removed before cancellation returns.
- Existing `META-Mover-Test-Run-*` directories are excluded from sampling. The renderer previews and processes only the returned copied corpus.

The renderer has no generic IPC function. `src/preload/index.ts` exposes these named methods on `window.electronAPI`:

| Method                                                  | Purpose                                       |
| ------------------------------------------------------- | --------------------------------------------- |
| `getSystemInfo()`                                       | Read non-secret platform information          |
| `selectDirectory()`                                     | Open the directory picker                     |
| `previewProcessing(request)`                            | Create a non-mutating preview                 |
| `startProcessing(request)`                              | Start an unchanged preview                    |
| `cancelProcessing(request)`                             | Request job cancellation                      |
| `getProcessingHealth()`                                 | Check bundled runtime readiness               |
| `getJobHistory(limit?)`                                 | Read recent durable job state                 |
| `onProcessingEvent(callback)`                           | Subscribe and receive an unsubscribe function |
| `getConfig()`                                           | Read schema-3 settings                        |
| `updateConfig(update)`                                  | Apply a strict partial update                 |
| `resetConfig()`                                         | Restore safe defaults                         |
| `windowMinimize()`, `windowMaximize()`, `windowClose()` | Window controls                               |
| `openExternal(url)`                                     | Open validated HTTP, HTTPS, or mail links     |
| `openPath(path)`                                        | Ask the OS to open a validated path           |
| `getPath(name)`                                         | Read an allowlisted Electron path             |

## Preview request

```ts
interface PreviewRequestDTO {
  sourcePaths: string[];
  destinationPath: string;
  options: {
    operation: 'copy' | 'move';
    conflictPolicy: 'skip' | 'rename';
    folderStructure: 'year/month' | 'year-month' | 'flat';
    appendScreenshotSuffix: boolean;
    workerCount: number;
    verifyIntegrity: true;
    writeMetadataDates: boolean;
  };
}
```

`writeMetadataDates` defaults to `false`. When enabled, a successful approved copy or move with a resolved date removes writable destination date/time tags, writes the selected date to standard image, video-container, track, media, and filesystem fields, and preserves non-date metadata. It never writes the source or an unresolved file. ExifTool rewrites the committed destination, so this optional post-processing step is size-dependent.

The preview result includes `jobId`, `previewId`, timestamps, effective options, summary counts, and rows. Each row includes source, proposed target, operation, conflict action, fingerprint, date evidence, confidence, and warnings.

Date resolution ranks valid embedded creation metadata first and bounded filename timestamps second. Filesystem modification, access, inode-change, metadata-modification, and profile dates are never accepted as creation truth. Filesystem birth time may be retained as low-confidence provenance for review, but it cannot resolve a file by itself. Conflicting claims and files with no valid creation claim remain unresolved or ambiguous and keep their original basename under `_Needs Review`.

## Start and cancel

```ts
interface StartProcessingRequestDTO {
  previewId: string;
  acknowledgeDestructiveOperation: boolean;
}

interface CancelProcessingRequestDTO {
  jobId: string;
  reason?: string;
}
```

Move requires `acknowledgeDestructiveOperation: true`. During preview, `cancelProcessing` uses the preview `jobId` to stop read-only analysis. Once the final progress event is emitted, cancellation closes and preview persistence finishes. During processing, cancellation stops new admission and lets an active atomic file transaction settle.

## Events

`processing:event` emits strictly increasing per-job sequences:

- `preview-started`, `preview-progress`, `preview-ready`
- `job-queued`, `job-started`, `job-progress`
- `job-cancelling`
- `job-completed`, `job-failed`, `job-cancelled`

Every current DTO uses plain serializable values. Unknown keys, accessors, cyclic values, `undefined`, non-finite numbers, and class instances are rejected at boundaries.

`preview-progress` reports `phase`, `filesProcessed`, `totalFiles`, `percentage`, and `currentFile` while a file is active. Discovery is indeterminate until inventory establishes the total. Progress must start at zero, advance without regression, and finish at 100 percent with the same total as the preview summary.
