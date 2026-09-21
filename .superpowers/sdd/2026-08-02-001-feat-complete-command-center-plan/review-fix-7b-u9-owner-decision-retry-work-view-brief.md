# Review fix 7b — exact owner decision retry in the Work view

## Context and split

Review Fix 7a implemented and independently approved the least-authority
service and trusted same-origin endpoint for one exact
`decision_attempts_exhausted` PR source root. This slice adds only the Work-view
control described by the original Review Fix 7 brief. It does not broaden the
backend capability or reduce any remaining product scope.

Do not access network, GitHub, models, MyDashboard runtime data, credentials,
private configuration, or any real PR. Do not restart or call the running
service. Use synthetic projections and fake responses only.

## Required design

1. Add a fail-closed browser eligibility predicate for the public work-item
   projection. Show the control only when all publicly available invariants
   agree:
   - bounded non-empty `itemId`, positive safe `revision`, lower-case 64-hex
     `inputDigest`, and non-negative safe `attempt`;
   - `kind === "source_root"`, `status === "blocked"`, and `statusReason ===
     "decision_attempts_exhausted"`;
   - `ownerId`, `leaseId`, `leaseUntil`, `activeIntentId`, `decisionContext`,
     and `sourceQuarantine` are exactly null;
   - source kind is `pull_request`; positive `inputRevision` equals
     `activeRevision`; `pendingRevision` and `pending` are null;
   - source current event ID is bounded and agrees with its embedded event;
     current input digest equals the item digest; and at least one source
     binding matches the current event ID and active revision.

   Missing, malformed, accessor-backed, custom-prototype, or contradictory
   eligibility data must not create a button. This predicate is a presentation
   guard only; the approved backend service remains the sole authority.
2. Render one ordinary `<button type="button">` labelled “重新排队一次” inside
   an eligible work row. Reuse the existing secondary-action visual language
   and density; add no decorative animation. The DOM may carry only the item
   ID needed to find the current in-memory projection. Do not put revision,
   digest, source payload, actor, reason, or status authority into data
   attributes.
3. Add one controller method that re-finds the current item by ID and reruns
   the eligibility predicate immediately before mutation. It must submit only:

   ```text
   POST /api/work/items/:encodedItemId/retry-decision-exhaustion
   content-type: application/json
   x-mydashboard-action: 1

   { expectedRevision, expectedInputDigest }
   ```

   Never accept revision/digest/actor/reason/status from the button or caller.
4. Permit only one owner retry request at a time. Disable eligible controls
   while it is pending; the active control reads “正在重新排队…”. Programmatic
   or duplicate clicks while pending, ineligible, missing, or stale in local
   state must perform no fetch.
5. On success, clear local error state, reload the complete Work projection,
   and emit a concise notice that the item was requeued for system handling.
   On HTTP 409, clear the pending state, reload current state, and notify that
   the item changed; do not present the stale operation as successful. For
   other bounded failures, retain the current row and render an escaped inline
   `role="alert"` message. Starting a new attempt or an explicit Work reload
   clears an obsolete row error.
6. Sequence asynchronous mutations so a late response cannot overwrite a
   newer load or item state. Bind the rendered button in `createWorkView.bind`
   and also expose the narrow controller method for focused tests. Preserve all
   existing code-job detail, graph, load sequencing, and read-failure behavior.
7. Do not add a generic work transition, claim, dispatch, execute, model,
   source, GitHub, confirmation, or code-job route. This button performs no
   external action and grants no browser-side authority.

## Required RED/GREEN tests

Extend the focused Work-view test with synthetic records to prove:

- the exact eligible projection renders one labelled button, while each wrong
  status/reason/kind/source binding, pending source, occupied owner/lease,
  active intent/context, quarantine, malformed revision/digest/attempt, and
  malformed data shape renders none;
- the exact encoded URL, trusted headers, and two-field body come only from the
  current in-memory item, never caller/button authority;
- pending state disables duplicate and concurrent retries and exposes a clear
  loading label;
- success reloads and emits the system-handling notice; 409 reloads and emits a
  stale-state notice; another error is escaped in an inline alert;
- a late response cannot overwrite a newer Work load;
- existing newest-first reads, code-job controls, graph behavior, and static
  no-generic-execution assertions remain green.

Tests must demonstrate relevant RED failures before production edits.

## Required verification

```powershell
node --test --test-concurrency=1 test/frontend-work-view.test.js
node --test --test-concurrency=1 test/frontend-work-view.test.js test/frontend-work-graph-view.test.js
node --check public/work-view.js
node --check test/frontend-work-view.test.js
node scripts/validate-ui.mjs
git diff --check
```

If the UI validator requires a runtime or external service, stop and report
instead of contacting it. Do not run the whole suite. Commit locally without
pushing as `feat(work): add exact owner retry control`.

## Allowed write scope

- `public/work-view.js`
- `test/frontend-work-view.test.js`
- this task's implementation report file

Reuse existing styles. Stop with `NEEDS_CONTEXT` before editing another file.
