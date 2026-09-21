import {
  normalizeOwnerWorkRequest,
  normalizeStoredOwnerWorkRequest,
  ownerWorkRequestEventMatches,
  ownerWorkRequestDigest,
} from "../domain/owner-work-request.js";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";

export const OWNER_WORK_REQUEST_STATE_KEY = "owner-work-requests-v1";
export const OWNER_WORK_REQUEST_MAX_RECORDS = 1_000;

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const PHASES = Object.freeze(["staged", "routed", "intaken"]);
const RECORD_KEYS = Object.freeze([
  "requestId",
  "requestDigest",
  "request",
  "event",
  "phase",
  "assignment",
  "workItemId",
  "createdAt",
  "updatedAt",
  "audit",
  "recordDigest",
]);
const STATE_KEYS = Object.freeze([
  "schemaVersion",
  "revision",
  "records",
  "stateDigest",
]);
const ASSIGNMENT_KEYS = Object.freeze([
  "assignmentId",
  "eventId",
  "target",
  "configVersion",
  "configDigest",
  "ruleId",
]);
const TARGET_KEYS = Object.freeze(["type", "id"]);
const AUDIT_KEYS = Object.freeze([
  "requestId",
  "sequence",
  "type",
  "at",
  "details",
  "contentDigest",
  "auditId",
]);
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_RULE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const ASSIGNMENT_ID = /^workflow-assignment-[a-f0-9]{64}$/;
const EVENT_ID = /^workflow-event-[a-f0-9]{64}$/;
const WORK_ITEM_ID = /^work-item-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function stateError(message, options = {}) {
  return Object.assign(
    new Error(message, options),
    {
      code: "OWNER_WORK_REQUEST_STATE_CORRUPTED",
      statusCode: 503,
    },
  );
}

function plainObject(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw stateError(`${label}损坏`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw stateError(`${label}损坏`);
    }
  }
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw stateError(`${label}字段损坏`);
  }
  return value;
}

function denseArray(value, maximum, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw stateError(`${label}损坏`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw stateError(`${label}损坏`);
    }
  }
  return value;
}

function timestamp(value, label) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw stateError(`${label}损坏`);
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeAssignment(value, event) {
  if (value === null) return null;
  plainObject(value, ASSIGNMENT_KEYS, "所有者工作请求分派");
  plainObject(value.target, TARGET_KEYS, "所有者工作请求分派目标");
  if (
    !ASSIGNMENT_ID.test(value.assignmentId) ||
    value.eventId !== event.eventId ||
    value.target.type !== "role" ||
    !SAFE_ROLE_ID.test(value.target.id) ||
    !Number.isSafeInteger(value.configVersion) ||
    value.configVersion < 1 ||
    !SHA256.test(value.configDigest) ||
    !SAFE_RULE_ID.test(value.ruleId)
  ) {
    throw stateError("所有者工作请求分派绑定损坏");
  }
  return {
    assignmentId: value.assignmentId,
    eventId: value.eventId,
    target: { type: "role", id: value.target.id },
    configVersion: value.configVersion,
    configDigest: value.configDigest,
    ruleId: value.ruleId,
  };
}

function auditDetails(type, value) {
  if (type === "request_staged") {
    plainObject(value, ["requestDigest", "eventId"], "所有者工作请求审计详情");
    if (!SHA256.test(value.requestDigest) || !EVENT_ID.test(value.eventId)) {
      throw stateError("所有者工作请求审计详情损坏");
    }
    return { requestDigest: value.requestDigest, eventId: value.eventId };
  }
  if (type === "request_routed") {
    plainObject(value, ["assignmentId", "target"], "所有者工作请求审计详情");
    plainObject(value.target, TARGET_KEYS, "所有者工作请求审计目标");
    if (
      !ASSIGNMENT_ID.test(value.assignmentId) ||
      value.target.type !== "role" ||
      !SAFE_ROLE_ID.test(value.target.id)
    ) {
      throw stateError("所有者工作请求审计详情损坏");
    }
    return {
      assignmentId: value.assignmentId,
      target: { type: "role", id: value.target.id },
    };
  }
  if (type === "request_intaken") {
    plainObject(
      value,
      ["assignmentId", "workItemId"],
      "所有者工作请求审计详情",
    );
    if (
      !ASSIGNMENT_ID.test(value.assignmentId) ||
      !WORK_ITEM_ID.test(value.workItemId)
    ) {
      throw stateError("所有者工作请求审计详情损坏");
    }
    return {
      assignmentId: value.assignmentId,
      workItemId: value.workItemId,
    };
  }
  throw stateError("所有者工作请求审计类型损坏");
}

function normalizeAudit(value, requestId, expectedSequence) {
  plainObject(value, AUDIT_KEYS, "所有者工作请求审计记录");
  const at = timestamp(value.at, "所有者工作请求审计时间");
  if (
    value.requestId !== requestId ||
    value.sequence !== expectedSequence ||
    !["request_staged", "request_routed", "request_intaken"].includes(
      value.type,
    )
  ) {
    throw stateError("所有者工作请求审计顺序损坏");
  }
  const content = {
    requestId,
    sequence: value.sequence,
    type: value.type,
    at,
    details: auditDetails(value.type, value.details),
  };
  const contentDigest = ownerWorkRequestDigest(content);
  if (
    value.contentDigest !== contentDigest ||
    value.auditId !== `owner-work-audit-${contentDigest}`
  ) {
    throw stateError("所有者工作请求审计摘要损坏");
  }
  return { ...content, contentDigest, auditId: value.auditId };
}

function expectedAuditTypes(phase) {
  return PHASES.slice(0, PHASES.indexOf(phase) + 1).map((value) =>
    ({
      staged: "request_staged",
      routed: "request_routed",
      intaken: "request_intaken",
    })[value]
  );
}

export function normalizeOwnerWorkRequestRecord(value) {
  plainObject(value, RECORD_KEYS, "所有者工作请求记录");
  let request;
  let event;
  try {
    request = normalizeStoredOwnerWorkRequest(value.request);
    event = normalizeStoredWorkflowEvent(value.event);
  } catch (cause) {
    throw stateError("所有者工作请求内容损坏", { cause });
  }
  const createdAt = timestamp(value.createdAt, "所有者工作请求创建时间");
  const updatedAt = timestamp(value.updatedAt, "所有者工作请求更新时间");
  const requestDigest = ownerWorkRequestDigest(request);
  if (
    value.requestId !== request.requestId ||
    value.requestDigest !== requestDigest ||
    !ownerWorkRequestEventMatches(request, event, createdAt) ||
    !PHASES.includes(value.phase) ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    throw stateError("所有者工作请求绑定损坏");
  }
  const assignment = normalizeAssignment(value.assignment, event);
  const workItemId = value.workItemId;
  const phaseIndex = PHASES.indexOf(value.phase);
  if (
    (phaseIndex === 0 && (assignment !== null || workItemId !== null)) ||
    (phaseIndex === 1 && (assignment === null || workItemId !== null)) ||
    (phaseIndex === 2 && (assignment === null || !WORK_ITEM_ID.test(workItemId)))
  ) {
    throw stateError("所有者工作请求阶段损坏");
  }
  const audit = denseArray(value.audit, PHASES.length, "所有者工作请求审计")
    .map((entry, index) => normalizeAudit(entry, request.requestId, index + 1));
  const types = expectedAuditTypes(value.phase);
  if (
    audit.length !== types.length ||
    audit.some((entry, index) => entry.type !== types[index]) ||
    audit.some(
      (entry, index) =>
        index > 0 && Date.parse(entry.at) < Date.parse(audit[index - 1].at),
    ) ||
    audit[0]?.details.requestDigest !== requestDigest ||
    audit[0]?.details.eventId !== event.eventId ||
    (assignment !== null &&
      (audit[1]?.details.assignmentId !== assignment.assignmentId ||
        !sameValue(audit[1]?.details.target, assignment.target))) ||
    (workItemId !== null &&
      (audit[2]?.details.assignmentId !== assignment.assignmentId ||
        audit[2]?.details.workItemId !== workItemId)) ||
    updatedAt !== audit.at(-1)?.at
  ) {
    throw stateError("所有者工作请求审计链损坏");
  }
  const content = {
    requestId: request.requestId,
    requestDigest,
    request: structuredClone(request),
    event: structuredClone(event),
    phase: value.phase,
    assignment,
    workItemId,
    createdAt,
    updatedAt,
    audit,
  };
  const recordDigest = ownerWorkRequestDigest(content);
  if (value.recordDigest !== recordDigest) {
    throw stateError("所有者工作请求记录摘要损坏");
  }
  return { ...content, recordDigest };
}

export function emptyOwnerWorkRequestState() {
  const content = { schemaVersion: 1, revision: 0, records: [] };
  return { ...content, stateDigest: ownerWorkRequestDigest(content) };
}

export function normalizeOwnerWorkRequestState(value) {
  plainObject(value, STATE_KEYS, "所有者工作请求状态");
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    throw stateError("所有者工作请求状态版本损坏");
  }
  const records = denseArray(
    value.records,
    OWNER_WORK_REQUEST_MAX_RECORDS,
    "所有者工作请求记录集合",
  ).map(normalizeOwnerWorkRequestRecord);
  if (new Set(records.map(({ requestId }) => requestId)).size !== records.length) {
    throw stateError("所有者工作请求 ID 重复");
  }
  const content = { schemaVersion: 1, revision: value.revision, records };
  const stateDigest = ownerWorkRequestDigest(content);
  const normalized = { ...content, stateDigest };
  if (
    value.stateDigest !== stateDigest ||
    Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_STATE_BYTES
  ) {
    throw stateError("所有者工作请求状态摘要或大小损坏");
  }
  return normalized;
}

function auditRecord(requestId, sequence, type, at, details) {
  const content = { requestId, sequence, type, at, details };
  const contentDigest = ownerWorkRequestDigest(content);
  return {
    requestId,
    sequence,
    type,
    at,
    details,
    contentDigest,
    auditId: `owner-work-audit-${contentDigest}`,
  };
}

function identifiedRecord(content) {
  return {
    ...content,
    recordDigest: ownerWorkRequestDigest(content),
  };
}

export function createStagedOwnerWorkRequestRecord(requestValue, event, at) {
  const request = normalizeOwnerWorkRequest(requestValue);
  const requestDigest = ownerWorkRequestDigest(request);
  const content = {
    requestId: request.requestId,
    requestDigest,
    request: structuredClone(request),
    event: structuredClone(event),
    phase: "staged",
    assignment: null,
    workItemId: null,
    createdAt: at,
    updatedAt: at,
    audit: [
      auditRecord(request.requestId, 1, "request_staged", at, {
        requestDigest,
        eventId: event.eventId,
      }),
    ],
  };
  return normalizeOwnerWorkRequestRecord(identifiedRecord(content));
}

export function routeOwnerWorkRequestRecord(recordValue, assignment, at) {
  const record = normalizeOwnerWorkRequestRecord(recordValue);
  if (record.phase !== "staged") return record;
  const selected = {
    assignmentId: assignment.assignmentId,
    eventId: assignment.eventId,
    target: structuredClone(assignment.target),
    configVersion: assignment.configVersion,
    configDigest: assignment.configDigest,
    ruleId: assignment.ruleId,
  };
  const content = {
    ...record,
    phase: "routed",
    assignment: selected,
    updatedAt: at,
    audit: [
      ...record.audit,
      auditRecord(record.requestId, 2, "request_routed", at, {
        assignmentId: selected.assignmentId,
        target: structuredClone(selected.target),
      }),
    ],
  };
  delete content.recordDigest;
  return normalizeOwnerWorkRequestRecord(identifiedRecord(content));
}

export function intakeOwnerWorkRequestRecord(recordValue, workItemId, at) {
  const record = normalizeOwnerWorkRequestRecord(recordValue);
  if (record.phase === "intaken") return record;
  if (record.phase !== "routed") {
    throw stateError("所有者工作请求不能越过路由阶段");
  }
  const content = {
    ...record,
    phase: "intaken",
    workItemId,
    updatedAt: at,
    audit: [
      ...record.audit,
      auditRecord(record.requestId, 3, "request_intaken", at, {
        assignmentId: record.assignment.assignmentId,
        workItemId,
      }),
    ],
  };
  delete content.recordDigest;
  return normalizeOwnerWorkRequestRecord(identifiedRecord(content));
}

export function nextOwnerWorkRequestState(previous, records) {
  const content = {
    schemaVersion: 1,
    revision: previous.revision + 1,
    records: records.map((record) => structuredClone(record)),
  };
  return normalizeOwnerWorkRequestState({
    ...content,
    stateDigest: ownerWorkRequestDigest(content),
  });
}
