## Summary

Describe the user-visible or operational change and why it is needed.

## Verification

- Tests run:
- Manual checks:
- Relevant failure or recovery cases:

## Trust-boundary review

- [ ] No credentials, private source, personal data, local paths, logs, screenshots, memory, or backup payloads are included.
- [ ] New model, data-class, repository, tool, or external-action authority is documented and denied by default.
- [ ] External and irreversible actions still require an explicit, revision-bound owner confirmation.
- [ ] Stale state, changed Git Heads, retries, restarts, and partial failures fail closed or recover deterministically.
- [ ] User-facing documentation and safe example configuration are updated when behavior changes.
- [ ] `npm test` passes, or the exact failure and its scope are documented here.

## Related work

Link the issue, plan, or decision record that defines the change.
