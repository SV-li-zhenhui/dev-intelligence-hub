# Validation notes

## 2026-08-02 — Stage 5 proactive work loop

- Automated regression: the complete Node test suite passed after composition with 563 passing and one opt-in Docker test skipped; syntax checks, frontend static contracts and `git diff --check` passed.
- Runtime restart: the new service is listening on `127.0.0.1:4173` as PID 22072 with an empty error log. `/`, `/app.js`, `/work-view.js`, `/api/work/items` and `/api/attention/next` all returned HTTP 200.
- Durable migration: `workflow-routing-state` migrated from schema 1 to schema 2 with a contiguous assignment feed from sequence 1 through 122. The work ledger then recorded exactly 122 unique items with intake cursor/high-watermark 122.
- Live safety state: 72 PR items remain queued because the legacy PR role is paused; one requirements item is waiting for the user and the other same-target items remain queued. Only one internal request and one delivered attention intent exist, so scheduled reruns did not duplicate the question.
- Preserved state: the PR employee remains paused at revision 66 with all 18 historical jobs. GitHub actions are disabled, the external confirmation runtime was not acquired, and no external write was performed.
- Recovery rehearsal: a separate temporary copy of the pre-migration JSON state completed v1→v2 migration, first intake and a second idempotent cycle without modifying production data.
- Browser automation was not used for acceptance because the selected in-app browser bootstrap was unavailable in this environment; frontend behavior is covered by static contract tests and real local HTTP checks.

## 2026-08-01 — Stage 1 generic employee control layer

- Automated regression: `npm test` passed 96/96; syntax checks and `git diff --check` passed.
- Runtime restart: the service returned healthy on `127.0.0.1:4173`; the PR employee remained paused at revision 66 with all 18 jobs and an empty confirmation queue preserved.
- API verification: `/api/employees` returned one lightweight `pr-reviewer` role; `/api/dashboard` retained its legacy PR employee projection without duplicating employee payloads.
- Browser verification: desktop (1440×1000) and mobile (390×844) returned HTTP 200, had no console/page errors or horizontal overflow, and showed the preserved paused employee and 18 jobs.
- Review result: one confirmed employee-ID/routing mismatch was fixed by enforcing the same URL-safe ID grammar at registration. Independent reliability review found no blocking issue.
- Current degraded badge is the preserved PR employee error from an older Ollama timeout; the latest refresh itself completed with 122 GitHub records, 41 DingTalk signals, and no source or brain-refresh errors.

### Post-restart monitoring

- Check `/api/health`, `/api/employees`, and `logs/server-error.log` through the next scheduled refresh and employee intervals.
- Treat loss of the paused state, revision/job regression, repeated one-second scheduling, HTTP failures, or new uncaught errors as rollback triggers.
- If a trigger occurs, stop only the process listening on `127.0.0.1:4173`, keep the JSON state files untouched, and relaunch the last known-good local version before investigating.

## 2026-07-31 — Initial dashboard validation

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
