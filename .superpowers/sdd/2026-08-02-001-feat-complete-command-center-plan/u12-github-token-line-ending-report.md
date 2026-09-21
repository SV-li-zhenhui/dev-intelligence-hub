# U12 GitHub CLI token line-ending compatibility report

## Status

COMPLETE — managed runtime proof pending.

## Runtime evidence

The product's own recovery path attempted all seven historical uncertain
Review reconciliations after v9 startup. Each retained unknown outcome and was
updated with the same sanitized `GITHUB_CREDENTIAL_OUTPUT_INVALID` failure;
the queue stayed at zero pending and no GitHub write was admitted.

GitHub CLI's official source prints successful `auth token` output with one
terminal LF:
`https://github.com/cli/cli/blob/trunk/pkg/cmd/auth/token/token.go`.

## RED and implementation

The existing strict-token test was changed so the synthetic fictional token
plus one LF is valid. Before production changes it failed at the new 38-byte
case with `GITHUB_CREDENTIAL_OUTPUT_INVALID`.

`parseToken` now removes exactly one terminal CRLF or LF before applying the
unchanged token validator. It does not trim general whitespace, accept more
than one line, or inspect/log token contents.

## GREEN and verification

- Focused strict token-line suite: 11 pass, 0 fail.
- Credential/confirmation/composition/external-action consumer group: 305
  pass, 0 fail, 0 skip.
- Syntax checks and `git diff --check`: passed.

Independent review of exact range `3038d31..27ba329` found no Critical,
Important, or Minor issue and approved the commit for managed restart.

## Changed production/test files

- `src/adapters/gh-login-credential-source.js`
- `test/github-credential-source.test.js`

No real token was exposed, no installed `gh` was invoked directly, and no
model call, GitHub write, ACL mutation, or push occurred.
