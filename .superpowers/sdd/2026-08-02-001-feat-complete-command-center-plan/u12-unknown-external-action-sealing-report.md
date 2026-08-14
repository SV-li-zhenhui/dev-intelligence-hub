# U12 unknown external-action owner sealing report

## Status

COMPLETE — live owner interaction pending.

## RED

- The startup-recovery regression expected one non-retryable unknown item in
  the unified queue and failed because the queue returned zero actionable
  items.
- The Playwright fixture supplied an exact unknown Review and failed because
  the existing dialog displayed its normal publish control.

## Implementation

Failed unknown items now follow existing pending and proven-absent retryable
items in the unified queue. Their public projection includes
`resolutionRequired: true` and the unchanged sanitized failure. They remain
non-retryable.

The browser routes that explicit projection to a dedicated no-replay dialog.
It displays the bound target/version, action type, diagnostic, historical body,
summary and evidence. Its only mutation is the existing revision/digest-bound
reject operation, labelled “承认结果未知并封存”; the alternative is “稍后再看”.
The recorded reason explicitly says the result remains unknown and retry is
forbidden.

## Review repair

The initial independent review found one Important audit defect: the ordinary
reject transition cleared the retained unknown execution and failure evidence.
The sealed-unknown transition now preserves that exact pair together with the
structured owner rejection. The durable contract accepts only either an
ordinary rejection with neither field, or a sealed unknown with both fields
still classified as `unknown`; partial or retryable variants remain invalid.

History retains the original diagnostic and a fixed
`seal_unknown_and_forbid_replay` owner-decision enum. The sanitized memory
projection retains that enum and decision time alongside the unknown
execution/failure; both confirmation and external-result unified-memory records
carry it. The owner-facing sealed projection retains the original failure and
the same fixed decision, but omits the durable rejection object so its free-form
reason cannot cross the public queue boundary. Free-form rejection text is not
copied into history or searchable memory. A restart regression proves a sealed
item remains rejected and invokes neither reconcile nor execute.

Four negative durable-state cases prove a rejected item cannot retain only one
of execution/failure or a non-unknown member of the pair. The pre-existing
lost-response integration now expects the newly actionable no-replay resolution
instead of the former hidden item, then still proves startup reconciliation can
complete it without replay when an exact receipt is found.

The memory consumer also rejects a projected `rejected` item without a rejection
time and rejects an unknown pair without the fixed owner decision before any
journal or authority-checkpoint write.

## GREEN and verification

- Focused startup-recovery regression: 1 pass, 0 fail.
- Confirmation queue/runtime, attention coordinator, server/API, memory runtime,
  memory projector and static frontend group after the audit repair: 247 pass,
  0 fail, 0 skip.
- A broader affected-consumer union passed 453/453; the final focused
  confirmation/memory/external-action group passed 98/98.
- Real Chromium Playwright confirmation fixture: passed, including absence of
  approve/publish/retry buttons, exact reject-only submission, and the fixed
  owner-decision history label.
- The first whole-suite run exposed the now-corrected legacy expectation that
  unknown items were absent from `next()`. Its focused regression is green.
  An unrelated staggered CLI timing test failed once only under whole-suite
  load and then passed focused 20/20; this remains a final full-suite rerun gate,
  not evidence that the whole suite is green.
- Syntax and `git diff --check`: passed.

No unknown outcome was auto-cleared. No credential, model, executor or GitHub
call is made by sealing. No live item has yet been sealed; that remains an
explicit owner UI action after reviewed restart.

## Independent review

The first review found one Important loss of structured unknown evidence. Two
subsequent rounds found and closed the public free-text projection and malformed
memory-projection gaps. Final immutable review of `fe2cef9..a4f8810` reported
zero Critical, Important, or Minor findings and approved managed restart.
