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
      id: "code-job-1",
      roleId: "developer",
      repository: "acme/repo",
      workspaceId: "acme-workspace",
      operation: "modify",
      status: "completed",
      phase: "seal",
      lastActionType: "complete",
      turnCount: 3,
      updatedAt: "2026-08-02T03:59:45.000Z",
      result: {
        summary: "<img src=x onerror=alert(1)>",
        modifiedFiles: ["src/<unsafe>.js"],
        profiles: [{ id: "node-tests", status: "passed" }],
        manifestDigest: "a".repeat(64),
      },
    }],
  }, { now: Date.parse("2026-08-02T04:00:00.000Z") });

  assert.match(html, /PR 新循环：暂停 \/ 旧员工独占/);
  assert.match(html, /GitHub 外部写：关闭/);
  assert.match(html, /requirements-analyst/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /本地代码任务/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /src\/&lt;unsafe&gt;\.js/);
  assert.equal(escapeWorkHtml('"<&'), "&quot;&lt;&amp;");
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
