import assert from "node:assert/strict";
import test from "node:test";
import { createPullRequestReadIdentity } from "../src/domain/pull-request-read-facts.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { WorkflowFactSource } from "../src/services/workflow-fact-source.js";

const NOW = "2026-08-02T04:00:00.000Z";

function item(eventType = "pull_request.updated", headRefOid = "HEAD-A") {
  return {
    event: {
      eventType,
      subject: { id: "github:pr:acme/repo#42" },
      ...(eventType.startsWith("pull_request.")
        ? { payload: { headRefOid } }
        : {}),
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
        headRefOid: "HEAD-A",
      },
    ],
    ...overrides,
  };
}

function gitTargetFacts(overrides = {}) {
  const facts = {
    githubAccount: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: "b".repeat(40),
    ...overrides,
  };
  return {
    headRefOid: facts.headRefOid,
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: facts.githubAccount,
      baseRepository: facts.baseRepository,
      baseRefName: facts.baseRefName,
      baseRefOid: facts.baseRefOid,
      headRepository: facts.headRepository,
      headRefName: facts.headRefName,
      headRefOid: facts.headRefOid,
    },
  };
}

function gitTargetItem(overrides = {}) {
  const target = gitTargetFacts(overrides);
  return {
    event: {
      eventType: "pull_request.updated",
      subject: {
        id: "github:pr:acme/repo#42",
        repository: "acme/repo",
        number: 42,
      },
      payload: { ...target },
    },
  };
}

function flatGitTargetFacts(target = gitTargetFacts().gitTarget) {
  return {
    githubAccount: target.sourceAccountId,
    baseRepository: target.baseRepository,
    baseRefName: target.baseRefName,
    baseRefOid: target.baseRefOid,
    headRepository: target.headRepository,
    headRefName: target.headRefName,
    headRefOid: target.headRefOid,
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

function taskContextFixture({ gitTargetAvailable = true } = {}) {
  const target = gitTargetFacts().gitTarget;
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.updated",
    occurredAt: "2026-08-02T03:59:00.000Z",
    source: { provider: "github", scopeId: "github-account:runtime-user" },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      headRefOid: target.headRefOid,
      ...(gitTargetAvailable
        ? { gitTargetAvailable: true, gitTarget: target }
        : {}),
    },
  });
  return {
    event,
    sourceBinding: {
      kind: "pull_request",
      rootItemId: "work-item-pr-root",
      workKey: "acme/repo#42:pr-engineer",
      inputRevision: 3,
      headRevision: 2,
      headRefOid: target.headRefOid,
      eventId: event.eventId,
      eventDigest: event.contentDigest,
      inputDigest: "d".repeat(64),
    },
  };
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

test("pull request facts are bound to the exact event Head", async () => {
  const value = snapshot();
  value.items[0].headRefOid = "HEAD-B";
  const facts = source(value);

  for (const fact of [
    "ci-status",
    "review-decision",
    "next-action",
    "state",
  ]) {
    assert.deepEqual(await facts.read({ item: item(), fact }), {
      healthy: true,
      fresh: false,
      value: null,
      observedAt: "2026-08-02T03:59:00.000Z",
    });
  }
});

test("pull request facts fail closed when either Head is missing", async () => {
  const missingExpectedHead = item();
  missingExpectedHead.event.payload = {};
  assert.equal(
    (await source(snapshot()).read({
      item: missingExpectedHead,
      fact: "ci-status",
    })).fresh,
    false,
  );

  const missingObservedHead = snapshot();
  delete missingObservedHead.items[0].headRefOid;
  assert.equal(
    (await source(missingObservedHead).read({
      item: item(),
      fact: "ci-status",
    })).fresh,
    false,
  );
});

test("v2 PR facts are fresh only for the same account, base, branches, repositories, and Head", async () => {
  const value = snapshot();
  value.items[0] = {
    ...value.items[0],
    ...gitTargetFacts(),
  };
  const facts = source(value);

  assert.equal(
    (await facts.read({ item: gitTargetItem(), fact: "base-oid" })).value,
    "a".repeat(40),
  );
  for (const change of [
    { githubAccount: "other-user" },
    { baseRefOid: "c".repeat(40) },
    { baseRefName: "release/next" },
    { headRepository: "other/repo" },
    { headRefName: "other-branch" },
  ]) {
    const result = await facts.read({
      item: gitTargetItem(change),
      fact: "ci-status",
    });
    assert.equal(result.fresh, false);
    assert.equal(result.value, null);
  }
});

test("contradictory Git target availability markers and duplicate facts fail closed", async (t) => {
  const targetFacts = gitTargetFacts();
  const cases = [
    {
      name: "unavailable marker with a nested target",
      item: { ...targetFacts, gitTargetAvailable: false },
    },
    {
      name: "available marker with only legacy flat facts",
      item: {
        ...flatGitTargetFacts(targetFacts.gitTarget),
        gitTargetAvailable: true,
      },
    },
    {
      name: "nested target conflicts with repeated flat facts",
      item: {
        ...targetFacts,
        ...flatGitTargetFacts(targetFacts.gitTarget),
        githubAccount: "other-user",
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const value = snapshot();
      value.items[0] = { ...value.items[0], ...entry.item };
      const observed = await source(value).read({
        item: gitTargetItem(),
        fact: "ci-status",
      });
      assert.equal(observed.healthy, true);
      assert.equal(observed.fresh, false);
      assert.equal(observed.value, null);
    });
  }
});

test("a marker-free legacy flat target remains readable only when complete", async () => {
  const value = snapshot();
  value.items[0] = {
    ...value.items[0],
    ...flatGitTargetFacts(),
  };

  const observed = await source(value).read({
    item: gitTargetItem(),
    fact: "ci-status",
  });

  assert.equal(observed.fresh, true);
  assert.equal(observed.value, "SUCCESS");
});

test("legacy Head-only work cannot treat a new target-aware snapshot as fresh", async () => {
  const value = snapshot();
  value.items[0] = { ...value.items[0], ...gitTargetFacts() };

  const result = await source(value).read({
    item: item("pull_request.updated", "b".repeat(40)),
    fact: "ci-status",
  });

  assert.equal(result.healthy, true);
  assert.equal(result.fresh, false);
  assert.equal(result.value, null);
});

test("issue facts remain readable without a Head binding", async () => {
  const value = snapshot({
    items: [{
      id: "github:issue:acme/repo#42",
      state: "open",
      description: "Steps plus https://github.com/user-attachments/assets/image",
      commentsCount: 3,
      latestComment: {
        author: "carol",
        body: "Video attached; the problem reproduces after save",
        createdAt: "2026-08-02T03:40:00.000Z",
        updatedAt: "2026-08-02T03:40:00.000Z",
        url: "https://github.com/acme/repo/issues/42#issuecomment-1",
      },
    }],
  });
  const issue = item("issue.updated");
  issue.event.subject.id = "github:issue:acme/repo#42";

  assert.deepEqual(await source(value).read({ item: issue, fact: "state" }), {
    healthy: true,
    fresh: true,
    value: "open",
    observedAt: "2026-08-02T03:59:00.000Z",
  });
  assert.equal(
    (await source(value).read({ item: issue, fact: "issue-description" })).value,
    "Steps plus https://github.com/user-attachments/assets/image",
  );
  assert.equal(
    (await source(value).read({ item: issue, fact: "issue-comments-count" })).value,
    "3",
  );
  assert.deepEqual(
    JSON.parse(
      (await source(value).read({ item: issue, fact: "issue-latest-comment" })).value,
    ),
    value.items[0].latestComment,
  );
  assert.equal(
    (await source(snapshot()).read({
      item: item(),
      fact: "issue-description",
    })).value,
    null,
  );
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

  const proxiedItems = new Proxy([snapshot().items[0]], {
    getPrototypeOf() {
      getterCalls += 1;
      throw new Error("array prototype trap must not run");
    },
    getOwnPropertyDescriptor() {
      getterCalls += 1;
      throw new Error("array descriptor trap must not run");
    },
    get() {
      getterCalls += 1;
      throw new Error("array get trap must not run");
    },
  });
  const proxiedSnapshot = snapshot({ items: proxiedItems });
  const proxiedFacts = new WorkflowFactSource({
    store: { async read() { return proxiedSnapshot; } },
    clock: () => NOW,
  });
  assert.deepEqual(await proxiedFacts.read({ item: item(), fact: "state" }), {
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

  const maliciousItem = item();
  Object.defineProperty(maliciousItem.event.payload, "headRefOid", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "HEAD-A";
    },
  });
  assert.deepEqual(
    await source(snapshot()).read({ item: maliciousItem, fact: "state" }),
    {
      healthy: true,
      fresh: false,
      value: null,
      observedAt: "2026-08-02T03:59:00.000Z",
    },
  );
  assert.equal(getterCalls, 0);
});

test("a frozen PR task-context reader constructs one exact v2 execution", async () => {
  const calls = [];
  const signals = [];
  const facts = source(snapshot(), {
    pullRequestFacts: {
      async context(input, options) {
        calls.push(structuredClone(input));
        signals.push(options?.signal ?? null);
        const identity = createPullRequestReadIdentity(input);
        return Object.freeze({
          schemaVersion: 1,
          identityDigest: identity.identityDigest,
          contentDigest: "e".repeat(64),
          summary: { reviewDecision: "REVIEW_REQUIRED" },
        });
      },
    },
  });
  const reader = facts.pullRequestTaskContextReader();
  const fixture = taskContextFixture();
  const controller = new AbortController();

  assert.equal(Object.isFrozen(reader), true);
  const context = await reader.read(fixture, { signal: controller.signal });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionBinding.schemaVersion, 2);
  assert.equal(
    calls[0].executionBinding.gitTarget.sourceAccountId,
    "runtime-user",
  );
  assert.equal(calls[0].event.eventId, fixture.event.eventId);
  assert.strictEqual(signals[0], controller.signal);
  assert.equal(context.identityDigest,
    createPullRequestReadIdentity(calls[0]).identityDigest);
  assert.equal(source(snapshot()).pullRequestTaskContextReader(), null);
});

test("PR task-context reading rejects legacy or mismatched identity before use", async () => {
  let calls = 0;
  const facts = source(snapshot(), {
    pullRequestFacts: {
      async context() {
        calls += 1;
        return { identityDigest: "0".repeat(64) };
      },
    },
  });
  const reader = facts.pullRequestTaskContextReader();

  await assert.rejects(
    reader.read(taskContextFixture({ gitTargetAvailable: false })),
    /atomic Git target/u,
  );
  assert.equal(calls, 0);

  await assert.rejects(
    reader.read(taskContextFixture()),
    /identity is stale/u,
  );
  assert.equal(calls, 1);
});

test("PR task-context ports reject accessors without invoking them", () => {
  let getterCalls = 0;
  const pullRequestFacts = {};
  Object.defineProperty(pullRequestFacts, "context", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => null;
    },
  });

  assert.throws(
    () => source(snapshot(), { pullRequestFacts }),
    /pullRequestFacts is invalid/u,
  );
  assert.equal(getterCalls, 0);
});
