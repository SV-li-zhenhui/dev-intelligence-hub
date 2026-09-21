# U12 Windows private-directory optional signal startup fix

## Problem

Managed startup with active GitHub `gh-login` reaches the production Windows
private-directory manager with no cancellation signal. The manager's public
`prepare` contract permits the signal to be omitted, but its PowerShell child
process adapter forwards the internal `null` sentinel to `execFile`, which
Node rejects before ACL inspection.

## Requirements

- Add a Windows-x64 production-path regression that omits `signal` from
  `PRODUCTION_PRIVATE_DIRECTORY_MANAGER.prepare` and proves private directory
  preparation succeeds under a supported ACL.
- Observe the regression fail with `ERR_INVALID_ARG_TYPE` before changing
  production code.
- Make the smallest correction at the process boundary: omit the `signal`
  option only when it is `null` or `undefined`; preserve supplied AbortSignal
  cancellation and invalid non-null input validation.
- Run the focused regression, the full supervised CLI provider tests, GitHub
  credential-source tests, composition-root tests, syntax checks, and diff
  validation.
- Do not invoke real CLI models, GitHub, credentials, network writes, or push.
