import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONFIGURATION_FORM_GROUPS,
  configurationDocumentFromForm,
  createConfigurationFormState,
  setConfigurationFormField,
} from "../public/configuration-form-support.js";
import { renderConfigurationSettingsSkeleton } from "../public/settings-view.js";

const [supportSource, settingsSource, currentConfigurationText] = await Promise.all([
  readFile(new URL("../public/configuration-form-support.js", import.meta.url), "utf8"),
  readFile(new URL("../public/settings-view.js", import.meta.url), "utf8"),
  readFile(new URL("../config.json", import.meta.url), "utf8"),
]);

function configurationWithCredentialReferences() {
  const configuration = JSON.parse(currentConfigurationText);
  configuration.brainProviders["remote.openai"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example.invalid/v1",
    apiKeyEnv: "MYDASHBOARD_OPENAI_API_KEY",
    remote: true,
  };
  configuration.githubActions.tokenEnv = "MYDASHBOARD_GITHUB_TOKEN";
  return configuration;
}

function configurationWithScalarConditions() {
  const configuration = configurationWithCredentialReferences();
  configuration.workflowRouting.rules[0].fallback = false;
  configuration.workflowRouting.rules[0].condition = {
    op: "oneOf",
    path: "payload.value",
    values: [null, "plain text", 1.5, true],
  };
  return configuration;
}

function configurationWithRemoteBrains() {
  const configuration = configurationWithCredentialReferences();
  configuration.employees.prReviewer.brain = {
    provider: "ollama",
    model: "qwen3.5:9b",
    baseUrl: "http://127.0.0.1:11434",
  };
  configuration.employees.roles.developer.brain.provider = "remote.openai";
  configuration.employees.roles.developer.brain.model = "gpt-5-mini";
  configuration.memory.answering.brain.provider = "remote.openai";
  configuration.memory.answering.brain.model = "gpt-5-mini";
  configuration.memory.answering.localBrain.provider = "remote.openai";
  configuration.memory.answering.localBrain.model = "gpt-5-mini";
  return configuration;
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function machinePaths(markup, attribute) {
  const pattern = new RegExp(`${attribute}="([^"]*)"`, "g");
  return [...markup.matchAll(pattern)].map((match) =>
    JSON.parse(decodeHtmlAttribute(match[1])),
  );
}

function primitivePaths(value, path = [], result = []) {
  if (value === null || typeof value !== "object") {
    result.push(path);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => primitivePaths(entry, [...path, index], result));
    return result;
  }
  for (const [key, entry] of Object.entries(value)) {
    primitivePaths(entry, [...path, key], result);
  }
  return result;
}

test("settings skeleton exposes every structured configuration group", () => {
  const state = createConfigurationFormState(configurationWithCredentialReferences());
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.match(markup, /<form[^>]+data-configuration-structured-form/);
  for (const group of CONFIGURATION_FORM_GROUPS) {
    assert.match(markup, new RegExp(`data-configuration-group="${group.id}"`));
    assert.match(markup, new RegExp(`<legend>${group.label}</legend>`));
  }
  assert.equal(
    (markup.match(/<fieldset/g) || []).length,
    CONFIGURATION_FORM_GROUPS.length,
  );
  assert.equal(Object.isFrozen(CONFIGURATION_FORM_GROUPS), true);
  assert.equal(CONFIGURATION_FORM_GROUPS.every(Object.isFrozen), true);
});

test("settings skeleton is structured and never falls back to a JSON editor", () => {
  const state = createConfigurationFormState(configurationWithCredentialReferences());
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.doesNotMatch(markup, /<textarea/i);
  assert.doesNotMatch(markup, /type=["']password/i);
  assert.doesNotMatch(settingsSource, /JSON\.stringify|JSON\.parse/);
  assert.doesNotMatch(supportSource, /eval\s*\(|new Function\s*\(/);
  const fields = machinePaths(markup, "data-configuration-field");
  const collections = machinePaths(markup, "data-configuration-collection");
  assert.deepEqual(fields.find((path) => path.length === 1 && path[0] === "port"), [
    "port",
  ]);
  for (const expected of [
    ["trackedRepositories"],
    ["employees", "roles"],
    ["workflowRouting", "rules"],
    ["codeExecutor", "workspaces"],
  ]) {
    assert.equal(
      collections.some((path) => JSON.stringify(path) === JSON.stringify(expected)),
      true,
      `missing encoded collection path ${expected.join(".")}`,
    );
  }
});

test("settings skeleton overlays valid edits and preserves invalid raw input", () => {
  let state = createConfigurationFormState(configurationWithCredentialReferences());
  state = setConfigurationFormField(state, {
    path: ["githubLogin"],
    kind: "text",
    rawValue: "SV-li-zhenhui-next",
  });
  state = setConfigurationFormField(state, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "",
  });

  const markup = renderConfigurationSettingsSkeleton({ state });
  assert.match(
    markup,
    /value="SV-li-zhenhui-next" data-configuration-field="\[&quot;githubLogin&quot;\]"/,
  );
  assert.match(
    markup,
    /value="" data-configuration-field="\[&quot;refreshMinutes&quot;\]"/,
  );
});

test("credential controls render only environment variable names and explain the boundary", () => {
  const configuration = configurationWithCredentialReferences();
  const state = createConfigurationFormState(configuration);
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.match(markup, /MYDASHBOARD_OPENAI_API_KEY/);
  assert.match(markup, /MYDASHBOARD_GITHUB_TOKEN/);
  assert.match(markup, /只填写环境变量名，不填写密钥值/);
  assert.match(markup, /autocomplete="off"/);
  assert.match(markup, /data-configuration-value-kind="env-reference"/);
  assert.doesNotMatch(markup, /process\.env/);

  const providerPath = machinePaths(markup, "data-configuration-field").find(
    (path) => path[0] === "brainProviders" && path.at(-1) === "apiKeyEnv",
  );
  assert.deepEqual(providerPath, ["brainProviders", "remote.openai", "apiKeyEnv"]);
  assert.notDeepEqual(providerPath, [
    "brainProviders",
    "remote",
    "openai",
    "apiKeyEnv",
  ]);
});

test("all interpolated configuration values are HTML escaped", () => {
  const configuration = configurationWithCredentialReferences();
  configuration.employees.roles.developer.mission = '<img src=x onerror="alert(1)">';
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configuration),
  });

  assert.doesNotMatch(markup, /<img src=x/);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("settings renderer does not invoke an accessor supplied at its public boundary", () => {
  let getterCalled = false;
  const options = {};
  Object.defineProperty(options, "state", {
    enumerable: true,
    get() {
      getterCalled = true;
      return createConfigurationFormState(configurationWithCredentialReferences());
    },
  });

  assert.throws(() => renderConfigurationSettingsSkeleton(options), /data property/i);
  assert.equal(getterCalled, false);
});

test("settings renderer exposes a native control for every primitive without count skeletons", () => {
  const configuration = configurationWithCredentialReferences();
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configuration),
  });
  const fields = machinePaths(markup, "data-configuration-field");
  const keys = new Set(fields.map((path) => JSON.stringify(path)));

  for (const path of primitivePaths(configuration)) {
    assert.equal(
      keys.has(JSON.stringify(path.map((segment) => `${segment}`))),
      true,
      `missing ${path.join(".")}`,
    );
  }
  assert.match(markup, /<input[^>]+type="text"/);
  assert.match(markup, /<input[^>]+type="number"/);
  assert.match(markup, /<input[^>]+type="checkbox"/);
  assert.match(markup, /<select[^>]+data-configuration-field/);
  assert.match(markup, /data-configuration-value-kind="env-reference"/);
  assert.doesNotMatch(markup, />\d+ 项</);
  assert.match(markup, /data-configuration-node=/);
});

test("every rendered collection has named add, remove and replace controls", () => {
  const markup = renderConfigurationSettingsSkeleton({
    state: createConfigurationFormState(configurationWithCredentialReferences()),
  });
  const collections = machinePaths(markup, "data-configuration-collection");
  assert.ok(collections.length > 0);
  for (const path of collections) {
    const encoded = escapeRegExp(configurationFormPathAttribute(path));
    assert.match(markup, new RegExp(`data-configuration-operation="add"[^>]*data-configuration-path="${encoded}"|data-configuration-path="${encoded}"[^>]*data-configuration-operation="add"`));
  }
  assert.match(markup, /<button[^>]+data-configuration-operation="remove"[^>]*>\s*删除/);
  assert.match(markup, /<button[^>]+data-configuration-operation="replace"[^>]*>\s*替换/);
  assert.match(markup, /data-configuration-template-value-root=/);
  assert.match(markup, /data-configuration-replace-template(?:[ >])/);
  assert.doesNotMatch(markup, /aria-label=""/);
});

test("invalid fields expose inline accessible errors while submit and status remain available", () => {
  let state = createConfigurationFormState(configurationWithCredentialReferences());
  state = setConfigurationFormField(state, {
    path: ["refreshMinutes"],
    kind: "integer",
    rawValue: "",
  });
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.match(markup, /aria-invalid="true"/);
  assert.match(markup, /aria-describedby="configuration-error-/);
  assert.match(markup, /data-configuration-first-invalid/);
  assert.match(markup, /role="status"[^>]+aria-live="polite"/);
  assert.match(markup, /<button type="submit"(?![^>]*disabled)/);
  assert.match(markup, /请输入整数/);
});

test("invalid select edits remain visible instead of bouncing to the persisted option", () => {
  let state = createConfigurationFormState(configurationWithCredentialReferences());
  state = setConfigurationFormField(state, {
    path: ["brainProviders", "ollama", "kind"],
    kind: "text",
    rawValue: "future-provider",
  });
  const markup = renderConfigurationSettingsSkeleton({ state });

  assert.match(
    markup,
    /<option value="future-provider" selected data-configuration-invalid-option>无效：future-provider<\/option>/,
  );
});

test("scalar condition controls declare lossless controller edit kinds", () => {
  let state = createConfigurationFormState(configurationWithScalarConditions());
  const cases = [
    { index: 0, kind: "scalar", rawValue: "null", expected: null },
    { index: 1, kind: "text", rawValue: "next text", expected: "next text" },
    { index: 2, kind: "number", rawValue: "2.75", expected: 2.75 },
    { index: 3, kind: "boolean", rawValue: false, expected: false },
  ];
  const markup = renderConfigurationSettingsSkeleton({ state });

  for (const entry of cases) {
    const path = [
      "workflowRouting",
      "rules",
      0,
      "condition",
      "values",
      entry.index,
    ];
    const control = controlForPath(markup, path);
    assert.match(
      control,
      new RegExp(`data-configuration-edit-kind="${entry.kind}"`),
      path.join("."),
    );
    state = setConfigurationFormField(state, {
      path,
      kind: entry.kind,
      rawValue: entry.rawValue,
    });
  }

  const result = configurationDocumentFromForm(state);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.configuration.workflowRouting.rules[0].condition.values,
    cases.map(({ expected }) => expected),
  );
  assert.match(markup, /data-configuration-template-scalar-type/);
  for (const type of ["null", "string", "number", "boolean"]) {
    assert.match(markup, new RegExp(`<option value="${type}"`));
  }
  assert.match(markup, /data-configuration-template-scalar-value/);
});

test("router-backed brain references render accessible configured provider selects", () => {
  const configuration = configurationWithRemoteBrains();
  const initial = createConfigurationFormState(configuration);
  assert.equal(configurationDocumentFromForm(initial).ok, true);
  const markup = renderConfigurationSettingsSkeleton({ state: initial });
  const paths = [
    ["employees", "roles", "developer", "brain", "provider"],
    ["memory", "answering", "brain", "provider"],
    ["memory", "answering", "localBrain", "provider"],
  ];

  for (const path of paths) {
    const select = selectForPath(markup, path);
    assert.match(select, /<option value="ollama">ollama<\/option>/);
    assert.match(
      select,
      /<option value="remote\.openai" selected>remote\.openai<\/option>/,
    );
    assert.match(select, /name="\[&quot;/);
    assert.match(
      markup,
      new RegExp(`<label[^>]+for="${escapeRegExp(controlId(path))}"`),
    );
  }

  const invalid = setConfigurationFormField(initial, {
    path: ["employees", "roles", "developer", "brain", "provider"],
    kind: "text",
    rawValue: "missing-provider",
  });
  const invalidMarkup = renderConfigurationSettingsSkeleton({ state: invalid });
  assert.match(
    selectForPath(invalidMarkup, ["employees", "roles", "developer", "brain", "provider"]),
    /<option value="missing-provider" selected data-configuration-invalid-option>无效：missing-provider<\/option>/,
  );

  for (const path of [
    ["brain", "provider"],
    ["employees", "prReviewer", "brain", "provider"],
  ]) {
    controlForPath(markup, path);
    const select = selectForPath(markup, path);
    assert.match(select, /<option value="ollama" selected>ollama<\/option>/);
    assert.doesNotMatch(select, /remote\.openai/);
  }
});

function configurationFormPathAttribute(path) {
  return JSON.stringify(path)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function controlForPath(markup, path) {
  const encoded = escapeRegExp(configurationFormPathAttribute(path.map(String)));
  const match = markup.match(
    new RegExp(`<(?:input|select)[^>]*data-configuration-field="${encoded}"[^>]*>`),
  );
  assert.ok(match, `missing control for ${path.join(".")}`);
  return match[0];
}

function selectForPath(markup, path) {
  const encoded = escapeRegExp(configurationFormPathAttribute(path.map(String)));
  const match = markup.match(
    new RegExp(`<select[^>]*data-configuration-field="${encoded}"[^>]*>[\\s\\S]*?<\\/select>`),
  );
  assert.ok(match, `missing select for ${path.join(".")}`);
  return match[0];
}

function controlId(path) {
  return `configuration-field-${encodeURIComponent(JSON.stringify(path.map(String))).replaceAll("%", "_")}`;
}
