import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import { normalizeWorkflowRoutingConfig } from "../domain/workflow-router.js";
import { projectWorkflowSnapshot } from "../domain/workflow-snapshot-events.js";
import {
  isTrustedPullRequestScopeLifecycleAssignment,
} from "../domain/pull-request-scope-lifecycle.js";
import { validateWorkflowRouteResultAgainstTrustedEvaluation } from "./workflow-route-result.js";
import {
  assertWorkflowAssignmentFeedConsistency,
  MAX_WORKFLOW_ASSIGNMENT_SEQUENCE,
  migrateWorkflowAssignmentFeed,
  normalizeWorkflowAssignmentFeedEntry,
} from "./workflow-assignment-feed.js";
import {
  assertWorkflowStateCapacity,
  retainWorkflowState,
} from "./workflow-routing-retention.js";
import {
  boundedWorkflowString,
  canonicalWorkflowValue,
  cloneWorkflowValue,
  hasExactWorkflowKeys,
  largeWorkflowDigest,
  normalizeWorkflowTarget,
  normalizeWorkflowTimestamp,
  SHA256_PATTERN,
  workflowDigest,
  workflowServiceError,
  WORKFLOW_OUTCOMES,
} from "./workflow-routing-values.js";

export const WORKFLOW_STATE_KEY = "workflow-routing-state";
export const WORKFLOW_STATE_SCHEMA_VERSION = 2;
export const LEGACY_WORKFLOW_STATE_SCHEMA_VERSION = 1;
export const MAX_WORKFLOW_RECORDS = 5_000;
export const MAX_WORKFLOW_CONFIG_HISTORY = 100;
export const MAX_WORKFLOW_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_WORKFLOW_AUDIT_BYTES = 256 * 1024;
export const MAX_WORKFLOW_BUNDLE_BYTES = 1024 * 1024;

export function workflowPersistedStateDigest(state) {
  return largeWorkflowDigest(state, {
    maximumBytes: MAX_WORKFLOW_STATE_BYTES,
  });
}

export function emptyWorkflowState() {
  return {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    revision: 0,
    currentConfig: null,
    configHistory: [],
    events: [],
    assignments: [],
    assignmentFeed: [],
    assignmentHighWatermark: 0,
    assignmentOldestAvailableSequence: 1,
    audit: [],
    checkpoint: null,
    lastSnapshot: null,
  };
}

const LEGACY_STATE_KEYS = Object.freeze([
  "schemaVersion",
  "revision",
  "currentConfig",
  "configHistory",
  "events",
  "assignments",
  "audit",
  "checkpoint",
  "lastSnapshot",
]);

const CURRENT_STATE_KEYS = Object.freeze([
  "schemaVersion",
  "revision",
  "currentConfig",
  "configHistory",
  "events",
  "assignments",
  "assignmentFeed",
  "assignmentHighWatermark",
  "assignmentOldestAvailableSequence",
  "audit",
  "checkpoint",
  "lastSnapshot",
]);

export function isLegacyWorkflowPersistedState(value) {
  return (
    hasExactWorkflowKeys(value, LEGACY_STATE_KEYS) &&
    value.schemaVersion === LEGACY_WORKFLOW_STATE_SCHEMA_VERSION
  );
}

function normalizeConfigEntry(value) {
  if (
    !hasExactWorkflowKeys(value, [
      "version",
      "digest",
      "definition",
      "changedBy",
      "changedAt",
    ]) ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流配置历史损坏",
      503,
    );
  }
  const definition = normalizeWorkflowRoutingConfig(value.definition);
  if (value.digest !== workflowDigest(definition)) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流配置摘要不一致",
      503,
    );
  }
  return {
    version: value.version,
    digest: value.digest,
    definition,
    changedBy: boundedWorkflowString(value.changedBy, "changedBy", 128),
    changedAt: normalizeWorkflowTimestamp(value.changedAt),
  };
}

function normalizeIdentifiedRecord(value, idName, idPrefix) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流记录损坏",
      503,
    );
  }
  const { [idName]: recordId, contentDigest, ...content } = value;
  const expectedDigest = workflowDigest(content);
  if (
    typeof recordId !== "string" ||
    recordId !== `${idPrefix}-${expectedDigest}` ||
    contentDigest !== expectedDigest
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流记录摘要不一致",
      503,
    );
  }
  return cloneWorkflowValue(value);
}

function normalizeAssignmentRecord(value) {
  if (
    !hasExactWorkflowKeys(value, [
      "assignmentId",
      "contentDigest",
      "eventId",
      "eventType",
      "subject",
      "configVersion",
      "configDigest",
      "ruleId",
      "target",
      "priority",
      "reason",
      "createdAt",
    ])
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流分派记录损坏",
      503,
    );
  }
  const record = normalizeIdentifiedRecord(
    value,
    "assignmentId",
    "workflow-assignment",
  );
  if (
    typeof record.eventId !== "string" ||
    typeof record.eventType !== "string" ||
    !Number.isSafeInteger(record.configVersion) ||
    record.configVersion < 1 ||
    typeof record.configDigest !== "string" ||
    !SHA256_PATTERN.test(record.configDigest) ||
    !Number.isSafeInteger(record.priority) ||
    record.priority < -10_000 ||
    record.priority > 10_000
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流分派字段损坏",
      503,
    );
  }
  return {
    ...record,
    subject: canonicalWorkflowValue(record.subject),
    ruleId: boundedWorkflowString(record.ruleId, "assignment.ruleId", 128),
    target: normalizeWorkflowTarget(record.target),
    reason: boundedWorkflowString(record.reason, "assignment.reason", 2_000),
    createdAt: normalizeWorkflowTimestamp(record.createdAt),
  };
}

function normalizeAuditRecord(value) {
  if (
    !hasExactWorkflowKeys(value, [
      "auditId",
      "contentDigest",
      "eventId",
      "eventType",
      "subject",
      "configVersion",
      "configDigest",
      "outcome",
      "matchedRuleIds",
      "assignmentIds",
      "explanation",
      "createdAt",
    ])
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流审计记录损坏",
      503,
    );
  }
  const record = normalizeIdentifiedRecord(value, "auditId", "workflow-audit");
  if (
    typeof record.eventId !== "string" ||
    typeof record.eventType !== "string" ||
    !Number.isSafeInteger(record.configVersion) ||
    record.configVersion < 1 ||
    typeof record.configDigest !== "string" ||
    !SHA256_PATTERN.test(record.configDigest) ||
    !WORKFLOW_OUTCOMES.has(record.outcome) ||
    !Array.isArray(record.matchedRuleIds) ||
    !Array.isArray(record.assignmentIds)
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流审计字段损坏",
      503,
    );
  }
  const matchedRuleIds = record.matchedRuleIds.map((ruleId) =>
    boundedWorkflowString(ruleId, "audit.matchedRuleIds", 128),
  );
  const assignmentIds = record.assignmentIds.map((assignmentId) =>
    boundedWorkflowString(assignmentId, "audit.assignmentIds", 128),
  );
  if (
    new Set(matchedRuleIds).size !== matchedRuleIds.length ||
    new Set(assignmentIds).size !== assignmentIds.length
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流审计引用重复",
      503,
    );
  }
  return {
    ...record,
    subject: canonicalWorkflowValue(record.subject),
    matchedRuleIds,
    assignmentIds,
    explanation: canonicalWorkflowValue(record.explanation),
    createdAt: normalizeWorkflowTimestamp(record.createdAt),
  };
}

export function workflowConfigReference(configVersion, configDigest) {
  return `${configVersion}:${configDigest}`;
}

function assertUniqueIds(records, idName, message) {
  const ids = records.map((record) => record[idName]);
  if (new Set(ids).size !== ids.length) {
    throw workflowServiceError("WORKFLOW_STATE_CORRUPTED", message, 503);
  }
}

function assertCrossRecordConsistency(state) {
  assertUniqueIds(state.events, "eventId", "工作流事件 ID 重复");
  assertUniqueIds(state.assignments, "assignmentId", "工作流分派 ID 重复");
  assertUniqueIds(state.audit, "auditId", "工作流审计 ID 重复");
  const events = new Map(state.events.map((event) => [event.eventId, event]));
  const assignments = new Map(
    state.assignments.map((assignment) => [assignment.assignmentId, assignment]),
  );
  assertWorkflowAssignmentFeedConsistency(state, { events, assignments });
  const configs = new Map(
    state.configHistory.map((config) => [
      workflowConfigReference(config.version, config.digest),
      config,
    ]),
  );
  const assignmentsByEvent = new Map();
  for (const assignment of state.assignments) {
    const event = events.get(assignment.eventId);
    const config = configs.get(
      workflowConfigReference(
        assignment.configVersion,
        assignment.configDigest,
      ),
    );
    const rule = config?.definition.rules.find(
      (candidate) => candidate.id === assignment.ruleId,
    );
    const trustedLifecycle =
      isTrustedPullRequestScopeLifecycleAssignment(assignment, event);
    if (
      !event ||
      !config ||
      assignment.eventType !== event.eventType ||
      workflowDigest(assignment.subject) !== workflowDigest(event.subject) ||
      (!trustedLifecycle &&
        (!rule ||
          assignment.priority !== rule.priority ||
          !rule.targets.some(
            (target) =>
              target.type === assignment.target.type &&
              target.id === assignment.target.id,
          )))
    ) {
      throw workflowServiceError(
        "WORKFLOW_STATE_CORRUPTED",
        "工作流分派引用不一致",
        503,
      );
    }
    const related = assignmentsByEvent.get(event.eventId) || [];
    related.push(assignment);
    assignmentsByEvent.set(event.eventId, related);
  }

  const auditByEvent = new Map();
  for (const entry of state.audit) {
    const event = events.get(entry.eventId);
    const config = configs.get(
      workflowConfigReference(entry.configVersion, entry.configDigest),
    );
    const related = assignmentsByEvent.get(entry.eventId) || [];
    if (
      !event ||
      !config ||
      auditByEvent.has(entry.eventId) ||
      entry.eventType !== event.eventType ||
      workflowDigest(entry.subject) !== workflowDigest(event.subject) ||
      related.some(
        (assignment) =>
          assignment.configVersion !== entry.configVersion ||
          assignment.configDigest !== entry.configDigest,
      ) ||
      entry.assignmentIds.length !== related.length ||
      entry.assignmentIds.some((assignmentId) => {
        const assignment = assignments.get(assignmentId);
        return !assignment || assignment.eventId !== entry.eventId;
      })
    ) {
      throw workflowServiceError(
        "WORKFLOW_STATE_CORRUPTED",
        "工作流审计引用不一致",
        503,
      );
    }
    try {
      const ordinaryAssignments = related.filter(
        (assignment) =>
          !isTrustedPullRequestScopeLifecycleAssignment(assignment, event),
      );
      validateWorkflowRouteResultAgainstTrustedEvaluation(
        {
          outcome: entry.outcome,
          matches: entry.matchedRuleIds,
          assignments: ordinaryAssignments.map(({ ruleId, target, priority }) => ({
            ruleId,
            target,
            priority,
          })),
          explanation: entry.explanation,
        },
        {
          event,
          definition: config.definition,
          context: undefined,
        },
      );
    } catch {
      throw workflowServiceError(
        "WORKFLOW_STATE_CORRUPTED",
        "工作流审计路由结论不一致",
        503,
      );
    }
    auditByEvent.set(entry.eventId, entry);
  }
  if (
    state.events.some((event) => !auditByEvent.has(event.eventId)) ||
    state.assignments.some(
      (assignment) => !auditByEvent.has(assignment.eventId),
    )
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流事件事务包不完整",
      503,
    );
  }
}

function legacyWorkflowCapacityState(state) {
  return {
    schemaVersion: LEGACY_WORKFLOW_STATE_SCHEMA_VERSION,
    revision: state.revision,
    currentConfig: state.currentConfig,
    configHistory: state.configHistory,
    events: state.events,
    assignments: state.assignments,
    audit: state.audit,
    checkpoint: state.checkpoint,
    lastSnapshot: state.lastSnapshot,
  };
}

function normalizeWorkflowPersistedStateInternal(
  value,
  {
    recordLimit = MAX_WORKFLOW_RECORDS,
    configHistoryLimit = MAX_WORKFLOW_CONFIG_HISTORY,
    stateByteBudget = MAX_WORKFLOW_STATE_BYTES,
    auditByteBudget = MAX_WORKFLOW_AUDIT_BYTES,
    bundleByteBudget = MAX_WORKFLOW_BUNDLE_BYTES,
    issueActiveWindowDays,
  } = {},
  { allowLegacyMigrationOverflow = false } = {},
) {
  const legacy = isLegacyWorkflowPersistedState(value);
  const current =
    hasExactWorkflowKeys(value, CURRENT_STATE_KEYS) &&
    value.schemaVersion === WORKFLOW_STATE_SCHEMA_VERSION;
  if (
    (!legacy && !current) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.configHistory) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.assignments) ||
    !Array.isArray(value.audit) ||
    value.configHistory.length > configHistoryLimit ||
    value.events.length > recordLimit ||
    value.assignments.length > recordLimit ||
    value.audit.length > recordLimit ||
    (current &&
      (!Array.isArray(value.assignmentFeed) ||
        value.assignmentFeed.length > recordLimit ||
        !Number.isSafeInteger(value.assignmentHighWatermark) ||
        value.assignmentHighWatermark < 0 ||
        value.assignmentHighWatermark > MAX_WORKFLOW_ASSIGNMENT_SEQUENCE ||
        !Number.isSafeInteger(value.assignmentOldestAvailableSequence) ||
        value.assignmentOldestAvailableSequence < 1 ||
        value.assignmentOldestAvailableSequence >
          value.assignmentHighWatermark + 1))
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流路由状态损坏",
      503,
    );
  }
  const configHistory = value.configHistory.map(normalizeConfigEntry);
  for (let index = 1; index < configHistory.length; index += 1) {
    if (configHistory[index].version !== configHistory[index - 1].version + 1) {
      throw workflowServiceError(
        "WORKFLOW_STATE_CORRUPTED",
        "工作流配置版本不连续",
        503,
      );
    }
  }
  const currentConfig = value.currentConfig === null
    ? null
    : normalizeConfigEntry(value.currentConfig);
  if (
    (currentConfig === null) !== (configHistory.length === 0) ||
    (currentConfig &&
      JSON.stringify(currentConfig) !== JSON.stringify(configHistory.at(-1)))
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "当前工作流配置与历史不一致",
      503,
    );
  }
  const assignments = value.assignments.map(normalizeAssignmentRecord);
  const assignmentFeedState = legacy
    ? migrateWorkflowAssignmentFeed(assignments)
    : {
        assignmentFeed: value.assignmentFeed.map(
          normalizeWorkflowAssignmentFeedEntry,
        ),
        assignmentHighWatermark: value.assignmentHighWatermark,
        assignmentOldestAvailableSequence:
          value.assignmentOldestAvailableSequence,
      };
  const state = {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    revision: value.revision,
    currentConfig,
    configHistory,
    events: value.events.map((event) =>
      cloneWorkflowValue(normalizeStoredWorkflowEvent(event)),
    ),
    assignments,
    ...assignmentFeedState,
    audit: value.audit.map(normalizeAuditRecord),
    checkpoint:
      value.checkpoint === null
        ? null
        : cloneWorkflowValue(projectWorkflowSnapshot(value.checkpoint, {
          issueActiveWindowDays,
        })),
    lastSnapshot:
      value.lastSnapshot === null
        ? null
        : cloneWorkflowValue(projectWorkflowSnapshot(value.lastSnapshot, {
          issueActiveWindowDays,
        })),
  };
  if (
    (state.checkpoint === null) !== (state.lastSnapshot === null) ||
    (state.checkpoint &&
      Date.parse(state.checkpoint.refreshedAt) >
        Date.parse(state.lastSnapshot.refreshedAt))
  ) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "工作流源检查点晚于最后接收的快照",
      503,
    );
  }
  assertCrossRecordConsistency(state);
  try {
    const capacityState =
      legacy && allowLegacyMigrationOverflow
        ? legacyWorkflowCapacityState(state)
        : state;
    assertWorkflowStateCapacity(capacityState, {
      stateByteBudget,
      auditByteBudget,
      bundleByteBudget,
    });
  } catch (error) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      error?.message || "工作流状态超过安全容量",
      503,
    );
  }
  return state;
}

export function normalizeWorkflowPersistedState(value, options) {
  return normalizeWorkflowPersistedStateInternal(value, options);
}

export function normalizeLegacyWorkflowPersistedStateForMigration(
  value,
  options,
) {
  if (!isLegacyWorkflowPersistedState(value)) {
    throw workflowServiceError(
      "WORKFLOW_STATE_CORRUPTED",
      "待迁移工作流状态不是受支持的 v1 状态",
      503,
    );
  }
  return normalizeWorkflowPersistedStateInternal(value, options, {
    allowLegacyMigrationOverflow: true,
  });
}

export function migrateWorkflowPersistedState(value) {
  if (!isLegacyWorkflowPersistedState(value)) {
    return normalizeWorkflowPersistedState(value);
  }
  const normalized = normalizeLegacyWorkflowPersistedStateForMigration(value);
  const retained = retainWorkflowState(
    { ...normalized, revision: normalized.revision + 1 },
    {
      protectedEventIds: new Set(),
      recordLimit: MAX_WORKFLOW_RECORDS,
      stateByteBudget: MAX_WORKFLOW_STATE_BYTES,
      auditByteBudget: MAX_WORKFLOW_AUDIT_BYTES,
      bundleByteBudget: MAX_WORKFLOW_BUNDLE_BYTES,
    },
  ).state;
  return normalizeWorkflowPersistedState(retained);
}

export function mergeWorkflowCheckpoint(previous, current, projectionOptions = {}) {
  if (!previous) return cloneWorkflowValue(current);
  const definitions = [
    { kind: "pull_request", status: "githubPullRequests" },
    { kind: "issue", status: "githubIssues" },
  ];
  const items = [];
  const sourceStatus = {};
  let refreshedAt = current.refreshedAt;
  for (const definition of definitions) {
    const currentStatus = current.sourceStatus[definition.status];
    const currentHealthy = currentStatus?.ok === true &&
      currentStatus.stale !== true;
    const source = currentHealthy ? current : previous;
    items.push(
      ...source.items.filter((item) => item.kind === definition.kind),
    );
    sourceStatus[definition.status] = cloneWorkflowValue(
      source.sourceStatus[definition.status],
    );
    if (definition.kind === "issue" && !currentHealthy) {
      refreshedAt = previous.refreshedAt;
    }
  }
  return cloneWorkflowValue(
    projectWorkflowSnapshot({
      refreshedAt,
      sourceStatus,
      items,
    }, projectionOptions),
  );
}
