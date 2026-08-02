import assert from "node:assert/strict";
import test from "node:test";
import {
  StructuredBrainContractError,
  WORK_DECISION_JSON_SCHEMA,
  parseStructuredWorkDecision,
} from "../src/domain/structured-brain-contract.js";

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "当前工作已经完成。",
    intent: {
      schemaVersion: 1,
      type: "complete",
      summary: "无需继续处理。",
      reason: "验收条件已经满足。",
      outcome: "done",
      evidence: ["本地验证通过"],
    },
    ...overrides,
  };
}

test("the structured brain schema is finite and parses one exact WorkDecision", () => {
  const parsed = parseStructuredWorkDecision(JSON.stringify(decision()));

  assert.deepEqual(parsed, decision());
  assert.equal(WORK_DECISION_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(WORK_DECISION_JSON_SCHEMA.required, [
    "schemaVersion",
    "confidence",
    "summary",
    "intent",
  ]);
  assert.equal(WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.length, 6);
  assert.equal(Object.isFrozen(WORK_DECISION_JSON_SCHEMA), true);
  assert.equal(
    WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.every(
      (variant) => variant.additionalProperties === false,
    ),
    true,
  );

  const askUser = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(
    ({ properties }) => properties.type.const === "ask_user",
  );
  const waitCondition = WORK_DECISION_JSON_SCHEMA.properties.intent.oneOf.find(
    ({ properties }) => properties.type.const === "wait_condition",
  );
  const choiceId = askUser.properties.choices.items.properties.id;
  const workflowFact = waitCondition.properties.condition.oneOf.find(
    ({ properties }) => properties.kind.const === "workflow_fact",
  );
  const time = waitCondition.properties.condition.oneOf.find(
    ({ properties }) => properties.kind.const === "time",
  );
  assert.equal(new RegExp(choiceId.pattern).test("more_details"), false);
  assert.equal(new RegExp(choiceId.pattern).test("more-details"), true);
  assert.equal(workflowFact.properties.oneOf.uniqueItems, true);
  assert.equal(time.properties.notBefore.format, "date-time");
  assert.equal(
    WORK_DECISION_JSON_SCHEMA.properties.summary.maxLength,
    1_024,
  );
});

test("parsing rejects wrappers, extra fields, invalid variants, and oversized text", () => {
  assert.throws(
    () => parseStructuredWorkDecision(`\`\`\`json\n${JSON.stringify(decision())}\n\`\`\``),
    (error) =>
      error instanceof StructuredBrainContractError &&
      error.code === "STRUCTURED_BRAIN_RESPONSE_INVALID",
  );
  assert.throws(
    () =>
      parseStructuredWorkDecision(
        JSON.stringify({ ...decision(), unexpected: "model-controlled" }),
      ),
    /structured brain response is invalid/i,
  );
  assert.throws(
    () =>
      parseStructuredWorkDecision(
        JSON.stringify(
          decision({ intent: { ...decision().intent, type: "run_shell" } }),
        ),
      ),
    /structured brain response is invalid/i,
  );
  assert.throws(
    () => parseStructuredWorkDecision("x".repeat(1_025), { maximumBytes: 1_024 }),
    (error) => error.code === "STRUCTURED_BRAIN_RESPONSE_TOO_LARGE",
  );
});

test("contract errors never echo model output", () => {
  const sensitiveOutput = "secret-response-material";
  assert.throws(
    () => parseStructuredWorkDecision(sensitiveOutput),
    (error) =>
      error.code === "STRUCTURED_BRAIN_RESPONSE_INVALID" &&
      !error.message.includes(sensitiveOutput),
  );
});
