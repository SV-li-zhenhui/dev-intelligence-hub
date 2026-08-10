# Review fix 8 — Ollama PR employee structured output and prompt budget

## Context and evidence

The owner authorized installation of the locally cached, Authenticode-valid
Ollama 0.32.6 update and synthetic-only structured-output verification. The
runtime now reports 0.32.6 and has rehydrated the existing local model store.
No real PR, GitHub operation, remote model, or MyDashboard runtime request is
part of this implementation task.

Synthetic probes established two independent failures in the legacy PR
employee adapter:

1. Ollama 0.32.6 rejects the current generation grammar because
   `RESULT_SCHEMA.properties.reviewBody.maxLength` is 8,000. The same schema
   without only that generation-time keyword is accepted and yields exact
   JSON. The 8,000-character limit remains a MyDashboard business invariant.
2. An oversized user message can cause local Ollama to discard the beginning
   of the rendered prompt, including trusted system and mode instructions.
   The adapter currently sends an unbounded patch and reserves no output
   window.

The prior user-visible parse error also echoed model prose from
`JSON.parse(...).message`. That content is untrusted and must not enter a
persisted or user-facing error.

## Safety boundary

Do not access network, GitHub, models, runtime data, credentials, private
configuration, or any real PR. Do not restart or call Ollama or MyDashboard.
Use fakes and synthetic strings only. Do not loosen parsing, extract JSON from
Markdown, or accept fields outside the existing result contract.

## Required design

1. Keep the existing full result schema as the authoritative business
   validation contract, including `reviewBody.maxLength === 8_000`. Add a
   separate Ollama generation schema that differs from the full schema only by
   omitting `reviewBody.maxLength`. Use the generation schema both in
   `format` and in the trusted system prompt. Do not mutate or alias the full
   schema in a way that can weaken manual validation.
2. Continue to parse exactly one complete JSON document with `JSON.parse` and
   apply all existing field, mode, unexpected-field, approval, and truncated
   evidence checks. Results whose review body exceeds 8,000 characters must
   still fail both attempts. Do not add fence stripping, substring extraction,
   repair, coercion, or Markdown fallbacks.
3. Set an explicit, fixed maximum output of 1,024 tokens with Ollama's native
   `options.num_predict`, alongside the configured `num_ctx`. Reserve those
   output tokens plus a conservative fixed chat-template allowance before
   admitting message content. The total UTF-8 byte length of the actual system
   and user message content must be used as a conservative upper bound on
   prompt tokens; include the JSON escaping present in the actual user message.
   Keep an absolute prompt byte ceiling so even a very large configured context
   cannot create an unbounded request.
4. Fit one deterministic effective context against the longer retry prompt,
   then send that exact same evidence context on both attempts. The normal
   attempt may use the shorter prompt but must not receive different evidence.
   Prove for both attempts that:

   ```text
   system-message UTF-8 bytes
   + user-message UTF-8 bytes
   + fixed chat-template token allowance
   + 1,024 output tokens
   <= configured contextTokens
   ```

   Because each non-special token consumes at least one input byte, this is a
   deliberately conservative no-truncation bound. A configuration too small
   for the retry system prompt plus a minimal facts object must fail clearly
   before action admission or `fetch`.
5. Preserve fixed identity/binding/status/mode facts exactly. Deterministically
   fit only bounded untrusted review evidence (`title`, `description`, `files`,
   and `patch`), with patch evidence receiving useful nonzero capacity whenever
   the configured context can support it. Truncate only on Unicode code-point
   boundaries. If the upstream patch was already truncated, or any review
   evidence is omitted or shortened by this packer, the exact sent context must
   have `patchTruncated: true`; consequently an `approve` result remains
   inadmissible. Never claim the original input was complete after fitting.
6. Validate results against the exact effective context that was sent, not the
   pre-budget input. Retry admission fencing, external abort identity, timeout
   behavior, redirect policy, remote-code opt-in, and the existing two-attempt
   limit must remain unchanged.
7. Sanitize failure messages at the adapter boundary. Invalid model JSON,
   malformed API JSON, HTTP response bodies, arbitrary unexpected property
   names, and model prose must never be copied into the final error. Retain
   bounded trusted diagnostics such as provider, HTTP status, contract field
   names, mode, timeout, and the fact that JSON/result validation failed.

## Required RED/GREEN tests

Extend only the focused adapter tests to prove:

- the request generation schema omits only `reviewBody.maxLength`, while the
  manual parser still rejects a review body longer than 8,000 characters;
- `num_predict` is 1,024 and both ordinary and retry message sets satisfy the
  conservative context equation;
- a large synthetic ASCII/Chinese/emoji/quote/backslash/newline input is
  packed deterministically under the same bound without broken Unicode or
  invalid embedded JSON;
- fixed binding/status/mode facts survive byte pressure, omitted evidence sets
  `patchTruncated: true`, and an attempted approval is retried/rejected;
- both attempts receive the same effective user facts even though the second
  system prompt includes the correction instruction;
- a context window too small for trusted fixed content fails before admission
  and before `fetch`;
- Markdown/prose invalid JSON, invalid API JSON, hostile unexpected property
  names, and hostile HTTP bodies cannot appear in thrown errors;
- existing action-admission cutover and external-abort tests continue to pass.

Tests must first demonstrate the relevant RED failures against the current
implementation. Keep test fixtures synthetic and bounded.

## Required verification

```powershell
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js test/proactive-pr-employee.test.js test/proactive-pr-confirmation-integration.test.js
node --check src/adapters/ollama-pr-employee-reviewer.js
node --check test/ollama-pr-employee-reviewer.test.js
git diff --check
```

Do not run the whole suite. Commit locally without pushing as
`fix(ollama): bound PR employee structured requests`.

## Allowed write scope

- `src/adapters/ollama-pr-employee-reviewer.js`
- `test/ollama-pr-employee-reviewer.test.js`
- this task's implementation report file

Stop with `NEEDS_CONTEXT` before editing another file.
