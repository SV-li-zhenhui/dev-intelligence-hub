# Operations

Development Intelligence Hub is a single-user, loopback-only service. Keep the project, active
data, backups, restore control state, and managed-process runtime on trusted
local storage. Do not publish port 4173 through a proxy, port forward, or LAN
listener.

## Prerequisites

- Node.js 22 or newer and `npm`.
- PowerShell 5.1 or newer for the managed lifecycle commands.
- A private `config.json` only when first importing accounts, providers, or
  privileged capabilities. A fresh checkout safely falls back to
  `config.example.json`; after an active version exists, use the structured
  configuration UI and owner-confirmed activation instead of editing bootstrap
  files.
- Credentials supplied only through the environment variables named by the
  private configuration.
- For supervised CLI brains, the first release requires Windows x64 and an
  official npm installation discoverable from the managed service account's
  `PATH`: an official Codex CLI package, or Claude CLI `>=2.1.222 <2.2.0`.

Install and verify before the first managed start:

```powershell
npm ci
npm test
```

For a repeatable release or upgrade acceptance, run the core validation from a
committed tree. It checks every committed Node test, JavaScript syntax, and the
configuration and confirmation browser fixtures:

```powershell
npm run setup:validation-browser
npm run validate:system
```

The setup command is required only after the first install or a Playwright
upgrade. It stores the matching Chromium headless shell under the ignored
`data/playwright-browsers/` directory. Validation never falls back to a host
browser profile or downloads a browser during an acceptance run.

The complete host gate additionally requires Docker Desktop and a healthy
managed service already listening on `127.0.0.1:4173`:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Start
npm run validate:system -- --all
```

Validation must start from a clean committed worktree. It fails if HEAD, the Git
tree, or tracked/untracked source changes during the run. Ordinary Node tests
run from a read-only materialization of the exact commit without `.git`. The
open-source distribution suite, which must inspect the Git index, current tree,
and package payload, runs separately from the repository after clean
commit/tree verification before and after the command. Both suites are
mandatory and together cover every committed top-level Node test. The command
writes a new machine-readable result for every run and prints its ignored path:
`validation-artifacts/runs/<runId>/system-validation.json`. The report includes
the start/end source identity, sanitized logical commands and exit status, and
Node pass/fail/skip identities. An `--all` run stores its structured UI result,
real PNG screenshots, and verified receipt under the same run directory. Runs
never overwrite one another. The immutable Node suite uses a fixed concurrency
of four test files so process-lifecycle and timeout checks remain reproducible
under host load; the Git-context distribution suite runs alone with concurrency
one.

After `--all` and two independent final reviews have passed, bind those records
to the same HEAD with:

```powershell
node scripts/system-acceptance-manifest.mjs `
  --validation-report "validation-artifacts/runs/<runId>/system-validation.json" `
  --review "security-reliability=validation-artifacts/runs/<runId>/reviews/security-reliability.json" `
  --review "maintainability-usability=validation-artifacts/runs/<runId>/reviews/maintainability-usability.json"
```

Each review file is a release-owner attestation recording the result of a
distinct reviewer execution after that validation run. The two exact scopes are
`security-reliability` and `maintainability-usability`. Each report binds the
same run ID, HEAD, tree, and validation-report SHA-256; carries unique review,
reviewer, and reviewer-run identities; declares verdict `ready`; and reports
zero P0, P1, and P2 findings. The manifest validates those bindings,
chronology, and uniqueness claims; it does not authenticate a reviewer or prove
execution independence. Retain the trusted orchestrator's original run records
and have the release owner verify them before creating the attestations.

The ignored
`validation-artifacts/runs/<runId>/system-acceptance-manifest.json` records the
validation commands and test identities and hashes the validation report, UI
results/screenshots, and both distinct review reports. It is published once and
never overwrites an existing manifest. Manifest creation fails for a stale or
dirty HEAD, a misplaced or partial validation report, missing Docker/live UI,
a failed command, missing UI evidence, or invalid reviews. Treat all local
artifacts as private operational data until reviewed and sanitized. The
manifest does not choose a license or replace the owner-confirmed product-only
live PR acceptance.

The current-tree privacy gate does not erase sensitive data from earlier Git
commits. Before the first public source release, review the complete history or
publish a verified, squashed source export into a new public repository. Never
push this private development history merely because the current tree passes.

## Managed lifecycle

Run lifecycle commands from the project root. The manager serializes concurrent
operations, authenticates the exact managed process, and does not force-kill a
process whose shutdown outcome is unknown.

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Status
.\scripts\Manage-MyDashboard.ps1 -Action Start
.\scripts\Manage-MyDashboard.ps1 -Action Start -OpenBrowser
.\scripts\Manage-MyDashboard.ps1 -Action Restart
.\scripts\Manage-MyDashboard.ps1 -Action Stop
```

`Start-MyDashboard.ps1` is a compatibility wrapper for `Start`. `Status`
returns a non-zero exit code for stopped, retained-uncertain, identity-mismatch,
or otherwise unhealthy managed state. Treat retained control state as evidence
to investigate; do not delete it merely to make `Start` succeed.

### Failed-shutdown recovery

`Restart` never overrides retained lifecycle uncertainty. Recovery preparation
accepts two bounded cases: an authenticated managed process that is still alive
and has emitted authenticated requested/`failure` receipts, or an authenticated
control generation whose exact process identity is already absent. The latter
may carry the same complete failure-receipt pair, or no receipts at all after an
unexpected exit; a partial pair is never accepted. The controlled port must be
unused and the recorded generation must have no visible descendants:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action PrepareFailedShutdownRecovery
```

Preparation rejects changed receipts, a reused PID/process identity, an IPv4
or IPv6 loopback listener, visible managed child processes, links, unexpected
data nesting, and files that change while they are copied or verified. Managed
external executors use Windows Job Objects so their descendants are reaped with
the supervised invocation; recovery does not treat an arbitrary uncontained
same-user process as belonging to MyDashboard. Preparation creates a
byte-exact observational snapshot and an
authenticated `pre_termination` incident in the private runtime. It does not
restore data, terminate a process, remove lifecycle evidence, restart the
service, or open a browser. Record the exact snapshot identifier emitted by the
command. A preparation failure removes its unpublished temporary snapshot and
leaves the managed process and lifecycle barrier intact. When the exact process
is already absent, preparation acquires the production application writer lease
before capture and holds it through snapshot and incident publication. A
no-receipt incident uses the dedicated
`managed_process_exit_without_receipt` snapshot reason and HMAC-bound absence
digests for both receipt paths. A receipt that appears later durably transitions
the HMAC-authenticated incident to `invalidated`; deleting that receipt cannot
revive the old recovery authority.

After inspecting that evidence and granting a separate, snapshot-specific
authorization, an operator may explicitly recover the failed lifecycle state:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action RecoverFailedShutdown `
  -RecoverySnapshotId shutdown-failure-YYYYMMDD-HHmmss-<32-lowercase-hex>
```

The recovery command accepts no browser option and leaves the service stopped.
It checks the snapshot manifest and active `data/` files byte-for-byte,
terminates only the PID whose executable path and process start time still
match a live authenticated control generation, verifies the project writer
lease can be acquired, holds it through final data validation and exact control
removal, and checks the snapshot against active data again after exact process
exit. An unexpected-exit snapshot is a
zero-termination authority: if the exact generation appears live, recovery
refuses instead of calling process termination. Before its final control removal,
the manager atomically reserves both absent receipt paths with exclusive,
delete-on-close barriers, so neither a requested nor terminal receipt can race
the finalization window. Only then does it durably finalize the incident,
reconcile the matching receipts, and remove the exact control state as the final
safety-affecting step. Any uncertainty before termination leaves
the process and evidence intact. A failure after termination retains the
control barrier and authenticated incident evidence; a retry can resume only
from that matching incident. An arbitrary, malformed, partially receipted, or
PID-reused dead control state is not recoverable.
Inspect the incident record before taking a separate explicit `Start` action.
Never delete private lifecycle evidence to bypass these checks.

Both `npm start` and managed startup use a bootstrap that captures the packaged
runtime identity before importing the application and verifies it again before
opening the service. A Git checkout must be clean and binds its real commit and
tree. A clean npm/offline payload without `.git` receives a deterministic
identity from its declared package files. Any source change during module load
fails startup closed. Git-backed startup also binds a process-private HEAD
reflog digest, so an ordinary commit, checkout, or reset from A to B and back to
A still fails. This check supplies consistency evidence; it does not defend
against an actively malicious process using the same operating-system account,
which is inside the documented trust boundary. Do not edit or switch the
checkout while starting the service.

The manager stores private process identity and bounded diagnostics outside the
repository. On Windows the root is:

```text
%LOCALAPPDATA%\MyDashboard\runtime\<project-digest>\
```

On non-Windows systems it is under
`$XDG_RUNTIME_DIR/mydashboard/<project-digest>/` when `XDG_RUNTIME_DIR` is an
absolute path; otherwise it falls back to
`~/.local/state/mydashboard/runtime/<project-digest>/`. `logs/server.log` is
rotated at 5 MiB with at most four archives. Logs, screenshots, backups, and
state may contain private engineering data; sanitize them before sharing.

## Supervised Codex and Claude CLI brains

The configuration UI contains safe templates for `codex-cli` and `claude-cli`.
Do not configure an executable, command, arguments, working directory, base URL,
API-key name, plugin, or MCP server. Production discovery accepts only the
official npm package shape and native executable. Codex discovery does not pin
a release range; each invocation validates the command protocol, structured
response, process exit, and cleanup contract. An unsupported,
missing, replaced, linked, or unverifiable binary remains unavailable.

Choose one explicit credential mode before `Start` or `Restart`:

- Recommended Codex `credentialMode: "codex-login"` proxies the current
  service user's file login. If `CODEX_HOME` existed when the service started,
  that absolute directory is the fixed source root; otherwise the source is the
  same Windows user's default Codex directory. Configuration and browser input
  cannot select or override this path.
- Backward-compatible Codex `credentialMode: "api-key"` reads only
  `OPENAI_API_KEY`. A missing mode remains API-key so an old configuration never
  silently changes account or billing path.
- Claude CLI supports only `credentialMode: "api-key"` and reads only
  `ANTHROPIC_API_KEY`. Claude login profiles, `CLAUDE_CODE_OAUTH_TOKEN`, and OS
  keyring export are not supported in the first release.

Keep API keys in the operating-system or service environment, not in
`config.json`, the configuration UI, scripts, logs, or command history. The
managed service must inherit the vendor package's npm binary directory in its
`PATH`, but each model child receives an empty-origin environment and does not
inherit that `PATH`.

Login mode requires an existing regular `auth.json` owned by the same Windows
user, with one link, a bounded size, no linked ancestor, and no unauthorized
write/delete/owner/ACL rights. MyDashboard does not change the host file or its
ACL. It copies only the validated authentication bytes into a private atomic
mirror outside project, data, backup, restore, and code-workspace roots. The
mirror is never logged, backed up, restored, or packaged. All login-mode Codex
calls for that service user are serial. Running `codex login`, switching the
account, or `codex logout` is detected at the next task boundary; refreshed
credentials stay in the private mirror and are never written back to the host.

In **配置**, add a CLI Provider, assign it and an explicit model to a role's
routine brain or task brain, and authorize each required remote data class
(`requirements`, `code`, `memory`) separately. CLI providers are always remote;
the remote flags are not editable. Validate the draft, inspect its impact, and
confirm activation one item at a time. The active runtime is immutable, so use:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Restart
```

after activation. Resume only the intended role after readiness returns.

Run the fixed no-model readiness check against the managed loopback service:

```powershell
node scripts/verify-codex-login-readiness.mjs --origin http://127.0.0.1:4173
```

The command performs one bounded GET to the sanitized status endpoint. It does
not invoke a model, inspect a repository or PR, accept credentials/headers, or
print response details. A cold Windows CLI startup can take tens of seconds; the
command keeps a 90-second client deadline while the broker retains its shorter
bounded process and cleanup deadlines. Success prints exactly one of these
states:

- `available`: the supported CLI and safe file login are usable;
- `file_login_unavailable`: no supported file login is available (logged out or
  first-release-unsupported keyring storage);
- `unsafe_source`: the login file identity, owner, ACL, links, or size is unsafe;
- `broker_blocked`: private mirror publication, integrity, or cleanup is blocked;
- `cli_unavailable`: the fixed supported Codex CLI package is unavailable.

For `file_login_unavailable`, run `codex login` under the same Windows user and
select file credential storage. For `unsafe_source`, inspect and intentionally
repair ownership/ACLs outside MyDashboard; the service will not weaken them for
you. For `broker_blocked`, retain the private runtime evidence and investigate
before retrying. For `cli_unavailable`, install a supported official npm version
in the managed service account's `PATH`. Restart only when configuration state
says a confirmed active version is pending restart.

Each claimed task starts at most one vendor process. It runs in a fresh private
directory with tools, plugins, browser integration, MCP, slash commands, host
rules, and host Git/GitHub/SSH context disabled. Codex requests bound to the same
PR or Issue restore their private task session; the isolated invocation is
removed only after verified exit and successful session capture. An unarchived
session is retained across service restarts, including legacy invocations with
rollout files, and blocks fresh invocation with
`STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED`. Do not delete it to clear the
error: preserve the only copy of task history and investigate capture recovery.
MyDashboard also keeps durable task context in its own ledger and memory.
This is reasoning only: any code or GitHub action
still crosses its independent policy, isolated execution, and owner-confirmation
boundary.

Operational failures are deliberately stable and redacted:

- missing credential fails before binary discovery or process start;
- denied remote data fails before discovery or process start;
- missing or unsupported CLI reports Provider unavailable without exposing a
  candidate path;
- timeout, cancellation, output limit, invalid JSON/schema, or non-success exit
  terminates and reaps the process tree, then ends the one attempt;
- an unprovable process-tree reap or temporary-directory cleanup fails closed
  and retains evidence instead of starting another invocation.

Correct the credential, version, authorization, or capacity problem and let a
new trusted work revision be scheduled; do not manually retry external effects.
Vendor calls may incur usage charges even though MyDashboard itself runs
locally. Review vendor billing, retention, region, and training settings before
resuming a role.

## GitHub CLI login credentials

GitHub writes remain disabled until both the action type and its exact queued
item are enabled and confirmed. The recommended `credentialMode: "gh-login"`
uses the current GitHub CLI login of the same operating-system user that runs
MyDashboard. Install an admitted `gh.exe` at a fixed absolute path, then log in
as that user without involving MyDashboard:

```powershell
gh auth login --hostname github.com
```

In **配置**, choose **GitHub CLI 当前登录（推荐）**, set the exact
`actorAccountId` and fixed `ghCommand`, enable only the required actions, then
validate, inspect, and confirm the version one item at a time. Restart only
after the activated version reports that a restart is required. Do not set
`GH_CONFIG_DIR` for the managed service and do not copy a host `hosts.yml` into
the project or application data.

At a confirmed execution or reconciliation boundary, MyDashboard supervises
the equivalent of `gh auth token --hostname github.com --user
<actorAccountId>` in a private temporary working directory and validates the
bounded token output. The selected GitHub transport then uses that lease to run
`GET /user` and verifies the exact `actorAccountId` before any write or other
mutation. The token lives only in a short in-memory lease; it is not persisted
or shown, and cleanup releases all retained references before another action
can acquire the source. Every Review, comment, update branch, push, or merge
still requires its own confirmation; selecting `gh-login` grants no action by
itself.

For compatibility, `credentialMode: "token-env"` reads only the environment
variable named by `tokenEnv`. Use a dedicated minimum-permission token and
restart the managed service after changing its environment. There is no silent
migration or fallback between `gh-login` and `token-env`.

Missing login, unavailable or replaced CLI, account mismatch, timeout,
oversized or malformed output, and temporary-directory cleanup failure all
fail before a GitHub write. Correct the same-user CLI login or activated
configuration, then let the durable queue retry only when its state permits.
If an already-started external result is `unknown`, do not click repeatedly or
run `gh` manually; reconciliation must resolve that receipt before duplicates
are unblocked.

## Runtime status

Open the **系统** view to inspect:

- liveness and readiness;
- the maintenance gate and in-flight operation count;
- recovery blockers and external actions with unknown results;
- storage-capacity and probe warnings;
- the verified backup catalog.

The safe read endpoint is `GET /api/system/status`. `GET /api/live` remains a
minimal liveness check even when readiness probes fail. A live process is not
necessarily ready: do not resume employees or retry external actions until the
readiness blockers are understood.

## Owner work intake

Use **工作流 → 创建共享工作** to put a new owner request into the shared task
graph. The target is server-controlled: the request first enters the
orchestrator and cannot name a role, node, permission, or internal identifier.
If submission reports a transient failure, retry the unchanged form; the page
reuses its request ID and the service reconciles any routing or ledger write
that may already have completed. A successful response can be read through
`GET /api/work/requests/<request-id>` and the resulting assignment and work item
through the existing workflow and ledger views.

The durable state is stored under the active data directory as
`owner-work-requests-v1`. It participates in normal consistent backups. A
digest or audit-chain mismatch fails the intake runtime closed; preserve the
state and restore a verified backup rather than editing the file manually.

## Create a consistent backup

Use **系统 → 创建备份** while the service is running. The server closes global
write admission, waits for admitted HTTP and background work to drain, captures
a checkpoint of every declared durable store and file, copies and hashes the
payload, verifies the published backup, and then reopens admission. New writes
receive HTTP 503 while the maintenance gate is closing or closed. A failed
backup also reopens the gate in `finally`.

The replaceable `data/playwright-browsers/` and
`data/validation-profile-probe/` validation caches are explicitly outside the
durable checkpoint and can be recreated with `npm run setup:validation-browser`.
Every other StateStore JSON value, including legacy array-valued stores, is
hashed into the checkpoint; values without a revision envelope use revision
`0` plus their content digest. Undeclared hidden paths and aliases still fail
the scan closed instead of being silently omitted.

The equivalent same-origin browser contract is:

```http
POST /api/system/backups
Content-Type: application/json
X-MyDashboard-Action: 1

{}
```

A successful response contains a content-addressed identifier such as
`backup-<64 lowercase hex>`. Backups are stored in the ignored `backups/`
directory. An item appears in the status catalog only after manifest and
payload verification. Status polling reads the bounded atomic catalog and does
not hash every retained payload. Its status is therefore the result of the last
deep verification; an explicit verify or restore refreshes an item to
`verified` or `corrupted`. Legacy directories without a catalog record appear
as `unindexed` until explicitly verified. Incomplete, unrecognized, missing,
or corrupted entries remain visible rather than being silently accepted.

Keep independent copies according to your retention policy. MyDashboard does
not currently delete old verified backups automatically, and deleting active
data does not delete backups.

## Restore a verified backup

Restore is deliberately offline. First copy the required backup to trusted
storage if needed, then stop the exact managed service and confirm its status:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Stop
.\scripts\Manage-MyDashboard.ps1 -Action Status
.\scripts\Manage-MyDashboard.ps1 -Action Restore -BackupId backup-<64-hex>
```

The restore command refuses to run if the manager has a live process, retained
unknown process state, or any listener on the configured port. It validates the
backup into a separate candidate directory, runs migration and read-only
reconciliation, records a durable swap journal, atomically activates the
candidate, and retains the previous active directory until the activation
receipt is durable. The service remains stopped after success; inspect the
receipt message, then start it explicitly:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Start
```

`Start` and `Restart` automatically recover an interrupted swap when the
ignored `restore-control/` transaction directory exists. Repeating the same
successful restore is idempotent. Do not manually rename `data/`, edit files in
`restore-control/`, or remove candidate/rollback directories during recovery.
If recovery cannot prove one safe state, it fails closed and leaves the evidence
for diagnosis.

Graceful shutdown aborts cooperative background I/O and has a bounded drain
deadline. If work or a runtime does not drain, the manager writes an
authenticated failure receipt and retains both its control state and the global
writer lease. It does not report a successful stop or begin offline restore in
that uncertain state.

## Incident procedure

1. Stop new employee activity in the UI when it is still reachable.
2. Run `Status`; record its exact output and the time.
3. Read the **系统** readiness blockers and unknown external-action kinds.
4. Preserve `server.log`, its bounded archives, `restore-control/`, and the
   relevant content-addressed artifacts. Never post them publicly without
   sanitizing credentials, source, messages, and personal data.
5. For an unknown GitHub mutation, use the system's read-only reconciliation;
   do not manually retry the mutation.
6. For an interrupted restore, run `Start` so the manager performs offline
   recovery before launching the server. If it still refuses, preserve the
   state and investigate instead of deleting the journal.
7. After repair, require a ready system status and run the relevant focused
   tests before resuming roles or privileged actions.

## Capacity and maintenance

The readiness service warns when the active data volume reaches 80% usage and
marks it critical at 95%. Make space using normal operating-system tools only
after resolving exact paths. Do not recursively delete a computed project,
home, runtime, data, backup, or restore directory. Prefer moving an old verified
backup to separate trusted storage, verify the copy, and only then remove the
exact original by its full path.

Run `npm test` after upgrades. Configuration replacement and schema migration
must complete before employees are resumed. Privileged settings remain disabled
in `config.example.json`; review every enabled role, brain data class, workspace,
GitHub action, and routing rule in the active version after an upgrade.

## Live GitHub smoke-test cleanup

Any test that creates a real GitHub pull request must register cleanup as soon
as the PR exists and run verification through `withSmokePullRequestCleanup` from
`scripts/github-smoke-pr-lifecycle.mjs`. The wrapper runs cleanup after both a
successful assertion and a failed or interrupted verification path.

Cleanup is intentionally narrow: it accepts only PRs owned by the authenticated
account whose title begins with `[MyDashboard E2E]`, contains `DO NOT MERGE`,
and whose same-repository head branch begins with
`test/mydashboard-e2e-`. Ordinary PRs, forks, and product branches are refused.
To reconcile an orphaned smoke PR explicitly, run:

```powershell
npm run cleanup:e2e-pr -- --repo owner/repository --pr 12345
```
