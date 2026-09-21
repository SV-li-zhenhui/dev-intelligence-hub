# Privacy

Development Intelligence Hub is local-first. Its state, work ledger, memory index, confirmation
history, executor evidence, backups, and logs are stored on the machine running
the service. It does not require a hosted Development Intelligence Hub account.

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
`code`, and `memory` grants as an HTTPS provider. Claude CLI and Codex's
backward-compatible API-key mode use only the fixed `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` from the service environment. Claude login profiles,
`CLAUDE_CODE_OAUTH_TOKEN`, and OS-keyring login export are not supported.

Codex may instead use `credentialMode: "codex-login"`. The source is fixed to
the service startup `CODEX_HOME` or the same Windows user's default file login;
the page cannot choose a path or view credentials. MyDashboard validates the
source's file identity, owner, ACL, links, and size, then stores an opaque atomic
mirror in a private location outside the repository, application data, backup,
restore, and package roots. It copies only the authentication file into each
disposable profile, never exposes the full host profile, and never writes a
refreshed credential back to the host source. Login, account switch, or logout
is detected at the next serialized task boundary. Account identity, token,
source path, timestamps, and digests are not returned by the status API or UI.

Every CLI call receives a fresh temporary home/config/cache tree and no
inherited Git, GitHub, SSH, proxy, or general host environment. The child is not
started in the source repository and its tools and persistent sessions are
disabled. MyDashboard validates its bounded structured response as untrusted
data, deletes the verified invocation directory, and stores only the normal
local ledger, memory, audit evidence, bounded failure record, and—only for
Codex login mode—the separately protected credential mirror. That mirror is
excluded from application backup and recovery and from npm/open-source
distribution. Persistent task context remains local to MyDashboard. A vendor
may still retain or bill for an authorized request according to its own policy.

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

For GitHub writes, recommended `credentialMode: "gh-login"` asks a fixed
GitHub CLI executable for the current login of the same operating-system user
only after a specific action has been confirmed or needs reconciliation. The
page cannot choose a profile path, set `GH_CONFIG_DIR`, or receive the token;
MyDashboard does not directly parse, copy, persist, back up, or package the
host `hosts.yml`. The fixed GitHub CLI reads the current login from the same
user's default profile. The selected transport verifies the exact
`actorAccountId` with GitHub before write authority is released, so an account
mismatch produces no GitHub mutation.

The returned token is held only in a bounded in-memory lease and is excluded
from configuration, durable state, logs, UI/API responses, model context,
backup, recovery, and acceptance artifacts. Cleanup drops retained references
before the next lease. JavaScript, its runtime, and the operating system do not
provide a reliable promise of physical memory zeroization, so MyDashboard does
not claim that discarded bytes are immediately erased from physical memory.
The explicit compatibility mode `credentialMode: "token-env"` has the same
non-persistence boundary but reads the named service environment variable;
neither mode silently falls back to the other.

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
