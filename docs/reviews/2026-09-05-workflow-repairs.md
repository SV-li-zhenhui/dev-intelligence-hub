# Workflow reliability repairs — 2026-09-05

Scope: eight validated findings from the architecture review of `9525aaccd4b9e40f9b3d51a0201c66caf41c91cb`. Changes are on `feat/automation-test-library`; no GitHub action or production task was executed to validate them.

## Repair matrix

| Finding | Repair | Regression evidence |
| --- | --- | --- |
| 1. Browser-only Review handoff can disappear | Save selection with the executing confirmation, then recover completed Reviews through an idempotent server-side local request. Show durable handoff status in confirmation history. | Lost responses, restart, crash after submit, unchanged idempotency key, no dispatch for unknown/rejected/stale outcomes. |
| 2. Cancellation poisons shared CLI credentials | Give recovery a separate bounded deadline; await actual runner settlement before capture and cleanup. | Safe cancellation and timeout permit the next credential lease; unprovable reaping remains fenced. |
| 3. Truncated file reads permit destructive replacement | Preserve truncation and require a complete read in the actual packed model context before binding an overwrite hash. | ASCII/UTF-8 truncation, packed/omitted context, unsafe prepared writes; small complete reads and create-only writes remain supported. |
| 4. Unknown/sealed confirmations violate handler schema | Accept strictly validated resolution metadata, keep polling unresolved unknown results, settle owner-sealed results as rejected without replay. | Real confirmation queue plus proposal runtime: unknown → waiting confirmation → owner seal → terminal result, exactly one external executor invocation. |
| 5. A rejected PR cutover stalls every role | Recognize narrowly verified completed-root cutovers; isolate only pre-commit graph-transition rejection while preserving the intake cursor. | Actual snapshot replay consumed 40 envelopes, cursor 4595 → 4635, in memory only; valid queued work continues after rejected intake. |
| 6. Unrelated task updates invalidate scoped decisions | Rebase only advancing global graph metadata with validated hashes and identical scoped inputs. Treat authentic pre-write contention separately from business failures. | Unrelated root changes proceed; local evidence/input changes, rollback and forged conflicts reject; repeated contention does not consume the business attempt budget. |
| 7. Failed CLI turns lose session progress | Capture the bound session after safely reaped failures, including first-turn IDs from private bounded output. Retain unidentified rollouts for recovery. | Same entity resumes the saved session; partial final output is tolerated only during failure recovery; public errors do not expose output. |
| 8. Waiting prefixes starve later conditions | Rotate the bounded condition scan after the last examined item, including invalid and unmet conditions. | A due 51st task is reached after 50 waiting tasks; wrap, removal and empty queue cases pass. |

## Safety boundaries retained

- Unknown external outcomes are never automatically replayed. Sealing records an owner decision, not proof of publication.
- Handoffs require a confirmed completed Review, and re-read current PR facts through the existing owner-request service.
- Graph, task, source, input, evidence, lease, owner and write-hash checks remain enforced.
- A CLI process whose exit cannot be proved remains fenced. Unarchived session history is retained and surfaced for operator recovery.
- Large files that cannot fit completely in the model context are paused for whole-file replacement. This change does not add paginated reads or large-file patch editing.

## Verification

Focused regression suites pass for the ledger/graph, orchestration, CLI/session/broker, controlled code worker, confirmation/handler, handoff runtime and frontend contracts. The two application-close tests now advance both mock-clock phases and retain their original real-time close bounds.

Full repository regression at `03e6b88bec`: **3937 tests, 3922 passed, 12 skipped, 3 failure records**, in 600 seconds. The failure records represent two distinct Windows integration cases (one also fails its parent test):

- `manage-mydashboard.integration.test.js`: authenticated unexpected-exit recovery reported remaining descendants.
- `windows-codex-credential-file.test.js`: the racing source-replacement case failed its allowed-outcome assertion.

Both cases passed when rerun together with test concurrency 1: **3 passed, 0 failed, 2 capability skips**. Their implementation and tests were not changed by these repairs. This is not evidence of a clean full-suite run; concurrency-sensitive Windows integration coverage remains a verification limitation.

Final review additionally reproduced and fixed a recovery diagnostic being overwritten by a later credential-capture timeout. The retained-session diagnostic now takes precedence so the owner is told to preserve history.

Final checks:

- Five-file CLI/provider/runner/session-store/broker regression: exit 0 after the final diagnostic fix.
- Retained-session diagnostic and both bounded application-close cases: 3 passed, 0 failed.
- Distribution and clean-source installation/composition checks: 19 passed, 0 failed, in 51 seconds.
- JavaScript syntax checks for the changed frontend and new handoff modules, plus `git diff --check`: passed.

No lint or typecheck command is configured in `package.json`.

## Deployment and acceptance limits

This repair does not establish that production employees have completed a real development → test → push → Review cycle. Production service startup, real model execution, repository build profiles and human-approved GitHub writes require separate operational acceptance. The reviewed configuration had only repository-preflight profiles, not a proven Qt/application test suite. Historical unknown outcomes and unsafe cleanup fences were not silently reset. The production `127.0.0.1:4173/api/live` check was unavailable during this repair; the production service was not restarted.
