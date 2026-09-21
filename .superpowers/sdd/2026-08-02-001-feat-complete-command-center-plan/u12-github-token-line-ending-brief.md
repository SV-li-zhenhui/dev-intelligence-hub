# U12 GitHub CLI token line-ending compatibility fix

## Problem

After managed startup succeeded on configuration v9, the product itself tried
to reconcile seven historical uncertain Review actions. Every credential
acquisition failed closed with `GITHUB_CREDENTIAL_OUTPUT_INVALID`.

The parser accepted a token with no terminator or one CRLF terminator, but
explicitly rejected one LF terminator. GitHub CLI's official `auth token`
implementation writes the token with `fmt.Fprintf(..., "%s\n", val)`.

## Requirements

- Move the synthetic single-LF output case from invalid to valid and observe
  the focused test fail before production changes.
- Remove exactly one terminal LF or CRLF while preserving all existing strict
  token, UTF-8, byte-limit, stderr, and single-line checks.
- Keep empty, leading/trailing whitespace, multiple-line, repeated-terminator,
  malformed UTF-8, and oversized output invalid.
- Run credential source and every confirmation/external-action consumer suite.
- Do not expose a real token, invoke installed `gh` directly, perform a GitHub
  write, call a model, mutate ACLs, or push.
