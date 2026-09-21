import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createWorkView,
  escapeWorkHtml,
  renderCodeJobDetail,
  renderWorkView,
} from "../public/work-view.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function response(value, ok = true, status = 200) {
  return { ok, status, async json() { return structuredClone(value); } };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const OWNER_RETRY_DIGEST = "a".repeat(64);

function eligibleOwnerRetryItem(overrides = {}) {
  return Object.assign({
    itemId: "work-item-owner-retry",
    assignmentId: "owner-retry-row",
    kind: "source_root",
    inputDigest: OWNER_RETRY_DIGEST,
    status: "blocked",
    statusReason: "decision_attempts_exhausted",
    revision: 7,
    ownerId: null,
    leaseId: null,
    leaseUntil: null,
    activeIntentId: null,
    decisionContext: null,
    sourceQuarantine: null,
    attempt: 3,
    source: {
      kind: "pull_request",
      inputRevision: 4,
      activeRevision: 4,
      pendingRevision: null,
      pending: null,
      current: {
        eventId: "event-4",
        inputDigest: OWNER_RETRY_DIGEST,
        event: { eventId: "event-4" },
      },
      bindings: [{ eventId: "event-4", inputRevision: 4 }],
    },
  }, overrides);
}

function workProjectionState(items, overrides = {}) {
  return {
    loaded: true,
    loading: false,
    error: "",
    summary: { itemCounts: {}, safeguards: {} },
    items,
    timeline: [],
    codeJobsEnabled: false,
    codeJobs: [],
    codeJobsError: "",
    graphLoading: false,
    graphSnapshot: null,
    graphError: "",
    ...overrides,
  };
}

function workProjectionResponse(url, items) {
  if (url === "/api/work/daily/summary") {
    return response({ itemCounts: {}, safeguards: {} });
  }
  if (url === "/api/work/daily/items?limit=50&order=newest") {
    return response({ items });
  }
  if (url === "/api/work/timeline?limit=50&order=newest") {
    return response({ items: [] });
  }
  if (url === "/api/code/jobs?limit=50&order=newest") {
    return response({ enabled: false, items: [] });
  }
  if (url === "/api/work/graph") {
    return response({
      schemaVersion: 1,
      graph: {
        schemaVersion: 1,
        graphId: "work-ledger",
        revision: 0,
        tasks: [],
      },
      taskStates: [],
    });
  }
  throw new Error(`unexpected request: ${url}`);
}

function applicationDetailState(application, {
  manifest = { packageId: `change-package-${"a".repeat(64)}` },
  packageStatus = "ready",
} = {}) {
  return {
    loading: false,
    error: "",
    detail: {
      job: {
        jobId: "code-job-application-ui",
        revision: 8,
        status: "completed",
        requestedBy: { roleId: "developer", workItemId: "work-1" },
      },
      archived: false,
      historyAvailable: true,
      observations: [],
      nextCursor: null,
      terminalDetail: null,
      changePackage: {
        status: packageStatus,
        receipt: packageStatus === "ready"
          ? {
              packageId: `change-package-${"a".repeat(64)}`,
              packageDigest: "a".repeat(64),
              deliveredAt: "2026-08-03T01:00:00.000Z",
            }
          : null,
        application,
      },
    },
    manifest,
    historyLoading: false,
    packageLoading: false,
    controlLoading: false,
    applyLoading: false,
    actionError: "",
  };
}

function codeJobControlDetailState(status, {
  archived = false,
  revision = 8,
  controlLoading = false,
  controlCommand = null,
} = {}) {
  return {
    loading: false,
    error: "",
    detail: {
      job: {
        jobId: "code-job-control-ui",
        revision,
        status,
        requestedBy: { roleId: "developer", workItemId: "work-control" },
      },
      archived,
      historyAvailable: true,
      observations: [],
      nextCursor: null,
      terminalDetail: null,
      changePackage: { status: "pending", receipt: null },
    },
    manifest: null,
    historyLoading: false,
    packageLoading: false,
    controlLoading,
    controlCommand,
    applyLoading: false,
    actionError: "",
  };
}

test("work view escapes records and clearly displays safety posture", () => {
  const html = renderWorkView({
    loaded: true,
    error: "",
    summary: {
      itemCounts: {
        queued: 2,
        paused: 5,
        working: 1,
        blocked: 3,
        completed: 4,
        cancelled: 1,
      },
      dailyScope: {
        activeWindowDays: 14,
        currentItems: 16,
        historyItems: 1907,
        durableItems: 1923,
      },
      safeguards: { prEmployeePaused: true, externalActionsEnabled: false },
    },
    items: [{
      assignmentId: "assignment-1",
      status: "paused",
      currentTarget: { type: "role", id: "requirements-analyst" },
      event: {
        eventType: "issue.updated",
        subject: { repository: "acme/repo", number: 42 },
      },
      attempt: 1,
      statusReason: "<script>alert(1)</script>",
      updatedAt: "2026-08-02T03:59:00.000Z",
    }],
    timeline: [{
      sequence: 7,
      type: "attention_answered",
      actorId: "owner",
      itemId: "work-1",
      at: "2026-08-02T03:59:30.000Z",
    }],
    codeJobsEnabled: true,
    codeJobsError: "",
    codeJobs: [{
      jobId: "code-job-1",
      requestedBy: { roleId: "developer", workItemId: "work-1" },
      repository: "acme/repo",
      workspaceId: "acme-workspace",
      operation: "modify",
      status: "completed",
      turn: 3,
      pendingActionType: null,
      latestObservation: {
        actionType: "complete",
        status: "succeeded",
        recordedAt: "2026-08-02T03:59:44.000Z",
      },
      terminalResult: {
        kind: "completed",
        recordedAt: "2026-08-02T03:59:45.000Z",
      },
      pause: null,
      uncertainty: null,
      updatedAt: "2026-08-02T03:59:45.000Z",
      result: {
        summary: "PRIVATE EXECUTOR RESULT",
      },
    }],
  }, { now: Date.parse("2026-08-02T04:00:00.000Z") });

  assert.match(html, /PR 新循环：暂停 \/ 旧员工独占/);
  assert.match(html, /GitHub 外部写：关闭/);
  assert.match(html, /最近 14 天自动任务/);
  assert.match(html, /1907 条历史审计记录/);
  assert.match(html, /<details[^>]*class="work-audit-graph"/);
  assert.match(html, /<h2>日常任务<\/h2>/);
  assert.match(html, /<span>暂停<\/span><strong>5<\/strong>/);
  assert.match(html, /<span>取消<\/span><strong>1<\/strong>/);
  assert.match(html, /status-paused[^>]*>已暂停/);
  assert.match(html, /requirements-analyst/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /本地代码任务/);
  assert.match(html, /最近动作 complete · 成功/);
  assert.match(html, /终态：已完成/);
  assert.doesNotMatch(html, /PRIVATE EXECUTOR RESULT/);
  assert.equal(escapeWorkHtml('"<&'), "&quot;&lt;&amp;");
});

test("PR engineer rows explain the current review stage and next owner", () => {
  const html = renderWorkView(workProjectionState([{
    assignmentId: "assignment-review",
    status: "waiting_external",
    statusReason: "intent_delivered",
    currentTarget: { type: "role", id: "pr-engineer" },
    event: {
      eventType: "pull_request.status",
      subject: { repository: "ExampleOrg/SoftwareApp", number: 24222 },
    },
    attempt: 1,
    updatedAt: "2026-08-27T02:10:02.000Z",
  }]));

  assert.match(html, /第 4\/5 步/);
  assert.match(html, /Review 建议已生成，等待你确认发布/);
  assert.match(html, /下一责任人：你/);
  assert.match(html, /台账原因：intent_delivered/);
});

test("owner retry renders only for the exact fail-closed public projection", () => {
  const eligibleHtml = renderWorkView(
    workProjectionState([eligibleOwnerRetryItem()]),
  );
  assert.equal(
    (eligibleHtml.match(/data-owner-decision-retry-item-id=/g) || []).length,
    1,
  );
  assert.match(
    eligibleHtml,
    /<button type="button" class="secondary-action" data-owner-decision-retry-item-id="work-item-owner-retry">重新排队一次<\/button>/,
  );
  assert.doesNotMatch(
    eligibleHtml,
    /data-(?:revision|digest|source|actor|reason|status)=/,
  );

  const source = () => eligibleOwnerRetryItem().source;
  const cases = [
    ["wrong status", { status: "queued" }],
    ["wrong reason", { statusReason: "decision_failed" }],
    ["wrong item kind", { kind: "assignment" }],
    ["wrong source kind", { source: { ...source(), kind: "issue" } }],
    ["missing source binding", { source: { ...source(), bindings: [] } }],
    ["wrong binding event", {
      source: { ...source(), bindings: [{ eventId: "event-3", inputRevision: 4 }] },
    }],
    ["wrong binding revision", {
      source: { ...source(), bindings: [{ eventId: "event-4", inputRevision: 3 }] },
    }],
    ["pending source revision", { source: { ...source(), pendingRevision: 5 } }],
    ["pending source", { source: { ...source(), pending: { eventId: "event-5" } } }],
    ["occupied owner", { ownerId: "employee-pr-engineer" }],
    ["occupied lease", { leaseId: "lease-1" }],
    ["occupied lease time", { leaseUntil: "2026-08-02T02:00:00.000Z" }],
    ["active intent", { activeIntentId: "intent-1" }],
    ["decision context", { decisionContext: { kind: "proposal" } }],
    ["source quarantine", { sourceQuarantine: { reason: "cutover" } }],
    ["zero revision", { revision: 0 }],
    ["fractional revision", { revision: 1.5 }],
    ["upper-case digest", { inputDigest: OWNER_RETRY_DIGEST.toUpperCase() }],
    ["short digest", { inputDigest: "a".repeat(63) }],
    ["negative attempt", { attempt: -1 }],
    ["fractional attempt", { attempt: 1.5 }],
    ["empty item ID", { itemId: "" }],
    ["oversized item ID", { itemId: "x".repeat(193) }],
    ["zero input revision", { source: { ...source(), inputRevision: 0 } }],
    ["inactive input revision", { source: { ...source(), activeRevision: 3 } }],
    ["empty current event ID", {
      source: { ...source(), current: { ...source().current, eventId: "" } },
    }],
    ["oversized current event ID", {
      source: { ...source(), current: { ...source().current, eventId: "x".repeat(193) } },
    }],
    ["contradictory embedded event", {
      source: {
        ...source(),
        current: { ...source().current, event: { eventId: "event-3" } },
      },
    }],
    ["contradictory current digest", {
      source: {
        ...source(),
        current: { ...source().current, inputDigest: "b".repeat(64) },
      },
    }],
    ["missing eligibility field", { sourceQuarantine: undefined }],
  ];

  for (const [label, overrides] of cases) {
    const item = eligibleOwnerRetryItem(overrides);
    if (label === "missing eligibility field") delete item.sourceQuarantine;
    assert.doesNotMatch(
      renderWorkView(workProjectionState([item])),
      /data-owner-decision-retry-item-id=/,
      label,
    );
  }
});

test("owner retry rejects accessor-backed and custom-prototype projection shapes", () => {
  assert.match(
    renderWorkView(workProjectionState([eligibleOwnerRetryItem()])),
    /data-owner-decision-retry-item-id=/,
  );
  let getterCalls = 0;
  const accessorItem = eligibleOwnerRetryItem();
  Object.defineProperty(accessorItem, "revision", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 7;
    },
  });
  const accessorSource = eligibleOwnerRetryItem();
  Object.defineProperty(accessorSource.source.current, "eventId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "event-4";
    },
  });
  const customItem = Object.assign(
    Object.create({ inherited: true }),
    eligibleOwnerRetryItem(),
  );
  const customSourceItem = eligibleOwnerRetryItem({
    source: Object.assign(Object.create(null), eligibleOwnerRetryItem().source),
  });
  const extraBindingArrayItem = eligibleOwnerRetryItem();
  extraBindingArrayItem.source.bindings.extra = true;

  for (const item of [
    accessorItem,
    accessorSource,
    customItem,
    customSourceItem,
    extraBindingArrayItem,
  ]) {
    assert.doesNotMatch(
      renderWorkView(workProjectionState([item])),
      /data-owner-decision-retry-item-id=/,
    );
  }
  assert.equal(getterCalls, 0);
});

test("owner retry rejects accessor-backed top-level work item collections", async () => {
  let getterCalls = 0;
  const items = [];
  Object.defineProperty(items, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return eligibleOwnerRetryItem();
    },
  });
  const pureHtml = renderWorkView(workProjectionState(items));
  const calls = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/api/work/daily/items?limit=50&order=newest") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { items };
          },
        };
      }
      if (options.method === "POST") return response({ requeued: true });
      return workProjectionResponse(url, []);
    },
  });
  await view.load();

  const controllerHtml = view.render();
  await view.retryDecisionExhaustion("work-item-owner-retry");

  assert.deepEqual({
    getterCalls,
    pureButtons: (
      pureHtml.match(/data-owner-decision-retry-item-id=/g) || []
    ).length,
    controllerButtons: (
      controllerHtml.match(/data-owner-decision-retry-item-id=/g) || []
    ).length,
    posts: calls.filter(({ options }) => options.method === "POST").length,
  }, {
    getterCalls: 0,
    pureButtons: 0,
    controllerButtons: 0,
    posts: 0,
  });
});

test("owner retry cannot be enabled by a self-replacing row accessor", async () => {
  const item = eligibleOwnerRetryItem();
  let getterCalls = 0;
  Object.defineProperty(item, "status", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      Object.defineProperty(item, "status", {
        configurable: true,
        enumerable: true,
        value: "blocked",
        writable: true,
      });
      return "blocked";
    },
  });
  const calls = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/api/work/daily/items?limit=50&order=newest") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { items: [item] };
          },
        };
      }
      if (options.method === "POST") return response({ requeued: true });
      return workProjectionResponse(url, []);
    },
  });
  await view.load();

  const html = view.render();
  await view.retryDecisionExhaustion("work-item-owner-retry");

  assert.equal(getterCalls, 0);
  assert.doesNotMatch(html, /data-owner-decision-retry-item-id=/);
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    0,
  );
});

test("owner retry cannot be enabled by a nested row presentation accessor", async () => {
  const item = eligibleOwnerRetryItem();
  let getterCalls = 0;
  const decisionContext = {};
  Object.defineProperty(decisionContext, "kind", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      item.decisionContext = null;
      return "proposal";
    },
  });
  item.decisionContext = decisionContext;
  const calls = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/api/work/daily/items?limit=50&order=newest") {
        return {
          ok: true,
          status: 200,
          async json() {
            return { items: [item] };
          },
        };
      }
      if (options.method === "POST") return response({ requeued: true });
      return workProjectionResponse(url, []);
    },
  });
  await view.load();

  const html = view.render();
  await view.retryDecisionExhaustion("work-item-owner-retry");

  assert.equal(getterCalls, 0);
  assert.doesNotMatch(html, /data-owner-decision-retry-item-id=/);
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    0,
  );
});

test("owner retry binds the button and submits only current in-memory authority", async () => {
  const itemId = "work/item ?#";
  let currentItems = [eligibleOwnerRetryItem({
    itemId,
    revision: 9,
    inputDigest: "b".repeat(64),
    source: {
      ...eligibleOwnerRetryItem().source,
      current: {
        ...eligibleOwnerRetryItem().source.current,
        inputDigest: "b".repeat(64),
      },
    },
  })];
  const calls = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") return response({ requeued: true });
      return workProjectionResponse(url, currentItems);
    },
  });
  await view.load();

  let click;
  const button = {
    dataset: { ownerDecisionRetryItemId: itemId },
    addEventListener(event, listener) {
      assert.equal(event, "click");
      click = listener;
    },
  };
  view.bind({
    querySelectorAll(selector) {
      return selector === "[data-owner-decision-retry-item-id]" ? [button] : [];
    },
  });
  assert.deepEqual(Object.keys(button.dataset), ["ownerDecisionRetryItemId"]);
  await click();

  const mutation = calls.find(({ options }) => options.method === "POST");
  assert.equal(
    mutation.url,
    "/api/work/items/work%2Fitem%20%3F%23/retry-decision-exhaustion",
  );
  assert.deepEqual(mutation.options.headers, {
    "content-type": "application/json",
    "x-mydashboard-action": "1",
  });
  assert.deepEqual(JSON.parse(mutation.options.body), {
    expectedRevision: 9,
    expectedInputDigest: "b".repeat(64),
  });

  currentItems = [eligibleOwnerRetryItem({ itemId, status: "queued" })];
  await view.load();
  await view.retryDecisionExhaustion(itemId, {
    expectedRevision: 999,
    expectedInputDigest: "f".repeat(64),
    actorId: "attacker",
  });
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
});

test("owner retry rejects ambiguous duplicate item IDs", async () => {
  const itemId = "work-item-ambiguous-owner-retry";
  const items = [
    eligibleOwnerRetryItem({
      assignmentId: "ambiguous-row-a",
      itemId,
    }),
    eligibleOwnerRetryItem({
      assignmentId: "ambiguous-row-b",
      itemId,
      revision: 8,
      inputDigest: "b".repeat(64),
      source: {
        ...eligibleOwnerRetryItem().source,
        current: {
          ...eligibleOwnerRetryItem().source.current,
          inputDigest: "b".repeat(64),
        },
      },
    }),
  ];
  const calls = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") return response({ requeued: true });
      return workProjectionResponse(url, items);
    },
  });
  await view.load();

  const html = view.render();
  await view.retryDecisionExhaustion(itemId);

  assert.equal(
    (html.match(/data-owner-decision-retry-item-id=/g) || []).length,
    0,
  );
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    0,
  );
});

test("owner retry counts ineligible and malformed readable duplicate IDs", async (t) => {
  const itemId = "work-item-readable-duplicate";
  const customPrototypeItem = Object.assign(
    Object.create({ inherited: true }),
    eligibleOwnerRetryItem({
      assignmentId: "custom-prototype-duplicate",
      itemId,
    }),
  );
  const scenarios = [
    [
      "queued duplicate",
      eligibleOwnerRetryItem({
        assignmentId: "queued-duplicate",
        itemId,
        status: "queued",
      }),
    ],
    ["custom-prototype duplicate", customPrototypeItem],
  ];

  for (const [name, duplicate] of scenarios) {
    await t.test(name, async () => {
      const items = [eligibleOwnerRetryItem({ itemId }), duplicate];
      const calls = [];
      const view = createWorkView({
        fetchImpl: async (url, options = {}) => {
          calls.push({ url, options });
          if (url === "/api/work/daily/items?limit=50&order=newest") {
            return {
              ok: true,
              status: 200,
              async json() {
                return { items };
              },
            };
          }
          if (options.method === "POST") return response({ requeued: true });
          return workProjectionResponse(url, []);
        },
      });
      await view.load();

      const html = view.render();
      await view.retryDecisionExhaustion(itemId);

      assert.equal(
        (html.match(/data-owner-decision-retry-item-id=/g) || []).length,
        0,
      );
      assert.equal(
        calls.filter(({ options }) => options.method === "POST").length,
        0,
      );
    });
  }
});

test("owner retry permits one pending request and disables every eligible control", async () => {
  const pendingResponse = deferred();
  const items = [
    eligibleOwnerRetryItem({ itemId: "owner-retry-a" }),
    eligibleOwnerRetryItem({ itemId: "owner-retry-b" }),
  ];
  const calls = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") return pendingResponse.promise;
      return workProjectionResponse(url, items);
    },
  });
  await view.load();

  const pending = view.retryDecisionExhaustion("owner-retry-a");
  await view.retryDecisionExhaustion("owner-retry-a");
  await view.retryDecisionExhaustion("owner-retry-b");

  const pendingHtml = view.render();
  assert.match(
    pendingHtml,
    /data-owner-decision-retry-item-id="owner-retry-a" disabled>正在重新排队…<\/button>/,
  );
  assert.match(
    pendingHtml,
    /data-owner-decision-retry-item-id="owner-retry-b" disabled>重新排队一次<\/button>/,
  );
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );

  pendingResponse.resolve(response({ requeued: true }));
  await pending;
});

test("owner retry reloads and notices on success or conflict, and escapes row errors", async (t) => {
  for (const scenario of [
    {
      name: "success",
      mutation: response({ requeued: true }),
      notice: /重新排队.*系统/,
      reloads: 2,
    },
    {
      name: "conflict",
      mutation: response({ error: "stale" }, false, 409),
      notice: /工作项.*变化/,
      reloads: 2,
    },
    {
      name: "bounded error",
      mutation: response({ error: "<img src=x onerror=alert(1)>" }, false, 503),
      notice: null,
      reloads: 1,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const notices = [];
      const items = [eligibleOwnerRetryItem()];
      const view = createWorkView({
        fetchImpl: async (url, options = {}) => {
          calls.push({ url, options });
          if (options.method === "POST") return scenario.mutation;
          return workProjectionResponse(url, items);
        },
        onNotice: (message) => notices.push(message),
      });
      await view.load();
      await view.retryDecisionExhaustion("work-item-owner-retry");

      assert.equal(
        calls.filter(({ url }) => url === "/api/work/daily/summary").length,
        scenario.reloads,
      );
      if (scenario.notice) {
        assert.equal(notices.length, 1);
        assert.match(notices[0], scenario.notice);
      } else {
        assert.deepEqual(notices, []);
        assert.match(
          view.render(),
          /role="alert"[^>]*>[^<]*&lt;img src=x onerror=alert\(1\)&gt;/,
        );
        assert.doesNotMatch(view.render(), /<img src=x/);

        const nextAttempt = view.retryDecisionExhaustion("work-item-owner-retry");
        assert.doesNotMatch(view.render(), /role="alert"/);
        await nextAttempt;
        await view.load();
        assert.doesNotMatch(view.render(), /role="alert"/);
      }
    });
  }
});

test("a late owner retry response cannot overwrite a newer Work load", async () => {
  const pendingResponse = deferred();
  let currentItems = [eligibleOwnerRetryItem()];
  const calls = [];
  const notices = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") return pendingResponse.promise;
      return workProjectionResponse(url, currentItems);
    },
    onNotice: (message) => notices.push(message),
  });
  await view.load();
  const pending = view.retryDecisionExhaustion("work-item-owner-retry");

  currentItems = [eligibleOwnerRetryItem({
    assignmentId: "newer-local-state",
    revision: 8,
    inputDigest: "b".repeat(64),
    source: {
      ...eligibleOwnerRetryItem().source,
      current: {
        ...eligibleOwnerRetryItem().source.current,
        inputDigest: "b".repeat(64),
      },
    },
  })];
  await view.load();
  const duplicateAfterLoad = view.retryDecisionExhaustion(
    "work-item-owner-retry",
  );
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
  assert.match(view.render(), /正在重新排队…/);
  pendingResponse.resolve(
    response({ error: "<script>late failure</script>" }, false, 503),
  );
  await Promise.all([pending, duplicateAfterLoad]);

  assert.match(view.render(), /newer-local-state/);
  assert.doesNotMatch(view.render(), /role="alert"|late failure|正在重新排队/);
  assert.deepEqual(notices, []);
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
});

test("code jobs render every safe lifecycle state from browser projections", () => {
  const statuses = [
    ["queued", "已授权，等待执行"],
    ["starting", "正在准备隔离工作区"],
    ["active", "受控执行中"],
    ["pausing", "正在安全暂停"],
    ["unknown", "状态待核验"],
    ["paused", "已暂停"],
    ["cancelling", "正在安全取消"],
    ["cancelled", "已取消"],
    ["completed", "已完成"],
    ["failed", "执行失败"],
    ["fenced", "安全隔离，等待核验"],
  ];
  const html = renderWorkView({
    loaded: true,
    error: "",
    summary: { itemCounts: {}, safeguards: {} },
    items: [],
    timeline: [],
    codeJobsEnabled: true,
    codeJobsError: "",
    codeJobs: statuses.map(([status], index) => ({
      jobId: `code-job-${status}`,
      status,
      requestedBy: { roleId: "developer", workItemId: `work-${index}` },
      repository: "acme/repo",
      workspaceId: "acme-workspace",
      operation: "modify",
      turn: index,
      pendingActionType: ["active", "unknown"].includes(status)
        ? "write_text"
        : null,
      latestObservation: status === "starting"
        ? {
            actionType: "list_files",
            status: "succeeded",
            recordedAt: "2026-08-02T03:58:00.000Z",
          }
        : null,
      terminalResult: ["cancelled", "completed", "failed", "fenced"].includes(status)
        ? { kind: status, recordedAt: "2026-08-02T03:59:00.000Z" }
        : null,
      pause: status === "paused"
        ? { reason: "等待用户检查 <workspace>", at: "2026-08-02T03:59:00.000Z" }
        : null,
      uncertainty: status === "unknown"
        ? {
            from: "active",
            code: "EXECUTOR_RESULT_UNKNOWN",
            message: "结果来自 <executor>，等待核验",
            at: "2026-08-02T03:59:00.000Z",
          }
        : null,
      updatedAt: "2026-08-02T03:59:00.000Z",
    })),
  }, { now: Date.parse("2026-08-02T04:00:00.000Z") });

  for (const [status, label] of statuses) {
    assert.match(html, new RegExp(`status-${status}[^>]*>${label}`));
  }
  assert.match(html, /待执行 write_text/);
  assert.match(html, /最近动作 list_files · 成功/);
  assert.match(html, /暂停原因：等待用户检查 &lt;workspace&gt;/);
  assert.match(
    html,
    /待核验：EXECUTOR_RESULT_UNKNOWN · 结果来自 &lt;executor&gt;，等待核验/,
  );
  assert.doesNotMatch(html, /暂停原因：结果来自/);
  assert.match(html, /<button[^>]+data-code-job-id="code-job-active"/);
});

test("code job controls use exact live lifecycle eligibility", () => {
  const commandsFor = (state) => [
    ...renderCodeJobDetail(state).matchAll(/data-code-job-control="([^"]+)"/g),
  ].map((match) => match[1]);
  const cases = [
    ["queued", ["pause", "cancel"]],
    ["starting", ["pause", "cancel"]],
    ["active", ["pause", "cancel"]],
    ["pausing", ["cancel"]],
    ["unknown", ["cancel"]],
    ["paused", ["resume", "cancel"]],
    ["cancelling", []],
    ["cancelled", []],
    ["completed", []],
    ["failed", []],
    ["fenced", []],
    ["future_state", []],
  ];

  for (const [status, expected] of cases) {
    const state = codeJobControlDetailState(status);
    const html = renderCodeJobDetail(state);
    assert.deepEqual(commandsFor(state), expected, status);
    if (status === "cancelling") assert.match(html, /正在安全取消/);
    if (status === "cancelled") assert.match(html, /已取消/);
  }

  assert.deepEqual(
    commandsFor(codeJobControlDetailState("active", { archived: true })),
    [],
  );
  assert.deepEqual(
    commandsFor(codeJobControlDetailState("active", { revision: 0 })),
    [],
  );
  const missingArchived = codeJobControlDetailState("active");
  delete missingArchived.detail.archived;
  assert.deepEqual(commandsFor(missingArchived), []);

  const cancelling = renderCodeJobDetail(codeJobControlDetailState("active", {
    controlLoading: true,
    controlCommand: "cancel",
  }));
  assert.match(
    cancelling,
    /data-code-job-control="cancel" disabled>正在请求取消…<\/button>/,
  );
  assert.match(
    cancelling,
    /data-code-job-control="pause" disabled>安全暂停<\/button>/,
  );
});

test("code job detail renders safe evidence, history, controls, and package metadata", () => {
  const detailJobId = `code-job-${"1".repeat(55)}`;
  const html = renderCodeJobDetail({
    loading: false,
    error: "",
    detail: {
      job: {
        jobId: detailJobId,
        revision: 7,
        status: "active",
        requestedBy: { roleId: "developer", workItemId: "work-1" },
        repository: "acme/repo",
        inputBinding: {
          repository: "acme/repo",
          pullRequestNumber: 42,
          headRefOid: "a".repeat(40),
        },
        workspaceId: "acme-workspace",
        operation: "modify",
        objective: "修复 <unsafe> 分支",
        acceptanceCriteria: ["测试通过", "不泄露 <secret>"],
        evidence: ["issue #42"],
        summary: "受控修改",
        reason: "用户授权",
        allowedActions: ["read_text", "write_text"],
        writablePaths: ["src"],
        requiredProfiles: ["node-tests"],
        observationCount: 2,
        memoryProjection: {
          recordId: `memory-${"a".repeat(64)}`,
          projectedAt: "2026-08-02T03:59:30.000Z",
        },
        createdAt: "2026-08-02T03:55:00.000Z",
        updatedAt: "2026-08-02T03:59:30.000Z",
      },
      archived: false,
      historyAvailable: true,
      observations: [{
        actionType: "read_text",
        status: "succeeded",
        detail: { summary: "读取 <src/app.js>" },
        detailDigest: "b".repeat(64),
        recordedAt: "2026-08-02T03:58:00.000Z",
      }],
      nextCursor: "observation:1",
      terminalDetail: { summary: "PRIVATE <terminal>" },
      changePackage: {
        status: "ready",
        receipt: {
          packageId: `change-package-${"c".repeat(64)}`,
          packageDigest: "c".repeat(64),
        },
        application: {
          status: "not_requested",
          canRequest: true,
        },
      },
    },
    manifest: {
      packageId: `change-package-${"c".repeat(64)}`,
      packageDigest: "c".repeat(64),
      job: { id: detailJobId },
      workspace: {
        id: "acme-workspace",
        sourceRevision: "d".repeat(64),
        workspaceRevision: "e".repeat(64),
      },
      changes: {
        created: [
          { path: "src/new.js", blob: { sha256: "f".repeat(64), bytes: 12 } },
          { path: "<img src=x onerror=alert(1)>", blob: { sha256: "f".repeat(64), bytes: 1 } },
        ],
        modified: [{ path: "src/app.js", beforeSha256: "1".repeat(64), blob: { sha256: "2".repeat(64), bytes: 24 } }],
        deleted: [{ path: "src/old.js", beforeSha256: "3".repeat(64) }],
      },
      passedProfiles: [{
        id: "node-tests",
        configDigest: "4".repeat(64),
        workspaceRevision: "e".repeat(64),
        actionId: "action-node-tests",
        attemptNumber: 2,
        imageId: "node@sha256:test",
        artifacts: {
          output: {
            path: `${detailJobId}/action-node-tests/output.json`,
            sha256: "5".repeat(64),
            bytes: 101,
          },
          stdout: {
            path: `${detailJobId}/action-node-tests/stdout.json`,
            sha256: "6".repeat(64),
            bytes: 102,
          },
          stderr: {
            path: `${detailJobId}/action-node-tests/stderr.json`,
            sha256: "7".repeat(64),
            bytes: 103,
          },
        },
      }],
    },
    historyLoading: false,
    packageLoading: false,
    controlLoading: false,
    applyLoading: false,
    actionError: "",
  }, { now: Date.parse("2026-08-02T04:00:00.000Z") });

  for (const visible of [
    "任务目标",
    "PR 输入",
    "精确 Head",
    "验收条件",
    "授权依据",
    "安全观察历史",
    "终态详情",
    "记忆投影",
    "变更包",
    "src/new.js",
    "node-tests",
    "加载更多观察",
    "安全暂停",
    "取消任务",
    "申请应用变更包",
  ]) {
    assert.equal(html.includes(visible), true, visible);
  }
  assert.match(html, /修复 &lt;unsafe&gt; 分支/);
  assert.match(html, /acme\/repo #42/);
  assert.match(html, new RegExp("a{40}"));
  assert.match(html, /读取 &lt;src\/app\.js&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, new RegExp(`变更前 <code>${"1".repeat(64)}</code> → 变更后 <code>${"2".repeat(64)}</code>`));
  assert.match(html, new RegExp(`配置摘要[\\s\\S]*${"4".repeat(64)}`));
  assert.match(html, /action-node-tests/);
  assert.match(html, /尝试 2/);
  assert.match(html, new RegExp(`${"5".repeat(64)}[\\s\\S]*101 bytes[\\s\\S]*output\\.json`));
  assert.match(html, new RegExp(`${"6".repeat(64)}[\\s\\S]*102 bytes[\\s\\S]*stdout\\.json`));
  assert.match(html, new RegExp(`${"7".repeat(64)}[\\s\\S]*103 bytes[\\s\\S]*stderr\\.json`));
  assert.equal((html.match(/class="code-job-evidence-download"/g) || []).length, 3);
  assert.match(
    html,
    new RegExp(
      `/api/code/jobs/${detailJobId}/change-package/change-package-${"c".repeat(64)}/evidence/node-tests/output\\?packageDigest=${"c".repeat(64)}&amp;sha256=${"5".repeat(64)}`,
    ),
  );
  assert.doesNotMatch(html, /<unsafe>|<secret>|<terminal>|<img src=x/);
});

test("change package application stays hidden until the owner inspects the manifest", () => {
  const html = renderCodeJobDetail({
    loading: false,
    error: "",
    detail: {
      job: {
        jobId: "code-job-inspect-first",
        revision: 4,
        status: "completed",
        requestedBy: { roleId: "developer", workItemId: "work-1" },
      },
      archived: false,
      historyAvailable: true,
      observations: [],
      nextCursor: null,
      terminalDetail: null,
      changePackage: {
        status: "ready",
        receipt: {
          packageId: `change-package-${"a".repeat(64)}`,
          packageDigest: "a".repeat(64),
          deliveredAt: "2026-08-02T04:00:00.000Z",
        },
        application: {
          status: "not_requested",
          canRequest: true,
        },
      },
    },
    manifest: null,
    historyLoading: false,
    packageLoading: false,
    controlLoading: false,
    applyLoading: false,
    actionError: "",
  });

  assert.match(html, /查看变更包/);
  assert.doesNotMatch(html, /申请应用变更包/);
});

test("change package application renders every authoritative lifecycle state", () => {
  const statuses = [
    ["not_requested", "尚未申请"],
    ["pending", "等待你确认"],
    ["applying", "正在应用"],
    ["rejected", "已拒绝"],
    ["stale", "已失效"],
    ["failed", "应用失败"],
    ["applied", "应用完成"],
    ["already", "已确认应用"],
  ];

  for (const [status, label] of statuses) {
    const html = renderCodeJobDetail(applicationDetailState({
      status,
      canRequest: false,
    }));
    assert.match(
      html,
      new RegExp(`data-application-status="${status}"[\\s\\S]*${label}`),
      status,
    );
    assert.doesNotMatch(html, /申请应用变更包/, status);
  }
});

test("change package application renders only whitelisted terminal metadata", () => {
  const failed = renderCodeJobDetail(applicationDetailState({
    status: "failed",
    canRequest: false,
    confirmationId: "confirmation-change-package-apply-safe",
    updatedAt: "2026-08-03T01:02:03.000Z",
    retryable: true,
    failure: {
      code: "CHANGE_PACKAGE_TARGET_DIRTY",
      outcome: "absent",
      retryable: true,
      at: "2026-08-03T01:02:02.000Z",
    },
  }));
  assert.match(failed, /confirmation-change-package-apply-safe/);
  assert.match(failed, /CHANGE_PACKAGE_TARGET_DIRTY/);
  assert.match(failed, /absent/);
  assert.match(failed, /请在确认队列重试/);

  const applied = renderCodeJobDetail(applicationDetailState({
    status: "applied",
    canRequest: false,
    receipt: {
      id: "change-package-application-safe",
      createdAt: "2026-08-03T01:03:00.000Z",
    },
  }));
  assert.match(applied, /change-package-application-safe/);

  const rejected = renderCodeJobDetail(applicationDetailState({
    status: "rejected",
    canRequest: false,
    rejectedAt: "2026-08-03T01:04:00.000Z",
  }));
  assert.match(rejected, /拒绝时间/);
});

test("application request button requires ready package, inspected manifest, and exact backend permission", () => {
  const allowed = { status: "not_requested", canRequest: true };
  assert.match(
    renderCodeJobDetail(applicationDetailState(allowed)),
    /申请应用变更包/,
  );

  for (const state of [
    applicationDetailState({ status: "not_requested", canRequest: false }),
    applicationDetailState(allowed, { manifest: null }),
    applicationDetailState(allowed, { packageStatus: "pending" }),
    applicationDetailState(null),
    applicationDetailState({ status: "future_state", canRequest: true }),
    applicationDetailState({ status: "not_requested" }),
  ]) {
    assert.doesNotMatch(renderCodeJobDetail(state), /申请应用变更包/);
  }
});

test("programmatic application requests obey the same manifest and backend permission gate", async () => {
  const createGuardedView = (application) => {
    const calls = [];
    const view = createWorkView({
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        if (url.endsWith("/change-package/apply")) {
          return response({ queued: true });
        }
        if (url.endsWith("/change-package")) {
          return response({
            manifest: { packageId: `change-package-${"a".repeat(64)}` },
          });
        }
        return response({
          enabled: true,
          detail: applicationDetailState(application).detail,
        });
      },
      onDetail: () => {},
    });
    return { calls, view };
  };

  const notInspected = createGuardedView({
    status: "not_requested",
    canRequest: true,
  });
  await notInspected.view.openCodeJob("code-job-application-ui");
  await notInspected.view.requestCodeJobChangePackageApply();
  assert.equal(
    notInspected.calls.some(({ url }) => url.endsWith("/change-package/apply")),
    false,
  );

  const denied = createGuardedView({
    status: "not_requested",
    canRequest: false,
  });
  await denied.view.openCodeJob("code-job-application-ui");
  await denied.view.loadCodeJobChangePackage();
  await denied.view.requestCodeJobChangePackageApply();
  assert.equal(
    denied.calls.some(({ url }) => url.endsWith("/change-package/apply")),
    false,
  );
});

test("malformed application metadata fails closed without invoking accessors or leaking text", () => {
  let getterCalls = 0;
  const accessor = { status: "not_requested" };
  Object.defineProperty(accessor, "canRequest", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  const hostileValues = [
    accessor,
    {
      status: "failed",
      canRequest: true,
      retryable: true,
      failure: {
        code: "CHANGE_PACKAGE_TARGET_DIRTY",
        outcome: "absent",
        retryable: true,
        at: "2026-08-03T01:00:00.000Z",
        message: "<script>PRIVATE FAILURE</script>",
      },
    },
    {
      status: "applied",
      canRequest: true,
      receipt: {
        id: "change-package-application-safe",
        createdAt: "2026-08-03T01:00:00.000Z",
        privatePath: "C:\\private\\secret.txt",
      },
    },
    {
      status: "not_requested",
      canRequest: true,
      confirmationId: "<img src=x onerror=alert(1)>",
    },
  ];

  for (const application of hostileValues) {
    const html = renderCodeJobDetail(applicationDetailState(application));
    assert.match(html, /应用状态不可用；申请入口已安全关闭/);
    assert.doesNotMatch(html, /申请应用变更包|PRIVATE FAILURE|private\\secret|<img/);
  }
  assert.equal(getterCalls, 0);
});

test("code job controller uses exact trusted endpoints and queues package application", async () => {
  const calls = [];
  const detailPayload = {
    enabled: true,
    detail: {
      job: { jobId: "code-job-1", revision: 7, status: "active" },
      archived: false,
      historyAvailable: true,
      observations: [{ actionType: "read_text", status: "succeeded" }],
      nextCursor: "cursor-1",
      terminalDetail: null,
      changePackage: {
        status: "ready",
        receipt: { packageId: `change-package-${"a".repeat(64)}` },
        application: {
          status: "not_requested",
          canRequest: true,
        },
      },
    },
  };
  const detailViews = [];
  let applyRequested = 0;
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/api/code/jobs?limit=50&order=newest") {
        return response({ enabled: true, items: [detailPayload.detail.job] });
      }
      if (url.includes("/change-package/apply")) return response({ queued: true });
      if (url.endsWith("/change-package")) {
        return response({ manifest: { packageId: detailPayload.detail.changePackage.receipt.packageId } });
      }
      if (url.includes("cursor=cursor-1")) {
        return response({
          enabled: true,
          detail: {
            ...detailPayload.detail,
            observations: [{ actionType: "complete", status: "succeeded" }],
            nextCursor: null,
          },
        });
      }
      if (url.endsWith("/control")) return response({ updated: true });
      return response(detailPayload);
    },
    onDetail: (markup) => detailViews.push(markup),
    onApplyRequested: async () => { applyRequested += 1; },
  });

  await view.openCodeJob("code-job-1");
  await view.loadMoreCodeJobObservations();
  await view.loadCodeJobChangePackage();
  await view.controlCodeJob("pause");
  await view.loadCodeJobChangePackage();
  await view.requestCodeJobChangePackageApply();

  assert.equal(
    calls.some(({ url }) => url === "/api/code/jobs/code-job-1?limit=20"),
    true,
  );
  assert.equal(
    calls.some(({ url }) => url.endsWith("?limit=20&cursor=cursor-1")),
    true,
  );
  for (const endpoint of ["/control", "/change-package/apply"]) {
    const call = calls.find(({ url }) => url.endsWith(endpoint));
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["x-mydashboard-action"], "1");
    assert.equal(call.options.headers["content-type"], "application/json");
  }
  assert.deepEqual(
    JSON.parse(calls.find(({ url }) => url.endsWith("/control")).options.body),
    { command: "pause", expectedRevision: 7 },
  );
  assert.deepEqual(
    JSON.parse(calls.find(({ url }) => url.endsWith("/change-package/apply")).options.body),
    { expectedRevision: 7 },
  );
  assert.equal(applyRequested, 1);
  assert.equal(detailViews.some((markup) => markup.includes("complete")), true);
});

test("programmatic cancellation uses the same exact lifecycle and revision gate", async () => {
  const jobId = "code-job-cancel-ui";
  let status = "unknown";
  let revision = 11;
  const calls = [];
  const detail = () => ({
    ...codeJobControlDetailState(status, { revision }).detail,
    job: {
      ...codeJobControlDetailState(status, { revision }).detail.job,
      jobId,
    },
  });
  const detailViews = [];
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === `/api/code/jobs/${jobId}?limit=20`) {
        return response({ enabled: true, detail: detail() });
      }
      if (url === `/api/code/jobs/${jobId}/control`) {
        status = "cancelling";
        revision += 1;
        return response({ status: "applied", job: detail().job });
      }
      if (url === "/api/code/jobs?limit=50&order=newest") {
        return response({ enabled: true, items: [detail().job] });
      }
      throw new Error(`unexpected request: ${url}`);
    },
    onDetail: (markup) => detailViews.push(markup),
  });

  await view.openCodeJob(jobId);
  await view.controlCodeJob("cancel");

  const mutation = calls.find(({ url }) => url.endsWith("/control"));
  assert.equal(mutation.options.method, "POST");
  assert.equal(mutation.options.headers["content-type"], "application/json");
  assert.equal(mutation.options.headers["x-mydashboard-action"], "1");
  assert.deepEqual(JSON.parse(mutation.options.body), {
    command: "cancel",
    expectedRevision: 11,
  });
  assert.match(detailViews.at(-1), /正在安全取消/);
  assert.doesNotMatch(detailViews.at(-1), /data-code-job-control=/);
});

test("programmatic cancellation fails closed for untrusted detail states", async () => {
  const missingArchived = codeJobControlDetailState("active").detail;
  delete missingArchived.archived;
  const cases = [
    ["future status", codeJobControlDetailState("future_state").detail],
    ["cancelling", codeJobControlDetailState("cancelling").detail],
    ["cancelled", codeJobControlDetailState("cancelled").detail],
    ["terminal", codeJobControlDetailState("completed").detail],
    ["archived", codeJobControlDetailState("active", { archived: true }).detail],
    ["missing archived", missingArchived],
    ["zero revision", codeJobControlDetailState("active", { revision: 0 }).detail],
    ["fractional revision", codeJobControlDetailState("active", { revision: 1.5 }).detail],
  ];

  for (const [label, detail] of cases) {
    const calls = [];
    const view = createWorkView({
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, options });
        return response({ enabled: true, detail });
      },
      onDetail: () => {},
    });
    await view.openCodeJob(detail.job.jobId);
    await view.controlCodeJob("cancel");
    assert.equal(
      calls.some(({ options }) => options.method === "POST"),
      false,
      label,
    );
  }

  const validCalls = [];
  const valid = codeJobControlDetailState("active").detail;
  const validView = createWorkView({
    fetchImpl: async (url, options = {}) => {
      validCalls.push({ url, options });
      return response({ enabled: true, detail: valid });
    },
    onDetail: () => {},
  });
  await validView.openCodeJob(valid.job.jobId);
  await validView.controlCodeJob("destroy");
  assert.equal(
    validCalls.some(({ options }) => options.method === "POST"),
    false,
  );
});

test("a stale code job control closes detail and reloads the list", async () => {
  const calls = [];
  let closed = 0;
  let notice = "";
  const view = createWorkView({
    fetchImpl: async (url, options = {}) => {
      calls.push(url);
      if (url.endsWith("/control") && options.method === "POST") {
        return response({ error: "stale" }, false, 409);
      }
      if (url === "/api/code/jobs?limit=50&order=newest") {
        return response({ enabled: true, items: [] });
      }
      return response({
        enabled: true,
        detail: {
          job: { jobId: "code-job-stale", revision: 2, status: "paused" },
          archived: false,
          observations: [],
          nextCursor: null,
          changePackage: { status: "pending", receipt: null },
        },
      });
    },
    onDetail: () => {},
    onDetailClose: () => { closed += 1; },
    onNotice: (message) => { notice = message; },
  });

  await view.openCodeJob("code-job-stale");
  await view.controlCodeJob("resume");

  assert.equal(closed, 1);
  assert.match(notice, /状态已经变化/);
  assert.equal(calls.includes("/api/code/jobs?limit=50&order=newest"), true);
});

test("a stale package read also invalidates the shared detail", async () => {
  let closed = 0;
  const calls = [];
  const view = createWorkView({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/change-package")) {
        return response({ error: "stale receipt" }, false, 409);
      }
      if (url === "/api/code/jobs?limit=50&order=newest") {
        return response({ enabled: true, items: [] });
      }
      return response({
        enabled: true,
        detail: {
          job: { jobId: "code-job-stale-package", revision: 3, status: "completed" },
          observations: [],
          nextCursor: null,
          changePackage: {
            status: "ready",
            receipt: { packageId: `change-package-${"a".repeat(64)}` },
            application: {
              status: "not_requested",
              canRequest: true,
            },
          },
        },
      });
    },
    onDetail: () => {},
    onDetailClose: () => { closed += 1; },
  });

  await view.openCodeJob("code-job-stale-package");
  await view.loadCodeJobChangePackage();

  assert.equal(closed, 1);
  assert.equal(calls.includes("/api/code/jobs?limit=50&order=newest"), true);
});

test("a stale mutation response from an old job cannot close a newly opened detail", async (t) => {
  for (const operation of ["control", "cancel", "apply"]) {
    await t.test(operation, async () => {
      const pendingResponse = deferred();
      const details = [];
      let closed = 0;
      let notice = "";
      const detailFor = (jobId) => ({
        enabled: true,
        detail: {
          job: { jobId, revision: 3, status: "active" },
          archived: false,
          historyAvailable: true,
          observations: [],
          nextCursor: null,
          terminalDetail: null,
          changePackage: {
            status: "ready",
            receipt: { packageId: `change-package-${"a".repeat(64)}` },
            application: {
              status: "not_requested",
              canRequest: true,
            },
          },
        },
      });
      const view = createWorkView({
        fetchImpl: async (url, options = {}) => {
          if (
            options.method === "POST" &&
            ((["control", "cancel"].includes(operation) && url.endsWith("/control")) ||
              (operation === "apply" && url.endsWith("/change-package/apply")))
          ) {
            return pendingResponse.promise;
          }
          if (url === "/api/code/jobs/code-job-a?limit=20") {
            return response(detailFor("code-job-a"));
          }
          if (url === "/api/code/jobs/code-job-b?limit=20") {
            return response(detailFor("code-job-b"));
          }
          if (url.endsWith("/change-package")) {
            return response({ manifest: { packageId: `change-package-${"a".repeat(64)}` } });
          }
          throw new Error(`unexpected request: ${url}`);
        },
        onDetail: (markup) => details.push(markup),
        onDetailClose: () => { closed += 1; },
        onNotice: (message) => { notice = message; },
      });

      await view.openCodeJob("code-job-a");
      if (operation === "apply") await view.loadCodeJobChangePackage();
      const pendingMutation = operation === "control"
        ? view.controlCodeJob("pause")
        : operation === "cancel"
          ? view.controlCodeJob("cancel")
          : view.requestCodeJobChangePackageApply();
      view.closeDetail();
      await view.openCodeJob("code-job-b");
      pendingResponse.resolve(response({ error: "stale" }, false, 409));
      await pendingMutation;

      assert.equal(closed, 0);
      assert.equal(notice, "");
      assert.match(details.at(-1), /code-job-b/);
    });
  }
});

test("work view reads only newest-first projection endpoints", async () => {
  const calls = [];
  const values = [
    { itemCounts: {}, safeguards: {} },
    { items: [{ assignmentId: "newest", status: "queued" }] },
    { items: [{ type: "latest" }] },
    { enabled: true, items: [{ id: "code-job-newest", status: "queued" }] },
    {
      schemaVersion: 1,
      graph: {
        schemaVersion: 1,
        graphId: "work-ledger",
        revision: 0,
        tasks: [],
      },
      taskStates: [],
    },
  ];
  const view = createWorkView({
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return response(values[calls.length - 1]);
    },
  });

  await view.load();

  assert.deepEqual(calls.map(([url]) => url), [
    "/api/work/daily/summary",
    "/api/work/daily/items?limit=50&order=newest",
    "/api/work/timeline?limit=50&order=newest",
    "/api/code/jobs?limit=50&order=newest",
    "/api/work/graph",
  ]);
  assert.equal(calls.every(([, options]) => options.cache === "no-store"), true);
  assert.match(view.render(), /newest/);
  assert.match(view.render(), /latest/);
  assert.match(view.render(), /code-job-newest|已授权，等待执行/);
});

test("work view manually adds an old GitHub target without widening automatic scope", async () => {
  const calls = [];
  let notice = "";
  const requestId = "12345678-1234-4123-8123-123456789abc";
  const view = createWorkView({
    requestIdFactory: () => requestId,
    onNotice(message) {
      notice = message;
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "/api/work/requests") {
        return response({
          requestId,
          workItemId: "work-item-manual-old",
          assignment: { target: { type: "role", id: "pr-engineer" } },
        }, true, 201);
      }
      return workProjectionResponse(url, []);
    },
  });

  const result = await view.addHistoricalWork({
    sourceUrl: "https://github.com/ExampleOrg/SoftwareApp/pull/23991",
    workType: "pull_request",
    priority: "high",
  });

  const mutation = calls.find(({ url }) => url === "/api/work/requests");
  assert.deepEqual(mutation.options.headers, {
    "content-type": "application/json",
    "x-mydashboard-action": "1",
  });
  assert.deepEqual(JSON.parse(mutation.options.body).pullRequest, {
    repository: "ExampleOrg/SoftwareApp",
    number: 23991,
  });
  assert.equal(JSON.parse(mutation.options.body).requestId, requestId);
  assert.equal(result.workItemId, "work-item-manual-old");
  assert.match(notice, /已人工加入日常任务/);
  assert.equal(calls.some(({ url }) => url === "/api/work/daily/summary"), true);

  await assert.rejects(
    view.addHistoricalWork({
      sourceUrl: "https://github.com/ExampleOrg/ProductApp/issues/12917",
      workType: "pull_request",
      priority: "high",
    }),
    /Issue 不能分配为 PR Review/,
  );
});

test("manual historical work retry reuses its idempotency key until the request changes", async () => {
  const requestIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const requests = [];
  const view = createWorkView({
    requestIdFactory: () => requestIds.shift(),
    fetchImpl: async (url, options = {}) => {
      if (url !== "/api/work/requests") {
        return workProjectionResponse(url, []);
      }
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return response({ error: "temporary failure" }, false, 503);
      }
      return response({
        requestId: body.requestId,
        workItemId: `work-${requests.length}`,
        assignment: { target: { type: "role", id: "developer" } },
      }, true, 201);
    },
  });
  const base = {
    sourceUrl: "https://github.com/ExampleOrg/ProductApp/issues/12917",
    workType: "development",
    priority: "high",
  };

  await assert.rejects(view.addHistoricalWork(base), /temporary failure/);
  await view.addHistoricalWork(base);
  await view.addHistoricalWork({ ...base, priority: "normal" });

  assert.deepEqual(
    requests.map(({ requestId }) => requestId),
    [
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
  );
});

test("work view can filter recent items to one configured role", async () => {
  const calls = [];
  let clearRole;
  const view = createWorkView({
    fetchImpl: async (url) => {
      calls.push(url);
      return workProjectionResponse(
        url.replace("&roleId=developer", ""),
        [{ assignmentId: "developer-task", status: "queued" }],
      );
    },
  });

  view.setRoleFilter("developer");
  await view.load();

  assert.equal(
    calls.includes("/api/work/daily/items?limit=50&order=newest&roleId=developer"),
    true,
  );
  assert.match(view.render(), /仅显示岗位 developer/);
  assert.match(view.render(), /显示全部岗位/);

  view.bind({
    querySelectorAll(selector) {
      if (selector === "[data-work-clear-role]") {
        return [{
          addEventListener(_type, handler) {
            clearRole = handler;
          },
        }];
      }
      return [];
    },
  });
  clearRole();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    calls.includes("/api/work/daily/items?limit=50&order=newest"),
    true,
  );
});

test("work view renders loading, empty, and safe read failures", async () => {
  assert.match(renderWorkView({ loaded: false }), /正在读取/);
  assert.match(
    renderWorkView({
      loaded: true,
      error: "",
      summary: { itemCounts: {}, safeguards: {} },
      items: [],
      timeline: [],
    }),
    /尚无工作项/,
  );

  const view = createWorkView({
    fetchImpl: async () => response({ error: "private detail" }, false, 503),
  });
  await view.load();
  assert.match(view.render(), /工作台账暂不可用/);
  assert.match(view.render(), /private detail/);
});

test("frontend work module exposes only revision-bound controls and no execution route", async () => {
  const source = await readFile(
    path.resolve(testDirectory, "../public/work-view.js"),
    "utf8",
  );

  assert.match(source, /method:\s*["']POST["']/);
  assert.match(source, /expectedRevision/);
  assert.match(source, /x-mydashboard-action/);
  assert.doesNotMatch(source, /\/api\/work\/(?:intake|claim|stage|dispatch|outbox)/);
  assert.doesNotMatch(source, /data-(?:claim|dispatch|execute)/);
  assert.doesNotMatch(source, /\/api\/code\/jobs[^"']*\/(?:run|execute|commit|push)/);
  assert.doesNotMatch(source, /body:\s*JSON\.stringify\([^)]*(?:path|patch|target)/);
  const manifestRenderer = source.slice(
    source.indexOf("function codeJobManifestMarkup"),
    source.indexOf("function codeJobObservationsMarkup"),
  );
  assert.doesNotMatch(manifestRenderer, /JSON\.stringify/);
  assert.doesNotMatch(manifestRenderer, /href=[^\n]*artifact\.path/);
});

test("a code job read failure does not blank the core work ledger", async () => {
  const view = createWorkView({
    fetchImpl: async (url) => {
      if (url.startsWith("/api/code/jobs")) {
        return response({ error: "code subsystem unavailable" }, false, 503);
      }
      if (url === "/api/work/daily/summary") {
        return response({ itemCounts: {}, safeguards: {} });
      }
      return response({ items: [{ assignmentId: "core-still-visible", status: "queued" }] });
    },
  });

  await view.load();
  assert.match(view.render(), /core-still-visible/);
  assert.match(view.render(), /code subsystem unavailable/);
});
