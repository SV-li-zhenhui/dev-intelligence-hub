# Review fix 7a — owner decision-retry core independent re-review

## Review target

- Brief: `review-fix-7a-u9-owner-decision-retry-core-brief.md`
- Fixed range: `84bce98710f58553b5e5f0d8b092a6c708832c2b..d8442bbcf448a8e3c63711f562a566e868365ec8`
- Fixed package: `review-84bce98..d8442bb.diff`
- SHA-256: `1C0702925C85EB8D6D87F65143AEC0784E12BEBEFB75647F8DE5533A60932C79`

## Independent verdict

`APPROVED`

- Critical: 0
- Important: 0
- Minor: 0

The initial review found one Important HTTP coverage gap. Round 1 added exact
malformed-item, revision, digest, JSON-body, and invalid-projection cases with
port-call and agency-signal assertions. The new RED exposed that an array with
named fields could pass the HTTP result projector; the production boundary now
rejects arrays before projection.

The re-review verified the cumulative immutable package and confirmed the
finding closed with no remaining findings. It covered exact eligibility and
stale bindings, hostile inputs, preserved attempts, fixed transition authority,
least-authority composition, trusted same-origin HTTP input, bounded response
projection, exact status mappings, and post-durable-success-only agency
signaling. The review was read-only and used no network, model, runtime data,
GitHub operation, or real PR.

## Controller verification

The controller independently ran:

```powershell
node --test --test-concurrency=1 test/owner-work-retry-service.test.js
node --test --test-concurrency=1 test/owner-work-retry-service.test.js test/work-ledger-service.test.js
node --test --test-concurrency=1 --test-name-pattern="owner decision retry HTTP boundary" test/server.test.js
node --test --test-concurrency=1 test/server.test.js test/composition-root.test.js
node --check src/services/owner-work-retry-service.js
node --check src/composition-root.js
node --check src/server.js
node --check test/server.test.js
git diff --check 84bce98..d8442bb
```

The service passed 7/7, the service-plus-ledger group passed 182/182, the
focused HTTP case passed 1/1, and the server-plus-composition group passed
178/178. Syntax and fixed-range whitespace checks passed, and the worktree was
clean at the reviewed Head.
