# Current work

This list records release gates, not speculative features.

- [ ] Finish the full refit validation suite without open handles or hung processes.
- [ ] Prove the final installed Linux `deb` and `rpm` packages through the UI workflow.
- [ ] Add native macOS signing, notarization, immutable-root attestation, package smoke tests, and runtime proof before claiming support.
- [ ] Add native Windows Authenticode, Program Files ACL attestation, package smoke tests, and runtime proof before claiming support.
- [ ] Replace placeholder branding assets before public release if they remain in the package.
- [ ] Review and close dependency audit findings through tested upgrades, never suppression.
- [ ] Materialize the validated refit into the published checkout only after every gate is green.

Feature requests come after the data-safety and release contracts pass. Duplicate detection, format conversion, metadata editing, cloud upload, archive extraction, and auto-update are not current capabilities.
