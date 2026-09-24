# Wall-clock conflict replay

## Scope

This replay tested whether META Mover can safely resolve a narrow class of `STRONG_CONFLICT`
records when an authoritative capture candidate and the filename show the same local wall-clock
value but instant-bearing candidates disagree about UTC.

The source was the sealed 99,998-row evidence ledger written by the successful September 22,
2026 run:

`/tmp/meta-mover-source-live-20260921/profile/meta-mover/evidence/9a51534d576c800d70d8862860e6393ecb05179151e2f6a1b744bf7c625b5570.evidence.jsonl`

The replay was read-only. It streamed every `resolution-decided` event and inspected the scored
candidates named by each ambiguous record's `contenderIds`.

## Result

| Measure                                                   | Records |
| --------------------------------------------------------- | ------: |
| Ledger rows                                               |  99,998 |
| Ambiguous `STRONG_CONFLICT` rows                          |   3,627 |
| Named `contenderIds` sharing one whole-second local clock |      60 |
| Those named-contender rows with fractional claims         |      60 |

No resolver rule was changed. The first pass inspected only `contenderIds`; all 60 apparent matches
in that projection have competing fractional values. The broader pass below inspects every eligible
candidate because `contenderIds` omits corroborators outside the top two constructed groups.

One representative record is `2020-04-13_15-32-38.jpeg`. Its contenders include EXIF
`15:32:38.000411`, offset-qualified XMP `15:32:38.411`, whole-second XMP, and the whole-second
filename. The date and second match, but the fractions do not. The record must remain reviewable.

## Rejected broad rules

- Filename agreement cannot choose between equal wall clocks carrying different explicit offsets;
  those offsets identify different instants.
- Filename agreement cannot override an authoritative candidate with a different local date or
  time.
- Whole-second agreement cannot suppress nonzero fractional disagreement.
- Exact-midnight claims retain the existing placeholder review behavior.

The resolver tests preserve these counterexamples.

## Broader residue mining

A second full-ledger pass normalized filename tags and clustered all 3,627 strong conflicts. There
are 77 contender signatures. The two largest clusters contain 1,252 and 949 records. Both carry
floating EXIF original time, XMP local time, explicit-offset IPTC time, GPS represented as UTC, and
a previously normalized filename. Every source agrees on the local date and time; the resolver
splits the group because GPS uses that clock as UTC while IPTC applies an offset.

The current 7,391 review rows consist of 3,627 strong conflicts, 3,448 exact-midnight low-confidence
records, and 316 insufficient-confidence records.

The apparent 60-versus-2,265 contradiction comes from two different projections. The first pass
looked only at IDs emitted for the resolver's top two groups. Group construction excludes some
eligible corroborators when instant semantics split an otherwise unanimous local clock. The second
pass evaluated all eligible nonfilesystem candidates and found 2,265 records satisfying the full
predicate. The production replay confirms that exact count.

### Conservative strategies

| Strategy                                                                                                                                   | Yield from 3,627 strong conflicts | Counterexample boundary                                                                                                 | Verdict                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------: | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Treat a unanimous whole-second local clock as authoritative when EXIF `DateTimeOriginal` and at least one other embedded source kind agree |                             2,265 | Excludes every nonzero fractional claim, midnight, and differing local date/time                                        | Implementable                           |
| Prefer independently corroborated EXIF original time over later repeated import/edit timestamps                                            |                               140 | "Later" alone is not proof; requires each conflicting value to recur in at least five files plus embedded corroboration | Implementable only with cohort evidence |
| Trust a prior normalized filename as an independent family                                                                                 |                 0 safe additional | The filename was produced from earlier metadata and is derived evidence                                                 | Reject                                  |
| Collapse subsecond values to their common whole second                                                                                     |           441 apparent candidates | Fractions disagree or a whole-second field omits a nonzero fraction                                                     | Reject                                  |
| Treat earlier midnight or date-only candidates as harmless                                                                                 |            69 apparent candidates | Could be a real earlier capture date; overlaps placeholder semantics                                                    | Reject                                  |

The first two strategies are disjoint in this replay and yield 2,405 records. Strong-conflict
residue would remain 1,222. Total review residue would fall from 7,391 to 4,986, or 4.99 percent of
the 99,998-row run. The requested sub-1-percent residue cannot be reached without resolving
midnight placeholders, dateless files, subsecond disagreements, or unequal semantic conflicts.
This corpus does not support doing that automatically.

### Required implementation constraints

The unanimous-local rule must require all of the following:

- EXIF `DateTimeOriginal` and at least one different embedded source kind agree on the complete
  non-midnight local value at second precision.
- Every eligible non-filesystem contender has the same local value, allowing a matching date-only
  candidate for that calendar date.
- No contender carries a nonzero fraction.
- Instant disagreement is explainable only by zone basis or offset representation.
- Filename evidence is retained for lineage and display. It is never required and does not satisfy
  independent corroboration.

The later-batch rule additionally needs cohort-level evidence. Every conflicting later value must
repeat across at least five files and the selected EXIF value must already have independent
embedded corroboration. A per-file "later date loses" rule is unsafe.

## Implemented replay gate

The independently reviewed unanimous-local predicate was implemented with one additional boundary:
the selected EXIF original must be floating local. This prevents a matching filename from choosing
between two authoritative explicit-offset originals.

All 99,998 durable resolution records were replayed through the corrected resolver:

- `UNANIMOUS_LOCAL_CAPTURE_RECOVERY`: 2,265
- `ambiguous/none` to `resolved/medium`: 2,265
- Every other status/confidence transition: 0

All 2,265 exclude nonzero fractions, exact midnight, differing local seconds, mismatched date-only
claims, filename-only corroboration, filesystem evidence, and explicit-offset EXIF originals. Zero
fractions on ten records are normalized to whole-second output without asserting false precision.

Independent review found that the first implementation accidentally made filename lineage
mandatory. Removing that requirement did not change this ledger's result: the same 2,265 records
recover, with the same sole status transition. This is expected because every current qualifying
record happens to retain a normalized filename, but future unrenamed files are no longer excluded.

## Calendar-day recovery after wall-time rules

Policy `date-resolution/2` adds a later, deliberately lower-precision outcome. It runs after the
exact-instant, audited MakerNote, and unanimous wall-clock rules. It requires at least one eligible
embedded creation candidate and requires every eligible or corroboration-only embedded EXIF, XMP,
and IPTC creation candidate to name the same local calendar day. Filename and filesystem evidence
cannot establish the result. Any credible embedded different day vetoes it.

The selected value is exactly `YYYY-MM-DD`, `precision: date`, and `zoneBasis: date-only`. It has no
instant, offset, zone, fraction, or invented midnight. Planning uses `YYYY-MM-DD.ext`, with the
existing deterministic suffix policy handling collisions. Metadata normalization skips the result.

The corrected combined 7,391-row replay resolves 6,262 records and leaves 1,129. Calendar precision
is selected for 3,652 results. Compared with the earlier replay, 287 records retain a trustworthy
known time instead of being reduced to date precision, while 64 records with conflicting
trustworthy times return to review. This accounts for all 351 removed date-only selections and the
64-record residue increase. On the 99,998-file run, the projected residue is 1.129 percent, so this
correction alone does not satisfy the less-than-one-percent gate.

## Narrow screenshot and AM/PM cohorts

A fresh metadata read validated two additional semantic rules without filenames or hashes as an
allowlist. Native PNG CreateDate may win when it matches a structured screenshot filename and the
filesystem modified timestamp represents the same UTC instant while PNG ModifyDate equals the
older Photoshop DateCreated value. A second exact branch admits Apple Display P3 1170x2532
screenshots where native nonmidnight CreateDate follows the older Photoshop content date and PNG
ModifyDate carries the known `2022-01-01 00:00:00` profile placeholder. Filename and filesystem
timestamps are optional corroboration in that Apple branch and cannot establish its result.

Apple AM/PM recovery is limited to iPhone 6, 6s, and 7 records. Photoshop and explicit-offset IPTC
local time must agree, GPS UTC must be within 49 seconds under a `-05:00` or `-07:00` relationship,
coordinates must support that offset, the IPTC offset must match it exactly, and EXIF
DateTimeOriginal plus XMP CreateDate must agree exactly 12 hours earlier.

The proposed set contained 19 PNG and nine Apple photo files. The strict fresh replay produced all
19 PNG and eight Apple AM/PM transitions, 27 total, with zero overlap. One LA record remains
ambiguous because IPTC anchors its local time at `-05:00` while coordinates and GPS prove
`-07:00`. No corrected instant is synthesized. Combined with the other audited rules, projected
residue is 996 of 99,998.
