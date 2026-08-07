import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONFIGURATION_FORM_SCHEMA,
  configurationCollectionDescriptor,
  configurationFieldDescriptor,
  configurationStructureTemplate,
} from "../public/configuration-form-schema.js";
import { normalizeConfigurationDocument } from "../src/domain/configuration-contract.js";

const configurationText = await readFile(
  new URL("../config.json", import.meta.url),
  "utf8",
);

function extendedConfiguration() {
  const configuration = JSON.parse(configurationText);
  configuration.codeExecutor = {
    enabled: false,
    gitCommand: "C:/Program Files/Git/mingw64/bin/git.exe",
    gitTimeoutMs: 30_000,
    docker: {
      executable: "docker",
      host: "npipe:////./pipe/docker_engine",
    },
    workspaces: [
      {
        id: "dashboard",
        sourceRoot: "D:/claude/MyDashboard",
        gitHeadSnapshot: true,
        writablePaths: ["public"],
        excludePaths: ["node_modules"],
      },
    ],
    profiles: {
      "node-contract": {
        kind: "node-test",
        image: `node:22-alpine@sha256:${"0".repeat(64)}`,
        timeoutMs: 120_000,
      },
    },
    requiredProfilesByWorkspace: {
      dashboard: ["node-contract"],
    },
  };
  configuration.githubActions.networkEnv = {
    HTTPS_PROXY: "http://127.0.0.1:7890",
  };
  configuration.workCoordination.policy.workspaceByRepository = {
    "SVisions/OCT-Software": "dashboard",
  };
  return normalizeConfigurationDocument(configuration);
}

function visit(value, path, visitor) {
  visitor(value, path);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, [...path, index], visitor));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    visit(entry, [...path, key], visitor);
  }
}

test("declarative schema describes every primitive field in a normalized configuration", () => {
  const configuration = extendedConfiguration();
  const primitives = [];
  visit(configuration, [], (value, path) => {
    if (value === null || typeof value !== "object") primitives.push([value, path]);
  });

  for (const [value, path] of primitives) {
    const descriptor = configurationFieldDescriptor(path, value);
    assert.ok(descriptor, `missing field descriptor for ${path.join(".")}`);
    assert.match(descriptor.label, /\S/);
    assert.ok(
      ["text", "number", "checkbox", "select", "env-reference", "scalar"].includes(
        descriptor.control,
      ),
      `unsupported control for ${path.join(".")}`,
    );
  }
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA), true);
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA.groups), true);
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA.fields), true);
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_SCHEMA.collections), true);
});

test("every supported array and mapping exposes add, remove, replace and a safe template", () => {
  const configuration = extendedConfiguration();
  const collectionPaths = [];
  visit(configuration, [], (value, path) => {
    if (Array.isArray(value)) collectionPaths.push([path, value]);
  });
  for (const path of [
    ["brainProviders"],
    ["employees", "roles"],
    ["codeExecutor", "profiles"],
    ["codeExecutor", "requiredProfilesByWorkspace"],
    ["githubActions", "networkEnv"],
    ["workCoordination", "policy", "capabilityRoles"],
    ["workCoordination", "policy", "codeOperationsByRole"],
    ["workCoordination", "policy", "workspaceByRepository"],
  ]) {
    let value = configuration;
    for (const segment of path) value = value[segment];
    collectionPaths.push([path, value]);
  }

  for (const [path, value] of collectionPaths) {
    const descriptor = configurationCollectionDescriptor(path, value);
    assert.ok(descriptor, `missing collection descriptor for ${path.join(".")}`);
    assert.deepEqual(descriptor.operations, ["add", "remove", "replace"]);
    const template = configurationStructureTemplate(path);
    assert.equal(template.kind, Array.isArray(value) ? "array" : "map");
    assert.equal(typeof template.value === "string" && /^[\[{]/.test(template.value), false);
  }
});

test("schema identifies enum, numeric, boolean and environment-reference controls centrally", () => {
  const providerKind = configurationFieldDescriptor(
    ["brainProviders", "ollama", "kind"],
    "ollama",
  );
  assert.equal(providerKind.control, "text");
  assert.equal(providerKind.readOnly, true);
  assert.equal(Object.hasOwn(providerKind, "options"), false);
  assert.deepEqual(
    configurationFieldDescriptor(
      ["workflowRouting", "rules", 0, "targets", 0, "type"],
      "role",
    ).options,
    ["role", "person", "node"],
  );
  assert.equal(
    configurationFieldDescriptor(["githubActions", "tokenEnv"], "TOKEN_ENV")
      .control,
    "env-reference",
  );
  assert.equal(configurationFieldDescriptor(["port"], 4173).minimum, 1);
  assert.equal(configurationFieldDescriptor(["port"], 4173).maximum, 65_535);
  const providerTimeout = configurationFieldDescriptor(
    ["brainProviders", "legacy", "timeoutMs"],
    180_000,
  );
  assert.equal(providerTimeout.minimum, 1);
  assert.equal(providerTimeout.maximum, 3_600_000);
  const providerResponseLimit = configurationFieldDescriptor(
    ["brainProviders", "legacy", "maxResponseBytes"],
    2 * 1024 * 1024,
  );
  assert.equal(providerResponseLimit.minimum, 1);
  assert.equal(providerResponseLimit.maximum, 2 * 1024 * 1024);
  assert.equal(
    configurationFieldDescriptor(["memory", "enabled"], true).control,
    "checkbox",
  );
  const gitCommand = configurationFieldDescriptor(
    ["codeExecutor", "gitCommand"],
    "C:/Program Files/Git/mingw64/bin/git.exe",
  );
  assert.equal(gitCommand.control, "text");
  assert.equal(gitCommand.kind, "text");
  assert.equal(gitCommand.maximumBytes, 4_096);
  const gitTimeout = configurationFieldDescriptor(
    ["codeExecutor", "gitTimeoutMs"],
    30_000,
  );
  assert.equal(gitTimeout.control, "number");
  assert.equal(gitTimeout.kind, "integer");
  assert.equal(gitTimeout.minimum, 1);
  assert.equal(gitTimeout.maximum, 60_000);
  const gitHeadSnapshot = configurationFieldDescriptor(
    ["codeExecutor", "workspaces", 0, "gitHeadSnapshot"],
    true,
  );
  assert.equal(gitHeadSnapshot.control, "checkbox");
  assert.equal(gitHeadSnapshot.kind, "boolean");
});

test("Git Head snapshot fields expose safe scalar templates for old configurations", () => {
  assert.deepEqual(
    configurationStructureTemplate(["codeExecutor", "gitCommand"]),
    {
      kind: "slot",
      value: "C:/Program Files/Git/mingw64/bin/git.exe",
    },
  );
  assert.deepEqual(
    configurationStructureTemplate(["codeExecutor", "gitTimeoutMs"]),
    { kind: "slot", value: 30_000 },
  );
  assert.deepEqual(
    configurationStructureTemplate([
      "codeExecutor",
      "workspaces",
      0,
      "gitHeadSnapshot",
    ]),
    { kind: "slot", value: true },
  );
  assert.deepEqual(
    configurationStructureTemplate(["codeExecutor", "workspaces"]).value,
    {
      id: "workspace-id",
      sourceRoot: ".",
      gitHeadSnapshot: false,
      writablePaths: [],
      excludePaths: [],
    },
  );
});

test("router-backed brain references declare a dynamic provider option source", () => {
  for (const path of [
    ["employees", "roles", "developer", "brain", "provider"],
    ["memory", "answering", "brain", "provider"],
    ["memory", "answering", "localBrain", "provider"],
  ]) {
    const descriptor = configurationFieldDescriptor(path, "remote.openai");
    assert.equal(descriptor.control, "select", path.join("."));
    assert.equal(descriptor.optionsFrom, "brainProviders", path.join("."));
    assert.equal(Object.hasOwn(descriptor, "options"), false, path.join("."));
    assert.equal(descriptor.format, "safe-id", path.join("."));
  }
  for (const path of [
    ["brain", "provider"],
    ["employees", "prReviewer", "brain", "provider"],
  ]) {
    const descriptor = configurationFieldDescriptor(path, "ollama");
    assert.deepEqual(descriptor.options, ["ollama"], path.join("."));
    assert.equal(Object.hasOwn(descriptor, "optionsFrom"), false, path.join("."));
  }
});

test("new provider template is a complete openai-compatible provider", () => {
  const template = configurationStructureTemplate(["brainProviders"]).value;
  assert.equal(template.kind, "openai-compatible");
  assert.equal(template.apiKeyEnv, "MYDASHBOARD_MODEL_API_KEY");
  assert.equal(template.responseFormat, "json-schema");
  assert.equal(template.remote, true);
  assert.equal(Object.hasOwn(template, "contextTokens"), false);
});

test("provider variants expose complete Responses and Ollama forms without stale fields", () => {
  assert.equal(
    configurationFieldDescriptor(["brainProviders", "codex", "kind"], "openai-compatible")
      .readOnly,
    true,
  );
  const responses = configurationStructureTemplate(
    ["brainProviders"],
    "openai-responses",
  );
  assert.equal(responses.key, "codex-api");
  assert.deepEqual(responses.value, {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "responses",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  });
  assert.equal(Object.hasOwn(responses.value, "contextTokens"), false);
  assert.deepEqual(
    configurationFieldDescriptor(
      ["brainProviders", "codex", "protocol"],
      "responses",
    ).options,
    ["chat-completions", "responses"],
  );
  const responseFormat = configurationFieldDescriptor(
    ["brainProviders", "codex", "responseFormat"],
    "json-schema",
  );
  assert.equal(responseFormat.label, "结构化输出模式");
  assert.equal(responseFormat.control, "select");
  assert.deepEqual(responseFormat.options, ["json-schema", "json-object"]);

  const ollama = configurationStructureTemplate(["brainProviders"], "ollama");
  assert.equal(ollama.value.kind, "ollama");
  assert.equal(ollama.value.baseUrl, "http://127.0.0.1:11434");
  assert.equal(Object.hasOwn(ollama.value, "executable"), false);
  assert.throws(
    () => configurationStructureTemplate(["brainProviders"], "missing"),
    /variant is unavailable/i,
  );
});

test("schema public path boundary rejects accessors, prototypes and oversized paths", () => {
  let getterCalled = false;
  const path = [];
  Object.defineProperty(path, "0", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "port";
    },
  });
  path.length = 1;
  assert.throws(() => configurationFieldDescriptor(path, 4173), /data|dense/i);
  assert.equal(getterCalled, false);
  assert.throws(
    () => configurationFieldDescriptor(Object.assign(Object.create(null), { 0: "port", length: 1 }), 4173),
    /array/i,
  );
  assert.throws(
    () => configurationFieldDescriptor(Array.from({ length: 33 }, () => "x"), "x"),
    /path|limit/i,
  );

  let collectionGetterCalled = false;
  const collection = {};
  Object.defineProperty(collection, "unsafe", {
    enumerable: true,
    get() {
      collectionGetterCalled = true;
      return {};
    },
  });
  assert.throws(
    () => configurationCollectionDescriptor(["brainProviders"], collection),
    /data properties/i,
  );
  assert.equal(collectionGetterCalled, false);
});
