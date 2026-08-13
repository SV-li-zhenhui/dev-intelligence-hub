import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  bindConfigurationFormController,
  configurationFieldEdit,
  configurationPullRequestWindowOperation,
  configurationTemplateValue,
} from "../public/configuration-form-controller.js";
import {
  configurationDocumentFromForm,
  createConfigurationFormState,
} from "../public/configuration-form-support.js";
import { renderConfigurationSettingsSkeleton } from "../public/settings-view.js";

const currentConfigurationText = await readFile(
  new URL("../config.example.json", import.meta.url),
  "utf8",
);

function credentialConfiguration(mode) {
  const configuration = JSON.parse(currentConfigurationText);
  configuration.githubActions = {
    enabled: true,
    credentialMode: mode,
    actorAccountId: "runtime-user",
    ghCommand: process.execPath,
    ...(mode === "token-env" ? { tokenEnv: "MYDASHBOARD_GITHUB_TOKEN" } : {}),
  };
  return configuration;
}

function selectControl(value) {
  return {
    tagName: "SELECT",
    type: "select-one",
    value,
    checked: false,
    dataset: {
      configurationField: JSON.stringify(["githubActions", "credentialMode"]),
      configurationEditKind: "text",
    },
    ownerDocument: { getElementById: () => null },
    getAttribute: () => null,
    removeAttribute() {},
    setAttribute() {},
  };
}

function credentialModeController(configuration) {
  let state = createConfigurationFormState(configuration);
  const listeners = new Map();
  const changes = [];
  const root = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    contains: () => true,
  };
  bindConfigurationFormController({
    root,
    getState: () => state,
    onStateChange(nextState, options) {
      state = nextState;
      changes.push({
        options,
        markup: options.render ? renderConfigurationSettingsSkeleton({ state }) : null,
      });
    },
    onInvalidate() {},
    onError(message) { throw new Error(message); },
  });
  return {
    change(mode) {
      listeners.get("change")({ target: selectControl(mode) });
      return changes.at(-1);
    },
    document() { return configurationDocumentFromForm(state); },
  };
}

test("field controls produce immutable typed edits without coercing invalid text", () => {
  const path = ["workflowRouting", "rules", "0", "priority"];
  const numberEdit = configurationFieldEdit({
    dataset: {
      configurationField: JSON.stringify(path),
      configurationEditKind: "integer",
    },
    value: "not-an-integer",
    checked: false,
  });
  assert.deepEqual(numberEdit, {
    path,
    kind: "integer",
    rawValue: "not-an-integer",
  });
  assert.equal(Object.isFrozen(numberEdit), true);
  assert.equal(Object.isFrozen(numberEdit.path), true);

  assert.deepEqual(
    configurationFieldEdit({
      dataset: {
        configurationField: JSON.stringify(["memory", "enabled"]),
        configurationEditKind: "boolean",
      },
      value: "on",
      checked: false,
    }),
    {
      path: ["memory", "enabled"],
      kind: "boolean",
      rawValue: false,
    },
  );
});

test("typed template fields preserve map, array and every scalar type", () => {
  const seed = {
    id: "new-entry",
    values: ["value", 0, false, null],
    nested: { provider: "ollama" },
  };
  const rootPath = ["workflowRouting", "rules", "0"];
  const result = configurationTemplateValue(seed, rootPath, [
    { path: [...rootPath, "id"], kind: "text", rawValue: "exact-entry" },
    { path: [...rootPath, "values", "0"], kind: "text", rawValue: "plain" },
    { path: [...rootPath, "values", "1"], kind: "number", rawValue: "2.75" },
    { path: [...rootPath, "values", "2"], kind: "boolean", rawValue: true },
    { path: [...rootPath, "values", "3"], kind: "scalar", rawValue: "null" },
    {
      path: [...rootPath, "nested", "provider"],
      kind: "text",
      rawValue: "remote.openai",
    },
  ]);

  assert.deepEqual(result, {
    id: "exact-entry",
    values: ["plain", 2.75, true, null],
    nested: { provider: "remote.openai" },
  });
  assert.deepEqual(seed, {
    id: "new-entry",
    values: ["value", 0, false, null],
    nested: { provider: "ollama" },
  });
});

test("template collection fails closed on invalid values and paths outside its root", () => {
  assert.throws(
    () =>
      configurationTemplateValue({ value: 1 }, ["items", "0"], [
        {
          path: ["items", "0", "value"],
          kind: "number",
          rawValue: "not-a-number",
        },
      ]),
    /valid number|有效数字/i,
  );
  assert.throws(
    () =>
      configurationTemplateValue({ value: "safe" }, ["items", "0"], [
        {
          path: ["other", "0", "value"],
          kind: "text",
          rawValue: "escaped",
        },
      ]),
    /root|范围/i,
  );
});

test("credential mode select changes rerender dependent Token fields without migrating legacy mode", () => {
  const tokenEnv = credentialModeController(credentialConfiguration("token-env"));
  const ghLoginChange = tokenEnv.change("gh-login");
  assert.equal(ghLoginChange.options.render, true);
  assert.doesNotMatch(ghLoginChange.markup, /GitHub Token 环境变量/);
  assert.equal(
    Object.hasOwn(tokenEnv.document().configuration.githubActions, "tokenEnv"),
    false,
  );

  const ghLogin = credentialModeController(credentialConfiguration("gh-login"));
  const tokenEnvChange = ghLogin.change("token-env");
  assert.equal(tokenEnvChange.options.render, true);
  assert.match(tokenEnvChange.markup, /GitHub Token 环境变量/);
  assert.match(
    tokenEnvChange.markup,
    /data-configuration-field="\[&quot;githubActions&quot;,&quot;tokenEnv&quot;\]"/,
  );
  assert.equal(ghLogin.document().ok, true);
  assert.equal(
    Object.hasOwn(ghLogin.document().configuration.githubActions, "tokenEnv"),
    true,
  );

  const legacy = JSON.parse(currentConfigurationText);
  delete legacy.githubActions.credentialMode;
  const unrelated = credentialModeController(legacy);
  assert.equal(
    Object.hasOwn(unrelated.document().configuration.githubActions, "credentialMode"),
    false,
  );
});

test("PR window controller converts local fixed dates before creating a slot operation", () => {
  const values = new Map([
    ["[data-configuration-pr-window-mode]", "fixed"],
    ["[data-configuration-pr-window-days]", "7"],
    ["[data-configuration-pr-window-from]", "20260801"],
    ["[data-configuration-pr-window-through]", "20260812"],
    ["[data-configuration-pr-window-time-zone]", "Asia/Shanghai"],
  ]);
  const operation = configurationPullRequestWindowOperation({
    dataset: { configurationPrWindowExisting: "false" },
    querySelector(selector) {
      return values.has(selector) ? { value: values.get(selector) } : null;
    },
  });
  assert.deepEqual(operation, {
    operation: "add",
    path: ["githubRead", "pullRequestUpdatedWindow"],
    value: {
      mode: "fixed",
      fromInclusive: "2026-07-31T16:00:00.000Z",
      untilExclusive: "2026-08-12T16:00:00.000Z",
      timeZone: "Asia/Shanghai",
    },
  });
});

test("bound PR window Apply action updates form state and requests a rerender", () => {
  let state = createConfigurationFormState(JSON.parse(currentConfigurationText));
  const listeners = new Map();
  const values = new Map([
    ["[data-configuration-pr-window-mode]", "rolling"],
    ["[data-configuration-pr-window-days]", "7"],
    ["[data-configuration-pr-window-from]", ""],
    ["[data-configuration-pr-window-through]", ""],
    ["[data-configuration-pr-window-time-zone]", "Asia/Shanghai"],
  ]);
  const container = {
    dataset: { configurationPrWindowExisting: "false" },
    querySelector(selector) {
      return values.has(selector) ? { value: values.get(selector) } : null;
    },
  };
  const button = {
    closest(selector) {
      if (selector === "[data-configuration-pr-window-apply]") return button;
      if (selector === "[data-configuration-pr-window]") return container;
      return null;
    },
  };
  let changeOptions = null;
  let invalidations = 0;
  const root = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    contains: () => true,
  };
  bindConfigurationFormController({
    root,
    getState: () => state,
    onStateChange(nextState, options) {
      state = nextState;
      changeOptions = options;
    },
    onInvalidate() { invalidations += 1; },
    onError(message) { throw new Error(message); },
  });

  listeners.get("click")({ target: button });

  assert.deepEqual(
    configurationDocumentFromForm(state).configuration.githubRead.pullRequestUpdatedWindow,
    { mode: "rolling", days: 7 },
  );
  assert.equal(changeOptions.render, true);
  assert.equal(invalidations, 1);
});

test("form submit captures dirty PR window controls before the save listener runs", () => {
  let state = createConfigurationFormState(JSON.parse(currentConfigurationText));
  const listeners = new Map();
  const values = new Map([
    ["[data-configuration-pr-window-mode]", "rolling"],
    ["[data-configuration-pr-window-days]", "30"],
    ["[data-configuration-pr-window-from]", ""],
    ["[data-configuration-pr-window-through]", ""],
    ["[data-configuration-pr-window-time-zone]", "Asia/Shanghai"],
  ]);
  const container = {
    dataset: {
      configurationPrWindowExisting: "false",
      configurationPrWindowDirty: "true",
    },
    querySelector(selector) {
      return values.has(selector) ? { value: values.get(selector) } : null;
    },
  };
  const root = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    contains: () => true,
    querySelector: () => container,
  };
  bindConfigurationFormController({
    root,
    getState: () => state,
    onStateChange(nextState) { state = nextState; },
    onInvalidate() {},
    onError(message) { throw new Error(message); },
  });
  let prevented = false;
  listeners.get("submit")({
    preventDefault() { prevented = true; },
    stopImmediatePropagation() {},
  });

  assert.equal(prevented, false);
  assert.deepEqual(
    configurationDocumentFromForm(state).configuration.githubRead.pullRequestUpdatedWindow,
    { mode: "rolling", days: 30 },
  );
});
