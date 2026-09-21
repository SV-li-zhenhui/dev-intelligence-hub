# Security policy

## Supported versions

Until the first stable release, security fixes are made on the current default
branch only. Published releases should state their support window in their
release notes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Before the first
public release, the repository owner must enable and test GitHub private
vulnerability reporting. If that feature cannot be enabled, the owner must add
a monitored confidential contact to this file before publication. Until one of
those channels exists, the distribution is not security-reporting-ready; do
not send vulnerability details through a public issue or discussion.

Include affected versions, impact, reproduction steps, and a minimal proof of
concept. Remove API keys, tokens, private source, personal messages, and local
memory data. A maintainer should acknowledge the report, assess severity, and
coordinate disclosure after a fix is available.

## Security model

Development Intelligence Hub is a single-user, loopback-only application. It is not designed to
be exposed to a LAN or the public internet. A process that can access the same
user account, local data directory, or loopback endpoint is inside the local
trust boundary.

The application treats the following as untrusted:

- model output and text embedded in PRs, Issues, chats, memory, and source;
- browser requests that do not satisfy the loopback, Host, and same-origin
  checks;
- stale confirmations, changed Git heads, and mismatched account or repository
  identities;
- backup archives, recovery journals, and executor artifacts until their
  digests and bindings are verified.

Important safeguards include disabled-by-default privileged features,
data-class authorization before remote model calls, fixed semantic executor
operations, immutable evidence, one-at-a-time confirmations, exact Git target
binding, and recovery-before-retry for uncertain external results.

Managed startup uses source identity as a consistency and provenance check. It
captures the declared runtime files, Git commit/tree, and a private digest of
the HEAD reflog before application import, then verifies them after the module
graph loads and again before the listener is claimed. A normal commit,
checkout, or reset sequence is rejected even when it returns from A to A. This
does not make mutable source a sandbox against an actively malicious process
running as the same operating-system user: that process is already inside the
documented local trust boundary and could also replace the bootstrap, Git
metadata, process, or data. Keep the checkout on trusted user-controlled
storage and do not edit it during startup.

## Deployment guidance

- Keep the listener on `127.0.0.1`; do not reverse-proxy or port-forward it.
- Store API keys and explicit `token-env` secrets only in environment variables
  and restrict access to the process account. Brokered login modes have their
  separate bounded credential-source rules below.
- Prefer GitHub `credentialMode: "gh-login"`; if `token-env` is required, use a
  dedicated GitHub token with the minimum repository permissions.
- Review every enabled provider, role permission, workspace, writable path,
  GitHub action, and routing rule before resuming employees.
- Keep backups and the active data directory on trusted local storage with
  user-only permissions.
- Treat logs, backups, memory records, and confirmation history as sensitive.
- For brokered Codex login, run MyDashboard under the same Windows user that
  owns the file login. Never place an authentication file, private credential
  mirror, or account identifier in configuration, project data, backup, logs,
  tests, or a distribution archive.
- Do not make a linked, shared-writable, wrong-owner, oversized, or otherwise
  unsafe Codex login source pass by disabling checks. MyDashboard reports
  `unsafe_source` and never changes the host file or ACL automatically.
- For GitHub `gh-login`, run MyDashboard as the same user that owns the intended
  GitHub CLI current login, bind the exact `actorAccountId`, and use only the
  fixed admitted `gh.exe`. Do not configure `GH_CONFIG_DIR`, copy `hosts.yml`,
  or put a GitHub token in configuration, logs, tests, backups, or packages.
- Treat every GitHub mutation as separately privileged. Login availability
  never substitutes for the per-action confirmation, immutable target/Head
  binding, receipt, or unknown-result reconciliation gate.

`credentialMode: "codex-login"` changes only how a Codex model request
authenticates. The broker selects a fixed same-user file source, stages only its
validated authentication bytes into a disposable profile, serializes calls for
that login identity, captures refreshes into a private mirror, and excludes the
mirror from backup, restore, npm packaging, and open-source distribution. It
does not expose the full host profile, support OS keyring export, or grant Git,
GitHub, repository, code-execution, plugin, MCP, shell, or browser authority.
Claude login brokering is not implemented; Claude remains API-key only.

GitHub `credentialMode: "gh-login"` invokes the fixed CLI only after an exact
confirmation or during reconciliation, verifies account identity, and gives
the selected transport a bounded in-memory credential lease. Account mismatch,
timeout, invalid output, or cleanup failure produces zero writes. The token is
never persisted, but reference cleanup cannot promise physical memory
zeroization by the JavaScript runtime or operating system. Explicit
`token-env` remains available without silent fallback between modes.

See [docs/PRIVACY.md](docs/PRIVACY.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md) for the complete data and operational
boundaries.
