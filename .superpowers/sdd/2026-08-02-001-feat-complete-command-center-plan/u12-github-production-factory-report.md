# U12 GitHub production credential-factory startup report

## Status

COMPLETE — managed restart pending.

## RED

Command:

```powershell
node --test --test-name-pattern="production factory constructs" test/github-credential-source.test.js
```

The new shipped-factory regression failed 0/1 with `TypeError: GitHub
credential test dependencies are invalid`, matching the managed-startup
failure. The regression only constructs the source around a compiled synthetic
offline fixture; it does not call `acquire` or execute the fixture.

## Implementation

The production factory now converts its two broad production objects into the
same least-authority plain ports required by the dependency validator:

- the environment contains only `SystemRoot`, `WINDIR`, `USERPROFILE`,
  `APPDATA`, and `LOCALAPPDATA` when each has a safe own string value;
- the supervised runner exposes only a bound `run` function in a frozen plain
  record.

The strict validator was not relaxed. No token or credential environment name
is copied.

## GREEN and verification

- Focused production-factory regression: 1 pass, 0 fail.
- Complete GitHub credential-source suite: 38 pass, 0 fail.
- Complete composition-root suite: 84 pass, 0 fail.
- Complete supervised-process-runner suite: 15 pass, 0 fail.
- `git diff --check`: passed.

Independent static review of exact range `0ed2469..e33be33` found no Critical,
Important, or Minor issue and approved the commit for managed restart.

## Changed production/test files

- `src/adapters/gh-login-credential-source.js`
- `test/github-credential-source.test.js`

No installed CLI invocation, credential read, model call, GitHub action,
network write, ACL mutation, or push occurred.
