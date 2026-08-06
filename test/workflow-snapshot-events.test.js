import assert from "node:assert/strict";
import test from "node:test";
import {
  projectWorkflowSnapshot,
  workflowEventsFromSnapshots,
} from "../src/domain/workflow-snapshot-events.js";

const REFRESHED_AT = "2026-08-02T02:00:00.000Z";

function pullRequest(number, overrides = {}) {
  return {
    id: `github:pr:acme/repo#${number}`,
    kind: "pull_request",
    repo: "acme/repo",
    number,
    title: `PR ${number}`,
    author: "alice",
    relation: "review_requested",
    state: "open",
    createdAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T02:00:00.000Z",
    labels: ["backend"],
    assignees: ["zhenhui"],
    isDraft: false,
    actionState: "action_now",
    nextActor: "me",
    nextAction: "review",
    requiresConfirmation: false,
    reviewDecision: "",
    ciStatus: "SUCCESS",
    mergeStateStatus: "CLEAN",
    headRefOid: `head-${number}`,
    myReviewState: "",
    ...overrides,
  };
}

function issue(number, overrides = {}) {
  return {
    id: `github:issue:acme/repo#${number}`,
    kind: "issue",
    repo: "acme/repo",
    number,
    title: `Issue ${number}`,
    author: "bob",
    relation: "assigned",
    state: "open",
    createdAt: "2026-08-01T03:00:00.000Z",
    updatedAt: "2026-08-01T04:00:00.000Z",
    labels: ["bug"],
    assignees: ["zhenhui"],
    ...overrides,
  };
}

function snapshot(items, overrides = {}) {
  return {
    refreshedAt: REFRESHED_AT,
    sourceStatus: {
      githubPullRequests: { ok: true, stale: false },
      githubIssues: { ok: true, stale: false },
    },
    items,
    ...overrides,
  };
}

function eventTypes(events) {
  return events.map((event) => `${event.subject.id}:${event.eventType}`);
}

test("snapshot projection is a deterministic safe replay checkpoint", () => {
  const input = snapshot(
    [
      issue(3, { labels: ["triage", "bug", "bug"] }),
      { id: "dingtalk:todo:1", kind: "todo", title: "ignore me" },
      pullRequest(1, {
        labels: ["risk:high", "backend"],
        token: "must-not-persist",
        env: { GH_TOKEN: "must-not-persist" },
        command: "gh pr review",
      }),
    ],
    {
      sourceStatus: {
        githubPullRequests: { ok: true, stale: false, detail: "drop" },
        githubIssues: { ok: false, stale: true, error: "drop" },
        dingtalk: { ok: true, stale: false },
      },
      errors: ["drop"],
    },
  );

  const projected = projectWorkflowSnapshot(input);
  const reordered = projectWorkflowSnapshot({
    ...input,
    items: [...input.items].reverse(),
  });

  assert.deepEqual(Object.keys(projected), [
    "refreshedAt",
    "sourceStatus",
    "items",
  ]);
  assert.deepEqual(projected.sourceStatus, {
    githubPullRequests: { ok: true, stale: false },
    githubIssues: { ok: false, stale: true },
  });
  assert.deepEqual(
    projected.items.map(({ id }) => id),
    ["github:pr:acme/repo#1", "github:issue:acme/repo#3"],
  );
  assert.deepEqual(projected.items[0].labels, ["backend", "risk:high"]);
  assert.deepEqual(projected.items[1].labels, ["bug", "triage"]);
  assert.deepEqual(reordered, projected);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
  assert.equal(JSON.stringify(projected).includes("must-not-persist"), false);
  assert.ok(Object.isFrozen(projected));
  assert.ok(projected.items.every(Object.isFrozen));
});

test("an initial healthy snapshot emits stable observed events with safe facts", () => {
  const unsafe = pullRequest(2, {
    token: "secret-token",
    env: { GH_TOKEN: "secret-token" },
    command: "gh pr merge",
  });
  const current = snapshot([
    issue(3),
    { id: "dingtalk:todo:1", kind: "todo" },
    unsafe,
    pullRequest(1),
  ]);

  const events = workflowEventsFromSnapshots(null, current);

  assert.deepEqual(eventTypes(events), [
    "github:pr:acme/repo#1:pull_request.observed",
    "github:pr:acme/repo#2:pull_request.observed",
    "github:issue:acme/repo#3:issue.observed",
  ]);
  assert.ok(events.every((event) => event.occurredAt === REFRESHED_AT));
  assert.ok(
    events.every(
      (event) =>
        event.source.provider === "github" &&
        event.source.scopeId === "github-dashboard",
    ),
  );
  assert.deepEqual(events[0].subject, {
    id: "github:pr:acme/repo#1",
    repository: "acme/repo",
    number: 1,
  });
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes('"env"'), false);
  assert.equal(serialized.includes('"command"'), false);
  assert.ok(events.every(Object.isFrozen));
});

test("additions and material changes emit granular events without flooding unchanged items", () => {
  const previous = snapshot([
    pullRequest(1),
    pullRequest(4),
    issue(10),
  ], { refreshedAt: "2026-08-02T01:00:00.000Z" });
  const current = snapshot([
    issue(10),
    issue(11),
    pullRequest(1, {
      title: "Merged PR 1",
      labels: ["backend", "risk:high"],
      state: "merged",
      ciStatus: "PENDING",
      updatedAt: "2026-08-02T01:59:00.000Z",
    }),
  ]);

  const events = workflowEventsFromSnapshots(previous, current, {
    sourceScopeId: "SV-li-zhenhui",
  });

  assert.deepEqual(eventTypes(events), [
    "github:pr:acme/repo#1:pull_request.updated",
    "github:pr:acme/repo#1:pull_request.classified",
    "github:pr:acme/repo#1:pull_request.status",
    "github:pr:acme/repo#1:pull_request.completed",
    "github:pr:acme/repo#4:pull_request.left_scope",
    "github:issue:acme/repo#11:issue.created",
  ]);
  assert.equal(events.every((event) => event.source.scopeId === "SV-li-zhenhui"), true);

  const changed = events.filter((event) => event.subject.number === 1);
  assert.deepEqual(changed[0].payload.changedFields, [
    "title",
    "updatedAt",
    "labels",
    "state",
    "ciStatus",
  ]);
  assert.deepEqual(changed[1].payload.changedFields, ["labels"]);
  assert.deepEqual(changed[2].payload.changedFields, ["state", "ciStatus"]);
  assert.equal(changed[3].payload.previousState, "open");
  assert.equal(changed[3].payload.state, "merged");
  assert.equal(
    events.some((event) => event.subject.id === "github:issue:acme/repo#10"),
    false,
  );
});

test("a changed PR Head carries its causal predecessor on the update event", () => {
  const previous = snapshot([
    pullRequest(1, { headRefOid: "head-a" }),
  ], { refreshedAt: "2026-08-02T01:00:00.000Z" });
  const current = snapshot([
    pullRequest(1, { headRefOid: "head-b" }),
  ]);

  const events = workflowEventsFromSnapshots(previous, current);

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "pull_request.updated");
  assert.equal(events[0].payload.headRefOid, "head-b");
  assert.equal(events[0].payload.previousHeadRefOid, "head-a");
  assert.deepEqual(events[0].payload.changedFields, ["headRefOid"]);
});

test("an unhealthy source suppresses all events for only its own item kind", () => {
  const previous = snapshot([pullRequest(1), issue(1)]);
  const current = snapshot([], {
    sourceStatus: {
      githubPullRequests: { ok: false, stale: true },
      githubIssues: { ok: true, stale: false },
    },
  });

  const events = workflowEventsFromSnapshots(previous, current);

  assert.deepEqual(eventTypes(events), [
    "github:issue:acme/repo#1:issue.left_scope",
  ]);
});

test("a source without a previous healthy baseline observes recovered history", () => {
  const previous = snapshot([], {
    refreshedAt: "2026-08-02T01:00:00.000Z",
    sourceStatus: {
      githubPullRequests: { ok: false, stale: true },
      githubIssues: { ok: true, stale: false },
    },
  });
  const current = snapshot([pullRequest(1), issue(2)]);

  assert.deepEqual(
    eventTypes(workflowEventsFromSnapshots(previous, current)),
    [
      "github:pr:acme/repo#1:pull_request.observed",
      "github:issue:acme/repo#2:issue.created",
    ],
  );
});

test("irrelevant and forbidden snapshot fields do not create update events", () => {
  const previous = snapshot([
    pullRequest(1, { labels: ["backend", "risk:high"] }),
  ]);
  const current = snapshot([
    pullRequest(1, {
      labels: ["risk:high", "backend"],
      token: "rotated-secret",
      env: { GH_TOKEN: "rotated-secret" },
      command: "different-command",
      displayOnlyNoise: "changed",
    }),
  ]);

  assert.deepEqual(workflowEventsFromSnapshots(previous, current), []);
});

test("event content, identity, and ordering are deterministic across repeated input", () => {
  const previous = snapshot([]);
  const current = snapshot([issue(9), pullRequest(8), issue(7)]);

  const first = workflowEventsFromSnapshots(previous, current);
  const repeated = workflowEventsFromSnapshots(previous, current);
  const reordered = workflowEventsFromSnapshots(
    previous,
    snapshot([...current.items].reverse()),
  );

  assert.deepEqual(repeated, first);
  assert.deepEqual(reordered, first);
  assert.deepEqual(
    first.map((event) => event.eventId),
    repeated.map((event) => event.eventId),
  );
});

test("completion requires a transition into a completed state", () => {
  const alreadyClosed = issue(1, { state: "closed" });
  const previous = snapshot([alreadyClosed]);
  const current = snapshot([alreadyClosed]);

  assert.deepEqual(workflowEventsFromSnapshots(previous, current), []);
  assert.deepEqual(
    eventTypes(workflowEventsFromSnapshots(snapshot([issue(1)]), current)),
    [
      "github:issue:acme/repo#1:issue.updated",
      "github:issue:acme/repo#1:issue.status",
      "github:issue:acme/repo#1:issue.completed",
    ],
  );
});
