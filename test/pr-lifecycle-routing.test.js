import assert from "node:assert/strict";
import test from "node:test";

import { withPrLifecycleRoutes } from "../src/domain/pr-lifecycle-routing.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { routeWorkflowEvent } from "../src/domain/workflow-router.js";

function pullRequestEvent(overrides = {}) {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.status",
    occurredAt: "2026-08-27T06:00:00.000Z",
    source: { provider: "github", scopeId: "dashboard" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      title: "PR 42",
      relation: "authored",
      state: "open",
      actionState: "action_now",
      nextAction: "address_review",
      ...overrides,
    },
  });
}

function definition() {
  return withPrLifecycleRoutes({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [{
      id: "generic-pr-route",
      source: "root",
      enabled: true,
      priority: 100,
      fallback: false,
      condition: {
        op: "equals",
        path: "eventType",
        value: "pull_request.status",
      },
      targets: [{ type: "role", id: "pr-engineer" }],
      onMatch: "stop",
    }],
  });
}

test("external review feedback on my PR routes directly to the developer", () => {
  const routed = routeWorkflowEvent({
    event: pullRequestEvent(),
    config: definition(),
  });

  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "developer" },
  ]);
});

test("another author's PR and my waiting PR remain with the PR engineer", () => {
  for (const event of [
    pullRequestEvent({
      relation: "review_requested",
      nextAction: "review",
    }),
    pullRequestEvent({
      actionState: "waiting_other",
      nextAction: "wait_rereview",
    }),
  ]) {
    const routed = routeWorkflowEvent({ event, config: definition() });
    assert.deepEqual(routed.assignments.map(({ target }) => target), [
      { type: "role", id: "pr-engineer" },
    ]);
  }
});

test("my PR enters testing after an external reviewer approves the current Head", () => {
  const routed = routeWorkflowEvent({
    event: pullRequestEvent({
      actionState: "waiting_other",
      nextAction: "wait_merge",
      reviewDecision: "APPROVED",
    }),
    config: definition(),
  });

  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "tester" },
  ]);
});

test("another author's PR enters testing after my approval of the current Head", () => {
  const routed = routeWorkflowEvent({
    event: pullRequestEvent({
      relation: "review_requested",
      actionState: "waiting_other",
      nextAction: "wait_merge",
      myReviewState: "APPROVED",
    }),
    config: definition(),
  });

  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "tester" },
  ]);
});
