# Contributing to Development Intelligence Hub

Development Intelligence Hub is a local-first engineering command center.
Contributions are welcome when they preserve its core trust boundaries: model
output is untrusted, source workspaces are not mutated implicitly, and every
external or irreversible action requires explicit owner confirmation.

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). Use the repository issue and pull request
templates so reports include the minimum reproducible information without
exposing private data. Security vulnerabilities follow the private process in
[SECURITY.md](SECURITY.md), never a public issue.

Contributions intentionally submitted for inclusion are provided under
Apache-2.0 unless explicitly stated otherwise.

## Development setup

Requirements:

- Node.js 22 or newer
- npm as provided with Node.js
- Git
- Optional: Ollama for local model-backed behavior
- Optional: Docker Desktop for the opt-in sandbox integration test

From a fresh checkout:

```powershell
npm ci
npm test
npm start
```

Hosted GitHub Actions runs the portable regression set. Tests that exercise real
Codex/GitHub login lifecycles, Windows private ACLs, and the PowerShell service
manager remain part of `npm test` and require a configured Windows workstation.
Run the complete `npm test` before release; hosted CI does not replace that gate.

The source checkout uses `package-lock.json`; the published/offline payload
uses `npm-shrinkwrap.json`. Dependency updates must regenerate the checkout
lock and then copy it byte-for-byte to the shrinkwrap. Distribution acceptance
rejects either an uncommitted lock or any divergence between them.

No private configuration is required for this safe start. Copy
`config.example.json` to `config.json` only when you are ready to customize it.
The example binds only to loopback, has no repositories or personal
identifiers, predefines only paused generic roles, and keeps model, executor,
workflow, memory, GitHub-read, and GitHub-write capabilities disabled.

Keep private settings in `config.json` or `config.local.json`; both are ignored
by Git. Keep API keys and GitHub tokens in environment variables referenced by
name from local configuration. Never commit credentials, private checkout
paths, production data, backups, logs, or generated review artifacts.

## Change workflow

1. Add or update focused tests for each behavior change.
2. Run `npm test` and `node scripts/validate-ui.mjs`.
3. For executor changes, run the opt-in Docker test against the pinned image
   digest and confirm the source checkout remains unchanged.
4. For state or recovery changes, test restart, corruption, partial writes, and
   unknown-result reconciliation.
5. Run `git diff --check` before preparing a review.

Do not weaken a fail-closed boundary merely to make a test pass. If a change
adds a new model, tool, repository, data class, external action, or recovery
path, document the authority it receives and how that authority is revoked.

## Code and tests

- Prefer small modules with explicit, least-authority ports.
- Validate untrusted values at the boundary and return immutable projections.
- Never expose raw shell, filesystem paths, credentials, or mutable store
  objects to a model or browser client.
- Bind proposals and confirmations to stable revisions and content digests.
- Use temporary directories and fake remote transports in ordinary tests.
- Do not contact or write to GitHub from the default test suite.

Security-sensitive changes should explain threat assumptions and include a
negative test proving that unauthorized data or side effects are rejected
before a provider, command runner, or remote transport is called.

## Reporting problems

Use the process in [SECURITY.md](SECURITY.md) for vulnerabilities. For ordinary
bugs, include the operating system, Node.js version, relevant safe
configuration fields, reproduction steps, and sanitized logs. Do not attach
tokens, private repository content, memory records, or backup payloads.
