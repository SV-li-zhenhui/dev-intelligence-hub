# Review fix 7 — exact owner retry for safe decision exhaustion

## Context

The reviewed GitHub CLI owner-shape fix is running in production. A
MyDashboard-owned read-only refresh completed successfully, but the exact PR
source root that previously exhausted `ROLE_CONTEXT_PR_FACT_UNAVAILABLE`
attempts has no pending source revision and therefore remains durably blocked
with `statusReason: decision_attempts_exhausted`. The product has no owner UI
or HTTP capability to requeue that exact, side-effect-free failure after its
cause is repaired.

This task must add that narrow product capability. It must not inspect any real
PR payload, access GitHub/network/models, mutate runtime data directly, restart
the service, or execute the owner retry against real state. All task tests use
fakes or temporary local ledger state.

## Required behavior

1. Start with RED tests for a narrow owner retry service. A retry is eligible
   only when the item is the current pull-request `source_root`, is exactly
   `blocked` for `decision_attempts_exhausted`, has no owner/lease/active
   intent/decision context, has no pending source revision, has matching active
   and input source revisions, and its item input digest matches the current
   source input digest.
2. Bind the request to an exact `itemId`, positive `expectedRevision`, and
   64-hex `expectedInputDigest`. Reject stale revision/digest, malformed or
   extra fields, legacy/cross-source markers, pending source cutover, child or
   non-PR work, every other blocked reason (especially delivery/intent/external
   failures), and non-blocked/terminal work before any transition call.
3. Reuse the existing ledger `blocked -> queued` transition with fixed trusted
   values: actor `owner:local`, reason `owner_retry_decision_exhaustion`, no
   lease, and no browser-supplied status/actor/reason/details. Preserve the
   cumulative attempt count so one owner retry grants one fresh claim rather
   than silently resetting the retry budget.
4. Expose only this method from a frozen least-authority application port. Do
   not expose the ledger or generic `transition` port to HTTP/browser code.
5. Add one trusted same-origin JSON endpoint for the exact item. Require only
   `expectedRevision` and `expectedInputDigest`, return a bounded result, map
   stale/ineligible cases to fail-closed HTTP errors, and signal background
   coordination only after a successful durable requeue.
6. In the Work view, render “重新排队一次” only for a locally projected item
   that meets the public eligibility fields. Submit its exact revision/digest,
   disable duplicate clicks while pending, handle 409 by reloading current
   state, show a clear error/notice, and never offer retry for another blocked
   reason.
7. Preserve all existing confirmation, source-cutover, graph, memory, and
   external-action boundaries. This local retry performs no GitHub action,
   model request, code execution, source mutation, or confirmation approval.

## TDD and verification

Record RED before production edits, then run at least:

```powershell
node --test --test-concurrency=1 test/owner-work-retry-service.test.js
node --test --test-concurrency=1 test/owner-work-retry-service.test.js test/work-ledger-service.test.js test/work-ledger-runtime.test.js
node --test --test-concurrency=1 test/server.test.js test/composition-root.test.js test/frontend-work-view.test.js
node --check src/services/owner-work-retry-service.js
node --check src/composition-root.js
node --check src/server.js
node --check public/work-view.js
git diff --check
```

Do not run the whole suite in this task. Commit locally without pushing.
Suggested message: `feat(work): add exact owner retry for decision exhaustion`.

## Allowed write scope

- `src/services/owner-work-retry-service.js`
- `src/composition-root.js`
- `src/server.js`
- `public/work-view.js`
- `test/owner-work-retry-service.test.js`
- `test/composition-root.test.js`
- `test/server.test.js`
- `test/frontend-work-view.test.js`
- this task's report file

If another file is required or the existing transition cannot preserve these
invariants, stop with `NEEDS_CONTEXT` and report the exact reason.
