# Development

## Setup

Requirements: Node.js 22.12+, npm 10.9, Rust 1.85.1, Git, and the current OS compiler toolchain.

```bash
npm ci
npm run package:stage-tools
npm run dev
```

Use the lockfile. Do not add lifecycle downloads, host package-manager calls, or executable lookup through `PATH`.

## Commands

```bash
npm run build:dev
npm run build
npm run test
npm run test:watch
npm run test:ci
npm run typecheck
npm run lint:check
npm run format:check
npm run native:verify
npm run package:integrity:source
npm run package:integrity
```

`npm run verify` combines the source quality gates.

## Change rules

- Write the failing test first.
- Keep current DTOs strict and transport-safe.
- Preserve preview purity and execution revalidation.
- Keep all media namespace mutation behind `NativeTransactionFilesystem`.
- Do not weaken copy, hash, no-clobber, journal, receipt, or durability steps.
- Add dependencies only when the platform or existing stack cannot solve the problem.
- Update `IMPLEMENT.md` and `CHANGELOG.md` for functional changes.

See [Architecture](ARCHITECTURE.md), [Testing](TESTING.md), and [Workflow](WORKFLOW.md).
