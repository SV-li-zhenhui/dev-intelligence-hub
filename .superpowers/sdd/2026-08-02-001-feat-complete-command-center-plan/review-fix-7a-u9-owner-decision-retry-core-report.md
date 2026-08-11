# Review fix 7a — owner decision-retry core report

## Scope and base

- Base HEAD: `84bce98710f58553b5e5f0d8b092a6c708832c2b`
- Implemented only the service, composition port, trusted HTTP boundary, tests,
  and this report.
- No UI, network, GitHub, model, runtime-data, real-PR, real-service, restart,
  push, or whole-suite operation was performed.

## RED evidence

### Service RED

Command:

```powershell
node --test --test-concurrency=1 test/owner-work-retry-service.test.js
```

Observed result before the service existed:

```text
Exit code: 1
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'src\services\owner-work-retry-service.js'
tests 1
pass 0
fail 1
```

### Composition RED

Command:

```powershell
node --test --test-concurrency=1 --test-name-pattern="enabled work coordination composes private runtimes into frozen application ports" test/composition-root.test.js
```

Observed result before composition wiring:

```text
Exit code: 1
tests 1
pass 0
fail 1
AssertionError: expected serviceOrder to include 'owner-work-retry'; it was absent
```

### HTTP RED

Command:

```powershell
node --test --test-concurrency=1 --test-name-pattern="owner decision retry HTTP boundary" test/server.test.js
```

Observed result before the route existed:

```text
Exit code: 1
tests 1
pass 0
fail 1
AssertionError: expected [403, 403, 415, 400, 400], received
[404, 404, 404, 404, 404]
```

## GREEN evidence

### Targeted service GREEN

```text
node --test --test-concurrency=1 test/owner-work-retry-service.test.js
Exit code: 0
tests 7
pass 7
fail 0
```

Covered exact input shape and hostile input rejection before I/O, exact
read/transition commands, happy path, preserved attempts, stale/not-found
bindings, unsafe reasons/states/source invariants, no transition on rejection,
and fail-closed transition-result validation.

### Targeted composition GREEN

```text
node --test --test-concurrency=1 --test-name-pattern="enabled work coordination composes private runtimes into frozen application ports" test/composition-root.test.js
Exit code: 0
tests 1
pass 1
fail 0
```

The injected service receives a frozen ledger capability containing exactly
`readItemForReconciliation` and `transition`. The application exposes a frozen
port containing exactly `retryDecisionExhaustion`.

### Targeted HTTP GREEN

```text
node --test --test-concurrency=1 --test-name-pattern="owner decision retry HTTP boundary" test/server.test.js
Exit code: 0
tests 1
pass 1
fail 0
```

Covered same-origin action trust, JSON content type, no query parameters,
exact body fields, path-owned item ID, stale 409 behavior, missing-capability
503 behavior, bounded response projection, and agency signaling only after a
successful durable retry.

## Required verification

```text
node --test --test-concurrency=1 test/owner-work-retry-service.test.js
Exit code: 0; tests 7; pass 7; fail 0

node --test --test-concurrency=1 test/owner-work-retry-service.test.js test/work-ledger-service.test.js
Exit code: 0; tests 182; pass 182; fail 0

node --test --test-concurrency=1 test/server.test.js test/composition-root.test.js
Exit code: 0; tests 178; pass 178; fail 0

node --check src/services/owner-work-retry-service.js
Exit code: 0

node --check src/composition-root.js
Exit code: 0

node --check src/server.js
Exit code: 0

git diff --check
Exit code: 0
```

`git diff --check` emitted only Git's working-copy LF-to-CRLF notices and no
whitespace errors.

## Implemented contract

- `OwnerWorkRetryService.retryDecisionExhaustion` accepts exactly `itemId`,
  `expectedRevision`, and `expectedInputDigest`, and rejects malformed,
  accessor, proxy, and custom-prototype input before ledger I/O.
- The service permits only the exact blocked PR source-root decision-exhaustion
  state and issues the fixed owner transition once.
- Transition results must preserve item/input identity and attempt count while
  returning queued revision `expectedRevision + 1` with no owner, lease,
  intent, or decision context.
- Composition grants the service only reconciliation read and transition, and
  grants HTTP only the exact retry method.
- `POST /api/work/items/:itemId/retry-decision-exhaustion` accepts trusted
  same-origin JSON with exactly the two request binding fields, returns only
  `itemId`, `inputDigest`, `status`, `revision`, and `attempt`, and signals
  background agency only after success.

## Files

- `src/services/owner-work-retry-service.js`
- `src/composition-root.js`
- `src/server.js`
- `test/owner-work-retry-service.test.js`
- `test/composition-root.test.js`
- `test/server.test.js`
- `.superpowers/sdd/2026-08-02-001-feat-complete-command-center-plan/review-fix-7a-u9-owner-decision-retry-core-report.md`

## Round 1 review fix — HTTP boundary gaps

Independent review identified missing HTTP coverage for malformed item IDs,
invalid or missing revisions and digests, non-object JSON bodies, and invalid
service projections.

### Round 1 RED

The owner HTTP test was expanded first with table-driven cases. Malformed
requests assert their exact 400/403/415 status, zero retry-port calls, and zero
agency signals. Invalid service projections assert HTTP 500, exactly one port
call needed to obtain the projection, and zero agency signals.

Command:

```powershell
node --test --test-concurrency=1 --test-name-pattern="owner decision retry HTTP boundary" test/server.test.js
```

Observed result against the existing implementation:

```text
Exit code: 1
tests 1
pass 0
fail 1
AssertionError [ERR_ASSERTION]: array projection
200 !== 500
```

This exposed a real fail-closed defect: `projectOwnerRetryResult` accepted an
array carrying valid-looking named fields. The minimum production fix added an
`Array.isArray` rejection to that projector.

### Round 1 GREEN

```text
node --test --test-concurrency=1 --test-name-pattern="owner decision retry HTTP boundary" test/server.test.js
Exit code: 0; tests 1; pass 1; fail 0

node --test --test-concurrency=1 test/server.test.js test/composition-root.test.js
Exit code: 0; tests 178; pass 178; fail 0

node --check test/server.test.js
Exit code: 0

node --check src/server.js
Exit code: 0

git diff --check
Exit code: 0
```

The first server/composition group run reached 177/178 and timed out only in
the unrelated offline CLI fixture `default non-versioned Code Job owns one real
offline CLI lifecycle`. No unrelated code was changed; the exact command was
rerun and passed 178/178.

Round 1 changed only:

- `src/server.js`
- `test/server.test.js`
- this report
