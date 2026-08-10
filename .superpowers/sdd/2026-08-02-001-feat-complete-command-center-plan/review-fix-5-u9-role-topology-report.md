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

## Review Round 1

Baseline was commit `ee953d46571d45672283c15349f3d60e21438217` with a
clean worktree. All three Important findings were accepted as valid. Runtime
inspection stayed within the fake mirrored U9 test and confirmed that the
existing public/read models expose the required proof:

- work-ledger timeline records contain stable IDs, sequence, task ID, type,
  actor, staged-intent requester, and immutable PR Head binding;
- confirmation history contains confirmation ID/kind/status and the exact
  requesting role/work-item binding;
- graph deliveries contain deliverable/contract/delivery revisions and
  evidence descriptors, while Code Job details expose the matching job ID and
  memory record and the change-package receipt exposes package and controlled
  commit digests.

The inspection also found the concrete cause of finding 1: the previous
`listTimeline({ limit: 200 })` call was capped to one public page and returned a
non-null cursor before the Head-2 PR Engineer records.

### Round 1 RED

After asserting that the old timeline snapshot was complete, ran:

```powershell
node --test --test-concurrency=1 test/u9-mirrored-pr-end-to-end.test.js
```

Result: exit code `1`; shell duration `107.9 s`; Node reported `1` test, `0`
passed, `1` failed, and `duration_ms 105497.9868`. The expected failure was:

```text
actual: work-timeline-cacc09519a28c80e613b6c4d8c7028be7ff0ba190b7f676a38e58be797a03e0c
expected: null
```

This proves the old durable assertion did not include the complete timeline.

### Round 1 changes

- Read every timeline page through the public cursor and assert the complete
  record set survives restart unchanged.
- Prove both Head epochs contain PR Engineer-only claims and staged intents,
  ordered after tester delivery acceptance and bound to Head revision/OID.
- Assert every claim and graph-delivery submission on developer, tester, and
  PR-specific tasks has exactly the expected actor; no additional actor can
  satisfy the checks.
- Bind all eight confirmation-history records to exact task IDs, roles, kinds,
  and terminal statuses: developer modify Code Job, tester verification Code
  Job, four completed Head-1 GitHub actions, one stale Head-1 merge, and the
  completed Head-2 merge. The two deliberately blocked PR tasks are asserted
  to have no confirmation.
- Bind developer delivery revisions and change-package evidence to the actual
  package receipt/digest and controlled commit evidence. Bind tester delivery
  revisions and test-report evidence to the actual verification Code Job ID
  and persisted memory-record digest. Accepted evidence must exactly preserve
  the submitted evidence.

### Round 1 focused GREEN

```powershell
node --test --test-concurrency=1 test/u9-mirrored-pr-end-to-end.test.js
```

Result: exit code `0`; measured duration `112789 ms`; Node reported `1` test,
`1` passed, `0` failed, `0` skipped, and `duration_ms 112694.7552`.

No production defect or missing public/read field was found; `NEEDS_CONTEXT`
is not required.

### Round 1 required checks

```powershell
node --check test/u9-mirrored-pr-end-to-end.test.js
git diff --check
git diff --name-only
git status --short
git rev-parse HEAD
git merge-base HEAD ee953d46571d45672283c15349f3d60e21438217
```

- Syntax: exit code `0`, duration `83 ms`.
- Diff check: exit code `0`, duration `85 ms`, no errors (only the existing
  Git LF-to-CRLF working-copy notice).
- Scope: exactly this report and `test/u9-mirrored-pr-end-to-end.test.js` are
  modified; check duration `374 ms`; diff count is
  `2 files changed, 398 insertions(+), 53 deletions(-)`.
- `HEAD` and merge-base both equal
  `ee953d46571d45672283c15349f3d60e21438217` before the Round 1 commit.
