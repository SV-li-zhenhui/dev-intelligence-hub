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

## Residual concern

The byte-per-token bound is intentionally conservative, so multilingual or
heavily escaped evidence may be omitted earlier than a tokenizer-specific
estimate would require. This is the safety tradeoff required to prevent prompt
prefix truncation without calling a model tokenizer.
