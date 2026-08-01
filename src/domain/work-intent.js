import { createHash } from "node:crypto";

const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const INTENT_TYPES = new Set([
  "ask_user",
  "wait_condition",
  "propose_github_review",
  "propose_code_action",
  "handoff",
  "complete",
]);
const REVIEW_VERDICTS = new Set(["approve", "request_changes", "comment"]);
const CODE_OPERATIONS = new Set(["inspect", "modify", "verify"]);
const HANDOFF_CAPABILITIES = new Set([
  "coordination",
  "requirements",
  "pr-review",
  "development",
  "testing",
]);
const COMPLETE_OUTCOMES = new Set(["done", "no-action"]);
const MAX_INTENT_BYTES = 64 * 1024;

export class WorkIntentError extends Error {
  constructor(message = "员工工作意图无效") {
    super(message);
    this.name = "WorkIntentError";
    this.code = "WORK_INTENT_INVALID";
    this.statusCode = 400;
  }
}

function invalid(message) {
  throw new WorkIntentError(message);
}

function plainDataEntries(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid();
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      invalid();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactObject(value, keys) {
  const entries = plainDataEntries(value);
  const actual = entries.map(([key]) => key);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  ) {
    invalid();
  }
  return new Map(entries);
}

function plainArray(value, maximum) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    invalid();
  }
  const expected = Array.from({ length: value.length }, (_, index) => `${index}`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length + 1 ||
    !keys.includes("length") ||
    expected.some((key) => !keys.includes(key))
  ) {
    invalid();
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
  }
  return value;
}

function text(value, name, maximum, { empty = false } = {}) {
  if (
    typeof value !== "string" ||
    INVALID_CONTROL.test(value) ||
    (!empty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function token(value, name) {
  const normalized = text(value, name, 64);
  if (!SAFE_TOKEN.test(normalized)) invalid(`${name} 无效`);
  return normalized;
}

function stringList(value, name, maximumItems, maximumBytes, { empty = true } = {}) {
  const entries = plainArray(value, maximumItems).map((entry) =>
    text(entry, name, maximumBytes, { empty: false }),
  );
  if (!empty && entries.length === 0) invalid(`${name} 不能为空`);
  return entries;
}

function common(value, expectedKeys) {
  const entries = exactObject(value, expectedKeys);
  if (entries.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const type = entries.get("type");
  if (!INTENT_TYPES.has(type)) invalid("type 无效");
  return {
    schemaVersion: 1,
    type,
    summary: text(entries.get("summary"), "summary", 2_048),
    reason: text(entries.get("reason"), "reason", 4_096),
  };
}

function normalizeChoices(value) {
  const choices = plainArray(value, 8).map((choice) => {
    const entries = exactObject(choice, ["id", "label", "description"]);
    return {
      id: token(entries.get("id"), "choice.id"),
      label: text(entries.get("label"), "choice.label", 256),
      description: text(
        entries.get("description"),
        "choice.description",
        1_024,
        { empty: true },
      ),
    };
  });
  if (new Set(choices.map(({ id }) => id)).size !== choices.length) {
    invalid("choice.id 重复");
  }
  return choices;
}

function normalizeCondition(value) {
  const typeEntries = plainDataEntries(value);
  const kindEntry = typeEntries.find(([key]) => key === "kind");
  const kind = kindEntry?.[1];
  if (kind === "time") {
    const entries = exactObject(value, ["kind", "notBefore"]);
    const notBefore = text(entries.get("notBefore"), "notBefore", 64);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(notBefore) ||
      !Number.isFinite(Date.parse(notBefore)) ||
      new Date(Date.parse(notBefore)).toISOString() !== notBefore
    ) {
      invalid("notBefore 无效");
    }
    return { kind: "time", notBefore };
  }
  if (kind === "workflow_fact") {
    const entries = exactObject(value, ["kind", "fact", "oneOf"]);
    const oneOf = stringList(entries.get("oneOf"), "condition.oneOf", 16, 256, {
      empty: false,
    });
    if (new Set(oneOf).size !== oneOf.length) invalid("condition.oneOf 重复");
    return {
      kind: "workflow_fact",
      fact: token(entries.get("fact"), "condition.fact"),
      oneOf,
    };
  }
  invalid("condition.kind 无效");
}

function normalizeEvidence(value) {
  return stringList(value, "evidence", 20, 2_048);
}

function normalizeIntentVariant(value) {
  const typeEntries = plainDataEntries(value);
  const type = typeEntries.find(([key]) => key === "type")?.[1];
  switch (type) {
    case "ask_user": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "question",
        "choices",
      ];
      const entries = exactObject(value, keys);
      return {
        ...common(value, keys),
        question: text(entries.get("question"), "question", 4_096),
        choices: normalizeChoices(entries.get("choices")),
      };
    }
    case "wait_condition": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "condition",
        "checkAfterSeconds",
      ];
      const entries = exactObject(value, keys);
      const checkAfterSeconds = entries.get("checkAfterSeconds");
      if (
        !Number.isSafeInteger(checkAfterSeconds) ||
        checkAfterSeconds < 30 ||
        checkAfterSeconds > 86_400
      ) {
        invalid("checkAfterSeconds 无效");
      }
      return {
        ...common(value, keys),
        condition: normalizeCondition(entries.get("condition")),
        checkAfterSeconds,
      };
    }
    case "propose_github_review": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "verdict",
        "body",
        "evidence",
      ];
      const entries = exactObject(value, keys);
      const verdict = entries.get("verdict");
      if (!REVIEW_VERDICTS.has(verdict)) invalid("verdict 无效");
      return {
        ...common(value, keys),
        verdict,
        body: text(entries.get("body"), "body", 32 * 1024),
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "propose_code_action": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "operation",
        "objective",
        "acceptanceCriteria",
        "evidence",
      ];
      const entries = exactObject(value, keys);
      const operation = entries.get("operation");
      if (!CODE_OPERATIONS.has(operation)) invalid("operation 无效");
      return {
        ...common(value, keys),
        operation,
        objective: text(entries.get("objective"), "objective", 4_096),
        acceptanceCriteria: stringList(
          entries.get("acceptanceCriteria"),
          "acceptanceCriteria",
          20,
          2_048,
          { empty: false },
        ),
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "handoff": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "capability",
        "brief",
        "evidence",
      ];
      const entries = exactObject(value, keys);
      const capability = entries.get("capability");
      if (!HANDOFF_CAPABILITIES.has(capability)) invalid("capability 无效");
      return {
        ...common(value, keys),
        capability,
        brief: text(entries.get("brief"), "brief", 4_096),
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "complete": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "outcome",
        "evidence",
      ];
      const entries = exactObject(value, keys);
      const outcome = entries.get("outcome");
      if (!COMPLETE_OUTCOMES.has(outcome)) invalid("outcome 无效");
      return {
        ...common(value, keys),
        outcome,
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    default:
      invalid("type 无效");
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function normalizeWorkIntent(value) {
  const intent = normalizeIntentVariant(value);
  if (Buffer.byteLength(JSON.stringify(intent), "utf8") > MAX_INTENT_BYTES) {
    invalid("员工工作意图过大");
  }
  return intent;
}

export function normalizeWorkDecision(value) {
  const entries = exactObject(value, [
    "schemaVersion",
    "confidence",
    "summary",
    "intent",
  ]);
  if (entries.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const confidence = entries.get("confidence");
  if (!Number.isSafeInteger(confidence) || confidence < 0 || confidence > 100) {
    invalid("confidence 无效");
  }
  return {
    schemaVersion: 1,
    confidence,
    summary: text(entries.get("summary"), "decision.summary", 4_096),
    intent: normalizeWorkIntent(entries.get("intent")),
  };
}

export function workIntentDigest(value) {
  const intent = normalizeWorkIntent(value);
  return createHash("sha256")
    .update(JSON.stringify(stableValue(intent)), "utf8")
    .digest("hex");
}
