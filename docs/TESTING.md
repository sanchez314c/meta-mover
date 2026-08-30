# Testing

## Required source gate

```bash
npm run verify
```

This runs formatting, ESLint, strict TypeScript checks, Rust formatting, Rust clippy with warnings denied, Rust tests, source package policy, and Jest with coverage thresholds.

Then prove build and runtime staging:

```bash
npm run build
npm run package:integrity
```

## Test layout

- `tests/unit`: contracts, date resolution, inventory, planning, security, services, UI, runtime, native client, and package policy
- `tests/integration`: canonical application composition and transaction execution
- `native/fs-helper/tests`: capability, no-follow, no-clobber, durability, deletion, and reconciliation protocols
- `native/launch-broker`: immutable launch and platform handle tests

## Non-negotiable regressions

Processing changes must prove:

- preview performs no mutation
- dates preserve offsets and fractional precision
- uncertain dates route to `_Needs Review`
- source and destination roots cannot overlap
- source or destination drift after preview fails closed
- parallel same-name files cannot overwrite one another
- copy retains every source
- move deletes only after verified publication and durable intent
- crash recovery never guesses source deletion from path absence
- cancellation emits one terminal state and leaves no untracked staging object
- packaged execution uses only manifest-bound tools

Jest coverage thresholds are defined in `config/jest.config.js`. Never lower a gate to make a change pass.

Native macOS and Windows runtime claims require their native CI jobs. A cross-compile from Linux is useful compile evidence, not runtime proof.
