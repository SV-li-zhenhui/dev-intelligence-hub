import { createHash } from "node:crypto";
import { normalizeWorkIntent } from "../domain/work-intent.js";
import {
  boundedLedgerString,
  canonicalLedgerValue,
  cloneLedgerValue,
  hasExactLedgerKeys,
  ledgerDigest,
  normalizeLedgerTarget,
  normalizeLedgerTimestamp,
  normalizeOptionalLedgerReason,
  prettySerializedLedgerBytes,
  SHA256_PATTERN,
  validatePositiveLimit,
  workLedgerError,
  WORK_LEDGER_OUTBOX_STATUSES,
  WORK_LEDGER_STATUSES,
} from "./work-ledger-values.js";
import {
  createDefaultWorkGraphMetadata,
  normalizeWorkLedgerGraphItems,
} from "./work-ledger-graph.js";

export const WORK_LEDGER_STATE_KEY = "work-ledger-state";
export const WORK_LEDGER_STATE_SCHEMA_VERSION = 3;
export const MAX_WORK_LEDGER_ITEMS = 5_000;
export const MAX_WORK_LEDGER_TIMELINE = 20_000;
export const MAX_WORK_LEDGER_OUTBOX = 5_000;
export const MAX_WORK_LEDGER_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_WORK_LEDGER_ITEM_BYTES = 512 * 1024;
export const MAX_WORK_LEDGER_TIMELINE_BYTES = 64 * 1024;
export const MAX_WORK_LEDGER_INTENT_BYTES = 64 * 1024;

export const WORK_LEDGER_TIMELINE_TYPES = new Set([
  "assignment_intaken",
  "intake_completed",
  "intake_gap",
  "claimed",
  "lease_expired",
  "transitioned",
  "retry_scheduled",
  "handed_off",
  "completed",
  "intent_staged",
  "intent_claimed",
  "intent_lease_expired",
  "intent_acknowledged",
  "attention_answer_applied",
  "attention_rejection_applied",
  "proposal_result_applied",
  "condition_satisfied",
]);

const ITEM_KEYS = [
  "itemId",
  "kind",
  "assignmentId",
  "sourceSequence",
  "inputDigest",
  "assignment",
  "event",
  "graph",
  "currentTarget",
  "activeIntentId",
  "decisionContext",
  "status",
  "revision",
  "ownerId",
  "leaseId",
  "leaseUntil",
  "attempt",
  "availableAt",
  "statusReason",
  "createdAt",
  "updatedAt",
];
const TIMELINE_KEYS = [
  "timelineId",
  "contentDigest",
  "sequence",
  "itemId",
  "type",
  "at",
  "actorId",
  "details",
];
const OUTBOX_KEYS = [
  "intentId",
  "intentDigest",
  "itemId",
  "inputDigest",
  "requestedBy",
  "intent",
  "status",
  "revision",
  "attempt",
  "dispatcherId",
  "dispatchLeaseId",
  "dispatchLeaseUntil",
  "outcome",
  "createdAt",
  "updatedAt",
];

export function normalizeWorkLedgerLimits(overrides = {}) {
  if (
    overrides === null ||
    typeof overrides !== "object" ||
    Array.isArray(overrides)
  ) {
    throw new TypeError("limits must be an object");
  }
  const known = new Set([
    "itemLimit",
    "timelineLimit",
    "outboxLimit",
    "stateByteBudget",
    "itemByteBudget",
    "timelineByteBudget",
    "intentByteBudget",
  ]);
  if (Object.keys(overrides).some((key) => !known.has(key))) {
    throw new TypeError("limits contains an unknown field");
  }
  return Object.freeze({
    itemLimit: validatePositiveLimit(
      overrides.itemLimit ?? MAX_WORK_LEDGER_ITEMS,
      MAX_WORK_LEDGER_ITEMS,
      "itemLimit",
    ),
    timelineLimit: validatePositiveLimit(
      overrides.timelineLimit ?? MAX_WORK_LEDGER_TIMELINE,
      MAX_WORK_LEDGER_TIMELINE,
      "timelineLimit",
    ),
    outboxLimit: validatePositiveLimit(
      overrides.outboxLimit ?? MAX_WORK_LEDGER_OUTBOX,
      MAX_WORK_LEDGER_OUTBOX,
      "outboxLimit",
    ),
    stateByteBudget: validatePositiveLimit(
      overrides.stateByteBudget ?? MAX_WORK_LEDGER_STATE_BYTES,
      MAX_WORK_LEDGER_STATE_BYTES,
      "stateByteBudget",
    ),
    itemByteBudget: validatePositiveLimit(
      overrides.itemByteBudget ?? MAX_WORK_LEDGER_ITEM_BYTES,
      MAX_WORK_LEDGER_ITEM_BYTES,
      "itemByteBudget",
    ),
    timelineByteBudget: validatePositiveLimit(
      overrides.timelineByteBudget ?? MAX_WORK_LEDGER_TIMELINE_BYTES,
      MAX_WORK_LEDGER_TIMELINE_BYTES,
      "timelineByteBudget",
    ),
    intentByteBudget: validatePositiveLimit(
      overrides.intentByteBudget ?? MAX_WORK_LEDGER_INTENT_BYTES,
      MAX_WORK_LEDGER_INTENT_BYTES,
      "intentByteBudget",
    ),
  });
}

export function emptyWorkLedgerState() {
  return {
    schemaVersion: WORK_LEDGER_STATE_SCHEMA_VERSION,
    revision: 0,
    intakeCursor: 0,
    sourceHighWatermark: 0,
    attentionCursor: 0,
    attentionHighWatermark: 0,
    proposalCursor: 0,
    proposalHighWatermark: 0,
    timelineStartSequence: 1,
    nextTimelineSequence: 1,
    items: [],
    timeline: [],
    outbox: [],
  };
}

const DECISION_CONTEXT_SOURCES = new Set([
  "attention",
  "condition",
  "proposal",
]);
const DECISION_CONTEXT_OUTCOMES = new Set([
  "answered",
  "rejected",
  "satisfied",
  "succeeded",
  "stale",
  "failed",
  "unknown",
]);

export function createWorkDecisionContext({
  source,
  referenceId,
  outcome,
  value,
  observedAt,
}) {
  if (!DECISION_CONTEXT_SOURCES.has(source)) {
    throw workLedgerError(
      "WORK_LEDGER_DECISION_CONTEXT_INVALID",
      "决策上下文来源无效",
    );
  }
  if (
    !DECISION_CONTEXT_OUTCOMES.has(outcome) ||
    (source === "attention" && !new Set(["answered", "rejected"]).has(outcome)) ||
    (source === "condition" && outcome !== "satisfied") ||
    (source === "proposal" &&
      !new Set([
        "succeeded",
        "rejected",
        "stale",
        "failed",
        "unknown",
      ]).has(outcome))
  ) {
    throw workLedgerError(
      "WORK_LEDGER_DECISION_CONTEXT_INVALID",
      "决策上下文结果无效",
    );
  }
  const normalizedValue = canonicalLedgerValue(value, {
    maximumEntries: 500,
    maximumDepth: 12,
    maximumStringBytes: 4 * 1024,
    errorCode: "WORK_LEDGER_DECISION_CONTEXT_INVALID",
  });
  const core = {
    source,
    referenceId: boundedLedgerString(referenceId, "referenceId", 192),
    outcome,
    value: normalizedValue,
    observedAt: normalizeLedgerTimestamp(observedAt, "observedAt"),
  };
  const context = { ...core, contentDigest: ledgerDigest(core) };
  if (prettySerializedLedgerBytes(context) > 8 * 1024) {
    throw workLedgerError(
      "WORK_LEDGER_DECISION_CONTEXT_INVALID",
      "决策上下文超过容量限制",
    );
  }
  return context;
}

function normalizeDecisionContext(value) {
  if (value === null) return null;
  if (
    !hasExactLedgerKeys(value, [
      "source",
      "referenceId",
      "outcome",
      "value",
      "observedAt",
      "contentDigest",
    ])
  ) {
    throw corrupted("员工工作项决策上下文字段损坏");
  }
  let normalized;
  try {
    normalized = createWorkDecisionContext(value);
  } catch {
    throw corrupted("员工工作项决策上下文损坏");
  }
  if (normalized.contentDigest !== value.contentDigest) {
    throw corrupted("员工工作项决策上下文摘要损坏");
  }
  return normalized;
}

function corrupted(message) {
  return workLedgerError("WORK_LEDGER_STATE_CORRUPTED", message, 503);
}

function canonicalStoredValue(value, message) {
  try {
    return canonicalLedgerValue(value, {
      maximumEntries: 30_000,
      errorCode: "WORK_LEDGER_STATE_CORRUPTED",
    });
  } catch {
    throw corrupted(message);
  }
}

function timestamp(value, name) {
  try {
    return normalizeLedgerTimestamp(value, name);
  } catch {
    throw corrupted(`${name} 损坏`);
  }
}

function safeString(value, name, maximumBytes = 256) {
  try {
    return boundedLedgerString(value, name, maximumBytes);
  } catch {
    throw corrupted(`${name} 损坏`);
  }
}

function optionalString(value, name, maximumBytes = 256) {
  return value === null ? null : safeString(value, name, maximumBytes);
}

function denseLedgerArrayValues(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return null;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return null;
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    entries.push(descriptor.value);
  }
  return entries;
}

function workItemCapacityView(item) {
  const baseItem = { ...item };
  delete baseItem.graph;
  return baseItem;
}

function workLedgerCapacityView(state) {
  // Preserve the legacy ledger budget while the graph contract enforces its
  // own independent task, structure, delivery, and total-byte hard limits.
  return {
    ...state,
    items: state.items.map(workItemCapacityView),
  };
}

function normalizeItem(value, stateRevision, limits) {
  if (!hasExactLedgerKeys(value, ITEM_KEYS)) {
    throw corrupted("员工工作项字段损坏");
  }
  const assignment = canonicalStoredValue(value.assignment, "分派内容损坏");
  const event = canonicalStoredValue(value.event, "分派事件损坏");
  const graph = canonicalStoredValue(value.graph, "工作图元数据损坏");
  const assignmentId = safeString(value.assignmentId, "assignmentId", 192);
  if (
    assignment.assignmentId !== assignmentId ||
    !assignment.target ||
    (assignment.eventId !== undefined &&
      event.eventId !== undefined &&
      assignment.eventId !== event.eventId)
  ) {
    throw corrupted("员工工作项输入引用不一致");
  }
  let originalTarget;
  let currentTarget;
  try {
    originalTarget = normalizeLedgerTarget(assignment.target);
    currentTarget = normalizeLedgerTarget(value.currentTarget);
  } catch {
    throw corrupted("员工工作项目标损坏");
  }
  assignment.target = originalTarget;
  const inputDigest = ledgerDigest({ assignment, event }, {
    maximumEntries: 30_000,
    errorCode: "WORK_LEDGER_STATE_CORRUPTED",
  });
  const expectedItemId = `work-item-${ledgerDigest({
    assignmentId,
    inputDigest,
  })}`;
  if (
    value.inputDigest !== inputDigest ||
    value.itemId !== expectedItemId ||
    !["assignment", "system_alert"].includes(value.kind) ||
    !Number.isSafeInteger(value.sourceSequence) ||
    value.sourceSequence < 0 ||
    (value.kind === "assignment" && value.sourceSequence < 1) ||
    (value.kind === "system_alert" && value.sourceSequence !== 0) ||
    !WORK_LEDGER_STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > stateRevision ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  ) {
    throw corrupted("员工工作项状态损坏");
  }
  const ownerId = optionalString(value.ownerId, "ownerId", 128);
  const leaseId = optionalString(value.leaseId, "leaseId", 128);
  const leaseUntil = value.leaseUntil === null
    ? null
    : timestamp(value.leaseUntil, "leaseUntil");
  const availableAt = value.availableAt === null
    ? null
    : timestamp(value.availableAt, "availableAt");
  const activeIntentId = optionalString(
    value.activeIntentId,
    "activeIntentId",
    192,
  );
  const working = value.status === "working";
  if (
    working !== (ownerId !== null && leaseId !== null && leaseUntil !== null) ||
    (value.status === "retry_wait") !== (availableAt !== null) ||
    (value.kind === "system_alert" && value.status !== "blocked")
  ) {
    throw corrupted("员工工作项租约或等待状态损坏");
  }
  let statusReason;
  try {
    statusReason = normalizeOptionalLedgerReason(value.statusReason, "statusReason");
  } catch {
    throw corrupted("员工工作项原因损坏");
  }
  const item = {
    itemId: value.itemId,
    kind: value.kind,
    assignmentId,
    sourceSequence: value.sourceSequence,
    inputDigest,
    assignment,
    event,
    graph,
    currentTarget,
    activeIntentId,
    decisionContext: normalizeDecisionContext(value.decisionContext),
    status: value.status,
    revision: value.revision,
    ownerId,
    leaseId,
    leaseUntil,
    attempt: value.attempt,
    availableAt,
    statusReason,
    createdAt: timestamp(value.createdAt, "createdAt"),
    updatedAt: timestamp(value.updatedAt, "updatedAt"),
  };
  if (
    Date.parse(item.updatedAt) < Date.parse(item.createdAt) ||
    prettySerializedLedgerBytes(workItemCapacityView(item)) >
      limits.itemByteBudget
  ) {
    throw corrupted("员工工作项超过容量或时间顺序损坏");
  }
  return item;
}

function normalizeTimelineEntry(value, stateRevision, limits) {
  if (!hasExactLedgerKeys(value, TIMELINE_KEYS)) {
    throw corrupted("员工工作时间线字段损坏");
  }
  const { timelineId, contentDigest, ...content } = value;
  const normalizedContent = canonicalStoredValue(content, "员工工作时间线损坏");
  const expectedDigest = ledgerDigest(normalizedContent);
  if (
    timelineId !== `work-timeline-${expectedDigest}` ||
    contentDigest !== expectedDigest ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !WORK_LEDGER_TIMELINE_TYPES.has(value.type) ||
    (value.itemId !== null && typeof value.itemId !== "string") ||
    value.sequence > stateRevision * 100_000 + 100_000
  ) {
    throw corrupted("员工工作时间线摘要或类型损坏");
  }
  const entry = {
    timelineId,
    contentDigest,
    sequence: value.sequence,
    itemId: value.itemId === null ? null : safeString(value.itemId, "itemId", 192),
    type: value.type,
    at: timestamp(value.at, "timeline.at"),
    actorId: optionalString(value.actorId, "actorId", 128),
    details: canonicalStoredValue(value.details, "时间线详情损坏"),
  };
  if (prettySerializedLedgerBytes(entry) > limits.timelineByteBudget) {
    throw corrupted("员工工作时间线超过容量");
  }
  return entry;
}

function normalizeIntent(value) {
  try {
    return normalizeWorkIntent(value);
  } catch {
    throw corrupted("员工工作意图类型损坏");
  }
}

function normalizeRequestedBy(value) {
  if (!hasExactLedgerKeys(value, ["roleId", "workerId"])) {
    throw corrupted("员工工作意图请求身份损坏");
  }
  return {
    roleId: safeString(value.roleId, "requestedBy.roleId", 128),
    workerId: safeString(value.workerId, "requestedBy.workerId", 128),
  };
}

function normalizeOutboxEntry(value, stateRevision, limits) {
  if (!hasExactLedgerKeys(value, OUTBOX_KEYS)) {
    throw corrupted("员工工作 outbox 字段损坏");
  }
  const intent = normalizeIntent(value.intent);
  const requestedBy = normalizeRequestedBy(value.requestedBy);
  const itemId = safeString(value.itemId, "outbox.itemId", 192);
  const inputDigest = value.inputDigest;
  const intentDigest = ledgerDigest({ itemId, inputDigest, requestedBy, intent });
  if (
    value.intentDigest !== intentDigest ||
    value.intentId !== `work-intent-${intentDigest}` ||
    !SHA256_PATTERN.test(inputDigest) ||
    !WORK_LEDGER_OUTBOX_STATUSES.has(value.status) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    value.revision > stateRevision ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  ) {
    throw corrupted("员工工作 outbox 摘要或状态损坏");
  }
  const dispatcherId = optionalString(value.dispatcherId, "dispatcherId", 128);
  const dispatchLeaseId = optionalString(
    value.dispatchLeaseId,
    "dispatchLeaseId",
    128,
  );
  const dispatchLeaseUntil = value.dispatchLeaseUntil === null
    ? null
    : timestamp(value.dispatchLeaseUntil, "dispatchLeaseUntil");
  const dispatching = value.status === "dispatching";
  if (
    dispatching !==
    (dispatcherId !== null &&
      dispatchLeaseId !== null &&
      dispatchLeaseUntil !== null) ||
    (["pending", "dispatching"].includes(value.status) !==
      (value.outcome === null))
  ) {
    throw corrupted("员工工作 outbox 租约或结果损坏");
  }
  const entry = {
    intentId: value.intentId,
    intentDigest,
    itemId,
    inputDigest,
    requestedBy,
    intent,
    status: value.status,
    revision: value.revision,
    attempt: value.attempt,
    dispatcherId,
    dispatchLeaseId,
    dispatchLeaseUntil,
    outcome: value.outcome === null
      ? null
      : canonicalStoredValue(value.outcome, "outbox 结果损坏"),
    createdAt: timestamp(value.createdAt, "outbox.createdAt"),
    updatedAt: timestamp(value.updatedAt, "outbox.updatedAt"),
  };
  if (prettySerializedLedgerBytes(entry.intent) > limits.intentByteBudget) {
    throw corrupted("员工工作意图超过容量");
  }
  return entry;
}

function assertUnique(records, field, message) {
  const values = records.map((record) => record[field]);
  if (new Set(values).size !== values.length) throw corrupted(message);
}

export function assertWorkLedgerCapacity(state, limits) {
  if (
    state.items.length > limits.itemLimit ||
    state.timeline.length > limits.timelineLimit ||
    state.outbox.length > limits.outboxLimit ||
    state.items.some(
      (item) =>
        prettySerializedLedgerBytes(workItemCapacityView(item)) >
        limits.itemByteBudget,
    ) ||
    state.timeline.some(
      (entry) => prettySerializedLedgerBytes(entry) > limits.timelineByteBudget,
    ) ||
    state.outbox.some(
      (entry) => prettySerializedLedgerBytes(entry.intent) > limits.intentByteBudget,
    ) ||
    prettySerializedLedgerBytes(workLedgerCapacityView(state)) >
      limits.stateByteBudget
  ) {
    throw workLedgerError(
      "WORK_LEDGER_CAPACITY_EXCEEDED",
      "员工工作台账达到安全容量上限，未推进读取游标",
      409,
    );
  }
}

export function normalizeWorkLedgerPersistedState(value, limitsInput) {
  const limits = normalizeWorkLedgerLimits(limitsInput);
  if (
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
    ]) &&
    value.schemaVersion === 1
  ) {
    value = {
      ...value,
      schemaVersion: 2,
      proposalCursor: 0,
      proposalHighWatermark: 0,
    };
  }
  const schema2Items =
    hasExactLedgerKeys(value, [
      "schemaVersion",
      "revision",
      "intakeCursor",
      "sourceHighWatermark",
      "attentionCursor",
      "attentionHighWatermark",
      "proposalCursor",
      "proposalHighWatermark",
      "timelineStartSequence",
      "nextTimelineSequence",
      "items",
      "timeline",
      "outbox",
    ]) &&
    value.schemaVersion === 2
      ? denseLedgerArrayValues(value.items)
      : null;
  if (
    schema2Items !== null &&
    schema2Items.every((item) => {
      const legacyKeys = ITEM_KEYS.filter((key) => key !== "graph");
      return hasExactLedgerKeys(item, legacyKeys);
    })
  ) {
    value = {
      ...value,
      schemaVersion: WORK_LEDGER_STATE_SCHEMA_VERSION,
      items: schema2Items.map((item) => ({
        ...item,
        graph: createDefaultWorkGraphMetadata(),
      })),
    };
  }
  const hasCurrentStateFields = hasExactLedgerKeys(value, [
    "schemaVersion",
    "revision",
    "intakeCursor",
    "sourceHighWatermark",
    "attentionCursor",
    "attentionHighWatermark",
    "proposalCursor",
    "proposalHighWatermark",
    "timelineStartSequence",
    "nextTimelineSequence",
    "items",
    "timeline",
    "outbox",
  ]);
  const itemValues = hasCurrentStateFields
    ? denseLedgerArrayValues(value.items)
    : null;
  const timelineValues = hasCurrentStateFields
    ? denseLedgerArrayValues(value.timeline)
    : null;
  const outboxValues = hasCurrentStateFields
    ? denseLedgerArrayValues(value.outbox)
    : null;
  if (
    !hasCurrentStateFields ||
    value.schemaVersion !== WORK_LEDGER_STATE_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.intakeCursor) ||
    value.intakeCursor < 0 ||
    !Number.isSafeInteger(value.sourceHighWatermark) ||
    value.sourceHighWatermark < value.intakeCursor ||
    !Number.isSafeInteger(value.attentionCursor) ||
    value.attentionCursor < 0 ||
    !Number.isSafeInteger(value.attentionHighWatermark) ||
    value.attentionHighWatermark < value.attentionCursor ||
    !Number.isSafeInteger(value.proposalCursor) ||
    value.proposalCursor < 0 ||
    !Number.isSafeInteger(value.proposalHighWatermark) ||
    value.proposalHighWatermark < value.proposalCursor ||
    !Number.isSafeInteger(value.timelineStartSequence) ||
    value.timelineStartSequence < 1 ||
    !Number.isSafeInteger(value.nextTimelineSequence) ||
    value.nextTimelineSequence < value.timelineStartSequence ||
    itemValues === null ||
    timelineValues === null ||
    outboxValues === null ||
    itemValues.length > limits.itemLimit ||
    timelineValues.length > limits.timelineLimit ||
    outboxValues.length > limits.outboxLimit
  ) {
    throw corrupted("员工工作台账状态损坏");
  }
  let state = {
    schemaVersion: WORK_LEDGER_STATE_SCHEMA_VERSION,
    revision: value.revision,
    intakeCursor: value.intakeCursor,
    sourceHighWatermark: value.sourceHighWatermark,
    attentionCursor: value.attentionCursor,
    attentionHighWatermark: value.attentionHighWatermark,
    proposalCursor: value.proposalCursor,
    proposalHighWatermark: value.proposalHighWatermark,
    timelineStartSequence: value.timelineStartSequence,
    nextTimelineSequence: value.nextTimelineSequence,
    items: itemValues.map((item) => normalizeItem(item, value.revision, limits)),
    timeline: timelineValues.map((entry) =>
      normalizeTimelineEntry(entry, value.revision, limits),
    ),
    outbox: outboxValues.map((entry) =>
      normalizeOutboxEntry(entry, value.revision, limits),
    ),
  };
  try {
    state = {
      ...state,
      items: normalizeWorkLedgerGraphItems(state.items, state.revision),
    };
  } catch {
    throw corrupted("员工工作图结构损坏");
  }
  assertUnique(state.items, "itemId", "员工工作项 ID 重复");
  assertUnique(state.items, "assignmentId", "员工分派 ID 重复");
  assertUnique(
    state.items.filter(({ kind }) => kind === "assignment"),
    "sourceSequence",
    "员工分派序号重复",
  );
  assertUnique(state.timeline, "timelineId", "员工工作时间线 ID 重复");
  assertUnique(state.outbox, "intentId", "员工工作意图 ID 重复");

  const itemIndex = new Map(state.items.map((item) => [item.itemId, item]));
  for (const entry of state.timeline) {
    if (entry.itemId !== null && !itemIndex.has(entry.itemId)) {
      throw corrupted("员工工作时间线引用不存在的工作项");
    }
  }
  for (const entry of state.outbox) {
    const item = itemIndex.get(entry.itemId);
    if (!item || item.inputDigest !== entry.inputDigest) {
      throw corrupted("员工工作 outbox 引用不存在或已变化的工作项");
    }
  }
  const outboxById = new Map(
    state.outbox.map((entry) => [entry.intentId, entry]),
  );
  const activeIntentsByItem = new Map();
  for (const entry of state.outbox) {
    if (!["pending", "dispatching"].includes(entry.status)) continue;
    const item = itemIndex.get(entry.itemId);
    if (item.status !== "dispatch_pending") {
      throw corrupted("活动 outbox 与工作项状态不一致");
    }
    activeIntentsByItem.set(
      item.itemId,
      (activeIntentsByItem.get(item.itemId) || 0) + 1,
    );
  }
  if (
    state.items.some(
      (item) =>
        item.status === "dispatch_pending" &&
        activeIntentsByItem.get(item.itemId) !== 1,
    ) ||
    [...activeIntentsByItem.values()].some((count) => count !== 1)
  ) {
    throw corrupted("工作项必须恰好关联一个活动 outbox 意图");
  }
  for (const item of state.items) {
    const active = item.activeIntentId === null
      ? null
      : outboxById.get(item.activeIntentId);
    if (item.status === "dispatch_pending") {
      if (!active || !["pending", "dispatching"].includes(active.status)) {
        throw corrupted("等待分发工作项没有绑定活动意图");
      }
      continue;
    }
    if (
      new Set(["waiting_user", "waiting_condition", "waiting_external"]).has(
        item.status,
      )
    ) {
      if (item.activeIntentId === null) continue;
      if (!active || active.status !== "delivered") {
        throw corrupted("等待工作项没有绑定已交付意图");
      }
      const expectedType = item.status === "waiting_user"
        ? "ask_user"
        : item.status === "waiting_condition"
          ? "wait_condition"
          : null;
      if (expectedType && active.intent.type !== expectedType) {
        throw corrupted("等待工作项与意图类型不一致");
      }
      continue;
    }
    if (item.activeIntentId !== null) {
      throw corrupted("非等待工作项不能保留活动意图绑定");
    }
  }
  for (let index = 0; index < state.timeline.length; index += 1) {
    if (state.timeline[index].sequence !== state.timelineStartSequence + index) {
      throw corrupted("员工工作时间线序号不连续");
    }
  }
  if (
    state.nextTimelineSequence !==
    state.timelineStartSequence + state.timeline.length
  ) {
    throw corrupted("员工工作时间线检查点不一致");
  }
  try {
    assertWorkLedgerCapacity(state, limits);
  } catch {
    throw corrupted("员工工作台账超过安全容量");
  }
  return state;
}

export function workLedgerPersistedStateDigest(state) {
  return createHash("sha256")
    .update(JSON.stringify(state), "utf8")
    .digest("hex");
}

export function cloneWorkLedgerState(state) {
  return cloneLedgerValue(state);
}
