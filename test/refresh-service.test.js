import assert from "node:assert/strict";
import test from "node:test";
import { RefreshService } from "../src/services/refresh-service.js";

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? this.values.get(name) : fallback;
  }

  async write(name, value) {
    this.values.set(name, value);
  }
}

function pullRequest(overrides = {}) {
  return {
    id: "github:pr:acme/repo#1",
    kind: "pull_request",
    relation: "review_requested",
    author: "someone-else",
    currentUser: "SV-li-zhenhui",
    state: "open",
    updatedAt: "2026-07-31T08:00:00.000Z",
    reviewFactsAvailable: true,
    headRefOid: "head-1",
    myReviewState: "",
    ciStatus: "NONE",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

test("refresh classifies complete PR facts and asks the brain only about uncertain items", async () => {
  const store = new MemoryStore();
  const brainCalls = [];
  const github = {
    async searchRelevantPullRequests() {
      return [
        pullRequest(),
        pullRequest({
          id: "github:pr:acme/repo#2",
          number: 2,
          reviewFactsAvailable: false,
        }),
      ];
    },
    async searchIssues() {
      return [];
    },
    async versions() {
      return [];
    },
  };
  const brain = {
    async assessPullRequest(item) {
      brainCalls.push(item.id);
      return {
        classification: "action_now",
        nextActor: "me",
        confidence: 0.72,
        evidence: ["Assignee 是当前用户"],
        recommendedAction: "确认是否需要首次审核",
        requiresConfirmation: true,
      };
    },
  };
  const service = new RefreshService({
    github,
    brain,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: true, maxAssessmentsPerRefresh: 3 },
    },
  });

  await service.refresh();
  const firstSnapshot = await store.read("snapshot");
  await service.refresh();

  const snapshot = await store.read("snapshot");
  const first = snapshot.items.find((item) => item.id.endsWith("#1"));
  const uncertain = snapshot.items.find((item) => item.id.endsWith("#2"));
  assert.equal(first.actionState, "action_now");
  assert.equal(first.nextAction, "review");
  assert.equal(uncertain.actionState, "uncertain");
  assert.equal(uncertain.brainAssessment.classification, "action_now");
  assert.deepEqual(brainCalls, ["github:pr:acme/repo#2"]);
  assert.equal(firstSnapshot.brain.assessed, 1);
  assert.equal(snapshot.brain.assessed, 0);
  assert.deepEqual(snapshot.sourceStatus.githubPullRequests, {
    ok: true,
    stale: false,
  });
});

test("an uncertain PR is reassessed when material facts change on the same head", async () => {
  const store = new MemoryStore();
  let refreshCount = 0;
  const brainCalls = [];
  const github = {
    async searchRelevantPullRequests() {
      refreshCount += 1;
      return [
        pullRequest({
          reviewFactsAvailable: false,
          ciStatus: refreshCount === 1 ? "NONE" : "UNKNOWN",
        }),
      ];
    },
    async searchIssues() { return []; },
    async versions() { return []; },
  };
  const service = new RefreshService({
    github,
    brain: {
      async assessPullRequest(item) {
        brainCalls.push(item.ciStatus);
        return {
          classification: "uncertain",
          nextActor: "unknown",
          confidence: 0.5,
          evidence: [item.ciStatus],
          recommendedAction: "请确认",
          requiresConfirmation: true,
        };
      },
    },
    dingtalk: {},
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: {
        enabled: true,
        provider: "ollama",
        model: "qwen3.5:9b",
        maxAssessmentsPerRefresh: 3,
      },
    },
  });

  await service.refresh();
  await service.refresh();

  assert.deepEqual(brainCalls, ["NONE", "UNKNOWN"]);
});

test("a failed source retains its last known data instead of reporting completion", async () => {
  const previousPullRequest = pullRequest({
    actionState: "action_now",
    nextAction: "review",
  });
  const previousIssue = {
    id: "github:issue:acme/repo#2",
    kind: "issue",
    relation: "assigned",
    title: "Keep me",
    updatedAt: "2026-07-31T08:00:00.000Z",
  };
  const previousMention = {
    id: "dingtalk:mention:3",
    kind: "mention",
    title: "Keep this signal",
    updatedAt: "2026-07-31T08:00:00.000Z",
  };
  const previousVersion = {
    id: "github:release:acme/repo:1",
    type: "release",
    title: "v1",
  };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: "2026-07-31T08:30:00.000Z",
      items: [previousPullRequest, previousIssue, previousMention],
      versions: [previousVersion],
    },
  });
  const github = {
    async searchRelevantPullRequests() {
      throw new Error("PR source unavailable");
    },
    async searchIssues() {
      throw new Error("Issue source unavailable");
    },
    async versions() {
      throw new Error("Version source unavailable");
    },
  };
  const service = new RefreshService({
    github,
    brain: null,
    dingtalk: {
      async collect() {
        throw new Error("DingTalk unavailable");
      },
    },
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
  });

  await service.refresh();

  const snapshot = await store.read("snapshot");
  assert.deepEqual(
    snapshot.items.map((item) => item.id).sort(),
    [previousPullRequest.id, previousIssue.id, previousMention.id].sort(),
  );
  assert.deepEqual(snapshot.versions, [previousVersion]);
  assert.equal(snapshot.errors.length, 4);
  assert.deepEqual(snapshot.sourceStatus.githubPullRequests, {
    ok: false,
    stale: true,
  });
});
