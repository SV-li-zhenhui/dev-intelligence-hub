import {
  cloneWorkflowValue,
  isPlainWorkflowObject,
  prettySerializedWorkflowBytes,
  workflowServiceError,
} from "./workflow-routing-values.js";

const TOP_LEVEL_ARRAY_INDENT = "    ";

function indentedArrayElementBytes(value) {
  const indented = JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `${TOP_LEVEL_ARRAY_INDENT}${line}`)
    .join("\n");
  return Buffer.byteLength(indented, "utf8");
}

function recordsByEvent(records) {
  const index = new Map();
  for (const record of records) {
    const related = index.get(record.eventId) || [];
    related.push(record);
    index.set(record.eventId, related);
  }
  return index;
}

function workflowBundles(state) {
  const assignments = recordsByEvent(state.assignments);
  const assignmentFeed = recordsByEvent(state.assignmentFeed || []);
  const audit = recordsByEvent(state.audit);
  const hasAssignmentFeed = Array.isArray(state.assignmentFeed);
  return state.events.map((event) => ({
    event,
    assignments: assignments.get(event.eventId) || [],
    ...(hasAssignmentFeed
      ? { assignmentFeed: assignmentFeed.get(event.eventId) || [] }
      : {}),
    audit: audit.get(event.eventId) || [],
  }));
}

function bundleBytes(bundle) {
  return prettySerializedWorkflowBytes(bundle);
}

function assertByteLimit(value, maximum, code, message) {
  if (prettySerializedWorkflowBytes(value) > maximum) {
    throw workflowServiceError(code, message, 409);
  }
}

export function assertWorkflowStateCapacity(
  state,
  { stateByteBudget, auditByteBudget, bundleByteBudget },
) {
  for (const entry of state.audit) {
    assertByteLimit(
      entry,
      auditByteBudget,
      "WORKFLOW_AUDIT_TOO_LARGE",
      "单条工作流审计超过安全字节上限",
    );
  }
  for (const bundle of workflowBundles(state)) {
    assertByteLimit(
      bundle,
      bundleByteBudget,
      "WORKFLOW_BUNDLE_TOO_LARGE",
      "单个工作流事件事务包超过安全字节上限",
    );
  }
  if (prettySerializedWorkflowBytes(state) > stateByteBudget) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CAPACITY_EXCEEDED",
      "工作流持久状态超过安全字节上限",
      409,
    );
  }
}

function removedArrayBytes(totalCount, removedCount, removedElementBytes) {
  if (removedCount === 0) return 0;
  const separators =
    removedCount === totalCount
      ? Math.max(0, totalCount - 1)
      : removedCount;
  const emptyArrayStructuralBytes = removedCount === totalCount ? 4 : 0;
  return removedElementBytes + separators * 2 + emptyArrayStructuralBytes;
}

function limitsSatisfied({
  state,
  removed,
  initialBytes,
  recordLimit,
  stateByteBudget,
}) {
  const remainingEvents = state.events.length - removed.events.count;
  const remainingAssignments =
    state.assignments.length - removed.assignments.count;
  const remainingAssignmentFeed = Array.isArray(state.assignmentFeed)
    ? state.assignmentFeed.length - removed.assignmentFeed.count
    : 0;
  const remainingAudit = state.audit.length - removed.audit.count;
  const removedBytes =
    removedArrayBytes(
      state.events.length,
      removed.events.count,
      removed.events.bytes,
    ) +
    removedArrayBytes(
      state.assignments.length,
      removed.assignments.count,
      removed.assignments.bytes,
    ) +
    (Array.isArray(state.assignmentFeed)
      ? removedArrayBytes(
          state.assignmentFeed.length,
          removed.assignmentFeed.count,
          removed.assignmentFeed.bytes,
        )
      : 0) +
    removedArrayBytes(
      state.audit.length,
      removed.audit.count,
      removed.audit.bytes,
    );
  const oldestSequenceByteDelta = Array.isArray(state.assignmentFeed)
    ? Buffer.byteLength(
        JSON.stringify(
          state.assignmentFeed[removed.assignmentFeed.count]?.sequence ||
            state.assignmentHighWatermark + 1,
        ),
        "utf8",
      ) -
      Buffer.byteLength(
        JSON.stringify(state.assignmentOldestAvailableSequence),
        "utf8",
      )
    : 0;
  return (
    remainingEvents <= recordLimit &&
    remainingAssignments <= recordLimit &&
    remainingAssignmentFeed <= recordLimit &&
    remainingAudit <= recordLimit &&
    initialBytes - removedBytes + oldestSequenceByteDelta <= stateByteBudget
  );
}

function addRemoved(removed, name, records) {
  removed[name].count += records.length;
  removed[name].bytes += records.reduce(
    (total, record) => total + indentedArrayElementBytes(record),
    0,
  );
}

export function retainWorkflowState(
  state,
  {
    protectedEventIds = new Set(),
    recordLimit,
    stateByteBudget,
    auditByteBudget,
    bundleByteBudget,
  },
) {
  const bundles = workflowBundles(state);
  let mandatoryDropThrough = -1;
  for (let index = 0; index < bundles.length; index += 1) {
    const bundle = bundles[index];
    const oversizedAudit = bundle.audit.some(
      (entry) => prettySerializedWorkflowBytes(entry) > auditByteBudget,
    );
    const oversizedBundle = bundleBytes(bundle) > bundleByteBudget;
    if (!oversizedAudit && !oversizedBundle) continue;
    if (protectedEventIds.has(bundle.event.eventId)) {
      throw workflowServiceError(
        oversizedAudit ? "WORKFLOW_AUDIT_TOO_LARGE" : "WORKFLOW_BUNDLE_TOO_LARGE",
        oversizedAudit
          ? "新工作流审计超过安全字节上限"
          : "新工作流事件事务包超过安全字节上限",
        409,
      );
    }
    mandatoryDropThrough = index;
  }

  const initialBytes = prettySerializedWorkflowBytes(state);
  const removed = {
    events: { count: 0, bytes: 0 },
    assignments: { count: 0, bytes: 0 },
    assignmentFeed: { count: 0, bytes: 0 },
    audit: { count: 0, bytes: 0 },
  };
  const droppedEventIds = new Set();
  let examinedBundles = 0;
  for (let index = 0; index < bundles.length; index += 1) {
    if (
      index > mandatoryDropThrough &&
      limitsSatisfied({
        state,
        removed,
        initialBytes,
        recordLimit,
        stateByteBudget,
      })
    ) {
      break;
    }
    const bundle = bundles[index];
    examinedBundles += 1;
    if (protectedEventIds.has(bundle.event.eventId)) {
      throw workflowServiceError(
        "WORKFLOW_RETENTION_LIMIT",
        "新工作流事务无法在安全容量内完整保留",
        409,
      );
    }
    droppedEventIds.add(bundle.event.eventId);
    addRemoved(removed, "events", [bundle.event]);
    addRemoved(removed, "assignments", bundle.assignments);
    addRemoved(removed, "assignmentFeed", bundle.assignmentFeed || []);
    addRemoved(removed, "audit", bundle.audit);
  }

  if (
    !limitsSatisfied({
      state,
      removed,
      initialBytes,
      recordLimit,
      stateByteBudget,
    })
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CAPACITY_EXCEEDED",
      "配置、快照与历史超过工作流安全容量",
      409,
    );
  }
  const retainedAssignmentFeed = Array.isArray(state.assignmentFeed)
    ? state.assignmentFeed.filter(
        (entry) => !droppedEventIds.has(entry.eventId),
      )
    : null;
  const retained = {
    ...state,
    events: state.events.filter(
      (event) => !droppedEventIds.has(event.eventId),
    ),
    assignments: state.assignments.filter(
      (assignment) => !droppedEventIds.has(assignment.eventId),
    ),
    ...(retainedAssignmentFeed
      ? {
          assignmentFeed: retainedAssignmentFeed,
          assignmentOldestAvailableSequence:
            retainedAssignmentFeed[0]?.sequence ||
            state.assignmentHighWatermark + 1,
        }
      : {}),
    audit: state.audit.filter(
      (entry) => !droppedEventIds.has(entry.eventId),
    ),
  };
  assertWorkflowStateCapacity(retained, {
    stateByteBudget,
    auditByteBudget,
    bundleByteBudget,
  });
  return {
    state: retained,
    stats: Object.freeze({
      examinedBundles,
      droppedBundles: droppedEventIds.size,
      initialBytes,
      retainedBytes: prettySerializedWorkflowBytes(retained),
    }),
  };
}

export function retainWorkflowConfigHistory(
  state,
  appendedEntry,
  configHistoryLimit,
) {
  const history = [...state.configHistory, appendedEntry];
  if (history.length <= configHistoryLimit) return history;
  const overflow = history.slice(0, history.length - configHistoryLimit);
  const referencedConfigs = new Set([
    ...state.assignments.map(
      (assignment) =>
        `${assignment.configVersion}:${assignment.configDigest}`,
    ),
    ...state.audit.map(
      (entry) => `${entry.configVersion}:${entry.configDigest}`,
    ),
  ]);
  if (
    overflow.some((entry) =>
      referencedConfigs.has(`${entry.version}:${entry.digest}`),
    )
  ) {
    throw workflowServiceError(
      "WORKFLOW_CONFIG_RETENTION_LIMIT",
      "配置历史已达到安全保留上限，请先归档关联记录",
      409,
    );
  }
  return history.slice(-configHistoryLimit);
}

function queryOptions(value = {}) {
  if (!isPlainWorkflowObject(value)) {
    throw workflowServiceError(
      "WORKFLOW_QUERY_INVALID",
      "工作流查询参数无效",
    );
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["cursor", "limit"].includes(key))) {
    throw workflowServiceError(
      "WORKFLOW_QUERY_INVALID",
      "工作流查询参数无效",
    );
  }
  const limit = value.limit === undefined ? 50 : Number(value.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw workflowServiceError(
      "WORKFLOW_QUERY_INVALID",
      "工作流查询条数无效",
    );
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw workflowServiceError(
      "WORKFLOW_CURSOR_INVALID",
      "工作流游标无效",
    );
  }
  return { cursor: value.cursor || null, limit: Math.min(limit, 100) };
}

export function pageWorkflowRecords(records, idName, options) {
  const { cursor, limit } = queryOptions(options);
  const newest = [...records].reverse();
  let start = 0;
  if (cursor) {
    const cursorIndex = newest.findIndex((record) => record[idName] === cursor);
    if (cursorIndex < 0) {
      throw workflowServiceError(
        "WORKFLOW_CURSOR_INVALID",
        "工作流游标已失效",
        400,
      );
    }
    start = cursorIndex + 1;
  }
  const items = newest.slice(start, start + limit).map(cloneWorkflowValue);
  return {
    items,
    nextCursor:
      start + items.length < newest.length && items.length
        ? items.at(-1)[idName]
        : null,
  };
}
