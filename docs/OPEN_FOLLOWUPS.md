# Open follow-ups for a smooth command-center workflow

This list records gaps identified in the September 2026 product and requirements review. It is a work queue, not a release acceptance report. Run-specific logs, credentials, account identities, and private runtime artifacts remain outside the repository. A finding is closed only when its acceptance check passes on the current source state.

## P0 — Restore supervised CLI task execution

The service can be healthy while a configured high-capability role cannot run because the Codex login broker reports `broker_blocked` and role cycles report `STRUCTURED_PROVIDER_CLEANUP_FAILED`. Diagnose the failed private mirror, process reap, or cleanup step without deleting retained sessions or changing the owner's login and configuration. Keep service readiness separate from role/provider execution readiness in the API and UI.

**Done when:** the bounded no-model readiness check reports `available`; one real configured role completes a bounded task and records its result; a forced broker failure leaves work unclaimed, explains the blocker to the owner, and preserves private evidence. Confirm that previously blocked work is reconciled by its own reason rather than bulk-retried.

## P1 — Prevent sensitive imported sessions from reaching remote brains

Local session import preserves transcript text, and memory answering can include retrieved records in a remote prompt after broad data-class authorization. Define a separate egress rule for imported sessions. Default imported transcripts to local-only, or require an explicit reviewed export decision for a bounded, sanitized subset. Preserve local search and citations.

**Done when:** a credential-bearing imported record causes zero remote provider calls while local retrieval still works; tests cover mixed safe and restricted records and provider switching.

## P1 — Make final acceptance internally consistent

U12 lists AE1–AE8 but omits the supervised CLI acceptance example AE9. Its zero-GitHub-write verification sentence also overlaps the separately authorized product-run live PR gate. Define a local fake-adapter, zero-write gate and a distinct owner-authorized product-run gate. Bind both to the same current source-state evidence without treating one as proof of the other.

**Done when:** AE9 is exercised in U12, the two gates have separate evidence and authorization rules, and release status cannot become complete from simulated or stale results.

## P1 — Give the owner a single actionable view of each work item

For each PR or Issue task, show the current responsible party, source status, blocker and its cause, next action, linked evidence, and freshness. Add safe per-item controls for pausing, cancelling, or requesting reassignment of local AI work. Keep a GitHub Assignee change as its own confirmed external action. Reconcile stale merged or closed PRs and supersede old Head-bound work.

**Done when:** an owner can identify and act on one queued, waiting, or blocked item without pausing an entire role; a merged PR cannot remain presented as an active action; independent tasks continue when one task blocks.

## P2 — Remove duplicate attention without weakening confirmations

Consultations and external actions stay in the one-at-a-time queue. Coalesce only duplicate requests for the same semantic action, target, source revision, and authority; preserve separate confirmations for distinct Review, code application, push, and merge actions.

**Done when:** repeated refreshes and employee cycles show one pending request per unchanged action, while a changed Head or changed proposal requires a new decision and old requests become stale.

## P2 — Define DingTalk report quality and task intake

Retain the Shanghai-time 09:00 daily overview and 12:00, 15:00, 18:00, and 20:00 updates. Specify source freshness, partial-data labeling, deduplication, links to evidence, and which messages or TODOs create shared work. A source error should produce a short actionable summary in the UI, with details confined to diagnostics.

**Done when:** each scheduled report distinguishes new progress, unchanged items, blockers, and missing sources; retrying a source does not duplicate tasks or expose a raw provider error on the dashboard.
