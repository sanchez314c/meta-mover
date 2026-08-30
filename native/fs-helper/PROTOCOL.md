# META Mover Filesystem Helper Protocol

`meta-mover-fs-helper --stdio` is a private child process owned by the Electron main process. It performs only filesystem mutations that need kernel-enforced no-follow and no-replace behavior. TypeScript remains the sole owner of the transaction journal and business state.

## Transport

- stdin and stdout are UTF-8 NDJSON.
- Each request and response occupies one line terminated by `\n`.
- A line may contain at most 65,536 bytes including the newline.
- The helper processes exactly one request at a time and writes exactly one response before reading the next request.
- EOF closes the helper. Any final bytes not terminated by `\n` are discarded and never executed.
- JSON objects reject duplicate and unknown keys. JSON nesting is limited to 16 levels. Arrays are limited to 256 items.
- `v` is always `1`. `id` is a lowercase canonical UUID v4 string and is echoed unchanged.
- stderr is diagnostic only. Protocol data never appears on stderr.

## Lifecycle

The first accepted operation is `hello`. The second is `bind_roots`. `bind_roots` may succeed once. After it succeeds, the helper seals ambient filesystem access. Every later filesystem reference is relative to a retained root capability. `close` returns a response and exits successfully. EOF also closes without performing more work.

`hello` request:

```json
{"v":1,"id":"00000000-0000-4000-8000-000000000001","op":"hello"}
```

`hello.result`:

```json
{
  "outcome":"applied",
  "protocol":1,
  "build":"0.1.0",
  "target":"x86_64-unknown-linux-gnu",
  "features":["capability-relative","no-follow","no-replace","sha256","durable-sync"]
}
```

`bind_roots` is the only operation accepting absolute paths:

```json
{
  "v":1,
  "id":"00000000-0000-4000-8000-000000000002",
  "op":"bind_roots",
  "roots":[
    {"name":"source","kind":"source","absolutePath":"/absolute/source"},
    {"name":"destination","kind":"destination","absolutePath":"/absolute/destination"},
    {"name":"control","kind":"control","absolutePath":"/absolute/control"}
  ]
}
```

Root names are unique ASCII identifiers matching `[A-Za-z][A-Za-z0-9_-]{0,63}`. A kind may be bound more than once under different names. Each root must already exist and must be a real directory, not a symbolic link. `bind_roots.result.roots` returns the bound `name`, `kind`, and native identity. The absolute path is never returned.

## Capability Paths

All later paths use this shape:

```json
{"root":"source","components":["2024","IMG_0001.jpg"]}
```

`root` must name a retained capability. `components` contains 1 to 256 literal path components. Components reject empty strings, NUL, `.`, `..`, `/`, `\\`, Windows device names, colons, alternate data streams, and trailing dot or space. No operation accepts an absolute path after root binding.

## Native Identity

Integer identity fields are decimal strings so JavaScript cannot lose precision. Device, inode, link-count, size, volume-serial, and file-ID fields are canonical unsigned decimals. `mtimeNs` is a canonical signed decimal because native filesystems can represent timestamps before the Unix epoch.

Unix identity:

```json
{"kind":"unix","device":"1","inode":"2","links":"1","size":"10","mtimeNs":"123"}
```

Windows identity:

```json
{"kind":"windows","volumeSerial":"1","fileId":"2","links":"1","size":"10","mtimeNs":"123"}
```

Requests that accept `expected` require the complete identity for the native platform. Optional `expectedSha256` is a lowercase 64-character SHA-256 digest.

## Operations

Every filesystem operation requires successful root binding.

- `ensure_dir_chain`: `{"path": CapabilityPath}`. Creates missing directories one component at a time without following links. Existing real directories are accepted. Returns the final directory identity. If a later component fails after a prefix was created and synced, the failure outcome is `unknown` because that durable prefix remains.
- `stage_copy`: `{"source": CapabilityPath, "target": CapabilityPath, "expected"?: NativeIdentity, "expectedSha256"?: string}`. The target parent must exist. Opens the source without following links, validates its identity, creates the target new, streams bytes while hashing, syncs the target, validates the optional hash, and syncs the target parent. Failure removes only the exact new staging file when its identity still matches.
- `write_marker_new`: `{"path": CapabilityPath, "contents": string}`. Creates a UTF-8 marker without replacement, syncs it, and syncs its parent.
- `hard_link_no_replace`: `{"source": CapabilityPath, "target": CapabilityPath, "expected"?: NativeIdentity}`. Links a regular source to an absent target without replacement and syncs the target parent.
- `rename_no_replace`: `{"source": CapabilityPath, "target": CapabilityPath, "expected"?: NativeIdentity}`. Uses Linux `renameat2(RENAME_NOREPLACE)`, macOS `renameatx_np(RENAME_EXCL)`, or a Windows handle rename with replacement disabled. Syncs both parents after success.
- `remove_managed_exact`: `{"path": CapabilityPath, "expected": NativeIdentity}`. Removes only a non-directory entry whose current no-follow identity exactly matches `expected`, then syncs its parent.
- `delete_source_exact`: `{"source": CapabilityPath, "expected": NativeIdentity, "expectedSha256": string, "deleteId": string, "receipt": CapabilityPath}`. `deleteId` is a caller-supplied lowercase canonical UUID v4 and must differ from the transport `id`. `receipt.root` must resolve to a retained `control` capability. Before mutation, the helper opens both final entries through retained parents and compares native object identities, rejecting `source` and `receipt` when they alias through differently named or typed root bindings, hard links, case-insensitive names, normalized names, or Windows short names. The helper opens and hashes the source without following links, creates `.meta-mover-delete-<deleteId-without-hyphens>` in the same parent, renames the source without replacement to `entry`, and reopens and verifies the quarantined identity and hash. It then creates the receipt without replacement, syncs the receipt and its parent, unlinks only the verified quarantine entry, syncs and closes the quarantine, removes it, and syncs the source parent. The receipt is permanent transaction evidence and is never removed by the helper. Existing quarantine or receipt state returns `reconciliation-required` with phase `precondition`, outcome `unknown`, and no details; the caller must invoke `reconcile_source_delete` before retrying.
- `reconcile_source_delete`: `{"source": CapabilityPath, "expected": NativeIdentity, "expectedSha256": string, "deleteId": string, "receipt": CapabilityPath}`. `receipt.root` must resolve to a retained `control` capability. The same source/receipt namespace-alias check runs before inspection or cleanup. The operation inspects only the capability-relative source, receipt, and `.meta-mover-delete-<deleteId-without-hyphens>/entry` using no-follow handles. It never restores by pathname, replaces an entry, removes a receipt, or deletes a source-path replacement.

The immutable receipt is compact UTF-8 JSON terminated by `\n`, with keys in the order shown:

```json
{"protocol":1,"deleteId":"00000000-0000-4000-8000-000000000031","source":{"root":"source","components":["incoming","photo.jpg"]},"expected":{"kind":"unix","device":"1","inode":"2","links":"1","size":"10","mtimeNs":"123"},"expectedSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
```

Only the helper creates this exact marker. It is created after the exact quarantined entry is reverified and before unlink. `reconcile_source_delete` may create it when an exact quarantine entry proves a crash occurred between quarantine verification and receipt creation. A create collision never overwrites or deletes the colliding object and returns unknown. Every later reconciliation requires byte-for-byte receipt validation.

Successful `delete_source_exact` returns:

```json
{
  "outcome":"applied",
  "state":"deleted",
  "sourceState":"absent",
  "quarantineState":"entry-deleted",
  "receiptState":"created",
  "deleteId":"00000000-0000-4000-8000-000000000031",
  "durability":{"file":"synced","parents":["synced","synced","synced"]}
}
```

`reconcile_source_delete` has these terminal success results:

```json
{
  "outcome":"not-applied",
  "state":"source-retained",
  "sourceState":"expected",
  "quarantineState":"absent",
  "receiptState":"absent",
  "deleteId":"00000000-0000-4000-8000-000000000031",
  "durability":{"file":"not-applicable","parents":[]}
}
```

`quarantineState` is `absent` when no quarantine exists or `empty-removed` when an exact empty quarantine was removed and its parent synced. This result is returned only after the source's complete identity and SHA-256 match and the receipt is absent.

```json
{
  "outcome":"applied",
  "state":"deleted",
  "sourceState":"absent",
  "quarantineState":"entry-deleted",
  "receiptState":"exact",
  "deleteId":"00000000-0000-4000-8000-000000000031",
  "durability":{"file":"not-applicable","parents":["synced","synced"]}
}
```

`sourceState` is `absent` or `replacement-preserved`. `quarantineState` is `entry-deleted`, `empty-removed`, or `absent`. `receiptState` is `created` when reconciliation safely creates and syncs a missing receipt from an exact quarantine entry, otherwise it is `exact`. The helper returns `deleted` only after the receipt is exact and the observed source/quarantine state proves the expected source crossed the quarantine boundary. A regular or special replacement at the source path is never opened for deletion and is reported as `replacement-preserved`.

Durability receipts list only work performed by the current request. Creating a receipt reports `file: "synced"` and one parent sync. Deleting an exact entry adds quarantine and source-parent syncs. Removing an empty pre-intent quarantine while retaining the exact source syncs only the source parent. When an exact receipt proves the delete intent, an empty quarantine is first synced to make entry absence durable, then removed and followed by a source-parent sync. Confirming an exact receipt with no quarantine syncs the source parent once before reporting `deleted`.

All ambiguous reconciliation states fail with `code: "reconciliation-required"`, `phase: "precondition"`, `outcome: "unknown"`, and this exact optional error detail object:

```json
{
  "deleteId":"00000000-0000-4000-8000-000000000031",
  "sourceState":"absent",
  "quarantineState":"entry-other",
  "receiptState":"absent",
  "relativeResidue":{
    "source":{"root":"source","components":["incoming","photo.jpg"]},
    "quarantine":{"root":"source","components":["incoming",".meta-mover-delete-00000000000040008000000000000031"]},
    "entry":{"root":"source","components":["incoming",".meta-mover-delete-00000000000040008000000000000031","entry"]},
    "receipt":{"root":"control","components":["delete-receipts","00000000-0000-4000-8000-000000000031.json"]}
  }
}
```

Failure `sourceState` is `expected`, `absent`, `other`, `special`, or `unreadable`. Failure `quarantineState` is `absent`, `empty`, `entry-expected`, `entry-other`, `entry-special`, `unexpected-entries`, `special`, or `unreadable`. Failure `receiptState` is `absent`, `exact`, `other`, `special`, or `unreadable`. The relative paths are inspection metadata, not proof that every named entry still exists. No absolute path is returned. Source absent with absent or empty quarantine and no exact receipt remains unknown. Exact receipt plus absent/empty quarantine and absent/replacement source proves the delete crossed the durable intent boundary and converges to `deleted`. Exact quarantine entry plus absent receipt may create the receipt and complete deletion. Any mismatched receipt or quarantine entry, special type, unreadable entry, unexpected quarantine child, or simultaneous exact source and exact quarantine entry preserves every object and returns explicit unknown.
- `close`: no fields. Seals the protocol and exits after responding.

Operations never replace an existing directory entry. Linux uses directory file descriptors plus `openat` or `openat2` style no-follow traversal. macOS uses directory descriptors and `renameatx_np`. Windows uses retained directory handles, reparse-point-safe opens, and handle-based rename with replacement disabled.

On Unix, the helper holds and validates the source descriptor before and after pathname-based rename or quarantine operations. Unix does not provide an atomic compare-identity-and-rename primitive. A concurrent name swap therefore returns `unknown` after mutation and preserves both the opened object and any quarantine or target residue for journal reconciliation. The helper never deletes an object after an identity mismatch.

## Packaging and trust boundary

Crates and the Rust 1.85.1 toolchain are pinned. Linux release helpers are static PIE executables and package verification rejects a `PT_INTERP` segment. macOS and Windows helpers use OS system interfaces. CI is configured to compile and test each supported OS before merge; local evidence in this refit covers Linux runtime behavior only.

The staged manifest and binary digest detect accidental corruption and binary-only replacement. They are not an external authenticity root because both live in the same package tree. Distribution signing and an installer location that denies ordinary write and delete access are required to defend against manifest-plus-binary replacement.

## Responses

Success:

```json
{
  "v":1,
  "id":"00000000-0000-4000-8000-000000000003",
  "ok":true,
  "result":{
    "outcome":"applied",
    "before":null,
    "after":{"kind":"unix","device":"1","inode":"2","links":"1","size":"10","mtimeNs":"123"},
    "sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "durability":{"file":"synced","parents":["synced"]}
  }
}
```

Fields not relevant to an operation are omitted. `durability.file` is `synced` or `not-applicable`. Each affected parent contributes one `synced` entry.

Failure:

```json
{
  "v":1,
  "id":"00000000-0000-4000-8000-000000000003",
  "ok":false,
  "error":{
    "code":"target-exists",
    "phase":"precondition",
    "outcome":"not-applied",
    "retryable":false,
    "message":"target already exists"
  }
}
```

`phase` is `validation`, `precondition`, `mutation`, `durability`, or `protocol`. `outcome` is `not-applied` only when the helper can prove no requested namespace mutation remains. Ambiguous syscall or transport outcomes use `unknown`; callers must reconcile state before retrying. `error.details` is omitted except for the exact `reconcile_source_delete` object above. Messages and details never contain absolute paths.
