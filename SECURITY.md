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

MyDashboard is a single-user, loopback-only application. It is not designed to
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

## Deployment guidance

- Keep the listener on `127.0.0.1`; do not reverse-proxy or port-forward it.
- Store secrets only in environment variables and restrict access to the
  process account.
- Use a dedicated GitHub token with the minimum repository permissions.
- Review every enabled provider, role permission, workspace, writable path,
  GitHub action, and routing rule before resuming employees.
- Keep backups and the active data directory on trusted local storage with
  user-only permissions.
- Treat logs, backups, memory records, and confirmation history as sensitive.

See [docs/PRIVACY.md](docs/PRIVACY.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md) for the complete data and operational
boundaries.
