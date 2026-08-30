# Troubleshooting

## Runtime health blocks preview

Run:

```bash
npm run package:stage-tools
npm run package:integrity
```

If a production package reports a writable or unauthenticated tool root, reinstall it through the supported system package. Do not copy the application into a home directory or bypass the trust check.

## Source and destination rejected

Choose separate real directories. Neither may contain the other. Symlinked roots, hard-linked source media, special files, and path aliases are rejected.

## File goes to `_Needs Review`

The creation-date evidence was missing, weak, or conflicting. Inspect the preview evidence and keep the file there until a human can resolve it. META Mover will not invent a date.

## Preview expires or execution reports drift

A source file, source directory, target, or root changed after preview. Generate a new preview. Do not retry an old preview after modifying either tree.

## Move leaves a source or residue

The transaction preserved data because deletion could not be proved. Check the job history, evidence manifest, and `.meta-mover` recovery state under the destination. Do not manually delete the source until hashes and receipt state are reconciled.

## Build or clean install fails

Confirm Node.js 22.12+, npm 10.9, Rust 1.85.1, and the native compiler toolchain. Use `npm ci`, not `npm install`, so the tested lock graph remains intact.

## Report a bug

Include OS, architecture, install format, app version, operation mode, exact error, preview warnings, and redacted logs. Never attach private media to a public issue.
