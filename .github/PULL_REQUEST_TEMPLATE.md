## What changed?

## Why?

## Risk

Describe media-loss, path, metadata-truth, crash, cancellation, package, and platform risks that apply.

## Validation

- [ ] Tests were written before production changes
- [ ] Focused tests pass
- [ ] `npm run verify` passes
- [ ] `npm run build` passes
- [ ] `npm run package:integrity` passes when reachability or packaging changed
- [ ] Copy and move behavior preserve the transaction contract
- [ ] Documentation, `IMPLEMENT.md`, and `CHANGELOG.md` are current
- [ ] No runtime download, host executable lookup, updater, or unsupported package target was added

## Platform evidence

List the OS and architecture where runtime behavior was tested. Cross-compilation must be labeled as compile evidence only.

## Recovery and rollback

Explain how a failure is detected and how the change can be reversed.
