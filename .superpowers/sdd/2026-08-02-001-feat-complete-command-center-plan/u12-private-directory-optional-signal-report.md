# U12 Windows private-directory optional signal report

## Status

DONE

## RED

Command:

```powershell
node --test --test-reporter=tap --test-name-pattern "omitted optional signal" test/supervised-cli-brain-provider.test.js
```

Before the production correction the new Windows production-path regression
failed 0/1 with `ERR_INVALID_ARG_TYPE`: `execFile` received `signal: null`.

## Implementation

`runPowerShell` now adds `options.signal` only when the caller supplied a
non-null value. Supplied AbortSignals still pass through unchanged, while
invalid non-null values remain subject to Node's native validation.

The regression uses the real production private-directory manager and Windows
ACL inspection/creation path with a synthetic temporary directory; it omits
the optional signal and invokes no CLI, credential, model, service, network,
or GitHub operation.

## GREEN and verification

- Focused regression: 1 pass, 0 fail, 0 skip.
- `supervised-cli-brain-provider`, `github-credential-source`, and
  `composition-root`: 194 pass, 0 fail, 2 documented Windows file-symlink
  privilege skips.
- Syntax checks and `git diff --check`: passed.

## Changed production/test files

- `src/lib/private-directory-manager.js`
- `test/supervised-cli-brain-provider.test.js`

No real CLI/model invocation, credential read, GitHub action, network write,
service mutation beyond the failed startup attempt, or push occurred.
