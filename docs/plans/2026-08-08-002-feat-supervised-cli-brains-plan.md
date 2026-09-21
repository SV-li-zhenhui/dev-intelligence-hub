# Supervised Codex and Claude CLI Brains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the controller reasoning role and every configurable employee `brain`/`taskBrain` select Codex CLI or Claude CLI while MyDashboard remains the durable authority for context, memory, execution, and confirmations.

**Architecture:** Add two `brainProviders` kinds backed by one provider-neutral supervised process adapter. Each admitted role decision, memory query, or durable Code Job turn is one bounded claimed task: it creates a fresh isolated temporary directory, launches exactly one known CLI with tools/session persistence disabled, supplies only the already-authorized structured request through stdin, accepts one bounded JSON result as untrusted input, then reaps the process and removes the directory. A validation correction is not a new task and therefore cannot launch a second CLI; a multi-turn Code Job may launch again only after the prior turn is durably recorded and a fresh turn is admitted. Existing `BrainRouter`, role employees, memory answering, and Code Job brain directory keep all data-class authorization and domain-result validation; no CLI receives a source checkout, generic command configuration, GitHub credentials, or an action port.

**Tech Stack:** Node.js 22+ ESM, `node:child_process`, `node:fs/promises`, existing `BrainRouter` and configuration contracts, Node test runner, browser form contracts, Codex CLI 0.147+ and Claude Code 2.1.222+ command shapes.

## Global Constraints

- One fresh CLI invocation per admitted bounded task/turn; malformed output fails locally without a correction retry, resume, continue, background agent, or persistent cross-task session.
- The only configurable CLI identity is `codex-cli` or `claude-cli`; no UI/config field may supply an executable, command, arguments, working directory, plugin, MCP server, hook, or shell fragment.
- The child working directory and HOME/USERPROFILE/XDG/application-data roots are new empty invocation-local directories and are never the MyDashboard project, a host source repository, a host user profile, or a controlled Code Job workspace.
- Codex runs ephemeral with user configuration/rules ignored, read-only sandboxing, and shell/apps/browser/computer/multi-agent/hooks disabled. Claude runs in safe non-interactive mode with built-in tools empty, MCP empty/strict, Chrome off, one turn, and session persistence off.
- Dynamic messages and schemas travel through stdin or temporary data files, never a shell command line. Every child launch uses `shell: false` and a fixed executable descriptor resolved by code.
- Child environment is built from an empty object and is provider-specific. GitHub/Git/SSH credentials, host profile paths, `NODE_OPTIONS`, and `GH_*`/`GITHUB_*`/`GIT_*`/`SSH_*` variables never enter the child; only fixed process/runtime fields and the selected vendor's standard model credential names may be retained. Host CLI login profiles are not reused.
- Production resolves only version-admitted native executables inside verified official npm package layouts. Arbitrary PATH executables, `.cmd`/`.ps1` shims, UI-configured commands, and production dependency replacement are unavailable; dependency seams exist only in explicit test factories.
- CLI stdout, stderr, result files, exit state, duration, and input are bounded. Errors expose stable local codes but never stderr, credentials, prompts, absolute paths, or raw provider output.
- A timeout, cancellation, output overflow, invalid result, unavailable CLI, or failed process is a `STRUCTURED_PROVIDER_*` failure so existing Code Job policy pauses for operator attention instead of falling back to a weaker brain.
- All CLI JSON is parsed as untrusted data and then validated by the existing work-decision, memory-answer, or code-action domain parser before any intent can reach policy, Code Jobs, confirmation, Git, or GitHub.
- No real PR, GitHub write, source-repository mutation, remote model smoke, service restart, or GitHub push is part of these implementation tasks.

---

### Task 1: Extend the versioned provider contract and settings form

**Files:**
- Modify: `src/domain/configuration-contract.js`
- Modify: `public/configuration-form-support.js`
- Modify: `public/configuration-form-schema.js`
- Test: `test/configuration-contract.test.js`
- Test: `test/configuration-form-support.test.js`
- Test: `test/configuration-form-schema.test.js`

**Interfaces:**
- Consumes: existing `brainProviders.<id>` records and role `brain`/`taskBrain` references.
- Produces: provider records with `kind: "codex-cli" | "claude-cli"`, `remote: true`, and optional `timeoutMs`, `maxResponseBytes`, `maxRequestBytes`; CLI records have no endpoint, credential-reference, protocol, response-format, context-token, executable, or argument fields.

- [x] **Step 1: Write failing domain and form-support tests**

```js
for (const kind of ["codex-cli", "claude-cli"]) {
  const value = document();
  value.brainProviders[kind] = {
    kind,
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  value.employees.roles.orchestrator.brain.provider = kind;
  assert.deepEqual(
    normalizeConfigurationDocument(value).brainProviders[kind],
    value.brainProviders[kind],
  );
}
```

Also assert that missing/false `remote`, `baseUrl`, `apiKeyEnv`, `protocol`, `responseFormat`, `contextTokens`, `executable`, and `args` fail both the domain normalizer and form support with a precise provider path.

- [x] **Step 2: Run the focused tests and preserve RED evidence**

Run: `node --test test/configuration-contract.test.js test/configuration-form-support.test.js test/configuration-form-schema.test.js`

Expected: FAIL because both CLI kinds and templates are currently unsupported.

- [x] **Step 3: Implement the exact CLI provider shape**

Use a shared kind set and branch requirements by kind:

```js
const CLI_PROVIDER_KINDS = new Set(["codex-cli", "claude-cli"]);
const isCli = CLI_PROVIDER_KINDS.has(kind);
if (isCli && config.remote !== true) {
  throw invalid(`${path}.remote`, "CLI 大脑必须显式标记为远程数据处理");
}
if (isCli && ["baseUrl", "apiKeyEnv", "protocol", "responseFormat", "contextTokens"]
  .some((name) => Object.hasOwn(config, name))) {
  throw invalid(path, "CLI 大脑字段组合无效");
}
```

Give CLI providers the Responses-style numeric ranges: timeout `1_000..3_600_000`, response `1_024..1_048_576`, request `1_024..1_048_576`. Add frozen settings templates labeled `Codex CLI（单任务受监管）` and `Claude CLI（单任务受监管）`, each with `remote: true` and no executable/path field.

- [x] **Step 4: Run focused tests to GREEN**

Run: `node --test test/configuration-contract.test.js test/configuration-form-support.test.js test/configuration-form-schema.test.js`

Expected: PASS.

- [x] **Step 5: Create a scoped local commit without pushing**

```powershell
git add -- src/domain/configuration-contract.js public/configuration-form-support.js public/configuration-form-schema.js test/configuration-contract.test.js test/configuration-form-support.test.js test/configuration-form-schema.test.js
git commit -m "feat: define supervised CLI brain providers"
```

---

### Task 2: Add a bounded child-process runner and fixed CLI locator

**Files:**
- Create: `src/lib/supervised-process-runner.js`
- Create: `src/lib/known-cli-locator.js`
- Create: `src/lib/windows-process-tree-wrapper.ps1`
- Test: `test/supervised-process-runner.test.js`
- Test: `test/known-cli-locator.test.js`

**Interfaces:**
- Produces: `SupervisedProcessRunner.run({ executable, args, cwd, env, input, signal, timeoutMs, maxStdoutBytes, maxStderrBytes }) -> Promise<{ exitCode, signal, stdout, stderr, stdoutBytes, stderrBytes }>` where `executable` must be a branded locator descriptor revalidated immediately before containment.
- Produces: `KnownCliLocator.resolve("codex-cli" | "claude-cli") -> Promise<{ command: absolutePath, prefixArgs: string[] }>`.
- The first release is explicitly Windows x64 only. Other platforms and architectures fail as `STRUCTURED_PROVIDER_UNAVAILABLE` until their native process-tree containment and official npm layouts have been independently verified.
- The locator resolves only fixed names to version-admitted native binaries inside verified official npm package layouts; it rejects standalone PATH executables and never executes `.cmd`/`.ps1` through a shell.

- [x] **Step 1: Write failing process lifecycle tests**

Use `process.execPath -e` fixtures to prove stdin/cwd/allowlisted env delivery, pre-abort without spawn, active abort, timeout, stdout overflow, stderr overflow, nonzero exit, and child closure before rejection. Assert error messages never include fixture stderr or environment secrets.

```js
await assert.rejects(
  runner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2048))"],
    cwd,
    env: {},
    input: Buffer.alloc(0),
    timeoutMs: 5_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
  }),
  { code: "STRUCTURED_PROVIDER_OUTPUT_LIMIT" },
);
```

- [x] **Step 2: Write failing locator tests**

Create fake PATH roots for direct executables and nested/hoisted/project-local npm layouts. Assert standalone executables, unsupported IDs, relative/symlinked package paths, malformed npm package identities, out-of-range package versions, forged/replaced descriptors, and `.cmd` execution requests fail as `STRUCTURED_PROVIDER_UNAVAILABLE` without executing anything.

- [x] **Step 3: Run both test files and preserve RED evidence**

Run: `node --test test/supervised-process-runner.test.js test/known-cli-locator.test.js`

Expected: FAIL because the modules do not exist.

- [x] **Step 4: Implement process supervision and locator confinement**

The runner must use `spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })`, count bytes before decoding UTF-8, catch output-stream failures, and enforce one deadline across executable revalidation, launch, termination, and close. Windows launches the verified binary suspended into a kill-on-close Job Object, waits for the direct result, then terminates and confirms the whole job is empty on success/failure/timeout/cancellation. Production construction has no dependency-replacement seam. The locator returns deeply frozen branded descriptors, supports admitted nested/hoisted/project-local official npm layouts, pins tested minor-version ranges, rehashes executable identity before containment, and is immutable after construction. The wrapper reserves its own control exit separately from every non-zero target exit.

- [x] **Step 5: Run both test files to GREEN**

Run: `node --test test/supervised-process-runner.test.js test/known-cli-locator.test.js`

Expected: PASS with no leaked child process.

- [x] **Step 6: Close independent Task 2 review findings**

Re-review must confirm output-stream errors cannot crash or leak, descriptor verification obeys timeout/cancellation without spawning late, every termination path is bounded, successful direct children cannot leave descendants, local `.bin` and hoisted npm layouts resolve safely, production dependencies and locator roots are immutable, same-size executable replacement fails closed by digest, child exit 125 remains a process failure, unsupported platforms fail closed, and Codex/Claude versions stay inside the explicitly tested minor ranges.

- [x] **Step 7: Create a scoped local commit without pushing**

```powershell
git add -- src/lib/supervised-process-runner.js src/lib/known-cli-locator.js src/lib/windows-process-tree-wrapper.ps1 test/supervised-process-runner.test.js test/known-cli-locator.test.js
git commit -m "feat: supervise known CLI brain processes"
```

---

### Task 3: Implement one-shot Codex and Claude structured providers

**Files:**
- Create: `src/lib/structured-brain-request.js`
- Create: `src/lib/strict-json.js`
- Create: `src/adapters/supervised-cli-brain-provider.js`
- Modify: `src/adapters/openai-compatible-provider.js`
- Modify: `src/adapters/ollama-structured-provider.js`
- Test: `test/supervised-cli-brain-provider.test.js`
- Test: `test/structured-brain-providers.test.js`

**Interfaces:**
- Produces: `normalizeStructuredBrainRequest({ model, messages, schema }, { maxRequestBytes })` returning a detached frozen request.
- Produces: `createProductionSupervisedCliBrainProvider({ id, cliKind, timeoutMs, maxResponseBytes, maxRequestBytes })` with `{ id, remote: true, singleAttempt: true, generate(...) }`; production owns its runner, locator, environment, and temporary root internally.
- Produces: explicitly named `createTestSupervisedCliBrainProvider(options, dependencies)` for local fixtures only; production composition never imports this dependency-replacement seam.
- Consumes: Task 2 runner and locator.

Compatibility decision: an already persisted OpenAI-compatible provider that omits `protocol` keeps the pre-existing bounded legacy limits and chat-completions behavior. The configuration contract and adapter use the same ranges; every new UI template writes an explicit protocol. Tightening legacy records is a separately previewed configuration migration, not an implicit CLI-brain side effect.

- [x] **Step 1: Write failing provider tests for exact invocation shapes**

For Codex assert one request uses an isolated cwd and fixed flags including:

```js
[
  "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
  "--skip-git-repo-check", "--sandbox", "read-only", "--strict-config",
  "--disable", "shell_tool", "--disable", "apps",
  "--disable", "browser_use", "--disable", "computer_use",
  "--disable", "image_generation", "--disable", "multi_agent",
  "--disable", "hooks", "--color", "never",
]
```

Assert it also passes `--output-schema <isolated file>`, `--output-last-message <isolated file>`, `--model <model>`, `-C <isolated cwd>`, and `-`; it must never pass resume, add-dir, workspace-write, danger, approval bypass, plugin, MCP, or a host repository path.

For Claude assert fixed flags include `--print`, `--output-format json`, `--tools ""`, `--permission-mode dontAsk`, `--safe-mode`, `--disable-slash-commands`, `--strict-mcp-config`, `--mcp-config {}`, `--no-chrome`, `--no-session-persistence`, and `--model`. Claude Code 2.1.222 does not expose `--max-turns` or `--system-prompt-file`; with all tools disabled, one non-interactive `--print` invocation is one response turn. The complete dynamic request and instruction, including the JSON schema, must therefore be stdin rather than a command argument.

- [x] **Step 2: Write failing boundary and cleanup tests**

Cover request/schema/message and final wire-payload limits, unique directories for concurrent calls, an exact empty-origin child environment allowlist, invocation-local HOME/USERPROFILE/XDG/application-data roots, invalid UTF-8, duplicate JSON keys, invalid/non-object JSON, oversized output, nonzero exit, timeout, cancellation, unavailable locator, internal `TypeError` redaction, malicious result-file symlink/hardlink, and cleanup after every success/failure. Add a crash-residue fixture proving a total-entry-bounded owner-marker scavenger deletes only stale verified invocation directories with no live owner. Prove cleanup atomically quarantines and revalidates directory identity before recursive deletion, and that cleanup failure takes precedence over an earlier process failure. Assert `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_CONFIG_*`, `NODE_OPTIONS`, `CLAUDE_CODE_OAUTH_TOKEN`, host profile paths, raw prompts, stderr, and temporary paths never occur in child environments or public errors.

- [x] **Step 3: Run provider tests and preserve RED evidence**

Run: `node --test test/supervised-cli-brain-provider.test.js test/structured-brain-providers.test.js`

Expected: FAIL because the adapter and shared request normalizer do not exist.

- [x] **Step 4: Extract the strict provider-neutral request normalizer**

Move the current bounded plain-array message clone and depth/node/key/string-budget JSON-schema clone from the OpenAI-compatible adapter into `structured-brain-request.js`; use it from OpenAI-compatible, Ollama, and CLI providers so accessors, proxies, sparse arrays, dangerous keys, cycles, and oversized schemas fail before any egress.

- [x] **Step 5: Implement the one-shot provider**

Serialize a versioned stdin request:

```js
{
  schemaVersion: 1,
  instruction: "Return exactly one JSON object. It has no action authority.",
  messages,
  schema,
}
```

Pre-create mode-restricted parent-owned schema/result files for Codex, launch one process, parse Codex's bounded `--output-last-message` file, or accept only an exact successful Claude JSON envelope whose sole result representation is a string containing one JSON object. A bounded strict parser rejects duplicate keys before semantic validation. Reject error/status conflicts and unknown envelope fields. Require one plain JSON object and return its canonical JSON text. Always cleanup only the atomically quarantined and reverified invocation directory after process closure; first use performs a total-entry-bounded stale-owner scan. Map every post-admission local failure, including internal `TypeError`, to stable redacted `STRUCTURED_PROVIDER_*` errors.

- [x] **Step 6: Run provider tests to GREEN**

Run: `node --test test/supervised-cli-brain-provider.test.js test/structured-brain-providers.test.js`

Expected: PASS.

- [x] **Step 7: Close independent Task 3 review findings**

Re-review must confirm duplicate envelope/result keys fail closed, cleanup failures cannot be masked, post-admission `TypeError` details are redacted, final stdin sizing precedes locator/temp work, stale scanning has a total-entry bound, quarantine prevents raced-directory deletion, top-level request proxies are never read, production dependencies are not injectable, and the omitted-protocol compatibility decision is aligned across code, contract, tests, and this plan.

- [x] **Step 8: Create a scoped local commit without pushing**

```powershell
git add -- src/lib/structured-brain-request.js src/lib/strict-json.js src/adapters/supervised-cli-brain-provider.js src/adapters/openai-compatible-provider.js src/adapters/ollama-structured-provider.js test/supervised-cli-brain-provider.test.js test/structured-brain-providers.test.js
git commit -m "feat: add one-shot Codex and Claude CLI brains"
```

---

### Task 4: Wire CLI providers through every configurable brain route

**Files:**
- Modify: `src/services/configured-workforce.js`
- Modify: `src/services/code-job-brain-directory.js` only if its dependency port requires narrowing.
- Modify: `src/services/role-decision-engine.js`
- Modify: `src/services/memory-answer-service.js`
- Modify: `src/composition-root.js` only if production brain dependencies are not already forwarded.
- Test: `test/configured-workforce.test.js`
- Test: `test/code-job-brain-directory.test.js`
- Test: `test/role-decision-engine.test.js`
- Test: `test/memory-answer-service.test.js`
- Test: `test/composition-root.test.js`
- Test: `test/agent-action-parity.test.js`

**Interfaces:**
- Consumes: `SupervisedCliBrainProvider` from Task 3.
- Produces: the existing `createConfiguredBrainRouter()` behavior for `codex-cli` and `claude-cli`, with no new action capability.

- [x] **Step 1: Write failing routing and authorization tests**

Prove both provider kinds work for a routine role brain, an orchestrator brain, a high-capability `taskBrain`, memory answering, and `CodeJobBrainDirectory.decide`. A CLI provider description must declare `singleAttempt: true`; role decisions, memory answers, and Code Job turns must launch once and fail locally on malformed output rather than entering their legacy correction retry. For a remote CLI with denied `requirements`, `code`, or `memory`, assert the locator and process runner receive zero calls. For an unavailable CLI, assert the error is `STRUCTURED_PROVIDER_UNAVAILABLE` and Code Job policy pauses for operator attention rather than using the routine Ollama brain.

- [x] **Step 2: Run focused route tests and preserve RED evidence**

Run: `node --test test/configured-workforce.test.js test/code-job-brain-directory.test.js test/composition-root.test.js test/agent-action-parity.test.js`

Expected: FAIL because `configured-workforce` supports only Ollama and OpenAI-compatible kinds.

- [x] **Step 3: Add the provider factory branch without changing BrainRouter**

```js
if (["codex-cli", "claude-cli"].includes(config.kind)) {
  return createProductionSupervisedCliBrainProvider({
    id,
    cliKind: config.kind,
    ...selectOptions(config, PROVIDER_LIMIT_KEYS),
  });
}
```

The production factory constructs its trusted runner/locator internally; fake runner/locator injection is available only through an explicitly named test factory that production composition never imports. Do not add CLI-specific branches to policy, grants, confirmation, Git, GitHub, or executor services. `BrainRouter.remote === true` remains the sole pre-egress data-class gate.

- [x] **Step 4: Run focused route tests to GREEN**

Run: `node --test test/configured-workforce.test.js test/code-job-brain-directory.test.js test/composition-root.test.js test/agent-action-parity.test.js`

Expected: PASS.

- [x] **Step 5: Create a scoped local commit without pushing**

```powershell
git add -- src/services/configured-workforce.js src/services/code-job-brain-directory.js src/composition-root.js test/configured-workforce.test.js test/code-job-brain-directory.test.js test/composition-root.test.js test/agent-action-parity.test.js
git commit -m "feat: route employee brains through supervised CLIs"
```

---

### Task 5: Prove the settings workflow in the browser

**Files:**
- Modify: `test/browser/configuration-form-playwright.mjs`
- Modify: `test/frontend-configuration-form-contract.test.js`
- Modify: `scripts/validate-ui.mjs` only if the stable settings fixture needs the new templates.

**Interfaces:**
- Consumes: Task 1 form schema/templates.
- Produces: owner-visible creation and assignment of both CLI providers without JSON editing.

- [x] **Step 1: Add a failing browser flow**

Create `codex.local-cli` from the Codex template and `claude.local-cli` from the Claude template, verify neither card has an endpoint, API key, executable, arguments, directory, plugin, or MCP field, assign one to `orchestrator.brain` and one to `developer.taskBrain`, and assert the exact draft patch survives validation/re-render.

- [x] **Step 2: Run the browser contract and preserve RED evidence**

Run: `node --test test/frontend-configuration-form-contract.test.js`

Run: `node test/browser/configuration-form-playwright.mjs`

Expected: FAIL before Task 1 templates are visible, then expose any remaining browser-only defect.

- [x] **Step 3: Make the smallest form/rendering correction**

Keep `kind` read-only, `remote` visibly true, and assignment model as a bounded text value. Do not introduce provider model discovery, authentication, executable browsing, or remote command controls.

- [x] **Step 4: Run browser tests to GREEN**

Run: `node --test test/frontend-configuration-form-contract.test.js`

Run: `node test/browser/configuration-form-playwright.mjs`

Expected: PASS without console/page errors, stale-draft overwrite, or overflow.

- [x] **Step 5: Create a scoped local commit without pushing**

```powershell
git add -- test/browser/configuration-form-playwright.mjs test/frontend-configuration-form-contract.test.js scripts/validate-ui.mjs
git commit -m "test: prove CLI brain configuration in the browser"
```

---

### Task 6: Run a real local-process end-to-end fixture without remote model use

**Files:**
- Create: `test/fixtures/fake-structured-cli.mjs`
- Create: `test/supervised-cli-brain-end-to-end.test.js`
- Modify: `test/code-job-end-to-end.test.js` only if the existing fixture can be extended without duplication.

**Interfaces:**
- Consumes: Tasks 2–4 production runner/provider/router.
- Produces: cross-layer evidence that one admitted bounded task/turn equals one isolated process and one locally validated, ledgered, projected, and recoverable decision.

- [x] **Step 1: Write a failing fake-CLI E2E**

The fake executable reads stdin, records only bounded test metadata inside its isolated cwd, emits a valid routine work decision or Code Job decision, and attempts to observe `GH_TOKEN`, host profile paths, repository cwd, and a correction invocation. The test must prove those values are absent, the cwd is unique and deleted afterward, and malformed output still starts exactly one child for the claimed task/turn.

- [x] **Step 2: Exercise both employee and Code Job routes**

Use a real composition-root fixture to route a CLI-backed orchestrator through the proactive work loop into deterministic `OrchestratorService`, and route a development turn through `CodeJobBrainDirectory`. Assert existing domain parsers accept the decisions, disallowed intents/actions still fail locally before any policy/executor call, ledger and memory projection records are actually persisted, and a reconstructed runtime can read the same evidence after restart.

- [x] **Step 3: Run E2E to RED, then GREEN**

Run: `node --test test/supervised-cli-brain-end-to-end.test.js`

Expected RED: missing production adapter/wiring. Expected GREEN: both vendor strategies pass using the fake local process, with zero network and zero source mutation.

- [x] **Step 4: Create a scoped local commit without pushing**

```powershell
git add -- test/fixtures/fake-structured-cli.mjs test/supervised-cli-brain-end-to-end.test.js test/code-job-end-to-end.test.js
git commit -m "test: prove supervised CLI brain lifecycle"
```

---

### Task 7: Document operation, failure behavior, and first-release limits

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/PRIVACY.md`
- Modify: `config.example.json`
- Modify: `docs/plans/2026-08-02-001-feat-complete-command-center-plan.md`
- Modify: `.superpowers/sdd/2026-08-02-001-feat-complete-command-center-plan/progress.md`

**Interfaces:**
- Produces: installation/configuration guidance and an explicit statement that persistent CLI sessions remain deferred.

- [x] **Step 1: Update docs and safe examples**

Document supported CLI version ranges, fixed vendor credential environment names as an operator prerequisite (host CLI login profiles are not reused), UI creation/assignment, restart-required activation, remote data-class toggles, the fixed no-tools invocation flags, stable unavailable/timeout behavior, local memory ownership, and the fact that CLI model calls may incur vendor cost. Examples must contain no credential, absolute machine path, active remote authorization, or executable path.

- [x] **Step 2: Run documentation and distribution checks**

Run: `node --test test/open-source-distribution.mjs test/frontend-configuration-contract.test.js`

Run: `node scripts/validate-ui.mjs`

Expected: PASS; publishing commands remain unexecuted.

- [x] **Step 3: Create a scoped local commit without pushing**

```powershell
git add -- README.md docs/ARCHITECTURE.md docs/OPERATIONS.md docs/PRIVACY.md config.example.json docs/plans/2026-08-02-001-feat-complete-command-center-plan.md .superpowers/sdd/2026-08-02-001-feat-complete-command-center-plan/progress.md
git commit -m "docs: explain supervised CLI brains"
```

---

### Task 8: Complete regression, real binary discovery, and independent review

**Files:**
- Modify only files required by concrete review findings.
- Record evidence in the authoritative plan/progress ledger; do not create redundant status documents.

**Interfaces:**
- Produces: acceptance evidence for AE9 and KTD17 without a paid/remote model invocation.

- [x] **Step 1: Verify installed CLI discovery without invoking a model**

Run the production locator against the installed Codex and Claude binaries and execute only their fixed `--version` commands through `SupervisedProcessRunner`. Assert bounded output and no repository cwd. If a binary is absent, record the stable unavailable result rather than installing it.

- [x] **Step 2: Run focused and cross-layer suites**

Run: `node --test test/supervised-process-runner.test.js test/known-cli-locator.test.js test/supervised-cli-brain-provider.test.js test/structured-brain-providers.test.js test/configuration-contract.test.js test/configuration-form-support.test.js test/configuration-form-schema.test.js test/configured-workforce.test.js test/code-job-brain-directory.test.js test/agent-action-parity.test.js test/supervised-cli-brain-end-to-end.test.js`

Run: `node --check` for every changed production JavaScript file.

Run: `git diff --check -- <all scoped CLI files>`.

- [x] **Step 3: Run the complete local regression and browser validator**

Run: `npm test`

Run: `node scripts/validate-ui.mjs`

Expected: all tests pass with only documented environment-gated skips. Do not start a real Codex/Claude model request in this task.

- [x] **Step 4: Obtain independent security/correctness review**

Review must verify one-attempt task semantics, process-tree reaping, empty-origin environment/profile isolation, fixed version-admitted npm executable resolution, stale-temp scavenging, temp-path confinement, result-file anti-symlink/hardlink checks, exact Claude success-envelope handling, output/error redaction, remote data denial before spawn, real composition/ledger/memory restart evidence, no policy/action parity regression, and no persistent sessions. Resolve every P0/P1/P2 before marking the CLI gate complete.

- [x] **Step 5: Update the authoritative ledger and create the final scoped local commit**

```powershell
git add -- <only reviewed CLI implementation, tests, and linked documentation>
git commit -m "feat: complete supervised CLI brain integration"
```

### Completion evidence (2026-08-09)

- The reviewed implementation was consolidated into local checkpoint `50f816d` after the cross-layer dependencies had settled; this satisfies the scoped commit steps above without splitting mutually dependent authority, provider, UI, and recovery changes. Nothing was pushed.
- Production discovery and version-only execution passed for Codex CLI `0.147.0` and Claude Code `2.1.222` from isolated temporary working directories. No model request was made.
- The final CLI-focused/cross-layer suite passed 369/370 with one explicit Windows symbolic-link skip. Two independent final reviews returned Ready with no P0/P1/P2 findings.
- At the `50f816d` checkpoint, the post-commit complete regression passed 2,777/2,784 with zero failures and seven documented platform/environment skips. Distribution and clean-room checks then passed 14/15 with one live machine-wide process-guard skip; the parent command-center plan records the later project-scoped guard repair, so this line is historical CLI-slice evidence rather than the current release verdict.
- Syntax validation passed for 435 JavaScript/ESM files. The configuration and confirmation-history Edge fixtures passed, and the desktop/mobile UI validator reported no console error, page error, or horizontal overflow.
- No paid/remote model request, source-repository mutation, service restart, GitHub access/write, PR action, or push was performed during this acceptance.

Do not push, create a PR, access the owner-only real PR target, or perform a paid remote-model smoke without a separate owner confirmation.
