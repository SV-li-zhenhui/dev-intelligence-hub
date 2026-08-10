import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ConfigurationContractError,
  configurationDocumentDigest,
  configurationDocumentImpact,
  normalizeConfigurationDocument,
} from "../src/domain/configuration-contract.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedDocument = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);

function document() {
  return structuredClone(committedDocument);
}

function trustedGitCommand() {
  return process.platform === "win32"
    ? "C:\\Program Files\\Git\\mingw64\\bin\\git.exe"
    : "/usr/bin/git";
}

function mirrorPath(name) {
  return process.platform === "win32"
    ? `D:\\mirrors\\${name}.git`
    : `/var/lib/mirrors/${name}.git`;
}

function conflictPreparationDocument() {
  const value = document();
  value.codeExecutor = {
    enabled: false,
    gitCommand: trustedGitCommand(),
    conflictPreparation: {
      enabled: true,
      baseMirrorsByRepository: {
        "acme/command-center": mirrorPath("oct-base"),
      },
      headMirrorsByRepository: {
        "acme/command-center": mirrorPath("oct-head"),
      },
    },
  };
  return value;
}

function assertInvalid(value) {
  assert.throws(
    () => normalizeConfigurationDocument(value),
    (error) =>
      error instanceof ConfigurationContractError &&
      error.code === "INVALID_CONFIGURATION_DOCUMENT" &&
      error.statusCode === 400,
  );
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

test("the committed complete configuration normalizes into an independent deep-frozen document", () => {
  const input = document();
  const normalized = normalizeConfigurationDocument(input);

  assert.deepEqual(normalized, committedDocument);
  assert.notStrictEqual(normalized, input);
  assert.notStrictEqual(normalized.employees, input.employees);
  assertDeepFrozen(normalized);

  input.employees.roles.developer.brain.model = "mutated-after-validation";
  assert.equal(normalized.employees.roles.developer.brain.model, "qwen3.5:9b");
});

test("the canonical digest is stable across object insertion order", () => {
  const forward = document();
  const reversed = reverseObjectKeys(forward);

  const first = configurationDocumentDigest(forward);
  const second = configurationDocumentDigest(reversed);

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(second, first);
});

test("pre-boundary documents preserve their content-addressed shape", () => {
  const legacy = document();
  delete legacy.githubRead;

  const normalized = normalizeConfigurationDocument(legacy);
  assert.equal(Object.hasOwn(normalized, "githubRead"), false);
  assert.deepEqual(normalized, legacy);
  assert.equal(configurationDocumentDigest(legacy), configurationDocumentDigest(normalized));
});

test("the legacy GitHub-read default is classified by effective authority", () => {
  const legacy = document();
  delete legacy.githubRead;
  const disabled = structuredClone(legacy);
  disabled.githubRead = { enabled: false };

  const tightening = configurationDocumentImpact(legacy, disabled);
  assert.deepEqual(tightening.security_tightening, ["githubRead"]);
  assert.deepEqual(tightening.authority_expansion, []);
  assert.deepEqual(tightening.restart_required, ["githubRead"]);

  const restored = configurationDocumentImpact(disabled, legacy);
  assert.deepEqual(restored.security_tightening, []);
  assert.deepEqual(restored.authority_expansion, ["githubRead"]);
});

test("unknown and dangerous fields are rejected even below a disabled feature", () => {
  const unknown = document();
  unknown.codeExecutor.unrestrictedShell = true;
  assertInvalid(unknown);

  const dangerous = document();
  Object.defineProperty(dangerous.codeExecutor, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  assertInvalid(dangerous);
});

test("role task brains are optional exact assigned brains without legacy backfill", () => {
  const legacy = normalizeConfigurationDocument(document());
  assert.equal(
    Object.hasOwn(legacy.employees.roles.developer, "taskBrain"),
    false,
  );

  const configured = document();
  configured.employees.roles.developer.taskBrain = {
    provider: "ollama",
    model: "qwen3.5:task",
    remoteData: { requirements: true, code: true, memory: false },
  };
  const normalized = normalizeConfigurationDocument(configured);
  assert.deepEqual(
    normalized.employees.roles.developer.taskBrain,
    configured.employees.roles.developer.taskBrain,
  );
  assertDeepFrozen(normalized.employees.roles.developer.taskBrain);

  const unknownField = structuredClone(configured);
  unknownField.employees.roles.developer.taskBrain.temperature = 0.2;
  assertInvalid(unknownField);

  const incomplete = structuredClone(configured);
  delete incomplete.employees.roles.developer.taskBrain.remoteData;
  assertInvalid(incomplete);

  const unknownProvider = structuredClone(configured);
  unknownProvider.employees.roles.developer.taskBrain.provider = "missing";
  assertInvalid(unknownProvider);
});

test("configuration change authority requires the same explicit role permission and policy", () => {
  const legacy = normalizeConfigurationDocument(document());
  assert.equal(
    Object.hasOwn(
      legacy.workCoordination.policy,
      "configurationChangeRoles",
    ),
    false,
  );

  const configured = document();
  configured.employees.roles.developer.permissions.allowedIntents.push(
    "propose_configuration_change",
  );
  configured.workCoordination.policy.configurationChangeRoles = ["developer"];
  assert.deepEqual(
    normalizeConfigurationDocument(configured).workCoordination.policy
      .configurationChangeRoles,
    ["developer"],
  );

  const missingPolicy = document();
  missingPolicy.employees.roles.developer.permissions.allowedIntents.push(
    "propose_configuration_change",
  );
  assertInvalid(missingPolicy);

  const missingPermission = document();
  missingPermission.workCoordination.policy.configurationChangeRoles = [
    "developer",
  ];
  assertInvalid(missingPermission);

  const legacyReviewer = document();
  legacyReviewer.workCoordination.policy.configurationChangeRoles = [
    "pr-reviewer",
  ];
  assertInvalid(legacyReviewer);
});

test("Git Head snapshot configuration is opt-in and preserves legacy workspaces", () => {
  const legacy = document();
  legacy.codeExecutor = {
    enabled: false,
    workspaces: [{ id: "dashboard", sourceRoot: "dashboard" }],
  };
  assert.deepEqual(normalizeConfigurationDocument(legacy).codeExecutor, {
    enabled: false,
    workspaces: [{ id: "dashboard", sourceRoot: "dashboard" }],
  });

  const optedIn = structuredClone(legacy);
  optedIn.codeExecutor.gitCommand =
    "C:\\Program Files\\Git\\mingw64\\bin\\git.exe";
  optedIn.codeExecutor.gitTimeoutMs = 30_000;
  optedIn.codeExecutor.workspaces[0].gitHeadSnapshot = true;

  assert.deepEqual(normalizeConfigurationDocument(optedIn).codeExecutor, {
    enabled: false,
    gitCommand: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    gitTimeoutMs: 30_000,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        gitHeadSnapshot: true,
      },
    ],
  });
});

test("Git Head snapshot workspaces require a bounded Git configuration", () => {
  const missingCommand = document();
  missingCommand.codeExecutor = {
    enabled: false,
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        gitHeadSnapshot: true,
      },
    ],
  };
  assertInvalid(missingCommand);

  for (const timeout of [1, 60_000]) {
    const boundary = document();
    boundary.codeExecutor.gitTimeoutMs = timeout;
    assert.equal(
      normalizeConfigurationDocument(boundary).codeExecutor.gitTimeoutMs,
      timeout,
    );
  }

  for (const timeout of [0, 60_001, 1.5]) {
    const invalidTimeout = document();
    invalidTimeout.codeExecutor.gitTimeoutMs = timeout;
    assertInvalid(invalidTimeout);
  }

  const blankCommand = document();
  blankCommand.codeExecutor.gitCommand = "   ";
  assertInvalid(blankCommand);

  const invalidFlag = structuredClone(missingCommand);
  invalidFlag.codeExecutor.gitCommand = "git";
  invalidFlag.codeExecutor.workspaces[0].gitHeadSnapshot = "true";
  assertInvalid(invalidFlag);

  const relativeCommand = structuredClone(missingCommand);
  relativeCommand.codeExecutor.gitCommand = "tools/mingw64/bin/git.exe";
  assertInvalid(relativeCommand);
});

test("Windows Git Head snapshots reject wrapper executables before activation", () => {
  if (process.platform !== "win32") return;
  const wrapper = document();
  wrapper.codeExecutor = {
    enabled: false,
    gitCommand: "C:\\Program Files\\Git\\cmd\\git.exe",
    workspaces: [{
      id: "dashboard",
      sourceRoot: "dashboard",
      gitHeadSnapshot: true,
    }],
  };
  assert.throws(
    () => normalizeConfigurationDocument(wrapper),
    (error) =>
      error instanceof ConfigurationContractError &&
      error.code === "INVALID_CONFIGURATION_DOCUMENT" &&
      error.message.startsWith("codeExecutor.gitCommand "),
  );

});

test("conflict preparation is opt-in and preserves the legacy code executor shape", () => {
  const legacy = normalizeConfigurationDocument(document());
  assert.equal(
    Object.hasOwn(legacy.codeExecutor, "conflictPreparation"),
    false,
  );

  const disabled = document();
  disabled.codeExecutor.conflictPreparation = { enabled: false };
  assert.deepEqual(
    normalizeConfigurationDocument(disabled).codeExecutor.conflictPreparation,
    { enabled: false },
  );

  const enabled = normalizeConfigurationDocument(conflictPreparationDocument());
  assert.deepEqual(enabled.codeExecutor.conflictPreparation, {
    enabled: true,
    baseMirrorsByRepository: {
      "acme/command-center": mirrorPath("oct-base"),
    },
    headMirrorsByRepository: {
      "acme/command-center": mirrorPath("oct-head"),
    },
  });
  assertDeepFrozen(enabled.codeExecutor.conflictPreparation);
});

test("conflict preparation uses exact enabled and disabled shapes", () => {
  const staleDisabled = document();
  staleDisabled.codeExecutor.conflictPreparation = {
    enabled: false,
    baseMirrorsByRepository: {},
  };
  assertInvalid(staleDisabled);

  for (const name of [
    "baseMirrorsByRepository",
    "headMirrorsByRepository",
  ]) {
    const missing = conflictPreparationDocument();
    delete missing.codeExecutor.conflictPreparation[name];
    assertInvalid(missing);

    const empty = conflictPreparationDocument();
    empty.codeExecutor.conflictPreparation[name] = {};
    assertInvalid(empty);
  }
});

test("conflict preparation accepts only canonical repository keys and local absolute mirrors", () => {
  const duplicate = conflictPreparationDocument();
  duplicate.codeExecutor.conflictPreparation.baseMirrorsByRepository[
    "ACME/COMMAND-CENTER"
  ] = mirrorPath("duplicate");
  assertInvalid(duplicate);

  for (const repository of ["owner-/repository", "bad--owner/repository", "owner/.repo", "owner/repo..git"]) {
    const invalidRepository = conflictPreparationDocument();
    invalidRepository.codeExecutor.conflictPreparation.baseMirrorsByRepository = {
      [repository]: mirrorPath("invalid-repository"),
    };
    assertInvalid(invalidRepository);
  }

  for (const mirror of ["relative/repository.git", "//server/share/repository.git"]) {
    const invalidMirror = conflictPreparationDocument();
    invalidMirror.codeExecutor.conflictPreparation.baseMirrorsByRepository[
      "acme/command-center"
    ] = mirror;
    assertInvalid(invalidMirror);
  }
});

test("conflict preparation requires the same trusted Git implementation as snapshots", () => {
  const missing = conflictPreparationDocument();
  delete missing.codeExecutor.gitCommand;
  assertInvalid(missing);

  const relative = conflictPreparationDocument();
  relative.codeExecutor.gitCommand = "tools/mingw64/bin/git.exe";
  assertInvalid(relative);

  if (process.platform === "win32") {
    const wrapper = conflictPreparationDocument();
    wrapper.codeExecutor.gitCommand = "C:\\Program Files\\Git\\cmd\\git.exe";
    assertInvalid(wrapper);
  }
});

test("Git Head snapshot fields retain strict data-only boundaries", () => {
  const extra = document();
  extra.codeExecutor = {
    enabled: false,
    gitCommand: "git",
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "dashboard",
        gitHeadSnapshot: true,
        gitRevision: "HEAD",
      },
    ],
  };
  assertInvalid(extra);

  for (const accessorPath of ["gitCommand", "gitHeadSnapshot"]) {
    const accessor = document();
    accessor.codeExecutor = {
      enabled: false,
      gitCommand: "git",
      workspaces: [
        {
          id: "dashboard",
          sourceRoot: "dashboard",
          gitHeadSnapshot: true,
        },
      ],
    };
    const target =
      accessorPath === "gitCommand"
        ? accessor.codeExecutor
        : accessor.codeExecutor.workspaces[0];
    let getterCalls = 0;
    Object.defineProperty(target, accessorPath, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return accessorPath === "gitCommand" ? "git" : true;
      },
    });

    assertInvalid(accessor);
    assert.equal(getterCalls, 0);
  }
});

test("accessors, symbols, and abnormal prototypes are rejected without invoking them", () => {
  const accessor = document();
  let getterCalls = 0;
  Object.defineProperty(accessor.employees.roles.developer.brain, "model", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-run";
    },
  });
  assertInvalid(accessor);
  assert.equal(getterCalls, 0);

  const symbol = document();
  symbol.memory[Symbol("hidden")] = true;
  assertInvalid(symbol);

  const abnormalPrototype = document();
  abnormalPrototype.memory.imports = Object.assign(Object.create(null), {
    localSessions: false,
    git: false,
  });
  assertInvalid(abnormalPrototype);
});

test("sparse, decorated, and cyclic configuration values are rejected", () => {
  const sparse = document();
  sparse.trackedRepositories = new Array(2);
  sparse.trackedRepositories[1] = "acme/product";
  assertInvalid(sparse);

  const decorated = document();
  decorated.employees.roles.developer.permissions.allowedIntents.extra = true;
  assertInvalid(decorated);

  const cyclic = document();
  cyclic.employees.roles.developer.brain.remoteData = cyclic;
  assertInvalid(cyclic);

  const nullMap = document();
  nullMap.brainProviders = null;
  assertInvalid(nullMap);
});

test("actual credentials are rejected while bounded environment references remain persistable", () => {
  for (const [field, value] of [
    ["token", "ghp_not-a-real-token"],
    ["apiKey", "sk-not-a-real-key"],
    ["password", "not-a-real-password"],
    ["privateKey", "-----BEGIN PRIVATE KEY-----"],
  ]) {
    const unsafe = document();
    unsafe.brainProviders.ollama[field] = value;
    assertInvalid(unsafe);
  }

  const referenced = document();
  referenced.brainProviders["remote-smart"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
    timeoutMs: 60_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
    remote: true,
  };
  referenced.githubActions = {
    enabled: false,
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
  };

  const normalized = normalizeConfigurationDocument(referenced);
  assert.equal(
    normalized.brainProviders["remote-smart"].apiKeyEnv,
    "MYDASHBOARD_MODEL_TOKEN",
  );
  assert.equal(
    normalized.githubActions.tokenEnv,
    "MYDASHBOARD_GITHUB_TOKEN",
  );
  assert.equal(JSON.stringify(normalized).includes("not-a-real"), false);
});

test("GitHub PR external actions require an explicit unique allow-list", () => {
  const configured = document();
  configured.githubActions = {
    enabled: true,
    actorAccountId: "runtime-user",
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    ghCommand: process.execPath,
    enabledActions: ["comment", "review", "update_branch", "merge"],
  };

  assert.deepEqual(
    normalizeConfigurationDocument(configured).githubActions.enabledActions,
    ["comment", "review", "update_branch", "merge"],
  );

  for (const enabledActions of [
    ["comment", "comment"],
    ["delete_branch"],
    "comment",
  ]) {
    const invalid = structuredClone(configured);
    invalid.githubActions.enabledActions = enabledActions;
    assertInvalid(invalid);
  }

  assert.equal(
    Object.hasOwn(
      normalizeConfigurationDocument((() => {
        const legacy = document();
        delete legacy.githubActions.enabledActions;
        return legacy;
      })()).githubActions,
      "enabledActions",
    ),
    false,
  );
});

test("GitHub PR action capability changes are authority changes requiring restart", () => {
  const legacy = document();
  delete legacy.githubActions.enabledActions;
  const enabled = structuredClone(legacy);
  enabled.githubActions.enabledActions = ["comment", "merge"];
  const expansion = configurationDocumentImpact(legacy, enabled);
  assert.deepEqual(expansion.authority_expansion, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(expansion.security_tightening, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(expansion.restart_required, [
    "githubActions.enabledActions",
  ]);

  const tightened = structuredClone(enabled);
  tightened.githubActions.enabledActions = ["comment"];
  const removal = configurationDocumentImpact(enabled, tightened);
  assert.deepEqual(removal.security_tightening, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(removal.authority_expansion, []);
  assert.deepEqual(removal.restart_required, [
    "githubActions.enabledActions",
  ]);

  const explicitlyDisabled = structuredClone(legacy);
  explicitlyDisabled.githubActions.enabledActions = [];
  const legacyDisabled = configurationDocumentImpact(
    legacy,
    explicitlyDisabled,
  );
  assert.deepEqual(legacyDisabled.security_tightening, [
    "githubActions.enabledActions",
  ]);
  assert.deepEqual(legacyDisabled.authority_expansion, []);

  const legacyRestored = configurationDocumentImpact(
    explicitlyDisabled,
    legacy,
  );
  assert.deepEqual(legacyRestored.security_tightening, []);
  assert.deepEqual(legacyRestored.authority_expansion, [
    "githubActions.enabledActions",
  ]);
});

test("role brains, routing targets, and trusted policies must reference declared configuration", () => {
  const missingProvider = document();
  missingProvider.employees.roles.developer.brain.provider = "missing-provider";
  assertInvalid(missingProvider);

  const missingRole = document();
  missingRole.workflowRouting.rules[0].targets[0].id = "missing-role";
  assertInvalid(missingRole);

  const untrustedCodeRole = document();
  untrustedCodeRole.workCoordination.policy.codeOperationsByRole.orchestrator = [
    "modify",
  ];
  assertInvalid(untrustedCodeRole);
});

test("legacy brains stay on Ollama while routed role and memory brains accept remote providers", () => {
  for (const mutate of [
    (value) => {
      value.brain.provider = "remote-smart";
    },
    (value) => {
      value.employees.prReviewer.brain.provider = "remote-smart";
    },
  ]) {
    const legacy = document();
    legacy.brainProviders["remote-smart"] = {
      kind: "openai-compatible",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
      remote: true,
    };
    mutate(legacy);
    assertInvalid(legacy);
  }

  const routed = document();
  routed.brainProviders["remote-smart"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
    remote: true,
  };
  routed.employees.roles.developer.brain.provider = "remote-smart";
  routed.memory.answering.brain = structuredClone(
    routed.employees.roles.developer.brain,
  );
  routed.memory.answering.brain.provider = "remote-smart";
  const normalized = normalizeConfigurationDocument(routed);
  assert.equal(normalized.employees.roles.developer.brain.provider, "remote-smart");
  assert.equal(normalized.memory.answering.brain.provider, "remote-smart");
});

test("Responses providers use explicit credential references and stricter request limits", () => {
  const value = document();
  value.brainProviders["company.codex_api"] = {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "responses",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  value.employees.roles.developer.brain.provider = "company.codex_api";
  const normalized = normalizeConfigurationDocument(value);

  assert.deepEqual(
    normalized.brainProviders["company.codex_api"],
    value.brainProviders["company.codex_api"],
  );
  assert.equal(
    normalized.employees.roles.developer.brain.provider,
    "company.codex_api",
  );

  for (const mutate of [
    (provider) => { provider.remote = false; },
    (provider) => { delete provider.apiKeyEnv; },
    (provider) => { provider.protocol = "agents"; },
    (provider) => { provider.responseFormat = "json-object"; },
    (provider) => { provider.responseFormat = "markdown"; },
    (provider) => { provider.maxRequestBytes = 1024 * 1024 + 1; },
    (provider) => { provider.contextTokens = 16_384; },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid.brainProviders["company.codex_api"]);
    assertInvalid(invalid);
  }

  const ollamaProtocol = document();
  ollamaProtocol.brainProviders.ollama.protocol = "responses";
  assertInvalid(ollamaProtocol);

  const ollamaResponseFormat = document();
  ollamaResponseFormat.brainProviders.ollama.responseFormat = "json-schema";
  assertInvalid(ollamaResponseFormat);
});

test("supervised CLI providers are closed remote-only brain identities", () => {
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

    const normalized = normalizeConfigurationDocument(value);
    assert.deepEqual(normalized.brainProviders[kind], value.brainProviders[kind]);
    assert.equal(normalized.employees.roles.orchestrator.brain.provider, kind);
  }
});

test("CLI provider credential modes remain optional legacy configuration and classify authority", () => {
  const legacy = document();
  legacy.brainProviders.cli = { kind: "codex-cli", remote: true };
  assert.equal(
    Object.hasOwn(normalizeConfigurationDocument(legacy).brainProviders.cli, "credentialMode"),
    false,
  );

  for (const credentialMode of ["api-key", "codex-login"]) {
    const configured = structuredClone(legacy);
    configured.brainProviders.cli.credentialMode = credentialMode;
    assert.equal(
      normalizeConfigurationDocument(configured).brainProviders.cli.credentialMode,
      credentialMode,
    );
  }

  const login = structuredClone(legacy);
  login.brainProviders.cli.credentialMode = "codex-login";
  assert.deepEqual(configurationDocumentImpact(legacy, login).authority_expansion, [
    "brainProviders.cli.credentialMode",
  ]);
  assert.deepEqual(configurationDocumentImpact(legacy, login).restart_required, [
    "brainProviders.cli.credentialMode",
  ]);

  const claude = structuredClone(legacy);
  claude.brainProviders.cli = { kind: "claude-cli", remote: true, credentialMode: "codex-login" };
  assertInvalid(claude);

  for (const provider of ["ollama", "openai-compatible"]) {
    const nonCli = document();
    const providerId = provider === "ollama" ? "ollama" : "openai";
    if (provider === "openai-compatible") {
      nonCli.brainProviders[providerId] = {
        kind: provider,
        baseUrl: "https://models.example/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        remote: true,
        credentialMode: "api-key",
      };
    } else {
      nonCli.brainProviders[providerId].credentialMode = "api-key";
    }
    assertInvalid(nonCli);
  }
});

test("supervised CLI provider configuration cannot widen process authority", () => {
  const cases = [
    {
      name: "missing remote classification",
      mutate(provider) { delete provider.remote; },
      path: "brainProviders.codex-cli.remote",
    },
    {
      name: "local classification",
      mutate(provider) { provider.remote = false; },
      path: "brainProviders.codex-cli.remote",
    },
    {
      name: "model endpoint",
      mutate(provider) { provider.baseUrl = "https://models.example/v1"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "credential reference",
      mutate(provider) { provider.apiKeyEnv = "OPENAI_API_KEY"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "wire protocol",
      mutate(provider) { provider.protocol = "responses"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "response format",
      mutate(provider) { provider.responseFormat = "json-schema"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "context window",
      mutate(provider) { provider.contextTokens = 16_384; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "executable",
      mutate(provider) { provider.executable = "codex"; },
      path: "brainProviders.codex-cli",
    },
    {
      name: "arguments",
      mutate(provider) { provider.args = ["--dangerously-bypass-approvals-and-sandbox"]; },
      path: "brainProviders.codex-cli",
    },
  ];

  for (const { name, mutate, path } of cases) {
    const value = document();
    value.brainProviders["codex-cli"] = {
      kind: "codex-cli",
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
    };
    mutate(value.brainProviders["codex-cli"]);
    assert.throws(
      () => normalizeConfigurationDocument(value),
      (error) =>
        error instanceof ConfigurationContractError &&
        error.message.includes(path),
      name,
    );
  }

  for (const [field, value] of [
    ["timeoutMs", 999],
    ["timeoutMs", 3_600_001],
    ["maxResponseBytes", 1_023],
    ["maxResponseBytes", 1_048_577],
    ["maxRequestBytes", 1_023],
    ["maxRequestBytes", 1_048_577],
  ]) {
    const invalid = document();
    invalid.brainProviders["claude-cli"] = {
      kind: "claude-cli",
      remote: true,
      timeoutMs: 300_000,
      maxResponseBytes: 131_072,
      maxRequestBytes: 262_144,
      [field]: value,
    };
    assertInvalid(invalid);
  }
});

test("providers without protocol preserve legacy numeric configuration ranges", () => {
  const value = document();
  value.brainProviders["legacy.remote"] = {
    kind: "openai-compatible",
    baseUrl: "https://legacy.example/v1",
    apiKeyEnv: "LEGACY_MODEL_TOKEN",
    remote: true,
    timeoutMs: 180_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxRequestBytes: 1,
  };

  const normalized = normalizeConfigurationDocument(value);
  assert.deepEqual(
    normalized.brainProviders["legacy.remote"],
    value.brainProviders["legacy.remote"],
  );

  const explicitChat = structuredClone(value);
  explicitChat.brainProviders["legacy.remote"].protocol = "chat-completions";
  assertInvalid(explicitChat);
});

test("change package activation requires the code executor it composes with", () => {
  const invalid = document();
  invalid.changePackages = {
    enabled: true,
    gitCommand: trustedGitCommand(),
  };
  invalid.codeExecutor = { enabled: false };

  assertInvalid(invalid);
});

test("provider protocol changes require new authority and restart", () => {
  const before = document();
  before.brainProviders["company.codex_api"] = {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "chat-completions",
    remote: true,
    timeoutMs: 120_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  before.employees.roles.developer.brain.provider = "company.codex_api";
  const after = structuredClone(before);
  after.brainProviders["company.codex_api"].protocol = "responses";

  const impact = configurationDocumentImpact(before, after);

  assert.deepEqual(impact.security_tightening, [
    "brainProviders.company.codex_api.protocol",
  ]);
  assert.deepEqual(impact.authority_expansion, [
    "brainProviders.company.codex_api.protocol",
  ]);
  assert.deepEqual(impact.benign_claim_change, []);
  assert.deepEqual(impact.restart_required, [
    "brainProviders.company.codex_api.protocol",
  ]);
});

test("provider response format changes require new authority and restart", () => {
  const before = document();
  before.brainProviders["company.ark_coding"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "ARK_API_KEY",
    protocol: "chat-completions",
    responseFormat: "json-schema",
    remote: true,
  };
  before.employees.roles.developer.brain.provider = "company.ark_coding";
  const after = structuredClone(before);
  after.brainProviders["company.ark_coding"].responseFormat = "json-object";

  const impact = configurationDocumentImpact(before, after);

  assert.deepEqual(impact.security_tightening, [
    "brainProviders.company.ark_coding.responseFormat",
  ]);
  assert.deepEqual(impact.authority_expansion, [
    "brainProviders.company.ark_coding.responseFormat",
  ]);
  assert.deepEqual(impact.benign_claim_change, []);
  assert.deepEqual(impact.restart_required, [
    "brainProviders.company.ark_coding.responseFormat",
  ]);
});

test("impact classifies security tightening and authority expansion directionally", () => {
  const permitted = document();
  permitted.employees.roles.developer.brain.remoteData.code = true;
  permitted.employees.roles.developer.permissions.allowedIntents.push(
    "orchestrate",
  );

  const tightened = configurationDocumentImpact(permitted, document());
  assert.deepEqual(tightened.authority_expansion, []);
  assert.deepEqual(tightened.security_tightening, [
    "employees.roles.developer.brain.remoteData.code",
    "employees.roles.developer.permissions.allowedIntents",
  ]);

  const expanded = configurationDocumentImpact(document(), permitted);
  assert.deepEqual(expanded.security_tightening, []);
  assert.deepEqual(expanded.authority_expansion, [
    "employees.roles.developer.brain.remoteData.code",
    "employees.roles.developer.permissions.allowedIntents",
  ]);
  assertDeepFrozen(expanded);
});

test("impact treats provider identity and repository scope changes as authority changes", () => {
  const expandedDocument = document();
  expandedDocument.brainProviders["remote-smart"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_TOKEN",
    timeoutMs: 60_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
    remote: true,
  };
  expandedDocument.employees.roles.developer.brain.provider = "remote-smart";
  expandedDocument.trackedRepositories.push("acme/new-product");

  const expanded = configurationDocumentImpact(document(), expandedDocument);
  assert.deepEqual(expanded.security_tightening, [
    "employees.roles.developer.brain.provider",
  ]);
  assert.deepEqual(expanded.authority_expansion, [
    "brainProviders.remote-smart",
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);
  assert.deepEqual(expanded.restart_required, [
    "brainProviders.remote-smart",
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);

  const tightened = configurationDocumentImpact(expandedDocument, document());
  assert.deepEqual(tightened.security_tightening, [
    "brainProviders.remote-smart",
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);
  assert.deepEqual(tightened.authority_expansion, [
    "employees.roles.developer.brain.provider",
  ]);
});

test("task brain authority changes invalidate precisely and require runtime restart", () => {
  const configured = document();
  configured.employees.roles.developer.taskBrain = {
    provider: "ollama",
    model: "qwen3.5:task",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const addition = configurationDocumentImpact(document(), configured);
  assert.deepEqual(addition.security_tightening, []);
  assert.deepEqual(addition.authority_expansion, [
    "employees.roles.developer.taskBrain",
  ]);
  assert.deepEqual(addition.restart_required, [
    "employees.roles.developer.taskBrain",
  ]);

  const changedModel = structuredClone(configured);
  changedModel.employees.roles.developer.taskBrain.model = "qwen3.5:task-v2";
  const replacement = configurationDocumentImpact(configured, changedModel);
  const modelPath = "employees.roles.developer.taskBrain.model";
  assert.deepEqual(replacement.security_tightening, []);
  assert.deepEqual(replacement.authority_expansion, []);
  assert.deepEqual(replacement.benign_claim_change, [modelPath]);
  assert.deepEqual(replacement.restart_required, [modelPath]);

  const expandedData = structuredClone(configured);
  expandedData.employees.roles.developer.taskBrain.remoteData.code = true;
  const dataExpansion = configurationDocumentImpact(configured, expandedData);
  const dataPath = "employees.roles.developer.taskBrain.remoteData.code";
  assert.deepEqual(dataExpansion.security_tightening, []);
  assert.deepEqual(dataExpansion.authority_expansion, [dataPath]);
  assert.deepEqual(dataExpansion.restart_required, [dataPath]);

  const removed = configurationDocumentImpact(configured, document());
  assert.deepEqual(removed.security_tightening, [
    "employees.roles.developer.taskBrain",
  ]);
  assert.deepEqual(removed.authority_expansion, []);
  assert.deepEqual(removed.restart_required, [
    "employees.roles.developer.taskBrain",
  ]);
});

test("conflict preparation changes invalidate authority and restart classifications precisely", () => {
  const enabled = conflictPreparationDocument();
  const activation = configurationDocumentImpact(document(), enabled);

  assert.equal(
    activation.authority_expansion.includes(
      "codeExecutor.conflictPreparation",
    ),
    true,
  );
  assert.equal(
    activation.restart_required.includes("codeExecutor.conflictPreparation"),
    true,
  );
  assert.equal(
    activation.restart_required.includes("codeExecutor.gitCommand"),
    true,
  );

  const changedMirror = structuredClone(enabled);
  changedMirror.codeExecutor.conflictPreparation.baseMirrorsByRepository[
    "acme/command-center"
  ] = mirrorPath("replacement-base");
  const replacement = configurationDocumentImpact(enabled, changedMirror);
  const changedPath =
    "codeExecutor.conflictPreparation.baseMirrorsByRepository.acme/command-center";
  assert.equal(replacement.security_tightening.includes(changedPath), true);
  assert.equal(replacement.authority_expansion.includes(changedPath), true);
  assert.equal(replacement.restart_required.includes(changedPath), true);
});

test("impact separates semantic claim changes while reporting actual restart needs", () => {
  const changed = document();
  changed.port += 1;
  changed.employees.roles.developer.brain.model = "qwen3.5:small";
  changed.employees.roles.developer.mission = "实现已验收需求并报告证据。";

  const impact = configurationDocumentImpact(document(), changed);

  assert.equal(impact.changed, true);
  assert.notEqual(impact.beforeDigest, impact.afterDigest);
  assert.deepEqual(impact.security_tightening, []);
  assert.deepEqual(impact.authority_expansion, []);
  assert.deepEqual(impact.benign_claim_change, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.mission",
  ]);
  assert.deepEqual(impact.restart_required, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.mission",
    "port",
  ]);
});

test("every changed path is reported as restart-required while runtime composition is immutable", () => {
  const changed = document();
  changed.refreshMinutes += 1;
  changed.employees.roles.developer.brain.model = "qwen3.5:replacement";
  changed.employees.roles.developer.mission = "Use the replacement mission.";
  changed.employees.roles.developer.brain.remoteData.code = true;

  const impact = configurationDocumentImpact(document(), changed);

  assert.deepEqual(impact.restart_required, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.brain.remoteData.code",
    "employees.roles.developer.mission",
    "refreshMinutes",
  ]);
  assert.deepEqual(impact.authority_expansion, [
    "employees.roles.developer.brain.remoteData.code",
  ]);
  assert.deepEqual(impact.benign_claim_change, [
    "employees.roles.developer.brain.model",
    "employees.roles.developer.mission",
    "refreshMinutes",
  ]);
});

test("identical documents have no impact and expose immutable empty classifications", () => {
  const impact = configurationDocumentImpact(document(), reverseObjectKeys(document()));

  assert.equal(impact.changed, false);
  assert.equal(impact.beforeDigest, impact.afterDigest);
  assert.deepEqual(impact.security_tightening, []);
  assert.deepEqual(impact.authority_expansion, []);
  assert.deepEqual(impact.benign_claim_change, []);
  assert.deepEqual(impact.restart_required, []);
  assertDeepFrozen(impact);
});
