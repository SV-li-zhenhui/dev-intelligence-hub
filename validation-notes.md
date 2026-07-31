# Validation notes

Date: 2026-07-31

## Automated checks

- `npm test`: 85/85 passing, covering responsibility semantics, newest-first versions, proactive jobs, head/revision guards, memory outbox, local API security and source-failure fallback.
- Real refresh: 122 GitHub records + 37 DingTalk signals, 22 tracked versions, 0 source errors.
- Tracked versions: newest created/published record is first (`Research artifacts for PR #22939`, published 2026-05-25).
- API health: `ok=true`; PR employee is running with local `ollama / qwen3.5:9b` and remote code context disabled.
- Employee persistence: 17 owner plans ready and searchable; one older job remains blocked after three 45-second Ollama timeouts, so role health correctly reports degraded.
- Playwright desktop viewport (1440×1000): HTTP 200, version-order note visible, employee/memory views exercised, no overflow, 0 console errors, 0 page errors.
- Playwright mobile viewport (390×844): the same checks pass with no horizontal page overflow.
- Confirmation fixtures: responsibility confirmation and employee review-draft acceptance both submit the displayed head; employee acceptance remains local-only.

Artifacts are generated locally in `validation-artifacts/`.

## Scheduled tasks

- `ClaudePRChatDigest`: `scripts/Refresh-And-Notify.ps1` now calls the resident server so refresh/confirmation/employee mutations share one writer; it fails closed when the server is unavailable.
- `MyDashboardServer`: registered at logon; manual execution returned `0`; health endpoint remained available.
- DingTalk delivery: an explicitly labelled switch-test notification was sent successfully.

## Pull request responsibility

- Another person's PR with me in `Assignees`: review work.
- My authored PR: modification/follow-through work, even when another person is assigned.
- Formal GitHub review requests are intentionally ignored as an ownership source.
- PR #23730 is correctly classified as authored work.

## Information-volume safeguards

- Overview is capped at seven focus items.
- Overview previews only five assigned issues and eight authored PRs.
- Full lists live behind dedicated navigation entries.
- First snapshot is a silent baseline.
- Display refresh and notification acknowledgement use separate snapshots, so the 10-minute page refresh cannot consume an hourly notification.
- Notifications require a new/changed item with score ≥80 and are capped at five per run.

## Proactive employee safeguards

- The model cannot overwrite job identity, status, work type or approval policy; the service copies only allowed analysis fields.
- A policy-version change supersedes old drafts before creating replacements.
- A stale head or failed GitHub PR refresh cannot create or approve work.
- Memory events use a bounded, idempotent outbox; failures preserve completed jobs and surface degraded health.
- Private PR patch context is loopback-only by default. Remote Ollama requires explicit opt-in and redirects are rejected.
- Browser mutations use Host/origin/action-header checks; static pages deny framing with CSP and `X-Frame-Options`.

## Known residuals

- Refresh snapshots, dashboards and notification baselines are still separate atomic JSON files. A disk failure between writes can leave those files at different generations; a future storage migration should commit them through one manifest/generation transaction.
- GitHub PR enrichment still invokes one `gh pr view` per relevant PR. It is correct but makes a full real refresh take roughly 24 seconds on the current data set; a future GraphQL batch adapter would reduce process/API overhead.
