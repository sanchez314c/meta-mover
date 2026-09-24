## 2026-09-23 calendar date without invented time

- Evidence validation correction: both coordinator admission and the shared Review contract now reuse `isValidDateEvidenceValue` for Gregorian `YYYY-MM-DD` validation. Impossible months, impossible month days, non-leap February 29, and year zero fail closed. Contract and coordinator tests reproduced acceptance of `2022-99-99` and `2023-02-30` before the correction.
- Regression correction: calendar-date recovery now separates imprecise evidence from reliable clock evidence. One trustworthy non-midnight embedded timestamp remains timestamp precision even when IPTC confirms only its day; date precision is selected when no trustworthy embedded time remains or when multiple trustworthy embedded times conflict and imprecise evidence confirms the shared day.
- TDD: the trusted EXIF plus same-day IPTC case and the same-day timed-conflict case both failed before the predicate correction. The resolver suite passes 103 tests afterward, including the existing midnight-placeholder case.
- Discussion: 3,000-plus review assets carry a defensible calendar day but no defensible clock time. Treating `time unknown` as `date unknown` inflated the error queue; turning midnight placeholders into `00-00-00` filenames manufactured precision.
- Decision: resolve only when at least one eligible embedded creation candidate exists and every eligible or corroboration-only embedded EXIF, XMP, or IPTC creation candidate reduces to one local calendar day. Filename, filesystem, sidecar, editorial modification, forbidden, invalid, and future claims cannot create consensus. Canon and Samsung capture candidates participate and veto through the same embedded boundary.
- Built: `date-resolution/2`; medium-confidence `YYYY-MM-DD` selection; exact audit reasons; date-only planner naming; metadata-write suppression; v1 evidence compatibility with v2 invariant validation; and manual calendar-date review input.
- MakerNote inventory: the remaining corpus contains 147 `Canon:TimeStamp` rows and 60 `Samsung:TimeStamp` rows. All 147 Canon rows were freshly reread with ExifTool and satisfy the audited EOS 5D qualifier. Samsung candidates are present in the replay and remain subject to exact instant validation.
- Reviewer correction: embedded EXIF/XMP/IPTC candidates establish consensus, but every credible eligible or corroboration-only nonfilesystem creation contender participates as a veto. A sidecar or container creation claim on another day blocks automation and remains in `contenderIds`. Filename and filesystem evidence still cannot establish consensus.
- Replay: `tools/replay-date-resolution.ts` against the refreshed candidate snapshot produces 6,262 resolved, 3,652 date-only selections, and 1,129 residue. The precision correction removes 351 prior date-only selections: 287 retain trustworthy timed resolution and 64 with conflicting trustworthy times return to review. `docs/CALENDAR_DATE_REPLAY.md` records the command, historical baseline, and current accounting. This does not claim the sub-1-percent gate.
- Contract correction: v2 automatic date-only evidence requires the consensus reason triplet. Manual calendar dates remain valid only when the selected eligible candidate is a user override with `NON_AUTHORITATIVE_SELECTION` and `RESOLVED_MEDIUM_CONFIDENCE`. The Review UI controls both manual inputs and clears the alternate value whenever the action changes.
- Final contract alignment: the shared Review guard now matches coordinator linkage checks for v2 date-only evidence. It rejects an unknown selected ID, non-eligible or zero-scored selection, invalid creation provenance, and a selected value unsupported by that exact candidate. Regressions cover each forged shape and a valid manual override.
- Validation: focused resolver, planner, normalization, executor, review contract, review service, Review UI, and evidence suites pass 269 tests. TypeScript and ESLint pass. Full validation is tracked after integration with concurrent offset and MakerNote edits. The running app was not restarted.

## 2026-09-23 audited MakerNote recovery rules

- Discussion: the remaining review corpus contains useful manufacturer metadata mixed with non-date MakerNote settings. A generic MakerNote priority would admit runtime counters, firmware dates, camera display modes, timers, and exposure settings as false capture dates.
- Decision: use two audited cohort rules only. Canon is restricted to the original EOS 5D signature where a non-midnight `Canon:TimeStamp` exactly matches `IFD0:ModifyDate` and both standard EXIF creation fields repeat the same midnight placeholder. Samsung remains capture evidence when its explicit-zone timestamp and standard EXIF agree at the whole second; differing fractional representations are disclosed and omitted from the selected value.
- TDD: collector tests cover the valid Canon signature, wrong model, mismatched modify date, non-repeated placeholders, midnight MakerNote time, and denied non-capture MakerNote tags. Resolver tests cover Canon selection, Samsung whole-second recovery, and preservation of genuine fractional conflict evidence.
- Corpus replay: all 147 Canon-tagged review assets were re-read with ExifTool; all 147 are Canon EOS 5D and satisfy the full predicate. The 7,391-row resolution replay contains 60 Samsung-tagged rows. Instant-aware review rejects two rows whose GPS UTC instant differs from Samsung. One stored row still contains the separately corrected nanosecond instant defect; current-ledger replay is 57 safe recoveries plus that known corrected row, so a fresh collector pass yields 58. Together with 147 Canon recoveries, the safe MakerNote transition count is 205 with zero unrelated transitions.
- Validation: focused collector and resolver suites, TypeScript, ESLint, Prettier, and diff checks pass. The running application was not restarted.

## 2026-09-23 exact offset and subsecond instant correction

- Discussion: explicit-offset metadata retained 4 to 9 digits in `localIso` and `fractionalDigits`, but constructed `instantUtc` through JavaScript `Date`, which serializes only milliseconds. The resolver correctly treated the two representations as inconsistent.
- Decision: keep strict instant validation and correct the collector. Compute calendar and offset rollover at whole-second precision, then append the exact source fraction unchanged to the UTC instant.
- Built `exactUtcInstant` and applied it to explicit-offset and spec-defined UTC candidates. Added collector coverage for every precision from 1 through 9 digits, positive and negative offsets, both rollover directions, and resolver coverage proving exact values pass while a one-nanosecond mismatch still fails.
- Review replay: all 7,391 review records were replayed; 579 carried the truncation defect. Exactly 287 `review-required/low` and 1 `ambiguous/none` record became `resolved/medium`; no reviewed record moved to a worse status.
- Full-ledger replay: all 99,998 resolution records were replayed. The correction affects 3,354 rows because the defect also existed in previously accepted candidates. It produces the 288 safe recoveries above and changes 32 `resolved/high` rows to `ambiguous/none` because exact fractions reveal real conflicts previously hidden by millisecond truncation. The other 3,034 rows retain their status and confidence. This is deliberate fail-closed correction, not weakened mismatch handling.
- Validation: 153 focused collector and resolver tests pass. TypeScript, ESLint, and Prettier pass. The running application was not restarted.

## 2026-09-22 Review Queue explanation correction

- User reported that the Review Queue exposed raw reason codes, opaque candidate IDs, field tags, and scores without explaining the actual problem.
- Decision: explain the conflict from the sealed evidence already available to the renderer. Resolver policy and automatic date selection remain unchanged.
- Built plain-English reason summaries, familiar metadata source labels, grouping by human-readable date/time value, weak-context warnings for filename and filesystem evidence, deduplicated messages, and a narrowly gated cautious recommendation.
- Exact underlying candidate IDs remain attached to the radio controls and are sent unchanged through dry run and apply.
- TDD covers a real two-date conflict shape, duplicate messages, exact candidate selection, midnight placeholders, missing dates, and metadata read failures.
- Reviewer correction: grouping now uses the complete parsed temporal identity rather than wall-clock text alone. Offset-only and subsecond conflicts stay separate and display their offset/fraction. EXIF labels follow the field semantic, and unrecognized future reason codes fall back to a plain-English safety explanation rather than an empty list.

## 2026-09-22 unanimous local capture recovery

- Discussion: the first replay inspected only the resolver's top-two `contenderIds` and found 60
  whole-second matches, all with fractional disagreement. That projection omitted eligible
  corroborators outside the constructed top groups.
- Decision: inspect every eligible nonfilesystem candidate. Recover only a floating EXIF
  `DateTimeOriginal` with a different embedded capture-semantic source, one unanimous non-midnight
  local second, matching date-only candidates, and no nonzero fraction. Filename lineage is
  recorded and displayed only; it is neither required nor independent corroboration.
- Built `UNANIMOUS_LOCAL_CAPTURE_RECOVERY` as a medium-confidence resolver outcome. It selects the
  EXIF original, normalizes zero-only fractions to whole seconds, and preserves every contender ID.
- Counterexamples remain ambiguous or review-only: different local clocks, nonzero fractions,
  midnight placeholders, explicit-offset originals, and weak filename-only agreement.
- Replay gate: all 99,998 durable resolutions replayed; exactly 2,265 changed from
- Reviewer correction: removed filename lineage as a predicate requirement and added exact boundary
  tests for missing lineage, midnight, nonzero fractions, date-only mismatch, missing independent
  embedded capture corroboration, and explicit-offset originals. The replay count remained 2,265,
  so the corrected predicate introduced no new ledger signature.

## 2026-09-22 Review Queue override persistence

- Decision: persist each user review result as one exact schema-versioned JSONL event with a caller supplied event ID and a sequence monotonic within its review ID. The store recomputes the contract SHA-256 review ID from job, preview, row, output path, and output hash before accepting any record. Replay exposes only the latest event for each review item.
- Built `ReviewOverrideStore.open`, `append`, `get`, `list`, and `close` with private path validation, exclusive ownership, fsync, partial-tail recovery, ambiguous-append reconciliation, poison semantics, immutable snapshots, and shared review contract validation.
- Scope remains persistence only. Runtime composition, IPC, remediation behavior, and renderer work are separate Review Queue tasks.
- Reviewer correction: close now blocks new admissions while draining accepted appends before releasing storage. Every get/list rechecks lock ownership, held/visible file identity, and exact known file size; replacement, truncation, or external append poisons reads.
- Validation: 15 focused storage tests pass. Scoped ESLint, Prettier, and diff checks pass. Whole-tree typecheck is presently blocked by the concurrently edited `ReviewRemediationService.ts` assigning `ParsedDateValue` to `JsonValue` at line 141.

## 2026-09-22 reason-specific review folders

- User requested that `_Needs Review` stop flattening every unresolved asset into one folder and retain enough structure to explain the failure class.
- Decision: preserve the existing type-first layout and route review items to `Type/_Needs Review/Placeholder Dates`, `Conflicting Dates`, `Metadata Read Failed`, or `No Usable Date`.
- Classification is deterministic from the immutable date resolution: `review-required` plus `MIDNIGHT_PLACEHOLDER_REVIEW`, `ambiguous` plus `STRONG_CONFLICT`, and `unresolved` plus `METADATA_READ_FAILED`; every other untrusted result uses `No Usable Date`.
- Review output keeps the sanitized original basename. Screenshot suffix labeling applies only when a trusted date produces a renamed output.
- Known boundary: metadata read failures currently survive as collector warning text and are not encoded as `METADATA_READ_FAILED` in `DateResolutionRecord`. The planner supports the reason code without guessing from an empty candidate set; retry/remediation plumbing must add the explicit reason before existing failures enter `Metadata Read Failed`.
- TDD: exact destination tests failed against the flat review layout, then all 33 planner tests passed after implementation. TypeScript, ESLint, and scoped Prettier checks pass.

## 2026-09-21 default window dimensions

- User requested that the live META Mover window's manually adjusted dimensions become the default without closing or restarting the application.
- Measured the visible X11 window at 1280 by 1316 and changed only the fallback used when no persisted bounds exist. Existing saved bounds remain authoritative.
- Added a runtime regression that constructs the app without saved bounds and requires a 1280 by 1316 BrowserWindow request.

## 2026-09-21 normalization audit preparation closure

- Decision: key every durable derived artifact and approval revision to both the sealed evidence revision and a canonical fingerprint of `NormalizationAuditPolicy`.
- Built: shared in-process preparation ownership across repository instances, randomized private temporary files, cleanup for legacy interrupted artifacts, and verified durable snapshot reuse before source recopy.
- Preserved: full hash-chain validation before snapshot publication and the second validation after index derivation. Concurrent callers share preparation while retaining caller-local cancellation through the existing async work context.
- Reviewer correction: derive `supported` from the actual operation target, clean every preview-scoped randomized artifact before a failed preparation rejects, serialize approvals in a process-wide queue, and canonicalize evidence/index roots before constructing shared lock keys.
- Validation: 15 focused repository tests pass, including lexical-alias concurrency, distinct concurrent approvals, interrupted and malformed recovery, cancellation cleanup and immediate retry, unsupported target classification, policy and approval invalidation, authorization binding mismatches, and 1,024-row progress cancellation. TypeScript and scoped ESLint pass.
- Final integrated gate: 55 suites and 1,085 tests pass with coverage above the project threshold, both native helpers pass formatting, linting, and protocol tests, source package integrity passes, the explicit 100,000-record scale test passes, and independent re-review returned `LGTM`.
- Dependency audit found three transitive build-tool advisories. A lockfile-only `npm audit fix` updated seven transitive packages without changing direct dependencies; complete and production-only audits now report zero vulnerabilities.

# META Mover Refit Implementation Contract

## 2026-09-12 15:42 EDT omitted-subsecond preview serialization correction

- User reported a preview error after relaunching Meta Mover with the copied test assets. The resolver's `omitSubseconds` path left an own `fractionalDigits` property set to `undefined`; the coordinator's strict JSON admission correctly rejected that non-JSON value.
- Correct the producer by omitting the optional property entirely when fractional precision is rejected. Do not weaken JSON validation, restore unverified fractions, change confidence policy, or mutate original candidate evidence.
- Changed `src/main/core/date/DateResolver.ts` and added `tests/unit/date/SubsecondSerialization.test.ts`. The regression covers absent fractions, unverified floating and explicit-offset fractions, and verified consensus through the real `MediaPlanner` and coordinator `createPreview`, including strict JSON roundtrip equality and provenance preservation. Source media, the standalone repair script, and unrelated work remain unchanged.
- TDD reproduced one failing case before the correction. The implementation agent confirmed 183 passing tests across `DateResolver`, `SubsecondSerialization`, `MediaPlanner`, and `ProcessingCoordinator`. Type checking and focused ESLint pass. The root agent's 82-test resolver coverage run reports 92.4 percent statements, 90.45 percent branches, 100 percent functions, and 96.62 percent lines.
- Read-only reproduction through production bundled ExifTool and the collector replayed the first 100 sorted supported files from the real test corpus. Four baseline cases contained the invalid undefined property; the first was operation 36, `input/Duplicates/2000-08-11_19-51-59.000038.jpeg`. The correction preserves the same whole-second selection and reason codes without media writes. This sample does not constitute a rerun of the full 100,000-file preview.
- Validation and live relaunch results are tracked separately; this entry does not claim a completed full-corpus preview or processing run.

## 2026-09-09 20:35 EDT image-format and embedded-date repair expansion

- User expanded the standalone script beyond JPEG and two EXIF fields. The manual six-ASCII-digit leading-zero conversion now covers semantic embedded date/time fractions, including EXIF modification subseconds and XMP timestamps. This supersedes the narrower standalone-script contract below.
- The script must identify actual file types, account explicitly for every scanned image, and report unsupported reading or writing capabilities rather than silently skipping image formats or claiming universal write support.
- Writes remain staged and require format-appropriate image-content and protected-metadata verification. The rule affects only eligible fractional components; it must preserve whole dates/times, offsets, trailing zeros, unrelated metadata, and filenames.
- Verification used 228 files: 221 copied real images and seven synthetic format fixtures, totaling 1,249,689,427 bytes. Independent baseline classification found 215 matching repair candidates and 13 negative/format controls. The controls were deliberately included to prove unchanged handling; not every copied file matched the six-digit rule.
- Final validation at 2026-09-09 20:55 EDT repaired all 215 matching candidates, making 666 fractional-field changes, while leaving all 13 controls untouched. All 215 original backups match exactly. A second dry-run found zero candidates: 224 unchanged images, three warning outcomes, one explicit unsupported BMP, and 215 separately identified backup artifacts.
- Successful repair cases were 199 JPEG, nine DNG, two HEIC, one PNG, one TIFF, one animated WebP, one animated GIF, and one AVIF: 209 real matching files plus six matching synthetic fixtures. The 13 untouched controls comprise nine files without targets, three WebP files with pre-existing warnings and no targets, and one unsupported BMP. Evidence is retained at `/media/heathen-admin/RAID/Media/Pictures/Photos/.subsecond-all-images-test-IVmExN/VERIFICATION.md`.
- All 228 original source SHA-256 hashes and modification timestamps remain unchanged. Independent comparison preserved all 269 decoded frames/pages, DNG/TIFF raw strip and tile bytes, group-qualified embedded previews and `OtherImage` bytes, and every protected metadata value. No normal-app behavior or full-library data was changed.
- The final suite passes 42 tests independently under primary and reviewer execution, with 85 percent combined coverage (main script 87 percent; format-integrity helper 80 percent). Independent review returned `SHIP`, including the structural-integrity changes.
- Eight-worker apply took 33.307 seconds on the cached sample; the second dry-run took 6.227 seconds. These are copied-sample results, not a cold-RAID or full-library throughput claim. Format capability remains explicit rather than a promise that every image format supports safe metadata rewriting.

## 2026-09-09 20:21 EDT explicit six-digit subsecond override

- User replaced the earlier corroboration policy for the standalone repair script with a manual rule: inspect existing EXIF `SubSecTimeOriginal` and `SubSecTimeDigitized` independently; when a value contains exactly six ASCII digits, remove its leading zeros. An all-zero value becomes `0`, and trailing zeros remain intact.
- This override requires no confidence score, matching date, or corroboration from another metadata field. It is a user-directed historical conversion, not a general rule that leading zeros are invalid.
- Other metadata fields and filenames remain unchanged. No normal-app behavior or full-library operation is authorized by this revision.
- Final copied-image validation at 2026-09-09 20:26 EDT used 200 fresh source-exact copies (198 JPEG and two HEIC, 966,314,203 bytes) in `/media/heathen-admin/RAID/Media/Pictures/Photos/.subsecond-manual-test-QX8BVD/input`. The script repaired 194 files, refused four pre-existing `IPTCDigest` warnings, and excluded two HEIC files.
- All 388 changed Original/Digitized fractional values independently match the manual rule. The three discussed examples changed `000065` to `65`, `000093` to `93`, and `000016` to `16` in both tags. Generic `SubSecTime`, filenames, and all protected metadata values remained unchanged.
- Verification preserved all 200 original source SHA-256 hashes and modification timestamps, decoded pixels/frames, thumbnail hashes, and embedded `PreviewImage`/`MPImage2`/`MPImage3` bytes. All 194 original backups match exactly. Metadata block relocation offsets are validated through unchanged embedded-image bytes rather than incorrectly requiring old byte positions after a rewrite.
- A second dry-run reported 194 unchanged files, the same four warning refusals, two excluded HEIC, and zero candidates. Eight-worker apply took 3.158 seconds; initial and repeat warm-cache dry-runs took 0.609 and 0.883 seconds. These sample timings are not a full-library estimate.
- The revised suite passes 21 Python tests with 84 percent branch-inclusive script coverage; changed classification and relocation-pointer handling are fully covered. Independent review returned `SHIP`. Corpus verification and reports remain beside the input as `VERIFICATION.md`, `verify_corpus.py`, and run reports. Only copied test files were modified.

## 2026-09-09 20:11 EDT standalone legacy subsecond repair

- User requested a fast Python script for a roughly 900,000-image library on spinning RAID, with parallel workers and a trial on copied images. Scope is `tools/repair_subsecond_padding.py` and its tests/documentation, with no companion app or organizer integration.
- The repair contract targets evidence-supported six-digit left padding from the legacy formatter. Leading zeros alone never authorize a correction. Surviving embedded fractional evidence must support the replacement at the same date and whole second; uncertain and conflicting cases remain untouched.
- Execution uses a configurable thread pool, persistent ExifTool processes, bounded streaming admission, and progress reporting. Dry-run is the default. Metadata writes require explicit apply mode and per-file verification.
- Current run authorization is limited to gathering test copies into a temporary input folder, running the repair against those copies, and verifying the result. Applying to the full original library is not authorized by this trial.
- Validation completed at 2026-09-09 20:15 EDT: all 20 Python tests pass and independent review returned `SHIP`.
- Real-media trial used 200 copies (198 JPEG and 2 HEIC) under `/media/heathen-admin/RAID/Media/Pictures/Photos/.subsecond-repair-test-8sfbox`: 48 repaired, 146 uncertain and preserved, four refused because of pre-existing `IPTCDigest` warnings, and two HEIC skipped. A second run found zero repair candidates.
- Independent verification found every original source SHA-256 and modification timestamp unchanged across all 200 files. Decoded pixels/frames and thumbnail hashes remained unchanged, protected metadata had zero differences, and all 48 original backups matched exactly. Only test copies were modified; the roughly 900,000-image library was not repaired.
- Eight-worker apply took 1.507 seconds on this copied sample. Warm-cache scan comparisons measured 0.928 seconds with four workers, 0.589 with eight, and 0.596 with sixteen. These small-sample measurements do not establish cold-cache RAID throughput or a full-library completion estimate.

## 2026-09-09 filename-only preview and conservative subsecond qualification

- User requested that preview Source and Target cells show only the original basename and proposed basename. Full paths remain in immutable evidence but are absent from the preview table.
- User clarified that a stored or filename-encoded fraction is not automatically correct. Fractional precision may affect a proposed name only when the same nonzero fraction is corroborated across at least two authoritative embedded source kinds, or when it is an explicit user override.
- Filename and filesystem fractions remain evidence but cannot authorize subsecond naming. Repeated tags inside one metadata family are not independent corroboration. Zero-only fractions add no precision and are ignored.
- Unverified fractions are deterministically omitted from the selected whole-second value and labeled `UNVERIFIED_SUBSECONDS_OMITTED`. Conflicting authoritative fractions are additionally labeled `SUBSECOND_CONFLICT`. The original candidate values remain unchanged in the evidence ledger.
- Live 15,000-file evidence motivated the fail-closed rule: 2,150 selected resolutions carried fractions, only 54 matched the conservative independent-embedded rule, 1,229 rows contained conflicting authoritative fractions, and 11,842 rows had fractions only in filename/filesystem evidence.

## 2026-09-08 evidence-gated metadata normalization and mass audit

- User required a safe mass workflow for terabyte-scale libraries: infer the most credible original date from all available evidence, preserve legitimate timeline fields, allow optional manual sampling, and approve safe groups in bulk.
- Date resolution now rejects timezone-collapsing merges, placeholder-midnight shortcuts, filename-only high confidence, and isolated ancient outliers. Conflicted authoritative originals are capped below automatic normalization.
- Destination metadata mutation is format-scoped and creation-only. It runs in private transaction staging, requires a concrete verified receipt, preserves sources on failure, writes EXIF offsets to companion tags, and refuses to invent a UTC QuickTime instant from floating local time.
- A hash-chained `preview-sealed` boundary makes the audit available before processing without weakening terminal job evidence. Audit authorization is bound to the exact preview operation, paths, and date resolution. Only automatic-safe rows and explicitly approved immutable cohorts can be normalized.
- The Audit UI loads the latest preview automatically, pages cohorts/evidence, builds reproducible stratified samples, opens source files for manual inspection, persists cohort approvals, and displays planned per-tag assignments. Dry-run existing values are explicitly identified as preview evidence, not a fresh metadata read.
- Large previews analyze metadata in ordered 256-file batches, cap renderer transport at 500 rows, eliminate the quadratic operation-to-decision join, and avoid a second full-plan serialization. The durable `JobPlanStore` adds chunked plans, atomic checkpoints, compact terminal state, torn-tail recovery, and million-record validation for the next source-of-truth migration.
- Real system ExifTool validation now covers JPEG EXIF offset tags and QuickTime creation tags in addition to mocked process-boundary tests.

## 2026-09-06 integrated random test runs

- User requested the prior random 15,000-file sampler inside the app, then reported that the UI had no visible Test Mode. Settings now has a persisted, default-off Test Mode toggle. When enabled, Organize displays a persistent TEST MODE warning and replaces normal preview with one `Gather & Build Test Preview` action.
- Originals are never passed to processing. Sampling uses a bounded reservoir, excludes earlier `META-Mover-Test-Run-*` directories, preserves relative paths, and copies through eight bounded workers into META Mover's private OS temporary root.
- A completed job discards only its app-owned corpus. Failure or cancellation retains the corpus and its visible path. IPC rejects malformed counts, noncanonical source paths, and cleanup outside the owned root.
- RED tests cover exact sampling, undersized sources, prior-corpus exclusion, IPC admission and cleanup, and renderer handoff into preview.
- User reported the live gather was far too slow and exposed no progress. The first run confirmed 6,481 of 15,000 files and 12 GB copied into `/tmp` before the exact app process was stopped.
- Corrected staging to an app-owned sibling of the selected destination so same-filesystem copy-on-write cloning can operate. Copy now attempts forced cloning first, falls back only for unsupported clone errors, caches directory creation across eight workers, and never stages on the system disk by default.
- Added throttled scan and copy progress events with scanned, selected, copied, total, percentage, phase, and current relative filename. Organize renders determinate copy progress, indeterminate scan progress, current filename, and Stop Test Run.
- The live 15,000-file test exposed a persistence rejection after successful gathering and preview analysis. The planner counted unsupported rows as unresolved, while the evidence validator counted only rows carrying the exact `Creation date requires review` warning. This made a valid mixed-format corpus fail summary conservation.
- Corrected the evidence invariant to count either explicit `UNRESOLVED` date evidence or the planner needs-review marker. Added a regression using the planner-shaped unsupported row without the unrelated marker. Persistence fanout errors now retain the nested sink message, which exposed the exact fault instead of reporting only `evidence`.
- User completed the 15,000-file preview, changed the operation from Copy to Move, then received `PREVIEW_EXPIRED` followed by the false `PREVIEW_CONSUMED`. Durable history showed the preview completed at 17:46 and the setting changed at 20:12; production allowed only 15 minutes.
- Raised the default preview lifetime to 24 hours while preserving mandatory start-time source and configuration revalidation. Expiry no longer mutates the preview into a consumed state.
- Processing-setting changes now rebuild the immutable preview automatically from the current selected source. Test Mode reuses the retained temporary corpus and exposes `Rebuild Test Preview`; it does not gather or copy another 15,000 files. Expired, drifted, or consumed start responses also trigger this rebuild path.
- After relaunch, selecting an existing `.meta-mover-test-runs/run-*/source` path is recognized as a retained corpus and exposes the same rebuild action without gathering. It is deliberately not adopted for automatic deletion because corpus ownership did not survive the process boundary.
- A live 15,000-file rebuild reached 100 percent and then appeared frozen for roughly eight minutes. Process I/O proved the evidence manifest was still growing; it reached 223 MB while `EvidenceManifest.writeEvent` performed one append, `fsync`, and two four-call identity sweeps for every file, candidate, resolution, and planned operation.
- Added bounded `appendBatch` support with one held-handle write, one `fsync`, and identity checks around at most 256 canonical hash-chained events. Only initial preview evidence uses batching. Operation ledger, rejection, and terminal evidence keep their existing per-event durability boundary.

## 2026-09-04 optional month subfolders

- User requested control over month subfolder creation. The existing canonical folder-structure setting now accepts `year`: resolved assets target `Type/Year/Filename` instead of `Type/Year/Month/Filename`.
- `year/month` remains the safe default. Existing `year-month` and `flat` behavior is unchanged. The Settings view exposes the new year-only choice, and the same value crosses persisted configuration, preview options, immutable evidence, and execution.
- TDD covers planner output, configuration persistence, and Settings UI transport.

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
6. Processing never writes metadata into source media. Destination date normalization is explicit, disabled by default, limited to resolved dates, and reported as failed committed residue if ExifTool cannot complete it. Evidence remains immutable; decisions and provenance live in a sidecar run manifest and job history.
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
- Keep filesystem modification time outside creation-date selection. Filesystem birth time may remain visible as weak provenance, but it cannot resolve or rename a file by itself.

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

## 2026-09-03 creation-date inference restoration

- User reported that a preview of `/media/heathen-admin/RAID/Media/Pictures/Photos/images` appeared to mark every file unresolved and directed inspection of the repository archives to recover Meta Mover's original purpose: infer the most likely original creation date from filenames and embedded metadata.
- Replayed the saved preview evidence instead of guessing from the UI. The original run contained 3,122 files: 1,056 resolved and 2,066 routed to ambiguous, review-required, or unresolved outcomes. UUID names sorted first made the problem appear universal.
- Unpacked and compared the 2025-08-23, 2026-03-27, and 2026-08-29 archives. The older programs searched more filename and metadata fields, but they also fabricated certainty from filesystem modification time and even current time. Restored the useful inference logic without restoring those unsafe fallbacks.
- Corrected the resolver's offset mismatch rule. Matching local capture clocks now corroborate whether or not every source carries an offset. If both local time and UTC evidence exist, the group retains both and selects the strongest explicit offset. A precision-aware coherence check prevents minute-only evidence from merging two different seconds.
- Added whole-second consensus handling for inconsistent fractional encodings. It applies only when the leading result has independent corroboration. Two unsupported high-precision claims that differ still remain ambiguous.
- Corrected ExifTool family-1 mapping for `TrackN:MediaCreateDate`, `TrackN:TrackCreateDate`, `QuickTime:CreateDate`, `XMP-exif:DateTimeOriginal`, `XMP-xmp:CreateDate`, `XMP-pdf:CreationDate`, `UserData:DateTimeOriginal`, `ItemList:ContentCreateDate`, `Samsung:TimeStamp`, GPS date and time, IPTC digital creation date and time, and PNG creation metadata. The final tag census found XMP PDF creation data in 272 files; all 272 agree with another creation source and none rely on it alone, so it is retained as corroborative evidence without outranking capture metadata.
- Restored bounded filename patterns from the archived implementations: screenshot timestamps, contiguous and separated full timestamps, camera-prefixed forms, and explicit date-only camera names. Rejected a UUID-shaped numeric counterexample rather than treating any eight digits as a date.
- Raised full timestamp filenames to medium confidence. Date-only camera names resolve only to calendar precision. Filesystem birth remains low-confidence corroboration; filesystem modification time, current time, metadata modification dates, and ICC profile dates cannot become capture truth.
- TDD added regression coverage for the real tag names, offset/floating corroboration, UTC bridges, GPS scoring, fractional conflicts, legacy filename forms, and numeric UUID rejection before or alongside each correction.
- Ran the production preview path across all 170,758,083,677 bytes and 3,122 files with verified read-only snapshots. Analysis reached 100 percent without source or destination mutation. A separate full-batch decision census through the same bundled ExifTool and corrected collector/resolver produced 1,958 resolved, 82 ambiguous, 1,082 unresolved, and zero review-required files.
- The 82 ambiguous files contain actual disagreement: 46 cross calendar dates and 36 materially different times on the same day. The 1,082 unresolved files have no accepted creation metadata or bounded filename date. The old mtime/current-time fallback would assign invented dates to those files and remains rejected.
- No dependency was added. The already-running Electron process was not stopped or restarted and still has the older bundle loaded until the User explicitly authorizes relaunch.
- Final validation passes 46 suites and 898 tests. Coverage is 89.40 percent statements, 84.83 percent branches, 91.62 percent functions, and 91.41 percent lines. Strict type checking, ESLint, Prettier, source containment, production main/preload/renderer builds, staged-tool containment, and diff checks pass.

## 2026-09-04 metadata-only video preview and opt-in date normalization

- User reported that large video files remained extremely slow during preview and requested the prior destination metadata reset as a setting.
- Root cause: preview copied every source into temporary storage, hashed the entire source during that copy, hashed the snapshot again, streamed every snapshot byte through ExifTool while hashing it a third time, then rehashed at approval. Large video preview therefore performed several complete reads plus a complete temporary write even though no frames were decoded.
- Replaced preview snapshots with a held, no-follow source descriptor. Linux gives bundled ExifTool the seekable `/proc/<application-pid>/fd/<descriptor>` path, binding extraction to the inventoried inode without copying or streaming the complete file. Portable paths use direct seekable extraction with before-and-after identity validation.
- Removed preview-time SHA-256 and temporary-space admission. The transaction core still performs one complete SHA-256 during an approved copy or move, where integrity verification belongs. Existing saved previews that contain a SHA-256 remain compatible with revalidation.
- Preserved adaptive parallel admission and the 80 percent host CPU ceiling. File size no longer reduces metadata-analysis concurrency because preview no longer duplicates the file.
- Added `processing.writeMetadataDates`, disabled by default, to config, Settings, renderer request construction, IPC validation, coordinator execution context, runtime health, and production composition.
- After a successful approved copy or move with a resolved date, the option runs bundled ExifTool only against the committed destination. It removes writable date/time tags while excluding filesystem timestamps from deletion, writes standard image fields from the selected local value, writes video container, track, and media fields from the selected UTC instant when one exists, resets filesystem modification time, and preserves non-date metadata. Sources and unresolved files are never modified.
- A writeback failure is recorded as failed committed-destination residue. The app does not claim full success after bytes were committed but metadata normalization failed.
- TDD began with 36 expected failures across 10 suites. The focused gate passes 223 tests. The complete gate passes 46 suites and 908 tests. TypeScript, ESLint, Prettier, and diff checks pass.
- Real-media proof used the exact held-descriptor path on a 7,637,578,064-byte MP4. Bundled ExifTool completed in 0.25 seconds with seek/read syscalls only and no output writes. A disposable JPEG proved stale dates were removed, the selected date reached `ModifyDate`, `DateTimeOriginal`, `CreateDate`, and filesystem modification time, and image dimensions remained intact.
- No dependency was added. ExifTool and Perl remain contained in the application resources.
- Production main, preload, and renderer bundles compiled successfully and package containment passed. The original source checkout launched under isolated profile `/tmp/meta-mover-source-live/profile` as PID 3342284. Runtime logs report canonical startup, the X11 window is present, Settings visibly shows the new unchecked option, and the organizer reports `Runtime ready. Preview is available.`

## 2026-09-04 filesystem date fallback restoration, retracted

- This change was wrong and has been removed. It treated filesystem modification time as an automatic rename source despite that timestamp recording file mutation rather than media creation.

- User reran `/media/heathen-admin/RAID/Media/Pictures/Photos/images` and showed that UUID-named media still received `INSUFFICIENT_CONFIDENCE`, a null selected date, and `_Needs Review` targets.
- Reproduced the failure on the exact files shown. Their UUID names contain no date, and representative JPEG and PNG files contain no accepted capture timestamp. The resolver received only filesystem birth time, scored it below its selection threshold, and returned no result.
- Reopened the archived Python implementation. Its operative hierarchy is creation metadata, then filename extraction, then `os.path.getmtime()` as the final date. The prior refit intentionally removed that last step, which contradicted Meta Mover's required best-available behavior.
- Added inventoried filesystem modified time as a distinct candidate. It cannot outrank embedded creation metadata or a valid filename timestamp, cannot corroborate itself into higher confidence, and is selected only as `resolved / low` with `filesystem-modified` provenance and `FILESYSTEM_MODIFIED_FALLBACK` evidence.
- Low-confidence resolved fallback dates now generate the normal year/month and timestamped filename target. Conflicting claims, filesystem change time, current time, metadata modification tags, and files with no valid timestamp still fail closed.
- TDD reproduced failures in candidate collection, resolver selection, preview plumbing, and target planning before implementation. Reviewer counterexamples then reproduced weak metadata displaced by mtime, embedded metadata displaced by a filename, spoofed mtime provenance, and forged low-fallback records hiding stronger evidence before each boundary was corrected.
- A live read-only proof ran the corrected collector, resolver, and planner against the first 12 exact files in the reported directory. All 12 produced `resolved / low` dated targets, none entered `_Needs Review`, and three metadata-confirmed screenshots also received `-screen-shot`.
- No dependency was added. Preview remains metadata-only and does not hash, copy, decode, or scan frames from media payloads.
- Final focused validation passes 3 suites and 104 tests. The complete suite passes 46 suites and 915 tests. The latest coverage gate passes at 89.52 percent statements, 84.94 percent branches, 91.67 percent functions, and 91.53 percent lines. TypeScript, ESLint, Prettier, and diff checks pass. Independent adversarial review returned LGTM.
- Rebuilt the production main, preload, and renderer bundles, passed package integrity, stopped only the prior source process tree, and launched the corrected checkout under the isolated source profile. The active Electron main process is PID 3391227, its renderer points at this repository, and the visible X11 window is titled `Meta Mover`.

## 2026-09-04 creation-date contract correction and legacy extraction audit

- User rejected filesystem modification time as creation evidence and required preservation of the original program's metadata extraction core. The automatic `filesystem-modified` selection was removed from candidate collection, resolution, planning, preview, and saved-evidence validation.
- Compared the date logic across v1.7, v1.9.4, v2.2, v2.3, the January and August TypeScript implementations, and v4.1. Valid legacy sources include original and digitized EXIF dates, media, track, content and container creation dates, XMP and IPTC creation dates, GPS date-time, audio recording dates, subseconds, offsets, and camera, screenshot, social, and processed filename patterns.
- Preserved the valid historical union in the active collector and retained the newer provenance, timezone, precision, corroboration, ambiguity, and malformed-value checks. Historical `FileModifyDate`, metadata modification dates, current-time fallbacks, ICC profile dates, and first-match `time:all` behavior remain excluded because they are not defensible creation claims.
- Raw ExifTool 13.59 output for the exact UUID JPEG, PNG, and WebP files visible in the User's screenshot contained only filesystem times. One PNG also contained an ICC profile build date. None contained an embedded capture or creation timestamp, so the correct result for those files is unresolved with the original basename under `_Needs Review`.
- Regression tests cover both ExifTool and synthetic filesystem-modification claims at the resolver boundary, absence of mtime candidate collection, absence of mtime preview plumbing, rejection of low-confidence resolved evidence records, and review routing. One shared provenance rule now protects resolver, planner, and immutable-evidence admission from forged high- or medium-confidence filesystem modification selections, relabeled metadata/profile dates, forbidden source families, non-eligible selections, and zero-scored selections. Filename candidates must use the collector-owned `filename:` tag namespace, preventing filesystem tags from being relabeled as filename evidence. Planner naming also requires the selected value to exactly match the selected candidate. Filename text is kept separate from metadata tag policy, so a legitimate timestamped basename containing `ModifyDate` still resolves. Characterization coverage explicitly includes legacy DSC, WhatsApp, Live Photo, burst, Instagram, and Pixel filename forms.
- A live read-only run through the active collector, resolver, and planner against five exact UUID files from the screenshot produced only filesystem-birth candidates, no filesystem-modified candidates, unresolved status, and original-basename `_Needs Review` targets for all five.
- Final validation passes 46 suites and 941 tests. Coverage is 89.45 percent statements, 85.08 percent branches, 91.60 percent functions, and 91.47 percent lines. Strict type checking, ESLint, Prettier, diff checks, production main/preload/renderer builds, and package integrity pass. Active source and production bundles contain no mtime fallback marker.
- Independent final review attacked relabeled filesystem tags, filename namespace spoofing, selected-value substitution, false positives inside legitimate basenames, and the review-only filesystem-birth path. Every counterexample is covered and the final verdict is `DONE` with no remaining concern.
- The previously launched source process had already exited when replacement began, so no stale PID remained to terminate. The corrected checkout now runs as Electron main PID 3535493 with renderer PID 3535616 under private isolated profile `/tmp/meta-mover-source-live-20260904-1942/profile`. Its visible X11 window is titled `Meta Mover`, the renderer identifies this exact repository with sandboxing enabled, and the separate refit process remains untouched.

## 2026-09-04 conflict-resolution correction from the live 3,122-file ledger

- User reran `/media/heathen-admin/RAID/Media/Pictures/Photos/images` and reported over 1,000 unresolved files. The 34 MB evidence ledger from that run (`/tmp/meta-mover-source-live-20260904-1942/profile/evidence/`) was replayed record by record through `resolveDateCandidates` instead of guessing from synthetic fixtures.
- Ledger totals: 1,731 resolved high, 227 resolved medium, 82 ambiguous, 1,082 unresolved.
- The 1,082 unresolved files carry exactly one candidate each, `FileSystem:BirthTime` (2026-09-03, the copy into the folder). Bundled ExifTool confirms they hold no embedded creation claim: 496 are xAI/Grok downloads (`IFD0:Artist` is the public asset UUID, `ImageDescription` is a signature), about 295 are stripped iOS screenshots (`UserComment` = `Screenshot`), and the rest carry only ICC profile dates. Every one has filesystem modification time 2026-03-27, a bulk export, which the User has already rejected as a creation date. No local source can date these files; `_Needs Review` is the correct output for them under the current contract.
- The 82 ambiguous files exposed two resolver defects. First, `STRONG_CONFLICT` fired between groups that were the same UTC instant rendered in different zones: `Keys:CreationDate` with an explicit offset versus UTC container and track dates plus a UTC-rendered filename. Second, it fired when a corroborated EXIF `DateTimeOriginal` (or QuickTime Keys / UserData original) was contradicted by a later IPTC or XMP editorial date or a later container date.
- Correction in `src/main/core/date/DateResolver.ts`: `groupsShareInstant` neutralizes a contender whose instant-bearing candidates all agree with the selected instant (`SAME_INSTANT_CONTENDER`, lead treated as 15, high confidence remains reachable). `topHoldsAuthoritativeOriginal` neutralizes a contender when the top group is corroborated by an independent family and its best candidate has base score 94 or higher and strictly above the contender's best base (`AUTHORITATIVE_ORIGINAL_PREFERRED`, lead treated as 10, so the result is capped at medium confidence because a real conflicting claim still exists). Uncorroborated conflicts and equal-authority conflicts remain ambiguous.
- TDD: three new resolver tests. Two reproduced red against the pre-fix resolver (same-instant Keys video, EXIF original versus IPTC editorial) and one guards that an uncorroborated Keys capture time days away from the container instant stays ambiguous. Focused suite: 64/64.
- Replay of the full ledger with the corrected resolver: 1,741 high, 277 medium, 22 ambiguous, 1,082 unresolved. 60 of 82 ambiguous files resolved (10 same-instant at high, 50 authoritative-original at medium). The 22 that remain are genuine conflicts: cameras stamped 1998-02-09 06:49:00 against 2025/2026 filenames, and Keys capture times days earlier than the container.
- Open decision for the User, not implemented: the 496 xAI files can be dated from the provider. `HEAD https://imagine-public.x.ai/imagine-public/images/<Artist UUID>.jpg` returns `Last-Modified` equal to the generation time (February to March 2026) and the same bytes (20 of 20 sampled). This adds a network call to a local tool, so it needs approval before it becomes an opt-in setting with its own `provider-asset-date` provenance.
- User then flagged the resolved values ending in `00-00-00` as suspicious. Confirmed from the ledger: the existing run had already resolved 78 files at exactly midnight with high confidence, 38 on 2022-01-01, 30 on 2022-12-12, 4 on 2015-10-18. These are placeholder stamps written into EXIF/QuickTime by an earlier bulk tool. The filenames of 1,975 of the 3,122 files are in Meta Mover's own `YYYY-MM-DD_HH-MM-SS[.ffffff][_NN]` output format, so a filename agreeing with the metadata is derived from it, not independent corroboration.
- Added `MIDNIGHT_PLACEHOLDER` (-25) for any non-filesystem candidate whose wall clock is exactly 00:00:00 while claiming second-or-finer precision. Date-only claims are untouched. A placeholder candidate cannot trigger `AUTHORITATIVE_ORIGINAL_PREFERRED`, and when the selected candidate is a placeholder the record is downgraded to `review-required` with `MIDNIGHT_PLACEHOLDER_REVIEW`, so the file lands in `_Needs Review` with its date still shown.
- TDD: three more resolver tests (placeholder plus derived filename routes to review; a real editorial timestamp beats a placeholder original; a genuine date-only claim is not double-penalized). Two reproduced red first. One pre-existing fixture used an incidental midnight value and was moved to 10:20:30. Focused suite: 67/67.
- Final replay of the 3,122-file ledger: 1,663 high, 273 medium, 76 review-required (all midnight placeholders), 28 ambiguous, 1,082 unresolved. Net against the User's run: 54 ambiguous files resolved, 76 falsely confident placeholder dates pulled back to review, 2 placeholder picks replaced by real IPTC/XMP dates.
- Not changed, for User decision: whether filenames in Meta Mover's own output format should stop counting as an independent corroboration family. That affects confidence on roughly two thirds of the corpus (mostly high to medium for container-only videos) and is a policy change, not a bug.
- Final validation: 46 suites, 947 tests, coverage 89.65 percent statements, 85.37 percent branches, 91.80 percent functions, 91.58 percent lines. TypeScript, ESLint, Prettier pass. Dev bundles rebuilt; `dist/main` contains the new reason codes.
- Stopped only the superseded source process (PIDs 3535478 and 3535493). Relaunched the corrected checkout on the same isolated profile `/tmp/meta-mover-source-live-20260904-1942/profile` so settings persist. Electron main PID 3587868, renderer PID 3588008, X11 window `Meta Mover` present, runtime log reports canonical startup.

## 2026-09-04 Move setting ignored by the Organize view

- User set Default operation to Move in Settings, but the Organize view offered `Start Copy` and the job copied. Profile `config.json` was saved with `operation: move` at 20:57:43 local; the preview recorded at 20:58:51 carried `operation: copy`.
- Root cause: `App.tsx` keeps `ProcessingLauncher` mounted and hidden across views, and the launcher loaded settings once into local state at mount. `SettingsView` saves through IPC into its own local state, so nothing updated the launcher's copy. Every preview after a settings change used the startup snapshot.
- Correction in `src/renderer/components/ProcessingLauncher.tsx`: `buildPreview` now calls `getConfig` first, stores the result, and plans from it. A failed reload surfaces as an action error and returns to the selection stage instead of planning from stale options.
- TDD: new launcher test seeds `getConfig` with copy at startup and move afterward, then asserts the preview request carries `operation: move` and the button reads `Start Move`. It failed red with `operation: copy` before the fix. The rapid double-activation test now waits for the asynchronous request before asserting exactly one call. Launcher suite 15/15.
- The cancelled copy job (802 of 3,122 files) left copies under `metamover output`; sources were not touched because the job was a copy.
- Validation: 46 suites, 948 tests, coverage 89.65 / 85.37 / 91.80 / 91.58. TypeScript, ESLint, Prettier pass. Dev bundles rebuilt.
- The prior source process had already exited at 21:05:13 (shutdown logged with failures right after the User cancelled the copy job; the output folder was emptied at 21:05:20, after exit, so that was manual cleanup, not a rollback). Relaunched on the same profile: Electron main PID 3624782, renderer PID 3624883, window `Meta Mover` present. Saved settings still carry `operation: move`.

## 2026-09-04 media-type top-level output folders

- User: output must be grouped by type at the destination root (images, videos, audio, and so on) before the date folders.
- The pre-refit source carried this mapping (`Photos`, `Videos`, `Audio`, `Documents`, `Art`, `Other`), and the refit dropped it. Restored in `src/main/core/planning/MediaPlanner.ts` as `mediaKindFolder`: image and raw go to `Photos`; video, audio, document, art to their own folders. Every folder structure (`year/month`, `year-month`, `flat`) resolves beneath the type folder, and `_Needs Review` sits inside the type folder so review items stay grouped with their kind.
- The legacy `Screenshots` folder routing was not restored; screenshots keep the existing `-screen-shot` suffix option.
- TDD: six-way parameterized planner test over every media kind and all three structures plus review routing failed red (6 of 6), then green. Updated 34 existing path expectations across the planner, preview planner, and parallel preview tests to include the type segment.
- Validation: 46 suites, 954 tests, coverage 89.65 / 85.36 / 91.81 / 91.58. TypeScript, ESLint, Prettier pass. `docs/ARCHITECTURE.md` and `docs/CONFIGURATION.md` describe the type layer.
- The prior instance had been closed by the User at 21:14:49, so nothing needed stopping. Rebuilt dev bundles and launched on the same profile: Electron main PID 3637520, window `Meta Mover` present, runtime started.

## 2026-09-04 same-filesystem move uses rename, cancel residue reclaimed

- User: moving within the same drive must be instant. A live move of 3,122 files within one ZFS dataset ran at copy speed with heavy CPU: 803 files in 17 minutes. Pool I/O was near idle; Electron main sat at 67 percent CPU and the helper at 38 percent.
- Root cause: `TransactionalFileCore.execute` treated `mode: 'move'` as copy plus delete. Per file it hashed the source in Node, staged a copy through the helper (hashing again), hashed the staging file in Node, hard-linked it into place, hashed the destination once more, then deleted the source. Four full reads and four SHA-256 passes per byte, three of them on the main thread.
- Correction: `executeSameFilesystemMove` runs when mode is move, no `expectedSha256` was supplied, and the source `st_dev` equals the target directory's `st_dev`. It reserves the destination name without hash-based duplicate detection, renames through the helper's existing `rename_no_replace` with the source identity as the expected precondition, verifies the destination `dev`, `ino`, and `size` match the source, syncs the target directory, then journals planned, reserved, committed, completed. No staging, no hashing, no delete step. A cross-device error from the rename falls back to the staged path with the allocation counter restored. Copies, cross-device moves, and moves with an expected hash are unchanged.
- The executor already passes `expectedSha256` only when preview computed a content hash, which it does not, so the fast path engages in the app.
- Second defect surfaced by the User's next preview: `Hard-linked media is rejected because path identity is ambiguous`. The cancelled 21:26 job aborted the helper channel while two videos were between publish and source delete. Their staging `.part` files were already hard-linked into the destination; the post-commit cleanup only ran when a durable delete intent existed, so the staging links stayed. The User then moved the output folders back into the source, and the inventory correctly refused files with two links.
- Correction: in the failure path, when the operation committed and the staging file shares the destination's inode, the staging link is reclaimed regardless of how the operation ended. On core open, `reclaimTerminalResidue` sweeps staging and reservation entries of completed, cancelled, failed, and duplicate records, removing a staging entry only when the destination shares its inode, the operation never committed, or the source was retained.
- On-disk residue from the incident was cleared by hand before the fix shipped: four duplicate staging links unlinked (their twins intact), one 413 MB partial copy of an intact source parked in `RAID/AI-Pre-Trash/meta-mover-staging-residue-20260904/`.
- Tests: five rename fast-path tests (rename without staging or hashing, expected-hash gate, cross-device fallback, exact-no-clobber collision, copy unchanged) plus executor coverage, and two residue tests (cancel during the delete step leaves no staging link and a single-link destination; reopen sweeps residue that an earlier core could not clean). All pass; TypeScript clean.
- First full gate exposed that immediate staging reclamation also fired on genuine failures, which two existing restart-recovery tests rely on (the guard link must survive a failed move so recovery can prove the destination). Narrowed immediate reclamation to cancelled operations whose source is retained; the open-time sweep covers completed, cancelled, and duplicate records and leaves failed records to the existing recovery path.
- Final gate: 46 suites, 962 tests, coverage 89.53 / 85.22 / 91.86 / 91.44. TypeScript, ESLint, Prettier pass. Rebuilt and relaunched on the same profile: Electron main PID 3708615, window present.

## 2026-09-17 recovery of the interrupted 2026-09-12 stall correction

- The 2026-09-12 evening session that diagnosed the 100,000-file "frozen at 2" report ended when its Codex driver hit a usage limit at 20:23 EDT. The correction code that landed on disk between 20:23 and 20:47 EDT had no session transcript, no changelog entry, and no validation.
- Reconstructed the thread from the Codex rollout store (`~/.codex/sessions/2026/09/04/rollout-2026-09-04T22-39-31-01a06f6f-7743-7ee1-916f-fd6ff64b7f8c.jsonl`) and its `processing_stall_trace` subagents. Root cause as diagnosed there: the first eligible file triggers a full audit of all preview records - snapshot copy, full verification, index and cohort construction, a second full verification, and a complete resolution Map - before authorizing one file, with no progress display or cancellation.
- Validated the found state: TypeScript, ESLint, and 1,077 Jest tests across 55 suites pass. Independent adversarial review of the uncommitted diff confirmed the port, repository, coordinator, renderer, and IPC changes deliver visible preparation progress, honored cancellation, intact hash-chain validation, and indexed authorization with binding checks, and enumerated the unmet portions of the correction contract.
- Launched the corrected checkout from source under isolated profile `/tmp/meta-mover-source-live-20260917/profile`. The live `dist/main` bundle contains the preparation-progress runtime markers and the runtime log reports canonical startup.
- Backed up the uncommitted working tree to `/archive/20260917_234500-meta-mover-source.zip` plus a binary-safe `git diff` patch before further edits.

## 2026-09-22 Review Queue runtime absorption

### Discussed

The Review view and remediation engine existed as isolated programs, but the running Electron application had no composition, IPC, or preload path connecting them.

### Decided

The canonical application runtime owns the append-only review override store and creates one ReviewRemediationService from the existing history, audit, metadata, and transaction primitives. Renderer requests carry review IDs, evidence revisions, actions, and plan tokens only. Filesystem paths remain derived from sealed history and audit evidence in the main process.

### Built

- Added Review service and override-store ownership to `ApplicationRuntime`, including rollback and deterministic shutdown.
- Added production bindings that open `review-overrides.jsonl` beside job history and construct the remediation service.
- Added strict shared validation and fixed handlers for `review:list`, `review:get`, `review:dry-run`, and `review:apply`.
- Added preload bridge methods and `ElectronAPI` result types matching `ReviewView`.
- Added focused TDD coverage for bridge mapping, malformed-request rejection, dependency composition, rollback, and shutdown.

### Validation

- 73 focused Review/runtime tests pass.
- `npm run typecheck` passes.
- `npm run lint:check` passes.
- The live application was not restarted during this scoped change.

### Review Queue runtime correction loop

Independent review found three blockers in the initial runtime absorption. Corrected them with failing tests first: non-terminal apply results now refresh and retain their queue row; malformed service outputs fail closed at IPC; and production composition exposes dedicated typed review-history and review-audit ports with no unknown casts. The focused Review/runtime grid now passes 76 tests, plus TypeScript, ESLint, Prettier, and diff checks.

### Review Queue durable failed-item discovery

The initial renderer query filtered the service to `pending`, so a failed but retryable override survived on disk yet disappeared after reload. The queue now pages the durable review set and admits pending and failed rows into the actionable UI while excluding terminal kept and resolved rows. A remount test proves failed state and `lastError` return from durable service truth.

### Review Queue actionable cursor contract

Client-side filtering after a bounded server page was unsafe because 50 terminal records could hide failed or pending records on later pages. `ReviewListRequestDTO` now accepts one exact, unique `statuses` set mutually exclusive with `status`; the remediation service filters by that set before slicing and calculating the cursor. ReviewView requests `pending` plus `failed`. Contract, service, and renderer regressions cover validation and the terminal-first-page counterexample.

### Review Queue compact catalog performance correction

The first Review Queue load performed one complete normalization-index scan per committed row, producing quadratic work on the 99,998-file run. The audit repository now publishes a compact unresolved-only review catalog with revision metadata, SHA-256, record count, deterministic cursor order, exact lookup indexing, and safe one-time derivation for existing validated profiles. Review discovery consumes catalog pages rather than invoking a full-index lookup for each row. Corruption and reopen tests verify fail-closed behavior and durable reuse. The live application was not restarted.

The remaining filesystem cost was removed by separating descriptor discovery from item materialization. Status filtering, stable review-ID ordering, cursor slicing, and exact-ID selection now happen before native identity and SHA-256 binding. A 7,391-row regression proves a 25-row page performs exactly 25 bindings, the next page has no duplicate IDs, and exact get performs one exact audit lookup plus one binding. Stale identity detection remains part of materializing each returned row.

Reviewer follow-up removed two remaining catalog integrity and complexity defects. The repository now reads each compact catalog once from one file descriptor, validates records and hashes those exact bytes, builds immutable page and exact-lookup structures, and pins the visible file identity. Later page or exact operations reject replacement, truncation, and in-place mutation through inode, size, mtime, and ctime checks. Pagination slices the immutable record set, so draining every 100-row page parses N records once rather than repeatedly parsing page prefixes. Instrumentation asserts JSON parsing does not increase across ten pages.

## 2026-09-23 audited placeholder metadata recovery

### Discussed

The remaining review corpus contained two independently reproducible corruption signatures: synthetic EXIF midnight timestamps competing with real GPS capture time, and synthetic EXIF midnight timestamps competing with unanimous XMP/IPTC editorial capture fields.

### Decided

Match semantic metadata signatures only. Do not whitelist filenames or hashes. For GPS records, preserve the exact GPS UTC instant; Photoshop local time can corroborate timezone context but cannot synthesize a replacement instant. For editorial records, require exact nonmidnight agreement across Photoshop, IPTC creation, and IPTC digital creation fields.

### Built

- Added `SYNTHETIC_EXIF_PLACEHOLDER_GPS_RECOVERY` for matching EXIF DateTimeOriginal/CreateDate 2022-01-01 tiny-fraction placeholders plus valid 2023/2024 GPS UTC evidence.
- Added `EDITORIAL_CAPTURE_CONSENSUS_RECOVERY` for exact 2003-07-01 or 2022-01-01 EXIF midnight placeholders contradicted by three agreeing XMP/IPTC fields.
- Added positive and counterexample tests for missing corroboration, GPS year boundaries, Photoshop context, and conflicting IPTC time.

### Validation

- DateResolver focused suite: 109 tests passed.
- TypeScript and ESLint passed before concurrent unrelated recovery work entered the shared resolver; final combined validation remains the orchestrator's gate.

## 2026-09-23 PNG screenshot and Apple AM/PM recovery

### Discussed

Two small residue cohorts carried enough independent evidence to recover a timestamp: PNG screenshots whose native creation clock agrees with the screenshot name and filesystem instant, and older Apple photos whose EXIF/XMP clock was shifted exactly 12 hours by AM/PM corruption.

### Decided

Use semantic predicates only. Require all corroborators and keep every near miss in review. The PNG rule admits either an exact edit-pair signature or an exact Apple Display P3 1170x2532 screenshot signature with the known `2022-01-01 00:00:00` PNG placeholder and an older embedded content date. The Apple photo rule accepts only iPhone 6, 6s, and 7 metadata with coordinates, an IPTC offset exactly matching the geographically supported `-05:00` or `-07:00` GPS relationship, and no more than 49 seconds of GPS clock drift.

### Built

- The collector binds each approved signature into the selected candidate's raw evidence.
- The resolver revalidates that evidence and emits `PNG_SCREENSHOT_NATIVE_DATE_RECOVERY` or `APPLE_AM_PM_CORRUPTION_RECOVERY` at medium confidence.
- Positive and required near-miss tests exercise the complete collector-to-resolver path.

### Validation

- Focused collector/resolver integration: 77 tests passed.
- Fresh read-only replay over the proposed 28 files produced 19 PNG and 8 safe Apple transitions, zero overlap. One LA file remains ambiguous because its IPTC `-05:00` offset conflicts with the coordinate/GPS-derived `-07:00` offset. The combined rules project residue 996 of 99,998 without inventing a corrected instant.
- TypeScript passed. Final combined lint and corpus replay remain the orchestrator's gate.

## 2026-09-24 strongest timestamp selection correction

### Discussed

A fresh run crashed while persisting a resolved record. The generic resolver had selected an IPTC calendar date as a fallback for unverified EXIF subseconds, then emitted a result without the audit triplet required for a date-only resolution.

### Decided

Candidate identity and subsecond precision are separate decisions. Keep the strongest candidate selected and reduce only its unsupported fractional precision to whole seconds. Calendar dates remain valid only through their existing audited resolution paths.

### Built

- Removed the generic preference for any candidate without `fractionalDigits`.
- Added an integration regression for EXIF DateTimeOriginal/CreateDate at `2003-10-11T15:34:20.000007`, competing IPTC date-only metadata, and a midnight filename claim.
- Added counterexamples proving whole-second and date-only-only inputs retain their existing behavior.

### Validation

- Collector and resolver focused suites: 195 tests passed.
- TypeScript, ESLint, and Prettier validation passed.
