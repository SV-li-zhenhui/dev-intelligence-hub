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
    "employees.roles.developer.brain.provider",
    "trackedRepositories",
  ]);

  const tightened = configurationDocumentImpact(expandedDocument, document());
  assert.deepEqual(tightened.security_tightening, [
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
