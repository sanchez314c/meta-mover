# Architecture

## Runtime graph

META Mover has one active Electron composition:

```text
React renderer
  -> typed preload bridge
  -> CoreIPCController and ProcessingIPCController
  -> ProcessingCoordinator
  -> inventory, metadata candidates, date resolver, planner, revalidator
  -> TransactionalOperationExecutor
  -> NativeTransactionFilesystem
  -> launch broker -> filesystem helper
```

`src/main/index.ts` creates `ElectronMain`, which owns `ProductionApplicationRuntime`. Startup constructs configuration, JSONL history, evidence manifests, bundled-runtime health, metadata extraction, preview planning, revalidation, transactions, and IPC in dependency order. Shutdown stops admission, drains active work, closes owners, and reports all cleanup failures.

There is no Python bridge, SQLite manager, FFmpeg worker, old processing engine, duplicate IPC graph, or auto-updater in the active runtime.

## Evidence-ranked dates

`MetadataCandidateCollector` asks bundled ExifTool for metadata without modifying the file. `DateResolver` scores candidates by media kind, semantic meaning, source, timezone basis, precision, consistency, and warnings. It keeps the raw value, parsed local value, UTC instant when available, offset, subseconds, source tag, and rejected candidates.

Every target sits under a top-level media-type folder (`Photos`, `Videos`, `Audio`, `Documents`, `Art`). Only a resolved high- or medium-confidence result enters a dated folder beneath it. Ambiguous, low-confidence, or unresolved files target `_Needs Review`.

## Preview and execution

Preview inventories no-follow regular files, binds canonical disjoint roots, gathers metadata, resolves dates, and reserves proposed targets in memory. It performs no media mutation.

Start accepts a preview ID, not a new path list. Revalidation proves the source identity and destination assumptions still match the preview. Any drift rejects the affected operation.

## Transaction boundary

The TypeScript core owns business state and the append-only journal. Namespace mutation crosses the Rust helper through root capabilities and validated path components. The helper stages data, syncs files, reserves targets without replacement, publishes atomically, and returns native identity evidence.

Copy leaves the source intact. Move adds a durable source-delete intent and receipt before asking the helper to quarantine and delete the exact validated source identity. Uncertain post-crash state remains pending for reconciliation. It is never guessed into success.

## Packaged tools

Tool staging produces a schema-3 manifest with exact ExifTool, Perl, filesystem-helper, and launch-broker records. Runtime health verifies the tree before any tool launches. The broker then verifies and executes an immutable helper snapshot.

Production launch also requires an authenticated, non-user-writable install root. Linux supports protected system installs. macOS and Windows require injected platform attestors supplied by signed native packages.

## Persistence

- Configuration: schema-3 JSON, written atomically with strict keys
- Job history: append-only JSONL with lock and torn-tail recovery
- Evidence: immutable JSONL records with policy version and digest
- Transactions: append-only journal plus conservation objects and delete receipts

Media bytes and embedded metadata are never rewritten.
