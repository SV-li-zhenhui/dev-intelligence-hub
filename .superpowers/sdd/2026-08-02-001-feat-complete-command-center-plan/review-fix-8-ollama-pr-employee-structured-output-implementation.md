# Review fix 8 implementation report

## Implemented

- Added an independent Ollama generation schema that omits only
  `reviewBody.maxLength`; manual result validation retains the 8,000-character
  limit and strict single-document `JSON.parse` behavior.
- Added deterministic UTF-8/JSON-aware evidence packing against the longer
  retry prompt, with a 1,024-token output reserve, 512-token template allowance,
  and 64 KiB absolute message-content ceiling. Both attempts reuse the same
  effective context, fixed facts are never shortened, and any omitted evidence
  marks `patchTruncated: true`.
- Added trusted-only adapter errors for invalid model/API JSON, unexpected
  fields, and HTTP failures while preserving retry, admission, abort, timeout,
  redirect, and remote-context behavior.

## TDD evidence

RED against committed production code:

```text
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
tests 19; pass 9; fail 10
```

Expected failures proved the generation schema still contained `maxLength`,
`num_predict` was absent, a mixed synthetic request used 535,399 message bytes,
evidence fitting did not fence approval, an impossible context reached request
admission, and model/API/property/HTTP hostile markers leaked into errors.

GREEN:

```text
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
tests 19; pass 19; fail 0

node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js test/proactive-pr-employee.test.js test/proactive-pr-confirmation-integration.test.js
tests 80; pass 80; fail 0

node --check src/adapters/ollama-pr-employee-reviewer.js
exit 0

node --check test/ollama-pr-employee-reviewer.test.js
exit 0
```

All fixtures were synthetic. No network, GitHub, Ollama, MyDashboard runtime,
credentials, private configuration, or real pull request was accessed.

## Round 1 independent review closure

- Replaced the 256-byte patch reservation with deterministic evidence growth
  weights: 60% patch, 10% title, 10% files, and 20% description. Unused space
  is reclaimed in patch-first order. The default-context fixture now retains a
  unified-diff hunk, a changed line after 42 context lines, and file evidence.
- Removed the raw-context size serialization. Patch prefixes are measured and
  bounded incrementally by JSON-encoded UTF-8 bytes before any complete context
  is serialized; the 8 MiB synthetic probe observes no serialized context with
  a patch above the 64 KiB absolute ceiling.
- Added trusted transport translation for synchronous and asynchronous `fetch`
  rejection and removed timeout causes. External abort still returns the exact
  abort reason, while action-admission failures remain untranslated.

Round 1 RED against committed HEAD `ae3e51b`:

```text
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
tests 25; pass 19; fail 6
```

The failures showed the changed diff line was omitted, the full 8 MiB patch was
serialized during preprocessing, both transport markers were returned, and a
timeout exposed hostile nested causes. After the packing-only change, 21 tests
passed and only the four transport/timeout checks remained RED.

Round 1 GREEN:

```text
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
tests 25; pass 25; fail 0

node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js test/proactive-pr-employee.test.js test/proactive-pr-confirmation-integration.test.js
tests 86; pass 86; fail 0

node --check src/adapters/ollama-pr-employee-reviewer.js
exit 0

node --check test/ollama-pr-employee-reviewer.test.js
exit 0
```

## Round 2 retry-boundary closure

The fixed-context baseline now uses the selected context's actual
`patchTruncated` value. When a complete result can still end in `false`, the
fitter budgets that one-byte-longer JSON literal; when upstream evidence is
already truncated, the immutable shorter `true` representation remains exact.

Round 2 RED against committed HEAD `d18ddce`:

```text
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
tests 26; pass 25; fail 1
```

The retry request measured 1,484 system bytes and 426 user bytes, so its exact
conservative total was `1,484 + 426 + 512 + 1,024 = 3,446`, exceeding
`contextTokens=3,445` by one.

Round 2 GREEN uses the same effective user facts on both attempts:

```text
ordinary: 1,378 + 424 + 512 + 1,024 = 3,338 <= 3,445
retry:    1,484 + 424 + 512 + 1,024 = 3,444 <= 3,445

node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
tests 26; pass 26; fail 0

node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js test/proactive-pr-employee.test.js test/proactive-pr-confirmation-integration.test.js
tests 87; pass 87; fail 0

node --check src/adapters/ollama-pr-employee-reviewer.js
exit 0

node --check test/ollama-pr-employee-reviewer.test.js
exit 0
```

## Residual concern

The byte-per-token bound is intentionally conservative, so multilingual or
heavily escaped evidence may be omitted earlier than a tokenizer-specific
estimate would require. This is the safety tradeoff required to prevent prompt
prefix truncation without calling a model tokenizer. Patch retention remains
prefix-based rather than semantic diff parsing, so later hunks can still be
omitted when a patch exceeds its bounded allocation.
