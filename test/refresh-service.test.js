import assert from "node:assert/strict";
import test from "node:test";
import { RefreshService } from "../src/services/refresh-service.js";
import { WorkflowFactSource } from "../src/services/workflow-fact-source.js";

const REFRESH_STARTED_AT = "2026-08-13T01:02:03.004Z";

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
    currentUser: "local-owner",
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

test("an explicitly disabled GitHub read boundary makes no adapter call", async () => {
  let githubCalls = 0;
  const unavailable = async () => {
    githubCalls += 1;
    throw new Error("GitHub must remain unreachable");
  };
  const store = new MemoryStore();
  const service = new RefreshService({
    github: {
      searchRelevantPullRequests: unavailable,
      searchIssues: unavailable,
      versions: unavailable,
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      githubRead: { enabled: false },
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
  });

  await service.refresh();

  assert.equal(githubCalls, 0);
  const snapshot = await store.read("snapshot");
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.sources, { github: 0, dingtalk: 0 });
  assert.equal(snapshot.sourceStatus.githubPullRequests.ok, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.stale, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.enabled, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, false);
  assert.equal(
    snapshot.sourceStatus.githubPullRequests.effectiveUpdatedWindow.mode,
    "unlimited",
  );
});

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
  assert.equal(snapshot.sourceStatus.githubPullRequests.ok, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.stale, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.enabled, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, true);
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
  assert.equal(snapshot.sourceStatus.githubPullRequests.ok, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.stale, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.enabled, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, false);
});

test("refresh freezes one effective PR window and publishes its completeness", async () => {
  const store = new MemoryStore();
  let receivedOptions;
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests(options) {
        receivedOptions = options;
        return [];
      },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      githubRead: {
        enabled: true,
        pullRequestUpdatedWindow: { mode: "rolling", days: 7 },
      },
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date(REFRESH_STARTED_AT),
  });

  await service.refresh();

  const effectiveUpdatedWindow = receivedOptions.effectiveUpdatedWindow;
  assert.equal(Object.isFrozen(effectiveUpdatedWindow), true);
  assert.deepEqual(effectiveUpdatedWindow, {
    mode: "rolling",
    days: 7,
    refreshStartedAt: REFRESH_STARTED_AT,
    fromInclusive: "2026-08-06T01:02:03.004Z",
  });
  const snapshot = await store.read("snapshot");
  assert.strictEqual(
    snapshot.sourceStatus.githubPullRequests.effectiveUpdatedWindow,
    effectiveUpdatedWindow,
  );
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, true);
});

test("failed finite PR discovery remains incomplete without changing its effective window", async () => {
  const store = new MemoryStore();
  let receivedWindow;
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests({ effectiveUpdatedWindow }) {
        receivedWindow = effectiveUpdatedWindow;
        throw new Error("segmented search failed closed");
      },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      githubRead: {
        enabled: true,
        pullRequestUpdatedWindow: { mode: "rolling", days: 7 },
      },
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date(REFRESH_STARTED_AT),
  });

  await service.refresh();

  const status = (await store.read("snapshot")).sourceStatus.githubPullRequests;
  assert.equal(status.ok, false);
  assert.equal(status.stale, true);
  assert.equal(status.complete, false);
  assert.strictEqual(status.effectiveUpdatedWindow, receivedWindow);
});

test("a slow refresh cannot renew the freshness age of earlier PR facts", async () => {
  const startedAt = Date.parse("2026-08-02T03:00:00.000Z");
  let now = startedAt;
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: "b".repeat(40),
  };
  const store = new MemoryStore();
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() {
        now = Date.parse("2026-08-02T03:20:00.000Z");
        return [
          pullRequest({
            id: "github:pr:acme/repo#42",
            repo: "acme/repo",
            number: 42,
            currentUser: "runtime-user",
            githubAccount: "runtime-user",
            baseRepository: gitTarget.baseRepository,
            baseRefName: gitTarget.baseRefName,
            baseRefOid: gitTarget.baseRefOid,
            headRepository: gitTarget.headRepository,
            headRefName: gitTarget.headRefName,
            headRefOid: gitTarget.headRefOid,
            gitTargetAvailable: true,
            gitTarget,
            ciStatus: "SUCCESS",
          }),
        ];
      },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date(now),
  });

  await service.refresh();
  const snapshot = await store.read("snapshot");
  assert.equal(snapshot.refreshedAt, "2026-08-02T03:00:00.000Z");
  assert.equal(snapshot.durationMs, 20 * 60 * 1_000);

  const facts = new WorkflowFactSource({
    store,
    clock: () => new Date("2026-08-02T03:34:00.000Z"),
  });
  const observed = await facts.read({
    item: {
      event: {
        eventType: "pull_request.updated",
        subject: {
          id: "github:pr:acme/repo#42",
          repository: "acme/repo",
          number: 42,
        },
        payload: {
          headRefOid: gitTarget.headRefOid,
          gitTargetAvailable: true,
          gitTarget,
        },
      },
    },
    fact: "ci-status",
  });
  assert.equal(observed.healthy, true);
  assert.equal(observed.fresh, false);
  assert.equal(observed.value, null);
});

test("refresh publishes grouped DingTalk summaries instead of raw messages or unread conversations", async () => {
  const store = new MemoryStore();
  const summaryCalls = [];
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: {
      async summarizeDingTalk(groups) {
        summaryCalls.push(groups);
        return groups.map((group) => ({
          groupId: group.groupId,
          important: true,
          summary: "研发群完成版本发布，等待确认风险",
          highlights: ["版本已经发布", "风险尚待确认"],
          actionRequired: "确认发布风险",
        }));
      },
    },
    dingtalk: {
      async collect() {
        return {
          errors: [],
          items: [
            {
              id: "dingtalk:message:1",
              kind: "message",
              title: "版本已经发布",
              author: "张三",
              context: "研发群",
              conversationId: "group-1",
              updatedAt: "2026-08-26T08:00:00.000Z",
            },
            {
              id: "dingtalk:message:2",
              kind: "message",
              title: "[图片消息](mediaId=@secret) 请确认风险",
              author: "李四",
              context: "研发群",
              conversationId: "group-1",
              updatedAt: "2026-08-26T09:00:00.000Z",
            },
            {
              id: "dingtalk:conversation:old",
              kind: "conversation",
              title: "陈年未读会话",
              updatedAt: "2023-01-01T00:00:00.000Z",
            },
          ],
        };
      },
    },
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: true, provider: "ollama", model: "qwen3.5:9b" },
    },
  });

  await service.refresh();

  const snapshot = await store.read("snapshot");
  assert.equal(summaryCalls.length, 1);
  assert.equal(summaryCalls[0].length, 1);
  assert.ok(!JSON.stringify(summaryCalls).includes("mediaId"));
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].title, "研发群完成版本发布，等待确认风险");
  assert.equal(snapshot.items[0].summaryStatus, "ai");
  assert.equal(snapshot.items[0].sourceMessages.length, 2);
  assert.equal(snapshot.brain.dingtalkSummarized, 1);
  assert.equal(snapshot.sources.dingtalk, 1);
});

test("a scheduled DingTalk report is durably claimed and sent once per slot", async () => {
  const store = new MemoryStore();
  const reports = [];
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {
      async collect() {
        return {
          errors: [],
          items: [{
            id: "dingtalk:todo:daily-report",
            kind: "todo",
            relation: "assigned",
            title: "提交日报",
            updatedAt: "2026-09-23T00:30:00.000Z",
            state: "open",
          }],
        };
      },
    },
    store,
    notifier: {
      async sendReport(report) { reports.push(report); },
    },
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date("2026-09-23T01:05:00.000Z"),
  });

  await service.refresh();
  await service.refresh();

  assert.equal(reports.length, 1);
  assert.equal(reports[0].slotKey, "2026-09-23@09:00");
  const state = await store.read("dingtalk-report-state");
  assert.equal(state.lastSlotKey, "2026-09-23@09:00");
  assert.equal(state.latest.status, "sent");
  const dashboard = await store.read("dashboard");
  assert.equal(dashboard.dingtalkReport.status, "sent");
  assert.equal(dashboard.dingtalkReport.counts.todos, 1);
});

test("an uncertain DingTalk report failure is not retried in the same slot", async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {
      async collect() { return { errors: [], items: [] }; },
    },
    store,
    notifier: {
      async sendReport() {
        attempts += 1;
        throw new Error("transport outcome unknown");
      },
    },
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date("2026-09-23T04:05:00.000Z"),
  });

  await service.refresh();
  await service.refresh();

  assert.equal(attempts, 1);
  const state = await store.read("dingtalk-report-state");
  assert.equal(state.lastSlotKey, "2026-09-23@12:00");
  assert.equal(state.latest.status, "failed");
  assert.match(
    (await store.read("dashboard")).dingtalkReport.error,
    /不会自动重发/,
  );
});
