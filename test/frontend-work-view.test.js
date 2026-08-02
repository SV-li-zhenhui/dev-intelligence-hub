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

test("work view escapes records and clearly displays safety posture", () => {
  const html = renderWorkView({
    loaded: true,
    error: "",
    summary: {
      itemCounts: { queued: 2, working: 1, blocked: 3, completed: 4 },
      safeguards: { prEmployeePaused: true, externalActionsEnabled: false },
    },
    items: [{
      assignmentId: "assignment-1",
      status: "waiting_user",
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
  assert.match(html, /requirements-analyst/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /本地代码任务/);
  assert.match(html, /最近动作 complete · 成功/);
  assert.match(html, /终态：已完成/);
  assert.doesNotMatch(html, /PRIVATE EXECUTOR RESULT/);
  assert.equal(escapeWorkHtml('"<&'), "&quot;&lt;&amp;");
});

test("code jobs render every safe lifecycle state from browser projections", () => {
  const statuses = [
    ["queued", "已授权，等待执行"],
    ["starting", "正在准备隔离工作区"],
    ["active", "受控执行中"],
    ["pausing", "正在安全暂停"],
    ["unknown", "状态待核验"],
    ["paused", "已暂停"],
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
      terminalResult: ["completed", "failed", "fenced"].includes(status)
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
    "申请应用变更包",
  ]) {
    assert.equal(html.includes(visible), true, visible);
  }
  assert.match(html, /修复 &lt;unsafe&gt; 分支/);
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
  for (const operation of ["control", "apply"]) {
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
          },
        },
      });
      const view = createWorkView({
        fetchImpl: async (url, options = {}) => {
          if (
            options.method === "POST" &&
            ((operation === "control" && url.endsWith("/control")) ||
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
          throw new Error(`unexpected request: ${url}`);
        },
        onDetail: (markup) => details.push(markup),
        onDetailClose: () => { closed += 1; },
        onNotice: (message) => { notice = message; },
      });

      await view.openCodeJob("code-job-a");
      const pendingMutation = operation === "control"
        ? view.controlCodeJob("pause")
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
  ];
  const view = createWorkView({
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return response(values[calls.length - 1]);
    },
  });

  await view.load();

  assert.deepEqual(calls.map(([url]) => url), [
    "/api/work/summary",
    "/api/work/items?limit=50&order=newest",
    "/api/work/timeline?limit=50&order=newest",
    "/api/code/jobs?limit=50&order=newest",
  ]);
  assert.equal(calls.every(([, options]) => options.cache === "no-store"), true);
  assert.match(view.render(), /newest/);
  assert.match(view.render(), /latest/);
  assert.match(view.render(), /code-job-newest|已授权，等待执行/);
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
      if (url === "/api/work/summary") {
        return response({ itemCounts: {}, safeguards: {} });
      }
      return response({ items: [{ assignmentId: "core-still-visible", status: "queued" }] });
    },
  });

  await view.load();
  assert.match(view.render(), /core-still-visible/);
  assert.match(view.render(), /code subsystem unavailable/);
});
