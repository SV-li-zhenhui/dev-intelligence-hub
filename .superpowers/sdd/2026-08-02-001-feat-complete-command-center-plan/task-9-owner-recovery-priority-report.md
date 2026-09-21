# Task 9: Owner recovery priority report

## RED evidence

Command:

```text
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern "a scheduled role requested after refresh in the same turn uses refreshed facts" test/server.test.js
```

Against `c69789a` with only the new test added, the focused test failed as
expected: refresh and its `refresh_completed` recovery ran, but the later
same-turn scheduled `developer` request was incorrectly discarded. The first
RED runner remained alive after reporting the assertion. On resumed process
inspection PID 23672 had exited, and repeated audits found no remaining
`server.test.js` process.

## Design invariant

`startApplicationBackgroundWork` keeps fact generation changes behind
operational admission: `enqueueFactCycle` increments `factCycleSequence`, and
an agency cycle captures that sequence inside its admitted operation,
immediately before queueing. Promise/admission order therefore distinguishes
refresh-before-scheduled from scheduled-before-refresh without allowing a
rejected refresh or mutation to reserve a generation. The named FIFO priority
lanes and single active background operation remain unchanged.

## Verification

- Focused RED command above: 1 failed with the expected missing scheduled run.
- Bounded focused ordering/lifecycle run: 3 passed in 401 ms (15 s deadline).
- Bounded background-work block: 18 passed in 541 ms (15 s deadline).
- `node --test --test-concurrency=1 --test-reporter=tap test/server.test.js`:
  113 passed in 1.487 s under a 20 s process-tree deadline.
- `node --check src/server.js`: passed.
- `node --check test/server.test.js`: passed.
- `git diff --check`: passed.
- Final process audit: no `server.test.js` Node process remained.
- Diff-scoped review: no residual admission, serialization, FIFO,
  stop/abort/drain, or error-path concerns found.

## Changed files

- `src/server.js`
- `test/server.test.js`
- `.superpowers/sdd/2026-08-02-001-feat-complete-command-center-plan/task-9-owner-recovery-priority-report.md`

## Commit

`fix(background): preserve admitted fact request order`

## Concerns

None.
