import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowFactSource } from "../src/services/workflow-fact-source.js";

const NOW = "2026-08-02T04:00:00.000Z";

function item(eventType = "pull_request.updated") {
  return {
    event: {
      eventType,
      subject: { id: "github:pr:acme/repo#42" },
    },
  };
}

function snapshot(overrides = {}) {
  return {
    refreshedAt: "2026-08-02T03:59:00.000Z",
    sourceStatus: {
      githubPullRequests: { ok: true, stale: false },
      githubIssues: { ok: true, stale: false },
    },
    items: [
      {
        id: "github:pr:acme/repo#42",
        state: "open",
        ciStatus: "SUCCESS",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        nextAction: "wait_merge",
        actionState: "waiting_other",
      },
    ],
    ...overrides,
  };
}

function source(value, options = {}) {
  return new WorkflowFactSource({
    store: {
      async read(name) {
        assert.equal(name, "snapshot");
        return structuredClone(value);
      },
    },
    clock: () => NOW,
    ...options,
  });
}

test("reads allowlisted facts only from a healthy fresh local snapshot", async () => {
  const facts = source(snapshot());

  assert.deepEqual(await facts.read({ item: item(), fact: "ci-status" }), {
    healthy: true,
    fresh: true,
    value: "SUCCESS",
    observedAt: "2026-08-02T03:59:00.000Z",
  });
  assert.deepEqual(await facts.read({ item: item(), fact: "unknown-fact" }), {
    healthy: true,
    fresh: true,
    value: null,
    observedAt: "2026-08-02T03:59:00.000Z",
  });
});

test("unhealthy, stale, and missing facts never satisfy a workflow condition", async () => {
  const unhealthy = snapshot();
  unhealthy.sourceStatus.githubPullRequests.ok = false;
  assert.deepEqual(
    await source(unhealthy).read({ item: item(), fact: "state" }),
    {
      healthy: false,
      fresh: false,
      value: null,
      observedAt: "2026-08-02T03:59:00.000Z",
    },
  );

  const stale = snapshot({ refreshedAt: "2026-08-02T03:00:00.000Z" });
  assert.equal(
    (await source(stale).read({ item: item(), fact: "state" })).fresh,
    false,
  );

  const missing = snapshot({ items: [] });
  assert.equal(
    (await source(missing).read({ item: item(), fact: "state" })).value,
    null,
  );
});

test("source health is selected from the work event kind", async () => {
  const value = snapshot({
    sourceStatus: {
      githubPullRequests: { ok: true, stale: false },
      githubIssues: { ok: false, stale: false },
    },
  });
  const result = await source(value).read({
    item: item("issue.updated"),
    fact: "state",
  });
  assert.equal(result.healthy, false);
  assert.equal(result.fresh, false);
});

test("malformed arrays and accessor-bearing inputs fail closed without execution", async () => {
  let getterCalls = 0;
  const malicious = snapshot();
  const array = [];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return malicious.items[0];
    },
  });
  array.length = 1;
  malicious.items = array;
  const store = {
    async read() {
      return malicious;
    },
  };
  const facts = new WorkflowFactSource({ store, clock: () => NOW });

  assert.deepEqual(await facts.read({ item: item(), fact: "state" }), {
    healthy: false,
    fresh: false,
    value: null,
    observedAt: "2026-08-02T03:59:00.000Z",
  });
  assert.equal(getterCalls, 0);

  const request = { fact: "state" };
  Object.defineProperty(request, "item", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return item();
    },
  });
  await assert.rejects(facts.read(request), /request is invalid/);
  assert.equal(getterCalls, 0);
});
