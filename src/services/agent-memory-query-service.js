import { createHash } from "node:crypto";

import { normalizeMemoryAnswerRequest } from "../domain/memory-answer-contract.js";
import { normalizeMemoryRecord } from "../domain/memory-record.js";
import { normalizeWorkIntent } from "../domain/work-intent.js";
import { OperationQueue } from "../lib/operation-queue.js";

export const AGENT_MEMORY_QUERY_STATE_KEY = "agent-memory-queries";
const STATE_KEY = AGENT_MEMORY_QUERY_STATE_KEY;
const DEFAULT_MAXIMUM_ENTRIES = 1_000;
const DEFAULT_MAXIMUM_STATE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_CONTEXT_CLAIMS = 6;
const MAXIMUM_CONTEXT_CITATIONS = 20;
const MAXIMUM_CONTEXT_STATEMENT_BYTES = 4_096;
const MAXIMUM_CONTEXT_ANSWER_BYTES = 8_192;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MEMORY_ID = /^memory-[a-f0-9]{64}$/;
const QUERY_ID = /^agent-memory-query-[a-f0-9]{64}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const RESULT_STATUSES = new Set(["answered", "insufficient_evidence"]);
const ENTRY_STATUSES = new Set(["reserved", "failed", "completed"]);
const RAW_MEMORY_RECORD_KEYS = Object.freeze([
  "schemaVersion",
  "source",
  "occurredAt",
  "roleId",
  "repository",
  "eventType",
  "title",
  "summary",
  "content",
  "evidence",
  "tags",
  "sourceUrl",
  "subjectNumber",
]);

export class AgentMemoryQueryServiceError extends Error {
  constructor(code, message, statusCode = 400, options) {
    super(message, options);
    this.name = "AgentMemoryQueryServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function serviceError(code, message, statusCode, cause) {
  return new AgentMemoryQueryServiceError(
    code,
    message,
    statusCode,
    cause === undefined ? undefined : { cause },
  );
}

function ownEntries(value, name, error = () => new TypeError(`${name} is invalid`)) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error();
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, name, error) {
  const fields = new Map(ownEntries(value, name, error));
  if (fields.size !== keys.length || keys.some((key) => !fields.has(key))) {
    throw (error?.() ?? new TypeError(`${name} is invalid`));
  }
  return fields;
}

function strictArray(value, maximum, name, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error();
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error();
    result.push(descriptor.value);
  }
  return result;
}

function boundedText(value, name, maximumBytes, { empty = false } = {}) {
  if (
    typeof value !== "string" ||
    INVALID_CONTROL.test(value) ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function timestamp(value, name) {
  const normalized = value instanceof Date ? value.toISOString() : value;
  if (
    typeof normalized !== "string" ||
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(Date.parse(normalized)).toISOString() !== normalized
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function bindMethod(value, method, name) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  let current = value;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          throw new TypeError(`${name} is invalid`);
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  throw new TypeError(`${name} is invalid`);
}

function requirePort(value, methods, name) {
  return Object.freeze(Object.fromEntries(
    methods.map((method) => [method, bindMethod(value, method, name)]),
  ));
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

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function truncateUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

function normalizeAllowedRoleIds(value) {
  const error = () => new TypeError("allowedRoleIds is invalid");
  const roles = strictArray(value, 256, "allowedRoleIds", error).map((roleId) => {
    if (typeof roleId !== "string" || !SAFE_ROLE_ID.test(roleId)) throw error();
    return roleId;
  });
  if (new Set(roles).size !== roles.length) throw error();
  return new Set(roles);
}

function roleId(value, name = "roleId") {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function itemBinding(value, expectedRoleId) {
  const fields = new Map(ownEntries(value, "item"));
  for (const key of ["itemId", "revision", "inputDigest", "currentTarget"]) {
    if (!fields.has(key)) throw new TypeError("item is invalid");
  }
  const target = exact(fields.get("currentTarget"), ["type", "id"], "item.currentTarget");
  const itemId = boundedText(fields.get("itemId"), "item.itemId", 192);
  const itemRevision = positiveInteger(fields.get("revision"), "item.revision", Number.MAX_SAFE_INTEGER);
  const inputDigest = boundedText(fields.get("inputDigest"), "item.inputDigest", 64);
  if (
    !SHA256.test(inputDigest) ||
    target.get("type") !== "role" ||
    target.get("id") !== expectedRoleId
  ) {
    throw serviceError(
      "AGENT_MEMORY_QUERY_BINDING_INVALID",
      "Agent memory query is not bound to the current role work item",
      409,
    );
  }
  return { roleId: expectedRoleId, itemId, itemRevision, inputDigest };
}

function readBinding(value, expectedRoleId) {
  const fields = exact(
    value,
    ["itemId", "itemRevision", "inputDigest", "currentTarget"],
    "memory query context item",
  );
  return itemBinding({
    itemId: fields.get("itemId"),
    revision: fields.get("itemRevision"),
    inputDigest: fields.get("inputDigest"),
    currentTarget: fields.get("currentTarget"),
  }, expectedRoleId);
}

function queryRequest(intentValue) {
  const intent = normalizeWorkIntent(intentValue);
  if (intent.type !== "query_memory") {
    throw serviceError(
      "AGENT_MEMORY_QUERY_INTENT_INVALID",
      "Agent memory query intent is invalid",
      400,
    );
  }
  return {
    intent,
    request: normalizeMemoryAnswerRequest({
      schemaVersion: 1,
      question: intent.question,
      mode: intent.mode,
      retrieval: {
        kind: "query",
        filters: { query: intent.searchQuery },
      },
    }),
  };
}

function logicalBinding(binding) {
  return {
    roleId: binding.roleId,
    itemId: binding.itemId,
    inputDigest: binding.inputDigest,
  };
}

function queryIdentity(binding, request) {
  return `agent-memory-query-${digest({
    domain: "mydashboard-agent-memory-query/v2",
    binding: logicalBinding(binding),
    request,
  })}`;
}

function legacyQueryIdentity(binding, request) {
  return `agent-memory-query-${digest({
    domain: "mydashboard-agent-memory-query/v1",
    binding,
    request,
  })}`;
}

function sameQueryRequest(left, right) {
  return digest(left) === digest(right);
}

function bindingKey(binding) {
  return [
    binding.roleId,
    binding.itemId,
    binding.inputDigest,
  ].join("\u0000");
}

function compareLegacyEntryOrder(left, right) {
  return (
    left.binding.itemRevision - right.binding.itemRevision ||
    left.startedAt.localeCompare(right.startedAt, "en") ||
    left.queryId.localeCompare(right.queryId, "en")
  );
}

function resolveLogicalEntryGroup(group) {
  const ordered = [...group].sort(compareLegacyEntryOrder);
  const reserved = ordered.filter(({ status }) => status === "reserved");
  if (reserved.length > 0) {
    return { entry: reserved[0], conflict: false };
  }
  if (new Set(ordered.map(({ request }) => digest(request))).size > 1) {
    return { entry: null, conflict: true };
  }
  const completed = ordered.filter(({ status }) => status === "completed");
  if (completed.length > 1) {
    return { entry: null, conflict: true };
  }
  return {
    entry: completed[0] ?? ordered[0],
    conflict: false,
  };
}

function stableErrorCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const value = descriptor && "value" in descriptor ? descriptor.value : null;
    if (typeof value === "string" && SAFE_ERROR_CODE.test(value)) return value;
  } catch {
    // Untrusted provider errors collapse to one stable local classification.
  }
  return "AGENT_MEMORY_QUERY_FAILED";
}

function optionalSignal(value) {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.aborted !== "boolean" ||
    typeof value.addEventListener !== "function" ||
    typeof value.removeEventListener !== "function"
  ) {
    throw new TypeError("signal is invalid");
  }
  return value;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw serviceError(
    "AGENT_MEMORY_QUERY_CANCELLED",
    "Agent memory query was cancelled",
    499,
  );
}

function memoryRecordFromFields(value, invalid) {
  const fields = exact(
    value,
    ["recordId", "contentDigest", ...RAW_MEMORY_RECORD_KEYS],
    "memory query citation record",
    invalid,
  );
  const normalized = normalizeMemoryRecord(Object.fromEntries(
    RAW_MEMORY_RECORD_KEYS.map((key) => [key, fields.get(key)]),
  ));
  if (
    normalized.recordId !== fields.get("recordId") ||
    normalized.contentDigest !== fields.get("contentDigest")
  ) {
    throw invalid();
  }
  return normalized;
}

function normalizeHydratedCitations(value, expected) {
  const invalid = () => serviceError(
    "AGENT_MEMORY_QUERY_CITATION_INVALID",
    "Agent memory query citations could not be verified",
    409,
  );
  const fields = exact(
    value,
    ["journalRevision", "items"],
    "memory query citation read result",
    invalid,
  );
  if (!Number.isSafeInteger(fields.get("journalRevision")) || fields.get("journalRevision") < 0) {
    throw invalid();
  }
  const items = strictArray(
    fields.get("items"),
    expected.length,
    "memory query citation items",
    invalid,
  );
  if (items.length !== expected.length) throw invalid();
  return items.map((item, index) => {
    const itemFields = exact(
      item,
      ["record", "labels"],
      "memory query citation item",
      invalid,
    );
    const record = memoryRecordFromFields(itemFields.get("record"), invalid);
    const labels = exact(
      itemFields.get("labels"),
      ["authority", "lifecycle"],
      "memory query citation labels",
      invalid,
    );
    if (
      record.recordId !== expected[index].recordId ||
      record.contentDigest !== expected[index].contentDigest ||
      labels.get("authority") !== "raw" ||
      labels.get("lifecycle") !== "current"
    ) {
      throw serviceError(
        "AGENT_MEMORY_QUERY_CITATION_STALE",
        "Agent memory query citations are no longer current and citable",
        409,
      );
    }
    return {
      recordId: record.recordId,
      contentDigest: record.contentDigest,
      title: record.title,
      occurredAt: record.occurredAt,
      eventType: record.eventType,
      roleId: record.roleId,
      repository: record.repository,
      source: structuredClone(record.source),
    };
  });
}

function normalizeAnswerResult(value) {
  const invalid = () => serviceError(
    "AGENT_MEMORY_QUERY_RESULT_INVALID",
    "MemoryAnswerService returned an invalid agent result",
    503,
  );
  const fields = exact(
    value,
    [
      "schemaVersion",
      "status",
      "answer",
      "derived",
      "claims",
      "citations",
      "context",
      "brain",
      "localRerunAvailable",
    ],
    "agent memory answer",
    invalid,
  );
  const status = fields.get("status");
  if (
    fields.get("schemaVersion") !== 1 ||
    !RESULT_STATUSES.has(status) ||
    typeof fields.get("derived") !== "boolean" ||
    typeof fields.get("localRerunAvailable") !== "boolean"
  ) {
    throw invalid();
  }
  const claims = strictArray(fields.get("claims"), 12, "agent memory claims", invalid)
    .map((claim) => {
      const claimFields = exact(
        claim,
        ["statement", "citationIds", "derived"],
        "agent memory claim",
        invalid,
      );
      const statement = claimFields.get("statement");
      const citationIds = strictArray(
        claimFields.get("citationIds"),
        8,
        "agent memory claim citations",
        invalid,
      );
      if (
        typeof statement !== "string" ||
        !statement.trim() ||
        INVALID_CONTROL.test(statement) ||
        Buffer.byteLength(statement, "utf8") > 4_096 ||
        claimFields.get("derived") !== true ||
        citationIds.length === 0 ||
        citationIds.some((recordId) => typeof recordId !== "string" || !MEMORY_ID.test(recordId)) ||
        new Set(citationIds).size !== citationIds.length
      ) {
        throw invalid();
      }
      return { statement, citationIds };
    });
  if (
    (status === "answered" && claims.length === 0) ||
    (status === "insufficient_evidence" && claims.length !== 0)
  ) {
    throw invalid();
  }
  const context = new Map(ownEntries(fields.get("context"), "agent memory context", invalid));
  const contextDigest = context.get("contextDigest");
  if (typeof contextDigest !== "string" || !SHA256.test(contextDigest)) throw invalid();
  const citationFields = strictArray(
    fields.get("citations"),
    MAXIMUM_CONTEXT_CITATIONS,
    "agent memory citations",
    invalid,
  ).map((citation) => {
    const entries = new Map(ownEntries(citation, "agent memory citation", invalid));
    const recordId = entries.get("recordId");
    const contentDigest = entries.get("contentDigest");
    if (
      typeof recordId !== "string" ||
      !MEMORY_ID.test(recordId) ||
      typeof contentDigest !== "string" ||
      !SHA256.test(contentDigest)
    ) {
      throw invalid();
    }
    return { recordId, contentDigest };
  });
  if (new Set(citationFields.map(({ recordId }) => recordId)).size !== citationFields.length) {
    throw invalid();
  }
  const citationsById = new Map(citationFields.map((entry) => [entry.recordId, entry]));
  const selectedClaims = [];
  const selectedCitationIds = new Set();
  let selectedStatementBytes = 0;
  let truncated = false;
  for (const claim of claims) {
    if (selectedClaims.length >= MAXIMUM_CONTEXT_CLAIMS) {
      truncated = true;
      break;
    }
    const candidateIds = new Set([...selectedCitationIds, ...claim.citationIds]);
    if (candidateIds.size > MAXIMUM_CONTEXT_CITATIONS) {
      truncated = true;
      break;
    }
    if (claim.citationIds.some((recordId) => !citationsById.has(recordId))) {
      throw invalid();
    }
    const statementBytes = Buffer.byteLength(claim.statement, "utf8");
    const separatorBytes = selectedClaims.length === 0 ? 0 : 1;
    if (
      selectedStatementBytes + separatorBytes + statementBytes >
      MAXIMUM_CONTEXT_ANSWER_BYTES
    ) {
      truncated = true;
      break;
    }
    selectedClaims.push({
      statement: claim.statement,
      citationIds: [...claim.citationIds],
    });
    selectedStatementBytes += separatorBytes + statementBytes;
    for (const recordId of claim.citationIds) selectedCitationIds.add(recordId);
  }
  if (status === "answered" && selectedClaims.length === 0) throw invalid();
  const brain = exact(
    fields.get("brain"),
    ["mode", "provider", "model", "remote"],
    "agent memory brain",
    invalid,
  );
  const mode = brain.get("mode");
  const provider = brain.get("provider");
  const model = brain.get("model");
  if (
    !new Set(["local", "configured"]).has(mode) ||
    typeof brain.get("remote") !== "boolean" ||
    typeof provider !== "string" ||
    !provider.trim() ||
    INVALID_CONTROL.test(provider) ||
    Buffer.byteLength(provider, "utf8") > 128 ||
    typeof model !== "string" ||
    !model.trim() ||
    INVALID_CONTROL.test(model) ||
    Buffer.byteLength(model, "utf8") > 256
  ) {
    throw invalid();
  }
  const result = {
    schemaVersion: 1,
    status,
    claims: selectedClaims,
    citations: [...selectedCitationIds].map((recordId) => citationsById.get(recordId)),
    contextDigest,
    brain: {
      mode,
      provider,
      model,
      remote: brain.get("remote"),
    },
    truncated: truncated || selectedClaims.length !== claims.length,
  };
  return deepFreeze(result);
}

function normalizeStoredResult(value, invalid) {
  const fields = exact(
    value,
    ["schemaVersion", "status", "claims", "citations", "contextDigest", "brain", "truncated"],
    "stored agent memory result",
    invalid,
  );
  if (
    fields.get("schemaVersion") !== 1 ||
    !RESULT_STATUSES.has(fields.get("status")) ||
    typeof fields.get("truncated") !== "boolean" ||
    typeof fields.get("contextDigest") !== "string" ||
    !SHA256.test(fields.get("contextDigest"))
  ) {
    throw invalid();
  }
  const claims = strictArray(
    fields.get("claims"),
    MAXIMUM_CONTEXT_CLAIMS,
    "stored agent memory claims",
    invalid,
  ).map((claim) => {
    const claimFields = exact(
      claim,
      ["statement", "citationIds"],
      "stored agent memory claim",
      invalid,
    );
    const citationIds = strictArray(
      claimFields.get("citationIds"),
      8,
      "stored agent memory claim citations",
      invalid,
    );
    const statement = claimFields.get("statement");
    if (
      typeof statement !== "string" ||
      !statement.trim() ||
      INVALID_CONTROL.test(statement) ||
      Buffer.byteLength(statement, "utf8") > MAXIMUM_CONTEXT_STATEMENT_BYTES ||
      citationIds.length === 0 ||
      citationIds.some((recordId) => typeof recordId !== "string" || !MEMORY_ID.test(recordId)) ||
      new Set(citationIds).size !== citationIds.length
    ) {
      throw invalid();
    }
    return { statement, citationIds };
  });
  const status = fields.get("status");
  if (
    (status === "answered" && claims.length === 0) ||
    (status === "insufficient_evidence" && claims.length !== 0)
  ) {
    throw invalid();
  }
  const citations = strictArray(
    fields.get("citations"),
    MAXIMUM_CONTEXT_CITATIONS,
    "stored agent memory citations",
    invalid,
  ).map((citation) => {
    const citationFields = exact(
      citation,
      ["recordId", "contentDigest"],
      "stored agent memory citation",
      invalid,
    );
    const recordId = citationFields.get("recordId");
    const contentDigest = citationFields.get("contentDigest");
    if (
      typeof recordId !== "string" ||
      !MEMORY_ID.test(recordId) ||
      typeof contentDigest !== "string" ||
      !SHA256.test(contentDigest)
    ) {
      throw invalid();
    }
    return { recordId, contentDigest };
  });
  const citationIds = new Set(citations.map(({ recordId }) => recordId));
  if (
    citationIds.size !== citations.length ||
    claims.some((claim) => claim.citationIds.some((recordId) => !citationIds.has(recordId))) ||
    Buffer.byteLength(
      claims.map(({ statement }) => statement).join("\n"),
      "utf8",
    ) > MAXIMUM_CONTEXT_ANSWER_BYTES
  ) {
    throw invalid();
  }
  const brainFields = exact(
    fields.get("brain"),
    ["mode", "provider", "model", "remote"],
    "stored agent memory brain",
    invalid,
  );
  if (
    !new Set(["local", "configured"]).has(brainFields.get("mode")) ||
    typeof brainFields.get("remote") !== "boolean"
  ) {
    throw invalid();
  }
  return {
    schemaVersion: 1,
    status,
    claims,
    citations,
    contextDigest: fields.get("contextDigest"),
    brain: {
      mode: brainFields.get("mode"),
      provider: boundedText(brainFields.get("provider"), "stored brain provider", 128),
      model: boundedText(brainFields.get("model"), "stored brain model", 256),
      remote: brainFields.get("remote"),
    },
    truncated: fields.get("truncated"),
  };
}

function normalizedStoredRequest(value) {
  try {
    return structuredClone(normalizeMemoryAnswerRequest(value));
  } catch (cause) {
    throw serviceError(
      "AGENT_MEMORY_QUERY_STATE_CORRUPTED",
      "Agent memory query state is corrupted",
      503,
      cause,
    );
  }
}

function projectionRecord(entry) {
  const answer = entry.result.status === "answered"
    ? entry.result.claims.map(({ statement }) => statement).join("\n")
    : "证据不足";
  return normalizeMemoryRecord({
    schemaVersion: 1,
    source: { kind: "agent-memory-query", id: entry.queryId },
    occurredAt: entry.completedAt,
    roleId: entry.binding.roleId,
    repository: null,
    eventType: entry.result.status === "answered"
      ? "agent.memory_answered"
      : "agent.memory_insufficient",
    title: truncateUtf8(`岗位记忆查询：${entry.request.question}`, 1_024),
    summary: truncateUtf8(answer, 8_192),
    content: JSON.stringify({
      schemaVersion: 1,
      queryId: entry.queryId,
      itemId: entry.binding.itemId,
      itemRevision: entry.binding.itemRevision,
      inputDigest: entry.binding.inputDigest,
      question: entry.request.question,
      searchQuery: entry.request.retrieval.filters.query,
      mode: entry.request.mode,
      status: entry.result.status,
      contextDigest: entry.result.contextDigest,
      claimCount: entry.result.claims.length,
      citationIds: entry.result.citations.map(({ recordId }) => recordId),
      truncated: entry.result.truncated,
    }),
    evidence: entry.result.citations.map(({ recordId }) => `cites:${recordId}`),
    tags: ["agent-memory-query", "derived"],
    sourceUrl: null,
    subjectNumber: null,
  });
}

function normalizeStoredEntry(value) {
  const invalid = () => serviceError(
    "AGENT_MEMORY_QUERY_STATE_CORRUPTED",
    "Agent memory query state is corrupted",
    503,
  );
  const fields = exact(
    value,
    [
      "queryId",
      "binding",
      "request",
      "status",
      "requestedBy",
      "startedAt",
      "completedAt",
      "errorCode",
      "result",
      "projectionRecordId",
      "projected",
    ],
    "agent memory query entry",
    invalid,
  );
  const queryId = fields.get("queryId");
  const bindingFields = exact(
    fields.get("binding"),
    ["roleId", "itemId", "itemRevision", "inputDigest"],
    "agent memory query binding",
    invalid,
  );
  const binding = {
    roleId: roleId(bindingFields.get("roleId"), "stored roleId"),
    itemId: boundedText(bindingFields.get("itemId"), "stored itemId", 192),
    itemRevision: positiveInteger(
      bindingFields.get("itemRevision"),
      "stored itemRevision",
      Number.MAX_SAFE_INTEGER,
    ),
    inputDigest: boundedText(bindingFields.get("inputDigest"), "stored inputDigest", 64),
  };
  if (
    typeof queryId !== "string" ||
    !QUERY_ID.test(queryId) ||
    !SHA256.test(binding.inputDigest)
  ) {
    throw invalid();
  }
  const request = normalizedStoredRequest(fields.get("request"));
  if (
    queryIdentity(binding, request) !== queryId &&
    legacyQueryIdentity(binding, request) !== queryId
  ) {
    throw invalid();
  }
  const status = fields.get("status");
  const requestedBy = boundedText(fields.get("requestedBy"), "stored requestedBy", 128);
  const startedAt = timestamp(fields.get("startedAt"), "stored startedAt");
  const completedAt = fields.get("completedAt") === null
    ? null
    : timestamp(fields.get("completedAt"), "stored completedAt");
  const errorCode = fields.get("errorCode");
  const projected = fields.get("projected");
  const projectionRecordId = fields.get("projectionRecordId");
  if (
    !ENTRY_STATUSES.has(status) ||
    typeof errorCode !== "string" ||
    (errorCode && !SAFE_ERROR_CODE.test(errorCode)) ||
    typeof projected !== "boolean" ||
    !(
      projectionRecordId === null ||
      (typeof projectionRecordId === "string" && MEMORY_ID.test(projectionRecordId))
    )
  ) {
    throw invalid();
  }
  const result = fields.get("result") === null
    ? null
    : normalizeStoredResult(fields.get("result"), invalid);
  const normalized = {
    queryId,
    binding,
    request,
    status,
    requestedBy,
    startedAt,
    completedAt,
    errorCode,
    result,
    projectionRecordId,
    projected,
  };
  if (
    (status === "reserved" && (
      completedAt !== null || errorCode || result !== null ||
      projectionRecordId !== null || projected
    )) ||
    (status === "failed" && (
      completedAt === null || !errorCode || result !== null ||
      projectionRecordId !== null || projected
    )) ||
    (status === "completed" && (
      completedAt === null || errorCode || result === null ||
      projectionRecordId === null
    ))
  ) {
    throw invalid();
  }
  if (status === "completed") {
    const record = projectionRecord(normalized);
    if (record.recordId !== projectionRecordId) throw invalid();
  }
  return normalized;
}

function normalizeState(value, maximumEntries, maximumStateBytes) {
  const invalid = () => serviceError(
    "AGENT_MEMORY_QUERY_STATE_CORRUPTED",
    "Agent memory query state is corrupted",
    503,
  );
  const fields = exact(
    value,
    ["schemaVersion", "revision", "entries"],
    "agent memory query state",
    invalid,
  );
  if (
    fields.get("schemaVersion") !== 1 ||
    !Number.isSafeInteger(fields.get("revision")) ||
    fields.get("revision") < 0
  ) {
    throw invalid();
  }
  let entries;
  try {
    entries = strictArray(
      fields.get("entries"),
      maximumEntries,
      "agent memory query entries",
      invalid,
    ).map(normalizeStoredEntry);
  } catch (cause) {
    if (
      cause instanceof AgentMemoryQueryServiceError &&
      cause.code === "AGENT_MEMORY_QUERY_STATE_CORRUPTED"
    ) {
      throw cause;
    }
    throw serviceError(
      "AGENT_MEMORY_QUERY_STATE_CORRUPTED",
      "Agent memory query state is corrupted",
      503,
      cause,
    );
  }
  if (new Set(entries.map(({ queryId }) => queryId)).size !== entries.length) {
    throw invalid();
  }
  const entriesByLogicalBinding = new Map();
  for (const entry of entries) {
    const key = bindingKey(entry.binding);
    const group = entriesByLogicalBinding.get(key) ?? [];
    group.push(entry);
    entriesByLogicalBinding.set(key, group);
  }
  if (
    [...entriesByLogicalBinding.values()].some(
      (group) =>
        group.length > 1 &&
        group.some(
          (entry) =>
            entry.queryId !== legacyQueryIdentity(entry.binding, entry.request),
        ),
    )
  ) {
    throw invalid();
  }
  const state = {
    schemaVersion: 1,
    revision: fields.get("revision"),
    entries,
  };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > maximumStateBytes) {
    throw invalid();
  }
  return state;
}

export function normalizeAgentMemoryQueryPersistedState(
  value,
  {
    maximumEntries = DEFAULT_MAXIMUM_ENTRIES,
    maximumStateBytes = DEFAULT_MAXIMUM_STATE_BYTES,
  } = {},
) {
  return normalizeState(
    value,
    positiveInteger(maximumEntries, "maximumEntries", 5_000),
    positiveInteger(
      maximumStateBytes,
      "maximumStateBytes",
      64 * 1024 * 1024,
    ),
  );
}

function publicContext(entry, citations) {
  const answer = entry.result.status === "answered"
    ? entry.result.claims.map(({ statement }) => statement).join("\n")
    : "证据不足";
  return deepFreeze({
    schemaVersion: 1,
    queryId: entry.queryId,
    question: entry.request.question,
    searchQuery: entry.request.retrieval.filters.query,
    mode: entry.request.mode,
    status: entry.result.status,
    answer,
    claims: structuredClone(entry.result.claims),
    citations,
    contextDigest: entry.result.contextDigest,
    answeredAt: entry.completedAt,
    brain: structuredClone(entry.result.brain),
    truncated: entry.result.truncated,
  });
}

function rawMemoryRecord(record) {
  return Object.fromEntries(
    RAW_MEMORY_RECORD_KEYS.map((key) => [key, structuredClone(record[key])]),
  );
}

export class AgentMemoryQueryService {
  #store;
  #answer;
  #readRecords;
  #appendMemory;
  #allowedRoleIds;
  #clock;
  #maximumEntries;
  #maximumStateBytes;
  #stateKey;
  #operationQueue;
  #state = null;
  #entriesByBinding = new Map();
  #conflictingBindings = new Set();

  constructor({
    store,
    memoryAnswer,
    memoryContextReader,
    memoryProducer,
    allowedRoleIds = [],
    clock = () => new Date(),
    maximumEntries = DEFAULT_MAXIMUM_ENTRIES,
    maximumStateBytes = DEFAULT_MAXIMUM_STATE_BYTES,
    stateKey = STATE_KEY,
    operationQueue = new OperationQueue(),
  } = {}) {
    this.#store = requirePort(store, ["read", "write"], "store");
    this.#answer = requirePort(memoryAnswer, ["answer"], "memoryAnswer").answer;
    this.#readRecords = requirePort(
      memoryContextReader,
      ["readRecords"],
      "memoryContextReader",
    ).readRecords;
    this.#appendMemory = requirePort(
      memoryProducer,
      ["append"],
      "memoryProducer",
    ).append;
    this.#allowedRoleIds = normalizeAllowedRoleIds(allowedRoleIds);
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.#clock = clock;
    this.#maximumEntries = positiveInteger(maximumEntries, "maximumEntries", 5_000);
    this.#maximumStateBytes = positiveInteger(
      maximumStateBytes,
      "maximumStateBytes",
      64 * 1024 * 1024,
    );
    this.#stateKey = boundedText(stateKey, "stateKey", 128);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(this.#stateKey)) {
      throw new TypeError("stateKey is invalid");
    }
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("operationQueue is invalid");
    }
    this.#operationQueue = operationQueue;
    Object.freeze(this);
  }

  async recover() {
    if (this.#state !== null) return this.status();
    const stored = await this.#store.read(this.#stateKey, null);
    this.#state = stored === null
      ? { schemaVersion: 1, revision: 0, entries: [] }
      : normalizeState(stored, this.#maximumEntries, this.#maximumStateBytes);
    this.#reindex();
    return this.status();
  }

  status() {
    this.#assertReady();
    return Object.freeze({
      revision: this.#state.revision,
      count: this.#state.entries.length,
      reserved: this.#state.entries.filter(({ status }) => status === "reserved").length,
      failed: this.#state.entries.filter(({ status }) => status === "failed").length,
      completed: this.#state.entries.filter(({ status }) => status === "completed").length,
      unprojected: this.#state.entries.filter(
        ({ status, projected }) => status === "completed" && !projected,
      ).length,
    });
  }

  execute({ roleId: roleValue, workerId, item, intent: intentValue, signal: signalValue } = {}) {
    return this.#operationQueue.enqueue(async () => {
      this.#assertReady();
      const signal = optionalSignal(signalValue);
      throwIfAborted(signal);
      const role = roleId(roleValue);
      if (!this.#allowedRoleIds.has(role)) {
        throw serviceError(
          "AGENT_MEMORY_QUERY_NOT_PERMITTED",
          "This role is not permitted to query memory",
          403,
        );
      }
      const requester = boundedText(workerId, "workerId", 128);
      const binding = itemBinding(item, role);
      const { request } = queryRequest(intentValue);
      const queryId = queryIdentity(binding, request);
      const existing = this.#entryForBinding(binding);
      if (existing) {
        if (existing.status === "reserved") {
          throw serviceError(
            "AGENT_MEMORY_QUERY_RESULT_UNKNOWN",
            "The previous memory query may have started but has no durable result",
            503,
          );
        }
        if (!sameQueryRequest(existing.request, request)) {
          throw serviceError(
            "AGENT_MEMORY_QUERY_LIMIT_EXCEEDED",
            "Only one memory query is allowed for this work iteration",
            409,
          );
        }
        if (existing.status === "failed") {
          throw serviceError(
            "AGENT_MEMORY_QUERY_ALREADY_ATTEMPTED",
            `The memory query already failed with ${existing.errorCode}`,
            409,
          );
        }
        await this.#project(existing.queryId);
        return Object.freeze({
          recovered: true,
          context: await this.#contextFor(existing),
        });
      }
      if (this.#state.entries.length >= this.#maximumEntries) {
        throw serviceError(
          "AGENT_MEMORY_QUERY_CAPACITY_EXCEEDED",
          "Agent memory query history reached its configured capacity",
          507,
        );
      }
      const startedAt = timestamp(this.#clock(), "clock");
      const reserved = {
        queryId,
        binding,
        request: structuredClone(request),
        status: "reserved",
        requestedBy: requester,
        startedAt,
        completedAt: null,
        errorCode: "",
        result: null,
        projectionRecordId: null,
        projected: false,
      };
      await this.#insert(reserved);

      let result;
      try {
        result = normalizeAnswerResult(await this.#answer(
          request,
          signal === null ? {} : { signal },
        ));
        throwIfAborted(signal);
        if (result.brain.mode !== request.mode) {
          throw serviceError(
            "AGENT_MEMORY_QUERY_RESULT_INVALID",
            "MemoryAnswerService returned a result for a different mode",
            503,
          );
        }
        await this.#hydrate(result.citations);
        throwIfAborted(signal);
        result = {
          ...structuredClone(result),
          citations: result.citations.map((citation) => ({ ...citation })),
        };
        const completedAt = timestamp(this.#clock(), "clock");
        const entryForProjection = {
          ...reserved,
          status: "completed",
          completedAt,
          result,
        };
        const projection = projectionRecord(entryForProjection);
        const completed = {
          ...entryForProjection,
          result,
          projectionRecordId: projection.recordId,
        };
        await this.#replace(completed);
        throwIfAborted(signal);
        await this.#project(queryId);
        throwIfAborted(signal);
        return Object.freeze({
          recovered: false,
          context: await this.#contextFor(this.#entriesByBinding.get(bindingKey(binding))),
        });
      } catch (error) {
        const latest = this.#entriesByBinding.get(bindingKey(binding));
        if (latest?.status === "reserved") {
          await this.#replace({
            ...latest,
            status: "failed",
            completedAt: timestamp(this.#clock(), "clock"),
            errorCode: stableErrorCode(error),
          });
        }
        throw error;
      }
    });
  }

  readContext({ roleId: roleValue, item } = {}) {
    return this.#operationQueue.enqueue(async () => {
      this.#assertReady();
      const role = roleId(roleValue);
      if (!this.#allowedRoleIds.has(role)) return null;
      const binding = readBinding(item, role);
      let entry = this.#entryForBinding(binding);
      if (!entry || entry.status !== "completed") return null;
      await this.#project(entry.queryId);
      entry = this.#entryForBinding(binding);
      return this.#contextFor(entry);
    });
  }

  verifyContext({
    roleId: roleValue,
    item,
    context,
    signal: signalValue,
  } = {}) {
    return this.#operationQueue.enqueue(async () => {
      this.#assertReady();
      const signal = optionalSignal(signalValue);
      throwIfAborted(signal);
      const role = roleId(roleValue);
      if (!this.#allowedRoleIds.has(role)) {
        throw serviceError(
          "AGENT_MEMORY_QUERY_NOT_PERMITTED",
          "This role is not permitted to query memory",
          403,
        );
      }
      const binding = itemBinding(item, role);
      const entry = this.#entryForBinding(binding);
      if (!entry || entry.status !== "completed") {
        throw serviceError(
          "AGENT_MEMORY_QUERY_CONTEXT_STALE",
          "Agent memory query context is no longer current",
          409,
        );
      }
      const current = await this.#contextFor(entry);
      throwIfAborted(signal);
      if (digest(context) !== digest(current)) {
        throw serviceError(
          "AGENT_MEMORY_QUERY_CONTEXT_STALE",
          "Agent memory query context changed before the decision completed",
          409,
        );
      }
      return Object.freeze({ queryId: entry.queryId, current: true });
    });
  }

  async #contextFor(entry) {
    const citations = await this.#hydrate(entry.result.citations);
    return publicContext(entry, citations);
  }

  async #hydrate(citations) {
    if (citations.length === 0) return [];
    let readResult;
    try {
      readResult = await this.#readRecords({
        recordIds: citations.map(({ recordId }) => recordId),
      });
    } catch (cause) {
      if (stableErrorCode(cause) === "MEMORY_RECORD_NOT_FOUND") {
        throw serviceError(
          "AGENT_MEMORY_QUERY_CITATION_STALE",
          "Agent memory query citations are no longer current and citable",
          409,
          cause,
        );
      }
      throw cause;
    }
    return normalizeHydratedCitations(readResult, citations);
  }

  async #project(queryId) {
    const current = this.#state.entries.find((entry) => entry.queryId === queryId);
    if (!current || current.status !== "completed" || current.projected) return;
    await this.#hydrate(current.result.citations);
    const record = projectionRecord(current);
    if (record.recordId !== current.projectionRecordId) {
      throw serviceError(
        "AGENT_MEMORY_QUERY_STATE_CORRUPTED",
        "Agent memory query projection binding is corrupted",
        503,
      );
    }
    const receipt = await this.#appendMemory(rawMemoryRecord(record));
    const receiptFields = exact(
      receipt,
      ["recordId", "created"],
      "agent memory projection receipt",
    );
    if (
      receiptFields.get("recordId") !== record.recordId ||
      typeof receiptFields.get("created") !== "boolean"
    ) {
      throw serviceError(
        "AGENT_MEMORY_QUERY_PROJECTION_INVALID",
        "Agent memory query projection receipt is invalid",
        503,
      );
    }
    await this.#replace({ ...current, projected: true });
  }

  async #insert(entry) {
    await this.#write([...this.#state.entries, entry]);
  }

  async #replace(entry) {
    const index = this.#state.entries.findIndex(
      ({ queryId }) => queryId === entry.queryId,
    );
    if (index < 0) {
      throw serviceError(
        "AGENT_MEMORY_QUERY_STATE_CORRUPTED",
        "Agent memory query entry disappeared",
        503,
      );
    }
    const entries = [...this.#state.entries];
    entries[index] = entry;
    await this.#write(entries);
  }

  async #write(entries) {
    const candidate = normalizeState(
      {
        schemaVersion: 1,
        revision: this.#state.revision + 1,
        entries,
      },
      this.#maximumEntries,
      this.#maximumStateBytes,
    );
    await this.#store.write(this.#stateKey, candidate);
    this.#state = candidate;
    this.#reindex();
  }

  #reindex() {
    this.#entriesByBinding = new Map();
    this.#conflictingBindings = new Set();
    const groups = new Map();
    for (const entry of this.#state.entries) {
      const key = bindingKey(entry.binding);
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const resolution = resolveLogicalEntryGroup(group);
      if (resolution.conflict) {
        this.#conflictingBindings.add(key);
      } else {
        this.#entriesByBinding.set(key, resolution.entry);
      }
    }
  }

  #entryForBinding(binding) {
    const key = bindingKey(binding);
    if (this.#conflictingBindings.has(key)) {
      throw serviceError(
        "AGENT_MEMORY_QUERY_STATE_CONFLICT",
        "Legacy memory query history is ambiguous for this logical input",
        503,
      );
    }
    return this.#entriesByBinding.get(key);
  }

  #assertReady() {
    if (this.#state === null) {
      throw serviceError(
        "AGENT_MEMORY_QUERY_NOT_READY",
        "Agent memory query service has not recovered",
        503,
      );
    }
  }
}
