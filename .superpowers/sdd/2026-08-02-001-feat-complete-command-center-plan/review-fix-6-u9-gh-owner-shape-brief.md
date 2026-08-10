# Review fix 6 — accept the valid GitHub CLI owner shape

## Context

MyDashboard can discover PR list-level atomic Git targets, but the full
review-facts loader rejects a valid `gh pr view --json headRepositoryOwner`
payload when GitHub CLI omits the owner's optional `id` and `name` fields and
returns only the required `login`. The current dedicated CLI-view parser uses
an exact `id`/`name`/`login` key set, so the PR Engineer records
`ROLE_CONTEXT_PR_FACT_UNAVAILABLE` before persisting full read facts.

This task is local/fake only. Do not call `gh` against any real repository or
PR, inspect PR #23178, invoke a model, restart the service, or perform any
GitHub/source mutation.

## Required behavior

1. Add a focused RED regression using production-shaped fake `gh` JSON where
   `headRepositoryOwner` is the plain data object `{ login: "contributor" }`
   for both the initial and last-hop target reads. The current implementation
   must fail with `GITHUB_PULL_REQUEST_FACTS_INVALID` before the fix.
2. Treat `login` as required and `id`/`name` as optional for this dedicated
   CLI owner object. Continue rejecting missing `login`, unknown keys,
   proxies, accessors, arrays, custom prototypes, and invalid login/target
   values without executing application-controlled getters or traps.
3. Preserve the separate strict GraphQL contract
   `headRepository { nameWithOwner }`; do not add cross-boundary fallbacks.
4. Preserve exact atomic target and last-hop comparison for observing account,
   base/head repositories, refs, and OIDs. An omitted descriptive owner field
   must not weaken repository identity.
5. Keep the change narrow. Do not add a blocked-work retry API, change task
   brain behavior, touch runtime data/configuration, or widen GitHub authority
   in this task.

## TDD and verification

Record RED before production edits, then run at least:

```powershell
node --test --test-concurrency=1 test/github-pull-request-facts.test.js
node --test --test-concurrency=1 test/github-adapter.test.js test/github-pull-request-facts.test.js
node --check src/adapters/github-pull-request-facts.js
node --check test/github-pull-request-facts.test.js
git diff --check
```

Commit locally without pushing. Suggested message:
`fix(github): accept minimal CLI owner identity`

## Allowed write scope

- `src/adapters/github-pull-request-facts.js`
- `test/github-pull-request-facts.test.js`
- this task's report file

If the required behavior needs another production file or reveals a different
defect, stop with `NEEDS_CONTEXT` and report the exact reason.
