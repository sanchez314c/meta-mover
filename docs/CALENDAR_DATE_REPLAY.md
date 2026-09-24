# Calendar-date replay evidence

Run the read-only resolver replay with:

```bash
node -r ts-node/register tools/replay-date-resolution.ts <rows.jsonl>
```

The immutable review rows extracted from the sealed 99,998-file preview are stored during this
validation as `/tmp/mm-review-resolutions.jsonl`. Before the trusted-time precision correction,
replaying those original candidates produced this historical baseline:

- total review rows: 7,391
- resolved: 6,320
- date-only selections: 3,998
- residue: 1,071

The refreshed candidate snapshot at `/tmp/mm-fixed-offset-replay.jsonl` includes the corrected exact
offset parser, metadata rereads, and the trusted-time precision correction. Replaying that snapshot
with current source produces:

- total review rows: 7,391
- resolved: 6,262
- date-only selections: 3,652
- residue: 1,129

The earlier fresh replay reported 6,326 resolved, 4,003 date-only selections, and 1,065 residue.
That run treated any same-day date-only or placeholder field as proof that the clock was unknown.
The corrected rule preserves 287 trustworthy timed resolutions instead of reducing them to calendar
precision. It also returns 64 records with conflicting trustworthy clock values to review rather
than hiding the conflict behind a date-only result. This accounts for the 351 fewer date-only
selections and the 64-record increase in residue.

Both inputs contain only the 7,391 original review rows. The other 92,607 rows were already outside
the review queue. The current fresh-preview projection is 98,869 resolved and 1,129 residue, or
1.129 percent of the 99,998-file run. The sealed baseline above documents the earlier policy result
and is not a current-source projection.
