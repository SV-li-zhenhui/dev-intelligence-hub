import assert from "node:assert/strict";
import test from "node:test";
import {
  configurationFieldEdit,
  configurationTemplateValue,
} from "../public/configuration-form-controller.js";

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
