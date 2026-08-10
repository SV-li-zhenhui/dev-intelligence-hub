# Review fix 8 — Ollama PR employee structured-output final review

## Review target

- Brief: `review-fix-8-ollama-pr-employee-structured-output-brief.md`
- Production commits: `45726b2`, `91284ba`, `b199a73`
- Fixed cumulative range: `36e700d..b199a73e`
- Immutable package: `review-36e700d..b199a73.diff`
- SHA-256: `2E661F43A99FA83F85AC9943DC65BE2C6F9C2659345DB7A34039848EF02FA6F4`

## Independent verdict

`APPROVED`

- Critical: 0
- Important: 0
- Minor: 0

The initial review found three Important gaps: insufficient default patch
evidence, complete serialization of raw oversized evidence before fitting, and
transport/timeout error leakage. Round 1 closed all three. Its cumulative
re-review found one additional one-byte `patchTruncated` true/false retry
boundary; Round 2 closed it with an exact ordinary-and-retry equation test. The
final cumulative re-review approved the complete range.

## Controller verification

The controller independently ran:

```powershell
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js
node --test --test-concurrency=1 test/ollama-pr-employee-reviewer.test.js test/proactive-pr-employee.test.js test/proactive-pr-confirmation-integration.test.js
node --check src/adapters/ollama-pr-employee-reviewer.js
node --check test/ollama-pr-employee-reviewer.test.js
git diff --check 36e700d..b199a73e
```

The focused suite passed 26/26 and the related employee/confirmation group
passed 87/87. Syntax, cumulative whitespace, and clean-worktree checks passed.

## Authorized synthetic live acceptance

The owner authorized applying the Authenticode-valid Ollama 0.32.6 update,
restarting it, and validating structured output with fictional data only. The
running local API reported 0.32.6 and `qwen3.5:9b` completed both cases in one
attempt under the configured 90-second employee timeout:

- Short fictional PR: 59,744 ms; conservative prompt total 3,890/8,192;
  complete 207-character patch with hunk and changed line; exact
  `review_draft`, `request_changes`, and `requiresApproval=true`.
- Pressure fictional PR: 7,364 ms; conservative prompt total 8,086/8,192;
  2,646 patch characters, hunk, changed line, and seven file entries retained;
  `patchTruncated=true`; exact `review_draft`, `request_changes`, and
  `requiresApproval=true`.

The generation schema omitted only `reviewBody.maxLength`, while the full
manual 8,000-character validation remained covered. No Markdown extraction or
JSON repair fallback was added.

All probes used names such as `fictional-lab/synthetic-repo` and synthetic
diffs. No MyDashboard runtime data, real PR, GitHub operation, remote model,
credential, or private configuration was accessed. MyDashboard itself was not
restarted or deployed as part of this acceptance.
