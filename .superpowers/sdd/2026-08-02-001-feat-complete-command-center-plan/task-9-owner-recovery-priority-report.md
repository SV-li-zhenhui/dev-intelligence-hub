# Task 9: Owner recovery priority report

## RED evidence

Command:

```text
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern "a manual employee run overtakes a queued scheduled role" test/server.test.js
```

Before the implementation, the focused test failed as expected: after the
active `requirements-analyst` scheduled role completed, the queued scheduled
`developer` role ran before the manual `pr-reviewer` run.

## Design invariant

`startApplicationBackgroundWork` now uses named FIFO lanes:
`fact_or_explicit` precedes `scheduled`, while `backgroundOperationActive`
allows only one fact/agency operation to execute. An active operation is never
interrupted. Scheduled cycles retain their fact-cycle sequence at request time,
so a later fact request still discards an obsolete queued scheduled cycle.

## Verification

- Focused RED command above: 1 failed with the expected ordering mismatch.
- Focused GREEN command above: 1 passed.
- Background-work block: 17 passed.
- `node --test --test-concurrency=1 --test-reporter=tap test/server.test.js`:
  112 passed.
- `node --check src/server.js`: passed.
- `node --check test/server.test.js`: passed.
- `git diff --check`: passed.
- Diff-scoped self-review: no residual correctness, serialization, FIFO, or
  stop/abort/drain concerns found.

## Changed files

- `src/server.js`
- `test/server.test.js`
- `.superpowers/sdd/2026-08-02-001-feat-complete-command-center-plan/task-9-owner-recovery-priority-report.md`

## Commit

`fix(background): prioritize explicit employee work`

## Concerns

None.
