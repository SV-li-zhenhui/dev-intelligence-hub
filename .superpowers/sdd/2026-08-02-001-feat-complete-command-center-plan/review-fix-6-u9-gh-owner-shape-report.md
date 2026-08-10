# Review Fix 6 Report — GitHub CLI owner shape

## Scope

- Base: `feat/controlled-code-executor` at `6c1305ef2347f13321e88a7ff75e0adb6deef784`.
- Changed `src/adapters/github-pull-request-facts.js` so the dedicated CLI-view owner object requires `login`, permits optional `id` and `name`, and rejects unknown keys.
- Changed `test/github-pull-request-facts.test.js` with a production-shaped fake that returns `{ login: "contributor" }` for both the initial and last-hop `gh pr view` target reads.
- Added this report. No other files were changed.
- No real GitHub account, repository, or PR was accessed. No `gh`, network, model, runtime-data/configuration, service restart, push, or external source mutation was invoked.

## TDD evidence

### RED — before the production edit

Command:

```powershell
node --test --test-concurrency=1 test/github-pull-request-facts.test.js
```

Result: exit code `1`; `16` tests, `15` passed, `1` failed.

Exact focused failure:

```text
✖ minimal CLI owner identity is accepted at both target reads
Error [GitHubPullRequestFactsError]: PR target response.headRepositoryOwner is invalid
code: 'GITHUB_PULL_REQUEST_FACTS_INVALID'
statusCode: 502
```

The failure originated at `githubViewPullRequestTarget` while parsing the first CLI target response, confirming that the old exact `id`/`name`/`login` key requirement caused the regression.

### GREEN — after the minimal production edit

Command:

```powershell
node --test --test-concurrency=1 test/github-pull-request-facts.test.js
```

Result: exit code `0`; `16` tests, `16` passed, `0` failed.

Command:

```powershell
node --test --test-concurrency=1 test/github-adapter.test.js test/github-pull-request-facts.test.js
```

Result: exit code `0`; `41` tests, `41` passed, `0` failed.

Commands:

```powershell
node --check src/adapters/github-pull-request-facts.js
node --check test/github-pull-request-facts.test.js
git diff --check
```

Result: all three exited `0`. `git diff --check` emitted only Git's existing working-copy line-ending warnings that LF will be replaced by CRLF for the two edited JavaScript files; it reported no whitespace errors.

### Optional full-suite command — non-evidence

`npm test` was not required by the brief and is not used as verification evidence. One optional invocation produced no captured test output and timed out after `124031` milliseconds with exit code `124`. A second optional invocation was interrupted while still running and produced no final result. Its status is unknown, and it was not retried again.

## Self-review

- The change is limited to the dedicated CLI owner parser. The separate GraphQL `headRepository { nameWithOwner }` exact contract is unchanged.
- `login` remains required and continues through the existing display-text, actor-login, and normalized Git-target validation. Missing or invalid login values still fail closed.
- The existing `dataMap` boundary remains in force, so proxies, accessors, arrays, custom prototypes, symbols, and non-enumerable/data-property violations are rejected without executing application-controlled getters or proxy traps.
- The explicit owner-key allowlist rejects unknown keys while allowing only the optional descriptive `id` and `name` fields alongside required `login`.
- Repository identity still derives only from validated owner `login` plus the strict CLI repository `name`; no fallback was added.
- Observing account, base/head repositories, refs, OIDs, and initial/last-hop atomic target comparisons are unchanged.
- No retry API, task-brain behavior, runtime authority, or unrelated refactor was introduced.
