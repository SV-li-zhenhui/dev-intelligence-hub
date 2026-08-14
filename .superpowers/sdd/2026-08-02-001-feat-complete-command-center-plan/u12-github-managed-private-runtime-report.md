# U12 GitHub managed private-runtime report

## Status

DONE

## Diagnosis

The failed managed startup logged `Private directory trust is unavailable` at
the parent inspection used by `createConfiguredGitHubCredentialSource`.
Read-only ACL inspection established that `C:\Users\<user>` has an additional
SID with inheritable write rights, while the manager-authenticated project
runtime directory is protected and grants full control only to the current
user, SYSTEM, and Administrators. No ACL was changed.

## RED

Focused command:

```powershell
node --test --test-reporter=tap --test-name-pattern "project-private managed runtime|authenticated private runtime directory|managed runtime identity" test/composition-root.test.js test/managed-process-control.test.js
```

Before the production correction, 0/2 matched top-level tests passed. The
credential factory still selected a home-directory root and managed startup
passed no private runtime directory to composition.

## Implementation

- Managed startup passes its authenticated runtime directory only into
  application composition.
- Application composition passes the directory to the configured GitHub
  credential factory only behind enabled GitHub confirmation execution.
- `gh-login` requires that directory to be absolute and project-digest-bound,
  then prepares the fixed `github-credentials-v1` child with the existing
  protected-root and exact-identity checks.
- `token-env` returns before any private-runtime validation or directory work.
- The obsolete home-directory dependency seam was removed.

## GREEN and verification

- Focused correction: 2 pass, 0 fail, 0 skip.
- Composition, managed process control, server, supervised CLI provider, and
  GitHub credential source: 316 pass, 0 fail, 2 documented Windows file
  symlink privilege skips.
- Four changed-file syntax checks and `git diff --check`: passed.

## Changed production/test files

- `src/composition-root.js`
- `src/server.js`
- `test/composition-root.test.js`
- `test/managed-process-control.test.js`

No home ACL mutation, real CLI/model call, credential read, GitHub action,
network write, or push occurred. Managed startup remains the next acceptance
gate.

## Review fix round 1

The independent review approved the task with no Critical or Important
finding and identified one Minor: validation for the removed `homeDirectory`
dependency was unreachable after the dependency allowlist change. Commit
`b40afda` removes only that dead branch. The full composition-root suite passed
84/84, and syntax/diff checks passed.
