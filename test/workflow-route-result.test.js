import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowRouter } from "../src/domain/workflow-router.js";
import { normalizeWorkflowRouteResult } from "../src/services/workflow-route-result.js";

function event() {
  return {
    schemaVersion: 1,
    eventType: "pull_request.created",
    occurredAt: "2026-08-02T01:00:00.000Z",
    source: { provider: "github", scopeId: "acme/repo" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: { number: 42 },
  };
}

function rule(id, overrides = {}) {
  return {
    id,
    source: "root",
    enabled: true,
    priority: 100,
    fallback: false,
    condition: {
      op: "equals",
      path: "eventType",
      value: "pull_request.created",
    },
    targets: [{ type: "role", id: `${id}-role` }],
    onMatch: "continue",
    ...overrides,
  };
}

function definition(rules) {
  return { schemaVersion: 1, enabled: true, maxHops: 8, rules };
}

function routed(config) {
  return createWorkflowRouter().route({ event: event(), config });
}

function matchedCondition() {
  return {
    op: "equals",
    path: "eventType",
    found: true,
    actual: "pull_request.created",
    actualType: "string",
    expected: "pull_request.created",
    result: true,
  };
}

test("strict route semantics reject a disabled rule forged as matched", () => {
  const config = definition([rule("disabled", { enabled: false })]);
  const result = routed(config);
  result.outcome = "assigned";
  result.matches = ["disabled"];
  result.assignments = [
    {
      ruleId: "disabled",
      target: { type: "role", id: "disabled-role" },
      priority: 100,
    },
  ];
  Object.assign(result.explanation.rules[0], {
    status: "matched",
    condition: matchedCondition(),
    targets: [
      {
        target: { type: "role", id: "disabled-role" },
        status: "assigned",
      },
    ],
  });

  assert.throws(
    () => normalizeWorkflowRouteResult(result, config),
    (error) => error.code === "WORKFLOW_ROUTE_INVALID",
  );
});

test("strict route semantics reject a source-mismatched rule forged as matched", () => {
  const config = definition([rule("remote", { source: "other-node" })]);
  const result = routed(config);
  result.outcome = "assigned";
  result.matches = ["remote"];
  result.assignments = [
    {
      ruleId: "remote",
      target: { type: "role", id: "remote-role" },
      priority: 100,
    },
  ];
  Object.assign(result.explanation.rules[0], {
    status: "matched",
    condition: matchedCondition(),
    targets: [
      {
        target: { type: "role", id: "remote-role" },
        status: "assigned",
      },
    ],
  });

  assert.throws(
    () => normalizeWorkflowRouteResult(result, config),
    (error) => error.code === "WORKFLOW_ROUTE_INVALID",
  );
});

test("strict route semantics reject fallback use after an ordinary match", () => {
  const config = definition([
    rule("ordinary"),
    rule("fallback", {
      priority: 0,
      fallback: true,
      condition: null,
      targets: [{ type: "person", id: "owner" }],
    }),
  ]);
  const result = routed(config);
  result.matches.push("fallback");
  result.assignments.push({
    ruleId: "fallback",
    target: { type: "person", id: "owner" },
    priority: 0,
  });
  result.explanation.usedFallback = true;
  Object.assign(result.explanation.rules[1], {
    status: "matched",
    condition: { op: "fallback", result: true },
    targets: [
      { target: { type: "person", id: "owner" }, status: "assigned" },
    ],
  });

  assert.throws(
    () => normalizeWorkflowRouteResult(result, config),
    (error) => error.code === "WORKFLOW_ROUTE_INVALID",
  );
});

test("strict route semantics reject matches and assignments after a stop rule", () => {
  const config = definition([
    rule("stop", { priority: 200, onMatch: "stop" }),
    rule("after", { priority: 100 }),
  ]);
  const result = routed(config);
  result.matches.push("after");
  result.assignments.push({
    ruleId: "after",
    target: { type: "role", id: "after-role" },
    priority: 100,
  });
  Object.assign(result.explanation.rules[1], {
    status: "matched",
    condition: matchedCondition(),
    targets: [
      {
        target: { type: "role", id: "after-role" },
        status: "assigned",
      },
    ],
  });

  assert.throws(
    () => normalizeWorkflowRouteResult(result, config),
    (error) => error.code === "WORKFLOW_ROUTE_INVALID",
  );
});

test("strict route semantics bind duplicate target statuses to assignments", () => {
  const target = { type: "role", id: "shared-role" };
  const config = definition([
    rule("first", { priority: 200, targets: [target] }),
    rule("second", { priority: 100, targets: [target] }),
  ]);
  const result = routed(config);
  result.explanation.rules[1].targets[0].status = "assigned";
  result.assignments.push({
    ruleId: "second",
    target,
    priority: 100,
  });

  assert.throws(
    () => normalizeWorkflowRouteResult(result, config),
    (error) => error.code === "WORKFLOW_ROUTE_INVALID",
  );
});
