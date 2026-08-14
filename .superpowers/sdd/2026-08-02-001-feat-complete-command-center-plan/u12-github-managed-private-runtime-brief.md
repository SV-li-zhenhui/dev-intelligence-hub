# U12 GitHub managed private-runtime correction

## Problem

After the cross-volume and optional-signal startup fixes, managed v9 startup
reached the real Windows ACL gate and failed with
`Private directory trust is unavailable`. Read-only ACL evidence showed the
implementation selected the service user's home directory, whose DACL grants
another SID inheritable write rights. The security gate correctly refuses to
create a credential workspace below such a mutable parent.

The owner-approved GitHub CLI login design requires command working
directories inside MyDashboard's private runtime. It does not require a home
directory root.

## Required correction

- Use the exact private runtime directory authenticated by the managed process
  controller as the parent authority for GitHub credential workspaces.
- Pass that directory explicitly from managed server startup to application
  composition and then to the configured GitHub credential factory. Do not
  derive it from a model, role, page, configuration draft, generic dependency
  bag, or host home directory.
- Bind the runtime directory's final component to the current 64-character
  project identity digest before creating any directory.
- Prepare one fixed `github-credentials-v1` child with the existing production
  private-directory manager and retain complete protected-root overlap checks.
- Keep `token-env` directory-free and usable without a managed runtime path.
- Do not weaken or mutate the user's home ACL and do not modify GitHub/Codex
  credentials.

## TDD and verification

- Observe RED for cross-volume factory placement and managed-server wiring.
- Prove the factory path, project-digest binding, protected-root rejection,
  exact prepared identity, zero token-env directory work, and server handoff.
- Run composition root, managed process control, server, supervised CLI, and
  GitHub credential-source suites; run syntax and diff checks.
- No real CLI/model invocation, credential read, GitHub action, network write,
  or push.
