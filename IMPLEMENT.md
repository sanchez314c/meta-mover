# META Mover Refit Implementation Contract

Date: 2026-08-29
Branch: `forge-refit`
Source baseline: `d6fdd9d6cf0600e41aafd9bc59b7ae950e4f096f`

## User directive

Repair the audited data-loss, metadata-truth, integration, dependency, and release-gate failures. Replace host-dependent Python execution with a self-contained application environment that runs from platform-specific packages without installing system tools.

## Completion contract

The refit is complete only when every assertion below has executable evidence.

1. One canonical TypeScript processing core is reachable from renderer to preload, IPC, service, transaction engine, history, and terminal events. The Python bridge and runtime package installation are absent from the shipped path.
2. Each platform package resolves ExifTool and its required Perl runtime from application resources produced on the same OS and architecture. No processing path invokes system Python, `pip`, Homebrew, APT, or an unqualified host executable.
3. Preview performs no media or filesystem mutation and reports the selected date, complete candidate provenance, confidence, ambiguity, proposed destination, and conflict action.
4. Copy is the default. Move is explicit. A move deletes its source only after a staged copy has been byte-counted, SHA-256 verified, atomically committed to a uniquely reserved destination, journaled, and directory-synced where the platform supports it.
5. Same-name parallel files cannot overwrite each other. A conservation test with at least 1,000 identical-timestamp inputs must finish with exactly 1,000 distinct outputs, 1,000 verified hashes, and zero missing sources on injected failure.
6. Processing never writes inferred dates or other metadata back into source or destination media. Evidence remains immutable; decisions and provenance live in a sidecar run manifest and job history.
7. Date resolution is media-aware. It preserves offsets and subseconds, never rewrites four-digit centuries, distinguishes capture/encode/filesystem/filename evidence, and labels uncertain or conflicting cases instead of claiming ground truth.
8. Filesystem roots are canonicalized and disjoint. Symlinks are not followed. Destination-inside-source, source-inside-destination, same-directory, hardlink alias, device-boundary surprises, and path escapes are rejected or handled by an explicit tested policy.
9. All processing settings displayed in the UI reach the core or are removed. Preview, copy/move, conflict policy, cancellation, history, dependency health, and terminal states remain truthful across navigation and restart.
10. Cancellation stops admission of new work, lets the current atomic file transaction settle, records a terminal cancelled state once, and leaves no untracked staging files.
11. Every attempted input ends in exactly one terminal classification: committed, skipped duplicate, rejected unsupported, review required, failed without source loss, or cancelled before admission. Aggregate counters are derived from these records.
12. CI performs registry-only clean installation, lint, formatting, strict typecheck, tests with enforced coverage, production build, and per-platform package smoke tests. No script swallows a failed gate or prints success after failure.
13. The original shared Miniconda environment is restored only from forensic evidence of the pre-audit state. Ambiguous packages remain untouched and are reported, never guessed away.

## Scope decisions

- Preserve the Electron/React shell where it remains useful.
- Rebuild the active processing core; do not repair both the Python and dormant TypeScript engines.
- Use platform-specific installers. A platform package includes every non-OS runtime dependency it needs.
- Treat archives as containers, not media. Archive extraction is out of scope and must not be implied by the UI or documentation.
- Default to non-destructive copy. Move remains available only through the transactional protocol.
- Treat filesystem times as low-confidence fallback evidence, never capture-time ground truth.

## Execution phases

1. Capture baseline and rollback artifacts.
2. Add characterization tests for valid behavior and red regression tests for every audited corruption.
3. Establish registry-only Node 22 dependency and package-resource contract.
4. Build provenance-aware metadata extraction and date resolution.
5. Build journaled transactional file operations and recovery.
6. Wire renderer, preload, IPC, settings, cancellation, history, and dependency health.
7. Remove the Python runtime path and restore the shared environment safely.
8. Repair CI, release packaging, documentation, and validation scripts.
9. Run adversarial review, full validation, packaged-app smoke tests, and conservation proof.
10. Materialize the verified refit into the published checkout only after all gates pass.

## Known-broken baseline behavior not to characterize as correct

- Parallel check-then-move collision behavior.
- Century rewriting and timezone stripping.
- First-match `-time:all` fallback.
- Runtime `pip install` or host executable discovery.
- Metadata mutation after organization.
- Inert settings, false cancellation success, listener loss, and missing history records.
- Test/build scripts that ignore exit status.

## 2026-08-29 dependency bootstrap and validation hardening

- Raised the declared runtime floor to Node 22.12.0 and npm 10.9.0 because `@electron/rebuild` 4.2.0 requires Node 22.12 or newer.
- Replaced `@electron/rebuild` 3.7.2, whose lock graph fetched `@electron/node-gyp` over Git, with exact 4.2.0 from the npm registry.
- Added exact `exiftool-vendored` 37.2.0 and exact `@ffmpeg-installer/ffmpeg` 1.1.0. Kept the imported `ffprobe-static` package and pinned it to 3.1.0 because its registry tarball contains an executable ffprobe under the active no-lifecycle-script install policy.
- Rejected `ffmpeg-ffprobe-static` because its npm tarball downloads binaries in a lifecycle script, and rejected `@ffprobe-installer/ffprobe` because its Linux registry binary is not executable under that same policy.
- Made `config/jest.config.js` authoritative, excluded archived rollback files from Jest discovery, and enforced 80 percent global coverage plus higher core thresholds.
- Replaced permissive CI and release flows with Node 22.12 registry-provenance checks, clean install, formatting, lint, typecheck, characterization, coverage, build, and tag-version gates. Release packaging remains blocked until platform smoke tests prove the produced installers offline.

## 2026-08-29 packaged runtime containment

- Replaced packaged `scripts/` output with an explicit `.build-tools/tools` application resource containing package-managed ExifTool, FFmpeg, and FFprobe payloads.
- Added an Electron builder hook that stages the current platform and architecture before packaging. It copies the media tools from installed npm packages and, on Linux or macOS, captures the absolute build-host Perl interpreter required by ExifTool. It performs no network or system installation.
- Added package-integrity tests and a hard gate for ASAR configuration, Python removal, resource path containment, exact platform tool inventory, version capture, SHA-256 verification, regular-file checks, and executable mode.
- Added unpacked-package validation before native installer creation in the release workflow.
- Added direct ASAR inspection through pinned `@electron/asar` 4.3.0. The gate rejects Python payloads and declared native modules without their required ABI binary.
- Moved Electron and `dmg-builder` to development dependencies as required by Electron builder. A real Linux unpacked build then exposed the missing `sqlite3` native ABI payload; the gate stays red until the separately owned JSONL migration removes that dependency and all imports/externals.
- Kept the source gate red while runtime programs still reference Python, unqualified host executables, or dependency-local executable paths. Core integration is tracked separately and this packaging task does not weaken that failure.

## 2026-08-30 transactional filesystem correction pass

- Reproduced eight independent filesystem-correctness failures before correction: nested recovery escape, journal-prefix loss during torn-tail repair, lock replacement/publication races, non-Linux reservation recovery failure, partial-move false success, retained-source identity confusion, nonterminal wrong-hash recovery, and unsynced cleanup namespaces.
- Recovery now opens and holds the exact destination parent before the mutation boundary. Linux mutations use that parent descriptor; other platforms use the prevalidated canonical parent and fail closed on detected drift. Valid interrupted reservations remain recoverable on macOS and Windows paths.
- Torn-tail repair truncates directly to the valid UTF-8 byte boundary. It never truncates to zero and rewrites the prefix.
- Core and journal locks publish through fully written same-directory candidates, compare owner token plus PID and inode identity, quarantine before deletion, restore crash-left quarantine state, and repair publication aliases.
- Recovery classifies source retention only when the recorded device, inode, link count, size, mtime, and ctime still match. Wrong-hash occupied destinations receive a durable failed terminal record.
- Cleanup unlinks are followed by parent-directory synchronization before completion is journaled.
- Executor semantics no longer count committed-but-incomplete moves as successful. A retained move source or failed/cancelled move terminal maps to a failed ledger entry.
- The conservation protocol now proves 1,000 same-name concurrent inputs with default durability, one injected post-commit failure, 1,000 unique destinations, 1,000 independently checked hashes, and all 1,000 sources retained.
- Durable journal sequence allocation derives its floor from `max(journal, stored)` at startup, then advances under the cross-process lock from the atomically stored sequence. This removes quadratic journal rescanning without weakening crash recovery.
- Applied exact non-major security corrections for `electron-updater`, `lodash`, `handlebars`, `shell-quote`, and `websocket-driver`. Major Electron, builder, native module, and UI changes remain deferred behind dedicated compatibility validation.

### Independent-review follow-up corrections

- Preserved the exact valid JSONL byte prefix, including accepted blank lines, when a torn final record is quarantined and truncation is interrupted.
- Made journal and core lock publishers tolerate a contender removing their published candidate alias only after re-reading the final lock and proving the same PID and ownership token. Deterministic barriers exercise both interpositions.
- Defined `sourceRetained` as retention of the captured source identity, not mere pathname occupancy. Replacement files remain untouched but are never counted as conservation of the original source.
- Cached the last validated journal size. An unchanged durable writer no longer full-reads the journal before every append; any locked size drift still triggers torn-tail validation before writing.
- Replaced the five-directory `Promise.all` acquisition in core startup with individually captured opens. A later identity failure now closes every earlier handle instead of leaving descriptors for garbage collection.
- Revalidated the combined core and journal grid with trace warnings enabled: 105 of 105 tests passed, including the 1,000-input durable conservation protocol, with no FileHandle warnings.

### Final-review lifecycle corrections and native boundary

- Added release-quarantine barriers for journal and core locks. A contender now recognizes the live reclaimer PID encoded in `.reclaim.*`, waits or rejects instead of restoring an in-progress release, and can only restore crash residue after that reclaimer is dead.
- Rejected multiply linked source inputs before publication or guard creation. A hardlink alias can no longer mutate its own captured link count and then falsely report the source missing.
- Made recovery terminal semantics mode-aware: a verified committed copy completes with its source retained, while a retained move remains cancelled/partial. Finalized failed recovery records are stable across later startups instead of appending another failure each time.
- Made journal and core close failure-complete. Every owned handle and the core lock receive a close/release attempt, and all failures are combined after cleanup.
- Added deterministic RED protocols for two guarantees that pure Node cannot implement safely: conditional source deletion bound to the inode last validated, and nested recovery mutation relative to a held directory on non-Linux platforms. Both failures remain visible and Move remains gated.

#### Required native filesystem helper contract

The cross-platform package needs one minimal native boundary before Move or portable nested recovery can ship:

1. Open a directory handle without following a symbolic link and return stable platform identity. Linux/macOS require device and inode; Windows requires volume and stable file ID plus reparse-point evidence.
2. Open and stat a child relative to that handle with no-follow semantics. Destination creation must return a held child handle so recovery writes, hashes, and file-syncs through the opened object before parent-directory sync.
3. Atomically quarantine the source child relative to its held parent, using a no-replace name. A pathname re-check followed by unlink is not sufficient.
4. After quarantine, verify stable file identity, link count, size, modification/change timestamps, and SHA-256 through a held no-follow handle. Delete only after every field matches the captured source evidence.
5. On any mismatch, restore the quarantined entry with no-replace semantics. If the original name is occupied, preserve the quarantined file as explicit reported residue; never overwrite either entry.
6. Create, rename, link, and unlink children relative to held directories, with exclusive/no-replace publication and identity-bearing results.
7. Synchronize every written file and its parent directory and report unsupported durability without claiming success.
8. Expose equivalent behavior on Linux, macOS, and Windows without depending on `/proc/self/fd` or assuming POSIX inode semantics on Windows.

Node's `fs` API exposes held `FileHandle` objects but no `openat`/`renameat`/`unlinkat` family or conditional inode-bound unlink. Revalidation can detect a completed swap; it cannot close the interval between validation and mutation. The RED protocols therefore remain architecture gates, not tests to skip or weaken.

## 2026-08-30 corruption and FFmpeg compatibility retirement

- Removed the inert corruption toggle from persisted configuration, settings, capability reporting, dependency health, and processing-phase exposure. Configuration schema 3 atomically rewrites schema 2 stores without carrying the retired value, while schema 3 rejects the retired field instead of silently stripping it.
- Deleted `corruptionDetection` from `ProcessingOptionsDTO` and every live renderer, preload, IPC, coordinator, evidence, history-write, and runtime-composition path. Any live options object containing that unknown key now fails closed regardless of whether its value is `false`, `true`, or explicit `undefined`.
- Kept compatibility only at two explicit persisted-data boundaries. `AppConfigStore` may consume schema 2 and atomically rewrite schema 3 without the retired value. `JobHistoryStore` may decode schema 1 creation and queued-event options by dropping a boolean legacy value and emitting a migration warning; all current history writes remain exact-key validated and reject the field.
- Proved the field is absent from new preview requests, preview results, queued events, evidence manifests, history snapshots, runtime defaults, and renderer bridge calls. Fourteen focused suites pass 165 tests with current-field rejection and both persisted migration protocols.
- Removed `@ffmpeg-installer/ffmpeg` and `ffprobe-static` from the package manifest and lockfile. Staging and runtime health now require exactly ExifTool plus bundled Perl on non-Windows platforms.
- Replaced the staged-tools manifest with schema 2 native-runtime evidence: OS, architecture, binary format, loader, and shared-library names. Staging rejects cross-OS and cross-architecture targets; unsupported runtime inspection fails the artifact instead of claiming portability.
- Deleted the cross-host `dist:all` entry. Existing platform-named package commands are native-only because the `beforePack` hook rejects a target that differs from the build host.
- Validated the actual Linux x64 stage: ExifTool and Perl only, 4,768 files, 89 MiB, ELF x86-64 Perl, loader `/lib64/ld-linux-x86-64.so.2`, and shared libraries `libm.so.6`, `libc.so.6`, and `libcrypt.so.1`.
- Unified staging and runtime directory hashing on a locale-independent codepoint order after an adversarial real-stage check exposed different `localeCompare` and runtime digest orders. A mixed-case filename regression now crosses both implementations.
- Bound the required `exiftool/lib` module tree into schema 2 with its relative path, file count, and content digest. Package and runtime verification now reject module tampering, symlinked launchers, hard-linked files, and file identity drift during package verification.
- The general source-integrity gate remains red on separately owned legacy Python, SQLite, host-tool, and FFprobe programs. This task does not weaken that gate or edit those excluded programs.

## 2026-08-29 main-process composition lifecycle

- Added `ApplicationRuntime` as the tested lifecycle owner for the intended config, history, evidence, bundled-runtime health, metadata, preview, revalidation, transaction, coordinator, and IPC graph. It remains inactive until the Electron entry point instantiates it in the integration lane.
- Kept Electron paths and concrete constructor choices behind injected factories. The lifecycle program now fixes construction order without hiding workstation paths or host dependencies in product code.
- Composed coordinator persistence hooks inside the runtime so durable history and evidence both receive the records they support. Both sinks settle before control returns, and labeled aggregate errors retain every sink failure.
- Registered each acquired owner for rollback immediately. Startup failure and normal shutdown both stop IPC admission, drain the coordinator, close transaction cores, finalize evidence, stop metadata, close history, and close config. Cleanup continues after individual failures and reports every failed step.
- Added nine focused tests for dependency order, concrete history and evidence fanout, delayed and multiple sink failures, partial-start rollback, multiple cleanup failures, IPC registration rollback, and concurrent shutdown calls.
- Kept legacy retirement and `src/main/index.ts` wiring out of this bounded change. No production entry point claims the new runtime yet.

## 2026-08-29 JobHistoryStore concurrent initialization correction

- Preserved the intermittent two-owner initialization regression and added a deterministic interposition test at the gap between reclaimer `lstat` and `open`.
- Reproduced the raw `ENOENT`: one store observed the reclaimer pathname while its owner quarantined and unlinked that pathname before the contender opened it.
- Changed `inspectLock` to treat only that `open`-time `ENOENT` as a vanished observation. The contender returns to the serialized acquisition loop, then rejects the live primary owner with `STORE_LOCKED`.
- Kept inode, token, no-follow, quarantine, and stale-lock ownership checks unchanged. Other open failures still propagate.
- Validation requires the focused deterministic regression, at least 20 repeated two-owner runs, the related history/coordinator suites, branch coverage of at least 80 percent, typecheck, lint, formatting, and independent review.

## 2026-08-30 native filesystem-helper TypeScript client

- Implemented the application-side client for the frozen `native/fs-helper/PROTOCOL.md` contract as a new, independently testable main-process program. Entry-point wiring and `TransactionalFileCore` absorption remain outside this bounded change.
- Resolved the packaged helper only from the application resources root. The client verifies manifest schema, platform, architecture, exact helper entry fields, target, protocol/build versions, regular-file identity, containment, SHA-256, and executable mode before launch.
- Launched `meta-mover-fs-helper[.exe] --stdio` with `shell: false` and private piped standard streams. Startup requires a matching `hello`, then exactly one `bind_roots`; every later mutation carries only root capability names and path components.
- Bound verified Linux execution to the held helper object by inheriting the verified descriptor as child fd 3 and executing `/proc/self/fd/3`. macOS and Windows fail closed unless runtime health injects an explicit deny-write-delete or authenticated-package launch lease; a bare verified pathname is not accepted as proof.
- Implemented strict 65,536-byte UTF-8 NDJSON framing, duplicate-key rejection, unknown-key rejection, nesting and array limits, lowercase canonical UUID v4 correlation, native-platform identity enforcement, signed nanosecond timestamp support, operation-specific result validation, and one in-flight request.
- Defined uncertainty semantics at the process boundary. EOF, crash, child-process error, write failure, malformed output, active abort, and abnormal close all terminate the helper and reject active work as non-retryable `UNKNOWN`. A queued abort remains provably `not-applied`.
- Added failure-complete, idempotent drain/close behavior. Close rejects late admission, drains prior requests, sends one close request, closes stdin, and requires a zero exit within a bounded deadline; failure escalates only the exact owned helper from TERM to KILL. Repeated close calls share the same Promise.
- Added 58 focused tests covering every operation DTO, package tampering, launch leases and cleanup failures, immediate post-spawn errors, a real owned-child stream/error/termination path, lifecycle proofs, framing attacks, malformed results, abort timing, process failure, serialized admission, ambient-path exclusion, and close ordering. Focused coverage is 89.77 percent statements, 82.53 percent branches, 87.39 percent functions, and 92.34 percent lines.

### Durable source-deletion reconciliation extension

- Extended the client to the receipt-backed deletion contract frozen at `native/fs-helper/PROTOCOL.md` SHA-256 `22013d5c0f5c088ac9c20c72d35545666d4f8ddf53de043966b84ea9dcc60490`.
- Split the caller's durable `deleteId` from the internal transport UUID. Both identifiers must be lowercase canonical UUID v4 values, and the client refuses to transmit a request when they collide.
- Required `delete_source_exact` and `reconcile_source_delete` to carry a capability-relative receipt path whose bound root kind is `control`. Absolute paths never enter either post-bind DTO.
- Added typed delete and reconciliation results for source retained, source deleted, preserved replacement, quarantine cleanup, and durable receipt states. Result parsing enforces the exact state and durability combinations produced by the frozen protocol.
- Added typed `reconciliation-required` details with exact source, quarantine, entry, and receipt capability paths. Mismatched IDs, path shapes, states, keys, or ambient path substitutions become fatal protocol `UNKNOWN` failures.
- Expanded the focused native-client suite from 58 to 76 tests. New cases cover delete ID validation and collision, receipt-root confinement, request serialization, both terminal reconciliation branches, every valid deleted durability pattern, malformed state combinations, capability-relative residue reporting, and the standard `reconciliation-required` handoff from delete to reconcile.

## 2026-08-30 bundled filesystem-helper readiness gate

- Extended schema 2 runtime health from ExifTool-only readiness to two required processing dependencies: ExifTool and the native filesystem helper. Non-Windows manifests must contain exactly `exiftool`, `fs-helper`, and `perl`; Windows manifests must contain exactly `exiftool` and `fs-helper`.
- Bound the helper manifest entry to the current OS and architecture, canonical staged path, SHA-256, protocol 1, and equal manifest/build versions. Existing regular-file, no-symlink, single-link, containment, and executable checks now cover the helper.
- Added a bounded, shell-free `hello` launch from the verified helper path with a minimal environment, 3-second timeout, 65,536-byte stdout/stderr limits, fatal UTF-8 decoding, strict newline-terminated NDJSON parsing, fixed correlation ID, Rust target validation, and exact required feature validation.
- The review correction rejects duplicate keys, unknown manifest/response fields, more than 16 JSON levels, arrays over 256 items, special entries in hashed support trees, and duplicated or reordered helper features. Stream errors enter the same controlled failure path as crashes.
- Failed hello processes stop output capture, receive TERM, escalate to SIGKILL on the exact owned child after 250 ms, and settle on observed close or a final bounded deadline.
- Made preview/start readiness require both ExifTool and helper health. Either failure is visible as its own dependency and blocks both capabilities.
- Replaced the packaging test's inert helper fixture with a real protocol-1 hello fixture so staging integrity and application runtime health exercise the same executable contract.
- Aligned staging and package verification with runtime rejection semantics after exact-tree review: the build probe now applies the same strict framing/schema/feature rules, and package directory hashing rejects FIFOs and other special entries instead of silently omitting them.
- TDD evidence: the initial focused run failed 17 of 31 tests; the runtime review hardening run then failed 11 adversarial probes; the exact-tree review added four failing staging/package probes. Final runtime suite passes 53 of 53 with 90.43% statements, 80% branches, 91.93% functions, and 93.23% lines; combined runtime and package-integrity tests pass 65 of 65.

## 2026-08-30 native filesystem helper implementation

- Froze `native/fs-helper/PROTOCOL.md` before implementation, then added the pinned Rust workspace, `Cargo.lock`, and `meta-mover-fs-helper --stdio` binary. TypeScript remains the only business-journal owner.
- Implemented strict 65,536-byte NDJSON, UUID v4 IDs, lifecycle ordering, duplicate and unknown key rejection, bounded JSON, platform-bound decimal identities, capability paths, and one retained set of no-follow root handles.
- Implemented `ensure_dir_chain`, streaming SHA-256 stage copy, create-new markers, hard-link and rename without replacement, identity-bound managed removal, deterministic same-filesystem quarantine deletion, and close. Every success includes an explicit durability receipt; partial or ambiguous mutations report `unknown`.
- Bound all post-handshake paths to root capabilities and literal components. Absolute ambient access is sealed after `bind_roots`; traversal, separators, Windows devices and ADS names, trailing dot or space, symlinked ancestors, target replacement, and hard-linked packaged helpers fail closed.
- Added Linux directory-descriptor operations with `renameat2(RENAME_NOREPLACE)` and full local runtime coverage. Added cfg-gated macOS `renameatx_np(RENAME_EXCL)` through rustix and Windows retained-handle operations with reparse rejection, no-replace handle rename, delete sharing, writable durability handles, and aligned Win32 buffers. Cross-target compilation and clippy pass from this host; native macOS and Windows runtime behavior remains gated by the configured CI matrix and is not claimed locally.
- Closed the Windows quarantined-file handle before unlink, synchronized the still-open quarantine directory, then closed that directory handle before removing and synchronizing its parent. A Windows-only regression requires the deterministic quarantine name to be immediately reusable before a successful response.
- Made deletion quarantine names deterministic from a caller-owned UUID v4 `deleteId`, separate from the transport request ID. Existing residue is `reconciliation-required` and `unknown`; identity mismatch never deletes either object. Failed quarantine rename cleanup is identity-checked and parent-synced.
- Added a caller-selected control-capability receipt to `delete_source_exact` and the new `reconcile_source_delete` operation. After the quarantined file is reverified through its held handle, the helper exclusively creates and syncs an immutable receipt before unlink. An exact receipt plus absent quarantine is durable evidence that reconciliation can classify deletion as applied without guessing from pathname absence.
- Reconciliation handles every crash boundary around quarantine rename, receipt creation, entry unlink, and quarantine cleanup. Exact source with no receipt remains retained; exact quarantine can create the missing receipt and finish deletion; an exact receipt can finish or confirm deletion while preserving any replacement at the source path. Mismatched receipts, special entries, unexpected quarantine contents, and ambiguous absent state preserve every object and return relative residue metadata only.
- Adversarial final review found that differently named `source` and `control` capabilities could bind the same native directory and let a receipt target alias the just-vacated source path. Both delete operations now open both final entries through held parents and compare native object IDs before mutation. This covers hard links plus case-insensitive, normalized, and Windows short-name aliases. Delete-time quarantine and receipt collisions now use the no-details `precondition` error shape required by the strict client.
- Pinned Rust 1.85.1 plus exact crate versions. Linux release builds use static PIE and package verification rejects a dynamic interpreter. The staged helper is single-link, executable, SHA-256-bound, target-bound, protocol/build-bound, and hello-probed before packaging.
- Added a Linux, macOS, and Windows native-helper CI matrix and a Windows PE architecture inspector. The package manifest contains the exact `fs-helper/<platform>-<arch>/meta-mover-fs-helper[.exe]` entry expected by the client and runtime health gate.
- RED to GREEN evidence covers strict framing, EOF truncation, lifecycle, hostile components, symlink traversal, retained-root replacement, no-clobber copy/link/rename/remove, exact quarantine deletion, deterministic residue, malformed identities, partial-directory outcomes, hash and identity faults, cleanup ownership, durable receipt collisions, namespace aliases, and injected reconciliation states. The receipt extension began with 14 failing checks out of 23; the final pinned Linux runtime gate passes all 25, with formatting and clippy warnings denied. Windows MSVC and macOS x86-64 all-target check and clippy gates pass from this host.
- Residual contract: Unix offers no atomic compare-identity-and-rename syscall. The helper detects a source-name swap after mutation, returns `unknown`, preserves residue, and never deletes on mismatch. Package manifest hashes are integrity evidence, not an authenticity root; signed distribution and a deny-write-delete install boundary remain required.

## 2026-08-30 transaction absorption into the native boundary

- Added `NativeTransactionFilesystem` as the single capability mapper between canonical transaction paths and the approved native-helper client. Media staging, nested-directory creation, reservation publication, no-replace final publication, managed cleanup, source deletion, and delete reconciliation now cross that boundary as root names plus validated components. There is no raw-path media-mutation fallback.
- Bound every transaction Core to one destination root, its `.meta-mover` control root, and the exact canonical source-root set admitted by the preview payload. `TransactionalOperationExecutor` serializes Core creation per destination, rejects a changed source-root set, drains admitted work, and closes each owned Core/helper once.
- Persisted helper-originated source, staging, reservation, and conservation identities in the journal. Recovery validates canonical containment before asking the helper to mutate a recorded object.
- Added durable `source-delete-pending` intent containing the caller-generated UUID v4 `sourceDeleteId`, control-capability receipt path, source identity, and expected hash before transmitting deletion. `source-deleted` is appended only after an applied delete receipt or receipt-backed reconciliation proves deletion.
- Kept transport `unknown` nonterminal. Startup reconciliation classifies an exact retained source as committed/source-retained, or an exact receipt plus reconciled deletion as source-deleted. Ambiguous state remains pending for a later recovery pass; it is never converted to success from pathname absence.
- Preserved an immutable content-addressed conservation object for each committed hash. Cleanup is identity-bound, destination publication is exclusive/no-replace, duplicates are hash-verified, and injected post-commit failures retain a source or another named verified copy.
- Converted the prior architecture RED gates to helper-backed GREEN protocols: exact source replacement interposition cannot delete the replacement, and nested recovery mutation remains capability-relative rather than relying on `/proc` or an ambient pathname.
- Independent review corrections made cleanup fail closed on exact identity mismatch. A link-count refresh is allowed only when the helper proves the same device/inode or volume/file ID, the same size and modification time, exactly one removed link, and the durable expected hash. A replacement is retained as explicit residue.
- Source-delete recovery now requires the complete source path, native identity, lowercase SHA-256, canonical UUID v4 delete ID, and exactly matching receipt filename before reconciliation. An incomplete or mismatched committed intent stays `source-delete-pending`; it cannot fall through to pathname-based completion or lose the prior committed fact.
- Normalized native-helper `target-exists` with Node `EEXIST` for reservation, final publication, conservation publication, and protected-destination restoration. Deterministic helper-error tests prove collision suffix allocation rather than false failure.
- Validation evidence: the complete Core protocol passes 92 of 92 with trace warnings enabled. The 1,000-copy run commits 999 normal copies plus one committed/source-retained injected post-commit outcome in 73.736 seconds. The 1,000-move run commits 999 moves plus one committed/source-retained injected post-commit outcome in 106.658 seconds. Both independently verify 1,000 unique destinations and all expected hashes.
- Post-review validation passes 94 of 94 in-process Core protocols with trace warnings clean. The current-hash 1,000-copy and 1,000-move conservation reruns pass in 74.297 and 106.785 seconds respectively. The real-helper crash-child and executor/full coverage remain deferred until the separately owned broker/client manifest absorption is frozen.
- Linux x64 runtime execution uses the staged static helper SHA-256 `6a177f08d8552d33f5aede3e4e8e34dfc09738860fa6c86cfafee06f7c3fa207` under protocol SHA-256 `22013d5c0f5c088ac9c20c72d35545666d4f8ddf53de043966b84ea9dcc60490`. Native macOS and Windows runtime behavior remains a CI/package gate and is not claimed from this Linux host.
- Final lifecycle review reproduced two defects: concurrent Core shutdown returned before owned cleanup, and source-retained delete outcomes terminalized while leaving full staging guards. Both began with deterministic failing tests.
- `TransactionalFileCore.close()` now caches its complete close operation. Concurrent callers wait for the journal, five directory handles, native helper, and writer-lock release, with every resource still attempted on failure.
- Source-retained cancellation and reconciliation remove staging and reservation entries by recorded native identity before terminalization. Cleanup failure records residue under a nonterminal committed state, and a later startup retries exact cleanup.
- The same retry rule covers duplicate-move cancellation. A failed `.duplicate-guard` removal leaves the prior committed record nonterminal until startup exact cleanup succeeds.
- Duplicate protection now publishes its guard path and native identity back to the outer transaction scope. Cancellation after durable delete intent therefore cleans that exact guard, or leaves the durable intent nonterminal when cleanup fails.
- Cleanup remains conservative. A live failure path removes a protected guard only after a durable delete intent exists and the committed destination still hashes to the expected content. Missing or changed destinations retain the guard for restoration.
- Current validation passes 108 of 108 non-stress Core tests with `--detectOpenHandles`, 194 of 194 configured transaction coverage tests, and both 1,000-file copy and move conservation tests. The configured gate exits zero at 92.30 percent statements, 87.54 percent branches, 93.75 percent functions, and 93.91 percent lines.

## 2026-08-30 standalone native launch broker

- Added the pinned Rust `native/launch-broker` workspace and froze its standalone contract before implementation. This bounded broker change does not edit `NativeFilesystemHelperClient`, `BundledRuntimeHealth`, `TransactionalFileCore`, or the Electron entry point; separately owned composition changes may absorb the frozen contract in the shared tree.
- The broker accepts only `--identity` and `--stdio`. It resolves the helper solely from the exact sibling resources layout and compiles the expected helper SHA-256, protocol, build, package target, and optional signer policy into the release binary.
- Linux opens every path component without following links, validates the held helper descriptor, copies the verified bytes into an anonymous sealed `memfd`, re-hashes that immutable snapshot, normalizes it to descriptor 3, closes ambient descriptors above it, and replaces itself through `/proc/self/fd/3`. The real staged static PIE broker relayed the helper protocol on this Linux x64 host with no pathname fallback. Regressions prove in-place snapshot writes fail and inherited descriptor 9 is closed before exec.
- macOS copies verified bytes to a unique private file, syncs and re-hashes it, reopens the same verified inode read-only with no-follow semantics, unlinks it, closes the writable descriptor, applies and verifies `UF_IMMUTABLE`, requires zero links, re-hashes, closes ambient descriptors, then executes only the read-only `/dev/fd/3`. Its native test executes `/bin/sh` from that descriptor, covering the `ETXTBSY` boundary rather than checking immutability alone. Windows retains every helper ancestor plus the final file while denying write/delete sharing, rejects reparse points, binds `FileIdInfo`, duplicates only the three standard handles, creates the helper suspended with a handle allowlist, assigns a kill-on-close job, rechecks identity, then resumes and waits.
- Signing is conditional and injectable. No configured signer records `null`; a configured policy without an injected verifier fails closed. No certificate, key, signer identity, or credential was invented.
- Advanced staged-tools manifest format to schema 3 with an exact `launch-broker` record bound to the broker digest, Rust/package targets, broker build, helper digest/protocol/build, and signer policy. Strict parsing rejects duplicate/unknown keys, identity drift, binary tampering, and a relay result that differs from the direct helper probe.
- Kept transactional package staging compatible with the broker's literal layout check by building the candidate beneath a private `tools` directory, validating the real relay there, then promoting only that validated directory to `.build-tools/tools`.
- Added native Linux, macOS, and Windows broker CI gates for formatting, denied-warning clippy, locked tests, release build, and actual staged relay. macOS additionally proves the unlinked snapshot rejects writes. Windows proves ambient inheritable-handle exclusion, exact pre-resume cleanup, and kill-on-close termination of a descendant tree. Those native results remain CI evidence only and are not claimed from this Linux host.
- Added build/package regression tests for strict identity JSON, signer conditionality, literal `tools` resource layout, symlink rejection, helper and broker tampering, manifest drift, duplicate keys, unknown keys at every schema-3 object level, and stdout-transparent hello relay. Linux, Windows MSVC, and macOS cross-target all-target clippy pass locally.

## 2026-08-30 schema-3 broker absorption into application runtime

- Advanced `NativeFilesystemHelperClient` from schema 2 direct-helper launch to the exact schema 3 inventory. The client now rejects missing, duplicate, or unknown tools and keys; verifies the direct helper digest; verifies the broker digest through a retained file handle; and enforces broker-to-helper hash, protocol, build, package-target, Rust-target, and release-signer binding.
- Made `meta-mover-launch-broker[.exe]` the only executable launched by application TypeScript. The client probes strict `--identity`, validates every compiled identity field against the package manifest, then starts `--stdio`; it never executes the helper pathname.
- Made broker launch trust explicit and shared by the client and runtime-health probe. Packaged mode rejects missing, development, or wrong-platform policies. The built-in Linux production policy accepts only a non-root process launching through the verified held fd from a root-owned, non-group/non-other-writable chain beneath `/opt` or `/usr/lib`, or from a matching read-only Type-2 AppImage mount whose outer image and ancestors pass the same administrative protection checks. Writable portable, extracted, mismatched-mount, symlinked, elevated, and development trees fail closed. macOS and Windows require a composition-supplied platform-bound production signer/ACL attestor; this lane does not fabricate one. Development requires an explicit untrusted policy and is rejected when packaged. Every launch uses `shell: false`, private pipes, the tools root as working directory, and an empty `PATH` with no ambient helper input.
- Added a bounded startup handshake. Broker identity and helper `hello`/`bind_roots` must complete within the configured limit. Identity capture rejects before allocating past 65,536 bytes, consumes the deadline once, escalates TERM to KILL after a fixed grace, and does not report completion until the owned broker lifecycle closes. Identity rejection is observed immediately while asynchronous launch-lease cleanup completes. The process port uses Node's `close` event so a failed spawn, which emits `error` and `close` without `exit`, cannot hang startup.
- Replaced `BundledRuntimeHealth`'s duplicate hash-then-path helper launch with the client launch boundary. Runtime health now validates ExifTool support plus the same schema 3 helper/broker manifest, strict broker identity, relayed helper hello, bound root proof, and clean close used by processing.
- Closed the real packaged metadata-adapter composition gap. `BundledExifToolAdapter.createPackaged` now forwards the same trust policy and package-mode declaration into runtime health, selects the built-in immutable-root policy only for packaged Linux, requires an injected native attestor for packaged macOS and Windows, and can select the untrusted development policy only after an explicit non-packaged declaration.
- Closed the pre-attestation execution path found in independent review. Runtime health now completes the broker/helper trust probe before any Perl or ExifTool version process can start. The Linux system-root policy recursively proves every file and directory beneath the packaged tools root is root-owned, non-group/non-other-writable, non-symbolic, and regular before it caches that immutable tree. A malicious writable-root Perl canary proves rejection creates no side effect.
- Added schema downgrade, broker/helper tamper, helper-hash unbinding, target/build/protocol/signer drift, unknown inventory, explicit packaged/development trust separation, Linux root-chain and AppImage mount attacks, writable portable rejection, empty-PATH relay, Windows injected lease, stream failure, real spawn failure, framing, timeout, allocation bounds, delayed lease cleanup, successful attestation sharing, failed-attestation eviction, and observed TERM-to-KILL close regressions. The three TypeScript suites pass 171 of 171; combined coverage is 90.42 percent statements, 83.38 percent branches, 93.83 percent functions, and 93.03 percent lines. Package integrity brings the reachable scoped graph to 183 of 183.

## 2026-08-30 canonical Electron main-process composition

- Replaced the legacy `ConfigManager`, SQLite, Python bridge, updater, and duplicate IPC entry graph with one tested composition rooted at `ElectronMain`, `ProductionApplicationRuntime`, and `ApplicationRuntime`. Legacy programs remain on disk for the coordinated retirement phase, but the production main bundle no longer reaches them.
- Composed the concrete config, JSONL history, immutable evidence, schema-3 bundled runtime health, packaged ExifTool metadata collection, preview planning, preview revalidation, native transaction executor, coordinator, and processing IPC owners. One broker launch-trust policy instance is shared across runtime health, metadata, and native filesystem operations.
- Added `CoreIPCController` as the only owner of preload-exposed dialog, system, window, path, and external-link channels. It validates plain inputs, limits system paths, permits only credential-free HTTP, HTTPS, and mail links, rolls back partial registration, and completes cleanup after multiple failures.
- Added the testable Electron lifecycle owner. Renderer windows run with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and insecure content disabled. IPC registers before renderer load; navigation and window creation are denied by default; updater and sandbox-bypass entry code are absent.
- Made shutdown failure-complete and race-safe. A quit request during deferred runtime creation waits for owner acquisition, drains the late owner exactly once, blocks activation, creates no post-quit window, and still completes application exit after logged cleanup failures.
- Tightened processing contract boundaries. Private destination snapshots can no longer leak into public preview rows, low-confidence filesystem dates remain correctly counted as review-required evidence, and the retired corruption toggle accepts only absent, `undefined`, or `false`, normalizing to `false` while rejecting `true`.
- Added an actual staged integration protocol that invokes `processing:preview`, then `processing:start`, through the canonical IPC surface and verifies the native helper copied the exact bytes while retaining the source.
- Validation passes 108 focused composition, service, evidence, runtime-smoke, and transaction tests. Runtime composition coverage is 92.18 percent statements, 80.95 percent branches, 93.27 percent functions, and 95.52 percent lines. Typecheck, scoped lint, scoped formatting, and the main-process development build pass. The build retains one `exiftool-vendored` dynamic-require warning.
- Release containment is not yet green. The real package integrity gate still rejects legacy `sqlite3`; `electron-updater` is also obsolete. AppImage remains advertised although the default packaged Linux policy accepts protected `/opt` or `/usr/lib` installs, and two legacy Linux launchers still declare sandbox bypasses. Those package, lockfile, and launcher corrections remain explicit gates rather than being hidden by the composition change.

## 2026-08-30 legacy retirement and package correction

- Proved the canonical Electron entry no longer imports the Python bridge, SQLite manager, duplicate IPC/config/window owners, old organizer core, worker, request validator, or bundled-tool resolver. Moved those programs, their obsolete tests, the Python/Conda files, old worker config, unsafe launch/build scripts, notarization hook, and DMG-only background to `/media/heathen-admin/RAID/AI-Pre-Trash/meta-mover-refit/20260830_045242/` with path-preserving recovery metadata.
- Kept `src/main/utils/Logger.ts` and `src/shared/constants/index.ts` because the canonical `src/main/index.ts` still imports Logger and Logger still imports `LOG_CATEGORIES`. They are reachable and therefore outside safe retirement in this pass.
- Removed SQLite, Sharp, Exifr, updater/store/logging/i18n/Lodash/direct Redux dependencies and unused native-rebuild, notarization, Sass, optimizer, analyzer, loader, DMG, and optional packaging dependencies. `exiftool-vendored` is now build-only and packages only its staged executable/module payload, not its Node package.
- Removed the worker build, legacy native externals, postinstall native rebuild, auto-update publishing metadata, AppImage/Snap/archive/portable/user-scoped targets, and missing NSIS/DMG resource references. Linux release output is limited to x64 `deb` and `rpm`; macOS is configured only for signed `/Applications` `pkg`; Windows is configured only for signed per-machine NSIS. Automated release currently emits only the locally verified Linux formats.
- Added executable package policy tests and hardened `assertPackageConfig` so source/package gates reject retired dependencies, inactive bundles, updater metadata, unsigned signable artifacts, and unsupported/user-writable installer formats.
- Replaced the Linux source launcher. It requires an existing locked install, stages the packaged runtime, builds only main/preload/renderer, preserves Chromium sandboxing, invokes no system mutation, kills no process, and performs no implicit dependency installation.
- Closed the independent package-review findings. Linux x64 now stages a locally built static Perl 5.42.0 binary with no ELF interpreter or shared-library dependencies and only the 11 core module files exercised by ExifTool version, JPEG, and PNG probes. The runtime and upstream licenses are stored under `native/perl`; host Perl and host `@INC` are no longer copied.
- Made updater suppression explicit with `publish: null`, rejected update manifests and blockmaps in final artifacts, corrected macOS root-volume pkg semantics, removed generic cross-architecture package commands, and pinned every GitHub Action to a verified commit.
- Added final native artifact inspection. Tagged release CI extracts the exact built `deb` or `rpm`, runs the same ASAR/runtime containment gate against the extracted filesystem, and only then writes its checksum. Local final-artifact validation passed for `meta-mover` 1.0.0 amd64 deb and x86_64 rpm.

## 2026-08-30 transaction configured-coverage closure

- Revalidated transaction execution against the frozen schema-3 broker/client/runtime boundary. The actual staged-helper executor passes three integration protocols and the crash-child recovery protocol passes independently.
- Added deterministic edge protocols for peer-grown journals, single-record torn tails, publication-alias loss, lock quarantine replacement, non-Error close failures, incomplete native mutation receipts, helper loss after durable delete intent, guard restoration, conservation aliases, and static lock-owner probes.
- Consolidated repeated best-effort close and value-probe callbacks into named helpers. This preserves the original failure as authoritative while making every cleanup owner explicit and independently exercised.
- The configured Jest gate now exits zero without changing thresholds: 192 focused transaction tests pass, two non-host platform protocols remain skipped, statements are 92.08 percent, branches 87.22 percent, functions 94.14 percent, and lines 93.69 percent.
- TypeScript compilation, scoped ESLint, and scoped Prettier checks pass. The unfiltered suite remains separately red on the pre-existing Linux launcher policy; transaction programs do not modify that launcher lane.

## 2026-08-30 truthful documentation reset

- Replaced the active user and developer documentation with the canonical preview-first, evidence-ranked, immutable-metadata, JSONL, and native-transaction model.
- Documented copy as the default, move as explicit and receipt-backed, no-clobber conflict handling, preview revalidation, `_Needs Review`, bundled ExifTool and Perl, the Rust filesystem helper, and the Rust launch broker.
- Limited release claims to current Linux x64 `deb` and `rpm` proof. macOS and Windows remain signed native package and attestor gates. AppImage, portable, archive, Snap, user-scoped, and unsigned signable packages are explicitly unsupported.
- Removed active claims for Python, SQLite, FFmpeg, ffprobe, corruption classification, metadata writeback, auto-update, worker bundles, host dependency installation, and sandbox bypasses.
- Moved duplicate and obsolete documentation, pipeline reports, and build metadata to `/media/heathen-admin/RAID/AI-Pre-Trash/meta-mover-refit/20260830_160000-docs-retirement/` with a path-preserving recovery map.

## 2026-08-30 dependency audit closure

- Replaced Electron 38.8.6, electron-builder 24, and styled-components 6.1 with fixed releases Electron 44.0.0, electron-builder 26.15.3, and styled-components 6.5.3.
- Updated the test tooling that owned vulnerable transitives: Jest and its jsdom environment to 30.5.0, ts-jest to 29.4.12, and wait-on to 9.1.0. A targeted lock refresh selected fixed Babel, brace-expansion, fast-uri, flatted, js-yaml, nanoid, picomatch, and PostCSS releases. No security override was needed.
- A clean install exposed two dependencies hidden by the stale shared tree. The crash-child protocol executes `ts-node/register/transpile-only`, and reachable `Logger.ts` imports `winston`. Both are now exact direct development dependencies instead of accidental transitives.
- Migrated electron-builder 26 configuration without changing package scope: Linux desktop metadata now uses `desktop.entry`; Windows signing uses `signExecutable`, `.dll` `signExts`, and `signtoolOptions`.
- Validation from a fresh isolated install passed full and production-only audits at zero, 43 suites and 757 tests, typecheck, build, staged-tool integrity, and extracted deb/rpm containment. Root owns the separately corrected formatting gate.

## 2026-08-30 Electron graceful shutdown correction

- Reproduced the release defect with an Electron 44 window close: the renderer window disappeared while the browser process stayed alive and retained the JSONL history file and ownership lock.
- Proved the cleanup owners were not the stalled component. Under Electron's browser process, IPC, coordinator, transaction, evidence, metadata, history, and config cleanup resolved in 1, 0, 0, 0, 0, 5, and 0 milliseconds respectively. The same idle production runtime closed in 5 milliseconds under Node and 6 milliseconds under Electron's Node mode.
- Moved non-macOS shutdown admission onto the concrete BrowserWindow `closed` event, with `window-all-closed` retained as an idempotent fallback. Both paths enter the existing one-shot barrier, wait for owner cleanup, set the quit allowance, and only then call `app.quit()`.
- Added deterministic failing tests for both lifecycle boundaries before changing production code. Three additional failing protocols proved that throwing telemetry could block shutdown failure, startup failure, and macOS recreation cleanup. Error reporting is now guarded, every failure path enters the same shutdown barrier, and the quit allowance runs in a `finally` continuation. The full ElectronMain suite now passes 17 tests, including delayed cleanup, duplicate lifecycle events, deferred runtime acquisition, shutdown failures, hostile telemetry, startup rollback, macOS recreation, and the concrete window-close regression.
- External X11 window destruction through `xdotool windowclose` removed the native window without delivering Electron's managed close lifecycle in this environment. It is not treated as proof of the in-app frameless Close button path, which invokes `BrowserWindow.close()` through registered IPC. No generic force-exit or cleanup timeout was added.

## 2026-08-30 filesystem-helper output-limit race correction

- Reproduced the scheduling race at the native client boundary: a helper that emitted 65,537 stdout bytes while closing stdin could surface `write EPIPE` before the oversized response was consumed.
- Added a deterministic regression that schedules the oversized output after the rejected write. The original client reported `helper-disconnected`; the corrected client reports non-retryable `helper-protocol` with the exact 65,536-byte response limit.
- Made broken-pipe failures provisional until the owned child closes, which follows stdio drain, or a 250 ms fallback expires. Any already-emitted oversized response therefore establishes the more precise protocol failure. A genuine broken pipe with no output remains bounded and reports transport uncertainty.
- Validation passes both complete client and bundled-runtime health suites under `--detectOpenHandles`: 155 of 155 tests, including the real shell helper and deterministic ordering regression.

## 2026-08-30 preview metadata byte-binding correction

- Reproduced the final-review race where preview hashed an inode-bound source handle and then allowed ExifTool to reopen the mutable source pathname. A deterministic regression renames the inventoried file, installs different bytes at its pathname, reads metadata, and restores the original before preview continues.
- Preview now copies and SHA-256 hashes the inventoried bytes from one held no-follow source handle into a private snapshot. The snapshot file and directory become read-only before extraction and retain held identities through the extraction boundary.
- The adapter opens that snapshot with no-follow semantics before process launch, streams bytes from the held descriptor to one-shot ExifTool stdin, and hashes and counts the same written chunks. Embedded tags are accepted only when this receipt matches the preview digest and byte count. A second adversarial regression swaps and restores the snapshot pathname during process launch and proves that ExifTool still parses the held original bytes.
- Filename evidence continues to use the logical source basename, and filesystem-birth evidence comes from the inventoried held source identity rather than reopening the source pathname.
- Snapshot verification and phase-aware cleanup run through a mandatory release barrier on success, failure, and cancellation. Cleanup preserves concurrent failures, retries unfinished construction cleanup once, removes the temp file and parent, and keeps source media and transaction semantics unchanged. Output-limit, stream, and cancellation failures all receive bounded TERM-to-KILL escalation.
- The focused binding grid passes 4 suites and 104 tests under open-handle detection. Scoped core coverage passes the configured thresholds at 94.56% statements, 85.44% branches, 100% functions, and 97.1% lines. Type checking, scoped lint, and formatting are clean.

## 2026-08-30 exhaustive inventory and multi-source correction

- Reproduced the final-review omission: inventory discarded every regular file whose extension was absent from its private registry, so preview could claim completeness while unknown inputs disappeared.
- Replaced the duplicate inventory and shared format tables with one classified `SUPPORTED_MEDIA_FORMATS` registry. Every derived format list and inventory classification now comes from that registry, with duplicate-free tests across every extension.
- Inventory now records every regular file with an explicit supported or unsupported status, normalized extension, canonical path, and filesystem identity. Link, path, identity, and metadata safety checks apply before either status is admitted.
- Unsupported inputs become non-mutating preview rows with `operation: skip`, no target, unresolved evidence, exact size and modification fingerprint, and a `Needs Review` warning stating that the source remains unchanged. They never reach hashing, metadata extraction, destination probing, or transaction admission.
- Closed the reviewer follow-up by making supported and unsupported inventory entries a discriminated union. Unsupported rows now increment `unresolvedDates`, so row evidence and preview totals cannot contradict each other.
- Replaced the renderer's single source string with ordered, deduplicated `sourcePaths[]` state. Operators can add one or more folders, retain prior selections, remove each folder through a path-specific accessible control, and send the exact remaining array to preview.
- Updated the product and quick-start contracts so exhaustive inventory, unsupported reporting, and multi-source selection match the shipped behavior.

## 2026-08-30 truthful per-file terminal outcomes

- Reproduced the final-review defect: a ledger containing failed file operations still emitted `job-completed`, while durable history replaced `processedFiles` with `totalFiles` and hid every failed path.
- Added `job-partially-completed` and terminal `partial` state for mixed outcomes. A job with every planned operation failed emits `job-failed` with `FILE_OPERATIONS_FAILED`; zero per-file failures is the only route to `job-completed`.
- Terminal partial and file-failure events carry conserved statistics plus each failed source path and error. History and evidence persistence reject completed events with failures, mismatched failure arrays, non-conserved counts, and processed byte totals above input bytes.
- Progress, history, and renderer `filesProcessed` now mean committed successes only. The Redux state, active terminal card, and persisted history show succeeded, skipped, failed, and total counts plus the failed path and error list.
- Added RED-to-GREEN protocols for mixed success/skip/failure, all-file failure, invalid executor output, Unicode failed paths, missing executor error text, state-machine terminality, durable replay, contradictory persistence, Redux reduction, active terminal UI, and history UI.
- Focused validation passes 8 suites and 133 tests under `--detectOpenHandles`. Whole-tree typecheck plus scoped ESLint and Prettier checks pass.

## 2026-08-30 native cross-platform runtime trust correction

- Replaced the macOS and Windows packaged-runtime injection dead end with built-in, fail-closed production trust policies. macOS requires the canonical `/Applications/*.app` resource layout, a non-root process, a root-owned protected bundle chain, strict code-signature verification, Gatekeeper assessment, and held-descriptor broker execution. Windows requires the canonical Program Files layout, a non-elevated token, valid Authenticode, and a broker that the current token cannot open for writing.
- Kept Linux on its separately proven root-owned immutable launch policy. All three policies feed the same manifest-bound broker and native helper graph; packaged runtimes still reject development policies or an attestor for another platform.
- Added a pinned native Perl 5.42.3 materializer using the official CPAN source SHA-256. It compiles on Linux/macOS native runners and stages the complete 2,201-file pure/core library inside application resources. Package verification exercises JPEG, PNG, TIFF, HEIC, QuickTime, MP4, PDF, MP3, and WAV inputs with the build tree unavailable, then rejects any loaded module outside resources. Windows continues to stage the vendored native ExifTool executable. No runtime package manager or host Python, FFmpeg, SQLite, Perl, or ExifTool lookup exists.
- Expanded native CI to Linux x64, macOS x64/arm64, and Windows x64/arm64 staging and broker proof. Release jobs compile the expected macOS TeamIdentifier or Windows certificate SHA-256 into the broker, build on native runners, require signing, require macOS notarization, extract the final PKG/NSIS installer, rerun containment checks, compare the exact signer identity, and upload only checksummed artifacts that pass those gates.
- Linux x64 staging and containment are locally proven. macOS and Windows policy/unit/workflow gates are validated from Linux, but their native runtime, signature, notarization, and installer-extraction gates remain intentionally unclaimed until the corresponding GitHub runners execute them.

## 2026-08-30 full decision and operation evidence correction

- Closed the audit gap between the metadata resolver and the immutable manifest. The coordinator now carries a private, frozen preview-audit snapshot beside the public preview DTO.
- The private snapshot contains every supported row's complete `DateResolutionRecord`, including all scored candidates, raw source values, rejection reasons, selected value, confidence, and policy version. It also contains an ordered operation record with the operation ID, source path, target path, byte count, and decision-row binding.
- Kept raw embedded metadata out of renderer DTOs and ordinary job history. Runtime fanout sends the reduced preview to history and sends the private audit snapshot only to the owner-private evidence sink.
- Added exact-key schema validation and cross-record conservation before admission. Evidence rejects unknown fields, identity mismatches, duplicate candidate or operation IDs, missing decision mappings, non-contiguous operation indexes, and any source, target, or byte disagreement with the public preview.
- The manifest now emits the previously declared `candidate-observed`, `resolution-decided`, and `operation-planned` events in deterministic preview order. Mutation after hook admission cannot alter persisted bytes because canonical snapshots are captured synchronously.
- Added focused regression proof for full candidate and resolution persistence, exact source/target operation mapping, post-admission mutation isolation, and public-record metadata minimization.

## 2026-08-30 post-mutation persistence outcome correction

- Reproduced the final-review defect where an executor successfully committed a file mutation, but a rejected ledger append prevented that outcome from entering the coordinator ledger. The fallback `job-failed` event then omitted committed counts, byte totals, and failed paths from terminal output, history, and evidence.
- The coordinator now records each settled executor outcome in memory before the fallible history and evidence append. Durability still blocks admission of the next operation, but an audit sink failure cannot erase an already completed mutation from terminal truth.
- Coordinator-level failures now carry conserved statistics and exact per-file failure details. Planned operations that were never admitted after the persistence failure are counted as failed and named by source path; committed, skipped, and executor-failed outcomes retain their original classification.
- Preserved the typed `HISTORY_PERSISTENCE_FAILED` code instead of collapsing the error into a generic coordinator code. The terminal remains non-recoverable because blind replay after a committed mutation would be unsafe.
- Evidence validation now accepts a `job-failed` terminal with system-level failure statistics that include successful or skipped files, including an empty failed-path list when every media mutation succeeded. `FILE_OPERATIONS_FAILED` requires both statistics and file failures, and every planned file must be represented as failed.
- Changed `src/main/services/ProcessingCoordinator.ts`, `src/main/services/CoordinatorEvidenceAdapter.ts`, `tests/unit/services/ProcessingCoordinator.test.ts`, and `tests/unit/evidence/CoordinatorEvidenceAdapter.test.ts`.
- A deterministic two-worker protocol proves the first persistence error remains authoritative while another already-admitted mutation settles and remains counted; only never-admitted paths become failures.
- Validation passes both focused suites at 71 of 71 tests with open-handle detection, plus whole-tree typecheck, ESLint, and Prettier checks.

## 2026-08-30 cancelled Move residue truth correction

- Reproduced the final-review defect where a Move cancelled after destination commit retained both the committed destination and source, but the executor reduced it to a zero-byte failure and the terminal event, evidence, history, and UI hid the residue.
- Added a cancellation-specific terminal contract. It separately counts successful, skipped, failed, cancelled, and unattempted files, plus successful bytes and committed residue bytes. The count and byte equations must conserve the complete preview plan.
- Added one exact outcome for every preview row, including conflict skips with a destination and unsupported skips with no destination. Each record carries source path, nullable destination path, planned bytes, state, committed bytes, source-retention truth, and error text. Unattempted operations are named instead of disappearing.
- The transaction executor now preserves `destination-committed-source-retained` for a post-commit cancelled Move and `cancelled-before-commit` for a precommit cancellation. Neither is counted as a successful Move.
- The coordinator records aborting in-flight operations before terminal emission, persists cancellation ledger records as `operation-cancelled`, and builds terminal statistics, failures, and outcomes only from the immutable plan plus ledger.
- Evidence binds every cancellation outcome back to its immutable preview row and, for attempted work, its exact audited operation and ledger entry. JSONL history stores the immutable preview rows and rejects path, destination, planned-byte, skip-state, and row-count substitutions. Both validators independently derive total, successful, and residue bytes from per-file outcomes.
- The reviewer counterexample pass tightened those bindings further. History accepts explicit-instant, floating-local, and date-only preview evidence, while executable `completed` outcomes must commit every planned byte and report source retention consistent with Copy or Move. Evidence requires exact error equality for ledger outcomes, the coordinator's exact not-attempted reason when no ledger exists, and no invented error on preview skips.
- The final boundary sweep rejects impossible calendar dates even when Node would normalize them, executable rows with null destinations, skipped outcomes that claim the source was removed, and committed-destination residue whose bytes do not equal the immutable planned size. Equality preserves the valid zero-byte residue case.
- Skipped executor outcomes must report zero committed bytes at coordinator and evidence admission. This keeps upstream ledger truth aligned with the shared terminal validator instead of converting a malformed skip into a later cancellation failure.
- Failed executor outcomes receive a nonempty error before ledger persistence; an absent message becomes the fixed fallback `Operation failed without an error message`, while any present blank optional error is rejected for committed, skipped, failed, and cancelled outcomes. Evidence enforces the same present-error rule and requires failed ledgers to carry an error, so cancellation closure cannot invent terminal-only text.
- Coordinator and evidence admission now enforce those invariants before any sink appends: committed outcomes require all planned bytes, executable preview rows require a destination, and the shared date-evidence calendar validator rejects impossible explicit-zone and local values.
- `destination-committed-source-retained` is now Move-only at coordinator normalization, evidence ledger admission, evidence terminal binding, and history preview binding. A Copy executor cannot inject Move residue into durable evidence or the renderer DTO stream.
- Zero-byte post-commit Moves remain `destination-committed-source-retained` across executor, coordinator, evidence, history, Redux, the active result card, and job history. Byte value can no longer erase a committed destination. A null destination is rendered explicitly as `(no destination)`.
- TDD proof: the reviewer follow-up reproduced unknown-ledger admission, preview-row omission, aggregate-only validation, processed-byte inflation, zero-byte state collapse, floating-local rejection, false completed Moves, invented terminal errors, failed ledgers without an error, blank optional ledger errors, partial committed residue, removed-source skips, nonzero-byte skips, executable null targets, normalized impossible dates, and Copy-labelled Move residue before the corrections. The corrected focused grid passes 9 suites and 214 tests under `--detectOpenHandles`; typecheck, full-source ESLint, full-source Prettier, and `git diff --check` pass.

## 2026-08-30 final clean-install and release validation

- A fresh-copy replay exposed a hidden prerequisite: integration tests reached the packaged native helper only when an ignored `.build-tools` directory already existed. The crash-child protocol therefore exited through its setup-error path before reaching the injected crash boundary.
- Added a package-policy regression before changing the command. `npm run test:ci` now stages the complete bundled runtime itself, so a registry-only `npm ci` followed by the documented test command has no prior-worktree dependency.
- A second empty temporary checkout proved the correction from zero state. `npm ci --ignore-scripts` reported zero vulnerabilities, `npm run test:ci` staged four Linux x64 tools, and all 44 suites and 842 tests passed with open-handle detection.
- Final configured coverage is 89.36 percent statements, 84.87 percent branches, 91.58 percent functions, and 91.26 percent lines. Formatting, ESLint, strict typecheck, source containment, native Rust formatting/clippy/tests, full and production npm audits, production bundles, and diff checks pass.
- Native validation passes 25 filesystem-helper protocols and 7 launch-broker tests. The production main, preload, and renderer bundles compile without warnings.
- Fresh Linux x64 installers were built and extracted through the same containment checks used by release CI. DEB SHA-256: `b34dced9ee7a46a741605fb01484e1e75b7d736df74a5b56529c1f4bce9c763c`. RPM SHA-256: `a90f31687c79f012d35e073435c7b492fda57cae24243fa57d565416dfe96c16`.
- The final independent review passed 354 cross-layer tests and returned LGTM with no remaining functional, security, or release finding. Linux x64 is locally proved. macOS and Windows remain truthfully gated on their signed native CI runners.

## 2026-08-30 exact-tree materialization

- Sealed the validated refit as commit `3b317b497e48cfbb5a89292a3ef2bddce4503d83` with tree `0dcfd738ee126047739277aad9103f6f48353968`.
- Moved every baseline path absent from the refit into path-preserving RAID Pre-Trash before modifying the original repository. No deleted source was discarded.
- Applied the refit to the original `main` index and required `git write-tree` to equal the sealed refit tree before commit. The gate caught one rename-detected legacy audit artifact; it was preserved and the gate reran successfully.
- Materialized the exact validated tree into the original repository as commit `878e56e3101aba04650e1443cc3053eda7c463b9`. Neither repository was pushed or published.

## 2026-08-31 live preview progress and cancellation

- User requested visible status while preview analysis runs, including current-file detail, then identified that analysis had no Stop control.
- Chose backend-authored progress instead of a renderer animation. `preview-progress` events carry exact processed counts, totals, phase, percentage, and the current path.
- Added cooperative cancellation from the renderer through the existing typed cancel IPC path. The same abort signal now reaches root validation, recursive inventory, source snapshotting, metadata extraction, and destination planning.
- Added a linear cancellation cutoff. Stop succeeds only while analysis is cancellable. Once planning is complete, the coordinator reports `PREVIEW_FINALIZING` instead of claiming a cancellation that cannot occur.
- Enforced the progress contract before `preview-ready`: zero-based start, stable totals, no regression, one-file increments, terminal organization phase, 100 percent completion, and total equality with the preview summary.
- Limited the product to one active preview analysis. The coordinator rejects overlap, the renderer blocks rapid duplicate requests, and Redux refuses a second preview-started event from replacing the active job.
- Kept the organizer mounted while other tabs are open. Progress, Stop Preview, and the final preview result survive navigation.
- Added reduced-motion handling and accessible determinate or indeterminate progressbar semantics. Stop Preview disables during durable finalization.
- Visible runtime testing reproduced delayed preview events arriving after a failed IPC response and leaving the launcher stuck on Building Preview. The launcher now returns to selection when a late terminal failed or cancelled state closes that preview.
- Added tests across path and root validation, inventory, planner, coordinator, IPC, state machine, history validation, Redux, application navigation, and the launcher. The focused feature grid passes through the named Jest suites in the validation protocol.
- No dependency was added. Source media remains read-only throughout preview and cancellation.

## 2026-09-01 opt-in screenshot filename labeling

- User requested a settings-controlled feature that appends `-screen-shot` before an image extension when metadata or the existing filename identifies a desktop or iOS screenshot.
- Chose conservative classification. Accepted filename evidence is explicit `Screenshot`, `Screen Shot`, or `Screen Capture` wording. Accepted metadata evidence is an image `UserComment` equal to `Screenshot` or the established iOS/macOS CGRect partial-capture form. Dimensions, PNG format, Apple device identity, and generic desktop wording are not evidence.
- Added `organization.appendScreenshotSuffix`, default `false`, to schema-3 application configuration and the Settings UI. The value crosses the canonical preview options, coordinator, history, evidence, and production runtime boundaries.
- Added screenshot evidence to the verified metadata result. It is derived during the existing ExifTool read of the preview-bound content, so no second metadata process or host dependency is introduced.
- Applied the suffix in `MediaPlanner` before collision numbering. Trusted date names and `_Needs Review` names both preserve their extension, remain within the filename length bound, and do not duplicate an existing `-screen-shot` suffix.
- Preview rows disclose the evidence field when the suffix is applied. Execution consumes the immutable reviewed target path and cannot independently reclassify the file.
- Added a schema-1 history migration that defaults pre-feature records to `appendScreenshotSuffix: false`. Current history writes reject missing, unknown, or non-boolean processing fields.
- TDD covered explicit filename forms, exact UserComment and CGRect metadata, weak-evidence rejection, non-image rejection, enabled and disabled naming, idempotence, review routing, settings persistence, UI behavior, preview-to-operation equality, IPC, evidence, history migration, and the production runtime smoke path.
- No dependency was added. Source metadata remains read-only.
- Attack review precommitted rejection if weak evidence labeled a file, preview and execution targets diverged, or preview text claimed a rename that did not occur. Filename and media-kind counterexamples held. The review corrected spaced CGRect parsing and changed the warning to truthfully cover already-suffixed names.
- Final coverage passes all 44 suites and 875 tests at 89.45 percent statements, 84.94 percent branches, 91.68 percent functions, and 91.39 percent lines. Formatting, ESLint, strict type checking, production bundles, package staging, containment verification, and diff checks pass.

## 2026-09-02 adaptive parallel preview analysis

- User observed roughly 13 percent CPU during preview and requested faster parallel image analysis while keeping total CPU below 80 percent.
- Preserved the product's central date algorithm. Filename, embedded metadata, container metadata, filesystem birth time, offsets, subseconds, confidence, ambiguity, and `Needs Review` logic still pass through the unchanged `DateResolver` policy.
- Split preview generation into two stages. Snapshot creation, SHA-256 work, and bundled ExifTool reads now run concurrently. Date decisions and destination collision reservations still run in canonical path order, keeping filenames and evidence deterministic.
- Added `AdaptiveWorkPool` with no new dependency. It uses Node's available processor count, reserves 25 percent CPU headroom, caps preview analysis at 16 workers, samples aggregate host CPU every 50 ms, and stops admitting work while utilization is 80 percent or higher.
- The attack consequence walk found that 15 simultaneous 10 GB media snapshots could consume roughly 150 GB of temporary storage. Added byte-weighted admission using current filesystem capacity. In-flight snapshots may use at most the smaller of 32 GiB or half of available temporary space, and an oversized single snapshot fails before copying.
- Cancellation links into the worker pool. It stops queued admission, aborts active analysis, waits for every admitted task to settle and release its private snapshot, then returns the first causal error.
- TDD reproduced the prior single-file peak, proved bounded concurrency and ordered results, exercised the 80 percent admission gate, rejected invalid resource limits, and proved cancellation settles active tasks without starting queued work.
- A real benchmark used 45 PNG files through the bundled ExifTool, private snapshot, repeated SHA-256, date planning, and cleanup path. The first serial-then-parallel pass measured 6997 ms versus 700 ms. An independent cache-order challenge ran parallel first on a separate source tree and measured 721 ms versus 7095 ms, a 9.8x speedup. Peak sampled host CPU was 71.7 percent on the 20-thread Linux validation host.
- The first benchmark attempt exposed an unreferenced CPU timer that allowed a standalone Node process to exit before work started. The timer now remains referenced. Electron was not affected, but the portable behavior was corrected before validation.
- Final validation passes 46 suites and 883 tests at 89.36 percent statements, 84.86 percent branches, 91.63 percent functions, and 91.33 percent lines. Formatting, ESLint, strict type checking, production bundles, package staging, containment verification, and diff checks pass.
- Recorded at 2026-09-02 21:20 EDT. The already-running Electron process was not stopped or restarted; it remains on the prior loaded bundle until the User authorizes restart.
