import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createDashboardServer,
  startApplicationBackgroundWork,
  startDashboardServer,
} from "../src/server.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";

function request(server, {
  method = "GET",
  path = "/",
  headers = {},
  body = "",
} = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: "127.0.0.1:4173",
          ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function requestPort(port, options = {}) {
  const target = {
    address() {
      return { port };
    },
  };
  return request(target, {
    ...options,
    headers: {
      host: `127.0.0.1:${port}`,
      ...(options.headers || {}),
    },
  });
}

function pendingConfirmationItem() {
  return {
    id: "confirmation-pr-work-startup",
    kind: "github.pull-request-review",
    status: "pending",
    queueRevision: 8,
    itemRevision: 2,
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: "pr-work-startup",
    },
    actor: { provider: "github", accountId: "review-account" },
    target: {
      provider: "github",
      resourceId: "acme/repo#42",
      version: "a".repeat(40),
    },
    display: {
      title: "acme/repo #42 · Checkout",
      summary: "旧确认必须先与首次 GitHub 刷新对账",
      actionLabel: "确认并发布到 GitHub",
      evidence: ["Head 已复核"],
      payload: {
        actor: { provider: "github", accountId: "review-account" },
        target: {
          provider: "github",
          resourceId: "acme/repo#42",
          version: "a".repeat(40),
        },
        action: {
          type: "pull_request_review",
          reviewEvent: "APPROVE",
          body: "Looks good.",
        },
      },
    },
    displayedPayloadDigest: "b".repeat(64),
    approvalBindingDigest: "c".repeat(64),
    retryable: false,
  };
}

function healthyRefreshResult() {
  return {
    dashboard: {
      sourceStatus: { githubPullRequests: { ok: true } },
      items: [],
    },
  };
}

function startupApplication({
  port = 0,
  refresh,
  runAll,
  recoverConfirmations = async () => {},
  close = async () => {},
  queueCalls = [],
} = {}) {
  const item = pendingConfirmationItem();
  let snapshot = null;
  const performRefresh = refresh || (async () => healthyRefreshResult());
  const employee = {
    id: "pr-reviewer",
    async recordConfirmationOutcome() {},
    recoverConfirmations,
  };
  return {
    config: {
      port,
      refreshMinutes: 10,
      githubActions: { enabled: true },
    },
    store: {
      async read(name) {
        return name === "snapshot" ? structuredClone(snapshot) : null;
      },
    },
    refreshService: {
      running: null,
      async refresh(options) {
        const result = await performRefresh(options);
        snapshot = structuredClone(result?.dashboard || null);
        return result;
      },
    },
    employeeRegistry: {
      get(id) {
        return id === employee.id ? employee : null;
      },
      async listRoles() {
        return [];
      },
      async view() {
        return {};
      },
      schedules() {
        return [];
      },
      runAll: runAll || (async () => {}),
    },
    confirmationQueue: {
      async next() {
        queueCalls.push("next");
        return {
          queueRevision: 8,
          pendingCount: 1,
          item: structuredClone(item),
        };
      },
      async approve() {
        queueCalls.push("approve");
        return { ...structuredClone(item), status: "completed" };
      },
      async retry() {
        queueCalls.push("retry");
        return { ...structuredClone(item), status: "completed" };
      },
      async reject() {
        queueCalls.push("reject");
        return { ...structuredClone(item), status: "rejected" };
      },
    },
    close,
  };
}

function confirmationApprovalRequest() {
  return {
    requestId: "request-startup-gate-0001",
    expectedQueueRevision: 8,
    expectedItemRevision: 2,
    displayedPayloadDigest: "b".repeat(64),
    approvalBindingDigest: "c".repeat(64),
  };
}

async function exerciseConfirmationRefreshGate(trigger) {
  const queueCalls = [];
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const reconcileStarted = deferred();
  const releaseReconcile = deferred();
  let refreshCalls = 0;
  let reconcileCalls = 0;
  const application = startupApplication({
    port: 4173,
    queueCalls,
    async refresh() {
      refreshCalls += 1;
      if (refreshCalls === 1) return healthyRefreshResult();
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return healthyRefreshResult();
    },
    async runAll() {
      reconcileCalls += 1;
      if (reconcileCalls === 1) return;
      reconcileStarted.resolve();
      await releaseReconcile.promise;
    },
  });
  const timers = [];
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });
  await backgroundWork.initialRefresh;
  const server = createDashboardServer(application, {
    backgroundWork,
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let cycle = null;

  try {
    const initiallyOpen = await request(server, {
      path: "/api/confirmations/next",
    });
    assert.equal(initiallyOpen.status, 200);
    queueCalls.length = 0;

    cycle =
      trigger === "periodic"
        ? timers[0].callback()
        : request(server, {
            method: "POST",
            path: "/api/refresh",
            headers: {
              origin: "http://127.0.0.1:4173",
              "x-mydashboard-action": "1",
            },
          });
    await refreshStarted.promise;

    const nextDuringRefresh = await request(server, {
      path: "/api/confirmations/next",
    });
    const approveDuringRefresh = await request(server, {
      method: "POST",
      path: `/api/confirmations/${pendingConfirmationItem().id}/approve`,
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(confirmationApprovalRequest()),
    });
    assert.equal(nextDuringRefresh.status, 503);
    assert.equal(approveDuringRefresh.status, 503);
    assert.deepEqual(queueCalls, []);

    releaseRefresh.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reconcileCalls, 2);
    await reconcileStarted.promise;
    const nextDuringAgency = await request(server, {
      path: "/api/confirmations/next",
    });
    assert.equal(nextDuringAgency.status, 200);
    assert.deepEqual(queueCalls, ["next"]);

    releaseReconcile.resolve();
    const cycleResult = await cycle;
    if (trigger === "manual") assert.equal(cycleResult.status, 200);
    const reopened = await request(server, {
      path: "/api/confirmations/next",
    });
    assert.equal(reopened.status, 200);
    assert.deepEqual(queueCalls, ["next", "next"]);
  } finally {
    releaseRefresh.resolve();
    releaseReconcile.resolve();
    await Promise.resolve(cycle).catch(() => {});
    await server.shutdown();
  }
}

async function withServer(
  run,
  {
    legacyOnly = false,
    confirmationQueueEnabled = true,
    onClose,
    onDashboardRead,
    backgroundWork,
    workflowRouting,
    workLedgerView,
    attentionCoordinator,
    attentionBrowser,
  } = {},
) {
  const calls = [];
  const reportedErrors = [];
  const dashboard = {
    meta: { refreshedAt: "2026-07-31T09:00:00.000Z" },
    secretMarker: "private-dashboard-data",
  };
  const prEmployee = {
    id: "pr-reviewer",
    running: null,
    async view() {
      return {
        role: {
          id: "pr-reviewer",
          name: "PR 推进员工",
          state: "observing",
          revision: 4,
          paused: true,
          enabled: true,
        },
        jobs: [],
        confirmationQueue: [],
      };
    },
    async roleView() {
      return (await this.view()).role;
    },
    async run(options) {
      calls.push({ operation: "employee_tick", ...options });
      return this.view();
    },
    async tick(options) {
      return this.run(options);
    },
    async control(command, expectedRevision) {
      calls.push({ operation: "employee_control", command, expectedRevision });
      return this.view();
    },
    async decide(id, decision, options) {
      calls.push({ operation: "employee_decide", id, decision, ...options });
      return this.view();
    },
    async searchMemory(query, limit) {
      calls.push({ operation: "memory_search", query, limit });
      return [{ id: "memory-1", title: "Checkout review" }];
    },
    async recordConfirmationOutcome(item) {
      calls.push({ operation: "employee_confirmation_outcome", item });
    },
  };
  const requirementsAnalyst = {
    id: "requirements-analyst",
    async view() {
      return {
        role: {
          id: this.id,
          name: "需求分析员工",
          state: "observing",
          revision: 2,
        },
        jobs: [],
        confirmationQueue: [],
      };
    },
    async roleView() {
      return (await this.view()).role;
    },
    async run(options) {
      calls.push({ operation: "analyst_tick", ...options });
      return this.view();
    },
    async control(command, expectedRevision) {
      calls.push({ operation: "analyst_control", command, expectedRevision });
      return this.view();
    },
  };
  const application = {
    config: {
      port: 4173,
      refreshMinutes: 10,
      githubActions: { enabled: false },
    },
    store: {
      async read() {
        if (onDashboardRead) return onDashboardRead();
        return dashboard;
      },
    },
    refreshService: {
      running: null,
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
        return { dashboard };
      },
      async confirmPullRequestResponsibility(id, actionState, headRefOid) {
        calls.push({ operation: "confirm", id, actionState, headRefOid });
        return dashboard;
      },
    },
    prEmployee,
    ...(typeof onClose === "function" ? { close: onClose } : {}),
  };
  if (confirmationQueueEnabled) {
    const confirmationItem = {
      id: "confirmation-pr-work-1",
      kind: "github.pull-request-review",
      status: "pending",
      queueRevision: 8,
      itemRevision: 2,
      requestedBy: { roleId: "pr-reviewer", workItemId: "pr-work-1" },
      actor: { provider: "github", accountId: "review-account" },
      target: {
        provider: "github",
        resourceId: "acme/repo#7",
        version: "a".repeat(40),
      },
      display: {
        title: "acme/repo #7 · Checkout",
        summary: "Ready to publish",
        actionLabel: "确认并发布到 GitHub",
        evidence: ["Head 已复核"],
        payload: {
          actor: { provider: "github", accountId: "review-account" },
          target: {
            provider: "github",
            resourceId: "acme/repo#7",
            version: "a".repeat(40),
          },
          action: {
            type: "pull_request_review",
            reviewEvent: "APPROVE",
            body: "Looks good.",
          },
        },
      },
      displayedPayloadDigest: "b".repeat(64),
      approvalBindingDigest: "c".repeat(64),
      retryable: false,
    };
    application.confirmationQueue = {
      async next() {
        calls.push({ operation: "confirmation_next" });
        return {
          queueRevision: 8,
          pendingCount: 1,
          item: structuredClone(confirmationItem),
        };
      },
      async approve(id, input) {
        calls.push({ operation: "confirmation_approve", id, input });
        return { ...structuredClone(confirmationItem), status: "completed" };
      },
      async retry(id, input) {
        calls.push({ operation: "confirmation_retry", id, input });
        return { ...structuredClone(confirmationItem), status: "completed" };
      },
      async reject(id, input) {
        calls.push({ operation: "confirmation_reject", id, input });
        return { ...structuredClone(confirmationItem), status: "rejected" };
      },
    };
  }
  if (!legacyOnly) {
    application.employeeRegistry = new EmployeeRegistry([
      prEmployee,
      requirementsAnalyst,
    ]);
  }
  if (workflowRouting) {
    application.workflowRouting =
      typeof workflowRouting === "function"
        ? workflowRouting(calls)
        : workflowRouting;
  }
  if (workLedgerView) application.workLedgerView = workLedgerView;
  if (attentionCoordinator) {
    application.attentionCoordinator = attentionCoordinator;
  }
  if (attentionBrowser) application.attentionBrowser = attentionBrowser;
  const server = createDashboardServer(application, {
    backgroundWork,
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ server, calls, reportedErrors });
  } finally {
    await server.shutdown();
  }
}

test("background work runs every registered employee after the initial refresh and on schedule", async () => {
  const calls = [];
  const timers = [];
  const clearedTimers = [];
  const employeeRegistry = {
    async runAll(options) {
      calls.push({ operation: "run_all", ...options });
    },
    schedules() {
      return [
        { id: "pr-reviewer", intervalMinutes: 3 },
        { id: "requirements-analyst", intervalMinutes: 11 },
      ];
    },
    async run(id, options) {
      calls.push({ operation: "run", id, ...options });
    },
  };
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry,
    refreshService: {
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
      },
    },
  };
  const setIntervalFn = (callback, milliseconds) => {
    const timer = {
      callback,
      milliseconds,
      unreferenced: false,
      unref() {
        this.unreferenced = true;
      },
    };
    timers.push(timer);
    return timer;
  };

  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn,
    clearIntervalFn(timer) {
      clearedTimers.push(timer);
    },
  });
  await backgroundWork.initialRefresh;

  assert.deepEqual(calls, [
    { operation: "refresh", notify: false },
    { operation: "run_all", trigger: "refresh_completed" },
  ]);
  assert.deepEqual(
    timers.map((timer) => timer.milliseconds),
    [7 * 60_000, 3 * 60_000, 11 * 60_000],
  );
  assert.equal(timers.every((timer) => timer.unreferenced), true);

  for (const timer of timers) await timer.callback();

  assert.deepEqual(calls.slice(2), [
    { operation: "refresh", notify: false },
    { operation: "run_all", trigger: "refresh_completed" },
    { operation: "run", id: "pr-reviewer", trigger: "scheduled" },
    {
      operation: "run",
      id: "requirements-analyst",
      trigger: "scheduled",
    },
  ]);

  await backgroundWork.stop();
  assert.deepEqual(clearedTimers, timers);

  const callsAfterStop = structuredClone(calls);
  for (const timer of timers) await timer.callback();
  assert.deepEqual(calls, callsAfterStop);
});

test("workflow routing observes every refreshed snapshot before confirmations and employees", async () => {
  const calls = [];
  const timers = [];
  let snapshot = null;
  let refreshNumber = 0;
  let backgroundWork;
  const application = {
    config: { refreshMinutes: 7 },
    store: {
      async read(name) {
        return name === "snapshot" ? structuredClone(snapshot) : null;
      },
    },
    refreshService: {
      async refresh(options) {
        refreshNumber += 1;
        snapshot = {
          cycle: refreshNumber,
          sourceStatus: { githubPullRequests: { ok: true } },
        };
        calls.push({ operation: "refresh", cycle: refreshNumber, ...options });
      },
    },
    workflowRouting: {
      async ingestSnapshot({ snapshot: routedSnapshot }) {
        assert.equal(backgroundWork.confirmationReady(), false);
        calls.push({ operation: "route", cycle: routedSnapshot.cycle });
      },
    },
    employeeRegistry: {
      get(id) {
        if (id !== "pr-reviewer") return null;
        return {
          async recoverConfirmations() {
            assert.equal(backgroundWork.confirmationReady(), false);
            calls.push({ operation: "recover", cycle: snapshot.cycle });
          },
        };
      },
      schedules() {
        return [];
      },
      async runAll(options) {
        assert.equal(backgroundWork.confirmationReady(), true);
        calls.push({ operation: "run_all", cycle: snapshot.cycle, ...options });
      },
    },
    confirmationQueue: {},
  };

  backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    assert.equal(backgroundWork.confirmationReady(), true);

    await timers[0].callback();
    assert.equal(backgroundWork.confirmationReady(), true);

    await backgroundWork.refresh({ notify: true });
    assert.equal(backgroundWork.confirmationReady(), true);

    assert.deepEqual(calls, [
      { operation: "refresh", cycle: 1, notify: false },
      { operation: "route", cycle: 1 },
      { operation: "recover", cycle: 1 },
      { operation: "run_all", cycle: 1, trigger: "refresh_completed" },
      { operation: "refresh", cycle: 2, notify: false },
      { operation: "route", cycle: 2 },
      { operation: "recover", cycle: 2 },
      { operation: "run_all", cycle: 2, trigger: "refresh_completed" },
      { operation: "refresh", cycle: 3, notify: true },
      { operation: "route", cycle: 3 },
      { operation: "recover", cycle: 3 },
      { operation: "run_all", cycle: 3, trigger: "refresh_completed" },
    ]);
  } finally {
    await backgroundWork.stop();
  }
});

test("workflow routing failure keeps confirmations closed and skips employees", async () => {
  const calls = [];
  const timers = [];
  const reportedErrors = [];
  const routingFailure = new Error("workflow routing failed");
  let snapshot = null;
  let refreshNumber = 0;
  let routingCalls = 0;
  const application = {
    config: { refreshMinutes: 7 },
    store: {
      async read(name) {
        return name === "snapshot" ? structuredClone(snapshot) : null;
      },
    },
    refreshService: {
      async refresh(options) {
        refreshNumber += 1;
        snapshot = {
          cycle: refreshNumber,
          sourceStatus: { githubPullRequests: { ok: true } },
        };
        calls.push({ operation: "refresh", cycle: refreshNumber, ...options });
      },
    },
    workflowRouting: {
      async ingestSnapshot({ snapshot: routedSnapshot }) {
        routingCalls += 1;
        calls.push({ operation: "route", cycle: routedSnapshot.cycle });
        if (routingCalls > 1) throw routingFailure;
      },
    },
    employeeRegistry: {
      get(id) {
        if (id !== "pr-reviewer") return null;
        return {
          async recoverConfirmations() {
            calls.push({ operation: "recover", cycle: snapshot.cycle });
          },
        };
      },
      schedules() {
        return [];
      },
      async runAll(options) {
        calls.push({ operation: "run_all", cycle: snapshot.cycle, ...options });
      },
    },
    confirmationQueue: {},
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
    reportError(error) {
      reportedErrors.push(error);
    },
  });

  try {
    await backgroundWork.initialRefresh;
    assert.equal(backgroundWork.confirmationReady(), true);

    await timers[0].callback();
    assert.equal(backgroundWork.confirmationReady(), false);

    await assert.rejects(
      backgroundWork.refresh({ notify: true }),
      (error) => error === routingFailure,
    );
    assert.equal(backgroundWork.confirmationReady(), false);

    assert.deepEqual(calls, [
      { operation: "refresh", cycle: 1, notify: false },
      { operation: "route", cycle: 1 },
      { operation: "recover", cycle: 1 },
      { operation: "run_all", cycle: 1, trigger: "refresh_completed" },
      { operation: "refresh", cycle: 2, notify: false },
      { operation: "route", cycle: 2 },
      { operation: "refresh", cycle: 3, notify: true },
      { operation: "route", cycle: 3 },
    ]);
    assert.deepEqual(reportedErrors, [routingFailure, routingFailure]);
  } finally {
    await backgroundWork.stop();
  }
});

test("background stop waits for initial refresh and suppresses its employee callback", async () => {
  let finishRefresh;
  let refreshStarted;
  const started = new Promise((resolve) => {
    refreshStarted = resolve;
  });
  const calls = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [];
      },
      async runAll(options) {
        calls.push({ operation: "run_all", ...options });
      },
    },
    refreshService: {
      async refresh(options) {
        calls.push({ operation: "refresh", ...options });
        refreshStarted();
        await new Promise((resolve) => {
          finishRefresh = resolve;
        });
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application);
  await started;

  let stopped = false;
  const stopping = backgroundWork.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  finishRefresh();
  await stopping;
  assert.deepEqual(calls, [{ operation: "refresh", notify: false }]);
});

test("background stop waits for a tracked scheduled task", async () => {
  let finishScheduledRun;
  let scheduledRunStarted;
  const started = new Promise((resolve) => {
    scheduledRunStarted = resolve;
  });
  const timers = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [{ id: "pr-reviewer", intervalMinutes: 3 }];
      },
      async runAll() {},
      async run() {
        scheduledRunStarted();
        await new Promise((resolve) => {
          finishScheduledRun = resolve;
        });
      },
    },
    refreshService: {
      async refresh() {},
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn(callback) {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn() {},
  });
  await backgroundWork.initialRefresh;

  const scheduledRun = timers[1].callback();
  await started;
  let stopped = false;
  const stopping = backgroundWork.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  finishScheduledRun();
  await Promise.all([scheduledRun, stopping]);
  assert.equal(stopped, true);
});

test("periodic refresh fences facts but reopens confirmations before slow agency", async () => {
  await exerciseConfirmationRefreshGate("periodic");
});

test("manual refresh fences facts but reopens confirmations before slow agency", async () => {
  await exerciseConfirmationRefreshGate("manual");
});

test("an unhealthy GitHub PR refresh keeps confirmation APIs closed", async () => {
  const queueCalls = [];
  const application = startupApplication({
    port: 4173,
    queueCalls,
    async refresh() {
      return {
        dashboard: {
          sourceStatus: {
            githubPullRequests: {
              ok: false,
              stale: true,
              error: "GitHub unavailable",
            },
          },
          items: [],
        },
      };
    },
  });
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn() {
      return { unref() {} };
    },
    clearIntervalFn() {},
  });
  await backgroundWork.initialRefresh;
  const server = createDashboardServer(application, {
    backgroundWork,
    reportError() {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const next = await request(server, { path: "/api/confirmations/next" });
    const approve = await request(server, {
      method: "POST",
      path: `/api/confirmations/${pendingConfirmationItem().id}/approve`,
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(confirmationApprovalRequest()),
    });

    assert.equal(next.status, 503);
    assert.equal(approve.status, 503);
    assert.deepEqual(queueCalls, []);
  } finally {
    await server.shutdown();
  }
});

test("server rejects an untrusted Host before exposing local data", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, {
      path: "/api/dashboard",
      headers: { host: "evil.example:4173" },
    });

    assert.equal(response.status, 421);
    assert.equal(response.body.includes("private-dashboard-data"), false);
  });
});

test("5xx responses hide internal details while 4xx responses stay actionable", async () => {
  const privatePath = "D:\\private\\runtime\\confirmation-store.json";
  await withServer(
    async ({ server, reportedErrors }) => {
      const internalFailure = await request(server, {
        path: "/api/dashboard",
      });
      const clientFailure = await request(server, {
        path: "/api/dashboard",
        headers: { host: "evil.example:4173" },
      });

      assert.equal(internalFailure.status, 500);
      assert.deepEqual(JSON.parse(internalFailure.body), {
        error: "服务器内部错误",
      });
      assert.equal(internalFailure.body.includes(privatePath), false);
      assert.equal(reportedErrors.length, 1);
      assert.match(reportedErrors[0].message, /cannot open/);
      assert.match(reportedErrors[0].message, /confirmation-store\.json/);
      assert.equal(clientFailure.status, 421);
      assert.deepEqual(JSON.parse(clientFailure.body), {
        error: "请求 Host 不属于本地指挥中枢",
      });
    },
    {
      onDashboardRead() {
        throw new Error(`cannot open ${privatePath}`);
      },
    },
  );
});

test("the local UI cannot be framed by another site", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server);

    assert.equal(response.status, 200);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(
      response.headers["content-security-policy"],
      /frame-ancestors 'none'/,
    );
  });
});

test("write endpoints require same-origin action headers and JSON", async () => {
  await withServer(async ({ server, calls }) => {
    const crossOrigin = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
      },
    });
    const missingActionHeader = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: { origin: "http://127.0.0.1:4173" },
    });
    const plainText = await request(server, {
      method: "POST",
      path: "/api/pr-responsibility/confirm",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "text/plain",
      },
      body: JSON.stringify({
        id: "github:pr:acme/repo#7",
        actionState: "historical",
        headRefOid: "head-1",
      }),
    });

    assert.equal(crossOrigin.status, 403);
    assert.equal(missingActionHeader.status, 403);
    assert.equal(plainText.status, 415);
    assert.deepEqual(calls, []);
  });
});

test("workflow read APIs expose routing and forward only pagination filters", async () => {
  const routing = {
    current: {
      version: 3,
      digest: "routing-digest",
      definition: { enabled: true, rules: [] },
    },
    history: [],
  };
  const assignments = {
    items: [{ assignmentId: "assignment-1", target: { type: "role", id: "pr-reviewer" } }],
    nextCursor: "assignment-next",
  };
  const audit = {
    items: [{ auditId: "audit-1", outcome: "assigned" }],
    nextCursor: "audit-next",
  };

  await withServer(
    async ({ server, calls }) => {
      const routingResponse = await request(server, {
        path: "/api/workflow/routing",
      });
      const assignmentsResponse = await request(server, {
        path: "/api/workflow/assignments?limit=17&cursor=assignment%3Apage%2B2&ignored=1",
      });
      const auditResponse = await request(server, {
        path: "/api/workflow/audit?limit=9&cursor=audit%3Apage%2F2&ignored=1",
      });

      assert.equal(routingResponse.status, 200);
      assert.deepEqual(JSON.parse(routingResponse.body), routing);
      assert.equal(assignmentsResponse.status, 200);
      assert.deepEqual(JSON.parse(assignmentsResponse.body), assignments);
      assert.equal(auditResponse.status, 200);
      assert.deepEqual(JSON.parse(auditResponse.body), audit);
      assert.deepEqual(calls, [
        { operation: "workflow_get_config" },
        {
          operation: "workflow_list_assignments",
          options: { limit: "17", cursor: "assignment:page+2" },
        },
        {
          operation: "workflow_list_audit",
          options: { limit: "9", cursor: "audit:page/2" },
        },
      ]);
    },
    {
      workflowRouting(calls) {
        return {
          async getConfig() {
            calls.push({ operation: "workflow_get_config" });
            return routing;
          },
          async dryRun() {
            throw new Error("unexpected dry-run");
          },
          async listAssignments(options) {
            calls.push({ operation: "workflow_list_assignments", options });
            return assignments;
          },
          async listAudit(options) {
            calls.push({ operation: "workflow_list_audit", options });
            return audit;
          },
        };
      },
    },
  );
});

test("workflow dry-run is same-origin JSON and forwards only event and definition", async () => {
  const event = {
    eventId: "workflow-event-1",
    eventType: "pr.updated",
    source: "github",
  };
  const definition = { enabled: true, rules: [] };
  const explanation = {
    ruleOrder: [],
    usedFallback: false,
    rules: [],
  };
  const body = JSON.stringify({
    event,
    definition,
    context: { visitedNodes: ["root"] },
    changedBy: "browser-user",
    dispatch: true,
  });

  await withServer(
    async ({ server, calls }) => {
      const crossOrigin = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "https://evil.example",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const missingActionHeader = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "http://127.0.0.1:4173",
          "content-type": "application/json",
        },
        body,
      });
      const plainText = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "text/plain",
        },
        body,
      });
      const trusted = await request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json; charset=utf-8",
        },
        body,
      });

      assert.equal(crossOrigin.status, 403);
      assert.equal(missingActionHeader.status, 403);
      assert.equal(plainText.status, 415);
      assert.equal(trusted.status, 200);
      assert.deepEqual(JSON.parse(trusted.body), {
        dryRun: true,
        persisted: false,
        assignments: [],
        explanation,
      });
      assert.deepEqual(calls, [
        {
          operation: "workflow_dry_run",
          input: { event, definition },
        },
      ]);
    },
    {
      workflowRouting(calls) {
        return {
          async getConfig() {
            throw new Error("unexpected config read");
          },
          async dryRun(input) {
            calls.push({ operation: "workflow_dry_run", input });
            return {
              dryRun: true,
              persisted: false,
              assignments: [],
              explanation,
            };
          },
          async listAssignments() {
            throw new Error("unexpected assignment read");
          },
          async listAudit() {
            throw new Error("unexpected audit read");
          },
        };
      },
    },
  );
});

test("workflow API exposes no config replacement or dispatch mutation", async () => {
  await withServer(
    async ({ server, calls }) => {
      const headers = {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      };
      const responses = await Promise.all(
        ["/api/workflow/routing", "/api/workflow/dispatch"].map((path) =>
          request(server, {
            method: "POST",
            path,
            headers,
            body: JSON.stringify({ definition: {}, event: {} }),
          }),
        ),
      );

      assert.deepEqual(
        responses.map((response) => response.status),
        [404, 404],
      );
      assert.deepEqual(calls, []);
    },
    {
      workflowRouting(calls) {
        const unexpectedMutation = (operation) => async (input) => {
          calls.push({ operation, input });
        };
        return {
          async getConfig() {
            return { current: null, history: [] };
          },
          async dryRun() {
            return { dryRun: true, persisted: false };
          },
          async listAssignments() {
            return { items: [], nextCursor: null };
          },
          async listAudit() {
            return { items: [], nextCursor: null };
          },
          replaceConfig: unexpectedMutation("workflow_replace_config"),
          ingest: unexpectedMutation("workflow_dispatch"),
        };
      },
    },
  );
});

test("workflow APIs fail closed when routing is unavailable", async () => {
  await withServer(async ({ server }) => {
    const trustedHeaders = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const responses = await Promise.all([
      request(server, { path: "/api/workflow/routing" }),
      request(server, { path: "/api/workflow/assignments" }),
      request(server, { path: "/api/workflow/audit" }),
      request(server, {
        method: "POST",
        path: "/api/workflow/dry-run",
        headers: trustedHeaders,
        body: JSON.stringify({ event: {} }),
      }),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status),
      [503, 503, 503, 503],
    );
  });
});

test("work APIs expose only newest-first ledger projections", async () => {
  const calls = [];
  const workLedgerView = {
    async getSummary() {
      calls.push({ operation: "summary" });
      return { revision: 7, itemCounts: { queued: 3 } };
    },
    async listItems(options) {
      calls.push({ operation: "items", options });
      return { items: [{ itemId: "work-1" }], nextCursor: null };
    },
    async listTimeline(options) {
      calls.push({ operation: "timeline", options });
      return { items: [{ timelineId: "timeline-1" }], nextCursor: null };
    },
  };

  await withServer(
    async ({ server }) => {
      const summary = await request(server, { path: "/api/work/summary" });
      const items = await request(server, {
        path: "/api/work/items?limit=17&cursor=item%3A2&status=queued&order=newest&ignored=1",
      });
      const timeline = await request(server, {
        path: "/api/work/timeline?limit=9&cursor=timeline%3A2&order=newest&status=blocked",
      });

      assert.equal(summary.status, 200);
      assert.deepEqual(JSON.parse(summary.body), {
        revision: 7,
        itemCounts: { queued: 3 },
        safeguards: {
          prEmployeePaused: true,
          externalActionsEnabled: false,
        },
      });
      assert.deepEqual(JSON.parse(items.body), {
        items: [{ itemId: "work-1" }],
        nextCursor: null,
      });
      assert.deepEqual(JSON.parse(timeline.body), {
        items: [{ timelineId: "timeline-1" }],
        nextCursor: null,
      });
      assert.deepEqual(calls, [
        { operation: "summary" },
        {
          operation: "items",
          options: {
            limit: "17",
            cursor: "item:2",
            status: "queued",
            order: "newest",
          },
        },
        {
          operation: "timeline",
          options: {
            limit: "9",
            cursor: "timeline:2",
            order: "newest",
          },
        },
      ]);
    },
    { workLedgerView },
  );
});

test("work HTTP boundary exposes no intake, claim, stage, dispatch, or outbox", async () => {
  await withServer(
    async ({ server, calls }) => {
      const headers = {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      };
      const responses = await Promise.all(
        ["intake", "claim", "stage", "dispatch", "outbox"].map((name) =>
          request(server, {
            method: "POST",
            path: `/api/work/${name}`,
            headers,
            body: JSON.stringify({ itemId: "work-1" }),
          }),
        ),
      );

      assert.deepEqual(responses.map(({ status }) => status), [404, 404, 404, 404, 404]);
      assert.deepEqual(calls, []);
    },
    {
      workLedgerView: {
        async getSummary() {},
        async listItems() {},
        async listTimeline() {},
        async intake() { throw new Error("must remain private"); },
        async claim() { throw new Error("must remain private"); },
      },
    },
  );
});

test("work APIs fail closed when the ledger projection is unavailable", async () => {
  await withServer(async ({ server }) => {
    const responses = await Promise.all([
      request(server, { path: "/api/work/summary" }),
      request(server, { path: "/api/work/items" }),
      request(server, { path: "/api/work/timeline" }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status), [503, 503, 503]);
  });
});

test("unified attention read projects external authorization without exposing actions", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, { path: "/api/attention/next" });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.available, true);
    assert.equal(body.source, "external_confirmation");
    assert.equal(body.externalEnabled, true);
    assert.equal(body.externalQueueRevision, 8);
    assert.equal(body.item.id, "confirmation-pr-work-1");
    assert.deepEqual(calls, [{ operation: "confirmation_next" }]);
  });
});

test("internal attention mutations are source-bound and only signal background work", async () => {
  const requestId = `attention-${"a".repeat(64)}`;
  const digest = "b".repeat(64);
  const calls = [];
  const attentionBrowser = Object.fromEntries(
    ["answer", "reject", "later"].map((operation) => [
      operation,
      async (input) => {
        calls.push({ operation, input });
        return {
          requestId,
          contentDigest: digest,
          status: operation === "later" ? "pending" : operation === "reject" ? "rejected" : "answered",
          revision: operation === "later" ? 3 : 4,
        };
      },
    ]),
  );
  const backgroundWork = {
    runConfirmationOperation(operation) { return operation(); },
    signalAgency(options) { calls.push({ operation: "signal", options }); },
  };
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };

  await withServer(
    async ({ server }) => {
      const answer = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/answer`,
        headers,
        body: JSON.stringify({
          expectedRevision: 3,
          contentDigest: digest,
          answer: { type: "text", text: "按最近一年迁移" },
        }),
      });
      const reject = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/reject`,
        headers,
        body: JSON.stringify({
          expectedRevision: 3,
          contentDigest: digest,
          answer: { type: "reject", reason: "缺少上下文" },
        }),
      });
      const later = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/later`,
        headers,
        body: JSON.stringify({
          expectedRevision: 3,
          contentDigest: digest,
          answer: { type: "later" },
        }),
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual([answer.status, reject.status, later.status], [200, 200, 200]);
      assert.deepEqual(calls, [
        {
          operation: "answer",
          input: {
            expectedRevision: 3,
            contentDigest: digest,
            answer: { type: "text", text: "按最近一年迁移" },
            requestId,
          },
        },
        { operation: "signal", options: { trigger: "user_answered" } },
        {
          operation: "reject",
          input: {
            expectedRevision: 3,
            contentDigest: digest,
            answer: { type: "reject", reason: "缺少上下文" },
            requestId,
          },
        },
        { operation: "signal", options: { trigger: "user_answered" } },
        {
          operation: "later",
          input: {
            expectedRevision: 3,
            contentDigest: digest,
            answer: { type: "later" },
            requestId,
          },
        },
      ]);
    },
    { attentionBrowser, backgroundWork },
  );
});

test("internal attention rejects untrusted callers and body-supplied request ids", async () => {
  const requestId = `attention-${"a".repeat(64)}`;
  const body = JSON.stringify({
    requestId,
    expectedRevision: 3,
    contentDigest: "b".repeat(64),
    answer: { type: "later" },
  });
  let browserCalls = 0;
  await withServer(
    async ({ server }) => {
      const crossOrigin = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/later`,
        headers: {
          origin: "https://evil.example",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const suppliedId = await request(server, {
        method: "POST",
        path: `/api/attention/internal/${requestId}/later`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const wrongNamespace = await request(server, {
        method: "POST",
        path: `/api/confirmations/${requestId}/answer`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });

      assert.deepEqual(
        [crossOrigin.status, suppliedId.status, wrongNamespace.status],
        [403, 400, 404],
      );
      assert.equal(browserCalls, 0);
    },
    {
      attentionBrowser: {
        async answer() { browserCalls += 1; },
        async reject() { browserCalls += 1; },
        async later() { browserCalls += 1; },
      },
    },
  );
});

test("the confirmation API exposes only the next immutable projection", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      path: "/api/confirmations/next",
    });

    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.available, true);
    assert.equal(body.pendingCount, 1);
    assert.equal(body.item.id, "confirmation-pr-work-1");
    assert.equal(body.item.display.payload.action.body, "Looks good.");
    assert.equal("action" in body.item, false);
    assert.deepEqual(calls, [{ operation: "confirmation_next" }]);
  });
});

test("confirmation mutations forward only bound requests and sync the employee", async () => {
  await withServer(async ({ server, calls }) => {
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const binding = {
      requestId: "request-confirmation-0001",
      expectedQueueRevision: 8,
      expectedItemRevision: 2,
      displayedPayloadDigest: "b".repeat(64),
      approvalBindingDigest: "c".repeat(64),
    };

    for (const operation of ["approve", "retry", "reject"]) {
      const response = await request(server, {
        method: "POST",
        path: `/api/confirmations/confirmation-pr-work-1/${operation}`,
        headers,
        body: JSON.stringify(
          operation === "reject" ? { ...binding, reason: "暂不发布" } : binding,
        ),
      });
      assert.equal(response.status, 200);
      const result = JSON.parse(response.body);
      assert.equal(result.item.status, operation === "reject" ? "rejected" : "completed");
      assert.equal(result.next.pendingCount, 1);
      assert.equal(result.employeeSyncPending, false);
    }

    for (const operation of ["approve", "retry", "reject"]) {
      const call = calls.find(
        (candidate) => candidate.operation === `confirmation_${operation}`,
      );
      assert.equal(call.id, "confirmation-pr-work-1");
      assert.deepEqual(
        call.input,
        operation === "reject" ? { ...binding, reason: "暂不发布" } : binding,
      );
    }
    assert.equal(
      calls.filter((call) => call.operation === "employee_confirmation_outcome")
        .length,
      3,
    );
  });
});

test("confirmation writes reject untrusted callers and expose no enqueue route", async () => {
  await withServer(async ({ server, calls }) => {
    const body = JSON.stringify({ requestId: "request-confirmation-0001" });
    const crossOrigin = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-pr-work-1/approve",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body,
    });
    const wrongType = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-pr-work-1/reject",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "text/plain",
      },
      body,
    });
    const enqueue = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-pr-work-1/enqueue",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body,
    });

    assert.equal(crossOrigin.status, 403);
    assert.equal(wrongType.status, 415);
    assert.equal(enqueue.status, 404);
    assert.equal(
      calls.some((call) => call.operation.startsWith("confirmation_")),
      false,
    );
  });
});

test("disabled external actions expose an empty read view and reject writes", async () => {
  await withServer(
    async ({ server }) => {
      const next = await request(server, { path: "/api/confirmations/next" });
      const approve = await request(server, {
        method: "POST",
        path: "/api/confirmations/confirmation-pr-work-1/approve",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestId: "request-confirmation-0001" }),
      });

      assert.deepEqual(JSON.parse(next.body), {
        available: false,
        queueRevision: 0,
        pendingCount: 0,
        item: null,
      });
      assert.equal(approve.status, 503);
    },
    { confirmationQueueEnabled: false },
  );
});

test("closing the HTTP server releases application-owned runtimes", async () => {
  let closed = 0;
  await withServer(
    async ({ server }) => {
      await server.shutdown();
    },
    {
      onClose() {
        closed += 1;
      },
    },
  );
  assert.equal(closed, 1);
});

test("awaited shutdown releases a delayed runtime before an immediate restart", async () => {
  let applicationNumber = 0;
  let runtimeHeld = false;
  let releaseFirstClose;
  let firstCloseStarted;
  const closeStarted = new Promise((resolve) => {
    firstCloseStarted = resolve;
  });
  const createApplicationFn = async () => {
    if (runtimeHeld) throw new Error("runtime lock still held");
    runtimeHeld = true;
    applicationNumber += 1;
    const currentApplication = applicationNumber;
    return {
      config: { port: 0, refreshMinutes: 10 },
      store: {
        async read() {
          return null;
        },
      },
      refreshService: {
        running: null,
        async refresh() {},
      },
      employeeRegistry: {
        get() {
          return null;
        },
        async listRoles() {
          return [];
        },
        schedules() {
          return [];
        },
        async runAll() {},
      },
      async close() {
        if (currentApplication === 1) {
          firstCloseStarted();
          await new Promise((resolve) => {
            releaseFirstClose = resolve;
          });
        }
        runtimeHeld = false;
      },
    };
  };
  const options = { createApplicationFn, log() {} };

  const firstServer = await startDashboardServer(options);
  assert.equal(firstServer instanceof http.Server, true);
  assert.equal(typeof firstServer.shutdown, "function");

  let shutdownFinished = false;
  const stopping = firstServer.shutdown().then(() => {
    shutdownFinished = true;
  });
  await closeStarted;
  assert.equal(shutdownFinished, false);
  await assert.rejects(
    () => startDashboardServer(options),
    /runtime lock still held/,
  );

  releaseFirstClose();
  await stopping;
  const restartedServer = await startDashboardServer(options);
  await restartedServer.shutdown();
  assert.equal(runtimeHeld, false);
});

test("startup does not listen until the first GitHub refresh and employee reconcile finish", async () => {
  const port = await availablePort();
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const reconcileStarted = deferred();
  const releaseReconcile = deferred();
  const queueCalls = [];
  let runAllCalls = 0;
  const application = startupApplication({
    port,
    queueCalls,
    async refresh() {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      return healthyRefreshResult();
    },
    async recoverConfirmations() {
      reconcileStarted.resolve();
      await releaseReconcile.promise;
    },
    async runAll(options) {
      runAllCalls += 1;
      assert.deepEqual(options, { trigger: "refresh_completed" });
    },
  });
  let server = null;
  let startupSettled = false;
  const starting = startDashboardServer({
    createApplicationFn: async () => application,
    log() {},
  }).then(
    (startedServer) => {
      startupSettled = true;
      server = startedServer;
      return startedServer;
    },
    (error) => {
      startupSettled = true;
      throw error;
    },
  );

  try {
    await refreshStarted.promise;
    assert.equal(startupSettled, false);
    await assert.rejects(
      requestPort(port, { path: "/api/confirmations/next" }),
      (error) => error.code === "ECONNREFUSED",
    );

    releaseRefresh.resolve();
    await reconcileStarted.promise;
    assert.equal(startupSettled, false);
    await assert.rejects(
      requestPort(port, { path: "/api/confirmations/next" }),
      (error) => error.code === "ECONNREFUSED",
    );

    releaseReconcile.resolve();
    server = await starting;
    const confirmation = await requestPort(port, {
      path: "/api/confirmations/next",
    });
    assert.equal(confirmation.status, 200);
    assert.equal(JSON.parse(confirmation.body).pendingCount, 1);
    assert.deepEqual(queueCalls, ["next"]);
    assert.equal(runAllCalls, 1);
  } finally {
    releaseRefresh.resolve();
    releaseReconcile.resolve();
    if (!server) server = await starting.catch(() => null);
    if (server) await server.shutdown();
  }
});

test("initial refresh failure aborts listen and releases background and application resources", async () => {
  const port = await availablePort();
  const refreshFailure = new Error("initial GitHub refresh failed");
  const initialRefresh = Promise.reject(refreshFailure);
  initialRefresh.catch(() => {});
  let backgroundStops = 0;
  let applicationCloses = 0;
  const application = startupApplication({
    port,
    async close() {
      applicationCloses += 1;
    },
  });
  const starting = startDashboardServer({
    createApplicationFn: async () => application,
    startBackgroundWorkFn() {
      return {
        initialRefresh,
        async stop() {
          backgroundStops += 1;
        },
      };
    },
    log() {},
  });
  let server = null;

  try {
    await assert.rejects(starting, (error) => error === refreshFailure);
  } finally {
    server = await starting.catch(() => null);
    if (server) await server.shutdown();
  }

  assert.equal(backgroundStops, 1);
  assert.equal(applicationCloses, 1);
  await assert.rejects(
    requestPort(port, { path: "/api/confirmations/next" }),
    (error) => error.code === "ECONNREFUSED",
  );
});

test("same-origin UI requests can refresh and confirm the displayed head", async () => {
  await withServer(async ({ server, calls }) => {
    const trustedHeaders = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
    };
    const refresh = await request(server, {
      method: "POST",
      path: "/api/refresh",
      headers: trustedHeaders,
    });
    const confirm = await request(server, {
      method: "POST",
      path: "/api/pr-responsibility/confirm",
      headers: {
        ...trustedHeaders,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        id: "github:pr:acme/repo#7",
        actionState: "waiting_other",
        headRefOid: "head-7",
      }),
    });

    assert.equal(refresh.status, 200);
    assert.equal(confirm.status, 200);
    assert.deepEqual(calls, [
      { operation: "refresh", notify: false },
      {
        operation: "confirm",
        id: "github:pr:acme/repo#7",
        actionState: "waiting_other",
        headRefOid: "head-7",
      },
    ]);
  });
});

test("responsibility confirmation is routed through the fact-cycle gate", async () => {
  const gateCalls = [];
  await withServer(
    async ({ server, calls }) => {
      const response = await request(server, {
        method: "POST",
        path: "/api/pr-responsibility/confirm",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          id: "github:pr:acme/repo#7",
          actionState: "waiting_other",
          headRefOid: "head-7",
        }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(gateCalls, ["entered", "completed"]);
      assert.deepEqual(calls, [
        {
          operation: "confirm",
          id: "github:pr:acme/repo#7",
          actionState: "waiting_other",
          headRefOid: "head-7",
        },
      ]);
    },
    {
      backgroundWork: {
        async mutateFacts(operation) {
          gateCalls.push("entered");
          const result = await operation();
          gateCalls.push("completed");
          return result;
        },
      },
    },
  );
});

test("the scheduled service path can request notification delivery", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      method: "POST",
      path: "/api/refresh?notify=1",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ operation: "refresh", notify: true }]);
  });
});

test("dashboard and health expose the proactive employee without changing stored data", async () => {
  await withServer(async ({ server }) => {
    const dashboard = await request(server, { path: "/api/dashboard" });
    const health = await request(server, { path: "/api/health" });

    assert.equal(dashboard.status, 200);
    const dashboardBody = JSON.parse(dashboard.body);
    const healthBody = JSON.parse(health.body);
    assert.equal(dashboardBody.employee.role.id, "pr-reviewer");
    assert.equal("employees" in dashboardBody, false);
    assert.equal(healthBody.employee.state, "observing");
    assert.deepEqual(
      healthBody.employees.map((employee) => employee.id),
      ["pr-reviewer", "requirements-analyst"],
    );
  });
});

test("server keeps legacy prEmployee-only applications operational", async () => {
  await withServer(async ({ server, calls }) => {
    const health = await request(server, { path: "/api/health" });
    const list = await request(server, { path: "/api/employees" });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(health.status, 200);
    assert.deepEqual(
      JSON.parse(health.body).employees.map((employee) => employee.id),
      ["pr-reviewer"],
    );
    assert.equal(list.status, 200);
    assert.equal(JSON.parse(list.body).items.length, 1);
    assert.equal(run.status, 200);
    assert.deepEqual(calls, [
      { operation: "employee_tick", trigger: "manual" },
    ]);
  }, { legacyOnly: true });
});

test("employee discovery and dynamic routes work for every registered role", async () => {
  await withServer(async ({ server, calls }) => {
    const list = await request(server, { path: "/api/employees" });
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const control = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/control",
      headers,
      body: JSON.stringify({ command: "pause", expectedRevision: 2 }),
    });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const missing = await request(server, {
      method: "POST",
      path: "/api/employees/missing-role/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const untrusted = await request(server, {
      method: "POST",
      path: "/api/employees/requirements-analyst/run",
      headers: {
        origin: "https://evil.example",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(list.status, 200);
    assert.deepEqual(
      JSON.parse(list.body).items.map((employee) => employee.id),
      ["pr-reviewer", "requirements-analyst"],
    );
    assert.equal("jobs" in JSON.parse(list.body).items[0], false);
    assert.equal(control.status, 200);
    assert.equal(run.status, 200);
    assert.equal(missing.status, 404);
    assert.equal(untrusted.status, 403);
    assert.deepEqual(
      calls.filter((call) => call.operation.startsWith("analyst_")),
      [
        { operation: "analyst_control", command: "pause", expectedRevision: 2 },
        { operation: "analyst_tick", trigger: "manual" },
      ],
    );
  });
});

test("employee control, manual run, and draft decisions use trusted local mutations", async () => {
  await withServer(async ({ server, calls }) => {
    const headers = {
      origin: "http://127.0.0.1:4173",
      "x-mydashboard-action": "1",
      "content-type": "application/json",
    };
    const control = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/control",
      headers,
      body: JSON.stringify({ command: "pause", expectedRevision: 4 }),
    });
    const run = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: headers.origin,
        "x-mydashboard-action": "1",
      },
    });
    const decide = await request(server, {
      method: "POST",
      path: "/api/pr-review-jobs/decide",
      headers,
      body: JSON.stringify({
        id: "pr-work-1",
        decision: "accept",
        headRefOid: "head-1",
        expectedRevision: 4,
      }),
    });

    assert.equal(control.status, 200);
    assert.equal(run.status, 200);
    assert.equal(decide.status, 200);
    assert.deepEqual(
      calls.filter((call) => call.operation.startsWith("employee_")),
      [
        { operation: "employee_control", command: "pause", expectedRevision: 4 },
        { operation: "employee_tick", trigger: "manual" },
        {
          operation: "employee_decide",
          id: "pr-work-1",
          decision: "accept",
          headRefOid: "head-1",
          expectedRevision: 4,
        },
      ],
    );
  });
});

test("memory search is local, bounded, and read-only", async () => {
  await withServer(async ({ server, calls }) => {
    const response = await request(server, {
      path: "/api/memory/search?q=checkout&limit=999",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).items, [
      { id: "memory-1", title: "Checkout review" },
    ]);
    assert.deepEqual(calls.at(-1), {
      operation: "memory_search",
      query: "checkout",
      limit: 100,
    });
  });
});
