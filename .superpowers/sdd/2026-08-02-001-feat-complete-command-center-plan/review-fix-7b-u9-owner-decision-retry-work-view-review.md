# Review fix 7b — Work-view owner retry review

## Scope

- Base: `1dcc080`
- Final implementation HEAD: `b60c78fbe003b97e926a35cf9865e1a9459f4e71`
- Immutable cumulative package:
  `review-1dcc080..b60c78f.diff`
- Size: 48,063 bytes
- SHA-256:
  `29E8E673458C48B007864E7281938C6A01859F3BC6A26722DA217CD4AF363C5E`

## Independent review history

The initial independent review rejected the implementation for two P2 issues:
an eligibility accessor could self-replace before the predicate ran, and
duplicate eligible item IDs could submit the first row's authority. Round 1
closed those exact cases, but re-review found two remaining P2 variants: a
nested presentation accessor could mutate eligibility before a later
programmatic request, and an eligible plus ineligible duplicate ID was not
treated as ambiguous. Round 2 closed those cases, but re-review found one final
P2: accessor-backed indices in the top-level items array were iterated before
descriptor validation. Round 3 moved both rendering and controller lookup onto
a bounded descriptor-validated collection snapshot.

The same independent reviewer verified the final immutable package and returned
`APPROVED` with no P0/P1/P2 findings.

## Final evidence

- The accessor-index regression invokes the getter zero times, renders zero
  owner-retry controls in pure and controller rendering, and issues zero POSTs.
- Seven malformed collection shapes fail closed while an ordinary 50-row JSON
  projection keeps its existing display behavior.
- Duplicate IDs, current-state revalidation, exact two-field request authority,
  one-request serialization, explicit reload invalidation, late responses,
  409 handling, bounded escaped errors, and accessibility remain correct.
- `test/frontend-work-view.test.js`: 39/39 passed.
- Work-view plus Work-graph tests: 48/48 passed.
- Both changed JavaScript files pass `node --check`.
- The cumulative diff passes `git diff --check`.
- No runtime, model, network, GitHub, credential, private configuration, or real
  PR data was used. Browser-level runtime validation remains part of the later
  HEAD-bound system acceptance run.

## Verdict

`APPROVED`
