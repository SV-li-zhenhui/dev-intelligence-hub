# Codex ChatGPT Login Credential Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a configured `codex-cli` brain use the current MyDashboard service user's existing file-backed Codex ChatGPT login without exposing the host profile, changing repository/GitHub authority, or silently changing existing API-key providers.

**Architecture:** Keep the host `auth.json`, a MyDashboard-owned persistent credential mirror, and every invocation-local `CODEX_HOME` as three separate trust tiers. A capability-gated singleton broker serializes all ChatGPT-login calls through one FIFO lease, delegates handle-bound Windows file and ACL work to a fixed native helper, stages only `auth.json` into the existing supervised invocation, captures refreshes after the process tree is reaped, and exposes a separate sanitized no-model readiness port. Configuration, confirmation, role routing, controlled execution, GitHub adapters, and durable work evidence remain authoritative outside the CLI.

**Tech Stack:** Node.js 22+ ESM, Windows x64 PowerShell 5.1 plus fixed C# P/Invoke helper, existing `KnownCliLocator`, `SupervisedProcessRunner`, `PRODUCTION_PRIVATE_DIRECTORY_MANAGER`, Node test runner, Playwright, managed MyDashboard lifecycle, Docker-backed U12 validation.

## Global Constraints

- First-release runtime is Windows x64 with Codex CLI `>=0.147.0 <0.148.0`; unsupported platform, architecture, package identity, or version fails closed.
- `credentialMode` allows only `api-key` and `codex-login`; an existing CLI provider with no field remains effectively `api-key` and is not rewritten automatically.
- A new Codex CLI template writes `credentialMode: "codex-login"`; Claude CLI writes and accepts only `credentialMode: "api-key"` in this release.
- The host login source comes only from startup `CODEX_HOME/auth.json`, or `~/.codex/auth.json` when `CODEX_HOME` is absent. Configuration, HTTP requests, and the page cannot provide a path.
- The host source must be a current-user-owned regular non-reparse file with no linked ancestors, one hard link, no unauthorized effective write/delete/owner/ACL rights, and a size of `1..65536` bytes.
- The private mirror stays outside the repository, application data, operations data, backups, controlled workspaces, and CLI temporary roots; it is protected for the current user, SYSTEM, and Administrators only.
- The mirror envelope has exact keys `schemaVersion`, `sourceDigest`, `credentialDigest`, `credentialBase64`, and `updatedAt`; `schemaVersion` is `1`, and publication is synchronized and atomic with no history.
- All `codex-login` providers for the service user share one FIFO exclusive lease covering source synchronization, the complete model call, refresh publication, invocation cleanup, and release.
- The child environment starts empty. Login mode adds only invocation-local `CODEX_HOME` to the existing profile allowlist and contains no API key, GitHub, Git, SSH, host profile, `NODE_OPTIONS`, plugin, MCP, or shell authority.
- The broker never writes the host `auth.json`; a host logout revokes mirror use for the next task, and a changed host source replaces the mirror generation at the next task boundary.
- Page, HTTP, logs, errors, audit, backup, restore, package, test snapshot, and validation evidence must not contain credential bytes, Base64, digests, account identifiers, or host/mirror/invocation paths.
- Readiness executes only fixed `codex login status` inside a disposable isolated profile after a secure source copy. It does not call a model, inspect host config, or initialize the durable mirror.
- Authentication changes no repository, Code Job, Git, `gh`, GitHub, confirmation, or external-action authority. CLI output remains untrusted structured input.
- Do not push. Stage only named task files, preserve the existing modified `.superpowers/sdd/2026-08-02-001-feat-complete-command-center-plan/progress.md`, and never reset, checkout, clean, or discard existing work.
- PR `#23178` remains product-only read acceptance. Codex development workers do not access it; comments, Reviews, branch updates, push, merge, and source application remain prohibited until separately confirmed in the page.

---

## Scope Check

This is one vertical security feature rather than independent subprojects: the store is unsafe without the lease, the lease is unused without provider integration, and provider activation is unusable without configuration and readiness. The implementation is split into reviewer-sized tasks at stable interfaces, while the final managed restart and product-only PR acceptance remain an explicit operational gate.

## File Structure

### New files

- `src/lib/windows-codex-credential-file.js` — validates the fixed helper protocol, launches the helper with an empty-origin environment, and exposes bounded handle-based source/private-file operations.
- `src/lib/windows-codex-credential-helper.ps1` — performs Windows handle, file identity, owner/DACL, relative private-file, synchronized write, atomic replace, and bounded temporary-file cleanup operations.
- `src/lib/codex-login-credential-store.js` — resolves fixed locations, enforces non-overlap, applies source-vs-mirror generation policy, validates the exact envelope, and stages/captures opaque credentials.
- `src/adapters/codex-login-credential-broker.js` — owns the singleton FIFO queue, task leases, provider availability check, disposable readiness probe, redacted states, and close semantics.
- `public/brain-provider-status-view.js` — renders only sanitized Codex CLI/login readiness and restart guidance.
- `scripts/verify-codex-login-readiness.mjs` — queries the running product's sanitized endpoint and prints one stable no-model acceptance marker.
- `test/windows-codex-credential-file.test.js` — helper protocol, ACL, identity, link, bound, replacement, and redaction tests.
- `test/codex-login-credential-store.test.js` — source/mirror generation, envelope, logout, restart, race, and non-overlap tests.
- `test/codex-login-credential-broker.test.js` — FIFO, cancellation, close, profile, refresh, readiness, and status projection tests.
- `test/frontend-brain-provider-status-contract.test.js` — escaped, bounded, secret-free readiness UI contract.
- `test/codex-login-readiness-command.test.js` — command response validation and output-redaction contract.

### Existing files modified

- `src/domain/configuration-contract.js` — admit and classify `credentialMode` without materializing a default into old documents.
- `public/configuration-form-schema.js`, `public/configuration-form-support.js`, `public/settings-view.js` — contextual mode field/slot, labels, templates, and exact combinations.
- `src/services/configured-workforce.js` — forward the effective mode and preserve broker availability through provider boundaries.
- `src/adapters/supervised-cli-brain-provider.js` — select API-key or broker mode, stage/capture login state, and expose no-model availability.
- `src/services/brain-router.js`, `src/services/role-decision-engine.js`, `src/services/configured-role-employee.js`, `src/services/role-worker-directory.js`, `src/services/proactive-work-loop.js` — carry optional availability checks so a known-unavailable configured brain is degraded before a ledger claim.
- `src/composition-root.js` — construct and track one capability-gated broker before all configured routers, include credential roots in isolation, and expose only its sanitized status port.
- `src/server.js`, `public/app.js`, `public/styles.css` — serve and display the read-only status without changing operational readiness or action admission.
- `test/fixtures/fake-structured-cli.mjs`, `test/supervised-cli-brain-provider.test.js`, `test/supervised-cli-brain-end-to-end.test.js`, `test/configured-workforce.test.js`, `test/brain-router.test.js`, `test/configured-role-employee.test.js`, `test/role-worker-directory.test.js`, `test/proactive-work-loop.test.js`, `test/composition-root.test.js`, `test/server.test.js`, `test/browser/configuration-form-playwright.mjs` — cross-layer behavior and authority evidence.
- `test/backup-service.test.js`, `test/offline-restore-runtime.test.js`, `test/open-source-distribution.mjs` — prove the mirror is absent from backup, restore, clean-room, and npm payloads.
- `config.example.json`, `README.md`, `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/PRIVACY.md`, `SECURITY.md` — safe configuration and operations guidance.
- `validation-notes.md`, `docs/plans/2026-08-02-001-feat-complete-command-center-plan.md` — record only final sanitized acceptance evidence.

## Stable Interfaces

These names and shapes are fixed for all tasks:

```js
createProductionCodexCredentialFilePort() -> {
  readSource({ file, maximumBytes, signal }) -> Promise<Buffer>,
  readPrivate({ directory, name, maximumBytes, required, signal }) -> Promise<Buffer|null>,
  writeNewPrivate({ directory, name, bytes, signal }) -> Promise<void>,
  replacePrivate({ directory, name, bytes, signal }) -> Promise<void>,
  removePrivate({ directory, name, signal }) -> Promise<void>
}

createTestCodexCredentialFilePort({ invoke }) -> same port

productionCodexLoginLocations() -> {
  sourceFile: absolutePath,
  mirrorRoot: absolutePath,
  mirrorDirectory: absolutePath,
  probeRoot: absolutePath
}

createProductionCodexLoginCredentialStore({ protectedRoots }) -> store
createTestCodexLoginCredentialStore(options, dependencies) -> store

store.beginTask({ signal }) -> Promise<opaqueSnapshot>
store.stageTask({ snapshot, codexHome, signal }) -> Promise<void>
store.captureTask({ snapshot, codexHome, signal }) -> Promise<void>
store.stageProbe({ codexHome, signal }) -> Promise<void>

createProductionCodexLoginCredentialBroker(grant) -> broker
createTestCodexLoginCredentialBroker(options, dependencies) -> broker

broker.acquire({ signal }) -> Promise<lease>
broker.checkAvailability({ signal = null } = {}) -> Promise<void>
broker.readStatus({ signal = null } = {}) -> Promise<{
  schemaVersion: 1,
  state: "available"|"file_login_unavailable"|"unsafe_source"|"broker_blocked"|"cli_unavailable",
  cliAvailable: boolean,
  fileLoginAvailable: boolean
}>
broker.close({ signal = null } = {}) -> Promise<void>

lease.stage({ invocation, signal }) -> Promise<{ codexHome: absolutePath }>
lease.capture({ signal }) -> Promise<void>
lease.release({ safe }) -> void
```

`directory`, `codexHome`, and `invocation` identities are exact frozen records with `path`, `device`, and `inode` string fields. The opaque task snapshot is accepted only by the store instance that created it and has no enumerable credential or digest fields.

### Task 1: Configuration Contract and Structured Form

**Files:**
- Modify: `src/domain/configuration-contract.js:72-101,503-535,1590-1620`
- Modify: `public/configuration-form-schema.js:183-198,321-325,395-428,459-500,499-540,777-794`
- Modify: `public/configuration-form-support.js:272-340,987-1010,1212-1255,1840-2010`
- Modify: `public/settings-view.js:60-90,347-390`
- Test: `test/configuration-contract.test.js:715-835,937-975`
- Test: `test/configuration-form-schema.test.js:391-450`
- Test: `test/configuration-form-support.test.js:1855-1940`
- Test: `test/frontend-configuration-form-contract.test.js:259-340`

**Interfaces:**
- Consumes: existing configuration document normalization, impact classification, generic field descriptors, and structural slots.
- Produces: optional persisted `credentialMode`, effective runtime default `api-key`, contextual select options/labels, and restart/authority impact paths consumed by later tasks.

- [ ] **Step 1: Write the failing domain-contract cases**

Add exact cases proving missing mode stays absent, explicit valid modes normalize, Claude rejects `codex-login`, all non-CLI providers reject the field, and a Codex mode change is a provider-identity authority change requiring restart:

```js
const legacy = document();
legacy.brainProviders.cli = { kind: "codex-cli", remote: true };
assert.equal(
  Object.hasOwn(normalizeConfigurationDocument(legacy).brainProviders.cli, "credentialMode"),
  false,
);

const login = structuredClone(legacy);
login.brainProviders.cli.credentialMode = "codex-login";
assert.equal(
  normalizeConfigurationDocument(login).brainProviders.cli.credentialMode,
  "codex-login",
);
assert.deepEqual(configurationDocumentImpact(legacy, login).authority_expansion, [
  "brainProviders.cli.credentialMode",
]);
assert.deepEqual(configurationDocumentImpact(legacy, login).restart_required, [
  "brainProviders.cli.credentialMode",
]);
```

- [ ] **Step 2: Write the failing schema/form cases**

Assert the new Codex template defaults to `codex-login`, the Claude template writes `api-key`, an old CLI provider offers an optional mode slot without being rewritten, and visible choices have exact labels:

```js
assert.equal(
  configurationStructureTemplate(["brainProviders"], "codex-cli").value.credentialMode,
  "codex-login",
);
assert.equal(
  configurationStructureTemplate(["brainProviders"], "claude-cli").value.credentialMode,
  "api-key",
);
const descriptor = configurationFieldDescriptor(
  ["brainProviders", "codex-cli", "credentialMode"],
  "codex-login",
  { providerKind: "codex-cli" },
);
assert.deepEqual(descriptor.options, ["codex-login", "api-key"]);
assert.equal(descriptor.optionLabels["codex-login"], "Codex 当前登录（受管代理，推荐）");
assert.equal(descriptor.optionLabels["api-key"], "环境变量 API Key");
```

- [ ] **Step 3: Run the four focused tests to confirm RED**

Run:

```powershell
node --test test/configuration-contract.test.js test/configuration-form-schema.test.js test/configuration-form-support.test.js test/frontend-configuration-form-contract.test.js
```

Expected: FAIL only on missing `credentialMode` admission, contextual slot/options, and template assertions.

- [ ] **Step 4: Implement the domain shape without silent migration**

Add `credentialMode` to `PROVIDER_FIELDS`, accept it only for CLI records, and copy it only when present:

```js
const CLI_CREDENTIAL_MODES = new Set(["api-key", "codex-login"]);

if (Object.hasOwn(config, "credentialMode")) {
  const mode = text(config.credentialMode, `${path}.credentialMode`, 32);
  if (!CLI_CREDENTIAL_MODES.has(mode) || (kind === "claude-cli" && mode !== "api-key")) {
    throw invalid(`${path}.credentialMode`, "CLI 大脑认证方式无效");
  }
  normalized.credentialMode = mode;
}
```

Reject `credentialMode` on Ollama/OpenAI-compatible providers, add it to provider identity direction, and retain the existing `brainProviders.*` restart rule.

- [ ] **Step 5: Implement contextual field and slot descriptors**

Add a slot restricted to CLI provider kinds and a default slot value of `api-key` so old records change only after the owner presses the structural add action:

```js
{
  pattern: ["brainProviders", "*", "credentialMode"],
  label: "认证方式",
  template: "provider-credential-mode",
  providerKinds: ["codex-cli", "claude-cli"],
  optional: true,
  operations: ["add", "remove", "replace"],
}
```

Extend `configurationSlotDescriptor(path, context = null)` and each settings/support caller to pass `{ providerKind }`. Add contextual options and `optionLabels`; update `selectControl()` to render the mapped label while preserving the raw option value.

- [ ] **Step 6: Implement exact form validation**

Allow the field in `assertProvider()`, enforce these combinations in both structural admission and `providerConfigurationIssues()`, and keep secret/path detection generic:

```js
const mode = provider.credentialMode ?? "api-key";
const invalidMode =
  !["api-key", "codex-login"].includes(mode) ||
  (provider.kind === "claude-cli" && mode !== "api-key") ||
  (!isCli && Object.hasOwn(provider, "credentialMode"));
```

Do not add any token, account, executable, source-path, mirror-path, or login-command field.

- [ ] **Step 7: Run the focused contract tests to GREEN**

Run the Step 3 command.

Expected: all four files PASS with no snapshot containing a secret-like value or absolute credential path.

- [ ] **Step 8: Commit the configuration slice**

```powershell
git add -- src/domain/configuration-contract.js public/configuration-form-schema.js public/configuration-form-support.js public/settings-view.js test/configuration-contract.test.js test/configuration-form-schema.test.js test/configuration-form-support.test.js test/frontend-configuration-form-contract.test.js
git commit -m "feat: define Codex login credential mode"
```

### Task 2: Handle-Bound Windows Credential File Port

**Files:**
- Create: `src/lib/windows-codex-credential-file.js`
- Create: `src/lib/windows-codex-credential-helper.ps1`
- Create: `test/windows-codex-credential-file.test.js`
- Modify: `test/open-source-distribution.mjs` only for packaged helper identity coverage

**Interfaces:**
- Consumes: fixed Windows PowerShell location pattern and private identity records used by `private-directory-manager.js`.
- Produces: `createProductionCodexCredentialFilePort()` and `createTestCodexCredentialFilePort({ invoke })` with the exact methods in Stable Interfaces.

**Independent bounds:**

- `MAXIMUM_CREDENTIAL_BYTES = 65_536`: actual credential/source bytes remain `1..65_536`, including host `auth.json` and Task 3 staged/captured credential semantics.
- `MAXIMUM_PRIVATE_FILE_BYTES = 192 * 1024`: generic private files, including the canonical mirror envelope, are `1..192 KiB`.
- `MAXIMUM_PACKET_BYTES = 384 * 1024`: helper JSON request and response packets are `1..384 KiB`; helper stderr remains `4096` bytes and its text is discarded.

- [ ] **Step 1: Write failing protocol and redaction tests**

Use an injected `invoke(request)` to prove exact request/response keys, source `1..65536` bounds, generic private-file `1..192 * 1024` bounds, safe direct-child names, abort propagation, Base64 validation, and generic public errors:

```js
const port = createTestCodexCredentialFilePort({
  async invoke(request) {
    assert.deepEqual(Object.keys(request).sort(), [
      "fileBase64",
      "maximumBytes",
      "operation",
      "schemaVersion",
    ]);
    return { schemaVersion: 1, status: "ok", bytesBase64: Buffer.from("auth").toString("base64") };
  },
});
assert.deepEqual(
  await port.readSource({ file: source, maximumBytes: 65_536, signal }),
  Buffer.from("auth"),
);
```

Assert malformed helper output, extra keys, oversized stdout/stderr, nonzero exit, and a response containing a private marker all map to `CODEX_CREDENTIAL_FILE_OPERATION_FAILED` without retaining that marker in `message`, `stack`, or enumerable fields.

- [ ] **Step 2: Write Windows-only filesystem cases**

Under a temporary current-user-owned root, add cases for a normal file, missing source, zero/oversized source, hardlink, symbolic link when privilege permits, file replacement during read, wrong owner where the test account can create it, an unauthorized effective write ACE, inherited read ACE, and private atomic replacement. Platform/privilege skips must name the missing Windows capability and may not turn an assertion failure into a skip.

```js
for (const fixture of [
  { name: "empty", expectedCode: "CODEX_CREDENTIAL_SOURCE_UNSAFE" },
  { name: "oversized", expectedCode: "CODEX_CREDENTIAL_SOURCE_UNSAFE" },
  { name: "hardlink", expectedCode: "CODEX_CREDENTIAL_SOURCE_UNSAFE" },
  { name: "dangerous-write-ace", expectedCode: "CODEX_CREDENTIAL_SOURCE_UNSAFE" },
]) {
  await assert.rejects(
    port.readSource({ file: fixture.file, maximumBytes: 65_536, signal }),
    (error) => error?.code === fixture.expectedCode,
    fixture.name,
  );
}
```

- [ ] **Step 3: Run the new test to confirm RED**

Run:

```powershell
node --test test/windows-codex-credential-file.test.js
```

Expected: FAIL because both module and helper are absent.

- [ ] **Step 4: Implement the fixed JavaScript wrapper**

Use `spawn()` directly with the fixed `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`, `windowsHide: true`, bounded stdio, and only `SystemRoot`/`WINDIR` in the child environment. Send one exact JSON request through stdin; credentials and paths never enter arguments or environment.

```js
const HELPER_REQUEST_KEYS = Object.freeze({
  "read-source": ["schemaVersion", "operation", "fileBase64", "maximumBytes"],
  "read-private": ["schemaVersion", "operation", "directory", "name", "maximumBytes", "required"],
  "write-new-private": ["schemaVersion", "operation", "directory", "name", "bytesBase64"],
  "replace-private": ["schemaVersion", "operation", "directory", "name", "bytesBase64"],
  "remove-private": ["schemaVersion", "operation", "directory", "name"],
});
```

Cap request and response packets at `384 * 1024` bytes and helper stderr at `4096` bytes; discard stderr text. Keep source reads independently capped at `65536` bytes and generic private reads/writes independently capped at `192 * 1024` bytes in JavaScript, PowerShell, and native C#.

- [ ] **Step 5: Implement handle and ACL admission in the helper**

The C# helper must open ancestors and the source with `CreateFileW` plus `FILE_FLAG_OPEN_REPARSE_POINT`, compare volume/file IDs before and after, require `FileType.Disk`, reject any reparse tag, require `NumberOfLinks == 1`, and read exactly the handle-reported byte count. Resolve owner/DACL from the open handle with `GetSecurityInfo`; owner must equal `WindowsIdentity.GetCurrent().User`.

Use these dangerous rights after generic-right mapping:

```powershell
$DangerousRights = 0x0002 -bor 0x0004 -bor 0x0010 -bor 0x0100 -bor 0x00010000 -bor 0x00040000 -bor 0x00080000
$AllowedDangerousSids = @(
  [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  "S-1-5-18",
  "S-1-5-32-544"
)
```

For every other trustee named by an allow ACE, use effective ACL rights and reject any overlap with `DangerousRights`; read-only inherited principals remain admissible.

- [ ] **Step 6: Implement relative private-file operations and atomic replace**

Open the supplied directory by its expected device/inode identity and only then open the validated direct-child `name`. Generic private-file reads, create-new writes, and replacements admit only `1..192 * 1024` bytes. `write-new-private` uses create-new semantics and `FlushFileBuffers`. `replace-private` writes a unique `state.tmp.<pid>.<32-hex>` sibling, flushes and revalidates it, publishes with `ReplaceFileW` or `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`, and reopens the final file to verify exact bytes. Scan at most 32 direct children and 256 KiB while deleting only matching owned temporary names; reject directories and links.

- [ ] **Step 7: Run native and distribution tests to GREEN**

Run:

```powershell
node --test test/windows-codex-credential-file.test.js test/open-source-distribution.mjs
```

Expected: PASS; only privilege-specific symlink/owner cases may be explicitly skipped, and `npm pack --dry-run --json` includes the fixed helper under `src/lib/`.

- [ ] **Step 8: Commit the file-security slice**

```powershell
git add -- src/lib/windows-codex-credential-file.js src/lib/windows-codex-credential-helper.ps1 test/windows-codex-credential-file.test.js test/open-source-distribution.mjs
git commit -m "feat: secure Codex credential file operations"
```

### Task 3: Source and Persistent Mirror Store

**Files:**
- Create: `src/lib/codex-login-credential-store.js`
- Create: `test/codex-login-credential-store.test.js`
- Modify: `test/backup-service.test.js`
- Modify: `test/offline-restore-runtime.test.js`

**Interfaces:**
- Consumes: Task 2 credential file port and `PRODUCTION_PRIVATE_DIRECTORY_MANAGER.prepare({ directory, signal, validateLocation })`.
- Produces: location resolver plus production/test stores and opaque snapshots defined in Stable Interfaces.

- [ ] **Step 1: Write failing fixed-location and non-overlap tests**

Prove `CODEX_HOME` is accepted only as an existing absolute directory, the default is `<homedir>/.codex/auth.json`, and the mirror/probe roots are fixed siblings outside every supplied protected root. Add table cases where repository, data, backup, workspace, CLI temp, source root, mirror root, or probe root contains another; each must fail before directory creation.

```js
assert.deepEqual(productionCodexLoginLocations(), {
  sourceFile: path.join(codexRoot, "auth.json"),
  mirrorRoot: path.join(home, ".mydashboard-cli-credentials-v1"),
  mirrorDirectory: path.join(home, ".mydashboard-cli-credentials-v1", "codex-login"),
  probeRoot: path.join(home, ".mydashboard-codex-login-probe-v1"),
});
```

- [ ] **Step 2: Write failing source/mirror state-machine tests**

Use a fake file port to cover: first source initializes one envelope; unchanged source uses refreshed mirror bytes; changed source replaces mirror bytes; missing source removes mirror use; temporarily unsafe source preserves but does not use the mirror; corrupt envelope blocks; capture updates `credentialDigest` but keeps `sourceDigest`; a reconstructed store uses the refreshed bytes.

Assert exact envelope keys and canonical newline-terminated JSON:

```js
assert.deepEqual(Object.keys(envelope).sort(), [
  "credentialBase64",
  "credentialDigest",
  "schemaVersion",
  "sourceDigest",
  "updatedAt",
]);
assert.equal(envelope.schemaVersion, 1);
assert.match(envelope.sourceDigest, /^[a-f0-9]{64}$/);
assert.match(envelope.credentialDigest, /^[a-f0-9]{64}$/);
```

- [ ] **Step 3: Write failing race, bound, and secrecy tests**

Inject replacement/short-read failures at source read, envelope read, temporary write, flush, replace, final verify, stage, and capture. Assert each task fails closed, no credential/digest/path appears in any thrown error, old or new complete envelope remains the only usable state, and an opaque snapshot has zero enumerable keys and is rejected by another store instance.

```js
const privateMarkers = [fictionalCredential, sourcePath, mirrorPath, sourceDigest];
await assert.rejects(store.beginTask({ signal }), (error) => {
  const publicFailure = JSON.stringify({
    message: error?.message,
    code: error?.code,
    stack: error?.stack,
    fields: Object.fromEntries(Object.entries(error || {})),
  });
  return privateMarkers.every((marker) => !publicFailure.includes(marker));
});
```

- [ ] **Step 4: Run store tests to confirm RED**

Run:

```powershell
node --test test/codex-login-credential-store.test.js test/backup-service.test.js test/offline-restore-runtime.test.js
```

Expected: FAIL because the store and credential-exclusion assertions are absent.

- [ ] **Step 5: Implement fixed locations and private directory preparation**

Resolve production locations from startup environment/homedir without I/O at module import. On first task operation, prepare `mirrorRoot` and `mirrorDirectory` in order, re-run non-overlap validation before and after each `prepare()`, and retain their identity records. Invalid source location maps to `CODEX_LOGIN_SOURCE_UNSAFE`; private directory or envelope uncertainty maps to `CODEX_LOGIN_BROKER_BLOCKED`.

- [ ] **Step 6: Implement exact envelope parsing and publication**

Use `canonicalJsonStringify()` plus a final newline, SHA-256 over opaque bytes, strict Base64 round-trip, a 192 KiB envelope cap, and the Task 2 atomic replace port. Validate exact own enumerable data properties and reject proxies, accessors, duplicate JSON keys, unknown versions, mismatched digests, and empty credentials. Independently reject decoded actual credentials above 65536 bytes even though the generic private-file port admits the larger envelope.

```js
function envelope(sourceDigest, credentialBytes, now) {
  return {
    schemaVersion: 1,
    sourceDigest,
    credentialDigest: sha256(credentialBytes),
    credentialBase64: credentialBytes.toString("base64"),
    updatedAt: now.toISOString(),
  };
}
```

- [ ] **Step 7: Implement task, probe, logout, and refresh policy**

`beginTask()` securely reads the host source before touching the mirror. Missing source removes a valid mirror envelope and throws `CODEX_LOGIN_FILE_UNAVAILABLE`; unsafe source leaves the mirror unchanged and throws `CODEX_LOGIN_SOURCE_UNSAFE`. Same source digest selects mirror credentials, changed digest publishes source credentials, and no mirror initializes it. `stageTask()` and `stageProbe()` create only `auth.json` under the supplied private directory identity; `captureTask()` reads it after reap and publishes only under the snapshot's original source generation.

- [ ] **Step 8: Prove backup and restore exclusion**

Create a sentinel mirror in a test-only home outside data/backup, run `BackupService.createBackup()` and offline restore, and assert the sentinel filename/bytes are absent from manifest, payload, restored inventory, and status. Assert restoring to another machine does not create a mirror and leaves the broker status unavailable until that machine has a source.

- [ ] **Step 9: Run store/recovery tests to GREEN**

Run the Step 4 command.

Expected: PASS with deterministic timestamps/digests only inside the private test fixture, never test names, errors, or snapshots.

- [ ] **Step 10: Commit the store slice**

```powershell
git add -- src/lib/codex-login-credential-store.js test/codex-login-credential-store.test.js test/backup-service.test.js test/offline-restore-runtime.test.js
git commit -m "feat: persist isolated Codex login credentials"
```

### Task 4: FIFO Broker, Disposable Probe, and Lifecycle

**Files:**
- Create: `src/adapters/codex-login-credential-broker.js`
- Create: `test/codex-login-credential-broker.test.js`

**Interfaces:**
- Consumes: Task 3 store, `KnownCliLocator.resolve("codex-cli", { signal })`, `SupervisedProcessRunner.run()`, private directory identities, and `prepareCleanupTreesByIdentity()`.
- Produces: production/test broker, task lease, sanitized status, and close behavior defined in Stable Interfaces.

- [ ] **Step 1: Write failing FIFO and cancellation tests**

Queue three acquisitions, hold the first, cancel the second, release the first, and prove the third acquires next without source/profile/process activity for the cancelled waiter. Assert two provider IDs still share one queue and API-key work never enters it.

```js
const first = await broker.acquire({ signal: firstController.signal });
const second = broker.acquire({ signal: secondController.signal });
const third = broker.acquire({ signal: thirdController.signal });
secondController.abort();
await assert.rejects(second, { code: "STRUCTURED_PROVIDER_CANCELLED" });
first.release({ safe: true });
assert.ok(await third);
```

- [ ] **Step 2: Write failing lease and close tests**

Prove `acquire()` calls `store.beginTask()` while holding the queue, `stage()` creates one `codex-home`, `capture()` is allowed once, `release()` is idempotence-rejecting, unsafe release permanently blocks new leases, and `close()` rejects waiters then waits for the active lease. Abort close with a supplied signal and require a stable cleanup failure.

```js
const lease = await broker.acquire({ signal });
await lease.stage({ invocation, signal });
await lease.capture({ signal });
lease.release({ safe: true });
assert.throws(() => lease.release({ safe: true }), /released/i);
```

- [ ] **Step 3: Write failing readiness tests**

Cover all five states. For `available`, assert fixed args `['login', 'status']`, a branded Codex descriptor, empty input, timeout at most 10000 ms, stdout/stderr limits at most 4096 bytes, isolated cwd/profile paths, no inherited credential/environment fields, no store mirror write, and complete probe-tree removal. Missing source must return before locator/spawn.

```js
assert.deepEqual(await broker.readStatus(), {
  schemaVersion: 1,
  state: "available",
  cliAvailable: true,
  fileLoginAvailable: true,
});
assert.deepEqual(processRuns[0].args, ["login", "status"]);
assert.equal(storeCalls.beginTask, 0);
```

- [ ] **Step 4: Run broker tests to confirm RED**

Run:

```powershell
node --test test/codex-login-credential-broker.test.js
```

Expected: FAIL because the broker module is absent.

- [ ] **Step 5: Implement one abortable FIFO queue**

Use an explicit waiter array rather than one promise tail so cancellation removes a waiter without disturbing order. Once closed or blocked, admission fails synchronously through stable broker errors. A lease owns a store snapshot in closure and exposes only frozen bound methods.

```js
const waiter = { resolve, reject, signal, onAbort };
this.#waiters.push(waiter);
signal?.addEventListener("abort", onAbort, { once: true });
```

Map source unavailable/unsafe to `STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE`, locator failure to `STRUCTURED_PROVIDER_UNAVAILABLE`, queue cancellation to `STRUCTURED_PROVIDER_CANCELLED`, and unsafe lifecycle/publish/cleanup to `STRUCTURED_PROVIDER_CLEANUP_FAILED`.

- [ ] **Step 6: Implement lease stage/capture/release**

Validate the invocation identity, prepare only its direct `codex-home` child, call `store.stageTask()`, retain the returned directory identity privately, and call `store.captureTask()` once. `release({ safe: false })` marks the singleton blocked before waking waiters. A safe release wakes exactly the oldest non-cancelled waiter.

- [ ] **Step 7: Implement disposable no-model readiness**

Run readiness through the same FIFO. Securely stage the host source with `store.stageProbe()` into a unique owner-marked directory below `probeRoot`, run the fixed status command through production locator/runner, accept only exit success plus normalized stdout `Logged in using ChatGPT`, then delete the complete identity-bound tree. Never call `beginTask()` from `readStatus()`.

Implement `checkAvailability()` as the task-grade counterpart: acquire the FIFO, call `store.beginTask()`, stage that opaque snapshot into a disposable profile, run the same fixed status command, capture any safe auth refresh, clean the profile, and release. It may initialize/update the private mirror because it is the pre-claim task boundary; it still makes no model call.

Return only:

```js
Object.freeze({
  schemaVersion: 1,
  state,
  cliAvailable: state !== "cli_unavailable",
  fileLoginAvailable: state === "available",
});
```

- [ ] **Step 8: Implement bounded close**

Set closed before rejecting queued waiters; if no active lease, resolve. Otherwise wait for release or the caller's abort signal. Never force-delete an active invocation or publish while its process state is uncertain.

- [ ] **Step 9: Run broker and private-directory tests to GREEN**

Run:

```powershell
node --test test/codex-login-credential-broker.test.js test/private-directory-manager.test.js
```

Expected: PASS with exact FIFO ordering and zero residual probe directories.

- [ ] **Step 10: Commit the broker slice**

```powershell
git add -- src/adapters/codex-login-credential-broker.js test/codex-login-credential-broker.test.js
git commit -m "feat: broker Codex login task leases"
```

### Task 5: Supervised Provider Integration and Pre-Claim Degradation

**Files:**
- Modify: `src/adapters/supervised-cli-brain-provider.js:75-84,315-355,420-520,1344-1420,1765-2185`
- Modify: `src/services/configured-workforce.js:12-38,240-400`
- Modify: `src/services/brain-router.js:85-225`
- Modify: `src/services/role-decision-engine.js:235-350`
- Modify: `src/services/configured-role-employee.js:300-520`
- Modify: `src/services/role-worker-directory.js:70-200`
- Modify: `src/services/proactive-work-loop.js:530-680,716-765`
- Modify: `test/fixtures/fake-structured-cli.mjs`
- Test: `test/supervised-cli-brain-provider.test.js`
- Test: `test/supervised-cli-brain-end-to-end.test.js`
- Test: `test/configured-workforce.test.js`
- Test: `test/brain-router.test.js`
- Test: `test/configured-role-employee.test.js`
- Test: `test/role-worker-directory.test.js`
- Test: `test/proactive-work-loop.test.js`

**Interfaces:**
- Consumes: Task 1 effective mode and Task 4 broker.
- Produces: mode-aware provider `generate()`/`checkAvailability()`, preserved remote-data denial ordering, and optional worker availability propagated before claim.

- [ ] **Step 1: Write failing provider option/environment tests**

Assert missing mode and explicit `api-key` preserve the current exact environment, `codex-login` requires Codex plus a broker, Claude rejects login mode, and login child environment adds only invocation-local `CODEX_HOME` with no `OPENAI_API_KEY`, `CODEX_API_KEY`, or `CODEX_ACCESS_TOKEN`.

```js
assert.deepEqual(Object.keys(loginRun.env).sort(), [
  "APPDATA", "CI", "CODEX_HOME", "HOME", "LANG", "LC_ALL",
  "LOCALAPPDATA", "NO_COLOR", "TEMP", "TERM", "TMP", "TMPDIR",
  "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
].sort());
```

- [ ] **Step 2: Write failing process/capture precedence tests**

Cover successful refresh, malformed result, nonzero exit, timeout, cancellation, output overflow, reap failure, capture failure, and invocation cleanup failure. Capture after any confirmed reap and before result parsing/cleanup; never capture after `STRUCTURED_PROVIDER_REAP_FAILED`. Capture or cleanup uncertainty must prevent a successful decision and block the shared broker.

```js
await assert.rejects(
  loginProvider.generate(request),
  (error) => error?.code === "STRUCTURED_PROVIDER_RESPONSE_INVALID",
);
assert.deepEqual(events, ["acquire", "stage", "run", "capture", "cleanup", "release:true"]);
```

- [ ] **Step 3: Extend the fake CLI fixture for login mode**

Make the fixture require `CODEX_HOME/auth.json` when `FIXTURE_REQUIRE_CODEX_LOGIN` is in the structured request, record only booleans/relative containment, and replace the file with fixed fictional bytes when `FIXTURE_REFRESH_CODEX_LOGIN` is requested. It must never print or record auth bytes or an absolute profile path.

```js
const authFile = path.join(process.env.CODEX_HOME, "auth.json");
const authVisible = (await lstat(authFile)).isFile();
if (requestText.includes("FIXTURE_REFRESH_CODEX_LOGIN")) {
  await writeFile(authFile, Buffer.from("fictional-refreshed-login-v1"), { flag: "w" });
}
fixture.authVisible = authVisible;
fixture.codexHomeInsideCwd = inside(process.cwd(), process.env.CODEX_HOME);
```

- [ ] **Step 4: Write failing router/workforce and pre-claim tests**

Prove configured workforce forwards effective mode, two configured Codex providers receive the same broker object, remote-data denial calls neither broker nor locator, and malformed output stays single-attempt. Add proactive-loop cases where routine and task-risk items select their corresponding brain availability; when the selected check throws `STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE`, assert `ledger.claim` has zero calls, outcome is `degraded`, and no weaker provider runs.

```js
const result = await loop.runCycle({ roleId: "developer" });
assert.equal(result.claimed, 0);
assert.equal(result.outcomes[0].status, "degraded");
assert.equal(ledger.calls.claim.length, 0);
assert.equal(fallbackCalls, 0);
```

- [ ] **Step 5: Run the cross-layer focused tests to confirm RED**

Run:

```powershell
node --test test/supervised-cli-brain-provider.test.js test/supervised-cli-brain-end-to-end.test.js test/configured-workforce.test.js test/brain-router.test.js test/configured-role-employee.test.js test/role-worker-directory.test.js test/proactive-work-loop.test.js
```

Expected: FAIL only on the new option, broker, capture, availability, and fixture assertions.

- [ ] **Step 6: Implement effective mode and broker dependency**

Add `credentialMode` to provider options and CLI workforce keys. Normalize in the provider constructor:

```js
const credentialMode = options.credentialMode ?? "api-key";
if (!["api-key", "codex-login"].includes(credentialMode)) {
  throw new TypeError("credentialMode is invalid");
}
if (options.cliKind === "claude-cli" && credentialMode !== "api-key") {
  throw new TypeError("Claude CLI credentialMode is invalid");
}
```

Production dependencies receive the singleton broker only through `ProductionCliCompositionGrant`; test dependencies accept a named `codexLoginCredentialBroker` only in `createTestSupervisedCliBrainProvider()`.

- [ ] **Step 7: Integrate the lease into one invocation**

After request/schema/size admission, acquire the login lease inside the existing request deadline. `acquire()` already synchronizes credentials before root recovery, locator, or invocation creation. Inside `#invoke`, stage after invocation creation, build login environment, run the existing Codex arguments unchanged, capture after confirmed reap, parse the result, clean the invocation, and finally release with the proven safe flag.

```js
let lease = null;
let credentialLifecycleSafe = true;
try {
  lease = this.#credentialMode === "codex-login"
    ? await deadline.run(({ signal }) => this.#credentialBroker.acquire({ signal }))
    : null;
  return await this.#invoke({
    request,
    wireInput,
    deadline,
    lease,
    expectedRoot: root,
    onCredentialStaged() { credentialLifecycleSafe = false; },
    onCredentialLifecycleSettled() { credentialLifecycleSafe = true; },
  });
} finally {
  lease?.release({ safe: credentialLifecycleSafe });
}
```

Call `onCredentialStaged()` immediately before staging begins and call `onCredentialLifecycleSettled()` only after confirmed reap, capture, and identity-bound invocation cleanup. A failure before staging remains safe to release; every uncertainty after staging leaves the flag false and blocks the broker.

- [ ] **Step 8: Add no-model availability through provider boundaries**

`SupervisedCliBrainProvider.checkAvailability({ signal })` validates API credential plus locator in API-key mode, or calls the task-grade `broker.checkAvailability()` in login mode. Preserve it through `providerWithBoundary()`, `BrainRouter.checkAvailability(brain, { signal })`, configured routers, and `RoleDecisionEngine.checkAvailability()`.

Configured worker ports expose optional `checkAvailability({ item, signal })` and select routine or task brain with the same `assignedTaskRisk()` rule used by `decide()`. `RoleWorkerDirectory.resolve()` preserves it; `ProactiveWorkLoop.#resolve()` executes it with the candidate item inside the existing resolve deadline before returning an active worker. A stable provider failure returns a degraded resolution/outcome and never calls `ledger.claim`; an unexpected programming error remains a resolution failure. The authoritative `generate()` path repeats source synchronization after claim so a host login change between preflight and invocation still fails closed.

- [ ] **Step 9: Run focused tests to GREEN**

Run the Step 5 command.

Expected: PASS; login refresh survives a second invocation and reconstructed provider, API-key/Claude snapshots are unchanged, and denied data has zero credential/locator/spawn calls.

- [ ] **Step 10: Commit provider integration**

```powershell
git add -- src/adapters/supervised-cli-brain-provider.js src/services/configured-workforce.js src/services/brain-router.js src/services/role-decision-engine.js src/services/configured-role-employee.js src/services/role-worker-directory.js src/services/proactive-work-loop.js test/fixtures/fake-structured-cli.mjs test/supervised-cli-brain-provider.test.js test/supervised-cli-brain-end-to-end.test.js test/configured-workforce.test.js test/brain-router.test.js test/configured-role-employee.test.js test/role-worker-directory.test.js test/proactive-work-loop.test.js
git commit -m "feat: run Codex brains with brokered login"
```

### Task 6: Production Composition and Sanitized Page Status

**Files:**
- Modify: `src/composition-root.js:88-127,186-274,440-610,681-753,990-1140,1660-1680,2100-2185`
- Modify: `src/server.js:2380-2420`
- Create: `public/brain-provider-status-view.js`
- Modify: `public/app.js:140-160,1210-1310,1360-1475,1590-1710,3970-4130`
- Modify: `public/styles.css`
- Test: `test/composition-root.test.js`
- Test: `test/server.test.js`
- Create: `test/frontend-brain-provider-status-contract.test.js`

**Interfaces:**
- Consumes: production broker/provider factories and fixed locations from Tasks 3-5.
- Produces: application port `brainProviderStatus.readStatus({ signal })`, `GET /api/brain-providers/status`, and a sanitized configuration-page card.

- [ ] **Step 1: Write failing composition authority/lifecycle tests**

Assert composition creates exactly one broker, tracks it before any router so reverse close closes providers before broker, passes the same broker to memory/workforce/Code Job routers, includes source/mirror/probe roots in CLI non-overlap, and exposes no broker/store/path/credential methods on the application.

```js
assert.deepEqual(Object.keys(application.brainProviderStatus), ["readStatus"]);
for (const privateName of [
  "codexLoginCredentialBroker",
  "codexLoginCredentialStore",
  "credentialLocations",
]) {
  assert.equal(privateName in application, false);
}
```

- [ ] **Step 2: Write failing server projection tests**

Add `GET /api/brain-providers/status` success, query rejection, missing/invalid port failure, concurrent cancellation, and secret-marker cases. Response must have only `schemaVersion`, `state`, `cliAvailable`, and `fileLoginAvailable`; it must remain reachable when the provider is unavailable and must not mutate configuration.

```js
const response = await request(server, { path: "/api/brain-providers/status" });
assert.equal(response.status, 200);
assert.deepEqual(JSON.parse(response.body), sanitizedStatus);
assert.equal(response.body.includes(privateMarker), false);
```

- [ ] **Step 3: Write failing renderer tests**

Cover all five states, loading/error, pending restart, exact repair guidance, HTML escaping, and forbidden words/markers. The rendered DOM must contain no account, email, token, digest, timestamp, source path, mirror path, `auth.json` content, upload/download button, or arbitrary command input.

```js
const html = renderBrainProviderStatus({
  state: { schemaVersion: 1, state: "file_login_unavailable", cliAvailable: true, fileLoginAvailable: false },
  pendingRestart: true,
});
assert.match(html, /同一 Windows 用户/);
assert.match(html, /重启后生效/);
for (const marker of privateMarkers) assert.equal(html.includes(marker), false);
```

- [ ] **Step 4: Run composition/server/frontend tests to confirm RED**

Run:

```powershell
node --test test/composition-root.test.js test/server.test.js test/frontend-brain-provider-status-contract.test.js
```

Expected: FAIL on the missing broker composition, endpoint, and view.

- [ ] **Step 5: Generalize the lexical grant to frozen runtime facts**

Rename the grant's private payload from protected roots to runtime facts while retaining the unforgeable secret, class brand check, and consumer-function lock. Issue one grant to construct the broker from external protected roots, then issue a provider grant containing exactly:

```js
Object.freeze({
  protectedRoots: Object.freeze([...providerProtectedRoots]),
  codexLoginCredentialBroker,
});
```

Delay final broker/grant construction until the versioned active config and Code Executor roots are known. Track the broker before creating any configured router.

- [ ] **Step 6: Expose only a sanitized application port**

Create:

```js
const brainProviderStatus = frozenPort(
  codexLoginCredentialBroker,
  ["readStatus"],
  "brain provider status",
);
```

Return that port on the application and add the exact GET route before operational mutation admission. Do not add broker status to core readiness, because an optional unavailable provider must not prevent the owner from opening the console to repair it.

- [ ] **Step 7: Implement the status card and loader**

Render a “Codex CLI 大脑能力” card above the structured provider form. Load its endpoint with `cache: "no-store"` and an abort controller whenever configuration view becomes active; preserve request sequence ordering. Derive “已保存，重启后生效” only from the existing configuration `pendingRestart` state, not from broker internals.

- [ ] **Step 8: Run composition/server/frontend tests to GREEN**

Run the Step 4 command.

Expected: PASS with providers closing before the broker and no private marker in HTTP or HTML.

- [ ] **Step 9: Commit production composition and status**

```powershell
git add -- src/composition-root.js src/server.js public/brain-provider-status-view.js public/app.js public/styles.css test/composition-root.test.js test/server.test.js test/frontend-brain-provider-status-contract.test.js
git commit -m "feat: expose sanitized Codex login readiness"
```

### Task 7: Browser, Operations, Distribution, and Repeatable No-Model Check

**Files:**
- Modify: `test/browser/configuration-form-playwright.mjs`
- Create: `scripts/verify-codex-login-readiness.mjs`
- Create: `test/codex-login-readiness-command.test.js`
- Modify: `test/open-source-distribution.mjs`
- Modify: `config.example.json`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/PRIVACY.md`
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: Task 1 form, Task 6 endpoint/view, managed loopback service.
- Produces: owner-visible browser flow, packaged docs/helper, and stable command `node scripts/verify-codex-login-readiness.mjs --origin http://127.0.0.1:4173`.

- [ ] **Step 1: Write the failing browser flow**

Mock the sanitized status route, add a Codex CLI provider, assert its default mode/labels, save/reload/edit to API-key and back, preview activation impact, and verify restart-required. Add Claude rejection and DOM scans for fictional secret/account/path markers. The browser test must not invoke a real CLI or model.

```js
await page.getByRole("button", { name: "新增 Codex CLI（单任务受监管）" }).click();
await expect(page.getByLabel("认证方式")).toHaveValue("codex-login");
await expect(page.getByLabel("认证方式").locator("option:checked"))
  .toHaveText("Codex 当前登录（受管代理，推荐）");
```

- [ ] **Step 2: Write the failing readiness-command contract**

Start a loopback fixture that returns each valid state and malformed/oversized/secret-bearing responses. Assert the command accepts only exact schema, prints `CODEX_LOGIN_READINESS_OK state=<state>` for a valid result, returns nonzero otherwise, and never echoes the response body, origin credentials, or private fields.

```js
assert.equal(result.status, 0);
assert.equal(result.stdout, "CODEX_LOGIN_READINESS_OK state=available\n");
assert.equal(result.stderr, "");
assert.equal(`${result.stdout}${result.stderr}`.includes(privateMarker), false);
```

- [ ] **Step 3: Run browser/command/distribution tests to confirm RED**

Run:

```powershell
node test/browser/configuration-form-playwright.mjs
node --test test/codex-login-readiness-command.test.js test/open-source-distribution.mjs
```

Expected: FAIL on the missing command, old browser template expectations, and old docs/privacy assertions.

- [ ] **Step 4: Implement the bounded loopback verifier**

Accept only `--origin` with an `http://127.0.0.1:<port>` URL, issue one GET to `/api/brain-providers/status` with a 15-second abort deadline and 16 KiB body limit, validate exact fields/enums/booleans, and print only the stable marker. Do not accept headers, credentials, alternate hosts, paths, or a command option.

- [ ] **Step 5: Update safe examples and documentation**

Set the example Codex provider to `credentialMode: "codex-login"` and Claude to `"api-key"`, while keeping providers unassigned or remote data disabled. Document fixed source selection, same-user prerequisite, private mirror, serial calls, login/logout detection, API-key compatibility, no keyring/Claude login, page confirmation/restart, status states, no full profile, no host write, no backup/restore/package, and unchanged action authority.

Replace the old blanket statement that host Codex login is never reused with the exact brokered-auth boundary. Keep Claude's old API-key prerequisite.

- [ ] **Step 6: Strengthen distribution/privacy assertions**

Assert npm payload contains the fixed helper and public docs but no `auth.json`, `.codex`, `.mydashboard-cli-credentials-v1`, envelope, token-shaped fixture, local absolute path, account identifier, or test credential. Run clean bootstrap with no login source and require console startup plus sanitized `file_login_unavailable`.

- [ ] **Step 7: Run browser/command/distribution tests to GREEN**

Run the Step 3 commands.

Expected: PASS with no console/page error, no horizontal overflow in the existing browser fixture, and no real model/GitHub call.

- [ ] **Step 8: Commit UX and operations guidance**

```powershell
git add -- test/browser/configuration-form-playwright.mjs scripts/verify-codex-login-readiness.mjs test/codex-login-readiness-command.test.js test/open-source-distribution.mjs config.example.json README.md docs/ARCHITECTURE.md docs/OPERATIONS.md docs/PRIVACY.md SECURITY.md
git commit -m "docs: operate brokered Codex login safely"
```

### Task 8: Complete Automated, Docker, Clean-Room, and Independent Review Gates

**Files:**
- Modify only if a gate finds a defect: the exact implementation/test/doc file that owns the defect
- Modify after all gates pass: `validation-notes.md`
- Modify after all gates pass: `docs/plans/2026-08-02-001-feat-complete-command-center-plan.md`

**Interfaces:**
- Consumes: committed Tasks 1-7.
- Produces: one exact reviewed HEAD with complete local, browser, Docker, clean-room, recovery, privacy, and independent-review evidence; no service restart or real PR access yet.

- [ ] **Step 1: Run all focused Codex-login and affected cross-layer tests**

```powershell
node --test test/windows-codex-credential-file.test.js test/codex-login-credential-store.test.js test/codex-login-credential-broker.test.js test/supervised-cli-brain-provider.test.js test/supervised-cli-brain-end-to-end.test.js test/configuration-contract.test.js test/configuration-form-schema.test.js test/configuration-form-support.test.js test/configured-workforce.test.js test/brain-router.test.js test/configured-role-employee.test.js test/role-worker-directory.test.js test/proactive-work-loop.test.js test/composition-root.test.js test/server.test.js test/frontend-brain-provider-status-contract.test.js test/backup-service.test.js test/offline-restore-runtime.test.js test/open-source-distribution.mjs test/codex-login-readiness-command.test.js
```

Expected: zero failures; only explicitly justified Windows privilege cases may skip.

- [ ] **Step 2: Run the complete project suite**

Run:

```powershell
npm test
```

Expected: zero failures and no new unclassified skips.

- [ ] **Step 3: Check every JavaScript/ESM file and whitespace**

```powershell
$javascriptFiles = rg --files -g '*.js' -g '*.mjs'
foreach ($javascriptFile in $javascriptFiles) {
  node --check $javascriptFile
  if ($LASTEXITCODE -ne 0) { throw "syntax check failed" }
}
git diff --check
```

Expected: every syntax check exits 0 and `git diff --check` is empty.

- [ ] **Step 4: Run the full U12 validator with live UI and Docker**

Run:

```powershell
npm run validate:system -- --all
```

Expected: full tests, configuration/confirmation browser checks, `scripts/validate-ui.mjs`, real pinned Docker sandbox with network disabled, distribution, manifest, and provenance gates all pass.

- [ ] **Step 5: Re-run from a clean local clone of the exact HEAD**

Create a new explicitly named temporary directory outside all retained evidence roots, clone the local repository with `--no-local`, checkout the exact current commit in detached mode, install from shrinkwrap, and run focused tests plus `npm test` and `npm run validate:system -- --all`. Verify the clone is clean afterward. Do not copy `config.json`, data, runtime directories, login source, mirror, or host profile into the clone.

```powershell
$acceptedHead = (git rev-parse HEAD).Trim()
$cleanRoot = Join-Path (Split-Path -Parent (Get-Location)) "MyDashboard-codex-login-clean-$($acceptedHead.Substring(0, 7))"
if (Test-Path -LiteralPath $cleanRoot) { throw "clean validation root already exists" }
git clone --no-local . $cleanRoot
git -C $cleanRoot switch --detach $acceptedHead
Push-Location $cleanRoot
try {
  npm ci
  node --test test/windows-codex-credential-file.test.js test/codex-login-credential-store.test.js test/codex-login-credential-broker.test.js test/supervised-cli-brain-provider.test.js test/supervised-cli-brain-end-to-end.test.js
  npm test
  npm run validate:system -- --all
  if ((git status --short).Length -ne 0) { throw "clean clone became dirty" }
} finally {
  Pop-Location
}
```

- [ ] **Step 6: Run two independent reviews**

Dispatch one correctness/security reviewer and one maintainability/testing reviewer against the exact committed diff from `17323e6` to current HEAD. Require explicit review of source ACL/effective rights, TOCTOU, mirror crash windows, FIFO cancellation/close, reap-capture-cleanup precedence, no-host-profile environment, authority non-expansion, pre-claim degradation, HTTP/DOM redaction, backup/package exclusion, and real-PR boundary. Resolve every P0/P1/P2, rerun affected gates, and repeat review until both return ready with no P0/P1/P2.

- [ ] **Step 7: Record sanitized automated evidence**

In `validation-notes.md` and the parent plan's current validation note, record exact HEAD, test pass/fail/skip totals, Docker/UI/clean-room result, and review verdicts. Do not record private roots, source metadata, account information, digests, or credential status output.

- [ ] **Step 8: Commit the automated acceptance record**

```powershell
git add -- validation-notes.md docs/plans/2026-08-02-001-feat-complete-command-center-plan.md
git commit -m "test: validate brokered Codex login"
```

### Task 9: Managed Activation and Product-Only PR Read Acceptance

**Files:**
- Modify after acceptance: `validation-notes.md`
- Modify after acceptance: `docs/plans/2026-08-02-001-feat-complete-command-center-plan.md`

**Interfaces:**
- Consumes: exact Task 8 accepted HEAD, existing managed process controller, existing configuration confirmation queue, current file-backed Codex login, and the user's standing read-only authorization for PR `#23178`.
- Produces: current managed service, page-confirmed Codex `taskBrain`, no-model native readiness evidence, and product-generated read-only PR acceptance with proof of zero external writes.

- [ ] **Step 1: Verify the current managed runtime before changing it**

Run:

```powershell
git status --short --branch
git rev-parse HEAD
.\scripts\Manage-MyDashboard.ps1 -Action Status
```

Expected: only the pre-existing progress ledger may be modified, HEAD equals the accepted Task 8 commit, and status identifies the old or stopped managed runtime without changing it.

- [ ] **Step 2: Restart only through the managed controller**

Run:

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Restart -TimeoutSeconds 120
.\scripts\Manage-MyDashboard.ps1 -Action Status
```

Expected: the service reports ready at `127.0.0.1`, runtime source identity equals the accepted HEAD, and startup logs contain no credential/account/path material.

- [ ] **Step 3: Run the real no-model readiness check through the product**

Run:

```powershell
node scripts/verify-codex-login-readiness.mjs --origin http://127.0.0.1:4173
```

Expected: `CODEX_LOGIN_READINESS_OK state=available`. This executes fixed isolated `codex login status` only; it does not call a model or access a PR. Verify the host login file's identity/size/mtime is unchanged and the disposable probe root is empty.

- [ ] **Step 4: Prepare the configuration draft in the page**

In the configuration page, select `Codex 当前登录（受管代理，推荐）` for the intended Codex provider, bind it only to the approved `taskBrain`, preserve explicit remote data classifications, keep GitHub actions disabled, save the draft, and inspect the impact preview. Confirm the preview lists credential identity change, remote model use, and restart-required without showing account/path/token data.

- [ ] **Step 5: Pause for the owner's per-item page confirmation**

Do not activate by direct file/database/API mutation. Wait until the owner approves the exact configuration confirmation item in the unified queue. Re-read configuration state and require the confirmed active version plus `pendingRestart: true` before continuing.

- [ ] **Step 6: Restart the confirmed active version and recheck status**

Run the managed Restart/Status commands from Step 2, then the readiness command from Step 3. Expected: runtime source remains the accepted HEAD, active configuration version matches the confirmed version, and Codex login state is available.

- [ ] **Step 7: Let MyDashboard itself perform PR `#23178` read acceptance**

Use the product's normal owner-work/workflow route and already confirmed `taskBrain`; do not use the development Codex worker, shell `gh`, browser, or manual GitHub calls to inspect the PR. Require product evidence that it claimed the task, invoked one supervised Codex process, produced a locally validated structured result, persisted ledger/memory/evidence, and reached a read-only terminal or owner-attention state.

- [ ] **Step 8: Prove the external-write boundary remained closed**

From MyDashboard's own confirmation history, external-action recovery status, work timeline, Code Job evidence, and managed logs, verify there was no comment, Review, update-branch, push, merge, source application, or pending unknown external action. Do not infer this from a model statement.

- [ ] **Step 9: Record and commit sanitized final evidence**

Record exact HEAD/config version, readiness state name, product work/evidence identifiers, terminal status, and zero-write checks in the two acceptance documents. Exclude PR content, credentials, account data, and private paths.

```powershell
git add -- validation-notes.md docs/plans/2026-08-02-001-feat-complete-command-center-plan.md
git commit -m "test: accept Codex login in the managed product"
```

- [ ] **Step 10: Re-run final status and worktree checks**

```powershell
.\scripts\Manage-MyDashboard.ps1 -Action Status
git status --short --branch
git log -5 --oneline
```

Expected: managed runtime is ready on the final evidence commit or its explicitly recorded accepted implementation parent, no product action is unknown/in-flight, no GitHub write occurred, and the only unrelated worktree modification is the preserved progress ledger.
