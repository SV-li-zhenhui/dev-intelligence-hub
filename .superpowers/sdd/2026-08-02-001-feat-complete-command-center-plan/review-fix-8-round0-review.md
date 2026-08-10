# Review fix 8 — initial independent review

## Review target

- Brief: `review-fix-8-ollama-pr-employee-structured-output-brief.md`
- Fixed range: `36e700d..45726b29`
- Immutable package: `review-36e700d..45726b2.diff`
- SHA-256: `BC1AB7E2BA7435CE48D84A94F7D1D077A1F5674A10E751A86DF00CA88B4A9EA9`

## Controller verification

- Focused adapter suite: 19/19 passed.
- Adapter plus proactive employee/confirmation group: 80/80 passed.
- Syntax and fixed-range whitespace checks passed.
- A default-8192 synthetic capture used 1,378 system bytes and 5,172 user
  bytes; the conservative total was 8,086, but it retained only 248 patch
  characters, 3,853 description characters, and no file entries.

## Independent verdict

- Critical: 0
- Important: 3
- Minor: 0

### Important findings

1. The default packer reserves only a tiny patch prefix before filling title
   and description. Its tests merely require a non-empty patch, so they can
   pass without retaining a hunk or changed line. The default configuration
   must retain useful diff evidence and test that fact.
2. The early size check serializes the complete raw context before fitting it.
   An 8 MiB synthetic patch was fully serialized even though only a few hundred
   characters were sent. Preprocessing must avoid input-proportional full
   serialization and gain a boundedness regression test.
3. Non-timeout transport failures are rethrown unchanged, and timeout errors
   retain the raw transport failure as `cause`. Both paths can preserve hostile
   provider text. Translate them to trusted diagnostics while retaining exact
   external-abort identity.

All three findings are required. Round 1/5 returns to the original implementer
and remains limited to the adapter, its focused test, and the implementation
report. No runtime, model, network, GitHub, credential, private configuration,
or real-PR access is allowed.
