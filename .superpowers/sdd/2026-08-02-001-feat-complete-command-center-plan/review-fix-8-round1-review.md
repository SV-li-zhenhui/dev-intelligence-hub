# Review fix 8 — Round 1 cumulative re-review

## Review target

- Fixed cumulative range: `36e700d..91284ba1`
- Immutable package: `review-36e700d..91284ba.diff`
- SHA-256: `67595C42FD7B43F05AE56848ED41F7E68800345314919626C74B7AA3DF998A2A`

## Accepted closures

The independent reviewer confirmed the three initial Important findings are
closed without observed regressions:

- default 8,192-token packing retains useful patch hunk, changed-line, and
  file evidence;
- raw oversized patch data is bounded before complete-context serialization;
- transport and timeout errors no longer retain hostile text, while admission
  and external-abort authority remain intact.

Controller verification passed 25/25 focused tests and 86/86 in the related
employee/confirmation group. A default synthetic capture retained 2,659 patch
characters, a hunk, a changed line, 924 description characters, and eight file
entries at a conservative total of 8,086/8,192.

## Remaining independent finding

- Critical: 0
- Important: 1
- Minor: 0

The fitter budgets the shorter JSON literal `true` for `patchTruncated`, then
can replace it with the one-byte-longer `false` after fitting. A no-truncation
boundary reached 3,446 conservative units for `contextTokens=3,445`; the retry
therefore violated the exact context equation by one byte. Round 2 must reserve
the longest final representation or revalidate the final serialized request,
and add an exact no-truncation boundary test for both attempts.

Round 2/5 returns to the original implementer. Scope and all synthetic-only,
offline, no-real-PR boundaries remain unchanged.
