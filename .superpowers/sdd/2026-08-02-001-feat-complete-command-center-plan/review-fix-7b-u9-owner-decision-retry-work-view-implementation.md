# Review fix 7b implementation report

## Implemented

- Added a fail-closed Work-view eligibility guard for the exact blocked
  `source_root` projection whose PR decision attempts are exhausted. The guard
  validates bounded IDs, revision/digest/attempt bindings, unoccupied ownership
  and lease state, absent intent/context/quarantine state, the active PR source
  revision, current event and digest agreement, and a matching source binding.
  Missing fields, accessors, custom prototypes, malformed arrays, and
  contradictory values suppress the control.
- Rendered one existing-style secondary button labelled `重新排队一次`. Its only
  DOM authority is the work-item ID. While a request is in flight, all eligible
  controls are disabled and the active control reads `正在重新排队…`.
- Added the narrow `retryDecisionExhaustion(itemId)` controller method. It
  re-finds and revalidates the current in-memory item and submits only the
  trusted POST route, action/content headers, expected revision, and expected
  input digest.
- Serialized owner retries independently from projection loads. Success and
  conflict reload the complete Work projection and emit distinct notices;
  bounded non-conflict failures stay on the row as escaped alerts. Explicit
  reloads clear obsolete errors, and superseded mutation responses cannot
  replace newer Work state or enable a concurrent retry.

## TDD evidence

Baseline before test or production changes:

```text
node --test --test-concurrency=1 test/frontend-work-view.test.js
tests 23; pass 23; fail 0
```

RED against starting production HEAD `1dcc080`:

```text
node --test --test-concurrency=1 test/frontend-work-view.test.js
tests 32; pass 23; fail 9
```

The expected failures showed that no eligible button rendered, `bind` did not
register it, and the narrow retry method did not exist. The 23 pre-existing
tests remained green.

Diff inspection then identified the reload-during-request concurrency edge. A
focused regression assertion failed before its implementation change:

```text
node --test --test-concurrency=1 test/frontend-work-view.test.js
tests 32; pass 31; fail 1
expected one POST; observed two POSTs
```

Final GREEN:

```text
node --test --test-concurrency=1 test/frontend-work-view.test.js
tests 32; pass 32; fail 0

node --test --test-concurrency=1 test/frontend-work-view.test.js test/frontend-work-graph-view.test.js
tests 41; pass 41; fail 0

node --check public/work-view.js
exit 0

node --check test/frontend-work-view.test.js
exit 0
```

All new fixtures and responses are synthetic. No network, GitHub, model,
MyDashboard runtime, Ollama, credential, private configuration, or real pull
request was accessed.

## UI validator boundary

`node scripts/validate-ui.mjs` was intentionally not run in this implementation
session. The controller separately observed that invoking it without receipt
arguments fails immediately with `UI validation command arguments are
invalid`. Static inspection confirms that a valid invocation requires supplied
live-service/receipt context and then verifies and fetches the dashboard at
`http://127.0.0.1:4173`, launches browser scenarios against that service, and
writes validation artifacts. No arguments or runtime inputs were invented to
bypass those gates because doing so would violate this task's explicit runtime
and write boundaries.

## Round 1 review closure

- Retry eligibility for every row is now captured before any ordinary row
  presentation field is read. Ordinary top-level fields are rendered only from
  descriptor-inspected data, so a self-replacing accessor cannot turn itself
  into an eligible projection during rendering. The controller still reruns
  eligibility against the current in-memory item immediately before mutation.
- Rendering and controller lookup now share one fresh eligibility pass that
  counts eligible item IDs. Every binding for a duplicated eligible ID is
  rejected, so contradictory revision/digest authorities cannot render a
  control or be selected by first-match lookup.

Round 1 RED against committed HEAD `e59cd43`:

```text
node --test --test-concurrency=1 test/frontend-work-view.test.js
tests 33; pass 32; fail 1
self-replacing status getter calls: expected 0; observed 1

node --test --test-concurrency=1 test/frontend-work-view.test.js
tests 34; pass 33; fail 1
ambiguous owner retry controls: expected 0; observed 2
```

Each regression invokes `retryDecisionExhaustion(itemId)` before asserting and
also requires zero POST requests. The accessor and duplicate-ID production
changes were made only after their respective RED run.

Round 1 GREEN:

```text
node --test --test-concurrency=1 test/frontend-work-view.test.js
tests 34; pass 34; fail 0

node --test --test-concurrency=1 test/frontend-work-view.test.js test/frontend-work-graph-view.test.js
tests 43; pass 43; fail 0

node --check public/work-view.js
exit 0

node --check test/frontend-work-view.test.js
exit 0
```

The live UI validator remained intentionally unrun for round 1; no runtime or
receipt arguments were invented or bypassed.

## Residual concerns

- Browser-level visual validation was not available under the no-runtime
  boundary. Rendering, event binding, loading labels, disabled states, and
  escaped alerts are covered through the focused synthetic frontend tests.
- The browser guard intentionally duplicates the approved backend eligibility
  invariants as a presentation safeguard. The backend service remains the sole
  mutation authority if the public projection contract changes.
