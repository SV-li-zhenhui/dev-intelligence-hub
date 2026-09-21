import {
  normalizeStoredWorkflowEvent,
  normalizeWorkflowEvent,
} from "../domain/workflow-events.js";
import {
  createWorkflowRouter,
  normalizeWorkflowRoutingConfig,
} from "../domain/workflow-router.js";
import {
  boundedWorkflowString,
  canonicalWorkflowValue,
  cloneWorkflowValue,
  deepFreezeWorkflowValue,
  hasExactWorkflowKeys,
  normalizeWorkflowTarget,
  workflowServiceError,
  WORKFLOW_OUTCOMES,
} from "./workflow-routing-values.js";

const MAX_ROUTE_ASSIGNMENTS = 4_000;
const ROUTE_STATUSES = new Set([
  "routing_disabled",
  "condition_not_matched",
  "matched",
  "disabled",
  "source_mismatch",
  "skipped_after_stop",
  "fallback_not_needed",
]);
const TARGET_STATUSES = new Set(["assigned", "duplicate"]);

function routeError(message = "工作流路由结果无效") {
  return workflowServiceError("WORKFLOW_ROUTE_INVALID", message, 500);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeTrustedEvent(event) {
  return event &&
    typeof event === "object" &&
    Object.hasOwn(event, "eventId")
    ? normalizeStoredWorkflowEvent(event)
    : normalizeWorkflowEvent(event);
}

function normalizeStringReferences(values, name, allowed, maximum = 200) {
  if (!Array.isArray(values) || values.length > maximum) {
    throw routeError(`${name} 无效`);
  }
  const normalized = values.map((value) =>
    boundedWorkflowString(value, name, 128),
  );
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((value) => !allowed.has(value))
  ) {
    throw routeError(`${name} 包含重复或未知引用`);
  }
  return normalized;
}

function orderedRules(rules) {
  return rules
    .map((rule, declarationOrder) => ({ rule, declarationOrder }))
    .sort(
      (left, right) =>
        Number(left.rule.fallback) - Number(right.rule.fallback) ||
        right.rule.priority - left.rule.priority ||
        left.declarationOrder - right.declarationOrder,
    )
    .map(({ rule }) => rule);
}

function normalizeConditionTrace(value, { rule, status }) {
  if (status === "matched" && rule.fallback) {
    if (!hasExactWorkflowKeys(value, ["op", "result"])) {
      throw routeError("fallback 命中解释无效");
    }
    if (value.op !== "fallback" || value.result !== true) {
      throw routeError("fallback 命中解释无效");
    }
    return { op: "fallback", result: true };
  }
  if (status === "matched" || status === "condition_not_matched") {
    const condition = canonicalWorkflowValue(value);
    if (
      condition === null ||
      typeof condition !== "object" ||
      Array.isArray(condition) ||
      condition.result !== (status === "matched")
    ) {
      throw routeError("工作流条件解释与命中状态不一致");
    }
    return condition;
  }
  if (value !== null) {
    throw routeError("未评估规则不能携带条件解释");
  }
  return null;
}

function expectedStatus({
  definition,
  rule,
  entry,
  currentNodeId,
  ordinaryMatched,
  stoppedByRuleId,
}) {
  if (!definition.enabled) return "routing_disabled";
  if (!rule.enabled) return "disabled";
  if (rule.source !== currentNodeId) return "source_mismatch";
  if (rule.fallback) {
    if (ordinaryMatched) return "fallback_not_needed";
    if (stoppedByRuleId) return "skipped_after_stop";
    return "matched";
  }
  if (stoppedByRuleId) return "skipped_after_stop";
  if (!["matched", "condition_not_matched"].includes(entry.status)) {
    throw routeError("可评估普通规则的状态无效");
  }
  return entry.status;
}

function normalizeExplanation(value, definition, suppliedMatches, suppliedAssignments) {
  if (
    !hasExactWorkflowKeys(value, [
      "enabled",
      "currentNodeId",
      "visitedNodeIds",
      "hopCount",
      "maxHops",
      "ruleOrder",
      "rules",
      "usedFallback",
      "stoppedByRuleId",
    ]) ||
    value.enabled !== definition.enabled ||
    typeof value.usedFallback !== "boolean" ||
    !Number.isSafeInteger(value.hopCount) ||
    value.hopCount < 0 ||
    value.hopCount > definition.maxHops ||
    value.maxHops !== definition.maxHops
  ) {
    throw routeError("工作流路由解释无效");
  }
  const currentNodeId = boundedWorkflowString(
    value.currentNodeId,
    "explanation.currentNodeId",
    128,
  );
  const visitedNodeIds = normalizeStringReferences(
    value.visitedNodeIds,
    "explanation.visitedNodeIds",
    new Set(value.visitedNodeIds || []),
    33,
  );
  if (
    visitedNodeIds.length !== value.hopCount + 1 ||
    visitedNodeIds.at(-1) !== currentNodeId
  ) {
    throw routeError("工作流路由路径无效");
  }

  const rules = orderedRules(definition.rules);
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const ruleOrder = normalizeStringReferences(
    value.ruleOrder,
    "explanation.ruleOrder",
    new Set(rulesById.keys()),
  );
  if (!sameValue(ruleOrder, rules.map(({ id }) => id))) {
    throw routeError("工作流规则顺序不一致");
  }
  if (!Array.isArray(value.rules) || value.rules.length !== rules.length) {
    throw routeError("工作流规则解释不完整");
  }

  const assignedTargets = new Set();
  const expectedAssignments = [];
  const expectedMatches = [];
  let ordinaryMatched = false;
  let stoppedByRuleId = null;
  let usedFallback = false;
  const normalizedRules = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const entry = value.rules[index];
    if (
      !hasExactWorkflowKeys(entry, [
        "ruleId",
        "source",
        "enabled",
        "priority",
        "fallback",
        "onMatch",
        "status",
        "condition",
        "targets",
      ]) ||
      !ROUTE_STATUSES.has(entry.status) ||
      entry.ruleId !== rule.id ||
      entry.source !== rule.source ||
      entry.enabled !== rule.enabled ||
      entry.priority !== rule.priority ||
      entry.fallback !== rule.fallback ||
      entry.onMatch !== rule.onMatch
    ) {
      throw routeError("工作流规则解释引用无效");
    }
    const requiredStatus = expectedStatus({
      definition,
      rule,
      entry,
      currentNodeId,
      ordinaryMatched,
      stoppedByRuleId,
    });
    if (entry.status !== requiredStatus) {
      throw routeError("工作流规则状态与启用、来源或停止语义不一致");
    }
    const condition = normalizeConditionTrace(entry.condition, {
      rule,
      status: entry.status,
    });

    if (!Array.isArray(entry.targets)) {
      throw routeError("工作流目标解释无效");
    }
    const targets = [];
    if (entry.status === "matched") {
      if (entry.targets.length !== rule.targets.length) {
        throw routeError("命中规则必须解释每个配置目标");
      }
      expectedMatches.push(rule.id);
      if (rule.fallback) usedFallback = true;
      else ordinaryMatched = true;
      for (let targetIndex = 0; targetIndex < rule.targets.length; targetIndex += 1) {
        const configuredTarget = rule.targets[targetIndex];
        const targetEntry = entry.targets[targetIndex];
        if (
          !hasExactWorkflowKeys(targetEntry, ["target", "status"]) ||
          !TARGET_STATUSES.has(targetEntry.status)
        ) {
          throw routeError("工作流目标解释无效");
        }
        const target = normalizeWorkflowTarget(targetEntry.target);
        const key = `${target.type}:${target.id}`;
        const duplicate = assignedTargets.has(key);
        if (
          !sameValue(target, configuredTarget) ||
          targetEntry.status !== (duplicate ? "duplicate" : "assigned")
        ) {
          throw routeError("工作流目标状态与分派顺序不一致");
        }
        targets.push({ target, status: targetEntry.status });
        if (!duplicate) {
          assignedTargets.add(key);
          expectedAssignments.push({
            ruleId: rule.id,
            target,
            priority: rule.priority,
          });
        }
      }
      if (rule.onMatch === "stop") stoppedByRuleId = rule.id;
    } else if (entry.targets.length !== 0) {
      throw routeError("未命中规则不能包含目标解释");
    }
    normalizedRules.push({
      ruleId: rule.id,
      source: rule.source,
      enabled: rule.enabled,
      priority: rule.priority,
      fallback: rule.fallback,
      onMatch: rule.onMatch,
      status: entry.status,
      condition,
      targets,
    });
  }

  if (
    !sameValue(suppliedMatches, expectedMatches) ||
    !sameValue(suppliedAssignments, expectedAssignments) ||
    value.usedFallback !== usedFallback ||
    value.stoppedByRuleId !== stoppedByRuleId
  ) {
    throw routeError("工作流命中、分派、fallback 或停止结论不一致");
  }
  return {
    explanation: {
      enabled: value.enabled,
      currentNodeId,
      visitedNodeIds,
      hopCount: value.hopCount,
      maxHops: value.maxHops,
      ruleOrder,
      rules: normalizedRules,
      usedFallback,
      stoppedByRuleId,
    },
    expectedOutcome: definition.enabled
      ? expectedAssignments.length > 0
        ? "assigned"
        : "unmatched"
      : "disabled",
  };
}

export function normalizeWorkflowRouteResult(value, definition) {
  if (
    !hasExactWorkflowKeys(value, [
      "outcome",
      "matches",
      "assignments",
      "explanation",
    ]) ||
    !WORKFLOW_OUTCOMES.has(value.outcome)
  ) {
    throw routeError();
  }
  const rulesById = new Map(definition.rules.map((rule) => [rule.id, rule]));
  const matches = normalizeStringReferences(
    value.matches,
    "matches",
    new Set(rulesById.keys()),
  );
  if (
    !Array.isArray(value.assignments) ||
    value.assignments.length > MAX_ROUTE_ASSIGNMENTS
  ) {
    throw routeError("工作流分派结果无效");
  }
  const normalizedAssignments = value.assignments.map((assignment) => {
    if (!hasExactWorkflowKeys(assignment, ["ruleId", "target", "priority"])) {
      throw routeError("工作流分派记录无效");
    }
    const target = normalizeWorkflowTarget(assignment.target);
    if (
      !rulesById.has(assignment.ruleId) ||
      !Number.isSafeInteger(assignment.priority) ||
      assignment.priority < -10_000 ||
      assignment.priority > 10_000
    ) {
      throw routeError("工作流分派包含无效引用或优先级");
    }
    return {
      ruleId: assignment.ruleId,
      target,
      priority: assignment.priority,
    };
  });
  const { explanation, expectedOutcome } = normalizeExplanation(
    value.explanation,
    definition,
    matches,
    normalizedAssignments,
  );
  if (value.outcome !== expectedOutcome) {
    throw routeError("工作流路由结论与严格语义不一致");
  }
  return {
    outcome: value.outcome,
    matches,
    assignments: normalizedAssignments.map((assignment) => ({
      ...assignment,
      reason: `规则 ${assignment.ruleId} 分派`,
    })),
    explanation,
  };
}

export function validateWorkflowRouteResultAgainstTrustedEvaluation(
  value,
  { event, definition, context },
) {
  const trustedEvent = normalizeTrustedEvent(event);
  const trustedDefinition = normalizeWorkflowRoutingConfig(definition);
  const trustedContext =
    context === undefined ? undefined : canonicalWorkflowValue(context);
  const trustedInput = {
    event: cloneWorkflowValue(trustedEvent),
    config: cloneWorkflowValue(trustedDefinition),
    ...(trustedContext === undefined
      ? {}
      : { context: cloneWorkflowValue(trustedContext) }),
  };
  const expected = normalizeWorkflowRouteResult(
    createWorkflowRouter().route(trustedInput),
    trustedDefinition,
  );
  const actual = normalizeWorkflowRouteResult(
    value,
    deepFreezeWorkflowValue(cloneWorkflowValue(trustedDefinition)),
  );
  if (!sameValue(actual, expected)) {
    throw routeError("工作流路由结果与可信确定性求值不一致");
  }
  return {
    event: trustedEvent,
    definition: trustedDefinition,
    result: actual,
  };
}

export async function routeWorkflowWithIsolation({
  router,
  event,
  definition,
  context,
}) {
  const trustedEvent = normalizeTrustedEvent(event);
  const trustedDefinition = normalizeWorkflowRoutingConfig(definition);
  const validationDefinition = deepFreezeWorkflowValue(
    cloneWorkflowValue(trustedDefinition),
  );
  const routerInput = {
    event: deepFreezeWorkflowValue(cloneWorkflowValue(trustedEvent)),
    config: deepFreezeWorkflowValue(cloneWorkflowValue(trustedDefinition)),
  };
  if (context !== undefined) {
    routerInput.context = deepFreezeWorkflowValue(
      canonicalWorkflowValue(context),
    );
  }
  const validationContext =
    routerInput.context === undefined
      ? undefined
      : deepFreezeWorkflowValue(cloneWorkflowValue(routerInput.context));
  const result = await router.route(Object.freeze(routerInput));
  return validateWorkflowRouteResultAgainstTrustedEvaluation(result, {
    event: trustedEvent,
    definition: validationDefinition,
    ...(validationContext === undefined ? {} : { context: validationContext }),
  });
}
