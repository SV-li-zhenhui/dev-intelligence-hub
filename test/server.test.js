import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import {
  createDashboardServer,
  startApplicationBackgroundWork,
  startDashboardServer,
} from "../src/server.js";
import { EmployeeRegistry } from "../src/services/employee-registry.js";
import { createSafeDisabledConfiguration } from "../src/lib/config.js";

const safeEditableConfiguration = createSafeDisabledConfiguration(
  JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")),
);

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
          const rawBody = Buffer.concat(chunks);
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: rawBody.toString("utf8"),
            rawBody,
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

async function waitForPort(port, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await requestPort(port, options);
    } catch (error) {
      if (error.code !== "ECONNREFUSED") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
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

function safeConfigurationApplication() {
  const calls = [];
  const runtimeConfiguration = structuredClone(safeEditableConfiguration);
  let snapshot = {
    revision: 0,
    activeVersion: null,
    migration: {
      status: "pending",
      importedAt: null,
      importedBy: null,
      sourceDigest: null,
    },
    versions: [],
    draftRevisions: [],
    draftHeads: [],
    audit: [],
    projectionOutbox: [],
  };

  const fail = (statusCode, message) => {
    throw Object.assign(new Error(message), { statusCode });
  };
  const copy = (value) => structuredClone(value);
  const requireDraft = (draftId, revision) => {
    const draft = snapshot.draftRevisions.find(
      (candidate) =>
        candidate.draftId === draftId && candidate.revision === revision,
    );
    if (!draft) fail(404, "配置草稿修订不存在");
    return draft;
  };
  const draftRecord = ({
    draftId,
    revision,
    configuration,
    proposedBy,
    supersedesRevisionId,
  }) => ({
    draftRevisionId: `configuration-draft-revision-${draftId}-${revision}`,
    contentDigest: `${revision}`.padStart(64, "a").slice(-64),
    draftId,
    revision,
    baseVersion: 0,
    configurationDigest: `${revision}`.padStart(64, "b").slice(-64),
    configuration: copy(configuration),
    proposedBy,
    createdAt: `2026-08-05T0${revision}:00:00.000Z`,
    supersedesRevisionId,
  });

  const draftManager = {
    async createInitializationDraft(input) {
      calls.push({ operation: "configuration_create", input: copy(input) });
      if (snapshot.activeVersion !== null) fail(409, "版本化配置已经完成初始化");
      const draft = draftRecord({
        draftId: "initial-draft",
        revision: 1,
        configuration: input.configuration,
        proposedBy: input.proposedBy,
        supersedesRevisionId: null,
      });
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        draftRevisions: [...snapshot.draftRevisions, draft],
        draftHeads: [
          ...snapshot.draftHeads,
          {
            draftId: draft.draftId,
            revision: draft.revision,
            draftRevisionId: draft.draftRevisionId,
          },
        ],
      };
      return copy(draft);
    },
    async reviseDraft(input) {
      calls.push({ operation: "configuration_revise", input: copy(input) });
      const headIndex = snapshot.draftHeads.findIndex(
        (candidate) => candidate.draftId === input.draftId,
      );
      const head = snapshot.draftHeads[headIndex];
      if (!head) fail(404, "配置草稿不存在");
      if (head.revision !== input.expectedDraftRevision) {
        fail(409, "配置草稿已有新修订");
      }
      const previous = requireDraft(head.draftId, head.revision);
      const draft = draftRecord({
        draftId: head.draftId,
        revision: head.revision + 1,
        configuration: input.configuration,
        proposedBy: input.proposedBy,
        supersedesRevisionId: previous.draftRevisionId,
      });
      const draftHeads = [...snapshot.draftHeads];
      draftHeads[headIndex] = {
        draftId: draft.draftId,
        revision: draft.revision,
        draftRevisionId: draft.draftRevisionId,
      };
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        draftRevisions: [...snapshot.draftRevisions, draft],
        draftHeads,
      };
      return copy(draft);
    },
  };

  const initializationItem = {
    id: "confirmation-configuration-initialization",
    kind: "local.configuration-activate",
    status: "pending",
    queueRevision: 12,
    itemRevision: 1,
    requestedBy: {
      roleId: "configuration-owner",
      workItemId: "configuration-initial-draft",
    },
    actor: { provider: "local-configuration", accountId: "owner:local" },
    target: {
      provider: "local-configuration",
      resourceId: "active-configuration",
      version: "c".repeat(64),
    },
    action: {
      type: "initialize_from_draft",
      validationDigest: "d".repeat(64),
    },
    display: {
      title: "初始化版本化配置",
      summary: "从已保存草稿初始化活动配置。",
      actionLabel: "确认初始化",
      evidence: [],
      payload: {
        actor: { provider: "local-configuration", accountId: "owner:local" },
        target: {
          provider: "local-configuration",
          resourceId: "active-configuration",
          version: "c".repeat(64),
        },
        action: {
          type: "initialize_from_draft",
          validationDigest: "d".repeat(64),
        },
      },
    },
    displayedPayloadDigest: "e".repeat(64),
    approvalBindingDigest: "f".repeat(64),
    retryable: false,
  };
  const githubItem = {
    ...copy(initializationItem),
    id: "confirmation-unrelated-github",
    kind: "github.pull-request-review",
    action: { type: "pull_request_review" },
  };
  const rollbackItem = {
    ...copy(initializationItem),
    id: "confirmation-configuration-rollback",
    action: { type: "activate_rollback" },
    display: {
      ...copy(initializationItem.display),
      payload: {
        ...copy(initializationItem.display.payload),
        action: { type: "activate_rollback" },
      },
    },
  };
  const items = new Map(
    [githubItem, rollbackItem, initializationItem].map((item) => [item.id, item]),
  );
  const publicItem = (item) => {
    if (!item) return null;
    const projected = copy(item);
    delete projected.action;
    return projected;
  };
  const nextInitialization = () => {
    const item = items.get(initializationItem.id);
    const pending = item.status === "pending" || item.retryable ? [item] : [];
    return {
      queueRevision: 12,
      pendingCount: pending.length,
      item: publicItem(pending[0] || null),
    };
  };
  const completeInitialization = () => {
    const head = snapshot.draftHeads[0];
    const draft = head && requireDraft(head.draftId, head.revision);
    if (!draft) fail(409, "初始化草稿不存在");
    const active = {
      configurationVersionId: "configuration-version-initialized",
      contentDigest: "1".repeat(64),
      version: 1,
      configurationDigest: draft.configurationDigest,
      configuration: copy(draft.configuration),
      source: "initialization",
      previousVersion: null,
      draftRevisionId: draft.draftRevisionId,
      rollbackOf: null,
      activatedBy: "owner:local",
      activatedAt: "2026-08-05T08:00:00.000Z",
      impactDigest: "2".repeat(64),
    };
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      activeVersion: 1,
      versions: [active],
    };
  };
  const confirmationQueue = {
    async next() {
      calls.push({ operation: "unsafe_confirmation_next" });
      throw new Error("safe mode must use an action-scoped query");
    },
    async nextForAction(kind, actionType, options) {
      calls.push({
        operation: "configuration_confirmation_next",
        kind,
        actionType,
        options: copy(options),
      });
      return copy(nextInitialization());
    },
    async get(id) {
      calls.push({ operation: "configuration_confirmation_get", id });
      const item = items.get(id);
      if (!item) fail(404, "确认项不存在");
      return publicItem(item);
    },
    async approve(id, input) {
      calls.push({ operation: "configuration_confirmation_approve", id, input: copy(input) });
      const item = items.get(id);
      item.status = "completed";
      completeInitialization();
      return publicItem(item);
    },
    async retry(id, input) {
      calls.push({ operation: "configuration_confirmation_retry", id, input: copy(input) });
      return publicItem(items.get(id));
    },
    async reject(id, input) {
      calls.push({ operation: "configuration_confirmation_reject", id, input: copy(input) });
      const item = items.get(id);
      item.status = "rejected";
      return publicItem(item);
    },
  };

  const reader = {
    async readSnapshot() {
      calls.push({ operation: "configuration_snapshot" });
      return copy(snapshot);
    },
    async readActive() {
      return copy(
        snapshot.versions.find(({ version }) => version === snapshot.activeVersion) || null,
      );
    },
    async readVersion({ version }) {
      const entry = snapshot.versions.find((candidate) => candidate.version === version);
      if (!entry) fail(404, "配置版本不存在");
      return copy(entry);
    },
    async readDraft({ draftId, revision }) {
      calls.push({ operation: "configuration_draft_read", draftId, revision });
      return copy(requireDraft(draftId, revision));
    },
    async readProjectionBatch() {
      return { highWatermark: 0, nextSequence: 0, items: [] };
    },
  };
  const simulator = {
    async prepareInitialization(input) {
      calls.push({ operation: "configuration_preview", input: copy(input) });
      return {
        kind: "configuration.initialize",
        ...copy(input),
        expectedActiveVersion: null,
        activeDigest: null,
        baselineDigest: "6".repeat(64),
        draftRevisionId: `configuration-draft-revision-${input.draftId}-${input.draftRevision}`,
        documentDigest: "3".repeat(64),
        validationDigest: "4".repeat(64),
        impactDigest: "5".repeat(64),
        impact: {
          changed: true,
          beforeDigest: "6".repeat(64),
          afterDigest: "3".repeat(64),
          security_tightening: [],
          authority_expansion: ["githubActions.enabled"],
          benign_claim_change: ["refreshMinutes"],
          restart_required: ["githubActions.enabled"],
        },
      };
    },
  };
  const confirmationRequester = {
    async requestInitialization(input) {
      calls.push({
        operation: "configuration_request_confirmation",
        input: copy(input),
      });
      return publicItem(initializationItem);
    },
  };
  const application = {
    config: runtimeConfiguration,
    configuration: {
      status: {
        safeMode: true,
        activeVersion: null,
        stateRevision: 0,
        migrationError: { code: "CONFIG_LOCAL_INVALID", message: "测试迁移失败" },
      },
      reader,
      draftManager,
      simulator,
      confirmationRequester,
    },
    confirmationQueue,
    store: { async read() { return null; } },
    refreshService: { running: null, async refresh() { fail(503, "safe mode"); } },
  };
  return { application, calls, getSnapshot: () => copy(snapshot), items };
}

async function withSafeConfigurationServer(run) {
  const fixture = safeConfigurationApplication();
  const backgroundWork = startApplicationBackgroundWork(fixture.application);
  const reportedErrors = [];
  const server = createDashboardServer(fixture.application, {
    backgroundWork,
    reportError(error) {
      reportedErrors.push(error);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ ...fixture, server, backgroundWork, reportedErrors });
  } finally {
    await server.shutdown();
  }
}

function trustedConfigurationHeaders() {
  return {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
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
    workGraphView,
    attentionCoordinator,
    attentionBrowser,
    memorySearch,
    memoryAnswer,
    memoryImports,
    codeJobReader,
    codeJobControl,
    changePackageReader,
    changePackageApplicationRequester,
    changePackageApplicationStatusReader,
    codeJobEvidenceReader,
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
  if (workGraphView) application.workGraphView = workGraphView;
  if (attentionCoordinator) {
    application.attentionCoordinator = attentionCoordinator;
  }
  if (attentionBrowser) application.attentionBrowser = attentionBrowser;
  if (memorySearch) application.memorySearch = memorySearch;
  if (memoryAnswer) application.memoryAnswer = memoryAnswer;
  if (memoryImports) application.memoryImports = memoryImports;
  if (codeJobReader) application.codeJobReader = codeJobReader;
  if (codeJobControl) application.codeJobControl = codeJobControl;
  if (changePackageReader) application.changePackageReader = changePackageReader;
  if (changePackageApplicationRequester) {
    application.changePackageApplicationRequester =
      changePackageApplicationRequester;
  }
  if (changePackageApplicationStatusReader) {
    application.changePackageApplicationStatusReader =
      changePackageApplicationStatusReader;
  }
  if (codeJobEvidenceReader) {
    application.codeJobEvidenceReader = codeJobEvidenceReader;
  }
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

test("configuration safe mode starts no background reads or employees but permits confirmation operations", async () => {
  let refreshCalls = 0;
  let operationCalls = 0;
  const application = startupApplication({
    async refresh() {
      refreshCalls += 1;
      return healthyRefreshResult();
    },
  });
  application.configuration = {
    status: { safeMode: true, migrationError: { code: "CONFIG_LOCAL_INVALID" } },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn() {
      throw new Error("safe mode must not schedule work");
    },
  });

  assert.deepEqual(await backgroundWork.initialRefresh, {
    skipped: "configuration_safe_mode",
  });
  assert.deepEqual(await backgroundWork.refresh(), {
    skipped: "configuration_safe_mode",
  });
  assert.deepEqual(
    await backgroundWork.mutateFacts(async () => {
      operationCalls += 1;
    }),
    { skipped: "configuration_safe_mode" },
  );
  assert.equal(
    await backgroundWork.runConfirmationOperation(async () => {
      operationCalls += 1;
      return "confirmation-completed";
    }),
    "confirmation-completed",
  );
  assert.deepEqual(backgroundWork.timers, []);
  assert.equal(backgroundWork.confirmationReady(), true);
  assert.equal(refreshCalls, 0);
  assert.equal(operationCalls, 1);
  const firstStop = backgroundWork.stop();
  assert.strictEqual(backgroundWork.stop(), firstStop);
  await firstStop;
});

test("configuration safe mode shutdown drains an accepted confirmation operation", async () => {
  const operationStarted = deferred();
  const releaseOperation = deferred();
  const application = startupApplication();
  application.configuration = {
    status: { safeMode: true, migrationError: null },
  };
  const backgroundWork = startApplicationBackgroundWork(application);
  const operation = backgroundWork.runConfirmationOperation(async () => {
    operationStarted.resolve();
    await releaseOperation.promise;
    return "completed";
  });
  await operationStarted.promise;

  let stopped = false;
  const stopping = backgroundWork.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(backgroundWork.confirmationReady(), false);
  await assert.rejects(
    backgroundWork.runConfirmationOperation(async () => "must-not-run"),
    (error) => error?.code === "CONFIRMATION_FACTS_NOT_READY",
  );

  releaseOperation.resolve();
  assert.equal(await operation, "completed");
  await stopping;
  assert.equal(stopped, true);
});

test("configuration API exposes an uncertain runtime fence", async () => {
  await withSafeConfigurationServer(async ({ application, server }) => {
    application.configuration.runtimeStatus = {
      readStatus() {
        return {
          mode: "unknown",
          storedActive: null,
          runtimeEffective: null,
        };
      },
    };

    const response = await request(server, { path: "/api/configuration" });
    assert.equal(response.status, 200);
    const state = JSON.parse(response.body);
    assert.equal(state.status.runtimeMode, "unknown");
    assert.equal(state.pendingRestart, true);
  });
});

test("configuration API fails closed on contradictory or one-sided bindings", async () => {
  await withSafeConfigurationServer(async ({ application, server }) => {
    application.configuration.runtimeStatus = {
      readStatus() {
        return {
          mode: "ready",
          storedActive: null,
          runtimeEffective: null,
        };
      },
    };
    const contradictory = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(contradictory.status.runtimeMode, "unknown");
    assert.equal(contradictory.pendingRestart, true);

    delete application.configuration.runtimeStatus;
    application.configuration.status.activeVersion = 1;
    const runtimeOnly = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(runtimeOnly.status.runtimeMode, "restart_required");
    assert.equal(runtimeOnly.pendingRestart, true);
  });
});

test("safe-mode configuration API creates, revises, previews, and reloads only initialization drafts", async () => {
  await withSafeConfigurationServer(async ({ server, calls }) => {
    const initial = await request(server, { path: "/api/configuration" });
    assert.equal(initial.status, 200);
    const initialState = JSON.parse(initial.body);
    assert.deepEqual(Object.keys(initialState).sort(), [
      "drafts",
      "editableConfiguration",
      "pendingRestart",
      "runtimeEffective",
      "status",
      "storedActive",
    ]);
    assert.equal(initialState.status.safeMode, true);
    assert.equal(initialState.status.runtimeMode, "boot_safe");
    assert.equal(initialState.status.stateRevision, 0);
    assert.equal(initialState.status.migrationError.code, "CONFIG_LOCAL_INVALID");
    assert.equal(initialState.storedActive, null);
    assert.equal(initialState.runtimeEffective.activeVersion, null);
    assert.match(initialState.runtimeEffective.configurationDigest, /^[a-f0-9]{64}$/);
    assert.equal(initialState.pendingRestart, false);
    assert.deepEqual(initialState.drafts, []);
    assert.deepEqual(
      initialState.editableConfiguration,
      safeEditableConfiguration,
    );
    assert.equal("audit" in initialState, false);
    assert.equal("projectionOutbox" in initialState, false);

    const firstConfiguration = structuredClone(safeEditableConfiguration);
    firstConfiguration.refreshMinutes = 20;
    const created = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 0,
        configuration: firstConfiguration,
      }),
    });
    assert.equal(created.status, 201, created.body);
    const createdDraft = JSON.parse(created.body).draft;
    assert.equal(createdDraft.draftId, "initial-draft");
    assert.equal(createdDraft.revision, 1);
    assert.equal(createdDraft.baseVersion, 0);
    assert.equal("proposedBy" in createdDraft, false);
    assert.equal("contentDigest" in createdDraft, false);
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_create").input,
      {
        expectedStateRevision: 0,
        configuration: firstConfiguration,
        proposedBy: "owner:local",
      },
    );

    const afterCreate = await request(server, { path: "/api/configuration" });
    assert.equal(afterCreate.status, 200);
    const createdState = JSON.parse(afterCreate.body);
    assert.equal(createdState.status.stateRevision, 1);
    assert.equal(createdState.drafts.length, 1);
    assert.equal(createdState.drafts[0].draftId, "initial-draft");
    assert.equal(createdState.drafts[0].baseVersion, 0);
    assert.equal("configuration" in createdState.drafts[0], false);
    assert.deepEqual(createdState.editableConfiguration, firstConfiguration);
    assert.equal(
      calls.filter(({ operation }) => operation === "configuration_draft_read")
        .length,
      0,
    );

    const draftRead = await request(server, {
      path: "/api/configuration/drafts/initial-draft?revision=1",
    });
    assert.equal(draftRead.status, 200);
    assert.deepEqual(JSON.parse(draftRead.body).draft.configuration, firstConfiguration);
    assert.equal(
      calls.filter(({ operation }) => operation === "configuration_draft_read")
        .length,
      1,
    );

    const secondConfiguration = structuredClone(firstConfiguration);
    secondConfiguration.refreshMinutes = 25;
    const revised = await request(server, {
      method: "PUT",
      path: "/api/configuration/drafts/initial-draft",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedDraftRevision: 1,
        expectedStateRevision: 1,
        configuration: secondConfiguration,
      }),
    });
    assert.equal(revised.status, 200, revised.body);
    assert.equal(JSON.parse(revised.body).draft.revision, 2);
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_revise").input,
      {
        draftId: "initial-draft",
        expectedDraftRevision: 1,
        expectedStateRevision: 1,
        configuration: secondConfiguration,
        proposedBy: "owner:local",
      },
    );

    const reloaded = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(reloaded.status.stateRevision, 2);
    assert.equal(reloaded.drafts[0].revision, 2);
    assert.deepEqual(reloaded.editableConfiguration, secondConfiguration);

    const binding = { draftRevision: 2, expectedStateRevision: 2 };
    const preview = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts/initial-draft/preview",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(binding),
    });
    assert.equal(preview.status, 200, preview.body);
    const prepared = JSON.parse(preview.body);
    assert.equal(prepared.kind, "configuration.initialize");
    assert.equal(prepared.expectedActiveVersion, null);
    assert.deepEqual(prepared.impact.restart_required, ["githubActions.enabled"]);
    assert.deepEqual(
      calls.find(({ operation }) => operation === "configuration_preview").input,
      { draftId: "initial-draft", ...binding },
    );

    const queued = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts/initial-draft/request-confirmation",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(binding),
    });
    assert.equal(queued.status, 200, queued.body);
    assert.equal(
      JSON.parse(queued.body).request.id,
      "confirmation-configuration-initialization",
    );
    assert.deepEqual(
      calls.find(
        ({ operation }) => operation === "configuration_request_confirmation",
      ).input,
      { draftId: "initial-draft", ...binding },
    );
  });
});

test("safe-mode configuration mutations reject untrusted, expansive, and direct activation requests", async () => {
  await withSafeConfigurationServer(async ({ server, calls }) => {
    const configuration = structuredClone(safeEditableConfiguration);
    const untrusted = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedStateRevision: 0, configuration }),
    });
    const clientActor = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({
        expectedStateRevision: 0,
        configuration,
        proposedBy: "attacker",
      }),
    });
    const directPaths = [
      "/api/configuration/activate",
      "/api/configuration/rollback",
      "/api/confirmations/enqueue",
    ];
    const direct = await Promise.all(
      directPaths.map((path) =>
        request(server, {
          method: "POST",
          path,
          headers: trustedConfigurationHeaders(),
          body: "{}",
        }),
      ),
    );

    assert.equal(untrusted.status, 403);
    assert.equal(clientActor.status, 400);
    assert.deepEqual(direct.map(({ status }) => status), [404, 404, 404]);
    assert.equal(
      calls.filter(({ operation }) => operation === "configuration_create").length,
      0,
    );
  });
});

test("safe mode exposes and operates only initialization confirmations then reports restart drift", async () => {
  await withSafeConfigurationServer(async ({ server, calls }) => {
    const configuration = structuredClone(safeEditableConfiguration);
    const created = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({ expectedStateRevision: 0, configuration }),
    });
    assert.equal(created.status, 201);

    const directNext = await request(server, { path: "/api/confirmations/next" });
    const attentionNext = await request(server, { path: "/api/attention/next" });
    assert.equal(directNext.status, 200, directNext.body);
    assert.equal(attentionNext.status, 200, attentionNext.body);
    assert.equal(
      JSON.parse(directNext.body).item.id,
      "confirmation-configuration-initialization",
    );
    assert.equal(
      JSON.parse(attentionNext.body).item.id,
      "confirmation-configuration-initialization",
    );
    const scopedReads = calls.filter(
      ({ operation }) => operation === "configuration_confirmation_next",
    );
    assert.equal(scopedReads.length, 2);
    for (const read of scopedReads) {
      assert.equal(read.kind, "local.configuration-activate");
      assert.equal(read.actionType, "initialize_from_draft");
    }
    assert.equal(
      calls.some(({ operation }) => operation === "unsafe_confirmation_next"),
      false,
    );

    const approval = {
      requestId: "request-configuration-initialization-1",
      expectedQueueRevision: 12,
      expectedItemRevision: 1,
      displayedPayloadDigest: "e".repeat(64),
      approvalBindingDigest: "f".repeat(64),
    };
    for (const id of [
      "confirmation-unrelated-github",
      "confirmation-configuration-rollback",
    ]) {
      const denied = await request(server, {
        method: "POST",
        path: `/api/confirmations/${id}/approve`,
        headers: trustedConfigurationHeaders(),
        body: JSON.stringify(approval),
      });
      assert.equal(denied.status, 404, `${id}: ${denied.body}`);
    }
    assert.equal(
      calls.filter(
        ({ operation }) => operation === "configuration_confirmation_approve",
      ).length,
      0,
    );

    const approved = await request(server, {
      method: "POST",
      path: "/api/confirmations/confirmation-configuration-initialization/approve",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify(approval),
    });
    assert.equal(approved.status, 200, approved.body);
    assert.equal(JSON.parse(approved.body).item.status, "completed");

    const status = JSON.parse(
      (await request(server, { path: "/api/configuration" })).body,
    );
    assert.equal(status.status.safeMode, true);
    assert.equal(status.status.runtimeMode, "restart_required");
    assert.equal(status.storedActive.version, 1);
    assert.equal(status.runtimeEffective.activeVersion, null);
    assert.equal(status.pendingRestart, true);
    assert.deepEqual(status.editableConfiguration, configuration);

    const version = await request(server, {
      path: "/api/configuration/versions/1",
    });
    assert.equal(version.status, 200);
    assert.deepEqual(JSON.parse(version.body).version.configuration, configuration);

    const createAfterActivation = await request(server, {
      method: "POST",
      path: "/api/configuration/drafts",
      headers: trustedConfigurationHeaders(),
      body: JSON.stringify({ expectedStateRevision: 2, configuration }),
    });
    assert.equal(createAfterActivation.status, 409);
  });
});

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

test("background work projects durable activity into unified memory after employees run", async () => {
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
      },
    },
    workCoordination: {
      async intake() {
        calls.push({ operation: "intake" });
      },
      async runCycle(options) {
        calls.push({ operation: "work_cycle", ...options });
      },
    },
    memoryProjector: {
      async runCycle() {
        calls.push({ operation: "memory_projection" });
      },
    },
  };
  const backgroundWork = startApplicationBackgroundWork(application, {
    setIntervalFn() {
      return { unref() {} };
    },
    clearIntervalFn() {},
  });

  try {
    await backgroundWork.initialRefresh;
    assert.deepEqual(calls, [
      { operation: "refresh", notify: false },
      { operation: "intake" },
      {
        operation: "work_cycle",
        trigger: "refresh_completed",
        includeWork: false,
      },
      { operation: "run_all", trigger: "refresh_completed" },
      { operation: "memory_projection" },
    ]);
  } finally {
    await backgroundWork.stop();
  }
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

test("scheduled employees stay behind the confirmation gate when facts are stale", async () => {
  const timers = [];
  const employeeRuns = [];
  const application = {
    config: { refreshMinutes: 7 },
    confirmationQueue: {},
    store: {
      async read(name) {
        if (name !== "snapshot") return null;
        return {
          sourceStatus: {
            githubPullRequests: { ok: false, stale: true },
          },
        };
      },
    },
    employeeRegistry: {
      get() {
        return null;
      },
      schedules() {
        return [{ id: "requirements-analyst", intervalMinutes: 11 }];
      },
      async runSelected(ids, options) {
        employeeRuns.push({ ids, ...options });
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

  try {
    await backgroundWork.initialRefresh;
    assert.equal(backgroundWork.confirmationReady(), false);

    await timers[1].callback();

    assert.deepEqual(employeeRuns, []);
  } finally {
    await backgroundWork.stop();
  }
});

test("scheduled and manual employees wait for refresh without an external queue", async () => {
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const timers = [];
  const employeeRuns = [];
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [{ id: "requirements-analyst", intervalMinutes: 11 }];
      },
      async runSelected(ids, options) {
        employeeRuns.push({ ids, ...options });
      },
    },
    refreshService: {
      async refresh() {
        refreshStarted.resolve();
        await releaseRefresh.promise;
      },
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

  try {
    await refreshStarted.promise;
    const scheduled = timers[1].callback();
    const manual = backgroundWork.runEmployee("developer");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(employeeRuns, []);

    releaseRefresh.resolve();
    await Promise.all([backgroundWork.initialRefresh, scheduled, manual]);

    assert.deepEqual(employeeRuns, [
      { ids: ["pr-reviewer"], trigger: "refresh_completed" },
      { ids: ["requirements-analyst"], trigger: "scheduled" },
      { ids: ["developer"], trigger: "manual" },
    ]);
  } finally {
    releaseRefresh.resolve();
    await backgroundWork.stop();
  }
});

test("overlapping scheduled role and refresh ticks are coalesced", async () => {
  const roleStarted = deferred();
  const releaseRole = deferred();
  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const timers = [];
  let refreshCount = 0;
  let roleRunCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [{ id: "requirements-analyst", intervalMinutes: 11 }];
      },
      async runSelected(ids) {
        if (ids[0] !== "requirements-analyst") return;
        roleRunCount += 1;
        roleStarted.resolve();
        await releaseRole.promise;
      },
    },
    refreshService: {
      async refresh() {
        refreshCount += 1;
        if (refreshCount === 1) return;
        refreshStarted.resolve();
        await releaseRefresh.promise;
      },
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

  try {
    await backgroundWork.initialRefresh;
    const firstRoleTick = timers[1].callback();
    await roleStarted.promise;
    const overlappingRoleTick = timers[1].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(roleRunCount, 1);
    releaseRole.resolve();
    await Promise.all([firstRoleTick, overlappingRoleTick]);
    assert.equal(roleRunCount, 1);

    const firstRefreshTick = timers[0].callback();
    await refreshStarted.promise;
    const overlappingRefreshTick = timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshCount, 2);
    releaseRefresh.resolve();
    await Promise.all([firstRefreshTick, overlappingRefreshTick]);
    assert.equal(refreshCount, 2);
  } finally {
    releaseRole.resolve();
    releaseRefresh.resolve();
    await backgroundWork.stop();
  }
});

test("a pending refresh skips obsolete queued role ticks", async () => {
  const firstRoleStarted = deferred();
  const releaseFirstRole = deferred();
  const timers = [];
  const calls = [];
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [
          { id: "requirements-analyst", intervalMinutes: 11 },
          { id: "developer", intervalMinutes: 13 },
        ];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
        if (ids[0] === "requirements-analyst") {
          firstRoleStarted.resolve();
          await releaseFirstRole.promise;
        }
      },
    },
    refreshService: {
      async refresh(options) {
        refreshCount += 1;
        calls.push({ operation: "refresh", count: refreshCount, ...options });
      },
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

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const activeRole = timers[1].callback();
    await firstRoleStarted.promise;
    const obsoleteRole = timers[2].callback();
    const refresh = timers[0].callback();
    releaseFirstRole.resolve();
    await Promise.all([activeRole, obsoleteRole, refresh]);

    assert.deepEqual(calls, [
      {
        operation: "run",
        ids: ["requirements-analyst"],
        trigger: "scheduled",
      },
      { operation: "refresh", count: 2, notify: false },
      {
        operation: "run",
        ids: ["pr-reviewer"],
        trigger: "refresh_completed",
      },
    ]);

    await timers[2].callback();
    assert.deepEqual(calls.at(-1), {
      operation: "run",
      ids: ["developer"],
      trigger: "scheduled",
    });
  } finally {
    releaseFirstRole.resolve();
    await backgroundWork.stop();
  }
});

test("a manual role run queued before refresh is never discarded", async () => {
  const firstManualStarted = deferred();
  const releaseFirstManual = deferred();
  const timers = [];
  const calls = [];
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
        if (ids[0] === "requirements-analyst") {
          firstManualStarted.resolve();
          await releaseFirstManual.promise;
        }
      },
    },
    refreshService: {
      async refresh(options) {
        refreshCount += 1;
        calls.push({ operation: "refresh", count: refreshCount, ...options });
      },
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

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const activeManual = backgroundWork.runEmployee("requirements-analyst");
    await firstManualStarted.promise;
    const queuedManual = backgroundWork.runEmployee("developer");
    const refresh = timers[0].callback();
    releaseFirstManual.resolve();
    await Promise.all([activeManual, queuedManual, refresh]);

    assert.deepEqual(calls, [
      {
        operation: "run",
        ids: ["requirements-analyst"],
        trigger: "manual",
      },
      { operation: "run", ids: ["developer"], trigger: "manual" },
      { operation: "refresh", count: 2, notify: false },
      {
        operation: "run",
        ids: ["pr-reviewer"],
        trigger: "refresh_completed",
      },
    ]);
  } finally {
    releaseFirstManual.resolve();
    await backgroundWork.stop();
  }
});

test("a manual role run between two fact cycles uses the first fresh snapshot", async () => {
  const firstRefreshStarted = deferred();
  const releaseFirstRefresh = deferred();
  const timers = [];
  const calls = [];
  let refreshCount = 0;
  const application = {
    config: { refreshMinutes: 7 },
    employeeRegistry: {
      schedules() {
        return [];
      },
      async runSelected(ids, options) {
        calls.push({ operation: "run", ids, ...options });
      },
    },
    refreshService: {
      async refresh(options) {
        refreshCount += 1;
        calls.push({ operation: "refresh", count: refreshCount, ...options });
        if (refreshCount === 2) {
          firstRefreshStarted.resolve();
          await releaseFirstRefresh.promise;
        }
      },
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

  try {
    await backgroundWork.initialRefresh;
    calls.length = 0;
    const firstRefresh = timers[0].callback();
    await firstRefreshStarted.promise;
    const manual = backgroundWork.runEmployee("developer");
    const secondRefresh = backgroundWork.refresh({ notify: true });
    releaseFirstRefresh.resolve();
    await Promise.all([firstRefresh, manual, secondRefresh]);

    assert.deepEqual(calls, [
      { operation: "refresh", count: 2, notify: false },
      { operation: "run", ids: ["developer"], trigger: "manual" },
      { operation: "refresh", count: 3, notify: true },
      {
        operation: "run",
        ids: ["pr-reviewer"],
        trigger: "refresh_completed",
      },
    ]);
  } finally {
    releaseFirstRefresh.resolve();
    await backgroundWork.stop();
  }
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
    const manualEmployee = await request(server, {
      method: "POST",
      path: "/api/employees/pr-reviewer/run",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
      },
    });

    assert.equal(next.status, 503);
    assert.equal(approve.status, 503);
    assert.equal(manualEmployee.status, 503);
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

test("work graph API exposes only the read-only graph snapshot", async () => {
  const calls = [];
  const snapshot = {
    schemaVersion: 1,
    graph: {
      schemaVersion: 1,
      graphId: "work-ledger",
      revision: 4,
      tasks: [
        {
          taskId: "work-1",
          revision: 2,
          parentTaskId: null,
          status: "in_progress",
          responsibility: { type: "role", id: "orchestrator" },
          acceptanceContracts: [
            {
              revision: 1,
              acceptanceCriteria: [],
              expectedDeliverables: [],
            },
          ],
          deliveries: [],
          dependsOn: [],
        },
      ],
      contentDigest: "a".repeat(64),
    },
    taskStates: [
      {
        taskId: "work-1",
        taskRevision: 2,
        ledgerStatus: "working",
        ownerId: "employee-orchestrator",
        leaseUntil: "2026-08-03T04:10:00.000Z",
        availableAt: null,
        statusReason: null,
        updatedAt: "2026-08-03T04:00:00.000Z",
        work: { title: "Review PR", description: null },
      },
    ],
  };
  const workGraphView = {
    async getSnapshot() {
      calls.push({ operation: "get_graph_snapshot" });
      return snapshot;
    },
    async createChild() {
      calls.push({ operation: "create_graph_child" });
      throw new Error("graph writes must remain private");
    },
  };

  await withServer(
    async ({ server }) => {
      const response = await request(server, { path: "/api/work/graph" });

      assert.equal(response.status, 200);
      const expected = {
        schemaVersion: 2,
        totalTaskCount: 1,
        graph: {
          schemaVersion: 1,
          graphId: "work-ledger",
          revision: 4,
          tasks: [{
            taskId: "work-1",
            revision: 2,
            parentTaskId: null,
            responsibility: { type: "role", id: "orchestrator" },
            acceptanceContract: {
              revision: 1,
              acceptanceCriteria: [],
              expectedDeliverables: [],
            },
            latestDeliveries: [],
            history: { acceptanceContractCount: 1, deliveryCount: 0 },
            dependsOn: [],
          }],
        },
        taskStates: [{
          taskId: "work-1",
          taskRevision: 2,
          ledgerStatus: "working",
          ownerId: "employee-orchestrator",
          statusReason: null,
          updatedAt: "2026-08-03T04:00:00.000Z",
          work: { title: "Review PR", description: null },
        }],
      };
      assert.deepEqual(JSON.parse(response.body), expected);
      assert.deepEqual(calls, [{ operation: "get_graph_snapshot" }]);
    },
    { workGraphView },
  );
});

test("work graph API returns a newest bounded window with complete references", async () => {
  const contract = {
    revision: 1,
    acceptanceCriteria: [],
    expectedDeliverables: [],
  };
  const tasks = Array.from({ length: 400 }, (_, index) => ({
    taskId: `task-${String(index).padStart(3, "0")}`,
    revision: 1,
    parentTaskId: index === 399 ? "task-000" : null,
    status: "pending",
    responsibility: { type: "role", id: "orchestrator" },
    acceptanceContracts: [structuredClone(contract)],
    deliveries: [],
    dependsOn: index === 399 ? ["task-001"] : [],
  }));
  tasks[399] = {
    ...tasks[399],
    revision: 4,
    acceptanceContracts: [
      {
        revision: 1,
        acceptanceCriteria: [],
        expectedDeliverables: [{
          deliverableId: "implementation",
          kind: "change-package",
          description: "Old implementation",
          required: true,
        }],
      },
      {
        revision: 2,
        acceptanceCriteria: [{
          criterionId: "verified",
          description: "Current behavior verified",
        }],
        expectedDeliverables: [{
          deliverableId: "implementation",
          kind: "change-package",
          description: "Current implementation",
          required: true,
        }],
      },
    ],
    deliveries: [
      {
        deliverableId: "implementation",
        revision: 1,
        contractRevision: 1,
        status: "accepted",
        summary: "obsolete delivery must stay private",
        evidence: [{
          kind: "artifact",
          referenceId: "obsolete",
          contentDigest: "a".repeat(64),
        }],
      },
      {
        deliverableId: "implementation",
        revision: 2,
        contractRevision: 2,
        status: "submitted",
        summary: "superseded current delivery",
        evidence: [{
          kind: "artifact",
          referenceId: "submitted",
          contentDigest: "b".repeat(64),
        }],
      },
      {
        deliverableId: "implementation",
        revision: 3,
        contractRevision: 2,
        status: "accepted",
        summary: "latest current delivery",
        evidence: [{
          kind: "artifact",
          referenceId: "accepted",
          contentDigest: "c".repeat(64),
        }],
      },
    ],
  };
  const taskStates = tasks.map((task, index) => ({
    taskId: task.taskId,
    taskRevision: task.revision,
    ledgerStatus: "queued",
    ownerId: null,
    statusReason: null,
    updatedAt: new Date(Date.parse("2026-08-03T00:00:00.000Z") + index * 1_000)
      .toISOString(),
    work: { title: `Task ${index}`, description: null },
  }));

  await withServer(
    async ({ server }) => {
      const response = await request(server, { path: "/api/work/graph" });
      const body = JSON.parse(response.body);
      assert.equal(response.status, 200);
      assert.equal(body.schemaVersion, 2);
      assert.equal(body.totalTaskCount, 400);
      assert.equal(body.graph.tasks.length, 300);
      assert.equal(body.taskStates.length, 300);
      const ids = new Set(body.graph.tasks.map(({ taskId }) => taskId));
      assert.equal(ids.has("task-399"), true);
      for (const task of body.graph.tasks) {
        if (task.parentTaskId !== null) assert.equal(ids.has(task.parentTaskId), true);
        for (const dependencyId of task.dependsOn) {
          assert.equal(ids.has(dependencyId), true);
        }
      }
      const newest = body.graph.tasks.find(({ taskId }) => taskId === "task-399");
      assert.equal(newest.acceptanceContract.revision, 2);
      assert.deepEqual(newest.history, {
        acceptanceContractCount: 2,
        deliveryCount: 3,
      });
      assert.deepEqual(
        newest.latestDeliveries.map(({ revision }) => revision),
        [3],
      );
      assert.doesNotMatch(response.body, /obsolete delivery|superseded current/);
    },
    {
      workGraphView: {
        async getSnapshot() {
          return {
            schemaVersion: 1,
            graph: {
              schemaVersion: 1,
              graphId: "work-ledger",
              revision: 400,
              tasks,
            },
            taskStates,
          };
        },
      },
    },
  );
});

test("work graph HTTP boundary exposes no write route", async () => {
  const calls = [];
  const workGraphView = {
    async getSnapshot() {
      calls.push({ operation: "get_graph_snapshot" });
      return {};
    },
    async createChild() {
      calls.push({ operation: "create_graph_child" });
      throw new Error("graph writes must remain private");
    },
  };

  await withServer(
    async ({ server }) => {
      const headers = {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      };
      const responses = await Promise.all([
        request(server, {
          method: "POST",
          path: "/api/work/graph",
          headers,
          body: JSON.stringify({ parentTaskId: "work-1" }),
        }),
        request(server, {
          method: "POST",
          path: "/api/work/graph/children",
          headers,
          body: JSON.stringify({ parentTaskId: "work-1" }),
        }),
      ]);

      assert.deepEqual(responses.map(({ status }) => status), [404, 404]);
      assert.deepEqual(calls, []);
    },
    { workGraphView },
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

test("work graph API fails closed when its projection is disabled or invalid", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/work/graph" });

    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: "服务器内部错误" });
  });
  await withServer(
    async ({ server }) => {
      const response = await request(server, { path: "/api/work/graph" });

      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(response.body), { error: "服务器内部错误" });
    },
    { workGraphView: {} },
  );
});

test("code jobs expose only their safe newest-first reader projection", async () => {
  const calls = [];
  const codeJobReader = {
    async list(options) {
      calls.push(options);
      return {
        items: [{ id: "code-job-1", status: "queued" }],
        nextCursor: null,
      };
    },
  };
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: "/api/code/jobs?limit=9&order=newest&status=queued&cursor=job%3A2",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), {
        enabled: true,
        items: [{ id: "code-job-1", status: "queued" }],
        nextCursor: null,
      });
      assert.deepEqual(calls, [
        { limit: "9", cursor: "job:2", status: "queued", order: "newest" },
      ]);
    },
    { codeJobReader },
  );
});

test("disabled code jobs remain a stable empty read-only API", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/code/jobs" });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      enabled: false,
      items: [],
      nextCursor: null,
    });
  });
});

test("code job detail forwards bounded pagination and reports missing jobs", async () => {
  const jobId = `code-job-${"a".repeat(55)}`;
  const calls = [];
  const detail = {
    job: {
      jobId,
      revision: 7,
      requestedBy: { roleId: "developer", workItemId: "work-1" },
    },
    archived: false,
    historyAvailable: true,
    observations: [],
    nextCursor: null,
    terminalDetail: null,
    changePackage: { status: "pending", receipt: null },
  };
  await withServer(
    async ({ server }) => {
      const found = await request(server, {
        path: `/api/code/jobs/${jobId}?limit=8&cursor=observation%3A2`,
      });
      const missing = await request(server, {
        path: `/api/code/jobs/code-job-${"b".repeat(55)}`,
      });
      const unknownQuery = await request(server, {
        path: `/api/code/jobs/${jobId}?status=active`,
      });
      const repeatedQuery = await request(server, {
        path: `/api/code/jobs/${jobId}?limit=4&limit=5`,
      });

      assert.equal(found.status, 200);
      assert.deepEqual(JSON.parse(found.body), { enabled: true, detail });
      assert.equal(missing.status, 404);
      assert.deepEqual([unknownQuery.status, repeatedQuery.status], [400, 400]);
      assert.deepEqual(calls, [
        { jobId, limit: "8", cursor: "observation:2" },
        { jobId: `code-job-${"b".repeat(55)}` },
      ]);
    },
    {
      codeJobReader: {
        async getDetail(options) {
          calls.push(options);
          return options.jobId === jobId ? detail : null;
        },
      },
    },
  );
});

test("code job detail binds and whitelists durable change package application status", async () => {
  const jobId = `code-job-${"e".repeat(55)}`;
  const packageDigest = "f".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const detail = {
    job: {
      jobId,
      revision: 9,
      requestedBy: { roleId: "developer", workItemId: "work-application" },
    },
    archived: false,
    historyAvailable: true,
    observations: [],
    nextCursor: null,
    terminalDetail: null,
    changePackage: {
      status: "ready",
      receipt: {
        packageId,
        packageDigest,
        deliveredAt: "2026-08-03T02:00:00.000Z",
      },
    },
  };
  let projection = { status: "not_requested" };
  let getterCalls = 0;

  await withServer(
    async ({ server, reportedErrors }) => {
      const available = await request(server, {
        path: `/api/code/jobs/${jobId}`,
      });
      assert.equal(available.status, 200);
      assert.deepEqual(
        JSON.parse(available.body).detail.changePackage.application,
        { status: "not_requested", canRequest: true },
      );

      projection = {
        confirmationId: `confirmation-change-package-apply-${"1".repeat(64)}`,
        approvalBindingDigest: "2".repeat(64),
        requestedBy: {
          roleId: "developer",
          workItemId: "work-application",
        },
        job: { id: jobId, revision: 8, recordDigest: "3".repeat(64) },
        packageId,
        packageDigest,
        workspaceId: "dashboard",
        itemRevision: 3,
        createdAt: "2026-08-03T02:01:00.000Z",
        updatedAt: "2026-08-03T02:02:00.000Z",
        status: "applied",
        receipt: {
          id: `change-package-application-${"4".repeat(64)}`,
          createdAt: "2026-08-03T02:01:30.000Z",
        },
        failure: null,
        rejectedAt: null,
        privatePath: "D:\\private\\checkout",
      };
      const applied = await request(server, {
        path: `/api/code/jobs/${jobId}`,
      });
      assert.equal(applied.status, 200);
      const application = JSON.parse(applied.body).detail.changePackage.application;
      assert.deepEqual(application, {
        status: "applied",
        canRequest: false,
        confirmationId: projection.confirmationId,
        updatedAt: projection.updatedAt,
        retryable: false,
        receipt: projection.receipt,
        failure: null,
        rejectedAt: null,
      });
      assert.equal(applied.body.includes("private\\checkout"), false);
      assert.equal(applied.body.includes("approvalBindingDigest"), false);

      projection = { status: "not_requested" };
      Object.defineProperty(projection, "privatePath", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "D:\\private\\secret";
        },
      });
      const hostile = await request(server, {
        path: `/api/code/jobs/${jobId}`,
      });
      assert.equal(hostile.status, 500);
      assert.equal(hostile.body.includes("private"), false);
      assert.equal(getterCalls, 0);
      assert.equal(reportedErrors.length, 1);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageApplicationStatusReader: {
        async getForJob(requestedJobId) {
          assert.equal(requestedJobId, jobId);
          return projection;
        },
      },
    },
  );
});

test("code job controls bind identity to the path and reject extra fields", async () => {
  const jobId = `code-job-${"c".repeat(55)}`;
  const calls = [];
  const agencySignals = [];
  const signalFailure = new Error("agency wake failed");
  const codeJobControl = {
    async pause(input) {
      calls.push(["pause", input]);
      return { status: "applied", job: { jobId, status: "paused" } };
    },
    async resume(input) {
      calls.push(["resume", input]);
      return { status: "applied", job: { jobId, status: "active" } };
    },
    async cancel(input) {
      calls.push(["cancel", input]);
      if (input.expectedRevision === 10) {
        throw Object.assign(new Error("stale code job revision"), {
          code: "CODE_JOB_REVISION_CONFLICT",
          statusCode: 409,
        });
      }
      return { status: "applied", job: { jobId, status: "cancelled" } };
    },
  };
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(
    async ({ server, reportedErrors }) => {
      const paused = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "pause", expectedRevision: 7 }),
      });
      const resumed = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "resume", expectedRevision: 8 }),
      });
      const cancelled = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "cancel", expectedRevision: 9 }),
      });
      const bodyBoundJob = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({
          command: "pause",
          expectedRevision: 9,
          jobId: `code-job-${"d".repeat(55)}`,
        }),
      });
      const clientReason = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({
          command: "pause",
          expectedRevision: 9,
          reason: "client supplied",
        }),
      });
      const untrusted = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "pause", expectedRevision: 9 }),
      });
      const unsupported = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "delete", expectedRevision: 9 }),
      });
      const staleCancel = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "cancel", expectedRevision: 10 }),
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(
        [paused.status, resumed.status, cancelled.status],
        [200, 200, 200],
      );
      assert.deepEqual(JSON.parse(paused.body), {
        status: "applied",
        job: { jobId, status: "paused" },
      });
      assert.deepEqual(JSON.parse(cancelled.body), {
        status: "applied",
        job: { jobId, status: "cancelled" },
      });
      assert.deepEqual(
        [
          bodyBoundJob.status,
          clientReason.status,
          untrusted.status,
          unsupported.status,
          staleCancel.status,
        ],
        [400, 400, 403, 400, 409],
      );
      assert.deepEqual(calls, [
        [
          "pause",
          {
            jobId,
            expectedRevision: 7,
            reason: "用户从本地指挥中枢暂停代码任务",
          },
        ],
        ["resume", { jobId, expectedRevision: 8 }],
        [
          "cancel",
          {
            jobId,
            expectedRevision: 9,
            reason: "用户从本地指挥中枢取消代码任务",
          },
        ],
        [
          "cancel",
          {
            jobId,
            expectedRevision: 10,
            reason: "用户从本地指挥中枢取消代码任务",
          },
        ],
      ]);
      assert.deepEqual(agencySignals, [
        { trigger: "code_job_cancel_requested" },
      ]);
      assert.deepEqual(reportedErrors, [signalFailure]);
    },
    {
      codeJobControl,
      backgroundWork: {
        async signalAgency(options) {
          agencySignals.push(options);
          throw signalFailure;
        },
      },
    },
  );
});

test("code job package reads require a ready receipt bound to the manifest", async () => {
  const jobId = `code-job-${"e".repeat(55)}`;
  const packageDigest = "f".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const calls = [];
  const detail = {
    job: {
      jobId,
      revision: 11,
      requestedBy: { roleId: "developer", workItemId: "work-1" },
    },
    changePackage: {
      status: "ready",
      receipt: {
        packageId,
        packageDigest,
        deliveredAt: "2026-08-03T01:00:00.000Z",
      },
    },
  };
  const manifest = {
    packageId,
    packageDigest,
    job: { id: jobId },
    changes: { created: [], modified: [], deleted: [] },
  };
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/code/jobs/${jobId}/change-package`,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), { manifest });
      assert.deepEqual(calls, [
        ["detail", { jobId }],
        ["package", packageId],
      ]);
    },
    {
      codeJobReader: {
        async getDetail(input) {
          calls.push(["detail", input]);
          return detail;
        },
      },
      changePackageReader: {
        async get(input) {
          calls.push(["package", input]);
          return manifest;
        },
      },
    },
  );
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/code/jobs/${jobId}/change-package`,
      });
      assert.equal(response.status, 409);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageReader: {
        async get() {
          return { ...manifest, packageDigest: "0".repeat(64) };
        },
      },
    },
  );
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/code/jobs/${jobId}/change-package`,
      });
      assert.equal(response.status, 404);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageReader: {
        async get() {
          throw Object.assign(new Error("missing package"), {
            code: "CHANGE_PACKAGE_NOT_FOUND",
          });
        },
      },
    },
  );
});

test("code job evidence downloads exact digest-bound bytes without accepting paths", async () => {
  const jobId = `code-job-${"8".repeat(55)}`;
  const packageDigest = "9".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const profileId = "node-tests";
  const kind = "stdout";
  const content = Buffer.from('{"stdout":"tests passed"}\n', "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const calls = [];
  const endpoint = `/api/code/jobs/${jobId}/change-package/${packageId}/evidence/${profileId}/${kind}?packageDigest=${packageDigest}&sha256=${sha256}`;
  await withServer(
    async ({ server }) => {
      const downloaded = await request(server, { path: endpoint });
      assert.equal(downloaded.status, 200);
      assert.deepEqual(downloaded.rawBody, content);
      assert.equal(downloaded.headers["content-length"], String(content.length));
      assert.equal(downloaded.headers["x-content-sha256"], sha256);
      assert.equal(downloaded.headers.etag, `"${sha256}"`);
      assert.equal(
        downloaded.headers["content-digest"],
        `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`,
      );
      assert.match(
        downloaded.headers["content-disposition"],
        new RegExp(`attachment; filename="${profileId}-${kind}-${sha256.slice(0, 12)}\\.json"`),
      );
      assert.equal(downloaded.headers["x-content-type-options"], "nosniff");

      const invalid = await Promise.all([
        request(server, {
          path: endpoint.replace(`&sha256=${sha256}`, ""),
        }),
        request(server, { path: `${endpoint}&path=private.txt` }),
        request(server, { path: `${endpoint}&sha256=${sha256}` }),
        request(server, {
          path: endpoint.replace(`/${profileId}/${kind}`, "/..%2Fprivate/stdout"),
        }),
      ]);
      assert.deepEqual(invalid.map(({ status }) => status), [400, 400, 400, 404]);
      assert.equal(calls.length, 1);
    },
    {
      codeJobEvidenceReader: {
        async read(input) {
          calls.push(input);
          return {
            jobId,
            packageId,
            packageDigest,
            profileId,
            kind,
            sha256,
            bytes: content.length,
            content,
          };
        },
      },
    },
  );
  assert.deepEqual(calls, [{
    jobId,
    packageId,
    packageDigest,
    profileId,
    kind,
    expectedSha256: sha256,
  }]);
});

test("code job evidence fails before streaming when the reader result is corrupt", async () => {
  const jobId = `code-job-${"7".repeat(55)}`;
  const packageDigest = "6".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const sha256 = "5".repeat(64);
  const endpoint = `/api/code/jobs/${jobId}/change-package/${packageId}/evidence/node-tests/output?packageDigest=${packageDigest}&sha256=${sha256}`;
  await withServer(
    async ({ server, reportedErrors }) => {
      const response = await request(server, { path: endpoint });
      assert.equal(response.status, 500);
      assert.doesNotMatch(response.body, /PRIVATE ARTIFACT/);
      assert.equal(response.headers["content-disposition"], undefined);
      assert.equal(reportedErrors.length, 1);
      assert.equal(reportedErrors[0].statusCode, 500);
    },
    {
      codeJobEvidenceReader: {
        async read() {
          return {
            jobId,
            packageId,
            packageDigest,
            profileId: "node-tests",
            kind: "output",
            sha256,
            bytes: 16,
            content: Buffer.from("PRIVATE ARTIFACT", "utf8"),
          };
        },
      },
    },
  );
});

test("code job evidence keeps an immutable URL binding across an untrusted await", async () => {
  const jobId = `code-job-${"a".repeat(55)}`;
  const packageDigest = "b".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const expectedSha256 = "c".repeat(64);
  const secret = Buffer.from("PRIVATE CROSS-JOB ARTIFACT\n", "utf8");
  const secretSha256 = createHash("sha256").update(secret).digest("hex");
  const endpoint = `/api/code/jobs/${jobId}/change-package/${packageId}/evidence/node-tests/output?packageDigest=${packageDigest}&sha256=${expectedSha256}`;
  await withServer(
    async ({ server, reportedErrors }) => {
      const response = await request(server, { path: endpoint });
      assert.equal(response.status, 500);
      assert.doesNotMatch(response.body, /PRIVATE CROSS-JOB ARTIFACT/);
      assert.equal(response.headers["content-disposition"], undefined);
      assert.equal(reportedErrors.length, 1);
    },
    {
      codeJobEvidenceReader: {
        async read(input) {
          assert.equal(Object.isFrozen(input), true);
          for (const [field, value] of Object.entries({
            jobId: `code-job-${"d".repeat(55)}`,
            packageId: `change-package-${"e".repeat(64)}`,
            packageDigest: "e".repeat(64),
            profileId: "foreign-tests",
            kind: "stderr",
            expectedSha256: secretSha256,
          })) {
            assert.equal(Reflect.set(input, field, value), false);
          }
          return {
            jobId: `code-job-${"d".repeat(55)}`,
            packageId: `change-package-${"e".repeat(64)}`,
            packageDigest: "e".repeat(64),
            profileId: "foreign-tests",
            kind: "stderr",
            sha256: secretSha256,
            bytes: secret.length,
            content: secret,
          };
        },
      },
    },
  );
});

test("code job package apply derives authority and only requests confirmation", async () => {
  const jobId = `code-job-${"1".repeat(55)}`;
  const packageDigest = "2".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  const requestedBy = { roleId: "developer", workItemId: "work-9" };
  const calls = [];
  const agencySignals = [];
  const detail = {
    job: { jobId, revision: 13, requestedBy },
    changePackage: {
      status: "ready",
      receipt: {
        packageId,
        packageDigest,
        deliveredAt: "2026-08-03T02:00:00.000Z",
      },
    },
  };
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(
    async ({ server }) => {
      const accepted = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 13 }),
      });
      const stale = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 12 }),
      });
      const forged = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 13, packageId: "forged" }),
      });
      const wrongContentType = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers: { ...headers, "content-type": "text/plain" },
        body: JSON.stringify({ expectedRevision: 13 }),
      });

      assert.equal(accepted.status, 200);
      assert.deepEqual(JSON.parse(accepted.body), {
        request: { id: "confirmation-package-1", status: "pending" },
      });
      assert.deepEqual(
        [stale.status, forged.status, wrongContentType.status],
        [409, 400, 415],
      );
      assert.deepEqual(calls, [
        { packageId, requestedBy },
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(agencySignals, [
        { trigger: "change_package_application_requested" },
      ]);
    },
    {
      codeJobReader: { async getDetail() { return detail; } },
      changePackageApplicationStatusReader: {
        async getForJob() { return { status: "not_requested" }; },
      },
      changePackageApplicationRequester: {
        async request(input) {
          calls.push(input);
          return { id: "confirmation-package-1", status: "pending" };
        },
      },
      backgroundWork: {
        signalAgency(options) { agencySignals.push(options); },
      },
    },
  );

  for (const [code, status] of [
    ["CHANGE_PACKAGE_APPLICATION_STALE", 409],
    ["CHANGE_PACKAGE_TARGET_DIRTY", 409],
    ["CHANGE_PACKAGE_TARGET_STALE", 409],
    ["CHANGE_PACKAGE_APPLICATION_BINDING_CONFLICT", 409],
    ["INVALID_CHANGE_PACKAGE_APPLICATION", 400],
    ["CHANGE_PACKAGE_APPLICATION_PACKAGE_UNAVAILABLE", 503],
  ]) {
    await withServer(
      async ({ server }) => {
        const response = await request(server, {
          method: "POST",
          path: `/api/code/jobs/${jobId}/change-package/apply`,
          headers,
          body: JSON.stringify({ expectedRevision: 13 }),
        });
        assert.equal(response.status, status, code);
      },
      {
        codeJobReader: { async getDetail() { return detail; } },
        changePackageApplicationStatusReader: {
          async getForJob() { return { status: "not_requested" }; },
        },
        changePackageApplicationRequester: {
          async request() {
            throw Object.assign(new Error("application request rejected"), {
              code,
            });
          },
        },
      },
    );
  }
});

test("package apply fails closed when its lifecycle reader is unavailable", async () => {
  const jobId = `code-job-${"5".repeat(55)}`;
  const packageDigest = "6".repeat(64);
  let requesterCalls = 0;
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedRevision: 4 }),
      });

      assert.equal(response.status, 503);
      assert.equal(requesterCalls, 0);
    },
    {
      codeJobReader: {
        async getDetail() {
          return {
            job: {
              jobId,
              revision: 4,
              requestedBy: { roleId: "developer", workItemId: "work-4" },
            },
            changePackage: {
              status: "ready",
              receipt: {
                packageId: `change-package-${packageDigest}`,
                packageDigest,
              },
            },
          };
        },
      },
      changePackageApplicationRequester: {
        async request() { requesterCalls += 1; },
      },
    },
  );
});

test("a projected application lifecycle blocks duplicate package requests", async () => {
  const jobId = `code-job-${"6".repeat(55)}`;
  const packageDigest = "7".repeat(64);
  const packageId = `change-package-${packageDigest}`;
  let requesterCalls = 0;
  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedRevision: 4 }),
      });
      assert.equal(response.status, 409);
      assert.equal(requesterCalls, 0);
    },
    {
      codeJobReader: {
        async getDetail() {
          return {
            job: {
              jobId,
              revision: 4,
              requestedBy: { roleId: "developer", workItemId: "work-4" },
            },
            changePackage: {
              status: "ready",
              receipt: { packageId, packageDigest },
            },
          };
        },
      },
      changePackageApplicationStatusReader: {
        async getForJob() {
          return {
            status: "pending",
            confirmationId: `confirmation-change-package-apply-${"8".repeat(64)}`,
            requestedBy: { roleId: "developer", workItemId: "work-4" },
            job: { id: jobId, revision: 3, recordDigest: "9".repeat(64) },
            packageId,
            packageDigest,
            workspaceId: "dashboard",
            itemRevision: 1,
            createdAt: "2026-08-03T02:00:00.000Z",
            updatedAt: "2026-08-03T02:00:00.000Z",
          };
        },
      },
      changePackageApplicationRequester: {
        async request() { requesterCalls += 1; },
      },
    },
  );
});

test("code job detail and mutation routes fail closed without required ports", async () => {
  const jobId = `code-job-${"3".repeat(55)}`;
  const headers = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(async ({ server }) => {
    const responses = await Promise.all([
      request(server, { path: `/api/code/jobs/${jobId}` }),
      request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/control`,
        headers,
        body: JSON.stringify({ command: "pause", expectedRevision: 1 }),
      }),
      request(server, { path: `/api/code/jobs/${jobId}/change-package` }),
      request(server, {
        path: `/api/code/jobs/${jobId}/change-package/change-package-${"4".repeat(64)}/evidence/node-tests/output?packageDigest=${"4".repeat(64)}&sha256=${"5".repeat(64)}`,
      }),
      request(server, {
        method: "POST",
        path: `/api/code/jobs/${jobId}/change-package/apply`,
        headers,
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
    ]);
    assert.deepEqual(
      responses.map(({ status }) => status),
      [503, 503, 503, 503, 503],
    );
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

test("unified attention read strictly parses bounded session exclusions", async () => {
  const external = {
    id: "confirmation-pr-work-1",
    approvalBindingDigest: "c".repeat(64),
  };
  const internal = {
    requestId: `attention-${"a".repeat(64)}`,
    contentDigest: "b".repeat(64),
  };
  const reads = [];
  const attentionCoordinator = {
    async next(options) {
      reads.push(options);
      return {
        available: false,
        source: null,
        pendingCount: 0,
        externalEnabled: true,
        externalQueueRevision: 8,
        item: null,
      };
    },
  };
  const deferred = [
    `external:${external.id}:${external.approvalBindingDigest}`,
    `internal:${internal.requestId}:${internal.contentDigest}`,
  ];

  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/attention/next?${deferred
          .map((value) => `deferred=${encodeURIComponent(value)}`)
          .join("&")}`,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(reads, [{ external: [external], internal: [internal] }]);

      const invalidPaths = [
        "/api/attention/next?unknown=1",
        `/api/attention/next?deferred=${encodeURIComponent("external:bad::binding")}`,
        `/api/attention/next?deferred=${encodeURIComponent(deferred[0])}&deferred=${encodeURIComponent(deferred[0])}`,
        `/api/attention/next?${Array.from(
          { length: 33 },
          (_, index) =>
            `deferred=${encodeURIComponent(
              `external:confirmation-${index}:${index.toString(16).padStart(64, "0")}`,
            )}`,
        ).join("&")}`,
      ];
      for (const path of invalidPaths) {
        const invalid = await request(server, { path });
        assert.equal(invalid.status, 400, path);
      }
      assert.equal(reads.length, 1);
    },
    { attentionCoordinator },
  );
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
  const signals = [];
  const backgroundWork = {
    runConfirmationOperation(operation) { return operation(); },
    signalAgency(options) { signals.push(options); },
  };
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
    await new Promise((resolve) => setImmediate(resolve));

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
    assert.deepEqual(signals, Array.from({ length: 3 }, () => ({
      trigger: "confirmation_answered",
    })));
  }, { backgroundWork });
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

test("startup listens immediately but confirmations stay closed until initial reconcile finishes", async () => {
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
    const healthDuringRefresh = await waitForPort(port, {
      path: "/api/health",
    });
    assert.equal(healthDuringRefresh.status, 200);
    const confirmationDuringRefresh = await requestPort(port, {
      path: "/api/confirmations/next",
    });
    assert.equal(confirmationDuringRefresh.status, 503);
    assert.deepEqual(queueCalls, []);

    releaseRefresh.resolve();
    await reconcileStarted.promise;
    assert.equal(startupSettled, false);
    const confirmationDuringReconcile = await requestPort(port, {
      path: "/api/confirmations/next",
    });
    assert.equal(confirmationDuringReconcile.status, 503);
    assert.deepEqual(queueCalls, []);

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

test("initial refresh failure closes the listening server and releases resources", async () => {
  const port = await availablePort();
  const refreshFailure = new Error("initial GitHub refresh failed");
  const initialRefresh = deferred();
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
        initialRefresh: initialRefresh.promise,
        async stop() {
          backgroundStops += 1;
        },
      };
    },
    log() {},
  });
  let server = null;

  try {
    const health = await waitForPort(port, { path: "/api/health" });
    assert.equal(health.status, 200);
    initialRefresh.reject(refreshFailure);
    await assert.rejects(starting, (error) => error === refreshFailure);
  } finally {
    initialRefresh.reject(refreshFailure);
    server = await starting.catch(() => null);
    if (server) await server.shutdown();
  }

  assert.equal(backgroundStops, 1);
  assert.equal(applicationCloses, 1);
  await assert.rejects(
    requestPort(port, { path: "/api/confirmations/next" }),
    (error) => ["ECONNREFUSED", "ECONNRESET"].includes(error.code),
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
    const defaultLimit = await request(server, {
      path: "/api/memory/search?q=checkout",
    });

    assert.equal(response.status, 200);
    assert.equal(defaultLimit.status, 200);
    assert.deepEqual(JSON.parse(response.body).items, [
      { id: "memory-1", title: "Checkout review" },
    ]);
    assert.deepEqual(calls.slice(-2), [
      {
        operation: "memory_search",
        query: "checkout",
        limit: 100,
      },
      {
        operation: "memory_search",
        query: "checkout",
        limit: 30,
      },
    ]);
  });
});

test("unified memory keeps the legacy search shape and reports local health", async () => {
  const memorySearch = {
    async search(options) {
      assert.deepEqual(options, { q: "checkout", limit: 100 });
      return {
        items: [{ id: "memory-2", title: "Unified checkout memory" }],
        nextCursor: null,
        totalMatched: 1,
        indexHealthy: true,
      };
    },
    async getHealth() {
      return {
        ready: true,
        revision: 3,
        recordCount: 8,
        indexHealthy: true,
        lastIndexError: "",
      };
    },
  };
  await withServer(
    async ({ server }) => {
      const search = await request(server, {
        path: "/api/memory/search?q=checkout&limit=999",
      });
      const health = await request(server, { path: "/api/health" });

      assert.equal(search.status, 200);
      assert.deepEqual(JSON.parse(search.body), {
        query: "checkout",
        items: [{ id: "memory-2", title: "Unified checkout memory" }],
      });
      assert.deepEqual(JSON.parse(health.body).memory, {
        ready: true,
        revision: 3,
        recordCount: 8,
        indexHealthy: true,
        lastIndexError: "",
      });
    },
    { memorySearch },
  );
});

test("unified memory query forwards only bounded filters and pagination", async () => {
  const calls = [];
  const cursor = Buffer.from(
    JSON.stringify(["2026-08-02T01:02:03.000Z", `memory-${"a".repeat(64)}`]),
  ).toString("base64url");
  const memorySearch = {
    async search(options) {
      calls.push(options);
      return {
        items: [],
        nextCursor: null,
        totalMatched: 0,
        indexHealthy: true,
      };
    },
    async getHealth() {
      return { ready: true };
    },
  };
  const query = new URLSearchParams({
    q: "结算失败",
    roleId: "requirements-analyst",
    repository: "acme/repo",
    eventType: "requirements.clarified",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
    limit: "5",
    cursor,
  });

  await withServer(
    async ({ server }) => {
      const response = await request(server, {
        path: `/api/memory/query?${query}`,
      });
      const unknown = await request(server, {
        path: "/api/memory/query?debug=1",
      });
      const duplicate = await request(server, {
        path: "/api/memory/query?q=one&q=two",
      });

      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.body), {
        items: [],
        nextCursor: null,
        totalMatched: 0,
        indexHealthy: true,
      });
      assert.deepEqual(calls, [Object.fromEntries(query)]);
      assert.equal(unknown.status, 400);
      assert.equal(duplicate.status, 400);
    },
    { memorySearch },
  );
});

test("unified memory query fails closed when the local journal is unavailable", async () => {
  await withServer(async ({ server }) => {
    const response = await request(server, { path: "/api/memory/query?q=test" });

    assert.equal(response.status, 503);
  });
});

test("cited memory answering is an explicit same-origin bounded operation", async () => {
  const calls = [];
  const input = {
    schemaVersion: 1,
    question: "测试为什么失败？",
    mode: "configured",
    retrieval: {
      kind: "query",
      filters: { query: "测试失败", repository: "acme/repo" },
    },
  };
  const result = {
    schemaVersion: 1,
    status: "insufficient_evidence",
    answer: "证据不足",
    derived: false,
    claims: [],
    citations: [],
    context: {
      contextDigest: "a".repeat(64),
      recordIds: [],
      records: [],
    },
    brain: {
      mode: "configured",
      provider: "ollama",
      model: "qwen",
      remote: false,
    },
    localRerunAvailable: true,
  };
  await withServer(
    async ({ server }) => {
      const body = JSON.stringify(input);
      const accepted = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json; charset=utf-8",
        },
        body,
      });
      const crossOrigin = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "https://attacker.example",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body,
      });
      const wrongType = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "text/plain",
        },
        body,
      });

      assert.equal(accepted.status, 200);
      assert.deepEqual(JSON.parse(accepted.body), result);
      assert.equal(crossOrigin.status, 403);
      assert.equal(wrongType.status, 415);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].value, input);
      assert.equal(calls[0].signal?.aborted, false);
    },
    {
      memoryAnswer: {
        async answer(value, { signal } = {}) {
          calls.push({ value: structuredClone(value), signal });
          return structuredClone(result);
        },
      },
    },
  );
});

test("disconnecting a memory answer client cancels server work and frees the next slot", async () => {
  const started = deferred();
  const cancelled = deferred();
  let inFlight = 0;
  let observedSignal = null;
  await withServer(
    async ({ server, reportedErrors }) => {
      const body = JSON.stringify({ slow: true });
      let outgoing;
      const abandoned = new Promise((resolve) => {
        outgoing = http.request({
          host: "127.0.0.1",
          port: server.address().port,
          method: "POST",
          path: "/api/memory/answer",
          headers: {
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-mydashboard-action": "1",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        });
        outgoing.on("response", (response) => {
          response.resume();
          response.on("end", resolve);
        });
        outgoing.on("error", resolve);
        outgoing.end(body);
      });

      await started.promise;
      outgoing.destroy();
      await cancelled.promise;
      await abandoned;

      const next = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ slow: false }),
      });

      assert.equal(observedSignal.aborted, true);
      assert.equal(next.status, 200);
      assert.deepEqual(JSON.parse(next.body), { status: "answered" });
      assert.deepEqual(reportedErrors, []);
    },
    {
      memoryAnswer: {
        async answer(value, { signal }) {
          if (inFlight >= 1) {
            throw Object.assign(new Error("busy"), { statusCode: 429 });
          }
          inFlight += 1;
          try {
            if (!value.slow) return { status: "answered" };
            observedSignal = signal;
            started.resolve();
            await new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                cancelled.resolve();
                reject(Object.assign(new Error("cancelled"), {
                  code: "MEMORY_ANSWER_CANCELLED",
                  statusCode: 499,
                }));
              }, { once: true });
            });
          } finally {
            inFlight -= 1;
          }
        },
      },
    },
  );
});

test("memory answer availability and provider failures remain safely classified", async () => {
  await withServer(async ({ server }) => {
    const unavailable = await request(server, {
      method: "POST",
      path: "/api/memory/answer",
      headers: {
        origin: "http://127.0.0.1:4173",
        "x-mydashboard-action": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ safe: true }),
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(JSON.parse(unavailable.body), { error: "服务器内部错误" });
  });

  const failure = Object.assign(new Error("private provider response"), {
    code: "STRUCTURED_PROVIDER_REQUEST_FAILED",
    statusCode: 502,
  });
  await withServer(
    async ({ server, reportedErrors }) => {
      const response = await request(server, {
        method: "POST",
        path: "/api/memory/answer",
        headers: {
          origin: "http://127.0.0.1:4173",
          "x-mydashboard-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ safe: true }),
      });
      assert.equal(response.status, 502);
      assert.deepEqual(JSON.parse(response.body), { error: "服务器内部错误" });
      assert.deepEqual(reportedErrors, [failure]);
      assert.equal(response.body.includes("private provider response"), false);
    },
    {
      memoryAnswer: {
        async answer() { throw failure; },
      },
    },
  );
});

test("memory session and Git imports require explicit same-origin opt-in ports", async () => {
  const calls = [];
  const session = {
    schemaVersion: 1,
    provider: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-05T01:00:00.000Z",
    title: "Memory work",
    entries: [{
      role: "user",
      occurredAt: "2026-08-05T01:00:01.000Z",
      content: "Continue the command center.",
    }],
  };
  const git = {
    schemaVersion: 1,
    repository: "acme/repo",
    commits: [{
      oid: "a".repeat(40),
      occurredAt: "2026-08-05T01:02:00.000Z",
      author: "Ada",
      subject: "Add memory import",
      body: "",
    }],
  };
  const trustedHeaders = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };

  await withServer(
    async ({ server }) => {
      const sessionResponse = await request(server, {
        method: "POST",
        path: "/api/memory/import/session",
        headers: trustedHeaders,
        body: JSON.stringify(session),
      });
      const gitResponse = await request(server, {
        method: "POST",
        path: "/api/memory/import/git",
        headers: trustedHeaders,
        body: JSON.stringify(git),
      });
      const untrusted = await request(server, {
        method: "POST",
        path: "/api/memory/import/session",
        headers: {
          ...trustedHeaders,
          origin: "https://attacker.example",
        },
        body: JSON.stringify(session),
      });

      assert.equal(sessionResponse.status, 200);
      assert.deepEqual(JSON.parse(sessionResponse.body), {
        schemaVersion: 1,
        kind: "session",
        added: 1,
      });
      assert.equal(gitResponse.status, 200);
      assert.deepEqual(JSON.parse(gitResponse.body), {
        schemaVersion: 1,
        kind: "git",
        added: 1,
      });
      assert.equal(untrusted.status, 403);
      assert.deepEqual(calls, [
        { kind: "session", value: session },
        { kind: "git", value: git },
      ]);
    },
    {
      memoryImports: {
        session: {
          async importSession(value) {
            calls.push({ kind: "session", value: structuredClone(value) });
            return { schemaVersion: 1, kind: "session", added: 1 };
          },
        },
        git: {
          async importCommits(value) {
            calls.push({ kind: "git", value: structuredClone(value) });
            return { schemaVersion: 1, kind: "git", added: 1 };
          },
        },
      },
    },
  );
});

test("disabled and oversized memory imports fail before invoking an importer", async () => {
  const trustedHeaders = {
    origin: "http://127.0.0.1:4173",
    "x-mydashboard-action": "1",
    "content-type": "application/json",
  };
  await withServer(async ({ server }) => {
    const unavailable = await request(server, {
      method: "POST",
      path: "/api/memory/import/session",
      headers: trustedHeaders,
      body: JSON.stringify({ schemaVersion: 1 }),
    });
    assert.equal(unavailable.status, 503);
  });

  let calls = 0;
  await withServer(
    async ({ server }) => {
      const oversized = await request(server, {
        method: "POST",
        path: "/api/memory/import/git",
        headers: trustedHeaders,
        body: "x".repeat(3 * 1024 * 1024 + 1),
      });
      assert.equal(oversized.status, 413);
      assert.equal(calls, 0);
    },
    {
      memoryImports: {
        git: {
          async importCommits() {
            calls += 1;
          },
        },
      },
    },
  );
});
