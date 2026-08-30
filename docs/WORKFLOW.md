# Development workflow

1. Define the behavior and failure state in a test.
2. Run the focused test and record the failure.
3. Make the smallest code change that satisfies the contract.
4. Run focused tests, then `npm run verify`.
5. Build and run `npm run package:integrity` when reachability or packaging changes.
6. Review data-loss, path-race, crash, cancellation, and unsupported-platform cases.
7. Update docs, `IMPLEMENT.md`, and `CHANGELOG.md`.

Use short branches and conventional commit subjects. Explain why a dependency or trust-boundary change exists. Do not include AI attribution footers.

## Review order

First check spec compliance: does the change do exactly what was requested and preserve the current product contract? Then check code quality: edge handling, security, recovery, performance, and maintainability.

Native behavior must be tested on the native OS before support is claimed. Cross-target compilation is not runtime proof.
