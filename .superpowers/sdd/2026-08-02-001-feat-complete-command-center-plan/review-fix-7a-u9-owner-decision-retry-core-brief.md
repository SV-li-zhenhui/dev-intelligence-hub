# Review fix 7a — exact owner decision-retry core

## Context and split

The broader Review Fix 7 produced no edits before its implementation thread
was stopped. This 7a slice implements only the atomic service, composition
port, and trusted HTTP boundary. Review Fix 7b will add the Work-view control
after this core is independently approved. The final product scope is not
reduced.

Do not access network, GitHub, models, runtime data, or any real PR. Do not
restart or call the running service. Use fakes and temporary state only.

## Required design

1. Add `OwnerWorkRetryService` (or an equivalently narrow factory) with one
   public method `retryDecisionExhaustion(input)`. Its only ledger dependency
   has `readItemForReconciliation` and `transition`; reject partial or broader
   dependency assumptions.
2. Accept exactly `{ itemId, expectedRevision, expectedInputDigest }`.
   Validate a bounded item ID, positive revision, and lower-case 64-hex digest.
   Unknown/missing/accessor/proxy/custom-prototype input fails before ledger
   I/O.
3. Read the exact item and allow the transition only if all are true:
   - `kind === "source_root"` and `source.kind === "pull_request"`;
   - status is `blocked`, reason is exactly `decision_attempts_exhausted`;
   - revision and input digest equal the request;
   - owner, lease, active intent, and decision context are null;
   - source has no pending revision, active revision equals input revision,
     current input digest equals the item input digest, and current event/input
     binding is present.
   Reject not-found, stale, malformed source, legacy/cross-source markers, all
   delivery/intent/external failure reasons, and every other state before
   calling `transition`.
4. Call existing `transition` once with fixed trusted fields:

   ```text
   itemId: exact item ID
   expectedRevision: exact request revision
   leaseId: null
   toStatus: queued
   actorId: owner:local
   reason: owner_retry_decision_exhaustion
   details.code: decision_attempts_exhausted
   ```

   Never accept those fields from HTTP. Preserve attempt count and require the
   returned item to remain bound to the same ID/input digest with status
   `queued`, revision `expectedRevision + 1`, null lease/owner/intent, and the
   same attempt. An invalid transition result fails closed.
5. Compose a frozen least-authority application port exposing only
   `retryDecisionExhaustion`; do not expose the generic ledger or transition.
6. Add `POST /api/work/items/:itemId/retry-decision-exhaustion`. Require trusted
   same-origin JSON with exactly `expectedRevision` and
   `expectedInputDigest`; the path supplies item ID. Return only bounded fields
   needed by the caller. Signal background coordination only after successful
   durable retry. Stale/ineligible requests return fail-closed 4xx responses;
   missing capability returns 503.
7. Add RED/GREEN coverage for happy path, exact transition command/result,
   attempts preserved, malformed/untrusted/stale requests, every unsafe
   reason/state/source invariant, no transition on rejection, least-authority
   port shape, HTTP exactness, and post-success-only agency signaling.

## Required verification

```powershell
node --test --test-concurrency=1 test/owner-work-retry-service.test.js
node --test --test-concurrency=1 test/owner-work-retry-service.test.js test/work-ledger-service.test.js
node --test --test-concurrency=1 test/server.test.js test/composition-root.test.js
node --check src/services/owner-work-retry-service.js
node --check src/composition-root.js
node --check src/server.js
git diff --check
```

Do not run the whole suite. Commit locally without pushing as
`feat(work): add exact owner decision retry core`.

## Allowed write scope

- `src/services/owner-work-retry-service.js`
- `src/composition-root.js`
- `src/server.js`
- `test/owner-work-retry-service.test.js`
- `test/composition-root.test.js`
- `test/server.test.js`
- this task's report file

Stop with `NEEDS_CONTEXT` before editing another file.
