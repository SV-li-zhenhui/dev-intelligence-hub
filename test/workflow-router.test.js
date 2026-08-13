import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  WorkflowRoutingError,
  createWorkflowRouter,
  normalizeWorkflowRoutingConfig,
  routeWorkflowEvent,
} from "../src/domain/workflow-router.js";

function workflowEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-pr-42",
    contentDigest: "a".repeat(64),
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:00:00.000Z",
    source: { provider: "github", scopeId: "acme/command-center" },
    subject: {
      id: "acme/command-center#42",
      repository: "acme/command-center",
      number: 42,
    },
    payload: {
      author: "alice",
      assignee: "local-owner",
      labels: ["backend", "risk:high"],
      files: ["src/api/routes.js", "test/routes.test.js"],
      riskScore: 8,
      draft: false,
    },
    ...overrides,
  };
}

function rule(overrides = {}) {
  return {
    id: "route-pr-review",
    source: "root",
    enabled: true,
    priority: 100,
    fallback: false,
    condition: {
      op: "equals",
      path: "eventType",
      value: "pull_request.created",
    },
    targets: [{ type: "role", id: "pr-reviewer" }],
    onMatch: "stop",
    ...overrides,
  };
}

function config(rules, overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules,
    ...overrides,
  };
}

function route(rules, options = {}) {
  return routeWorkflowEvent({
    event: workflowEvent(),
    config: config(rules),
    ...options,
  });
}

test("normalizes a strict routing definition without retaining caller objects", () => {
  const definition = config([rule()]);
  const normalized = normalizeWorkflowRoutingConfig(definition);

  assert.deepEqual(normalized, definition);
  assert.notStrictEqual(normalized, definition);
  assert.notStrictEqual(normalized.rules, definition.rules);
  assert.notStrictEqual(normalized.rules[0].condition, definition.rules[0].condition);
  assert.notStrictEqual(normalized.rules[0].targets[0], definition.rules[0].targets[0]);

  definition.rules[0].targets[0].id = "mutated";
  assert.equal(normalized.rules[0].targets[0].id, "pr-reviewer");
});

test("rejects extra fields, duplicate ids, invalid fallback conditions, and unsafe targets", () => {
  const invalidDefinitions = [
    { ...config([rule()]), extra: true },
    config([rule(), rule()]),
    config([rule({ fallback: true })]),
    config([rule({ fallback: true, condition: { op: "equals", path: "eventType", value: "x" } })]),
    config([rule({ fallback: false, condition: null })]),
    config([rule({ targets: [{ type: "queue", id: "review" }] })]),
    config([rule({ targets: [{ type: "node", id: "../unsafe" }] })]),
    config([rule({ priority: 1.5 })]),
    config([rule({ id: "system-pull-request-scope-lifecycle" })]),
  ];

  for (const definition of invalidDefinitions) {
    assert.throws(
      () => normalizeWorkflowRoutingConfig(definition),
      (error) =>
        error instanceof WorkflowRoutingError &&
        error.code === "INVALID_ROUTING_CONFIG",
    );
  }
});

test("routes by descending priority and preserves declaration order for ties", () => {
  const result = route([
    rule({
      id: "third",
      priority: 10,
      onMatch: "continue",
      targets: [{ type: "role", id: "third-role" }],
    }),
    rule({
      id: "first-tie",
      priority: 20,
      onMatch: "continue",
      targets: [{ type: "role", id: "first-role" }],
    }),
    rule({
      id: "second-tie",
      priority: 20,
      onMatch: "stop",
      targets: [{ type: "person", id: "local-owner" }],
    }),
    rule({
      id: "never-evaluated",
      priority: 0,
      targets: [{ type: "role", id: "late-role" }],
    }),
  ]);

  assert.equal(result.outcome, "assigned");
  assert.deepEqual(result.matches, ["first-tie", "second-tie"]);
  assert.deepEqual(result.assignments, [
    {
      ruleId: "first-tie",
      target: { type: "role", id: "first-role" },
      priority: 20,
    },
    {
      ruleId: "second-tie",
      target: { type: "person", id: "local-owner" },
      priority: 20,
    },
  ]);
  assert.deepEqual(result.explanation.ruleOrder, [
    "first-tie",
    "second-tie",
    "third",
    "never-evaluated",
  ]);
  assert.equal(result.explanation.stoppedByRuleId, "second-tie");
  assert.deepEqual(
    result.explanation.rules.map(({ ruleId, status }) => [ruleId, status]),
    [
      ["first-tie", "matched"],
      ["second-tie", "matched"],
      ["third", "skipped_after_stop"],
      ["never-evaluated", "skipped_after_stop"],
    ],
  );
});

test("uses fallback rules only when no ordinary rule matches", () => {
  const fallback = rule({
    id: "fallback",
    priority: 1_000,
    fallback: true,
    condition: null,
    targets: [{ type: "role", id: "triage" }],
  });
  const ordinary = rule({
    id: "ordinary",
    priority: 1,
    onMatch: "continue",
  });

  const matched = route([fallback, ordinary]);
  assert.deepEqual(matched.matches, ["ordinary"]);
  assert.deepEqual(matched.explanation.ruleOrder, ["ordinary", "fallback"]);
  assert.equal(matched.explanation.usedFallback, false);
  assert.equal(
    matched.explanation.rules.find(({ ruleId }) => ruleId === "fallback").status,
    "fallback_not_needed",
  );

  const missed = route([
    fallback,
    rule({
      id: "ordinary-miss",
      priority: 1,
      condition: { op: "equals", path: "eventType", value: "issue.created" },
    }),
  ]);
  assert.deepEqual(missed.matches, ["fallback"]);
  assert.equal(missed.explanation.usedFallback, true);
  assert.equal(missed.assignments[0].target.id, "triage");
});

test("skips disabled and other-source rules while retaining them in the explanation", () => {
  const result = route([
    rule({ id: "disabled", enabled: false }),
    rule({ id: "other-node", source: "triage" }),
  ]);

  assert.equal(result.outcome, "unmatched");
  assert.deepEqual(result.matches, []);
  assert.deepEqual(
    result.explanation.rules.map(({ ruleId, status }) => [ruleId, status]),
    [
      ["disabled", "disabled"],
      ["other-node", "source_mismatch"],
    ],
  );
});

test("evaluates every supported condition operator with a complete nested trace", () => {
  const condition = {
    op: "all",
    conditions: [
      { op: "equals", path: "payload.draft", value: false },
      {
        op: "any",
        conditions: [
          { op: "equals", path: "payload.author", value: "nobody" },
          { op: "oneOf", path: "payload.author", values: ["alice", "bob"] },
        ],
      },
      { op: "not", condition: { op: "equals", path: "payload.assignee", value: "nobody" } },
      { op: "hasAny", path: "payload.labels", values: ["frontend", "backend"] },
      { op: "hasAll", path: "payload.labels", values: ["backend", "risk:high"] },
      { op: "globAny", path: "payload.files", patterns: ["src/**/*.js"] },
      {
        op: "globAll",
        path: "payload.files",
        patterns: ["src/**", "test/**/*.test.js"],
      },
      { op: "atLeast", path: "payload.riskScore", value: 7 },
    ],
  };

  const result = route([rule({ condition })]);
  const trace = result.explanation.rules[0].condition;

  assert.equal(result.outcome, "assigned");
  assert.equal(trace.op, "all");
  assert.equal(trace.result, true);
  assert.equal(trace.children.length, 8);
  assert.equal(trace.children[1].children.length, 2);
  assert.deepEqual(
    trace.children.map(({ op, result }) => [op, result]),
    [
      ["equals", true],
      ["any", true],
      ["not", true],
      ["hasAny", true],
      ["hasAll", true],
      ["globAny", true],
      ["globAll", true],
      ["atLeast", true],
    ],
  );
});

test("glob matching preserves path semantics without dynamic regular expressions", () => {
  const cases = [
    ["src/**/*.js", "src/index.js", true],
    ["src/**/*.js", "src/api/routes.js", true],
    ["src/**/*.js", "src/api/routes.ts", false],
    ["src/*.js", "src/index.js", true],
    ["src/*.js", "src/api/index.js", false],
    ["src/?.js", "src/a.js", true],
    ["src/?.js", "src/api.js", false],
    ["**.js", "src/api/routes.js", true],
    ["**/foo", "barfoo", false],
    ["**/foo", "bar/foo", true],
    ["src/**/routes.js", "src/api-routes.js", false],
    ["src/**/routes.js", "src/routes.js", true],
    ["**/", "abc", false],
    ["**/", "abc/", true],
  ];

  for (const [pattern, value, expected] of cases) {
    const result = route([
      rule({
        condition: { op: "globAny", path: "payload.files", patterns: [pattern] },
      }),
    ], {
      event: workflowEvent({ payload: { files: [value] } }),
    });
    assert.equal(result.outcome === "assigned", expected, `${pattern} -> ${value}`);
  }

  const source = readFileSync(
    new URL("../src/domain/workflow-router.js", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("new RegExp"), false);
});

test("enforces a global glob budget across all rules at exact boundaries", () => {
  const patternsAtCountLimit = Array.from(
    { length: 32 },
    (_, index) => `path-${index}-*.js`,
  );
  assert.doesNotThrow(() =>
    normalizeWorkflowRoutingConfig(
      config([
        rule({
          condition: {
            op: "globAny",
            path: "payload.files",
            patterns: patternsAtCountLimit,
          },
        }),
      ]),
    ),
  );
  assert.throws(
    () =>
      normalizeWorkflowRoutingConfig(
        config([
          rule({
            condition: {
              op: "globAny",
              path: "payload.files",
              patterns: [...patternsAtCountLimit, "one-too-many"],
            },
          }),
        ]),
      ),
    (error) =>
      error instanceof WorkflowRoutingError &&
      error.code === "INVALID_ROUTING_CONFIG" &&
      error.message.includes("glob 总预算超限"),
  );

  const patternsAtByteLimit = Array.from(
    { length: 8 },
    (_, index) => `${String(index)}${"x".repeat(255)}`,
  );
  assert.doesNotThrow(() =>
    normalizeWorkflowRoutingConfig(
      config([
        rule({
          condition: {
            op: "globAll",
            path: "payload.files",
            patterns: patternsAtByteLimit,
          },
        }),
      ]),
    ),
  );
  const startedAt = performance.now();
  const boundedResult = route(
    [
      rule({
        condition: {
          op: "globAny",
          path: "payload.files",
          patterns: patternsAtByteLimit,
        },
      }),
    ],
    {
      event: workflowEvent({ payload: { files: "z".repeat(16 * 1024) } }),
    },
  );
  assert.equal(boundedResult.outcome, "unmatched");
  assert.ok(
    performance.now() - startedAt < 1_000,
    "maximum accepted scalar glob workload must stay bounded",
  );
  assert.throws(
    () =>
      normalizeWorkflowRoutingConfig(
        config([
          rule({
            condition: {
              op: "globAll",
              path: "payload.files",
              patterns: [...patternsAtByteLimit, "x"],
            },
          }),
        ]),
      ),
    (error) =>
      error instanceof WorkflowRoutingError &&
      error.code === "INVALID_ROUTING_CONFIG" &&
      error.message.includes("2048 字节"),
  );
});

test("rejects oversized glob candidate work before synchronous matching", () => {
  const startedAt = performance.now();
  assert.throws(
    () =>
      route(
        [
          rule({
            condition: {
              op: "globAny",
              path: "payload.files",
              patterns: ["x".repeat(256)],
            },
          }),
        ],
        {
          event: workflowEvent({
            payload: {
              files: Array.from(
                { length: 10 },
                (_, index) => String(index).repeat(16_000),
              ),
            },
          }),
        },
      ),
    (error) =>
      error instanceof WorkflowRoutingError &&
      error.code === "ROUTING_GLOB_BUDGET",
  );
  assert.ok(performance.now() - startedAt < 500);
});

test("glob matching has bounded work for adversarial wildcard input", () => {
  const pattern = `${"*a".repeat(18)}b`;
  const value = "a".repeat(200);
  assert.equal(pattern.length, 37);
  assert.equal(value.length, 200);

  const startedAt = performance.now();
  const result = route([
    rule({
      condition: { op: "globAny", path: "payload.files", patterns: [pattern] },
    }),
  ], {
    event: workflowEvent({ payload: { files: [value] } }),
  });
  const elapsedMilliseconds = performance.now() - startedAt;

  assert.equal(result.outcome, "unmatched");
  assert.ok(
    elapsedMilliseconds < 500,
    `bounded glob match took ${elapsedMilliseconds.toFixed(1)}ms`,
  );
});

test("condition mismatches explain missing paths and type mismatches", () => {
  const result = route([
    rule({
      condition: {
        op: "all",
        conditions: [
          { op: "equals", path: "payload.missing", value: "x" },
          { op: "atLeast", path: "payload.author", value: 1 },
        ],
      },
    }),
  ]);
  const [missing, wrongType] = result.explanation.rules[0].condition.children;

  assert.equal(result.outcome, "unmatched");
  assert.equal(missing.found, false);
  assert.equal(Object.hasOwn(missing, "actual"), false);
  assert.equal(wrongType.found, true);
  assert.equal(wrongType.actualType, "string");
  assert.equal(wrongType.result, false);
});

test("deduplicates the same target after the highest-priority assignment", () => {
  const result = route([
    rule({
      id: "primary",
      priority: 20,
      onMatch: "continue",
      targets: [{ type: "role", id: "pr-reviewer" }],
    }),
    rule({
      id: "secondary",
      priority: 10,
      onMatch: "continue",
      targets: [
        { type: "role", id: "pr-reviewer" },
        { type: "person", id: "local-owner" },
      ],
    }),
  ]);

  assert.deepEqual(
    result.assignments.map(({ target }) => target),
    [
      { type: "role", id: "pr-reviewer" },
      { type: "person", id: "local-owner" },
    ],
  );
  assert.deepEqual(
    result.explanation.rules[1].targets.map(({ status }) => status),
    ["duplicate", "assigned"],
  );
});

test("rejects condition trees beyond depth, node, path, or string limits", () => {
  let tooDeep = { op: "equals", path: "eventType", value: "pull_request.created" };
  for (let index = 0; index < 9; index += 1) {
    tooDeep = { op: "not", condition: tooDeep };
  }
  const tooMany = {
    op: "all",
    conditions: Array.from({ length: 129 }, () => ({
      op: "equals",
      path: "eventType",
      value: "pull_request.created",
    })),
  };

  for (const condition of [
    tooDeep,
    tooMany,
    { op: "equals", path: "payload.__proto__.value", value: "x" },
    { op: "equals", path: `payload.${"x".repeat(600)}`, value: "x" },
    { op: "globAny", path: "payload.files", patterns: ["*".repeat(300)] },
  ]) {
    assert.throws(
      () => normalizeWorkflowRoutingConfig(config([rule({ condition })])),
      (error) =>
        error instanceof WorkflowRoutingError &&
        error.code === "INVALID_ROUTING_CONFIG",
    );
  }
});

test("rejects static node cycles and paths longer than maxHops", () => {
  const cycle = config([
    rule({
      id: "to-triage",
      targets: [{ type: "node", id: "triage" }],
    }),
    rule({
      id: "to-root",
      source: "triage",
      targets: [{ type: "node", id: "root" }],
    }),
  ]);
  const tooLong = config(
    [
      rule({ id: "one", targets: [{ type: "node", id: "one" }] }),
      rule({ id: "two", source: "one", targets: [{ type: "node", id: "two" }] }),
    ],
    { maxHops: 1 },
  );

  assert.throws(
    () => normalizeWorkflowRoutingConfig(cycle),
    (error) => error.code === "ROUTING_CYCLE",
  );
  assert.throws(
    () => normalizeWorkflowRoutingConfig(tooLong),
    (error) => error.code === "ROUTING_HOP_LIMIT",
  );
});

test("rejects a node assignment that revisits runtime context or exceeds hop limit", () => {
  const runtimeCycle = config([
    rule({
      id: "to-previous",
      source: "triage",
      targets: [{ type: "node", id: "previous" }],
    }),
  ]);
  const hopLimit = config(
    [
      rule({
        id: "to-next",
        source: "triage",
        targets: [{ type: "node", id: "next" }],
      }),
    ],
    { maxHops: 1 },
  );
  const context = {
    currentNodeId: "triage",
    visitedNodeIds: ["previous", "triage"],
    hopCount: 1,
  };

  assert.throws(
    () => routeWorkflowEvent({ event: workflowEvent(), config: runtimeCycle, context }),
    (error) => error.code === "ROUTING_CYCLE",
  );
  assert.throws(
    () => routeWorkflowEvent({ event: workflowEvent(), config: hopLimit, context }),
    (error) => error.code === "ROUTING_HOP_LIMIT",
  );
});

test("returns a deterministic disabled outcome without evaluating rules", () => {
  const result = routeWorkflowEvent({
    event: workflowEvent(),
    config: config([rule()], { enabled: false }),
  });

  assert.deepEqual(result, {
    outcome: "disabled",
    matches: [],
    assignments: [],
    explanation: {
      enabled: false,
      currentNodeId: "root",
      visitedNodeIds: ["root"],
      hopCount: 0,
      maxHops: 8,
      ruleOrder: ["route-pr-review"],
      rules: [
        {
          ruleId: "route-pr-review",
          source: "root",
          enabled: true,
          priority: 100,
          fallback: false,
          onMatch: "stop",
          status: "routing_disabled",
          condition: null,
          targets: [],
        },
      ],
      usedFallback: false,
      stoppedByRuleId: null,
    },
  });
});

test("createWorkflowRouter exposes the same pure route contract", () => {
  const router = createWorkflowRouter();
  const input = { event: workflowEvent(), config: config([rule()]) };

  assert.deepEqual(router.route(input), routeWorkflowEvent(input));
  assert.deepEqual(Object.keys(router), ["route"]);
});
