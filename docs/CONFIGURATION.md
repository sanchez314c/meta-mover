# Configuration

META Mover stores schema-3 JSON under Electron's `userData` directory. The app reads and writes it through `AppConfigStore`; hand editing while the app is running is not supported.

## Current schema

```json
{
  "version": 3,
  "theme": "system",
  "processing": {
    "workerCount": 4,
    "operation": "copy",
    "verifyIntegrity": true
  },
  "organization": {
    "folderStructure": "year/month",
    "conflictPolicy": "rename",
    "appendScreenshotSuffix": false
  }
}
```

| Setting                               | Allowed values                     | Default      |
| ------------------------------------- | ---------------------------------- | ------------ |
| `theme`                               | `light`, `dark`, `system`          | `system`     |
| `processing.workerCount`              | integer 1 through 10               | `4`          |
| `processing.operation`                | `copy`, `move`                     | `copy`       |
| `processing.verifyIntegrity`          | `true` only                        | `true`       |
| `organization.folderStructure`        | `year/month`, `year-month`, `flat` | `year/month` |
| `organization.conflictPolicy`         | `skip`, `rename`                   | `rename`     |
| `organization.appendScreenshotSuffix` | `true`, `false`                    | `false`      |

Window bounds may contain width, height, x, and y within validated limits.

Unknown keys fail validation. Schema-2 configuration is migrated once to schema 3. The retired corruption option is dropped only during that legacy read and is rejected in current updates.

When `organization.appendScreenshotSuffix` is enabled, META Mover appends `-screen-shot` before the extension only for image files with explicit screenshot filename or metadata evidence. Dimension-only and device-only guesses are rejected. Existing job history that predates this setting is loaded with the option disabled.

Integrity checks, preview revalidation, source conservation, no-clobber publication, and metadata immutability are safety rules, not optional settings.
