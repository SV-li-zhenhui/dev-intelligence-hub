import {
  PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID,
} from "./pull-request-scope-lifecycle.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const SAFE_PATH_SEGMENT = /^[A-Za-z][A-Za-z0-9_]*$/;
const INVALID_TEXT_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TARGET_TYPES = new Set(["role", "person", "node"]);
const MATCH_BEHAVIORS = new Set(["stop", "continue"]);
const CONDITION_OPERATORS = new Set([
  "all",
  "any",
  "not",
  "equals",
  "oneOf",
  "hasAny",
  "hasAll",
  "globAny",
  "globAll",
  "atLeast",
]);

const MAX_RULES = 200;
const MAX_TARGETS_PER_RULE = 20;
const MAX_HOPS = 32;
const MAX_CONDITION_DEPTH = 8;
const MAX_CONDITION_NODES = 128;
const MAX_CONDITION_CHILDREN = 128;
const MAX_CONDITION_VALUES = 50;
const MAX_ID_BYTES = 128;
const MAX_PATH_BYTES = 512;
const MAX_VALUE_BYTES = 512;
const MAX_PATTERN_BYTES = 256;
const MAX_GLOB_PATTERNS = 32;
const MAX_GLOB_PATTERN_BYTES = 2 * 1024;
const MAX_GLOB_MATCH_WORK = 40_000_000;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_EVENT_DEPTH = 16;
const MAX_EVENT_ENTRIES = 2_000;
const MAX_EVENT_STRING_BYTES = 16 * 1024;

export class WorkflowRoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowRoutingError";
    this.code = code;
    this.statusCode = 400;
  }
}

function routingError(code, message) {
  return new WorkflowRoutingError(code, message);
}

function invalidConfig(message = "工作流路由配置无效") {
  return routingError("INVALID_ROUTING_CONFIG", message);
}

function invalidInput(message = "工作流路由输入无效") {
  return routingError("INVALID_ROUTING_INPUT", message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataKeys(value, error) {
  if (!isPlainObject(value)) throw error;
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
  }
  return keys;
}

function exactKeys(value, expected, error) {
  const keys = dataKeys(value, error);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

function allowedKeys(value, allowed, required, error) {
  const keys = dataKeys(value, error);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

function plainArray(value, maximumLength, error, { minimumLength = 0 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimumLength ||
    value.length > maximumLength
  ) {
    throw error;
  }
  const expectedKeys = Array.from(
    { length: value.length },
    (_, index) => String(index),
  );
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length + 1 ||
    !keys.includes("length") ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
  }
  return value;
}

function boundedString(
  value,
  { name, maximumBytes, minimumBytes = 1, pattern = null },
  error,
) {
  if (typeof value !== "string" || INVALID_TEXT_CONTROL.test(value)) {
    throw error;
  }
  const length = Buffer.byteLength(value, "utf8");
  if (
    length < minimumBytes ||
    length > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw error;
  }
  return value;
}

function safeId(value, name, error = invalidConfig()) {
  return boundedString(
    value,
    { name, maximumBytes: MAX_ID_BYTES, pattern: SAFE_ID },
    error,
  );
}

function safeInteger(value, { minimum, maximum }, error) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw error;
  }
  return value;
}

function scalarValue(value, error = invalidConfig()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw error;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return boundedString(
      value,
      {
        name: "condition value",
        maximumBytes: MAX_VALUE_BYTES,
        minimumBytes: 0,
      },
      error,
    );
  }
  throw error;
}

function conditionPath(value) {
  const error = invalidConfig("工作流条件路径无效");
  const path = boundedString(
    value,
    { name: "condition path", maximumBytes: MAX_PATH_BYTES },
    error,
  );
  const segments = path.split(".");
  if (
    segments.length > 16 ||
    segments.some(
      (segment) =>
        !SAFE_PATH_SEGMENT.test(segment) || DANGEROUS_KEYS.has(segment),
    )
  ) {
    throw error;
  }
  return path;
}

function uniqueScalarValues(value, { stringsOnly = false } = {}) {
  const error = invalidConfig("工作流条件值列表无效");
  plainArray(value, MAX_CONDITION_VALUES, error, { minimumLength: 1 });
  const normalized = value.map((entry) => scalarValue(entry, error));
  if (stringsOnly && normalized.some((entry) => typeof entry !== "string")) {
    throw error;
  }
  const identities = normalized.map((entry) => `${typeof entry}:${String(entry)}`);
  if (new Set(identities).size !== identities.length) throw error;
  return normalized;
}

function normalizePatterns(value, globBudget) {
  const error = invalidConfig("工作流 glob 模式无效");
  plainArray(value, MAX_CONDITION_VALUES, error, { minimumLength: 1 });
  const patterns = value.map((pattern) =>
    boundedString(
      pattern,
      { name: "glob pattern", maximumBytes: MAX_PATTERN_BYTES },
      error,
    ),
  );
  if (new Set(patterns).size !== patterns.length) throw error;
  globBudget.patterns += patterns.length;
  globBudget.patternBytes += patterns.reduce(
    (total, pattern) => total + Buffer.byteLength(pattern, "utf8"),
    0,
  );
  if (
    globBudget.patterns > MAX_GLOB_PATTERNS ||
    globBudget.patternBytes > MAX_GLOB_PATTERN_BYTES
  ) {
    throw invalidConfig(
      `工作流 glob 总预算超限（最多 ${MAX_GLOB_PATTERNS} 个模式、${MAX_GLOB_PATTERN_BYTES} 字节）`,
    );
  }
  return patterns;
}

function normalizeCondition(
  value,
  context = {
    depth: 1,
    nodes: { count: 0 },
    globBudget: { patterns: 0, patternBytes: 0 },
  },
) {
  const error = invalidConfig("工作流条件无效");
  context.nodes.count += 1;
  if (
    context.depth > MAX_CONDITION_DEPTH ||
    context.nodes.count > MAX_CONDITION_NODES
  ) {
    throw error;
  }
  const keys = dataKeys(value, error);
  if (!keys.includes("op") || !CONDITION_OPERATORS.has(value.op)) throw error;
  const childContext = {
    depth: context.depth + 1,
    nodes: context.nodes,
    globBudget: context.globBudget,
  };

  if (value.op === "all" || value.op === "any") {
    exactKeys(value, ["op", "conditions"], error);
    plainArray(value.conditions, MAX_CONDITION_CHILDREN, error, {
      minimumLength: 1,
    });
    return {
      op: value.op,
      conditions: value.conditions.map((condition) =>
        normalizeCondition(condition, childContext),
      ),
    };
  }
  if (value.op === "not") {
    exactKeys(value, ["op", "condition"], error);
    return {
      op: "not",
      condition: normalizeCondition(value.condition, childContext),
    };
  }
  if (value.op === "equals" || value.op === "atLeast") {
    exactKeys(value, ["op", "path", "value"], error);
    const normalizedValue = scalarValue(value.value, error);
    if (value.op === "atLeast" && typeof normalizedValue !== "number") {
      throw error;
    }
    return {
      op: value.op,
      path: conditionPath(value.path),
      value: normalizedValue,
    };
  }
  if (["oneOf", "hasAny", "hasAll"].includes(value.op)) {
    exactKeys(value, ["op", "path", "values"], error);
    return {
      op: value.op,
      path: conditionPath(value.path),
      values: uniqueScalarValues(value.values, {
        stringsOnly: value.op !== "oneOf",
      }),
    };
  }
  exactKeys(value, ["op", "path", "patterns"], error);
  return {
    op: value.op,
    path: conditionPath(value.path),
    patterns: normalizePatterns(value.patterns, context.globBudget),
  };
}

function normalizeTarget(value) {
  const error = invalidConfig("工作流分派目标无效");
  exactKeys(value, ["type", "id"], error);
  if (!TARGET_TYPES.has(value.type)) throw error;
  return {
    type: value.type,
    id: safeId(value.id, "target id", error),
  };
}

function normalizeRule(value, globBudget) {
  const error = invalidConfig("工作流路由规则无效");
  exactKeys(
    value,
    [
      "id",
      "source",
      "enabled",
      "priority",
      "fallback",
      "condition",
      "targets",
      "onMatch",
    ],
    error,
  );
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.fallback !== "boolean" ||
    !MATCH_BEHAVIORS.has(value.onMatch)
  ) {
    throw error;
  }
  plainArray(value.targets, MAX_TARGETS_PER_RULE, error, { minimumLength: 1 });
  const targets = value.targets.map(normalizeTarget);
  const targetKeys = targets.map(({ type, id }) => `${type}:${id}`);
  if (new Set(targetKeys).size !== targetKeys.length) throw error;
  if (
    (value.fallback && value.condition !== null) ||
    (!value.fallback && value.condition === null)
  ) {
    throw error;
  }
  return {
    id: safeId(value.id, "rule id", error),
    source: safeId(value.source, "source node", error),
    enabled: value.enabled,
    priority: safeInteger(
      value.priority,
      { minimum: -10_000, maximum: 10_000 },
      error,
    ),
    fallback: value.fallback,
    condition: value.fallback
      ? null
      : normalizeCondition(value.condition, {
          depth: 1,
          nodes: { count: 0 },
          globBudget,
        }),
    targets,
    onMatch: value.onMatch,
  };
}

function nodeGraph(rules) {
  const graph = new Map();
  for (const rule of rules) {
    if (!graph.has(rule.source)) graph.set(rule.source, new Set());
    for (const target of rule.targets) {
      if (target.type === "node") graph.get(rule.source).add(target.id);
    }
  }
  return graph;
}

function assertAcyclic(graph) {
  const visiting = new Set();
  const visited = new Set();

  function visit(node) {
    if (visiting.has(node)) {
      throw routingError("ROUTING_CYCLE", `工作流节点 ${node} 构成循环`);
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of graph.get(node) ?? []) visit(target);
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.keys()) visit(node);
}

function assertGraphWithinHopLimit(graph, maxHops) {
  const longestPaths = new Map();

  function longestPath(node) {
    if (longestPaths.has(node)) return longestPaths.get(node);
    let length = 0;
    for (const target of graph.get(node) ?? []) {
      length = Math.max(length, 1 + longestPath(target));
    }
    longestPaths.set(node, length);
    return length;
  }

  for (const node of graph.keys()) {
    if (longestPath(node) > maxHops) {
      throw routingError(
        "ROUTING_HOP_LIMIT",
        `工作流节点 ${node} 的路径超过最大跳数`,
      );
    }
  }
}

export function normalizeWorkflowRoutingConfig(value) {
  const error = invalidConfig();
  exactKeys(value, ["schemaVersion", "enabled", "maxHops", "rules"], error);
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean") {
    throw error;
  }
  const maxHops = safeInteger(
    value.maxHops,
    { minimum: 1, maximum: MAX_HOPS },
    error,
  );
  plainArray(value.rules, MAX_RULES, error);
  const globBudget = { patterns: 0, patternBytes: 0 };
  const rules = value.rules.map((rule) => normalizeRule(rule, globBudget));
  if (rules.some(({ id }) => id === PULL_REQUEST_SCOPE_LIFECYCLE_RULE_ID)) {
    throw invalidConfig("系统 PR 生命周期规则 ID 为保留标识");
  }
  if (new Set(rules.map(({ id }) => id)).size !== rules.length) throw error;

  const normalized = {
    schemaVersion: 1,
    enabled: value.enabled,
    maxHops,
    rules,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_CONFIG_BYTES) {
    throw invalidConfig("工作流路由配置过大");
  }
  const graph = nodeGraph(rules);
  assertAcyclic(graph);
  assertGraphWithinHopLimit(graph, maxHops);
  return normalized;
}

function cloneEventJson(
  value,
  context = {
    depth: 0,
    entries: { count: 0 },
    ancestors: new Set(),
  },
) {
  const error = routingError("INVALID_ROUTING_EVENT", "工作流事件无效");
  context.entries.count += 1;
  if (
    context.depth > MAX_EVENT_DEPTH ||
    context.entries.count > MAX_EVENT_ENTRIES
  ) {
    throw error;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw error;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    return boundedString(
      value,
      {
        name: "event string",
        maximumBytes: MAX_EVENT_STRING_BYTES,
        minimumBytes: 0,
      },
      error,
    );
  }
  if (value === undefined || context.ancestors.has(value)) throw error;
  context.ancestors.add(value);
  const childContext = {
    depth: context.depth + 1,
    entries: context.entries,
    ancestors: context.ancestors,
  };
  try {
    if (Array.isArray(value)) {
      plainArray(value, MAX_EVENT_ENTRIES, error);
      return value.map((entry) => cloneEventJson(entry, childContext));
    }
    const keys = dataKeys(value, error);
    const result = {};
    for (const key of keys.sort()) {
      if (Buffer.byteLength(key, "utf8") > MAX_PATH_BYTES) throw error;
      result[key] = cloneEventJson(value[key], childContext);
    }
    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

function normalizeEvent(value) {
  const event = cloneEventJson(value);
  if (!isPlainObject(event) || Object.keys(event).length === 0) {
    throw routingError("INVALID_ROUTING_EVENT", "工作流事件无效");
  }
  return event;
}

function normalizeContext(value, maxHops) {
  if (value === undefined) {
    return {
      currentNodeId: "root",
      visitedNodeIds: ["root"],
      hopCount: 0,
    };
  }
  const error = invalidInput("工作流路由上下文无效");
  exactKeys(value, ["currentNodeId", "visitedNodeIds", "hopCount"], error);
  const currentNodeId = safeId(value.currentNodeId, "current node", error);
  const hopCount = safeInteger(
    value.hopCount,
    { minimum: 0, maximum: MAX_HOPS },
    error,
  );
  plainArray(value.visitedNodeIds, MAX_HOPS + 1, error, { minimumLength: 1 });
  const visitedNodeIds = value.visitedNodeIds.map((node) =>
    safeId(node, "visited node", error),
  );
  if (
    visitedNodeIds.length !== hopCount + 1 ||
    visitedNodeIds.at(-1) !== currentNodeId
  ) {
    throw error;
  }
  if (new Set(visitedNodeIds).size !== visitedNodeIds.length) {
    throw routingError("ROUTING_CYCLE", "工作流路由上下文包含循环");
  }
  if (hopCount > maxHops) {
    throw routingError("ROUTING_HOP_LIMIT", "工作流路由超过最大跳数");
  }
  return { currentNodeId, visitedNodeIds, hopCount };
}

function valueAtPath(event, path) {
  let current = event;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function leafTrace(condition, resolved, expected, result) {
  return {
    op: condition.op,
    path: condition.path,
    found: resolved.found,
    ...(resolved.found
      ? { actual: resolved.value, actualType: valueType(resolved.value) }
      : {}),
    ...expected,
    result,
  };
}

function sameScalar(left, right) {
  return left === right;
}

function globTokens(pattern) {
  const characters = Array.from(pattern);
  const tokens = [];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "*" && characters[index + 1] === "*") {
      if (characters[index + 2] === "/") {
        tokens.push({ type: "globstarSlashEntry" });
        tokens.push({ type: "globstarSlashBody" });
        index += 2;
      } else {
        tokens.push({ type: "globstar" });
        index += 1;
      }
    } else if (character === "*") {
      tokens.push({ type: "star" });
    } else if (character === "?") {
      tokens.push({ type: "one" });
    } else {
      tokens.push({ type: "literal", value: character });
    }
  }
  return tokens;
}

function addGlobEpsilonTransitions(states, tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const { type } = tokens[index];
    if (!states[index]) continue;
    if (type === "globstarSlashEntry") states[index + 2] = true;
    if (type === "globstar" || type === "star") states[index + 1] = true;
  }
  return states;
}

function globMatches(pattern, value) {
  const tokens = globTokens(pattern);
  let states = addGlobEpsilonTransitions(
    Array.from({ length: tokens.length + 1 }, (_, index) => index === 0),
    tokens,
  );

  for (const character of Array.from(value)) {
    const next = Array(tokens.length + 1).fill(false);
    for (let index = 0; index < tokens.length; index += 1) {
      if (!states[index]) continue;
      const token = tokens[index];
      if (token.type === "literal" && token.value === character) {
        next[index + 1] = true;
      } else if (token.type === "one" && character !== "/") {
        next[index + 1] = true;
      } else if (token.type === "star" && character !== "/") {
        next[index] = true;
      } else if (token.type === "globstar") {
        next[index] = true;
      } else if (token.type === "globstarSlashEntry") {
        next[index + 1] = true;
        if (character === "/") next[index + 2] = true;
      } else if (token.type === "globstarSlashBody") {
        next[index] = true;
        if (character === "/") next[index + 1] = true;
      }
    }
    states = addGlobEpsilonTransitions(next, tokens);
  }
  return states[tokens.length];
}

function stringList(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return null;
}

function evaluateCondition(condition, event, globContext) {
  if (condition.op === "all" || condition.op === "any") {
    const children = condition.conditions.map((child) =>
      evaluateCondition(child, event, globContext),
    );
    return {
      op: condition.op,
      result:
        condition.op === "all"
          ? children.every(({ result }) => result)
          : children.some(({ result }) => result),
      children,
    };
  }
  if (condition.op === "not") {
    const child = evaluateCondition(condition.condition, event, globContext);
    return { op: "not", result: !child.result, child };
  }

  const resolved = valueAtPath(event, condition.path);
  if (condition.op === "equals") {
    return leafTrace(
      condition,
      resolved,
      { expected: condition.value },
      resolved.found && sameScalar(resolved.value, condition.value),
    );
  }
  if (condition.op === "oneOf") {
    return leafTrace(
      condition,
      resolved,
      { expected: condition.values },
      resolved.found &&
        condition.values.some((value) => sameScalar(resolved.value, value)),
    );
  }
  if (condition.op === "hasAny" || condition.op === "hasAll") {
    const actual = resolved.found && Array.isArray(resolved.value)
      ? resolved.value
      : null;
    const result =
      actual !== null &&
      (condition.op === "hasAny"
        ? condition.values.some((value) => actual.includes(value))
        : condition.values.every((value) => actual.includes(value)));
    return leafTrace(
      condition,
      resolved,
      { expected: condition.values },
      result,
    );
  }
  if (condition.op === "globAny" || condition.op === "globAll") {
    const actual = resolved.found ? stringList(resolved.value) : null;
    if (actual !== null) {
      const valueCharacters = actual.reduce(
        (total, value) => total + Array.from(value).length,
        0,
      );
      const patternCharacters = condition.patterns.reduce(
        (total, pattern) => total + globTokens(pattern).length,
        0,
      );
      globContext.work += valueCharacters * patternCharacters;
      if (globContext.work > MAX_GLOB_MATCH_WORK) {
        throw routingError(
          "ROUTING_GLOB_BUDGET",
          "工作流 glob 匹配工作量超出限制",
        );
      }
    }
    const result =
      actual !== null &&
      (condition.op === "globAny"
        ? condition.patterns.some((pattern) =>
            actual.some((value) => globMatches(pattern, value)),
          )
        : condition.patterns.every((pattern) =>
            actual.some((value) => globMatches(pattern, value)),
          ));
    return leafTrace(
      condition,
      resolved,
      { patterns: condition.patterns },
      result,
    );
  }
  return leafTrace(
    condition,
    resolved,
    { minimum: condition.value },
    resolved.found &&
      typeof resolved.value === "number" &&
      Number.isFinite(resolved.value) &&
      resolved.value >= condition.value,
  );
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

function unexploredRule(rule, status) {
  return {
    ruleId: rule.id,
    source: rule.source,
    enabled: rule.enabled,
    priority: rule.priority,
    fallback: rule.fallback,
    onMatch: rule.onMatch,
    status,
    condition: null,
    targets: [],
  };
}

function assertNodeTargetIsSafe(target, context, maxHops) {
  if (target.type !== "node") return;
  if (context.visitedNodeIds.includes(target.id)) {
    throw routingError(
      "ROUTING_CYCLE",
      `工作流节点 ${target.id} 已在当前路径中`,
    );
  }
  if (context.hopCount + 1 > maxHops) {
    throw routingError("ROUTING_HOP_LIMIT", "工作流路由超过最大跳数");
  }
}

function routingDisabledResult(config, context, rules) {
  return {
    outcome: "disabled",
    matches: [],
    assignments: [],
    explanation: {
      enabled: false,
      currentNodeId: context.currentNodeId,
      visitedNodeIds: [...context.visitedNodeIds],
      hopCount: context.hopCount,
      maxHops: config.maxHops,
      ruleOrder: rules.map(({ id }) => id),
      rules: rules.map((rule) => unexploredRule(rule, "routing_disabled")),
      usedFallback: false,
      stoppedByRuleId: null,
    },
  };
}

function routeNormalized(event, config, context) {
  const rules = orderedRules(config.rules);
  if (!config.enabled) return routingDisabledResult(config, context, rules);

  const explanations = new Map();
  const matches = [];
  const assignments = [];
  const assignedTargets = new Set();
  let stoppedByRuleId = null;
  let ordinaryMatched = false;
  let usedFallback = false;
  const globContext = { work: 0 };

  function evaluateRule(rule) {
    const condition = rule.fallback
      ? { op: "fallback", result: true }
      : evaluateCondition(rule.condition, event, globContext);
    if (!condition.result) {
      explanations.set(rule.id, {
        ...unexploredRule(rule, "condition_not_matched"),
        condition,
      });
      return false;
    }

    const targetExplanations = [];
    for (const target of rule.targets) {
      assertNodeTargetIsSafe(target, context, config.maxHops);
      const key = `${target.type}:${target.id}`;
      const duplicate = assignedTargets.has(key);
      targetExplanations.push({
        target: { ...target },
        status: duplicate ? "duplicate" : "assigned",
      });
      if (!duplicate) {
        assignedTargets.add(key);
        assignments.push({
          ruleId: rule.id,
          target: { ...target },
          priority: rule.priority,
        });
      }
    }
    matches.push(rule.id);
    explanations.set(rule.id, {
      ...unexploredRule(rule, "matched"),
      condition,
      targets: targetExplanations,
    });
    if (rule.onMatch === "stop") stoppedByRuleId = rule.id;
    return true;
  }

  for (const rule of rules.filter(({ fallback }) => !fallback)) {
    if (!rule.enabled) {
      explanations.set(rule.id, unexploredRule(rule, "disabled"));
    } else if (rule.source !== context.currentNodeId) {
      explanations.set(rule.id, unexploredRule(rule, "source_mismatch"));
    } else if (stoppedByRuleId) {
      explanations.set(rule.id, unexploredRule(rule, "skipped_after_stop"));
    } else if (evaluateRule(rule)) {
      ordinaryMatched = true;
    }
  }

  for (const rule of rules.filter(({ fallback }) => fallback)) {
    if (!rule.enabled) {
      explanations.set(rule.id, unexploredRule(rule, "disabled"));
    } else if (rule.source !== context.currentNodeId) {
      explanations.set(rule.id, unexploredRule(rule, "source_mismatch"));
    } else if (ordinaryMatched) {
      explanations.set(rule.id, unexploredRule(rule, "fallback_not_needed"));
    } else if (stoppedByRuleId) {
      explanations.set(rule.id, unexploredRule(rule, "skipped_after_stop"));
    } else {
      usedFallback = true;
      evaluateRule(rule);
    }
  }

  return {
    outcome: assignments.length > 0 ? "assigned" : "unmatched",
    matches,
    assignments,
    explanation: {
      enabled: true,
      currentNodeId: context.currentNodeId,
      visitedNodeIds: [...context.visitedNodeIds],
      hopCount: context.hopCount,
      maxHops: config.maxHops,
      ruleOrder: rules.map(({ id }) => id),
      rules: rules.map((rule) => explanations.get(rule.id)),
      usedFallback,
      stoppedByRuleId,
    },
  };
}

export function routeWorkflowEvent(value) {
  const error = invalidInput();
  allowedKeys(value, ["event", "config", "context"], ["event", "config"], error);
  const config = normalizeWorkflowRoutingConfig(value.config);
  const event = normalizeEvent(value.event);
  const context = normalizeContext(value.context, config.maxHops);
  return routeNormalized(event, config, context);
}

export function createWorkflowRouter() {
  return Object.freeze({ route: routeWorkflowEvent });
}
