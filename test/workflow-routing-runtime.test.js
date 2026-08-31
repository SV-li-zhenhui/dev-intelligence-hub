import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowRouter } from "../src/domain/workflow-router.js";
import { createWorkflowRoutingRuntime } from "../src/workflow-routing-runtime.js";

class MemoryStore {
  constructor() {
    this.values = new Map();
    this.writes = 0;
  }

  async read(name, fallback = null) {
    return this.values.has(name)
      ? structuredClone(this.values.get(name))
      : structuredClone(fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
    this.writes += 1;
  }
}

class FakeGuard {
  constructor(events = []) {
    this.events = events;
    this.tail = Promise.resolve();
    this.closePromise = null;
  }

  async acquire() {
    this.events.push("acquire");
  }

  run(operation) {
    this.events.push("run");
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }

  close() {
    this.closePromise ||= Promise.resolve().then(() => {
      this.events.push("close");
    });
    return this.closePromise;
  }
}

function guardFactory(events = []) {
  return (options) => {
    assert.deepEqual(options, { name: "mydashboard-workflow-routing-v1" });
    return new FakeGuard(events);
  };
}

function definition(enabled = true) {
  return {
    schemaVersion: 1,
    enabled,
    maxHops: 8,
    rules: [],
  };
}

function assignedIssue(number, updatedAt) {
  return {
    id: `github:issue:acme/repo#${number}`,
    kind: "issue",
    repo: "acme/repo",
    number,
    title: `Issue ${number}`,
    author: "octocat",
    relation: "assigned",
    state: "open",
    createdAt: updatedAt,
    updatedAt,
    labels: [],
    assignees: ["local-owner"],
  };
}

test("an absent workflow definition constructs no routing state", async () => {
  const store = new MemoryStore();

  const runtime = await createWorkflowRoutingRuntime({}, { store });

  assert.equal(runtime, null);
  assert.equal(store.writes, 0);
});

test("startup records the local definition once and reuses the same version", async () => {
  const store = new MemoryStore();
  const config = { workflowRouting: definition() };
  const first = await createWorkflowRoutingRuntime(config, {
    store,
    router: createWorkflowRouter(),
    clock: () => "2026-08-02T04:00:00.000Z",
    createGuard: guardFactory(),
  });
  const firstConfig = await first.getConfig();
  const second = await createWorkflowRoutingRuntime(config, {
    store,
    router: createWorkflowRouter(),
    clock: () => "2026-08-02T04:01:00.000Z",
    createGuard: guardFactory(),
  });

  assert.equal(firstConfig.current.version, 1);
  assert.equal((await second.getConfig()).current.version, 1);
  assert.equal(store.writes, 1);
  await Promise.all([first.close(), second.close()]);
});

test("runtime injects the configured issue active window into snapshot routing", async () => {
  const runtime = await createWorkflowRoutingRuntime(
    {
      workflowRouting: definition(),
      githubRead: { issueActiveWindowDays: 3 },
    },
    {
      store: new MemoryStore(),
      router: createWorkflowRouter(),
      clock: () => "2026-08-02T04:00:00.000Z",
      createGuard: guardFactory(),
    },
  );

  const result = await runtime.ingestSnapshot({
    snapshot: {
      refreshedAt: "2026-08-02T01:00:00.000Z",
      sourceStatus: {
        githubPullRequests: { ok: true, stale: false },
        githubIssues: { ok: true, stale: false },
      },
      items: [
        assignedIssue(1, "2026-07-28T00:00:00.000Z"),
        assignedIssue(2, "2026-07-31T00:00:00.000Z"),
      ],
    },
  });

  assert.deepEqual(result.events.map(({ subject }) => subject.number), [2]);
  await runtime.close();
});

test("a whole local replacement advances version and preserves history", async () => {
  const store = new MemoryStore();
  const first = await createWorkflowRoutingRuntime(
    { workflowRouting: definition(true) },
    {
      store,
      clock: () => "2026-08-02T04:00:00.000Z",
      createGuard: guardFactory(),
    },
  );

  const runtime = await createWorkflowRoutingRuntime(
    { workflowRouting: definition(false) },
    {
      store,
      clock: () => "2026-08-02T04:01:00.000Z",
      createGuard: guardFactory(),
    },
  );
  const projection = await runtime.getConfig();

  assert.equal(projection.current.version, 2);
  assert.equal(projection.current.definition.enabled, false);
  assert.deepEqual(
    projection.history.map((entry) => entry.definition.enabled),
    [true, false],
  );
  await Promise.all([first.close(), runtime.close()]);
});

test("runtime acquires the named guard and exposes idempotent close", async () => {
  const events = [];
  const runtime = await createWorkflowRoutingRuntime(
    { workflowRouting: definition() },
    {
      store: new MemoryStore(),
      createGuard: guardFactory(events),
    },
  );

  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(typeof runtime.close, "function");
  assert.equal(typeof runtime.readAssignmentBatch, "function");
  assert.deepEqual(await runtime.readAssignmentBatch({ afterSequence: 0 }), {
    items: [],
    nextSequence: 0,
    highWatermark: 0,
    oldestAvailableSequence: 1,
  });
  assert.deepEqual(events.slice(0, 2), ["acquire", "run"]);
  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  assert.equal(events.filter((event) => event === "close").length, 1);
});

test("runtime closes its guard when acquisition or recovery fails", async (t) => {
  await t.test("acquisition failure", async () => {
    let closes = 0;
    const acquisitionFailure = new Error("guard held");
    await assert.rejects(
      createWorkflowRoutingRuntime(
        { workflowRouting: definition() },
        {
          store: new MemoryStore(),
          createGuard: () => ({
            async acquire() {
              throw acquisitionFailure;
            },
            async run(operation) {
              return operation();
            },
            async close() {
              closes += 1;
            },
          }),
        },
      ),
      (error) => error === acquisitionFailure,
    );
    assert.equal(closes, 1);
  });

  await t.test("recovery failure", async () => {
    let closes = 0;
    const store = new MemoryStore();
    store.values.set("workflow-routing-state", { corrupt: true });
    await assert.rejects(
      createWorkflowRoutingRuntime(
        { workflowRouting: definition() },
        {
          store,
          createGuard: () => ({
            async acquire() {},
            async run(operation) {
              return operation();
            },
            async close() {
              closes += 1;
            },
          }),
        },
      ),
      (error) => error.code === "WORKFLOW_STATE_CORRUPTED",
    );
    assert.equal(closes, 1);
  });
});
