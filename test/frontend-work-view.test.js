import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createWorkView,
  escapeWorkHtml,
  renderWorkView,
} from "../public/work-view.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function response(value, ok = true, status = 200) {
  return { ok, status, async json() { return structuredClone(value); } };
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

test("frontend work module contains no mutation or internal execution route", async () => {
  const source = await readFile(
    path.resolve(testDirectory, "../public/work-view.js"),
    "utf8",
  );

  assert.doesNotMatch(source, /method:\s*["']POST["']/);
  assert.doesNotMatch(source, /\/api\/work\/(?:intake|claim|stage|dispatch|outbox)/);
  assert.doesNotMatch(source, /data-(?:claim|dispatch|execute)/);
  assert.doesNotMatch(source, /\/api\/code\/jobs[^"']*\/(?:run|apply|commit|push)/);
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
