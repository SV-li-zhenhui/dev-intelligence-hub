import { createHash } from "node:crypto";
import { normalizeWorkflowEvent } from "./workflow-events.js";

export const OWNER_WORK_REQUEST_EVENT_TYPE = "owner_request.created";
export const OWNER_WORK_REQUEST_DEFAULT_RULE_ID =
  "system-owner-request-to-orchestrator";
export const OWNER_WORK_REQUEST_TYPES = Object.freeze([
  "general",
  "requirements",
  "development",
  "testing",
  "pull_request",
]);
export const OWNER_WORK_REQUEST_PRIORITIES = Object.freeze([
  "normal",
  "high",
  "urgent",
]);

const REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "requestId",
  "workType",
  "priority",
  "title",
  "description",
  "acceptanceCriteria",
]);
const REQUEST_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_TITLE_BYTES = 256;
const MAX_DESCRIPTION_BYTES = 12 * 1024;
const MAX_CRITERIA = 20;
const MAX_CRITERION_BYTES = 1_000;

export class OwnerWorkRequestError extends Error {
  constructor(code, message, statusCode = 400, options = {}) {
    super(message, options);
    this.name = "OwnerWorkRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid(message = "所有者工作请求无效") {
  return new OwnerWorkRequestError(
    "OWNER_WORK_REQUEST_INVALID",
    message,
  );
}

function dataKeys(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${label}必须是普通对象`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${label}包含不安全字段`);
    }
  }
  return keys;
}

function exactKeys(value, expected, label) {
  const keys = dataKeys(value, label);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw invalid(`${label}字段无效`);
  }
}

function boundedText(value, label, maximumBytes) {
  if (typeof value !== "string" || INVALID_CONTROL.test(value)) {
    throw invalid(`${label}无效`);
  }
  const normalized = value.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (!normalized || bytes > maximumBytes) {
    throw invalid(`${label}无效`);
  }
  return normalized;
}

function denseArray(value, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_CRITERIA ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${label}无效`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${label}无效`);
    }
  }
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function ownerWorkRequestDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function normalizeOwnerWorkRequest(value) {
  exactKeys(value, REQUEST_KEYS, "所有者工作请求");
  if (
    value.schemaVersion !== 1 ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId) ||
    !OWNER_WORK_REQUEST_TYPES.includes(value.workType) ||
    !OWNER_WORK_REQUEST_PRIORITIES.includes(value.priority)
  ) {
    throw invalid();
  }
  const acceptanceCriteria = denseArray(
    value.acceptanceCriteria,
    "acceptanceCriteria",
  ).map((criterion) =>
    boundedText(criterion, "acceptanceCriteria 条目", MAX_CRITERION_BYTES)
  );
  if (new Set(acceptanceCriteria).size !== acceptanceCriteria.length) {
    throw invalid("acceptanceCriteria 不能重复");
  }
  return deepFreeze({
    schemaVersion: 1,
    requestId: value.requestId,
    workType: value.workType,
    priority: value.priority,
    title: boundedText(value.title, "title", MAX_TITLE_BYTES),
    description: boundedText(
      value.description,
      "description",
      MAX_DESCRIPTION_BYTES,
    ),
    acceptanceCriteria,
  });
}

export function createOwnerWorkRequestEvent(requestValue, occurredAt) {
  const request = normalizeOwnerWorkRequest(requestValue);
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: OWNER_WORK_REQUEST_EVENT_TYPE,
    occurredAt,
    source: {
      provider: "local-owner",
      scopeId: "owner-command-center",
    },
    subject: {
      id: `owner-request:${request.requestId}`,
      requestId: request.requestId,
    },
    payload: {
      title: request.title,
      description: request.description,
      workType: request.workType,
      priority: request.priority,
      acceptanceCriteria: [...request.acceptanceCriteria],
    },
  });
}

export function withOwnerWorkRequestDefaultRoute(definition) {
  const rules = Array.isArray(definition?.rules)
    ? definition.rules.filter(
        (rule) => rule?.id !== OWNER_WORK_REQUEST_DEFAULT_RULE_ID,
      )
    : definition?.rules;
  return {
    ...definition,
    rules: [
      {
        id: OWNER_WORK_REQUEST_DEFAULT_RULE_ID,
        source: "root",
        enabled: true,
        priority: 10_000,
        fallback: false,
        condition: {
          op: "equals",
          path: "eventType",
          value: OWNER_WORK_REQUEST_EVENT_TYPE,
        },
        targets: [{ type: "role", id: "orchestrator" }],
        onMatch: "stop",
      },
      ...rules,
    ],
  };
}
