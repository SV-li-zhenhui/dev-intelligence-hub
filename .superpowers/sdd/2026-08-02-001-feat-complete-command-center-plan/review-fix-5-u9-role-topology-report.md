# Review fix 5 — U9 role-topology report

## Scope and baseline

- Repository `HEAD`: `d6ddaf38f829297204f9441c48d8d5527c72423c`
- Required base: `d6ddaf38f829297204f9441c48d8d5527c72423c`
- `git merge-base HEAD d6ddaf38f829297204f9441c48d8d5527c72423c`:
  `d6ddaf38f829297204f9441c48d8d5527c72423c`
- Initial `git status --short`: no output (clean worktree).
- Changed files (final intended scope):
  `test/u9-mirrored-pr-end-to-end.test.js` and this report only.

## RED evidence

Before changing the fixture or decision model, added topology assertions that
require `development` to resolve to `developer`, `pr-review` to resolve to
`pr-engineer`, and a distinct developer worker/task brain.

Command:

```powershell
node --test --test-concurrency=1 test/u9-mirrored-pr-end-to-end.test.js
```

Result: exit code `1`; shell duration `5.6 s`; Node reported `1` test, `0`
passed, `1` failed, and `duration_ms 2903.936`. The expected assertion failure
was at `test/u9-mirrored-pr-end-to-end.test.js:1235:12`:

```text
+ actual - expected
+ 'pr-engineer'
- 'developer'
```

This establishes that the original mirrored topology routed development to the
PR Engineer rather than to a distinct developer.

## Fixture/scenario change

- Added a `developer` role with worker ID `employee-developer`, routine model
  `routine-developer`, and its own strong task-brain model.
- Gave the orchestrator, PR Engineer, developer, and tester distinct worker and
  task-brain identities in the fixture.
- Aligned policy to `coordination=orchestrator`, `development=developer`,
  `testing=tester`, and `pr-review=pr-engineer`.
- Restricted code actions to developer (`modify`) and tester (`verify`); GitHub
  review authority remains PR Engineer-only.
- Moved conflict Code Job proposal/submission to the developer. PR-specific
  external-action children (including stale-Head rejection and Head-2 merge)
  now use `pr-review` and are handled by the PR Engineer.
- Added durable assertions over graph task responsibility/dependency/delivery
  history, ledger timeline handoff/claims/owner acceptance, confirmation
  identities, Head supersession, and post-restart graph/timeline recovery.

The final graph proof includes a developer-owned conflict task with submitted
then accepted change-package delivery; a tester-owned verification task that
depends on it and has submitted then accepted test-report delivery; and
PR-Engineer-owned external tasks. It also retains the original temporary Git
mirror, fixed source binding, fake transport, one-at-a-time confirmations,
unknown-result recovery, memory citations, and duplicate-effect assertions.

## Verification

Focused green run:

```powershell
node --test --test-concurrency=1 test/u9-mirrored-pr-end-to-end.test.js
```

Result: exit code `0`; shell duration `120.0 s`; Node reported `1` test, `1`
passed, `0` failed, `0` skipped, and `duration_ms 117420.7202`.

Syntax:

```powershell
node --check test/u9-mirrored-pr-end-to-end.test.js
```

Result: exit code `0`; duration `88 ms`.

Whitespace:

```powershell
git diff --check
```

Result: exit code `0`; duration `86 ms`; no output.

Final syntax, whitespace, and scope checks (with the report present):

```powershell
node --check test/u9-mirrored-pr-end-to-end.test.js
git diff --check
git diff --name-only
git status --short
```

Result: syntax exit code `0` in `85 ms`; whitespace exit code `0` in `84 ms`;
the report is ignored by the repository's normal status output and will be
force-added for the required local commit. The intended and committed scope is
only `test/u9-mirrored-pr-end-to-end.test.js` and this report.

After adding the ignored report to Git's intent-to-add index, `git diff --check`
again exited `0` in `75 ms`; `git diff --name-only` listed exactly those two
allowed files.
