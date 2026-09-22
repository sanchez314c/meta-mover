# Engineering learnings

## A timestamp is evidence, not truth

EXIF fields, container fields, filenames, and filesystem times mean different things. Flattening them into one `Date` loses source, offset, precision, and uncertainty. META Mover keeps candidates and explains the selected result.

## A correct preview is a contract

A preview is useful only if execution proves the inputs and destination still match it. META Mover binds roots, fingerprints files, snapshots destination state, and revalidates before mutation.

## Move is a distributed state problem

Copy, hash, publish, journal, receipt, and source deletion can be interrupted between any two steps. An append-only journal and idempotent reconciliation make those boundaries visible. Path absence alone never proves deletion.

## Hashes need a trust root

A manifest hash detects changes only after the manifest and package tree are authenticated. Production therefore requires a signed or administrator-owned immutable install, then the broker and helper verify exact bytes again.

## Self-contained means no runtime installer

Bundling a script that calls Python, package managers, or `PATH` is still host-dependent. META Mover stages every non-OS processing runtime at build time and refuses to fall back.

## Uncertain files should remain easy to find

Forcing weak evidence into a dated folder produces tidy lies. `_Needs Review` keeps the file safe and makes the uncertainty actionable.

## Wall-clock agreement does not erase instant or subsecond conflicts

A filename can corroborate a local date and time, but it cannot select between explicit offsets or
discard conflicting fractions. The 99,998-row September 22 replay contained 3,627 strong conflicts;
all 60 contenders that matched at whole-second wall-clock precision still disagreed below the
second. None qualified for automatic resolution.
