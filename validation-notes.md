# Validation notes

## 2026-08-09 — supervised CLI brains and earlier `50f816d` checkpoint

- Local implementation checkpoint: `50f816d` contains the reviewed command-center integration, including versioned configuration, shared role coordination, controlled PR/code execution, recoverable operations, and supervised Codex/Claude CLI brains. It remains local and unpushed.
- CLI acceptance: production version-only discovery/execution passed for Codex CLI `0.147.0` and Claude Code `2.1.222`; the fake local-process E2E covers employee and Code Job routes. No real model request, host CLI profile, source checkout, or GitHub credential was exposed.
- Review result: two independent final reviews returned Ready with no P0/P1/P2 finding after deadline, cancellation, result-read, process-tree reaping, and cleanup precedence defects were reproduced and fixed.
- Complete regression: `npm test` passed 2,777/2,784 with zero failures and seven explicit platform/environment skips. The focused/cross-layer CLI suite passed 369/370 with one Windows symbolic-link skip.
- Distribution and UI at that checkpoint: committed-tree packaging/clean-room checks passed 14/15 with one live machine-wide process-guard skip; 435 JavaScript/ESM files passed syntax checks; configuration and confirmation-history Edge fixtures passed; desktop and 390 px mobile validation reported no horizontal overflow, console error, or page error. The process-guard gap was subsequently repaired with project-scoped guard identities and is retained here only as historical evidence.
- Docker boundary: the opt-in real Docker smoke passed previously, and the Docker sandbox adapter/test have not changed since that evidence. It was not rerun in this checkpoint because the Docker Desktop Linux daemon was stopped.
- Remaining owner gates: select one SPDX license before creating `LICENSE` or matching package metadata; separately authorize the product itself to perform a live PR acceptance. No service restart, real PR access/action, GitHub write, or push occurred in this acceptance.

## 2026-08-06 — U9 fixed-Head execution foundation

- Complete regression: `npm test` passed 1925/1929 with zero failures; four skips are platform- or opt-in-specific. The focused fixed-Head suite passed 235/237 with two platform skips, and the real Windows Git integration passed.
- Exact-source binding: PR code proposals, confirmations, capability grants, Code Jobs, executor recovery and cancellation now carry the same canonical repository, PR number and 40/64-character Head OID. Any mismatch fails before a workspace side effect.
- Safe materialization: the executor reads the approved commit directly from a local Git object database into an isolated workspace. It does not checkout the user's working tree, run hooks or filters, fetch from a network, follow alternate object stores, or accept a Windows Git wrapper in place of the pinned implementation binary.
- Independent boundary checks: the workspace broker revalidates executable identity, repository/object-directory boundaries, every materialized path, hash, size, Git mode, file count and total bytes before exposing the workspace to the executor.
- Real integration result: a synthetic repository proved that the materialized source remains the sealed older Head after both the branch Head and dirty working tree change; executable files retain logical Git mode and hostile hooks/filters are not invoked.
- Review result: three independent reviews found no P0/P1 in this foundation. One U10 residual remains: a Windows file lock can leave a failed workspace that is explicitly detectable and manually discardable, but automatic persistent orphan reconciliation is not implemented yet. Object-database scan deadline/receipt reuse is also retained as a scale optimization.
- Scope boundary: this foundation does not yet implement trusted base-commit capture, merge/conflict inspection, conflict-resolution semantics, commit creation, remote update or GitHub write. The owner-only real PR target was deliberately not submitted to the system and was not inspected or modified manually.
- Delivery policy: all changes and commits remain local. No GitHub push, PR creation, branch update, merge, Review or comment was performed.

## 2026-08-03 — Stage 7 controlled code delivery loop

- Complete regression: `npm test` passed 1112/1114 with zero failures; the two skips are host-unavailable Windows symbolic-link cases. Focused ledger, end-to-end, and restart recovery checks passed 51/51 after the final review fix.
- Real end to end: a disposable Git checkout traversed workflow routing, durable ledger intake, a developer decision, owner confirmation, Code Job read/write/test/complete actions, immutable Change Package delivery, searchable local memory, proposal reconciliation, and a separately confirmed source application. The source stayed unchanged until that second confirmation, and replay retained one application and one receipt.
- Restart recovery: cancellation cleanup was interrupted after the first of two isolated attempts, then recovered from the same durable state without another brain call, grant verification, executor start/resume/action, package creation, or source mutation. Both attempts were removed and one cancellation memory record was projected.
- Docker boundary: the opt-in real Docker smoke passed against the pinned `node:22-alpine` digest with network disabled, source mounted read-only, sensitive environment data absent, and artifacts returned only through the controlled boundary.
- UI regression: desktop (1440 px) and mobile (390 px) checks passed with one confirmation dialog at a time, correct focus after pause/package/cancel actions, verified evidence downloads, visible application/cancellation state, no horizontal overflow, and no console or page errors.
- Binding repair: the full composition test found that raw employee intent IDs and policy-bound proposal IDs are intentionally distinct. Work Ledger reconciliation now locates the current trusted outbox through `activeIntentId` and requires one unique matching `downstreamRef`, plus matching proposal digest, role, kind, item and input digest. Forged and ambiguous bindings fail closed.
- Independent review: no P0/P1/P2 remained. Its one P3 finding was fixed by allowing the Git-dependent end-to-end test to skip only an explicit locator miss; other process or permission failures now fail the test.
- Delivery policy: all changes and commits remain local. No GitHub push, PR creation, remote branch update, merge, Review, or comment was performed.

## 2026-08-02 — Stage 6 multi-role and multi-brain command center

- Automated regression: the final complete Node suite passed with 686 passing and one opt-in real Docker test skipped; 49 server lifecycle/scheduling tests and the independent 60-test Stage 6 review set passed. Syntax checks and `git diff --check` also passed.
- Runtime restart: the accepted service is listening only on `127.0.0.1:4173` as PID 54124. `/`, static assets, health, employees, dashboard, attention, memory, work-ledger and workflow-routing endpoints all returned HTTP 200; `logs/server-stage6-accepted.stderr.log` is empty.
- Live refresh: 122 GitHub records and 41 DingTalk signals were collected in 23.079 seconds with zero source errors and zero brain-refresh errors. Routing version 2 targets PR events to `pr-engineer` and Issue events to `requirements-analyst`.
- Workforce state: six roles are discoverable. The five configured roles and the legacy `pr-reviewer` are all paused; each configured role reports local `ollama / qwen3.5:9b`, `remote=false`, and all remote data classifications denied.
- Real brain smoke: direct structured decisions through the configured Ollama model succeeded for requirements analysis and PR engineering. The PR result produced the allowed `propose_github_review` intent without invoking GitHub.
- Durable state: the work ledger is at revision 269 with 130 unique items (129 queued, one waiting for the user). The unified attention endpoint exposes exactly that internal request; external actions remain disabled. Unified local memory is healthy and reports 547 searchable records.
- Scheduling safety: facts, scheduled work and manual work share one serialized boundary. Same-scope scheduled ticks and same-kind refreshes coalesce; pending facts discard only obsolete scheduled work, while manual work remains ordered across one or multiple refresh cycles and returns 503 if no valid facts exist.
- Provider safety: Ollama and OpenAI-compatible options are isolated by adapter kind; remote credentials come only from the named environment variable, and requirements/code/memory each require explicit per-role remote authorization.
- Review result: independent review reproduced and drove fixes for the no-confirmation-queue fact race, slow-tick backlog, manual-run loss, Provider option leakage and stale frontend response ordering. Final review found no remaining high-confidence P0/P1/P2 in the Stage 6 scope.
- Browser automation was not used because the selected in-app browser bootstrap remained unavailable; frontend behavior is covered by static contracts and real local HTTP checks.

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
