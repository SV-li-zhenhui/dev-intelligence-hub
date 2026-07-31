import assert from "node:assert/strict";
import test from "node:test";
import { ProactivePrEmployeeService } from "../src/services/proactive-pr-employee.js";

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? structuredClone(this.values.get(name)) : fallback;
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function pullRequest(overrides = {}) {
  return {
    id: "github:pr:acme/repo#42",
    kind: "pull_request",
    relation: "review_requested",
    repo: "acme/repo",
    number: 42,
    title: "Protect the checkout flow",
    url: "https://github.example/acme/repo/pull/42",
    author: "someone-else",
    state: "open",
    updatedAt: "2026-07-31T09:00:00.000Z",
    reviewFactsAvailable: true,
    headRefOid: "head-42",
    actionState: "action_now",
    nextAction: "review",
    actionReasons: ["等待你首次审核"],
    ...overrides,
  };
}

function snapshot(items, overrides = {}) {
  return {
    refreshedAt: "2026-07-31T10:00:00.000Z",
    sourceStatus: { githubPullRequests: { ok: true } },
    items,
    ...overrides,
  };
}

function reviewResult(overrides = {}) {
  return {
    workType: "review_draft",
    summary: "支付失败路径缺少回归覆盖，建议先补测试。",
    confidence: 0.86,
    evidence: ["checkout.js 修改了错误分支"],
    steps: ["补充失败路径测试", "核对错误码映射"],
    questions: [],
    reviewVerdict: "request_changes",
    reviewBody: "建议补充失败路径测试后再合并。",
    requiresApproval: true,
    ...overrides,
  };
}

function createService({ store, github, reviewer, now, config = {} } = {}) {
  return new ProactivePrEmployeeService({
    store,
    github,
    reviewer,
    clock: () => new Date(now || "2026-07-31T10:01:00.000Z"),
    config: {
      enabled: true,
      name: "PR 推进员工",
      policyVersion: 1,
      maxJobsPerTick: 2,
      maxAttempts: 3,
      retryMinutes: [1, 5, 30],
      memoryLimit: 100,
      ...config,
    },
  });
}

test("a new review head is analyzed proactively once and queued for human review", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const loaded = [];
  const reviewed = [];
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        loaded.push(item.headRefOid);
        return {
          ...item,
          patch: "diff --git a/checkout.js b/checkout.js",
          patchTruncated: false,
          files: [{ path: "checkout.js", additions: 8, deletions: 2 }],
        };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "qwen3.5:9b",
      async analyze(context) {
        reviewed.push(context.headRefOid);
        return reviewResult();
      },
    },
  });

  const first = await service.tick({ trigger: "refresh_completed" });
  const second = await service.tick({ trigger: "scheduled" });

  assert.deepEqual(loaded, ["head-42"]);
  assert.deepEqual(reviewed, ["head-42"]);
  assert.equal(first.jobs[0].status, "ready_for_human");
  assert.equal(first.confirmationQueue.length, 1);
  assert.equal(first.confirmationQueue[0].reviewBody, reviewResult().reviewBody);
  assert.equal(second.jobs.length, 1);
  assert.equal(second.role.lastRun.newJobs, 0);
  assert.equal(second.role.state, "waiting_user");
});

test("job identity and approval policy cannot be overridden by a reviewer", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        return reviewResult({
          id: "forged-id",
          subjectId: "forged-subject",
          status: "accepted",
          workType: "owner_plan",
          requiresApproval: false,
        });
      },
    },
  });

  const result = await service.tick();

  assert.match(result.jobs[0].id, /^pr-work-/);
  assert.equal(result.jobs[0].subjectId, pullRequest().id);
  assert.equal(result.jobs[0].workType, "review_draft");
  assert.equal(result.jobs[0].requiresApproval, true);
  assert.equal(result.jobs[0].status, "ready_for_human");
});

test("a policy upgrade supersedes the old draft before creating a replacement", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const github = {
    async loadReviewContext(item) {
      return { ...item, patch: "diff", patchTruncated: false, files: [] };
    },
  };
  const reviewer = { async analyze() { return reviewResult(); } };

  await createService({ store, github, reviewer }).tick();
  const upgraded = await createService({
    store,
    github,
    reviewer,
    config: { policyVersion: 2 },
  }).tick();

  assert.equal(upgraded.jobs.length, 2);
  assert.equal(
    upgraded.jobs.filter((job) => job.status === "superseded").length,
    1,
  );
  assert.equal(upgraded.confirmationQueue.length, 1);
  assert.equal(upgraded.confirmationQueue[0].policyVersion, 2);
});

test("an authored PR produces an internal work plan without entering approval", async () => {
  const owned = pullRequest({
    relation: "authored",
    author: "SV-li-zhenhui",
    nextAction: "fix_ci",
    actionReasons: ["需要你处理检查失败"],
  });
  const store = new MemoryStore({ snapshot: snapshot([owned]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "failure handling diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "qwen3.5:9b",
      async analyze() {
        return reviewResult({
          workType: "owner_plan",
          reviewVerdict: "none",
          reviewBody: "",
          requiresApproval: false,
        });
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "ready");
  assert.equal(result.confirmationQueue.length, 0);
  assert.equal(result.role.lastRun.newJobs, 1);
});

test("pausing is persistent and prevents new analysis until resumed", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  let calls = 0;
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        calls += 1;
        return reviewResult();
      },
    },
  });

  const initial = await service.view();
  const paused = await service.control("pause", initial.role.revision);
  await service.tick();
  const resumed = await service.control("resume", paused.role.revision);
  await service.tick({ trigger: "resume" });

  assert.equal(paused.role.state, "paused");
  assert.equal(resumed.role.state, "observing");
  assert.equal(calls, 1);
});

test("a head change during model work supersedes the stale result", async () => {
  const original = pullRequest();
  const store = new MemoryStore({ snapshot: snapshot([original]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        await store.write("snapshot", snapshot([
          pullRequest({ headRefOid: "head-43" }),
        ]));
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "superseded");
  assert.equal(result.confirmationQueue.length, 0);
});

test("fallback GitHub data never starts a proactive job", async () => {
  const store = new MemoryStore({
    snapshot: snapshot([pullRequest()], {
      sourceStatus: { githubPullRequests: { ok: false, stale: true } },
    }),
  });
  let calls = 0;
  const service = createService({
    store,
    github: {},
    reviewer: {
      async analyze() {
        calls += 1;
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(calls, 0);
  assert.equal(result.jobs.length, 0);
  assert.match(result.role.lastRun.summary, /GitHub.*未刷新/);
});

test("review decisions are local, revision guarded, and searchable in memory", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
  });
  const ready = await service.tick();
  const job = ready.jobs[0];

  await assert.rejects(
    service.decide(job.id, "accept", {
      headRefOid: job.headRefOid,
      expectedRevision: ready.role.revision - 1,
    }),
    (error) => error.statusCode === 409,
  );

  const accepted = await service.decide(job.id, "accept", {
    headRefOid: job.headRefOid,
    expectedRevision: ready.role.revision,
  });
  const memories = await service.searchMemory("失败路径");

  assert.equal(accepted.jobs[0].status, "accepted");
  assert.equal(accepted.confirmationQueue.length, 0);
  assert.ok(memories.some((memory) => memory.sourceId === job.subjectId));
});

test("memory persistence failures do not roll completed work back into retry", async () => {
  class FailingMemoryStore extends MemoryStore {
    async write(name, value) {
      if (name === "pr-employee-memory") {
        throw new Error("memory disk unavailable");
      }
      await super.write(name, value);
    }
  }

  const store = new FailingMemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
  });

  const ready = await service.tick();
  const job = ready.jobs[0];
  const accepted = await service.decide(job.id, "accept", {
    headRefOid: job.headRefOid,
    expectedRevision: ready.role.revision,
  });
  const memories = await service.searchMemory("失败路径");

  assert.equal(job.status, "ready_for_human");
  assert.equal(job.attempts, 1);
  assert.equal(accepted.jobs[0].status, "accepted");
  assert.equal(accepted.role.state, "degraded");
  assert.match(accepted.role.lastError, /记忆队列写入失败/);
  assert.ok(memories.some((memory) => memory.sourceId === job.subjectId));
});

test("a prolonged memory outage keeps the outbox bounded", async () => {
  class FailingMemoryStore extends MemoryStore {
    async write(name, value) {
      if (name === "pr-employee-memory") throw new Error("disk unavailable");
      await super.write(name, value);
    }
  }
  const requests = [1, 2, 3].map((number) =>
    pullRequest({
      id: `github:pr:acme/repo#${number}`,
      number,
      headRefOid: `head-${number}`,
    }),
  );
  const store = new FailingMemoryStore({ snapshot: snapshot(requests) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
    config: { maxJobsPerTick: 3, memoryOutboxLimit: 2 },
  });

  const result = await service.tick();
  const state = await store.read("pr-employee-state");

  assert.equal(result.jobs.length, 3);
  assert.equal(state.memoryOutbox.length, 2);
  assert.equal(state.memoryOutboxDropped, 1);
});
