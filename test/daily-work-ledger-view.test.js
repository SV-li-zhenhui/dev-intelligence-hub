import assert from "node:assert/strict";
import test from "node:test";
import { createDailyWorkLedgerView } from "../src/services/daily-work-ledger-view.js";

const NOW = "2026-08-31T08:00:00.000Z";

function githubEvent({
  number,
  updatedAt,
  kind = "pull_request",
  actionState = "action_now",
  eventType = "pull_request.updated",
  provider = "github",
  scopeId = "github-dashboard",
  title = `PR ${number}`,
} = {}) {
  return {
    eventId: `event-${number}-${eventType}`,
    eventType,
    occurredAt: NOW,
    source: { provider, scopeId },
    subject: {
      id: `github:${kind === "issue" ? "issue" : "pr"}:acme/repo#${number}`,
      repository: "acme/repo",
      number,
    },
    payload: { actionState, title, updatedAt },
  };
}

function assignment({
  id,
  number,
  status = "queued",
  roleId = "pr-engineer",
  updatedAt = NOW,
  sourceUpdatedAt = "2026-08-30T08:00:00.000Z",
  actionState,
  eventType,
  provider,
  scopeId,
  subjectKind = "pull_request",
  statusReason = null,
} = {}) {
  return {
    itemId: id,
    kind: "assignment",
    status,
    statusReason,
    updatedAt,
    currentTarget: { type: "role", id: roleId },
    event: githubEvent({
      number,
      kind: subjectKind,
      updatedAt: sourceUpdatedAt,
      ...(actionState === undefined ? {} : { actionState }),
      ...(eventType === undefined ? {} : { eventType }),
      ...(provider === undefined ? {} : { provider }),
      ...(scopeId === undefined ? {} : { scopeId }),
    }),
  };
}

function sourceRoot({ id, number, status = "working", roleId = "pr-engineer" }) {
  const event = githubEvent({
    number,
    updatedAt: "2026-08-30T09:00:00.000Z",
    title: `Authoritative PR ${number}`,
  });
  return {
    itemId: id,
    kind: "source_root",
    status,
    statusReason: null,
    updatedAt: "2026-08-31T07:00:00.000Z",
    currentTarget: { type: "role", id: roleId },
    event,
    source: {
      kind: "pull_request",
      inputRevision: 2,
      activeRevision: 2,
      scope: { kind: "automatic", active: true },
      current: { event },
    },
  };
}

function ledgerFixture(items, { unstable = false } = {}) {
  let summaryReads = 0;
  const itemCounts = {};
  for (const item of items) itemCounts[item.status] = (itemCounts[item.status] || 0) + 1;
  return {
    async getSummary() {
      summaryReads += 1;
      return {
        revision: unstable ? summaryReads : 7,
        itemCounts,
        intakeCursor: 12,
      };
    },
    async listItems({ cursor, limit = 100, order = "oldest" } = {}) {
      assert.equal(order, "oldest");
      const start = cursor
        ? items.findIndex((item) => item.itemId === cursor) + 1
        : 0;
      const page = items.slice(start, start + limit);
      return {
        items: structuredClone(page),
        nextCursor: start + page.length < items.length
          ? page.at(-1).itemId
          : null,
      };
    },
    async listTimeline(options) {
      return { options, items: [], nextCursor: null };
    },
  };
}

function fixtureItems() {
  return [
    assignment({
      id: "legacy-historical",
      number: 10,
      sourceUpdatedAt: "2025-01-01T00:00:00.000Z",
      actionState: "historical",
    }),
    assignment({
      id: "inactive-root",
      number: 11,
      status: "blocked",
      statusReason: "pr_source_left_scope",
    }),
    assignment({
      id: "terminal-pr-root",
      number: 16,
      status: "blocked",
      statusReason: "pr_source_terminal",
    }),
    assignment({
      id: "shadow-assignment",
      number: 12,
      updatedAt: "2026-08-30T06:00:00.000Z",
    }),
    sourceRoot({ id: "active-root", number: 12 }),
    assignment({
      id: "manual-old",
      number: 13,
      roleId: "developer",
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
      provider: "local-owner",
      scopeId: "owner-request:00000000-0000-4000-8000-000000000013",
      eventType: "pull_request.owner_requested",
    }),
    assignment({
      id: "recent-completed",
      number: 14,
      status: "completed",
      roleId: "tester",
    }),
    assignment({
      id: "recent-blocker",
      number: 15,
      status: "blocked",
      roleId: "tester",
      statusReason: "test_environment_unavailable",
    }),
  ];
}

test("daily view removes historical control records, deduplicates subjects, and keeps manual old work", async () => {
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture(fixtureItems()),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  const page = await view.listCurrentItems({ limit: 20, order: "newest" });

  assert.deepEqual(
    page.items.map(({ itemId }) => itemId),
    ["recent-completed", "recent-blocker", "manual-old", "active-root"],
  );
  assert.equal(page.nextCursor, null);
});

test("Issue age window does not hide an actionable old PR", async () => {
  const oldPullRequest = assignment({
    id: "old-actionable-pr",
    number: 20,
    sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
  });
  const oldIssue = assignment({
    id: "old-issue",
    number: 21,
    sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
    eventType: "issue.updated",
  });
  oldIssue.event = githubEvent({
    number: 21,
    kind: "issue",
    eventType: "issue.updated",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture([oldPullRequest, oldIssue]),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  assert.deepEqual(
    (await view.listCurrentItems()).items.map(({ itemId }) => itemId),
    ["old-actionable-pr"],
  );
});

test("daily view deduplicates a manual Issue against its automatic Issue", async () => {
  const automatic = assignment({
    id: "automatic-issue",
    number: 30,
    eventType: "issue.updated",
  });
  const manual = assignment({
    id: "manual-issue",
    number: 30,
    eventType: "issue.owner_requested",
    provider: "local-owner",
    scopeId: "owner-request:00000000-0000-4000-8000-000000000030",
  });
  automatic.event = githubEvent({
    number: 30,
    kind: "issue",
    eventType: "issue.updated",
    updatedAt: "2026-08-30T08:00:00.000Z",
  });
  manual.event = githubEvent({
    number: 30,
    kind: "issue",
    eventType: "issue.owner_requested",
    provider: "local-owner",
    scopeId: "owner-request:00000000-0000-4000-8000-000000000030",
    updatedAt: "2026-08-30T08:00:00.000Z",
  });
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture([automatic, manual]),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  const items = (await view.listCurrentItems()).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].itemId, "manual-issue");
  const workloads = await view.getCurrentRoleWorkloads();
  assert.deepEqual(workloads.items[0].tasks[0].subject, {
    kind: "issue",
    repository: "acme/repo",
    number: 30,
  });
});

test("daily summary separates current work from immutable audit history", async () => {
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture(fixtureItems()),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  const summary = await view.getCurrentSummary();

  assert.deepEqual(summary.itemCounts, {
    queued: 1,
    blocked: 1,
    working: 1,
    completed: 1,
  });
  assert.deepEqual(summary.dailyScope, {
    activeWindowDays: 14,
    currentItems: 4,
    historyItems: 4,
    durableItems: 8,
  });
  assert.deepEqual(summary.durableItemCounts, {
    queued: 3,
    blocked: 3,
    working: 1,
    completed: 1,
  });
  assert.equal(summary.intakeCursor, 12);
});

test("daily role workloads count only actionable current tasks", async () => {
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture(fixtureItems()),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  const workloads = await view.getCurrentRoleWorkloads();

  assert.deepEqual(
    workloads.items.map(({ roleId, counts }) => [roleId, counts]),
    [
      ["developer", { queued: 1, working: 0, waiting: 0, blocked: 0 }],
      ["pr-engineer", { queued: 0, working: 1, waiting: 0, blocked: 0 }],
      ["tester", { queued: 0, working: 0, waiting: 0, blocked: 1 }],
    ],
  );
  assert.equal(workloads.items[1].tasks[0].title, "Authoritative PR 12");
  assert.deepEqual(workloads.items[1].tasks[0].subject, {
    kind: "pull_request",
    repository: "acme/repo",
    number: 12,
  });
});

test("daily item listing supports status, role and stable cursor filters", async () => {
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture(fixtureItems()),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  const first = await view.listCurrentItems({
    limit: 1,
    order: "newest",
    roleId: "tester",
  });
  const second = await view.listCurrentItems({
    limit: 1,
    order: "newest",
    roleId: "tester",
    cursor: first.nextCursor,
  });
  const blocked = await view.listCurrentItems({ status: "blocked" });

  assert.equal(first.items[0].itemId, "recent-completed");
  assert.equal(first.nextCursor, "recent-completed");
  assert.equal(second.items[0].itemId, "recent-blocker");
  assert.equal(second.nextCursor, null);
  assert.deepEqual(blocked.items.map(({ itemId }) => itemId), ["recent-blocker"]);
});

test("daily item listing preserves durable query validation and limit semantics", async () => {
  const items = Array.from({ length: 101 }, (_, index) => assignment({
    id: `query-item-${String(index).padStart(3, "0")}`,
    number: 100 + index,
  }));
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture(items),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  const capped = await view.listCurrentItems({ limit: 101 });
  assert.equal(capped.items.length, 100);
  assert.notEqual(capped.nextCursor, null);
  for (const query of [
    { status: "not-a-status" },
    { roleId: "Not A Role" },
    { cursor: "daily-item-not-visible" },
  ]) {
    await assert.rejects(
      view.listCurrentItems(query),
      (error) => error?.statusCode === 400 &&
        ["WORK_LEDGER_QUERY_INVALID", "WORK_LEDGER_CURSOR_INVALID"]
          .includes(error?.code),
    );
  }
});

test("daily projection fails closed when the ledger changes throughout the read", async () => {
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture(fixtureItems(), { unstable: true }),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
    snapshotAttempts: 2,
  });

  await assert.rejects(
    view.getCurrentSummary(),
    (error) => error?.code === "DAILY_WORK_LEDGER_SNAPSHOT_UNSTABLE",
  );
});

test("daily projection ages cached ledger items out as the clock advances", async () => {
  let now = "2026-08-31T08:00:00.000Z";
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture([
      assignment({
        id: "aging-item",
        number: 16,
        sourceUpdatedAt: "2026-08-30T09:00:00.000Z",
        eventType: "issue.updated",
        subjectKind: "issue",
      }),
    ]),
    activeWindowDays: 1,
    clock: () => new Date(now),
  });

  assert.equal((await view.listCurrentItems()).items.length, 1);
  now = "2026-08-31T10:00:00.000Z";
  assert.equal((await view.listCurrentItems()).items.length, 0);
});

test("concurrent daily reads share one ledger page traversal", async () => {
  let listReads = 0;
  const ledger = ledgerFixture(fixtureItems());
  const originalListItems = ledger.listItems;
  ledger.listItems = async (options) => {
    listReads += 1;
    await Promise.resolve();
    return originalListItems(options);
  };
  const view = createDailyWorkLedgerView({
    ledger,
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  await Promise.all([
    view.getCurrentSummary(),
    view.listCurrentItems(),
    view.getCurrentRoleWorkloads(),
  ]);

  assert.equal(listReads, 1);
});

test("daily projection traverses the valid combined assignment and source-root capacity", async () => {
  const items = [
    ...Array.from({ length: 5_000 }, (_, index) => assignment({
      id: `capacity-assignment-${index}`,
      number: index + 1,
    })),
    sourceRoot({ id: "capacity-source-root", number: 5_001 }),
  ];
  const view = createDailyWorkLedgerView({
    ledger: ledgerFixture(items),
    activeWindowDays: 14,
    clock: () => new Date(NOW),
  });

  const summary = await view.getCurrentSummary();
  assert.equal(summary.dailyScope.durableItems, 5_001);
  assert.equal(summary.dailyScope.currentItems, 5_001);
});
