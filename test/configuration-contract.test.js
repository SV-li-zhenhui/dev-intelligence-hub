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
  await readFile(path.join(projectRoot, "config.json"), "utf8"),
);

function document() {
  return structuredClone(committedDocument);
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
  sparse.trackedRepositories[1] = "SVisions/OCT-Product";
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
  expandedDocument.trackedRepositories.push("SVisions/New-Product");

  const expanded = configurationDocumentImpact(document(), expandedDocument);
  assert.deepEqual(expanded.security_tightening, [
    "employees.roles.developer.brain.provider",
  ]);
  assert.deepEqual(expanded.authority_expansion, [
    "brainProviders.remote-smart",
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);
  assert.deepEqual(expanded.restart_required, ["brainProviders.remote-smart"]);

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

test("impact separates claim-time behavior from restart-required infrastructure", () => {
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
  assert.deepEqual(impact.restart_required, ["port"]);
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
