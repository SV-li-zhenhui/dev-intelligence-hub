# Privacy

MyDashboard is local-first. Its state, work ledger, memory index, confirmation
history, executor evidence, backups, and logs are stored on the machine running
the service. It does not require a hosted MyDashboard account.

## Data the system can process

Depending on local configuration, the system may process GitHub PR and Issue
metadata, diffs and review threads, DingTalk signals, requirements, source-code
snippets, test output, local session imports, Git history, model prompts and
responses, and user confirmation decisions. These records can contain personal,
confidential, or proprietary information.

Work created in the command-center form, including its description and
acceptance criteria, is persisted locally with routing and intake audit records.
Creating it does not itself call a model or external service. A role may later
include that work in a brain request only through the same local/remote provider
selection and per-data-class authorization described below.

Disabled capabilities collect or transmit nothing. Local-session and Git
imports are opt-in. GitHub writes, code execution, workflow routing, memory,
and every employee role are also disabled or paused in the safe example
configuration. GitHub reads have a separate switch and are disabled in that
example, so its initial refresh does not invoke the GitHub CLI or API.

## Local and remote brains

Ollama can keep inference on the local machine. Third-party providers are
optional. Before a remote request, MyDashboard classifies the context into
`requirements`, `code`, and `memory`; the selected role or task brain must be
explicitly authorized for every included class. Denial occurs before the
provider is called. Model credentials are read from named environment
variables and are not stored in application configuration or responses.

Codex CLI and Claude CLI are also remote providers even though MyDashboard
starts a local executable. The executable sends the authorized prompt to its
vendor. These providers therefore require the same explicit `requirements`,
`code`, and `memory` grants as an HTTPS provider. MyDashboard uses only the
fixed `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from the service environment; it
does not reuse host login profiles, OAuth sessions, `CLAUDE_CODE_OAUTH_TOKEN`,
plugins, MCP servers, or browser state.

Every CLI call receives a fresh temporary home/config/cache tree and no
inherited Git, GitHub, SSH, proxy, or general host environment. The child is not
started in the source repository and its tools and persistent sessions are
disabled. MyDashboard validates its bounded structured response as untrusted
data, deletes the verified invocation directory, and stores only the normal
local ledger, memory, audit evidence, and bounded failure record. Persistent
cross-task context remains local to MyDashboard. A vendor may still retain or
bill for an authorized request according to its own policy.

Authorization limits transmission but cannot control what a third-party model
provider does after receiving an allowed request. Review that provider's terms,
retention policy, region, and training policy before enabling it.

## External services

GitHub and DingTalk adapters access only the accounts and repositories selected
in local configuration. GitHub reads require the separate `githubRead.enabled`
switch; GitHub mutations are disabled by default and each
comment, review, branch update, push, or merge is a separate owner-confirmed
action. Unknown results block retries until reconciliation so the application
does not deliberately duplicate an external write.

## Retention and deletion

Retention is controlled by local store limits and configuration. Backups are
separate complete snapshots and are not removed when active data is removed.
To erase data, stop the service, retain any backup required by policy, and
delete the relevant active data, backup, restore-control, log, and generated-artifact
directories using normal operating-system controls. Verify the target paths
before deletion.

The system does not currently provide anonymization or multi-user access
controls. Do not share raw data directories or backups as diagnostic bundles.
Sanitize exported logs and screenshots before reporting a problem.
