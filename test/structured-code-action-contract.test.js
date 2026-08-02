import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_ACTION_DECISION_JSON_SCHEMA,
  normalizeStructuredCodeActionDecision,
  parseStructuredCodeActionDecision,
  StructuredCodeActionError,
} from "../src/domain/structured-code-action-contract.js";

function decision(action, overrides = {}) {
  return {
    schemaVersion: 1,
    confidence: 87,
    summary: "Inspect the relevant implementation.",
    reason: "The current evidence is not sufficient to modify a file.",
    action,
    ...overrides,
  };
}

function assertInvalid(operation, code = "STRUCTURED_CODE_ACTION_INVALID") {
  assert.throws(
    operation,
    (error) => error instanceof StructuredCodeActionError && error.code === code,
  );
}

test("the brain can choose only semantic actions without trusted execution fields", () => {
  const values = [
    decision({ type: "list_files", path: "" }),
    decision({ type: "read_text", path: "src/app.js" }),
    decision({ type: "search_text", path: "src", query: "TODO" }),
    decision({ type: "write_text", path: "src/app.js", content: "" }),
    decision({ type: "run_profile" }),
    decision({
      type: "complete",
      outcome: "The requested change and checks are complete.",
      evidence: ["node-tests passed"],
    }),
  ];

  for (const value of values) {
    assert.deepEqual(
      parseStructuredCodeActionDecision(JSON.stringify(value)),
      value,
    );
    for (const forbidden of [
      "sessionId",
      "actionId",
      "expectedWorkspaceRevision",
      "expectedSha256",
      "profileId",
      "command",
      "env",
    ]) {
      assert.equal(JSON.stringify(value).includes(`\"${forbidden}\"`), false);
      assert.equal(JSON.stringify(CODE_ACTION_DECISION_JSON_SCHEMA).includes(`\"${forbidden}\"`), false);
    }
  }
});

test("unknown actions and capability-bearing fields fail closed", () => {
  const invalid = [
    decision({ type: "shell", command: "npm test" }),
    decision({ type: "read_text", path: "src/app.js", sessionId: "session-1" }),
    decision({
      type: "write_text",
      path: "src/app.js",
      content: "x",
      expectedSha256: "a".repeat(64),
    }),
    decision({ type: "run_profile", profileId: "node-tests" }),
  ];
  for (const value of invalid) {
    assertInvalid(() => normalizeStructuredCodeActionDecision(value));
  }
});

test("the parser enforces exact data objects, text limits, and response limits", () => {
  assertInvalid(() =>
    normalizeStructuredCodeActionDecision({
      ...decision({ type: "list_files", path: "" }),
      extra: true,
    }),
  );
  assertInvalid(() =>
    normalizeStructuredCodeActionDecision(
      Object.assign(Object.create({ inherited: true }), decision({
        type: "list_files",
        path: "",
      })),
    ),
  );
  assertInvalid(() =>
    normalizeStructuredCodeActionDecision(
      decision({ type: "search_text", path: "", query: "bad\u0000query" }),
    ),
  );
  assertInvalid(
    () =>
      parseStructuredCodeActionDecision(
        JSON.stringify(decision({ type: "read_text", path: "src/app.js" })),
        { maximumBytes: 4 },
      ),
    "STRUCTURED_CODE_ACTION_TOO_LARGE",
  );
});

test("completion evidence is bounded and unique", () => {
  assertInvalid(() =>
    normalizeStructuredCodeActionDecision(
      decision({
        type: "complete",
        outcome: "done",
        evidence: ["same", "same"],
      }),
    ),
  );
  assert.equal(
    normalizeStructuredCodeActionDecision(
      decision({ type: "complete", outcome: "done", evidence: [] }),
    ).action.outcome,
    "done",
  );
});
