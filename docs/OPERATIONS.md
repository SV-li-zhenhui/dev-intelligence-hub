# Operations

MyDashboard is a single-user, loopback-only service. Keep the project, active
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
  `PATH`: Codex CLI `>=0.147.0 <0.148.0`, or Claude CLI
  `>=2.1.222 <2.2.0`.

Install and verify before the first managed start:

```powershell
npm ci
npm test
```

For a repeatable release or upgrade acceptance, run the core validation from a
committed tree. It checks the complete Node suite, JavaScript syntax, and the
configuration and confirmation browser fixtures:

```powershell
npm run validate:system
```

The complete host gate additionally requires Docker Desktop and a healthy
managed service already listening on `127.0.0.1:4173`:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Start
npm run validate:system -- --all
```

The command writes a machine-readable result to the ignored
`validation-artifacts/system-validation.json`. Treat that artifact and the UI
screenshots as private local operational data until they have been reviewed and
sanitized.

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
tested official npm package shape and native executable. An unsupported,
missing, replaced, linked, or unverifiable binary remains unavailable.

Supply credentials to the managed service before `Start` or `Restart`:

- Codex CLI reads only `OPENAI_API_KEY`.
- Claude CLI reads only `ANTHROPIC_API_KEY`.

Host CLI login profiles and `CLAUDE_CODE_OAUTH_TOKEN` are deliberately not
reused. Keep keys in the operating-system or service environment, not in
`config.json`, the configuration UI, scripts, logs, or command history. The
managed service must inherit the vendor package's npm binary directory in its
`PATH`, but each model child receives an empty-origin environment and does not
inherit that `PATH`.

In **配置**, add a CLI Provider, assign it and an explicit model to a role's
routine brain or task brain, and authorize each required remote data class
(`requirements`, `code`, `memory`) separately. CLI providers are always remote;
the remote flags are not editable. Validate the draft, inspect its impact, and
confirm activation one item at a time. The active runtime is immutable, so use:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Restart
```

after activation. Resume only the intended role after readiness returns.

Each claimed task starts at most one vendor process. It runs in a fresh private
directory with tools, plugins, browser integration, MCP, slash commands, host
rules, Git/GitHub/SSH context, and session persistence disabled. MyDashboard
removes the directory after a verified exit and keeps durable task context in
its own ledger and memory. This is reasoning only: any code or GitHub action
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
