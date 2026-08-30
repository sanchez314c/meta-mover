# META Mover Launch Broker Contract

`meta-mover-launch-broker` is the only program intended to launch the packaged `meta-mover-fs-helper`. This standalone implementation is staged beside the helper under the application resources tree. The Electron client and runtime health consume this broker boundary through the separately owned composition layer.

## Commands

- `meta-mover-launch-broker --identity` emits one newline-terminated JSON object describing the broker build, native target, compiled helper SHA-256, helper protocol, helper build, helper package target, and optional release signer policy. It performs no filesystem mutation and launches nothing.
- `meta-mover-launch-broker --stdio` locates the helper relative to the broker executable, validates it, then transfers the broker's existing stdin, stdout, and stderr channels to the helper. No other arguments are accepted.

The staged layout is exact:

```text
tools/
  launch-broker/<platform>-<arch>/meta-mover-launch-broker[.exe]
  fs-helper/<platform>-<arch>/meta-mover-fs-helper[.exe]
```

The broker rejects execution when its own executable is not under the exact `launch-broker/<platform>-<arch>` layout. It never searches `PATH`, accepts an ambient helper path, follows a symbolic-link component, or falls back to pathname execution after a held-object launch fails.

## Compiled helper identity

Release builds compile these values into the broker:

- lowercase 64-character helper SHA-256;
- helper protocol version `1`;
- non-empty helper build version;
- exact `<platform>-<arch>` package target;
- optional release signer policy supplied by the release build.

The build fails when these values are missing or malformed. Test-profile builds use an explicit test identity and inject expected hashes into verification functions. The broker hashes the opened helper object, checks stable native identity before and after hashing, and rejects a non-regular or reparse entry.

Release signing is conditional. With no release signer configured, the broker records `null` and relies on the compiled content hash plus the package trust boundary. When a signer policy is configured, verification is mandatory and fail-closed through the platform signer-verifier interface. This repository contains no certificate, private key, signer identity, or fabricated credential.

## Package manifest

Staging advances `tools/manifest.json` to schema `3` and adds exactly one `launch-broker` entry with these fields: `name`, `path`, `version`, `sha256`, `target`, `rustTarget`, `buildVersion`, `helperSha256`, `helperProtocolVersion`, `helperBuildVersion`, `releaseSigner`. Package verification rejects duplicate keys and unknown keys at every schema-3 object level, a noncanonical path, any broker hash drift, any mismatch between the manifest and `--identity`, and any mismatch between the broker's relayed `hello` result and the directly probed helper.

Runtime absorption validates the same direct helper entry, broker manifest entry, strict `--identity` response, and relayed helper `hello` evidence before launching `--stdio`. The broker boundary supplies no direct-helper fallback.

## Platform launch

### Linux

The broker opens every resource component without following links and validates through the retained helper descriptor. It copies those verified bytes into an anonymous `memfd`, hashes the snapshot against the compiled digest, adds and verifies write/grow/shrink/seal seals, normalizes that descriptor to `3`, closes every ambient descriptor above `3`, and calls `execve` on `/proc/self/fd/3`. Successful launch replaces the broker process, so the original PID and inherited private standard streams become the helper's. Snapshot, seal, descriptor closure, or `/proc/self/fd` failure is terminal; there is no pathname fallback.

### macOS

The broker validates the retained packaged descriptor, creates a unique private temporary execution file with `mkstemp`, copies and syncs the verified bytes, restricts it to executable-owner mode, and re-hashes it against the compiled digest. Before unlinking, it opens the same inode separately as read-only with no-follow semantics and verifies native identity equality. It then unlinks the snapshot, closes the writable descriptor, applies and verifies `UF_IMMUTABLE` through the retained read-only descriptor, requires link count zero, and re-hashes again. It normalizes only this immutable read-only descriptor to `3`, closes every ambient descriptor above `3`, and calls `execve` on `/dev/fd/3`. Snapshot, identity, immutability, descriptor closure, or `/dev/fd` failure is terminal; there is no original-path or mutable-descriptor fallback. Native macOS CI must prove the snapshot rejects writes, actually executes through `/dev/fd/3`, and executes the staged broker relay before packaging. Cross-compilation alone is not runtime proof.

### Windows

The broker opens and retains every nonempty helper ancestor from the volume/share root through the target directory, plus the final helper, with reparse-point processing disabled. Handles deny write and delete sharing. The final handle is checked for regular-file attributes, stable `FileIdInfo`, size, and SHA-256. The broker duplicates only stdin, stdout, and stderr as inheritable handles, places exactly those handles in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, and starts the verified path with `CreateProcessW` using `CREATE_SUSPENDED` and `EXTENDED_STARTUPINFO_PRESENT`. It assigns the suspended process to a job configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, rechecks the held helper identity, resumes the primary thread, waits for termination, and returns the child exit code. Any failure before resume terminates the exact child. Closing the broker's job handle terminates the child tree if the broker dies.

Native Windows CI must execute the staged broker relay, prove an ambient inheritable handle is excluded, prove pre-resume failure terminates the exact child, and prove kill-on-close terminates a launched descendant tree. Cross-compilation alone is not runtime proof.

## Lifecycle and failures

The broker buffers no protocol frames and emits no stdout of its own in `--stdio` mode. On Unix, successful `execve` gives the helper direct ownership of the inherited streams. On Windows, the helper inherits only duplicated standard handles while the broker waits. Diagnostics use stderr. Validation or launch failure exits nonzero without retrying or attempting another executable.
