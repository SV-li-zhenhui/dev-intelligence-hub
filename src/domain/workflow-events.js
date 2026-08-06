import { createHash } from "node:crypto";
import { normalizePullRequestGitTarget } from "./git-tool-contract.js";

const SCHEMA_VERSION = 1;
const SUBJECT_KINDS = Object.freeze(["pull_request", "issue"]);
const EVENT_NAMES = Object.freeze([
  "observed",
  "created",
  "updated",
  "completed",
  "left_scope",
  "classified",
  "status",
]);
const EVENT_TYPES = new Set(
  SUBJECT_KINDS.flatMap((kind) =>
    EVENT_NAMES.map((eventName) => `${kind}.${eventName}`),
  ),
);
const BASE_KEYS = Object.freeze([
  "schemaVersion",
  "eventType",
  "occurredAt",
  "source",
  "subject",
  "payload",
]);
const STORED_KEYS = Object.freeze([
  "schemaVersion",
  "eventId",
  "contentDigest",
  "eventType",
  "occurredAt",
  "source",
  "subject",
  "payload",
]);
const SOURCE_KEYS = Object.freeze(["provider", "scopeId"]);
const SUBJECT_KEYS = Object.freeze(["id", "repository", "number"]);
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const IDENTIFIER_CONTROL = /\p{Cc}/u;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PAYLOAD_FIELDS = new Set([
  "actionState",
  "assignee",
  "assignees",
  "assignmentSource",
  "author",
  "changedFields",
  "ciStatus",
  "confidence",
  "createdAt",
  "description",
  "draft",
  "evidence",
  "files",
  "gitTarget",
  "gitTargetAvailable",
  "headRefOid",
  "inactiveDays",
  "isDraft",
  "issueType",
  "labels",
  "mergeStateStatus",
  "milestone",
  "myReviewCommitOid",
  "myReviewState",
  "nextAction",
  "nextActor",
  "number",
  "previousHeadRefOid",
  "previousState",
  "pullRequestType",
  "relation",
  "requiresConfirmation",
  "reviewDecision",
  "reviewFactsAvailable",
  "riskLevel",
  "riskScore",
  "state",
  "summary",
  "title",
  "tokenCount",
  "updatedAt",
]);
const FILE_FACT_FIELDS = new Set([
  "additions",
  "deletions",
  "path",
  "previousPath",
  "status",
]);
const STRING_PAYLOAD_FIELDS = new Set([
  "actionState",
  "assignee",
  "assignmentSource",
  "author",
  "ciStatus",
  "createdAt",
  "description",
  "headRefOid",
  "issueType",
  "mergeStateStatus",
  "milestone",
  "myReviewCommitOid",
  "myReviewState",
  "nextAction",
  "nextActor",
  "previousHeadRefOid",
  "previousState",
  "pullRequestType",
  "relation",
  "reviewDecision",
  "riskLevel",
  "state",
  "summary",
  "title",
  "updatedAt",
]);
const BOOLEAN_PAYLOAD_FIELDS = new Set([
  "draft",
  "gitTargetAvailable",
  "isDraft",
  "requiresConfirmation",
  "reviewFactsAvailable",
]);
const NUMBER_PAYLOAD_FIELDS = new Set([
  "confidence",
  "inactiveDays",
  "number",
  "riskScore",
  "tokenCount",
]);
const STRING_ARRAY_PAYLOAD_FIELDS = new Set([
  "assignees",
  "changedFields",
  "evidence",
  "labels",
]);
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 16;
const MAX_PAYLOAD_ENTRIES = 1_000;
const MAX_CONTAINER_ENTRIES = 200;
const MAX_STRING_BYTES = 16 * 1024;

export const WORKFLOW_EVENT_TYPES = Object.freeze([...EVENT_TYPES]);

export class WorkflowEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowEventError";
    this.code = "INVALID_WORKFLOW_EVENT";
    this.statusCode = 400;
  }
}

function invalid(field = "event") {
  return new WorkflowEventError(`工作流事件无效：${field}`);
}

function normalize(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof WorkflowEventError) throw error;
    throw invalid();
  }
}

function ownDataKeys(value, field) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(field);
  }

  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      throw invalid(field);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(field);
    }
  }
  return keys;
}

function assertExactKeys(value, expected, field) {
  const keys = ownDataKeys(value, field);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw invalid(field);
  }
  return value;
}

function boundedString(
  value,
  field,
  { minimumBytes = 1, maximumBytes = 512, pattern = null } = {},
) {
  if (typeof value !== "string" || INVALID_CONTROL.test(value)) {
    throw invalid(field);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (
    bytes < minimumBytes ||
    bytes > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw invalid(field);
  }
  return value;
}

function identifierString(value, field, maximumBytes) {
  const normalized = boundedString(value, field, { maximumBytes });
  if (IDENTIFIER_CONTROL.test(normalized) || !normalized.trim()) {
    throw invalid(field);
  }
  return normalized;
}

function normalizeTimestamp(value) {
  const timestamp = boundedString(value, "occurredAt", {
    maximumBytes: 24,
    pattern: ISO_TIMESTAMP,
  });
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  ) {
    throw invalid("occurredAt");
  }
  return timestamp;
}

function normalizeRepository(value) {
  const repository = boundedString(value, "subject.repository", {
    maximumBytes: 140,
    pattern: REPOSITORY,
  });
  const [, owner, name] = repository.match(REPOSITORY);
  if (
    owner.includes("--") ||
    name.includes("..") ||
    name.startsWith(".") ||
    name.endsWith(".")
  ) {
    throw invalid("subject.repository");
  }
  return repository;
}

function normalizeSource(value) {
  assertExactKeys(value, SOURCE_KEYS, "source");
  return {
    provider: boundedString(value.provider, "source.provider", {
      maximumBytes: 128,
      pattern: SAFE_TOKEN,
    }),
    scopeId: identifierString(value.scopeId, "source.scopeId", 256),
  };
}

function normalizeSubject(value) {
  assertExactKeys(value, SUBJECT_KEYS, "subject");
  if (!Number.isSafeInteger(value.number) || value.number < 1) {
    throw invalid("subject.number");
  }
  return {
    id: identifierString(value.id, "subject.id", 512),
    repository: normalizeRepository(value.repository),
    number: value.number,
  };
}

function assertPlainArray(value, field) {
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_CONTAINER_ENTRIES
  ) {
    throw invalid(field);
  }
  const expectedKeys = Array.from({ length: value.length }, (_, index) =>
    String(index),
  );
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length + 1 ||
    !keys.includes("length") ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw invalid(field);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(field);
    }
  }
  return expectedKeys;
}

function clonePayloadValue(value, context, field) {
  context.budget.entries += 1;
  if (context.budget.entries > MAX_PAYLOAD_ENTRIES) {
    throw invalid("payload 过大");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return boundedString(value, field, {
      minimumBytes: 0,
      maximumBytes: MAX_STRING_BYTES,
    });
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(field);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw invalid(field);
  if (context.depth >= MAX_PAYLOAD_DEPTH || context.ancestors.has(value)) {
    throw invalid("payload 嵌套过深或包含循环引用");
  }

  context.ancestors.add(value);
  const childContext = {
    depth: context.depth + 1,
    budget: context.budget,
    ancestors: context.ancestors,
  };
  try {
    if (Array.isArray(value)) {
      return assertPlainArray(value, field).map((key) => {
        const entry = Object.getOwnPropertyDescriptor(value, key).value;
        return clonePayloadValue(entry, childContext, `${field}[${key}]`);
      });
    }

    const keys = ownDataKeys(value, field);
    if (keys.length > MAX_CONTAINER_ENTRIES) throw invalid(field);
    const result = {};
    for (const key of keys.sort()) {
      const entry = Object.getOwnPropertyDescriptor(value, key).value;
      result[key] = clonePayloadValue(entry, childContext, `${field}.${key}`);
    }
    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

function assertPayloadShape(value) {
  const keys = ownDataKeys(value, "payload");
  for (const key of keys) {
    if (!PAYLOAD_FIELDS.has(key)) throw invalid(`payload.${key}`);
    const entry = Object.getOwnPropertyDescriptor(value, key).value;
    if (key !== "files") {
      if (entry === null) continue;
      if (STRING_PAYLOAD_FIELDS.has(key) && typeof entry !== "string") {
        throw invalid(`payload.${key}`);
      }
      if (BOOLEAN_PAYLOAD_FIELDS.has(key) && typeof entry !== "boolean") {
        throw invalid(`payload.${key}`);
      }
      if (
        NUMBER_PAYLOAD_FIELDS.has(key) &&
        (typeof entry !== "number" || !Number.isFinite(entry))
      ) {
        throw invalid(`payload.${key}`);
      }
      if (STRING_ARRAY_PAYLOAD_FIELDS.has(key)) {
        const indexes = assertPlainArray(entry, `payload.${key}`);
        if (
          indexes.some(
            (index) =>
              typeof Object.getOwnPropertyDescriptor(entry, index).value !==
              "string",
          )
        ) {
          throw invalid(`payload.${key}`);
        }
      }
      continue;
    }
    if (!Array.isArray(entry)) {
      if (typeof entry !== "string") throw invalid("payload.files");
      continue;
    }
    for (const index of assertPlainArray(entry, "payload.files")) {
      const item = Object.getOwnPropertyDescriptor(entry, index).value;
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        if (typeof item !== "string") {
          throw invalid(`payload.files[${index}]`);
        }
        continue;
      }
      const fileKeys = ownDataKeys(item, `payload.files[${index}]`);
      if (
        !fileKeys.includes("path") ||
        fileKeys.some((fileKey) => !FILE_FACT_FIELDS.has(fileKey))
      ) {
        throw invalid(`payload.files[${index}]`);
      }
      if (typeof Object.getOwnPropertyDescriptor(item, "path").value !== "string") {
        throw invalid(`payload.files[${index}].path`);
      }
      for (const fileKey of fileKeys) {
        const fileValue = Object.getOwnPropertyDescriptor(item, fileKey).value;
        if (
          fileValue !== null &&
          !["string", "number", "boolean"].includes(typeof fileValue)
        ) {
          throw invalid(`payload.files[${index}].${fileKey}`);
        }
      }
    }
  }
}

function normalizePayload(value) {
  assertPayloadShape(value);
  const normalized = clonePayloadValue(
    value,
    { depth: 0, budget: { entries: 0 }, ancestors: new Set() },
    "payload",
  );
  if (Object.hasOwn(normalized, "gitTarget")) {
    try {
      normalized.gitTarget = structuredClone(
        normalizePullRequestGitTarget(normalized.gitTarget),
      );
    } catch {
      throw invalid("payload.gitTarget");
    }
  }
  return normalized;
}

function normalizeContent(value) {
  assertExactKeys(value, BASE_KEYS, "event");
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw invalid("schemaVersion");
  }
  if (typeof value.eventType !== "string" || !EVENT_TYPES.has(value.eventType)) {
    throw invalid("eventType");
  }

  const content = {
    schemaVersion: SCHEMA_VERSION,
    eventType: value.eventType,
    occurredAt: normalizeTimestamp(value.occurredAt),
    source: normalizeSource(value.source),
    subject: normalizeSubject(value.subject),
    payload: normalizePayload(value.payload),
  };
  const hasGitTarget = Object.hasOwn(content.payload, "gitTarget");
  const hasGitTargetAvailability = Object.hasOwn(
    content.payload,
    "gitTargetAvailable",
  );
  if (
    hasGitTargetAvailability &&
    (content.payload.gitTargetAvailable !== hasGitTarget ||
      !content.eventType.startsWith("pull_request."))
  ) {
    throw invalid("payload.gitTargetAvailable");
  }
  if (
    hasGitTarget &&
    (
      content.payload.gitTargetAvailable !== true ||
      !content.eventType.startsWith("pull_request.") ||
      content.payload.gitTarget.baseRepository !== content.subject.repository ||
      content.payload.gitTarget.headRefOid !== content.payload.headRefOid ||
      [
        "githubAccount",
        "baseRepository",
        "baseRefName",
        "baseRefOid",
        "headRepository",
        "headRefName",
      ].some((field) => Object.hasOwn(content.payload, field))
    )
  ) {
    throw invalid("payload.gitTarget");
  }
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_EVENT_BYTES) {
    throw invalid("event 过大");
  }
  return content;
}

function identify(content) {
  const contentDigest = createHash("sha256")
    .update(JSON.stringify(content), "utf8")
    .digest("hex");
  return freezeEvent({
    schemaVersion: content.schemaVersion,
    eventId: `workflow-event-${contentDigest}`,
    contentDigest,
    eventType: content.eventType,
    occurredAt: content.occurredAt,
    source: content.source,
    subject: content.subject,
    payload: content.payload,
  });
}

function freezeEvent(value) {
  if (Array.isArray(value)) {
    for (const entry of value) freezeEvent(entry);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeEvent(entry);
  }
  return Object.freeze(value);
}

export function normalizeWorkflowEvent(value) {
  return normalize(() => identify(normalizeContent(value)));
}

export function normalizeStoredWorkflowEvent(value) {
  return normalize(() => {
    assertExactKeys(value, STORED_KEYS, "stored event");
    const normalized = normalizeWorkflowEvent({
      schemaVersion: value.schemaVersion,
      eventType: value.eventType,
      occurredAt: value.occurredAt,
      source: value.source,
      subject: value.subject,
      payload: value.payload,
    });
    if (
      typeof value.contentDigest !== "string" ||
      !SHA256.test(value.contentDigest) ||
      value.contentDigest !== normalized.contentDigest ||
      value.eventId !== normalized.eventId
    ) {
      throw invalid("stored event identity");
    }
    return normalized;
  });
}
