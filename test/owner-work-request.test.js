import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createOwnerPullRequestEvent,
  createOwnerWorkRequestEvent,
  normalizeOwnerWorkRequest,
  withOwnerWorkRequestDefaultRoute,
} from "../src/domain/owner-work-request.js";
import { StateStore } from "../src/lib/state-store.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { routeWorkflowEvent } from "../src/domain/workflow-router.js";
import { createOwnerWorkRequestRuntime } from "../src/owner-work-request-runtime.js";
import {
  normalizeOwnerWorkRequestState,
  OWNER_WORK_REQUEST_STATE_KEY,
} from "../src/services/owner-work-request-state.js";
import { createWorkLedgerRuntime } from "../src/work-ledger-runtime.js";
import { createWorkflowRoutingRuntime } from "../src/workflow-routing-runtime.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: REQUEST_ID,
    workType: "general",
    priority: "high",
    title: "Build a safe owner intake",
    description: "Route one durable shared task through the command center.",
    acceptanceCriteria: ["One shared root", "No browser-selected authority"],
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    schemaVersion: 2,
    requestId: REQUEST_ID,
    workType: "pull_request",
    priority: "high",
    title: "Review an explicitly selected PR",
    description: "Continue this PR even when it is outside automatic discovery.",
    acceptanceCriteria: ["Use a newly bound authority source"],
    pullRequest: { repository: "acme/repo", number: 42 },
    ...overrides,
  };
}

function guardFactory() {
  return {
    async acquire() {},
    async run(operation) {
      return operation();
    },
    async close() {},
  };
}

function clockFixture() {
  let now = Date.parse("2026-08-08T01:00:00.000Z");
  return () => {
    const value = new Date(now);
    now += 1_000;
    return value;
  };
}

function routingConfig({ enabled = true } = {}) {
  return {
    workflowRouting: {
      schemaVersion: 1,
      enabled,
      maxHops: 8,
      rules: [
        {
          id: "generic-owner-fallback",
          source: "root",
          enabled: true,
          priority: 0,
          fallback: true,
          condition: null,
          targets: [{ type: "person", id: "local-user" }],
          onMatch: "stop",
        },
      ],
    },
  };
}

function roleReadiness(overrides = {}) {
  return {
    async read(roleId) {
      return {
        roleId,
        enabled: true,
        paused: false,
        ...overrides,
      };
    },
  };
}

async function createRoutingAndLedger(store, clock, options = {}) {
  const routing = await createWorkflowRoutingRuntime(
    routingConfig(options),
    { store, clock, createGuard: guardFactory },
  );
  const ledger = await createWorkLedgerRuntime({
    store,
    assignmentSource: routing,
    clock,
    idFactory: () => "owner-work-lease",
    createGuard: guardFactory,
  });
  return { routing, ledger };
}

test("owner request DTO exposes business fields only and creates a bound workflow event", () => {
  const normalized = normalizeOwnerWorkRequest(request({
    title: "  Build intake  ",
    acceptanceCriteria: ["  One root  "],
  }));
  assert.equal(normalized.title, "Build intake");
  assert.deepEqual(normalized.acceptanceCriteria, ["One root"]);
  assert.equal(Object.isFrozen(normalized), true);

  const event = createOwnerWorkRequestEvent(
    normalized,
    "2026-08-08T01:00:00.000Z",
  );
  assert.equal(event.eventType, "owner_request.created");
  assert.deepEqual(event.subject, {
    id: `owner-request:${REQUEST_ID}`,
    requestId: REQUEST_ID,
  });
  assert.deepEqual(event.source, {
    provider: "local-owner",
    scopeId: "owner-command-center",
  });
  assert.equal("roleId" in event.payload, false);
  assert.equal("nodeId" in event.payload, false);
  assert.equal("permissions" in event.payload, false);
  const baseEvent = {
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    source: event.source,
    subject: event.subject,
    payload: event.payload,
  };
  assert.throws(
    () => normalizeWorkflowEvent({
      ...baseEvent,
      source: { provider: "github", scopeId: "owner-command-center" },
    }),
    (error) => error.code === "INVALID_WORKFLOW_EVENT",
  );
  assert.throws(
    () => normalizeWorkflowEvent({
      ...baseEvent,
      payload: { ...baseEvent.payload, permissions: ["write"] },
    }),
    (error) => error.code === "INVALID_WORKFLOW_EVENT",
  );

  const routedDefinition = withOwnerWorkRequestDefaultRoute({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [
      {
        id: "browser-configured-owner-hijack",
        source: "root",
        enabled: true,
        priority: 10_000,
        fallback: false,
        condition: {
          op: "equals",
          path: "eventType",
          value: "owner_request.created",
        },
        targets: [{ type: "role", id: "developer" }],
        onMatch: "stop",
      },
    ],
  });
  assert.deepEqual(routedDefinition.rules.find(
    ({ id }) => id === "system-owner-request-to-orchestrator",
  ).targets, [
    { type: "role", id: "orchestrator" },
  ]);
  const protectedResult = routeWorkflowEvent({
    event,
    config: routedDefinition,
  });
  assert.deepEqual(
    protectedResult.assignments.map(({ target }) => target),
    [{ type: "role", id: "orchestrator" }],
  );
  assert.equal(
    protectedResult.explanation.rules.find(({ status }) => status === "matched")
      ?.ruleId,
    "system-owner-request-to-orchestrator",
  );

  for (const invalid of [
    request({ roleId: "developer" }),
    request({ requestId: "browser-chosen-internal-id" }),
    request({ workType: "../../internal/worker" }),
    request({ acceptanceCriteria: ["same", "same"] }),
  ]) {
    assert.throws(
      () => normalizeOwnerWorkRequest(invalid),
      (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
    );
  }
});

test("testing handoff preserves a structured GitHub responsible person", () => {
  const normalized = normalizeOwnerWorkRequest(request({
    schemaVersion: 3,
    workType: "testing",
    pullRequest: { repository: "acme/repo", number: 42 },
    responsiblePerson: { login: "bs-tester", product: "bs" },
  }));
  const event = createOwnerPullRequestEvent(
    normalized,
    {
      repository: "acme/repo",
      number: 42,
      title: "PR 42",
      state: "open",
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid: "d".repeat(40),
        headRepository: "contributor/repo",
        headRefName: "fix/testing-handoff",
        headRefOid: "a".repeat(40),
      },
    },
    "2026-08-08T01:00:00.000Z",
  );

  assert.deepEqual(normalized.responsiblePerson, {
    login: "bs-tester",
    product: "bs",
  });
  assert.deepEqual(event.payload.responsiblePerson, {
    login: "bs-tester",
    product: "bs",
  });
  assert.throws(
    () => normalizeOwnerWorkRequest(request({
      schemaVersion: 3,
      workType: "development",
      pullRequest: { repository: "acme/repo", number: 42 },
      responsiblePerson: { login: "bs-tester", product: "bs" },
    })),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
});

test("review and development handoffs accept a named responsible person", () => {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "d".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/named-handoff",
    headRefOid: "a".repeat(40),
  };
  for (const workType of ["pull_request", "development"]) {
    const normalized = normalizeOwnerWorkRequest(request({
      schemaVersion: 4,
      workType,
      pullRequest: { repository: "acme/repo", number: 42 },
      responsiblePerson: { login: "named-owner", product: "qt" },
    }));
    const event = createOwnerPullRequestEvent(
      normalized,
      {
        repository: "acme/repo",
        number: 42,
        title: "PR 42",
        state: "open",
        gitTarget,
      },
      "2026-08-08T01:00:00.000Z",
    );

    assert.deepEqual(normalized.responsiblePerson, {
      login: "named-owner",
      product: "qt",
    });
    assert.deepEqual(event.payload.responsiblePerson, {
      login: "named-owner",
      product: "qt",
    });
    const routed = routeWorkflowEvent({
      event,
      config: withOwnerWorkRequestDefaultRoute({
        schemaVersion: 1,
        enabled: true,
        maxHops: 8,
        rules: [],
      }),
    });
    assert.equal(
      routed.assignments[0].target.id,
      workType === "development" ? "developer" : "pr-engineer",
    );
  }
});

test("owner capability requests route directly to their fixed least-authority roles", () => {
  const definition = withOwnerWorkRequestDefaultRoute({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [],
  });
  const expectations = new Map([
    ["development", "developer"],
    ["testing", "tester"],
    ["requirements", "requirements-analyst"],
    ["general", "orchestrator"],
  ]);

  for (const [workType, roleId] of expectations) {
    const event = createOwnerWorkRequestEvent(
      request({ workType }),
      "2026-08-08T01:00:00.000Z",
    );
    const routed = routeWorkflowEvent({ event, config: definition });

    assert.deepEqual(
      routed.assignments.map(({ target }) => target),
      [{ type: "role", id: roleId }],
    );
  }
});

test("an explicit PR request requires a structured target and creates a distinct owner authority event", () => {
  const normalized = normalizeOwnerWorkRequest(pullRequest());
  assert.deepEqual(normalized.pullRequest, {
    repository: "acme/repo",
    number: 42,
  });
  assert.throws(
    () => normalizeOwnerWorkRequest(pullRequest({ pullRequest: undefined })),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
  assert.equal(
    normalizeOwnerWorkRequest(request({ workType: "pull_request" }))
      .schemaVersion,
    1,
  );

  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "d".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/owner-request",
    headRefOid: "a".repeat(40),
  };
  const event = createOwnerPullRequestEvent(
    normalized,
    {
      repository: "acme/repo",
      number: 42,
      title: "PR 42",
      state: "open",
      gitTarget,
    },
    "2026-08-08T01:00:00.000Z",
  );
  assert.equal(event.eventType, "pull_request.owner_requested");
  assert.deepEqual(event.source, {
    provider: "local-owner",
    scopeId: `owner-request:${REQUEST_ID}`,
  });
  assert.deepEqual(event.subject, {
    id: "github:pr:acme/repo#42",
    repository: "acme/repo",
    number: 42,
  });
  assert.equal(event.payload.headRefOid, gitTarget.headRefOid);
  assert.equal(event.payload.state, "open");
  assert.deepEqual(event.payload.gitTarget, gitTarget);

  assert.throws(
    () => createOwnerPullRequestEvent(
      normalized,
      {
        repository: "acme/repo",
        number: 42,
        title: "PR 42",
        state: "closed",
        gitTarget,
      },
      "2026-08-08T01:00:00.000Z",
    ),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );

  const routed = withOwnerWorkRequestDefaultRoute({
    schemaVersion: 1,
    enabled: true,
    maxHops: 8,
    rules: [],
  });
  assert.deepEqual(
    routeWorkflowEvent({ event, config: routed }).assignments.map(
      ({ target }) => target,
    ),
    [{ type: "role", id: "pr-engineer" }],
  );
});

test("default route creates exactly one durable orchestrator root and replay is idempotent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-work-request-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));

  const [first, replay] = await Promise.all([
    owner.submit(request()),
    owner.submit(request()),
  ]);
  assert.equal(first.deduplicated, false);
  assert.equal(replay.deduplicated, true);
  assert.equal(first.phase, "intaken");
  assert.equal(replay.workItemId, first.workItemId);
  assert.deepEqual(first.assignment.target, {
    type: "role",
    id: "orchestrator",
  });

  const assignments = await routing.listAssignments({ limit: 10 });
  const items = await ledger.listItems({ limit: 10 });
  const graph = await ledger.graphReader.getSnapshot();
  assert.equal(assignments.items.length, 1);
  assert.equal(items.items.length, 1);
  assert.equal(graph.graph.tasks.length, 1);
  assert.equal(graph.graph.tasks[0].taskId, first.workItemId);
  assert.deepEqual(graph.graph.tasks[0].responsibility, {
    type: "role",
    id: "orchestrator",
  });
  assert.deepEqual(graph.taskStates[0].work, {
    title: request().title,
    description: request().description,
  });

  await assert.rejects(
    owner.submit(request({ title: "Different work under the same request ID" })),
    (error) => error.code === "OWNER_WORK_REQUEST_IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("an explicit PR request resolves one immutable target before staging a PR engineer root", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-pr-request-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let resolveCalls = 0;
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    pullRequestResolver: {
      async resolvePullRequestTarget(target) {
        resolveCalls += 1;
        return {
          ...target,
          title: "PR 42",
          state: "open",
          gitTarget: {
            schemaVersion: 1,
            provider: "github",
            sourceAccountId: "runtime-user",
            baseRepository: target.repository,
            baseRefName: "main",
            baseRefOid: "d".repeat(40),
            headRepository: "contributor/repo",
            headRefName: "fix/owner-request",
            headRefOid: "a".repeat(40),
          },
        };
      },
    },
    clock,
    createGuard: guardFactory,
  });
  t.after(() => Promise.all([owner.close(), ledger.close(), routing.close()]));

  await assert.rejects(
    owner.submit(request({ workType: "pull_request" })),
    (error) => error.code === "OWNER_WORK_REQUEST_INVALID",
  );
  assert.equal(resolveCalls, 0);
  const first = await owner.submit(pullRequest());
  const replay = await owner.submit(pullRequest());
  assert.equal(resolveCalls, 1);
  assert.equal(first.phase, "intaken");
  assert.deepEqual(first.assignment.target, {
    type: "role",
    id: "pr-engineer",
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.workItemId, first.workItemId);
  const item = (await ledger.listItems({ limit: 10 })).items[0];
  assert.equal(item.source.scope.kind, "owner_requested");
  assert.equal(item.source.current.event.payload.headRefOid, "a".repeat(40));
  assert.equal(item.source.current.event.payload.state, "open");

  const namedDevelopment = await owner.submit(pullRequest({
    schemaVersion: 4,
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workType: "development",
    responsiblePerson: { login: "runtime-user", product: "qt" },
  }));
  assert.equal(resolveCalls, 2);
  assert.deepEqual(namedDevelopment.assignment.target, {
    type: "role",
    id: "developer",
  });
  assert.deepEqual(namedDevelopment.request.pullRequest, {
    repository: "acme/repo",
    number: 42,
  });
  assert.deepEqual(namedDevelopment.request.responsiblePerson, {
    login: "runtime-user",
    product: "qt",
  });
});

test("restart resumes a staged request after a lost routing response without duplication", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-work-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let loseResponse = true;
  const uncertainRouting = {
    dryRun: routing.dryRun,
    async ingest(input) {
      const result = await routing.ingest(input);
      if (loseResponse) {
        loseResponse = false;
        throw Object.assign(new Error("simulated lost response"), {
          code: "SIMULATED_LOST_RESPONSE",
        });
      }
      return result;
    },
  };
  const firstRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: uncertainRouting,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  await assert.rejects(
    firstRuntime.submit(request()),
    (error) => error.code === "SIMULATED_LOST_RESPONSE",
  );
  await firstRuntime.close();
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 0);

  const recoveredRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  t.after(() =>
    Promise.all([recoveredRuntime.close(), ledger.close(), routing.close()])
  );
  const recovered = await recoveredRuntime.get(REQUEST_ID);
  assert.equal(recovered.phase, "intaken");
  assert.equal(recovered.audit.length, 3);
  assert.deepEqual(
    recovered.audit.map(({ type }) => type),
    ["request_staged", "request_routed", "request_intaken"],
  );
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("restart reconciles a lost ledger intake response to the existing work item", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-ledger-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  let loseResponse = true;
  const uncertainLedger = {
    async intake(input) {
      const result = await ledger.intake(input);
      if (loseResponse) {
        loseResponse = false;
        throw Object.assign(new Error("simulated lost ledger response"), {
          code: "SIMULATED_LEDGER_RESPONSE_LOST",
        });
      }
      return result;
    },
    listItems: ledger.listItems,
  };
  const firstRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger: uncertainLedger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  await assert.rejects(
    firstRuntime.submit(request()),
    (error) => error.code === "SIMULATED_LEDGER_RESPONSE_LOST",
  );
  await firstRuntime.close();
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);

  const recoveredRuntime = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  t.after(() =>
    Promise.all([recoveredRuntime.close(), ledger.close(), routing.close()])
  );
  const recovered = await recoveredRuntime.get(REQUEST_ID);
  assert.equal(recovered.phase, "intaken");
  assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 1);
  assert.equal((await ledger.listItems({ limit: 10 })).items.length, 1);
});

test("routing and role readiness fail before staging owner-controlled work", async (t) => {
  for (const fixture of [
    { enabled: false, readiness: roleReadiness(), code: "OWNER_WORK_REQUEST_ROUTING_NOT_READY" },
    { enabled: true, readiness: roleReadiness({ paused: true }), code: "OWNER_WORK_REQUEST_ROLE_NOT_READY" },
  ]) {
    const root = await mkdtemp(path.join(tmpdir(), "owner-work-not-ready-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const store = new StateStore(path.join(root, "state"));
    const clock = clockFixture();
    const { routing, ledger } = await createRoutingAndLedger(store, clock, {
      enabled: fixture.enabled,
    });
    const owner = await createOwnerWorkRequestRuntime({
      store,
      workflowRouting: routing,
      ledger,
      roleReadiness: fixture.readiness,
      clock,
      createGuard: guardFactory,
    });
    await assert.rejects(
      owner.submit(request()),
      (error) => error.code === fixture.code && error.statusCode === 503,
    );
    assert.equal(await store.read(OWNER_WORK_REQUEST_STATE_KEY, null), null);
    assert.equal((await routing.listAssignments({ limit: 10 })).items.length, 0);
    await Promise.all([owner.close(), ledger.close(), routing.close()]);
  }
});

test("owner request recovery rejects a modified durable audit chain", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "owner-work-corruption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new StateStore(path.join(root, "state"));
  const clock = clockFixture();
  const { routing, ledger } = await createRoutingAndLedger(store, clock);
  const owner = await createOwnerWorkRequestRuntime({
    store,
    workflowRouting: routing,
    ledger,
    roleReadiness: roleReadiness(),
    clock,
    createGuard: guardFactory,
  });
  await owner.submit(request());
  await owner.close();
  const state = await store.read(OWNER_WORK_REQUEST_STATE_KEY);
  state.records[0].audit[0].details.eventId = `workflow-event-${"f".repeat(64)}`;
  await store.write(OWNER_WORK_REQUEST_STATE_KEY, state);
  assert.throws(
    () => normalizeOwnerWorkRequestState(state),
    (error) => error.code === "OWNER_WORK_REQUEST_STATE_CORRUPTED",
  );
  await assert.rejects(
    createOwnerWorkRequestRuntime({
      store,
      workflowRouting: routing,
      ledger,
      roleReadiness: roleReadiness(),
      clock,
      createGuard: guardFactory,
    }),
    (error) => error.code === "OWNER_WORK_REQUEST_STATE_CORRUPTED",
  );
  await Promise.all([ledger.close(), routing.close()]);
});
