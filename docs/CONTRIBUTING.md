# Contributing

## Setup

```bash
npm ci
npm run package:stage-tools
npm run dev
```

## Before a pull request

```bash
npm run verify
npm run build
npm run package:integrity
```

Write tests before production changes. A fix to media movement must include failure, crash, cancellation, changed-input, and conservation cases that match the risk.

Keep dependencies pinned where the runtime contract depends on exact bytes. Explain every new dependency. Do not add runtime downloads, system package installs, updater code, host executable lookup, or user-writable production package targets.

Use short conventional commit subjects. Describe the user-visible behavior, risk, validation, and platform proof in the pull request. Do not claim macOS or Windows runtime support from a Linux cross-compile.

Security flaws belong in private email, not public issues. See [SECURITY.md](../SECURITY.md).
