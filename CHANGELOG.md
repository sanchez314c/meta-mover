## 2026-09-25 exact 2022 batch-placeholder recovery

- Added a fail-closed recovery for the audited 2022 batch signature: EXIF DateTimeOriginal and CreateDate must repeat the same `2022-01-01 00:00:00` wall time, including the known matching tiny synthetic subsecond form, and XMP CreateDate must repeat that placeholder when present.
- Recovery requires exactly one nonplaceholder creation alternative: either one valid nonmidnight Photoshop DateCreated value, or agreeing IPTC DateCreated+Time and DigitalCreationDate+Time values. A second nonplaceholder creation claim, disagreement, different placeholder day, or unmatched EXIF fractions remains in Review Queue.
- The cohort rule now runs only after established narrow metadata recoveries and only when ordinary resolution would remain ambiguous or require review. Full evidence replay confirms it changes zero previously resolved records. Photoshop and IPTC alternatives must also carry their expected embedded source kind and family; malformed or ineligible named alternatives fail closed.
- Exact replay of the completed run's 937 Review Queue decisions recovers 209 rows at medium confidence, 197 through Photoshop and 12 through the agreeing IPTC pair. The rule has zero signature spillover; combined with the 35 calendar-date recoveries, 693 rows remain.

## 2026-09-25 unanimous embedded capture calendar recovery

- Added a review-only date recovery when every eligible embedded EXIF, XMP, or IPTC capture claim agrees on one calendar day but its clock evidence is conflicting, placeholder-marked, or absent. The rule runs only where ordinary resolution would remain ambiguous or low confidence, so a trustworthy timestamp already selected by the normal resolver keeps its time.
- Filename and filesystem dates cannot establish or veto the result. Embedded digitized and content-created lifecycle fields do not veto the capture day because they can describe import or processing events. Credible external creation evidence and every eligible embedded capture claim still veto on a different day.
- Replaying the completed run's exact 937 Review Queue decisions recovers the independently identified 35 files at calendar-date precision and leaves 902 for review: 33 ambiguous and 2 low-confidence rows become resolved; all 266 unresolved rows stay unresolved.
- Full 99,998-row replay preserves the status and selected date value of all 99,061 previously resolved rows. Combined residue recovery is 244 rows: 35 calendar fallbacks plus 209 exact 2022 placeholder recoveries.

## 2026-09-23 calendar-date-only resolution

- Closed a fail-open evidence boundary: coordinator evidence admission and shared Review contracts now apply real Gregorian validation to `YYYY-MM-DD` values. Impossible dates such as `2022-99-99`, `2023-02-30`, and year zero are rejected before persistence or review actions.
- Corrected calendar-date recovery so a same-day date-only IPTC field no longer discards a trustworthy non-midnight EXIF capture time. Date precision is now used only when embedded evidence actually leaves the time unavailable or conflicting.
- Added resolver regressions for trusted timed EXIF plus date-only IPTC, conflicting same-day embedded times with a date-only claim, and the existing midnight-placeholder path.
- Added `date-resolution/2`, which resolves a calendar day when every eligible or corroborating embedded EXIF, XMP, and IPTC creation claim names that same day but the time is missing, conflicting, or a midnight placeholder.
- Date-only results retain `YYYY-MM-DD` with `date-only` precision and the audit reasons `CALENDAR_DATE_CONSENSUS`, `TIME_UNKNOWN`, and `RESOLVED_DATE_ONLY`. Filenames, filesystem dates, and modification fields cannot establish the consensus.
- Planned names are `YYYY-MM-DD.ext`; ordinary collision suffixing remains responsible for same-day duplicates. Date-only results never become `00-00-00` filenames.
- Destination metadata normalization skips date-only results, preventing an unknown time from being written as midnight. The Review Queue also accepts a manual calendar date and states that the time remains unknown.
- The v2 evidence readers retain v1 compatibility and validate the exact date-only shape. The live application was not restarted.
- Shared Review validation now applies the coordinator's selected-candidate checks to v2 date-only evidence: the selected ID must exist, remain eligible with a positive score, carry valid creation provenance, and support the reduced calendar value. Forged or missing automatic and user-override selections fail closed.
- Credible sidecar, container, and other nonfilesystem creation evidence now vetoes calendar consensus when it names another day. Filename and filesystem evidence remain unable to establish or veto the day.
- The corrected fresh 7,391-row replay resolves 6,262, selects date-only precision for 3,652, and leaves 1,129. Relative to the earlier replay, 287 trustworthy timed results keep their time and 64 conflicting timed records return to review, accounting for all 351 removed date-only selections. `docs/CALENDAR_DATE_REPLAY.md` records the evidence; the result remains above the under-one-percent gate.

## 2026-09-23 audited Canon and Samsung MakerNote recovery

- Added one narrow Canon MakerNote capture rule: `Canon:TimeStamp` is eligible only for `Canon EOS 5D`, only when it is non-midnight, exactly matches `IFD0:ModifyDate`, and replaces matching midnight `DateTimeOriginal` and `CreateDate` placeholders. Generic MakerNote dates remain excluded.
- Preserved `Samsung:TimeStamp` as zone-bearing capture evidence. When Samsung and standard EXIF agree to the whole second but encode fractional digits differently, META Mover selects only the agreed whole second and retains `SUBSECOND_CONFLICT` in the audit record.
- Explicitly left Apple runtime, Casio firmware, date-stamp mode, self-timer, and exposure-setting tags outside the collector allowlist.
- Real 7,391-row review replay identifies exactly 147 Canon recoveries and 58 safe Samsung recoveries after the nanosecond collector correction. Two Samsung rows retain conflicting GPS instants and remain ambiguous. No unrelated MakerNote rows transition.

## 2026-09-23 exact offset and subsecond instants

- Preserved all 1 to 9 source fractional digits when converting explicit-offset and spec-defined UTC metadata into `instantUtc`; JavaScript `Date` is now used only for whole-second calendar and offset rollover.
- Kept nanosecond-exact resolver validation. Genuine offset/instant disagreements, including a one-nanosecond mismatch, remain rejected.
- The 7,391-row review replay repairs 579 affected records and safely moves 288 to `resolved/medium` with no review-row regression. A full 99,998-row replay also exposes 32 formerly high-confidence records as genuine fractional conflicts; these now fail closed instead of receiving a date from truncated evidence.

## 2026-09-22 plain-English Review Queue evidence

- Replaced internal reason codes, candidate IDs, tags, and numeric scores in the Review Queue with direct explanations of why META Mover stopped.
- Grouped identical date values and labeled their sources as camera EXIF, IPTC/Photoshop, XMP, container, sidecar, filename, or filesystem evidence. Filename and filesystem dates are explicitly marked as weak context.
- Candidate controls remain bound to the exact evidence candidate IDs. Duplicate reason text is collapsed, and cautious recommendations appear only when one strong embedded date is opposed solely by weak filename or filesystem context.
- Reviewer correction: candidates now group by full temporal identity, so different offsets, UTC instants, timezones, precision, or fractional seconds remain visible. Displayed dates preserve fractions and zone context; EXIF labels distinguish original, digitized, and modified fields; unknown reason codes receive a safe generic explanation.

## 2026-09-22 unanimous local capture recovery

- Recovered 2,265 formerly ambiguous images when floating EXIF `DateTimeOriginal`, a different
  embedded capture source, and every eligible nonfilesystem contender agree on one non-midnight
  local clock. Filename lineage remains display-only and is never required.
- Kept the result at medium confidence and retained every contender ID because instant-bearing
  fields still disagree about zone representation.
- Excluded nonzero fractions, differing local values, unrelated date-only claims, midnight
  placeholders, explicit-offset originals, and filenames as independent corroboration.
- Full 99,998-row replay changed exactly 2,265 `ambiguous/none` records to `resolved/medium` and no
  other status or confidence. Removing the erroneous filename requirement added no records in the
  current ledger.

## 2026-09-22 reason-specific review folders

- Split review output beneath each media type into `Placeholder Dates`, `Conflicting Dates`, `Metadata Read Failed`, and `No Usable Date` folders.
- Preserved the sanitized original basename for every review item; screenshot suffix labeling remains limited to trusted dated output.
- `Metadata Read Failed` requires the explicit `METADATA_READ_FAILED` resolution reason. Current metadata collector warnings do not yet add that reason to the resolution record, so those rows continue to use `No Usable Date` until retry plumbing supplies it.
- Added exact-path planner coverage for all four reasons, guarded status/reason combinations, every media type, malformed or untrusted selections, and review basename preservation.

# Changelog

## 2026-09-22 durable review override ledger

- Added a private append-only `ReviewOverrideStore` for Review Queue decisions. It enforces the shared exact record schema, contract-derived review IDs, per-review monotonic sequences, latest-record replay, a live exclusive lock with dead-owner recovery, canonical safe paths, single-link file identity, `0700` parent and `0600` file permissions, and fsynced appends.
- Startup repairs only an invalid partial trailing record. Complete records without a terminating newline, malformed middle records, sequence gaps, external file drift, lock replacement, and unreconcilable append outcomes poison the store instead of guessing.
- Ambiguous append failures reconcile exact prefix bytes, truncate partial writes, retry, and sync before publishing in-memory state. Focused storage tests cover replay, permissions, contention, stale locks, tail repair, poison paths, sequence rejection, append reconciliation, symlinks, hard links, close-time draining, and read-time detection of replacement, truncation, or external append.

## 2026-09-21 default window dimensions

- Set the unsaved-window default to the User's manually selected 1280 by 1316 dimensions. Persisted window bounds continue to take precedence.
- The live application was measured read-only and was not closed, resized, or restarted during this change.

## 2026-09-21 audit preparation cache and concurrency correction

- Bound durable normalization indexes, cohort summaries, dataset revisions, and approvals to a canonical SHA-256 fingerprint of the active audit and transform policy. A policy change now rebuilds derived data and invalidates prior approvals.
- Added process-wide single-flight preparation across repository instances sharing an evidence root. Randomized build artifacts prevent writer collisions, and legacy interrupted artifacts are discarded before a new build.
- Reopen now verifies and reuses the private sealed snapshot before considering a source recopy. Cold preparation verifies the temporary snapshot before publication and retains the post-index verification that detects evidence mutation during derivation.
- Corrected the reviewer follow-up: persisted support classification now comes from the target format policy, every failed or cancelled preparation removes its randomized snapshot/index/cohort artifacts before rejection, approval writes serialize across repository instances, and canonical roots prevent lexical path aliases from bypassing either shared lock.
- Focused validation passes 15 repository tests covering concurrent and aliased instances, interrupted-build recovery, malformed and cancelled preparation cleanup with immediate retry, stale policy metadata and approvals, unsupported formats, immutable authorization binding, large-dataset progress and cancellation, TypeScript, and scoped ESLint.
- Final project validation passes all 55 suites and 1,085 tests with 89.18 percent statement, 84.44 percent branch, 91.74 percent function, and 91.11 percent line coverage. The explicit 100,000-record job-plan scale test passes. Independent re-review returned `LGTM` after all five findings were closed.
- Refreshed seven transitive build packages through `npm audit fix`; both complete and production-only audits now report zero vulnerabilities. No direct dependency or application runtime contract changed.

## 2026-09-17 audit preparation progress, cancellation, and indexed authorization

- Correction for the 2026-09-12 evening 100,000-file run that appeared frozen at `2 / 100,000`: two files had completed, and the first eligible file was blocked behind authorization evidence preparation with no visible stage and no cancellation path.
- `NormalizationAuthorizationPort` now carries an `AbortSignal` and a progress channel through the executor's authorization await. The audit repository streams the sealed evidence snapshot through cancellable, progress-reporting passes scoped per request via `AsyncLocalStorage`, and treats aborts as rejections rather than invalid evidence.
- Hash-chain verification strength is unchanged: canonical JSON, sequence, previous-hash linkage, per-event hashes, sealed ending, and pre/post identity checks still run.
- Authorization replaced the full-resolution in-memory Map with an indexed lookup carrying `sourcePath`, `outputPath`, and resolution-hash binding checks plus duplicate-operation corruption detection.
- The Organize view shows a `Preparing metadata audit` card with stage, counts, and percentage while preparation runs, with cancellation enabled. The stage rides the `preparation` payload of ephemeral job progress; the processing phase enum is unchanged, so the file counter still shows last-completed counts during preparation.
- Job progress additionally reports committed `bytesProcessed`, `totalBytes`, `throughput`, and estimated time remaining.
- Validation on 2026-09-17: TypeScript, ESLint, and the complete Jest suite pass with 55 suites and 1,077 tests. Independent adversarial review confirmed the correction is implemented end to end and enumerated the remaining gaps: duplicate full-snapshot verification on the cold path, per-session snapshot recopying before the durable-index reuse check, no single-flight sharing of preparation across concurrent authorizations, and missing large-evidence, shared-preparation, and authorization-decision tests.

## 2026-09-12 15:42 EDT omitted-subsecond preview serialization correction

- Corrected the date resolver's omitted-subsecond output to exclude `fractionalDigits` instead of emitting an own property with `undefined`, which the coordinator rejected during strict JSON preview admission.
- Preserved conservative fractional-evidence rejection, original candidate values, and strict preview validation. This correction does not change the standalone repair script or source media.
- Added coordinator/planner serialization regressions for absent, unverified floating, unverified offset-bearing, and verified fractions. The focused four-suite run passes 183 tests; no full-corpus or live-runtime result is claimed here.
- Read-only production metadata replay of 100 real test files reproduced four baseline failures, including operation 36, `input/Duplicates/2000-08-11_19-51-59.000038.jpeg`. The correction retains the same whole-second selections and reason codes without media writes. Type checking and focused ESLint pass; the 82-test resolver coverage run exceeds 90 percent statements and branches. The full 100,000-file preview has not been rerun.

## 2026-09-09 20:55 EDT image-format and embedded-date repair expansion

- Expanded the standalone repair contract beyond JPEG and two EXIF tags to semantic embedded date/time fractions, including EXIF modification subseconds and XMP timestamps.
- Required actual file-type detection, explicit accounting of scanned images and unsupported capabilities, staged writes, and format-appropriate content verification. No universal write-support claim is made.
- Whole dates/times, offsets, trailing zeros, unrelated metadata, and filenames remain protected. Final validation passes 42 tests, 85 percent combined coverage, and independent `SHIP` review.
- The 228-file copied/fixture corpus contained 215 matching repair candidates and 13 negative/format controls. All 215 candidates were repaired with 666 fractional changes; all 13 controls stayed untouched. All 215 backups are byte-exact, and a second dry-run found zero candidates.
- Successful repairs covered JPEG, DNG, HEIC, PNG, TIFF, animated WebP, animated GIF, and AVIF across 209 real matching files and six matching synthetic fixtures. The three warning-only WebP controls had no repair targets.
- Verified all 228 original source hashes and modification timestamps, all 269 decoded frames/pages, raw DNG/TIFF strips/tiles, and embedded preview/OtherImage bytes unchanged, with zero protected metadata differences. BMP remains explicitly unsupported; no universal write claim or full-library mutation is included.
- Eight-worker apply took 33.307 seconds and repeated dry-run 6.227 seconds on the cached sample; these timings are not extrapolated to the full library.

## 2026-09-09 20:26 EDT explicit six-digit subsecond override

- User revised `tools/repair_subsecond_padding.py` to remove leading zeros independently from existing EXIF `SubSecTimeOriginal` and `SubSecTimeDigitized` values containing exactly six ASCII digits. All zeros become `0`; trailing zeros are preserved.
- The explicit manual conversion replaces corroboration and date-confidence requirements for this standalone script only. Other metadata fields, filenames, and normal application behavior remain unchanged.
- Revised validation passes 21 Python tests with 84 percent branch-inclusive coverage and independent `SHIP` review. A fresh 200-copy trial repaired 194 files (388 Original/Digitized values), refused four pre-existing `IPTCDigest` warnings, and excluded two HEIC files.
- All 200 original source hashes and modification timestamps, decoded pixels/frames, thumbnails, and embedded previews remain unchanged; all 194 backups match exactly. Metadata relocation pointers are checked through unchanged embedded-image content. Other protected metadata and filenames remain unchanged.
- The repeated dry-run found zero candidates. Eight-worker apply took 3.158 seconds on this warm-cache sample; no full-library writes or throughput extrapolation are included.

## 2026-09-09 20:15 EDT standalone legacy subsecond repair

- Added `tools/repair_subsecond_padding.py` with configurable parallel workers, persistent ExifTool processes, bounded streaming, progress, dry-run by default, and verified explicit writes.
- Restricted the historical repair to supported six-digit left-padding cases. Valid leading zeros and uncertain fractional timestamps must remain unchanged.
- Validated 20 passing Python tests and independent `SHIP` review. A 200-copy real-image trial repaired 48, preserved 146 uncertain files, refused four pre-existing `IPTCDigest` warnings, and skipped two HEIC files. A rerun found zero repair candidates.
- Verified all 200 original source hashes and modification timestamps unchanged, unchanged decoded pixels/frames and thumbnails, zero protected metadata differences, and 48 exact original backups. Only test copies were modified; the roughly 900,000-image library remains untouched.
- Eight-worker apply completed in 1.507 seconds on the copied sample. Warm-cache scans measured 0.928/0.589/0.596 seconds at four/eight/sixteen workers; no full-library performance claim is inferred from that sample.

## 2026-09-06 integrated random test runs

- Added a persisted Test Mode toggle to Settings. When enabled, Organize displays a persistent TEST MODE warning and replaces normal preview with `Gather & Build Test Preview`.
- The test action copies 15,000 random files into an app-owned temporary corpus and automatically previews only those copies.
- Added bounded reservoir sampling, eight-worker copy concurrency, relative-path preservation, prior-test-run exclusion, strict IPC validation, and owned-path cleanup after successful processing.
- Originals are never processed by test-run mode. Failed and cancelled runs retain the temporary corpus for inspection.
- Moved temporary gathering from the OS system disk to an app-owned staging root beside the destination, enabling copy-on-write clones when the filesystem supports them.
- Added live scan count, copy count, percentage, current filename, and Stop Test Run. Cancellation removes incomplete app-owned staging before returning.
- Corrected evidence-summary validation for unsupported files: unresolved rows are now conserved from their explicit `UNRESOLVED` evidence state instead of requiring one UI warning string.
- Persistence errors now include the failing sink's underlying validation message instead of collapsing the useful cause to `evidence`.
- Extended the production preview lifetime from 15 minutes to 24 hours. Immediate start-time revalidation still rejects changed sources, destinations, runtime health, or processing settings.
- Changing processing settings while a preview is open now rebuilds the preview from the selected source, including an already-gathered test corpus, without gathering another random corpus. Expired, drifted, and consumed starts follow the same recovery path.
- Retained `.meta-mover-test-runs/run-*/source` folders are recognized after an application relaunch and can be previewed directly without another gathering pass. Relaunch-recovered corpora are not auto-deleted because the new process did not create them.
- Repeated attempts against an expired preview continue to report `PREVIEW_EXPIRED` instead of incorrectly changing to `PREVIEW_CONSUMED`.
- Replaced per-record `fsync` and identity validation during initial preview-evidence creation with bounded 256-event durable batches. The hash chain and private-file checks remain intact, while transaction, rejection, and terminal records retain individual durable appends.

## 2026-09-04 optional month subfolders

- Added a `Year only (no month folders)` organization setting. Resolved media now supports `Type/Year/Filename` alongside the existing `Type/Year/Month/Filename` default.
- Preserved existing year-month and flat layouts and added planner, persistence, and UI regressions.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - 2026-09-04

### Added

- Added a default-off Settings option to normalize writable destination date fields from the resolver-selected creation date after an approved copy or move. Source files and unresolved items are never written.
- Added an opt-in screenshot filename label. Verified image screenshots now receive `-screen-shot` immediately before the extension in both trusted-date and `_Needs Review` targets.
- Screenshot classification accepts explicit `Screenshot`, `Screen Shot`, or `Screen Capture` filename wording and exact iOS/macOS `UserComment` evidence, including the established CGRect partial-capture form. It does not guess from dimensions, file format, device brand, or generic desktop wording.
- Added a Settings checkbox for screenshot labeling. The option defaults off, is included in the immutable preview and execution contract, and is visible in preview warnings when applied.
- Existing schema-1 job history loads with screenshot labeling defaulted off. Current history, IPC, coordinator, and evidence records require the explicit boolean.

### Changed

- Preview metadata extraction no longer copies or hashes complete media files. Bundled ExifTool reads a seekable held source descriptor on Linux, while other platforms use a guarded direct path. Approved transactions still perform one full integrity hash.
- Removed size-weighted temporary snapshot admission. Large videos now receive the same parallel metadata scheduling as photos under the existing 80 percent CPU ceiling.
- Runtime health now reports bundled ExifTool as the dependency for destination metadata normalization. No dependency was added.
- Preview analysis now runs independent snapshot, SHA-256, and bundled ExifTool work in parallel. It reserves 25 percent of logical processors, caps the pool at 16 workers, and pauses new work when sampled host CPU reaches 80 percent.
- Concurrent snapshot bytes are limited to the smaller of 32 GiB or half of currently available temporary storage. Large files receive fewer parallel slots, and a single file that cannot fit the safe budget is rejected before copying begins.
- Date resolution and destination collision allocation remain ordered and deterministic. Faster metadata reads cannot change evidence ranking, preview row order, or suffix assignment.
- Preserved the valid metadata and filename extraction union recovered from the Python and TypeScript generations while keeping filesystem modification time outside creation-date selection.
- A cache-order challenge using 45 real PNG files on Linux x64 reduced preview time from 7095 ms with one worker to 721 ms with the adaptive pool, a 9.8x speedup. Peak sampled host CPU was 71.7 percent.
- Preview analysis now publishes real discovery and per-file metadata progress with the current path, stable counts, and an accessible determinate or indeterminate progress indicator.
- The organizer stays mounted across navigation so an active preview, its Stop control, and its completed result are not lost when changing tabs.
- Updated the build and test dependency graph to fixed Electron 44.0.0, electron-builder 26.15.3, styled-components 6.5.3, Jest 30.5.0, ts-jest 29.4.12, and wait-on 9.1.0 releases. Full and production npm audits now report zero vulnerabilities without security overrides.
- Declared the crash-test TypeScript loader and active Winston logger explicitly, eliminating reliance on packages left behind by an older install.
- Migrated Linux desktop and Windows signing configuration to electron-builder 26 while preserving deb/rpm, signed pkg, and signed per-machine NSIS policy.
- Replaced active project documentation with the current evidence-ranked preview, no-clobber transaction, JSONL persistence, immutable metadata, and packaged native-runtime contracts.
- Limited documentation and issue templates to verified Linux x64 package claims. macOS and Windows remain signed native package gates; AppImage and portable installs are unsupported.
- Moved duplicate and obsolete reports, agent notes, audit snapshots, package matrices, and templates to path-preserving RAID pre-trash with a recovery map.
- Retired the unreachable Python/SQLite processing stack, duplicate TypeScript organizer and worker pipeline, obsolete validation/tool-resolution duplicates, Conda configuration, unsafe launchers, and superseded packaging scripts into timestamped RAID pre-trash rather than deleting them.
- Reduced the declared application graph to four bundled runtime dependencies and a focused build-only toolchain. ExifTool remains a build-time staging dependency; its executable, Perl runtime, native filesystem helper, and launch broker ship under application resources.
- Limited release packaging to the currently verified Linux x64 `deb` and `rpm` formats. macOS configuration now permits only signed `/Applications` `pkg` output, and Windows configuration permits only signed per-machine NSIS output; neither is published until native signed CI proves it.
- Replaced the Linux source launcher with a fail-fast launcher that stages bundled tools, builds the three active bundles, preserves Electron sandboxing, never kills ambient processes, and never installs dependencies implicitly.
- Extended package integrity policy to reject retired dependencies, worker builds, updater metadata, portable/user-writable formats, unsigned signable artifacts, and non-root installer configurations.
- Replaced host Perl capture with a static Linux x64 Perl 5.42.0 runtime and an 11-file ExifTool module closure stored inside the app.
- Added final deb/rpm extraction and containment verification before release checksums, explicit updater suppression, immutable GitHub Action revisions, and valid `meta-mover` package metadata for both native formats.
- Replaced the legacy Electron entry composition with the canonical config, JSONL history, evidence, bundled runtime health, metadata, preview, revalidation, native transaction, coordinator, and IPC graph.
- Added one lifecycle owner for secure renderer creation and ordered, failure-complete shutdown. Browser windows now use sandboxing, context isolation, disabled Node integration, strict navigation, and IPC registration before renderer load.
- Added a strict core IPC owner for dialog, system, window, path, and external-link channels.
- Wired the application client and runtime health to packaged-tools manifest schema 3. Both now require the exact broker/helper inventory and binding; schema 2 fails closed.
- Made the launch broker the only TypeScript-launched filesystem program. Runtime health reuses the client boundary instead of hashing the helper and then launching its pathname independently.
- Added bounded broker identity and helper handshake startup with private pipes, `shell: false`, an empty `PATH`, and owned-process termination.
- Added a standalone Rust launch broker that validates the exact packaged filesystem-helper identity before launch; the application client and runtime health now consume that boundary.
- Advanced packaged tool resources to schema 3 with an exact broker entry bound to its own digest and compiled helper identity.
- Added native broker build, test, and staged relay gates to Linux, macOS, and Windows CI and release jobs.
- Routed transaction media mutations and recovery through the packaged native filesystem helper using capability roots and validated path components. Raw-path mutation is no longer a fallback.
- Made the transaction executor own and close one serialized Core/helper per canonical destination and exact source-root set.
- Journaled source-delete intent, caller delete ID, helper identity, and receipt path before transmission. Unknown deletion remains recoverable until helper reconciliation proves source retained or deleted.
- Kept content-addressed conservation objects as permanent recovery evidence and extended the 1,000-file conservation gate to both copy and move with injected post-commit faults.
- Raised the supported runtime floor to Node 22.12.0 and npm 10.9.0.
- Replaced the Git-dependent Electron rebuild chain with exact registry package `@electron/rebuild` 4.2.0.
- Kept vendored ExifTool and removed the unused FFmpeg and FFprobe package dependencies.
- Made the standalone Jest configuration authoritative and enforced coverage thresholds.
- Rebuilt CI and tagged-release workflows as hard gates without permissive failure paths.
- Reworked transactional recovery to bind nested mutations to held destination-parent identities and preserve portable exact-target recovery.
- Made core and journal lock publication atomic and ownership-aware through candidate and quarantine records.
- Corrected executor accounting so incomplete moves cannot be reported as successful processing.
- Avoided unchanged-tail full reads on the normal durable journal append path while retaining locked repair when another writer changes the journal size.
- Added a pinned Rust 1.85.1 native filesystem helper and native Linux, macOS, and Windows CI matrix for capability-relative mutations that Node cannot perform safely.
- Made Linux helper releases static PIE executables and reject staged helpers with a dynamic interpreter.
- Consolidated transaction cleanup ownership into named, failure-preserving close and value probes so admission and execution errors retain their original cause while every acquired resource is settled.

- Output is now grouped by media type at the top level of the destination: `Photos` (images and raw), `Videos`, `Audio`, `Documents`, `Art`. The chosen folder structure (`year/month`, `year-month`, `flat`) and `_Needs Review` apply inside the type folder. Names match the original Meta Mover layout.

### Fixed

- Eliminated repeated whole-file preview I/O that made a 7.64 GB video behave like a copy job. The held-descriptor metadata command completed against that real file in 0.25 seconds with no output writes.
- Metadata normalization failures now surface as failed committed-destination residue instead of reporting a completed operation.
- Stopped reporting `STRONG_CONFLICT` for two groups that describe the same UTC instant rendered in different zones (QuickTime `Keys:CreationDate` with an offset versus UTC container and track dates plus a UTC-rendered filename). The offset-bearing capture time is selected at high confidence with `SAME_INSTANT_CONTENDER`.
- Stopped reporting `STRONG_CONFLICT` when a corroborated authoritative original (EXIF `DateTimeOriginal`, QuickTime `Keys:CreationDate`, `UserData:DateTimeOriginal`, BWF origination) is contradicted by a lower-authority editorial, sidecar, or container date. The original is selected at medium confidence with `AUTHORITATIVE_ORIGINAL_PREFERRED`; the conflicting claim stays visible in the evidence. Replaying the User's 3,122-file run moved 60 of 82 ambiguous files to resolved (10 high, 50 medium); the remaining 22 are genuine conflicts.
- Flagged exact-midnight timestamps that still claim second-or-finer precision as placeholders (`MIDNIGHT_PLACEHOLDER`, -25). A placeholder can no longer act as an authoritative original, and when it is still the best available claim the file goes to `_Needs Review` with the date visible (`MIDNIGHT_PLACEHOLDER_REVIEW`) instead of being renamed at high confidence. In the User's run this moved 76 files stamped `2022-01-01 00:00:00`, `2022-12-12 00:00:00`, and `2015-10-18 00:00:00` out of high confidence, and let real IPTC/XMP timestamps win in 2 more.
- The Organize view now re-reads saved settings from the main process each time it builds a preview. It previously used a snapshot taken at startup, so switching Default operation to Move in Settings still produced a Copy preview and a `Start Copy` button until the app was restarted.
- Move within one filesystem is now a single rename. The core checks that source and destination share a device, renames without staging or hashing, and verifies the same inode landed. Cross-device moves and copies keep the verified staged path. A 2 GB video that took minutes to move now takes milliseconds.
- Cancelled or failed operations no longer leave staging hard links behind. When a committed destination shares the staging file's inode the staging link is reclaimed immediately, and every core open sweeps staging and reservation residue of terminal operations. Leftover links previously caused `Hard-linked media is rejected because path identity is ambiguous` on the next preview of files that had been moved back into a source folder.
- Removed the erroneous filesystem-modification fallback. UUID-named files with no embedded creation claim now remain unresolved instead of being renamed from an unrelated file-handling timestamp.
- Closed planner and evidence-ledger bypasses that could accept forged high- or medium-confidence filesystem modification records, relabeled metadata/profile dates, filesystem tags mislabeled as filename claims, or a selected value that did not match its selected candidate. Resolver, planner, and persistence now share one provenance rule. Filename tags require the `filename:` namespace while the basename content remains separate from metadata-tag blacklists.
- Recognized the family-1 tag names actually emitted by bundled ExifTool, including numbered QuickTime tracks, QuickTime container creation, XMP EXIF, XMP create, and XMP PDF creation dates, UserData original dates, ItemList content dates, Samsung timestamps, GPS date-time pairs, IPTC digital creation pairs, and PNG creation fields.
- Stopped treating matching local timestamps as conflicting only because one source included an offset. Explicit offsets now win selection when credible sources agree on the local capture clock, while different dates and materially different times remain ambiguous.
- Resolved corroborated whole-second agreement when metadata formats encode fractional seconds differently. Unsupported high-precision disagreements still remain ambiguous.
- Restored bounded legacy filename extraction for screenshot wording, separated and contiguous full timestamps, camera-prefixed timestamps, and explicit date-only camera names. Numeric UUID segments are not accepted as date-only evidence.
- Promoted complete timestamp filenames to medium-confidence evidence and explicit date-only camera names to calendar-organization evidence. Filesystem modification time, current time, metadata modification tags, filesystem change time, and ICC profile creation time remain forbidden.
- Parallel preview cancellation now stops queued admission, aborts active ExifTool reads, waits for snapshot cleanup, and returns the first causal failure. The CPU sample timer remains referenced so non-Electron hosts cannot exit before analysis starts.
- Prevented parallel large-media analysis from multiplying temporary-space demand by the worker count and exhausting the system volume.
- Added Stop Preview through the typed cancellation path. Cancellation now reaches recursive inventory as well as metadata work and does not mutate source media.
- Added a strict finalization cutoff so a late Stop request reports `PREVIEW_FINALIZING` instead of falsely claiming success.
- Rejected regressive, partial, mismatched, and overlapping preview progress before `preview-ready`; duplicate rapid Build Preview requests no longer create untrackable jobs.
- Prevented delayed preview events after an IPC failure from leaving the launcher stuck on Building Preview with a disabled Stop control.
- Materialized the independently reviewed refit into the original `main` repository only after its staged Git tree exactly matched the sealed refit tree. Removed baseline paths remain recoverable from path-preserving RAID Pre-Trash.
- Removed the hidden clean-test dependency on a pre-existing ignored `.build-tools` directory. `npm run test:ci` now stages the packaged native runtime before Jest, and a fresh registry-only checkout passes all 842 tests without prior build state.
- Persisted the full immutable date-decision audit trail instead of only reduced preview rows. Private evidence now records every scored candidate, complete `DateResolutionRecord`, and exact operation ID/source/target/byte mapping under strict deterministic schemas. Raw embedded metadata stays out of renderer DTOs and ordinary job history.

- Bound preview metadata decisions to the exact SHA-256 bytes recorded in the preview. ExifTool now receives the private snapshot through a held no-follow descriptor over stdin, and its tag result carries a checked digest and byte-count receipt. Source or snapshot pathname swap and restoration cannot substitute different metadata. Cancellation, concurrent failures, bounded child termination, and phase-aware temp cleanup are covered.
- Made an oversized filesystem-helper response authoritative when the child closes stdin at the same time. A provisional `EPIPE` now waits for drained stdout or a 250 ms bound, so runtime health reports the exact 65,536-byte protocol violation instead of a scheduling-dependent transport error.
- Made the concrete non-macOS BrowserWindow close event and the app-level last-window event enter the asynchronous shutdown barrier directly. Runtime owners now settle before the final permitted `app.quit()` call instead of depending on a second Electron quit event to start cleanup. A telemetry failure can no longer interrupt that final exit path.
- Prevented a quit request during deferred runtime construction from leaking a live runtime or creating a renderer after application exit began.
- Kept internal destination evidence out of public preview rows and aligned review-required date counts between preview and immutable evidence persistence.
- Removed the corruption-detection field from the live processing contract. IPC, coordinator, evidence, and new history writes reject the unknown key for every value; renderer and runtime composition no longer manufacture it. Only schema 2 config migration and schema 1 history decoding may drop the legacy boolean, with history migration warnings.
- Prevented helper launch from trusting PATH or an unchecked packaged pathname. Linux executes an independently re-hashed, sealed anonymous snapshot; macOS executes a separately reopened read-only, re-hashed, unlinked `UF_IMMUTABLE` snapshot; Windows denies helper/ancestor replacement, rejects reparse points, uses an inherited-handle allowlist, and contains the child tree in a kill-on-close job.
- Rejected launch brokers staged outside the literal `tools/launch-broker/<target>` parent layout.
- Made transactional tool staging validate the broker beneath a literal private `tools` directory before promoting that exact directory into package resources.
- Made broker identity, every schema-3 manifest object, binary hash, and relayed helper protocol fail closed on duplicate keys, unknown fields, tampering, target drift, build drift, signer-policy drift, or helper drift.
- Replaced the two pure-TypeScript filesystem architecture gates with helper-backed exact source deletion and portable capability-relative nested recovery.
- Prevented source deletion from becoming terminal from pathname absence or an ambiguous helper outcome; only applied or reconciled receipts can produce `source-deleted`.
- Prevented a cached destination Core from accepting operations under a different validated source-root capability set.
- Prevented managed cleanup from re-identifying and deleting a replacement after an exact identity mismatch. Only a helper-proven one-link transition on the same stable object and durable expected hash can refresh cleanup identity.
- Kept incomplete or mismatched source-delete intent nonterminal and preserved its committed journal fact instead of inferring completion from source-path absence.
- Treated the native helper's `target-exists` precondition as the same no-clobber collision as Node `EEXIST` across transaction reservation, publication, conservation, and restoration paths.
- Prevented concurrent JobHistoryStore initialization from leaking `ENOENT` when a contended reclaimer disappears between pathname observation and no-follow open. The contender now retries and reports `STORE_LOCKED` for the live owner.
- Preserved valid JSONL history when torn-tail repair is interrupted after truncation.
- Prevented recovery from following a nested ancestor swapped after validation.
- Bound retained-source recovery to recorded filesystem identity instead of pathname existence.
- Terminalized committed recovery when an occupied destination fails hash verification.
- Synced staging and reservation parents after cleanup before durable completion.
- Removed quadratic durable journal rescanning exposed by the 1,000-file conservation proof.
- Added a dependency-injected `ApplicationRuntime` lifecycle abstraction for the intended main-process graph. Electron entry-point wiring remains pending.
- Fan coordinator persistence hooks out to both durable job history and per-job evidence.
- Fixed startup rollback and shutdown ordering so every acquired owner is settled even when another cleanup step fails.
- Preserved accepted blank lines when truncating a torn final journal record.
- Prevented live journal and core lock publishers from failing when a contender removes the already-published candidate alias.
- Counted a source as retained only when its captured identity remains at the source path; a replacement pathname no longer inflates conservation accounting.
- Closed every trusted-directory handle acquired before a later startup identity failure.
- Prevented live journal/core lock release quarantines from being restored by contenders as crash residue.
- Rejected multiply linked source inputs before any transaction guard can alter their link count.
- Made committed-copy recovery complete normally and made finalized failed recovery stable across repeated startups.
- Attempted every journal/core resource close and core-lock release even when an earlier close reports an error.
- Added a strict TypeScript client for the packaged native filesystem helper. It verifies the exact manifest target, protocol/build version, file identity, containment, digest, and executable mode before launching with private piped standard streams.
- Bound verified Linux execution to inherited child fd 3 and `/proc/self/fd/3`. Other platforms require an injected deny-write-delete or authenticated-package launch lease and reject a bare pathname trust claim.
- Closed the broker's identity-to-relay mutation window with an explicit shared launch-trust policy. Packaged Linux accepts only a protected root-owned system install or a protected outer AppImage plus matching read-only inherited mount; writable portable and unpacked trees fail closed. Packaged macOS and Windows require a platform-bound production attestor and otherwise refuse launch.
- Wired the packaged ExifTool adapter into that trust boundary. Packaged Linux selects the immutable system-root policy by default, packaged macOS and Windows reject missing native attestors before reading resources, explicit non-packaged runs use the development policy, and a development policy cannot enter a packaged launch.
- Prevented runtime health from executing Perl or ExifTool before package trust succeeds. Linux system installs now attest the complete packaged tools tree as root-owned, protected, and free of symbolic or special entries before any bundled process starts; a writable-root side-effect canary remains untouched on rejection.
- Bound helper operations to named roots and path components after a one-time handshake. Ambient paths, unsafe components, malformed or oversized NDJSON, duplicate/unknown keys, mismatched UUIDs, and incomplete root proofs fail closed.
- Capped broker identity capture before buffer allocation, consumed its handshake deadline only once, observed identity rejection during asynchronous lease cleanup, and required the owned broker's lifecycle close before timeout or output-limit failure can settle. Process completion now follows Node's `close` event so spawn failures cannot hang while waiting for an `exit` event Node never emits.
- Defined process-boundary uncertainty explicitly: transport failure, EOF, crash, malformed output, active abort, and abnormal shutdown reject active work as non-retryable `UNKNOWN` and never retry a mutator.
- Made helper drain/close idempotent, ordered, and bounded: reject late admission, drain queued work, send one close, end stdin, require a zero exit, and escalate only the exact helper from TERM to KILL on deadline.
- Required native filesystem-helper health alongside ExifTool before preview or processing can report ready. Runtime health now rejects missing or extra staged tools, wrong helper target/path/protocol/build metadata, unknown or duplicate manifest keys, digest or link tampering, special support-tree entries, non-executable helpers, crashes, stream failures, timeouts, oversized output, invalid UTF-8, malformed or unterminated NDJSON, wrong Rust targets, and non-exact capability reports.
- Made build-time helper probing and package directory hashing enforce the same strict protocol and special-entry rejection rules as application runtime health.
- Implemented strict helper framing, no-follow retained roots, no-replace operations, exact identity and SHA-256 checks, deterministic quarantine deletion, and explicit unknown outcomes for partial or ambiguous mutations.
- Corrected Windows helper durability access, delete sharing, root directory validation, and aligned rename buffers before native CI validation.
- Prevented Windows quarantine deletion from reporting success while open file or directory handles could still defer namespace removal.
- Prevented EOF-terminated partial JSON from executing and prevented partial directory creation from claiming `not-applied` after a durable prefix remains.
- Extended native source deletion with a caller-owned durable `deleteId`, a control-capability receipt path, and a strict `reconcile_source_delete` client method. Transport UUIDs remain internal and cannot equal the durable delete ID.
- Added typed receipt-backed delete and reconciliation results. The client rejects invalid state, quarantine, receipt, durability, or capability-relative residue combinations as non-retryable protocol `UNKNOWN`.
- Made the helper create and sync an immutable control-root delete receipt after quarantine revalidation and before unlink. Reconciliation uses that evidence to finish or confirm deletion across every crash boundary without deleting a source replacement.
- Preserved source, quarantine, and receipt objects on mismatched markers, special files, unexpected directory contents, or ambiguous absent state. Errors expose only capability-relative residue metadata.
- Rejected source and receipt namespace aliases before mutation by opening both final entries through retained parents and comparing native object IDs. Hard links plus case-insensitive, normalized, and Windows short-name aliases cannot bypass the guard. Delete-time reconciliation errors now match the strict client schema exactly.
- Added fail-closed coverage for incomplete native staging, reservation, publication, duplicate-protection, and destination-hash receipts; helper loss after durable delete intent; journal peer growth and torn first records; lock publication alias loss; quarantine replacement; guard restoration; and conservation-object alias cleanup.
- Raised the configured transaction coverage gate to a passing 92.08 percent statements, 87.22 percent branches, 94.14 percent functions, and 93.69 percent lines without lowering Jest thresholds.
- Removed verified staging guards before terminalizing source-retained delete reconciliation or post-pending cancellation. Failed exact cleanup remains nonterminal and is retried during startup recovery.
- Made concurrent transaction Core shutdown callers join one cached close promise, so none can report completion before the journal, helper, directory handles, and writer lock finish closing.
- Kept recovery guards when a committed destination is missing or unverified. Cleanup now requires both a durable delete intent and a matching committed destination, preserving the verified copy needed for restoration.
- Raised the current configured transaction coverage result to 92.30 percent statements, 87.54 percent branches, 93.75 percent functions, and 93.91 percent lines without changing thresholds.

### Validation

- Replayed the exact final tree from an empty temporary checkout: locked install, runtime staging, 44 suites and 842 tests, 89.36 percent statement coverage, 84.87 percent branch coverage, zero npm vulnerabilities, and no open-handle warning. Fresh extracted Linux packages passed containment with DEB SHA-256 `b34dced9ee7a46a741605fb01484e1e75b7d736df74a5b56529c1f4bce9c763c` and RPM SHA-256 `a90f31687c79f012d35e073435c7b492fda57cae24243fa57d565416dfe96c16`.
- Added a real staged integration test from processing IPC through metadata preview and native transactional copy. The focused composition, service, evidence, smoke, and executor grid passes 108 tests; runtime composition coverage remains above 80 percent on every metric.
- Added 171 focused client/runtime/adapter tests for schema 3 inventory, helper and broker tamper, compiled identity and signer drift, helper-hash binding, broker-only launch, packaged/development trust separation, packaged adapter policy selection, Linux ownership, symlink, writable-ancestor, AppImage mount and outer-image rejection, successful attestation sharing, failed-attestation eviction, empty-PATH relay, launch leases, strict framing, allocation bounds, handshake timeout, delayed cleanup rejection, real spawn failure, stream errors, and observed TERM-to-KILL close. Focused coverage is 90.42 percent statements, 83.38 percent branches, 93.83 percent functions, and 93.03 percent lines. Package integrity brings the reachable scoped graph to 183 passing tests.
- Proved the actual Linux x64 staged broker is static PIE, contains no dynamic interpreter, matches its manifest SHA-256, and relays protocol 1 from the compiled helper hash. Native macOS CI additionally gates immutable unlinked execution, while Windows CI gates handle exclusion, exact pre-resume termination, descendant-tree kill-on-close, and the real relay.
- Added a deterministic lock interposition test that reproduces the reclaimer `lstat` to `open` race without timing assumptions.
- Proved the prior lockfile failed clean install with `EALLOWGIT`; the regenerated lockfile installs successfully without changing global npm configuration.
- Confirmed the staged ExifTool and Perl runtime launch from package-managed paths.
- Added a tested package-integrity gate that stages ExifTool and a build-host Perl interpreter under application resources, checks version, SHA-256, containment, executable mode, native OS/architecture, loader and shared-library evidence, rejects Python artifacts and host-tool lookup, and inspects unpacked packages before installer creation.
- Removed the Python scripts directory from packaged artifacts.
- Added direct ASAR inspection so transitive Python files and missing native ABI payloads fail the release gate. The Linux package now contains zero Python ASAR entries.
- Reduced the npm audit result from 4 critical and 42 high findings to 1 critical and 40 high findings using non-major dependency corrections only.
- Added nine focused composition tests covering construction order, concrete persistence fanout, delayed and multiple sink failures, partial-start cleanup, IPC rollback, idempotent shutdown, and multiple cleanup failures.
- Removed the inert corruption-detection setting and capability from persisted config, settings, dependency health, and runtime phases; schema 2 config is atomically rewritten as schema 3 without the retired value.
- Deleted the deprecated corruption-detection transport bridge. Fourteen focused contract, IPC, coordinator, evidence, history, renderer, planner, revalidation, runtime, and integration suites pass 165 tests; current writes reject the key while explicit persisted migrations drop it.
- Made native tool staging fail closed for cross-OS, cross-architecture, or unsupported runtime inspection and removed the cross-host `dist:all` command.
- Fixed locale-dependent Perl library hashing that made a valid staged runtime fail its own application health check.
- Bound the ExifTool module tree into the staged manifest and rejected symbolic-link, hard-link, identity-drift, and support-module tampering during package and runtime validation.
- Added deterministic publication-barrier regressions for both journal and core locks, an exact blank-prefix crash test, captured-source accounting assertions, and a durable append read-count assertion.
- Added release-quarantine, hardlink-alias, mode-aware recovery, repeated-startup, and failure-complete close regressions.
- Added executable architecture gates for final source-unlink interposition and non-Linux nested recovery containment. They remain RED pending a native directory-relative conditional-mutation helper; Move remains gated.
- Added 58 focused native-client tests covering every frozen operation DTO, packaged-resource tampering, launch leases and cleanup failures, immediate post-spawn errors, a real child-process stream/error/termination path, handshake/root proof, 65,536-byte framing, malformed results, native identity/UUID enforcement, abort timing, process failures, one-request serialization, ambient-path exclusion, and shutdown ordering. Focused coverage is 89.77 percent statements, 82.53 percent branches, 87.39 percent functions, and 92.34 percent lines.
- Added 53 bundled-runtime health tests plus four staging/package admission attacks. Runtime health coverage is 90.43 percent statements, 80 percent branches, 91.93 percent functions, and 93.23 percent lines; the combined runtime/package gate passes 65 tests.
- Added 12 pinned Rust integration protocols covering framing, lifecycle, capability confinement, hostile paths, no-clobber operations, exact quarantine deletion, request-bound residue, malformed identity, partial-directory outcomes, fault cleanup, root replacement, and exact helper termination. Linux formatting, clippy with warnings denied, tests, static release probe, staging, and direct package verification pass locally.
- Added a Windows-native deletion regression that requires the request-bound quarantine name to be reusable before the helper reports success; it is compiled locally for the pinned MSVC target and runs in the configured Windows CI job.
- Expanded the native-client protocol suite to 76 focused tests for durable delete IDs, control-root receipts, source-retained and deleted reconciliation, preserved replacements, exact receipt evidence, malformed result combinations, ambient-path-free residue details, and the delete-to-reconcile error handoff.
- Expanded the native-helper runtime suite from 12 to 25 Linux integration tests. New cases cover canonical durable IDs, control-root receipt confinement, exact and alternate-name source/receipt aliases, receipt collision, source-retained cleanup, exact-entry completion with and without a receipt, replacement preservation, absent-state convergence, and fail-closed mismatched or special residue. Linux tests and clippy pass; Windows MSVC and macOS x86-64 all-target check and clippy gates pass from this host.

## [1.1.0] - 2026-03-28 00:34

### Added (Python Processing Bridge — Full Pipeline)

- Created `scripts/media_organizer.py` — headless/JSON-progress mode for the proven Python media organizer
- Created `src/main/services/PythonProcessingBridge.ts` — subprocess wrapper that spawns Python script and bridges JSON stdout into Electron IPC events
- Created `src/renderer/components/ProcessingLauncher.tsx` — new default "Organize" tab with source/dest folder pickers, live progress bar, completion summary, dependency check
- Added `checkDependencies` IPC channel (`system:checkDependencies`) — checks python3 and exiftool availability
- Added `checkDependencies` to preload bridge and ElectronAPI type definition

### Changed

- Rewired `IPCHandler.ts` to use `PythonProcessingBridge` instead of broken `ProcessingEngine`
- Rewired `main/index.ts` lifecycle (before-quit, will-quit) to use `PythonProcessingBridge`
- Replaced decorative HeroCard landing page with functional ProcessingLauncher
- Simplified `ProcessingView.tsx` to job history only (removed duplicate folder pickers and IPC listeners)
- Cleaned dead state/callbacks from `App.tsx` (selectedFolder, fileCount, handleSelectFolder, dual IPC listeners)

### Fixed

- Resolved dual IPC listener registration issue (App.tsx and ProcessingView.tsx both registered progress/complete/error listeners)

## [1.0.11] - 2026-03-27 13:45

### Changed (Neo-Noir Glass Monitor Restyle — Step 9)

- Applied Neo-Noir Glass Monitor design system across all UI components
- Added `disable-gpu-compositing` Linux flag to main process (correct flag per spec — NOT disable-gpu)
- Added `body::before` pseudo-element for rounded window shadow (replaces flat OS shadow)
- Updated body padding from 16px to 20px to match shadow inset and create float effect
- Added glass border (`rgba(255,255,255,0.03)`) and `box-shadow: none` to AppContainer
- Added `-webkit-app-region: drag` to TitleBar styled component (enables window drag)
- Added complete CSS token set: `--success`, `--warning`, `--error`, `--text-accent`, `--text-inverse`, `--radius-input`
- Fixed StatusBar left side: removed duplicate unicode dot `&#x25CF;` prefix — StatusDot component already renders the indicator dot
- Updated index.html loading screen body padding to 20px and added body::before window shadow
- Added glass border to loading screen container
- All cards already have: gradient backgrounds, glass-border, `::before` inner highlight, hover lift + shadow escalation
- Sidebar already correct: no logo section, nav items at top, teal active state
- TitleBar already correct: flat About/Settings icons, circular 28px window controls, IPC-wired
- AboutModal already correct: layered shadow, glass styling, GitHub badge, license text
- StatusBar already correct: version-only right side, status+count left

## [1.0.10] - 2026-03-27

### Fixed (Wire Audit — Step 8)

- **DuplicatesView**: Removed fake progress bar animation (`setInterval` simulating scan progress with no backend call). Replaced with honest "Feature coming soon" banner. Folder selection IPC wire (`selectDirectory`) retained.
- **BatchView**: All 4 operation cards (Batch Rename, Date Correction, Format Conversion, Tag Management) now correctly marked `$disabled` with "Coming Soon" badges. Previously Rename and Date Correction appeared interactive (hover transform, pointer cursor) but had no onClick handlers or backend connections.
- **Notification memory leak**: Added auto-dismiss `useEffect` in App.tsx — notifications with a `duration` field are now automatically removed from Redux state after their timeout expires. Previously `addNotification` was dispatched but `removeNotification` was never called, causing unbounded accumulation.
- **Dead modal state**: Removed `settings` and `jobDetails` keys from `UIState.modals` in uiSlice. `openModal('settings')` was never dispatched anywhere (TitleBar settings button uses `setActiveView('settings')` instead). `openModal('jobDetails')` was never dispatched. The `about` modal is the only one in use.
- **SettingsView dead field**: Removed `batchSize` from `LocalSettings` interface and UI. The field was stored in local state and rendered in a NumberInput but was never mapped to any config key in `saveProcessingOptions` — saves were silently dropped.

### Verified (No Dead Wires Found)

- All 22 `window.electronAPI.*` calls in renderer trace cleanly through preload → IPCHandler → backend
- All window control IPC channels (`window:minimize`, `window:maximize`, `window:close`) handled in main/index.ts setupCoreIPC
- `open-external` handler present in main/index.ts with protocol validation

## [1.0.9] - 2026-03-27

### Removed (Dead Code Cleanup)

- Deleted `LegacyMigration.ts` - exported class with no active callers (Python-era migration never triggered)
- Deleted `MenuBuilder.ts` - entire file was commented out at its only import site
- Deleted `LoadingSpinner.tsx` - component never imported anywhere in renderer
- Deleted `ErrorBoundary.tsx` - class exported but never used in index.tsx or App.tsx
- Removed `saveProfile`, `saveHistoricalJob`, `getProfiles` stub methods from DatabaseManager (only LegacyMigration called them)
- Removed `removeProgressListener` from preload/index.ts and electron.d.ts (never called from renderer)
- Removed 8 unused Redux selectors from appSlice.ts (selectApp, selectIsInitialized, selectIsLoading, selectError, selectSystemInfo, selectActiveJobsCount, selectConnectionStatus, selectSidebarCollapsed)
- Removed 8 dead exported constants from shared/constants: APP_DESCRIPTION, FILE_TYPES, VIDEO_RESOLUTIONS, PROCESSING_STATUS, JOB_TYPES, LOG_LEVELS, DATE_PATTERNS, METADATA_FIELD_MAPPINGS (defined but never imported)

## [1.0.8] - 2026-03-27

### Fixed

- GPU acceleration default aligned: settingsSlice initialState now matches ConfigManager and DEFAULT_CONFIG (both false)
- SettingsView config key mismatch: now reads/writes correct nested keys (processingOptions.maxConcurrentJobs, organizationOptions.folderStructure, etc.) instead of non-existent flat keys
- ProcessingView is now reachable from sidebar navigation (Processing tab added)
- ProcessingView wired into App.tsx renderContent switch
- Removed dead WindowManager import and instantiation from main/index.ts (window created inline)
- Removed 20 unregistered IPC channel constants from IPC_CHANNELS that had no backend handlers
- Removed duplicate web-contents-created setWindowOpenHandler registration
- Removed unconditional will-navigate preventDefault that broke dev server HMR navigation
- Fixed listener accumulation memory leak in preload: onProgress/onProcessingComplete/onProcessingError now replace previous listener before adding new one
- Fixed timer leak in DuplicatesView: setInterval is now cleared on component unmount
- Tightened CSP: removed unsafe-inline from script-src (styles still allow it for styled-components)
- DatabaseManager stub methods now log warnings instead of silently swallowing calls
- Removed 4 stale .backup.\* files from src/ tree

## [1.0.7] - 2026-03-17

### Fixed

- Fixed 7 of 8 broken IPC channels (preload/main channel name mismatches)
- Fixed SQL injection surface in DatabaseManager column name interpolation
- Fixed dialog:openDirectory cancel handling (returned undefined instead of null)
- Added 30-second timeout to all ffprobe spawn calls (prevents hanging on corrupt files)
- Fixed ErrorBoundary crash when styled-components ThemeProvider is absent
- Removed duplicate IPC handler registrations between index.ts and IPCHandler.ts

### Added

- Worker thread implementation (ProcessingWorker.ts) with webpack build pipeline
- Worker health monitoring with max 3 restarts per worker, graceful fallback
- File cache system for incremental processing (skips unchanged files on re-run)
- Processing Dashboard view with source/destination selection and job history
- Settings view with real-time config read/write via IPC
- Metadata browser view (read-only, v1.0 placeholder)
- Duplicates scanner view (v1.0 placeholder)
- Batch processing view (v1.0 placeholder)
- Redux store fully wired to UI (appSlice, jobsSlice, settingsSlice, uiSlice)
- CSP updated to allow GitHub auto-updater connections

### Removed

- Dead code: simple.ts (61 lines), themes.ts (188 lines), i18n.ts (57 lines)
- Duplicate constants file consolidated into single source
- ThemeProvider wrapper (all styles use CSS variables)
- Unused i18n module (no component used useTranslation)

### Changed

- App.tsx decomposed from 979 lines to 129 lines (7 extracted components)
- IPC channels standardized to namespace:action convention
- Preload bridge expanded with complete API surface (config, jobs, processing control)
- Constants consolidated from two files into single canonical source

## [1.0.6] - 2026-03-14 20:10:00

### Neo-Noir Glass Monitor Design System — Full Restyle

#### Renderer / UI

- `src/renderer/styles/GlobalStyles.ts` — Added complete `:root` CSS custom property token system (50+ tokens: backgrounds, typography, accents, borders, glass, gradients, layered shadows, radius, spacing, transitions). Replaced all hardcoded hex values with CSS variables.
- `src/renderer/App.tsx` — Replaced all hardcoded color/shadow values throughout every styled-component with CSS variables (`var(--*)`). Hero card now uses ambient radial-gradient mesh (`::after`). Glass card `::before` inner highlight uses `var(--glass-highlight)`. All hover shadows use layered `--shadow-card-hover`. Status bar left side uses `● Ready` dot indicator. About modal wired to `software@jasonpaulmichaels.co` and GitHub pill badge linking `sanchez314c/meta-mover`. About modal closes on X, overlay click, and Escape key. Sidebar has no logo section — nav items start at `margin-top: 4px`. Window controls are circular 28px. TitleBar controls z-index: 200, drag handle z-index: 50.
- `src/renderer/index.html` — Loading screen now uses `:root` CSS variables, matching the full token system.

#### Main Process (already compliant — verified)

- `src/main/index.ts` — `frame: false`, `transparent: true`, `backgroundColor: '#00000000'`, `hasShadow: false`, `resizable: true` confirmed. Linux flags (`enable-transparent-visuals`, `disable-gpu-compositing`, `no-sandbox`) confirmed present before `app.whenReady()`.

## [1.0.5] - 2026-03-14 17:13:14

### Forensic Code Quality Audit — Full Fix Pass

#### Security (CRITICAL)

- `src/main/services/IPCHandler.ts` — fixed path traversal validation that was a complete no-op (resolved path always starts with itself). Now checks for null bytes and verifies absolute paths
- `src/main/services/IPCHandler.ts` — added whitelist for `system:getPath` IPC channel to prevent arbitrary app path disclosure from renderer
- `src/main/services/IPCHandler.ts` — added null byte and type validation to `system:openPath` before passing path to shell
- `src/main/services/IPCHandler.ts` — moved misplaced `import { app }` from bottom of file to top-level import (was a hoisting hazard)

#### Data Safety (CRITICAL)

- `src/main/core/FileOrganizer.ts` — fixed data loss bug where `verifyFileIntegrity(file.path, finalPath)` was called after a move, reading a path that no longer exists. Now correctly validates destination size for moves vs SHA-256 comparison for copies
- `src/main/utils/FileSystemUtils.ts` — fixed cross-device move race condition: now verifies copy size matches source before deleting source. Removes bad destination copy if sizes don't match, preserving the original

#### TypeScript / Type Safety (HIGH + MEDIUM)

- `src/main/utils/JobQueue.ts` — removed broken generic `JobQueue<T>` which had 10+ type errors due to unconstrained `T`. Replaced with concrete `Job` types
- `src/main/services/ConfigManager.ts` — changed `get()`/`set()` from `any` to proper generic `K extends keyof AppConfig` signatures
- `src/main/services/DatabaseManager.ts` — added definite assignment assertion to `db` property; changed `close()` from `void` to `Promise<void>` with proper callback
- `src/main/services/DatabaseManager.ts` — added stub `saveProfile()`, `saveHistoricalJob()`, `getProfiles()` methods referenced by `LegacyMigration`
- `src/renderer/store/index.ts` — fixed slice vs reducer mismatch (`appSlice` used as reducer directly, now uses `appSlice.reducer`)
- `src/renderer/store/index.ts` — fixed listenerMiddleware type incompatibility with `as any` cast
- `src/renderer/store/slices/appSlice.ts` — exported `AppState` interface (required for declaration emit)
- `src/renderer/store/slices/jobsSlice.ts` — exported `JobsState` interface
- `src/renderer/store/slices/settingsSlice.ts` — exported `SettingsState` interface
- `src/renderer/store/slices/uiSlice.ts` — exported `UIState` interface
- `src/main/core/CorruptionDetector.ts` — added missing `[MediaType.ART]` entry in header validators map
- `src/main/core/FileOrganizer.ts` — fixed stream callback type from `Buffer` to `string | Buffer`
- `src/main/services/LegacyMigration.ts` — fixed `DuplicateHandling` string literal vs enum, `CorruptionLevel` cast, and `AppConfig` intermediate type
- `src/main/index.ts` — replaced `mainWindow!` non-null assertions in `before-quit` and `update-downloaded` dialogs with safe fallback chain
- `src/main/core/ProcessingEngine.ts` — fixed unreachable `CANCELLED` comparison with explicit cast

#### Constants / Import Fixes (HIGH)

- `src/main/core/ProcessingEngine.ts` — fixed import to use `@shared/constants/index` (full constants with `MAX_WORKER_COUNT`, processing limits)
- `src/main/core/CorruptionDetector.ts` — fixed import to use `@shared/constants/index` (full constants with `PLAYABILITY_TEST_DURATION`, `FFMPEG_PLAYABILITY_TIMEOUT`, `MIN_ACCEPTABLE_BITRATE`)
- `src/main/core/FileOrganizer.ts` — fixed import to use `@shared/constants/index`
- `src/main/core/MetadataExtractor.ts` — fixed import to use `@shared/constants/index`
- `src/main/services/LegacyMigration.ts` — fixed import to use `@shared/constants/index`

#### Media Extraction (HIGH)

- `src/main/utils/FFProbeWrapper.ts` — fixed false negatives: ffprobe writes informational messages to stderr even for valid files. Changed `if (code !== 0 || error)` to `if (code !== 0)` in both metadata methods

#### Code Quality (LOW)

- `src/main/services/ConfigManager.ts` — fixed `loadConfig()` to merge loaded config over defaults (prevents missing-key runtime errors on config version upgrades)
- `src/main/utils/TemplateEngine.ts` — replaced inline `require('fs')` with top-level `import * as fs from 'fs'`

#### Dependencies

- Ran `npm audit fix` — resolved ajv ReDoS, node-forge ASN.1, qs DoS, webpack SSRF, svgo Billion Laughs, express/body-parser issues
- Remaining vulnerabilities are build-tool-only (electron-builder, @electron/rebuild chain) and do not affect the running application

#### Verification

- `npm run typecheck` — exits 0, zero errors after all fixes
- All shell scripts pass `bash -n` syntax validation

#### Documentation

- `AUDIT_REPORT.md` — full forensic audit report written to project root

## [1.0.4] - 2026-03-14 UTC

### Repository Compliance Audit — Full Mode

#### Changed

- `src/main/index.ts` — injected Linux transparency/sandbox switches (`enable-transparent-visuals`, `disable-gpu-compositing`, `no-sandbox`) before `app.whenReady()`. Updated dev server port from 3000 to 58594
- `config/webpack.renderer.config.js` — updated devServer port from 8080 to 58594
- `.nvmrc` — updated Node version from 18 to 24
- `AGENTS.md` — synced from CLAUDE.md
- `run-source-linux.sh` — full rewrite with port management (58594/62340/63004), zombie kill, sandbox fix, port cleanup
- `run-source-mac.sh` — full rewrite with port management, zombie kill, port cleanup
- `run-source-windows.bat` — full rewrite with port management, zombie kill, port cleanup

#### Verified Compliant (no changes needed)

- `package.json` — author, scripts, GitHub URLs all correct
- `.gitignore` — all required entries present
- `archive/`, `docs/`, `resources/icons/`, `tests/`, `legacy/` — all directories exist
- `.editorconfig`, `VERSION_MAP.md` — present and valid

## [1.0.3] - 2026-03-14 UTC

### Documentation Standardization — 27-File Standard

#### Added

- `CODE_OF_CONDUCT.md` at repository root (Contributor Covenant v2.1, moved from `docs/`)
- `docs/DEPLOYMENT.md` — platform toolchain setup, artifact listing, release checklist, auto-update config
- `docs/PRD.md` — full product requirements with processing pipeline details, business rules, format list
- `docs/LEARNINGS.md` — architecture decisions, Python-to-TypeScript porting notes, known issues
- `docs/TODO.md` — UI wiring tasks, test coverage gaps, technical debt tracking

#### Changed

- `SECURITY.md` — updated supported versions (1.0.x), real contact email, documented actual security architecture (contextIsolation, InputValidator, path traversal prevention, navigation lock)
- `AGENTS.md` — complete rewrite with real codebase content: full directory map, all development commands, IPC channel reference, processing pipeline phases, key business rules
- `LICENSE` — updated copyright to "Copyright (c) 2026 Jason Paul Michaels"
- `docs/README.md` — rebuilt to index all 15 docs files with descriptions and key source file table
- `docs/FAQ.md` — rewritten with answers that reference actual code paths and real behavior
- `docs/INSTALLATION.md` — fixed all GitHub URLs (spacewelder314 → sanchez314c, META_Mover → meta-mover), fixed version (3.0 → 1.0)
- `docs/TECHSTACK.md` — fixed version header (3.0.0 → 1.0.0, September 2025 → March 2026)
- `README.md` — fixed all GitHub URLs (spacewelder314 → sanchez314c, META_Mover → meta-mover)
- `.github/ISSUE_TEMPLATE/bug_report.md` — fixed version example (3.0.0 → 1.0.0)
- `VERSION_MAP.md` — updated last-updated date

## [1.0.2] - 2026-02-08 11:39 UTC

### Repository Compliance Audit (FULL mode)

#### Changed

- **Flattened** `v1.0.01/` version folder to repository root (renamed to v1.0.0)
- **Renamed** `build-resources/` to `resources/` (standard convention)
- **Updated** all `build-resources` path references in package.json build config
- **Updated** package.json: author to "J. Michaels", GitHub URLs to sanchez314c/meta-mover
- **Updated** Electron scripts: added `--no-sandbox` to start/dev/start:prod, added `--dev` to dev script
- **Updated** .gitignore: added `legacy/`, `*.tsbuildinfo`, `dist_electron/`, `.cache/`, `.serena/cache/`
- **Consolidated** `versions/Python-Legacy/` into `legacy/Python-Legacy/`

#### Added

- `AGENTS.md` (copied from CLAUDE.md)
- `.nvmrc` (Node.js 18)
- `VERSION_MAP.md` (complete version inventory)
- `run-source-linux.sh`, `run-source-mac.sh`, `run-source-windows.bat` at project root
- `tests/` directory with `.gitkeep`
- **Documentation Suite**: ARCHITECTURE.md, BUILD_COMPILE.md, DEVELOPMENT.md, QUICK_START.md, DOCUMENTATION_INDEX.md, FAQ.md, TROUBLESHOOTING.md, WORKFLOW.md
- `archive/20260208_113948.tar.gz` (pre-audit backup)

#### Removed

- OS junk files (`._*` macOS resource forks)
- Empty `logs/` directory
- `v1.0.01/` version folder (flattened to root)
- `versions/` directory (consolidated into legacy/)

## [1.0.1] - 2026-02-08 11:43 UTC

### Added

- **Documentation Suite**: Created DEVELOPMENT.md, QUICK_START.md, and WORKFLOW.md in docs/ directory

### Changed

- Version bump: All version references changed from 3.0.0 to 1.0.0 across package.json, constants, App.tsx, FileOrganizer, ConfigManager, LegacyMigration, Logger, CLAUDE.md, CHANGELOG.md

## [1.0.0] - 2026-02-07 22:00 UTC

### Legacy Logic Port - Complete alignment with media-organizer-enhanced-v2.3.0-safe-optimized.py

#### Added

- **ART media type**: New `MediaType.ART` enum value with support for `.psd`, `.ai`, `.indd`, `.cdr`, `.dwg`, `.eps` formats (`media.ts`, `constants/index.ts`)
- **Subsecond metadata**: `subsecond` and `isScreenshot` fields on `MediaMetadata` interface (`media.ts`)
- **`artFiles` counter**: Added to `ProcessingStatistics` interface for ART media type breakdown (`media.ts`)
- **Screenshot detection**: EXIF UserComment-based iOS/macOS screenshot detection in MetadataExtractor — iOS: `UserComment == "Screenshot"`, macOS: starts with `{{` and contains `},` (CGRect pattern)
- **EXIF write-back**: `setExifCreateDateFromFilename()` in FileOrganizer — writes CreateDate + SubSecTimeOriginal back via exiftool after move, syncs filesystem mtime/atime
- **Empty directory cleanup**: `removeEmptyDirectories()` in FileOrganizer — recursive removal of empty dirs after processing (matches legacy `remove_empty_directories()`)
- **Disk space check**: `checkDiskSpace()` in FileOrganizer using `statfsSync`
- **Final sweep**: `performFinalSweep()` in ProcessingEngine — re-scans source directories for remaining files after initial pass (matches legacy `perform_final_sweep()`)
- **Worker optimization**: `optimizeCoreUsage()` in ProcessingEngine — matches legacy formula: >=12 cores: 6 workers, >=8: 5, >=4: 4, else: 2
- **Output directory exclusion**: FileDiscovery now skips directories named 'output' (case-insensitive), matching legacy `dirs[:] = [d for d in dirs if d.lower() != 'output']`
- **MPO to JPEG conversion**: FileOrganizer renames `.mpo` files to `.jpg` during organization

#### Changed

- **DateExtractor**: Complete rewrite with all legacy patterns:
  - Century correction: years 1000-1999 → last 2 digits + 2000; 100-999 → +2000; 1-99 → +2000
  - Date validation bounds: 1990-01-01 to current year Dec 31
  - 4 filename patterns: IMG/VID/PIC/PHOTO prefix, YYYY-MM-DD_HH-MM-SS, YYYYMMDD_HHMMSS, Screenshot format
  - `isAlreadyProcessed()`: Detects legacy processed filenames, rejects all-zero subseconds
  - `formatFilenameWithDate()`: YYYY-MM-DD_HH-MM-SS[.sss].ext format
- **MetadataExtractor date priority**: Now matches legacy order — MediaCreateDate > TrackCreateDate > ContentCreateDate > DateTimeOriginal > CreateDate > DateTime > DateCreated > DateTimeDigitized (was previously DateTimeOriginal-first)
- **MetadataExtractor resolution**: Video resolution now uses shorter side (orientation-aware) — `min(width, height)` for resolution category (matches legacy)
- **MetadataExtractor subsecond**: Extracts SubSecTimeOriginal/SubSecTime from EXIF data
- **MetadataExtractor century correction**: Applied to all extracted dates (EXIF, video tags, fallback)
- **FileOrganizer**: Complete rewrite with legacy organization logic:
  - Output path: `{mediaFolder}/{year}`, Screenshots → `Screenshots/{year}`, Corrupt → `corrupt/{mediaFolder}/{year}`, Error → `Error/{mediaFolder}/{year}`
  - Filename: YYYY-MM-DD_HH-MM-SS[.sss].ext with 2-digit zero-padded conflict counters (`_01`, `_02`)
  - `sanitizeFilename()`: Removes control chars, replaces `<>:"|?*`, limits to 250 chars
  - Media folder map matches legacy: image→Photos, video→Videos, audio→Audio, document→Documents, art→Art
- **CorruptionDetector VidBeast logic**:
  - Empty file (0 bytes) → immediate CATASTROPHIC
  - If video plays fine with ≤1 minor issues → clear all corruption types to NONE
  - Bitrate sanity check: < 10000 bps → MODERATE
  - Final decision: NONE/MINOR → treated as NONE (only MODERATE+ counts as corrupted)
  - Playability test: 5-second duration (was 10), 15s timeout, legacy ffmpeg arg order
- **ProcessingEngine**: Uses `optimizeCoreUsage()` for worker count and batch sizes instead of raw CPU count
- **ProcessingEngine**: Discovery now properly stats files for size and passes `excludeOutputDirs: true`
- **ProcessingEngine**: Cleanup phase now removes empty directories from source paths
- **Constants**: All format arrays updated to match legacy — added `.mpo`, `.ptx`, `.svg`, `.mpg`, `.mpeg`, `.caf`, `.amr`, `.wmf`, `.xls`, `.xlsx`, `.ppt`, `.pptx`
- **Constants**: Processing limits updated — `FFPROBE_TIMEOUT: 30`, `FFMPEG_PLAYABILITY_TIMEOUT: 15`, `EXIFTOOL_TIMEOUT: 30`, `PLAYABILITY_TEST_DURATION: 5`, `MIN_ACCEPTABLE_BITRATE: 10000`

#### Files Modified

- `src/shared/types/media.ts`
- `src/shared/constants/index.ts`
- `src/main/utils/DateExtractor.ts`
- `src/main/core/MetadataExtractor.ts`
- `src/main/core/FileOrganizer.ts`
- `src/main/core/CorruptionDetector.ts`
- `src/main/core/FileDiscovery.ts`
- `src/main/core/ProcessingEngine.ts`

## [0.9.0] - 2024-09-XX

### Added

- Initial TypeScript/React rewrite from legacy Python
- Modern Electron architecture
- Professional media organization features
- Cross-platform support (macOS, Windows, Linux)
- Redux state management
- Styled Components for UI
- Internationalization support

### Changed

- Migrated from Python legacy versions to TypeScript
- Improved performance and stability
- Enhanced user interface

### Removed

- Legacy Python implementations (kept in versions/ for reference)

## [2.0.0] - 2024-XX-XX

### Added

- Enhanced media processing capabilities
- GPU acceleration support
- Advanced metadata extraction

### Changed

- Improved file organization algorithms
- Better error handling

## [1.9.4] - 2024-XX-XX

### Fixed

- Various bug fixes in media organization
- Improved date extraction accuracy

## [1.9.0] - 2024-XX-XX

### Added

- New media formats support
- Enhanced reporting features

### Changed

- Performance optimizations

## [1.8.3] - 2024-XX-XX

### Fixed

- Critical bugs in file processing
- Memory usage improvements

## [1.8.1] - 2024-XX-XX

### Added

- Basic video processing
- Audio organization features

## [1.7.0] - 2024-XX-XX

### Added

- Initial media organization features
- Basic file moving capabilities
- Metadata extraction

### Changed

- Improved file discovery algorithms

## [1.0.0] - 2024-XX-XX

### Added

- Initial release
- Basic media file organization
- Python-based implementation

## 2026-08-30 exhaustive inventory and multi-source correction

- Stopped silently dropping unrecognized regular files. Preview now reports each as a skipped `Needs Review` row and leaves its source unchanged.
- Consolidated supported-format classification and reporting onto one duplicate-free registry.
- Added ordered, deduplicated multi-folder source selection with accessible per-folder removal controls.
- Added regressions for unsupported and extensionless files, registry parity, non-mutating unsupported planning, and exact multi-source preview requests.
- Made inventory status and nullable media kind a discriminated union, and counted unsupported rows in unresolved-date totals.

## 2026-08-30 truthful per-file terminal outcomes

- Stopped reporting jobs with failed file operations as completed.
- Added a partial terminal state for mixed results and a failed terminal with per-file statistics when every planned operation fails.
- Made processed-file counts equal committed successes in live progress, persisted history, Redux state, and terminal UI.
- Added visible succeeded, skipped, failed, and total counts plus the source path and error for every failed file.
- Made history and evidence stores reject contradictory completion statistics or failed-path counts.
- Added mixed-result, all-failure, persistence, replay, Redux, and UI regressions.

## 2026-08-30 native cross-platform runtime trust correction

- Added built-in production package attestors for macOS and Windows instead of requiring an unwired injected policy.
- Replaced the incomplete Linux Perl closure and added macOS materialization with pinned Perl 5.42.3 plus its full core library and a nine-format package probe.
- Added native x64/arm64 CI containment gates for macOS and Windows, plus exact signer binding and signed/notarized final-installer extraction checks.
- Kept platform claims evidence-bound: Linux x64 is locally proven; macOS and Windows remain gated on their native runners.

## 2026-08-30 post-mutation persistence outcome correction

- Preserved committed executor outcomes before the fallible ledger append so audit persistence failures cannot erase filesystem mutations from job totals.
- Added conserved statistics and exact failed source paths to coordinator-failed terminal events, durable history, and evidence manifests.
- Counted operations not admitted after a coordinator failure as failed without reclassifying already committed or skipped work.
- Kept the specific `HISTORY_PERSISTENCE_FAILED` terminal error code and prevented unsafe blind-retry messaging after a committed mutation.
- Relaxed failed-terminal evidence validation only for system-level failures with conserved mixed outcomes. All-file operation failures require both statistics and every failed path.
- Added regressions for a successful mutation followed by an evidence append failure, stopped-job path accounting, two-worker in-flight settlement, omitted all-file details, and durable system-failure evidence.

## 2026-08-30 cancelled Move residue truth correction

- Stopped reducing a post-commit cancelled Move to a zero-byte failure.
- Added conserved cancellation statistics for successful, skipped, failed, cancelled, and unattempted files, including committed residue bytes.
- Added exact per-file cancellation outcomes for every preview row, including conflict skips and unsupported files with no destination. Outcomes include planned bytes, committed bytes, state, retained-source status, and error.
- Added `operation-cancelled` to immutable evidence. Evidence now binds terminal outcomes to preview rows, audited operations, and ledger entries. JSONL history persists preview rows and rejects substituted paths, destinations, planned bytes, or skip states.
- Kept floating-local and date-only creation evidence valid in persisted preview rows. Rejected partial or retained-source completed Moves and required evidence terminal errors to match ledger, skipped-row, or not-attempted truth exactly.
- Rejected impossible normalized calendar dates, executable rows with null destinations, skipped outcomes that claim source removal, and partial-byte committed-destination residue. Zero-byte committed residue remains valid and explicit.
- Rejected skipped executor and evidence-ledger outcomes that claim nonzero committed bytes.
- Normalized an absent failed-operation error before ledger persistence, rejected blank optional errors on every executor outcome, and applied the same admission rule to evidence ledgers so cancellation terminal errors remain exact.
- Enforced impossible-date, full-commit-byte, and executable-target invariants at coordinator and evidence admission, before durable sinks can diverge.
- Restricted `destination-committed-source-retained` to Move operations at coordinator, evidence, and history boundaries.
- Exposed cancellation residue in durable history, Redux, the active terminal card, and job history without calling it a successful Move.
- Preserved zero-byte post-commit Move residue as an explicit committed-destination state across executor, coordinator, evidence, history, Redux, and both UIs. Unsupported rows display `(no destination)` instead of a blank target.
- Added executor, coordinator, evidence, persistence, history, Redux, and UI regressions. The focused grid passes 214 tests with open-handle detection.

# 2026-09-09

### Changed

- Preview Source and Target columns now display basenames instead of full filesystem paths.
- Proposed names retain a nonzero subsecond only when exact fractional precision is independently corroborated by authoritative embedded metadata or explicitly supplied by a user override.

### Fixed

- Prevented filename, filesystem, repeated single-family, zero-only, and conflicting fractional claims from silently controlling output names or normalized creation timestamps.
- Added explicit evidence reasons when unverified subseconds are omitted or authoritative fractional claims conflict.

# 2026-09-08

### Added

- Evidence-backed normalization audit with five fail-closed dispositions, deterministic cohorts, persisted approvals, bounded paging, stratified sampling, and planned tag dry runs.
- Hash-chained preview sealing so audit and authorization work before processing begins.
- Format-specific creation-date normalization policies and real JPEG/MOV ExifTool integration tests.
- Chunked durable job-plan storage with checkpoint recovery and a one-million-record scale protocol.

### Changed

- Metadata writes now occur only in private transaction staging and require immutable audit authorization plus verified post-write receipts.
- EXIF timestamps store local wall time with dedicated offset tags; UTC-based containers require a resolved UTC instant.
- Preview analysis runs in ordered 256-file batches, renderer previews are capped at 500 rows, and operation/evidence binding is linear instead of quadratic.
- The Metadata navigation item is now Audit and automatically follows the latest successful preview.

### Fixed

- Prevented blanket normalization of every merely resolved date.
- Prevented audit deadlock caused by requiring terminal job closure before pre-run review.
- Prevented source deletion or destination publication after unverified metadata mutation.
- Preserved legitimate GPS, timecode, history, non-date metadata, TrackCreateDate, and MediaCreateDate semantics.

## 2026-09-22 Review Queue runtime absorption

- Connected the Review Queue to the production application runtime with an owned private override store and remediation service.
- Added fixed `review:list`, `review:get`, `review:dry-run`, and `review:apply` IPC channels with strict shared request validation before service execution.
- Exposed the four operations through the sandboxed preload bridge and typed renderer API without accepting renderer-supplied filesystem paths.
- Added lifecycle, rollback, IPC validation, and preload regressions. The focused Review/runtime grid passes 73 tests; TypeScript and ESLint pass.

### Review Queue runtime follow-up

- Kept pending metadata retries and failed review transactions visible, refreshed from main-process truth, and surfaced persisted transaction errors instead of dropping those rows.
- Validated every Review service response against the shared DTO contracts before IPC returns it to the renderer.
- Replaced production review-history and audit casts with explicit typed runtime ports. Review discovery now consumes full durable history snapshots rather than renderer-safe history summaries.

### Review Queue failed-item reload correction

- Review Queue reloads durable pending and failed records, excludes terminal kept and resolved records, and surfaces a persisted failure when the row is selected.
- Added an unmount/remount regression proving a failed transaction remains discoverable after renderer recreation.

### Review Queue actionable pagination correction

- Added an exact server-side multi-status list contract so pending and failed records are filtered before cursor pagination.
- Prevented terminal records in an earlier page from causing a false empty Review Queue while actionable records exist later.

## 2026-09-22 Review catalog performance correction

- Added an atomically published, hash- and count-validated per-preview review catalog containing only unresolved audit inputs.
- Existing validated profiles derive the compact catalog once; subsequent opens validate and reuse it. Corrupt catalogs fail closed.
- Review discovery now pages the compact catalog and performs no per-row scans of the full normalization index.
- Review list pagination now joins lightweight history, catalog, and override descriptors before filesystem identity work, so a 25-row page hashes at most 25 files. Exact get and action lookup use one catalog record and one binding.
- Pinned validated review catalogs in memory with device, inode, size, mtime, and ctime identity checks. Catalog pagination now slices the single parsed snapshot without reparsing earlier pages, and post-open replacement, truncation, or mutation fails closed.
- Catalog validation now computes ordering, count, and SHA-256 from the same opened byte snapshot, removing the prior validate-then-hash race.

## 2026-09-23 audited placeholder metadata recovery

- Added a narrow GPS recovery for the exact synthetic 2022-01-01 EXIF DateTimeOriginal/CreateDate microsecond placeholder signature. A valid 2023/2024 embedded GPS UTC instant now wins; compatible Photoshop local time remains evidence but never replaces the GPS instant.
- Added a narrow editorial recovery for exact 2003-07-01 or 2022-01-01 midnight EXIF placeholders when nonmidnight Photoshop DateCreated, IPTC DateCreated+TimeCreated, and IPTC DigitalCreationDate+Time agree exactly.
- Both recoveries reject missing signature fields, out-of-window GPS values, conflicting editorial time, and extra conflicting embedded creation evidence.

## 2026-09-23 PNG screenshot and Apple AM/PM recovery

- Added native PNG screenshot-date recovery for two audited signatures: agreement among PNG CreateDate, a structured screenshot filename, and the filesystem-modified instant plus an older PNG ModifyDate/XMP DateCreated edit pair; or the exact Apple Display P3 1170x2532 screenshot signature where nonmidnight native CreateDate follows older embedded content dates and PNG ModifyDate is the known 2022 placeholder.
- Added a narrow Apple iPhone 6/6s/7 AM/PM correction requiring agreeing Photoshop/IPTC local time, an IPTC offset that exactly matches the coordinate-supported `-05:00` or `-07:00` GPS relationship, GPS UTC within 49 seconds, and EXIF/XMP creation fields exactly 12 hours earlier.
- Rejected an LA file whose IPTC time claimed `-05:00` while its coordinates and GPS instant proved `-07:00`; META Mover does not synthesize a corrected anchored value.
- Added counterexamples for altered models, missing coordinates, incompatible offsets, a 50-second GPS miss, mismatching IPTC time, and rejected PNG placeholder metadata.

## 2026-09-24 strongest timestamp selection correction

- Fixed generic date resolution selecting a lower-authority date-only candidate merely because it lacked fractional digits.
- Unsupported subseconds are now removed from the strongest candidate's value while its identity, timestamp, and audit reasons remain intact.
- Added collector-to-resolver regressions for the crashing EXIF/IPTC/filename combination, a legitimate whole-second timestamp, and date-only-only metadata.

## 2026-09-24

- Made live processing status distinguish attempted, settled, successful, and failed files.
- Added the current processing phase and file before executor work begins.
- Kept the progress percentage tied to successful commits so failures cannot falsely advance completion.
- Persisted the new progress counters with strict conservation checks and preserved the last observed attempt totals when a coordinator-wide fatal event marks remaining files as failed.
- Required attempted, settled, and failed progress counters as one atomic tuple. Legacy progress preserves known counters, and fatal or cancelled terminals conserve only observed or outcome-proven work.

## 2026-09-24 bounded transaction journal replay

- Replaced whole-file transaction journal reads with 64 KiB streaming replay from the already identity-bound file handle, removing the V8 string-length crash on the 577,797,708-byte journal.
- Preserved exact line reporting, final torn-record quarantine and truncation, valid unterminated-tail normalization, file locking, and inode protections.
- Added replay envelope validation for operation ID, transaction state, mode, and sequence. Startup sequence recovery now streams the journal without retaining every historical record.
- Added regressions for chunk, newline, and UTF-8 splits; malformed interior JSON; invalid record schema; incomplete tails; and a simulated 600 MiB journal that proves read buffers remain at or below 64 KiB.

## 2026-09-24 bounded transaction journal aggregation

- Startup recovery and outcome derivation now fold journal records directly from the bounded stream instead of first retaining every historical record in an array.
- Preserved one merged record per operation for recovery and one latest record per operation for outcome reporting while removing the duplicate full-history allocation.
- Added regressions proving both paths avoid the materializing `readRecords` API.

## 2026-09-26 automatic calendar-date audit contract

- Centralized the required audit reason triplet for every automatic resolved calendar-date-only decision.
- Preserved manual date overrides under their existing explicit override contract.
- Added resolver and immutable evidence-persistence regressions for audited narrow metadata returning date precision.

## 2026-09-26 incomplete source inventory reporting

- Continued previewing readable images when a child directory returns `EIO`, while listing each unreadable path and explaining that its file count is unknown.
- Persisted incomplete scan diagnostics in job history and the immutable preview evidence, so a completed readable subset cannot appear as a complete source scan after relaunch.
- Added a Move acknowledgment for partial scans and regressions for inventory, preview, evidence, history replay, and renderer presentation.
