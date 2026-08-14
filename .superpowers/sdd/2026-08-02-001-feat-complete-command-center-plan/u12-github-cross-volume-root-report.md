# U12 GitHub cross-volume runtime root report

## Status

DONE

## RED

Command:

```powershell
node --test --test-reporter=tap --test-name-pattern "permits a home-drive runtime root outside project protected roots" test/composition-root.test.js
```

Result: failed as expected before the production correction: 0 pass, 1 fail, 0 skipped. The regression exercised `createConfiguredGitHubCredentialSource` with `D:\projects\dashboard` as both project and protected root and `C:\Users\<user>` as the injected home directory. It failed with `GitHub runtime temporary root overlaps a protected root` from `assertGitHubRuntimeTemporaryRoot`.

## Implementation

Changed `pathsOverlap` in `src/composition-root.js` so a `path.relative()` result can identify containment only when it is not absolute. This keeps exact matches and same-volume ancestor/descendant overlap checks fail-closed while treating roots on different Windows volumes as disjoint.

Added one Windows-only regression at the exported `createConfiguredGitHubCredentialSource` boundary. It injects the project identity, private-directory manager, and gh-login factory; it creates no credentials and invokes neither `gh` nor a network/service/model dependency. On this Windows host it constructs a source and verifies the project-private runtime root is under the injected `C:` home directory.

Changed implementation files:

- `src/composition-root.js`
- `test/composition-root.test.js`

## GREEN and verification

Focused regression:

```powershell
node --test --test-reporter=tap --test-name-pattern "permits a home-drive runtime root outside project protected roots" test/composition-root.test.js
```

Result: 1 pass, 0 fail, 0 skipped.

Focused composition-root test file:

```powershell
node --test --test-reporter=tap test/composition-root.test.js
```

Result: 83 pass, 0 fail, 0 skipped.

Relevant GitHub credential-source test file:

```powershell
node --test --test-reporter=tap test/github-credential-source.test.js
```

Result: 37 pass, 0 fail, 0 skipped.

Syntax and diff checks:

```powershell
node --check src/composition-root.js
node --check test/composition-root.test.js
git diff --check
```

Result: all passed with exit code 0.

## Commit

Implementation and regression commit: `9d7c90d5647e583690ed48817a71c09bf2835ad5` (`fix(github): allow cross-volume runtime roots`).

## Self-review and concerns

The change is confined to the existing containment predicate and does not expose helpers or add configuration. `relative === ""` still rejects exact equality; same-volume descendants produce non-absolute paths and remain rejected in either direction; cross-volume `relative()` output is absolute and now correctly cannot establish containment.

No concerns identified. The added test intentionally skips on non-Windows hosts because the reproduced `path.relative()` cross-volume behavior is Windows-specific; it executed on this Windows host.
