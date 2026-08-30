# API

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
    workerCount: number;
    verifyIntegrity: true;
    writeMetadataDates: false;
  };
}
```

`writeMetadataDates` is a compatibility field fixed to `false`. Any other value is rejected.

The preview result includes `jobId`, `previewId`, timestamps, effective options, summary counts, and rows. Each row includes source, proposed target, operation, conflict action, fingerprint, date evidence, confidence, and warnings.

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

Move requires `acknowledgeDestructiveOperation: true`. Cancellation stops new admission and lets an active atomic file transaction settle.

## Events

`processing:event` emits strictly increasing per-job sequences:

- `preview-started`, `preview-ready`
- `job-queued`, `job-started`, `job-progress`
- `job-cancelling`
- `job-completed`, `job-failed`, `job-cancelled`

Every current DTO uses plain serializable values. Unknown keys, accessors, cyclic values, `undefined`, non-finite numbers, and class instances are rejected at boundaries.
