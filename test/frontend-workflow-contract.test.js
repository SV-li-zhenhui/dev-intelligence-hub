import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createWorkflowView,
  renderWorkflowView,
  workflowExplanationLines,
} from "../public/workflow-view.js";

const root = path.resolve(import.meta.dirname, "..");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function routingDefinition(overrides = {}) {
  return {
    current: {
      version: 3,
      digest: "1234567890abcdef",
      definition: {
        enabled: true,
        maxHops: 8,
        rules: [
          {
            id: "pr-review",
            enabled: true,
            priority: 100,
            fallback: false,
            source: "github",
            targets: [{ type: "role", id: "pr-reviewer" }],
            onMatch: "stop",
            condition: { op: "equals", path: "eventType", value: "pull_request.updated" },
          },
        ],
      },
      ...overrides,
    },
  };
}

test("workflow command view remains isolated behind the app render seam", async () => {
  const html = await readFile(path.join(root, "public", "index.html"), "utf8");
  const app = await readFile(path.join(root, "public", "app.js"), "utf8");

  assert.match(html, /data-view="workflow"/);
  assert.match(html, /<span>工作流<\/span><kbd>8<\/kbd>/);
  assert.match(app, /import \{ createWorkflowView \} from "\.\/workflow-view\.js"/);
  assert.match(app, /workflow:\s*"工作流指挥"/);
  assert.match(app, /workflow:\s*\(\) => workflowView\.render\(\)/);
  assert.match(app, /workflowView\.bind\(content\)/);
  assert.match(app, /\^\[1-9\]\$/);
  assert.equal(app.includes("/api/workflow/"), false);
  assert.equal((html.match(/id="confirmation-dialog"/g) || []).length, 1);
});

test("workflow controller loads routing, newest assignments, and audit explanations", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/workflow/routing") return jsonResponse(routingDefinition());
    if (url === "/api/workflow/assignments?limit=30") {
      return jsonResponse({
        items: [
          {
            subject: { repository: "owner/repo", number: 42 },
            target: { type: "role", id: "pr-reviewer" },
            eventType: "pull_request.updated",
            ruleId: "pr-review",
            configVersion: 3,
            reason: "规则已匹配",
            createdAt: "2026-08-02T08:00:00.000Z",
          },
        ],
      });
    }
    return jsonResponse({
      items: [
        {
          subject: { repository: "owner/repo", number: 43 },
          outcome: "unmatched",
          assignmentIds: [],
          eventType: "issue.updated",
          matchedRuleIds: [],
          explanation: {
            rules: [{ ruleId: "pr-review", status: "condition_not_matched" }],
          },
          createdAt: "2026-08-02T08:00:00.000Z",
        },
      ],
    });
  };
  const view = createWorkflowView({
    fetchImpl,
    clock: () => Date.parse("2026-08-02T08:01:00.000Z"),
  });

  await view.load();

  assert.deepEqual(
    calls.map(({ url, options }) => ({ url, options })),
    [
      { url: "/api/workflow/routing", options: { cache: "no-store" } },
      { url: "/api/workflow/assignments?limit=30", options: { cache: "no-store" } },
      { url: "/api/workflow/audit?limit=30", options: { cache: "no-store" } },
    ],
  );
  const markup = view.render();
  for (const visibleText of [
    "当前路由配置",
    "最新分派",
    "owner/repo #42",
    "未匹配 / 审计解释",
    "pr-review：条件未命中",
    "没有产生分派",
  ]) {
    assert.equal(markup.includes(visibleText), true, visibleText);
  }
});

test("workflow pure renderer covers loading, error, empty, and escaped server content", () => {
  assert.match(renderWorkflowView({ loaded: false }), /正在读取工作流配置/);
  assert.match(
    renderWorkflowView({ loaded: true, error: "offline", routing: null }),
    /工作流暂不可用.*offline/s,
  );
  assert.match(
    renderWorkflowView({ loaded: true, error: "", routing: null }),
    /尚未配置工作流路由/,
  );

  const attack = '<img src=x onerror="alert(1)">';
  const emptyMarkup = renderWorkflowView({
    loaded: true,
    error: "",
    routing: routingDefinition(),
    assignments: [],
    audit: [],
    dryRunInput: "{}",
    dryRunLoading: false,
    dryRunResult: null,
    dryRunError: "",
  });
  assert.match(emptyMarkup, /尚无分派记录/);
  assert.match(emptyMarkup, /尚无审计记录/);

  const markup = renderWorkflowView({
    loaded: true,
    error: "",
    routing: routingDefinition({
      definition: {
        enabled: true,
        maxHops: attack,
        rules: [
          {
            id: attack,
            enabled: true,
            priority: attack,
            source: attack,
            targets: [{ type: "role", id: attack }],
            onMatch: "stop",
            condition: { value: attack },
          },
        ],
      },
    }),
    assignments: [
      {
        subject: { repository: attack, number: 42 },
        target: { type: "role", id: attack },
        eventType: attack,
        ruleId: attack,
        configVersion: attack,
        reason: attack,
        createdAt: "2026-08-02T08:00:00.000Z",
      },
    ],
    audit: [
      {
        subject: { id: attack },
        outcome: attack,
        assignmentIds: [],
        eventType: attack,
        matchedRuleIds: [attack],
        explanation: attack,
        createdAt: "2026-08-02T08:00:00.000Z",
      },
    ],
    dryRunInput: attack,
    dryRunLoading: false,
    dryRunResult: {
      outcome: attack,
      assignments: [{ target: { type: "role", id: attack } }],
      explanation: attack,
    },
    dryRunError: "",
  });

  assert.equal(markup.includes(attack), false);
  assert.match(markup, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("structured workflow explanations preserve meaningful rule outcomes", () => {
  assert.deepEqual(
    workflowExplanationLines({
      usedFallback: true,
      rules: [
        { ruleId: "primary", status: "condition_not_matched" },
        { ruleId: "fallback", status: "matched" },
      ],
    }),
    ["primary：条件未命中", "fallback：命中", "本次使用了兜底规则"],
  );
});

test("workflow dry-run posts only the event through the same-origin action contract", async () => {
  const calls = [];
  const view = createWorkflowView({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === "/api/workflow/routing") return jsonResponse(routingDefinition());
      if (url === "/api/workflow/assignments?limit=30") {
        return jsonResponse({ items: [] });
      }
      if (url === "/api/workflow/audit?limit=30") {
        return jsonResponse({ items: [] });
      }
      return jsonResponse({
        outcome: "assigned",
        assignments: [{ target: { type: "role", id: "pr-reviewer" } }],
        explanation: { rules: [{ ruleId: "pr-review", status: "matched" }] },
      });
    },
  });
  const event = {
    schemaVersion: 1,
    eventType: "pull_request.updated",
    source: { provider: "github", scopeId: "github-dashboard" },
    subject: { id: "pr-42", repository: "owner/repo", number: 42 },
    occurredAt: "2026-08-02T08:00:00.000Z",
    payload: {},
  };

  await view.load();
  await view.submitDryRun(JSON.stringify(event));

  const dryRunCall = calls.at(-1);
  assert.equal(calls.length, 4);
  assert.equal(dryRunCall.url, "/api/workflow/dry-run");
  assert.equal(dryRunCall.options.method, "POST");
  assert.deepEqual(dryRunCall.options.headers, {
    "content-type": "application/json",
    "x-mydashboard-action": "1",
  });
  assert.deepEqual(JSON.parse(dryRunCall.options.body), { event });
  assert.equal(Object.keys(JSON.parse(dryRunCall.options.body)).length, 1);
  assert.match(view.render(), /模拟结果：assigned.*岗位 · pr-reviewer.*pr-review：命中/s);

  const sources = await Promise.all([
    readFile(path.join(root, "public", "app.js"), "utf8"),
    readFile(path.join(root, "public", "workflow-view.js"), "utf8"),
  ]);
  assert.equal(sources.some((source) => source.includes("/api/workflow/dispatch")), false);
  assert.equal(sources.some((source) => source.includes("/api/workflow/routing/replace")), false);
});

test("invalid dry-run JSON stays local and renders a safe error", async () => {
  let dryRunFetchCalls = 0;
  const view = createWorkflowView({
    fetchImpl: async (url) => {
      if (url === "/api/workflow/routing") return jsonResponse(routingDefinition());
      if (url === "/api/workflow/assignments?limit=30") return jsonResponse({ items: [] });
      if (url === "/api/workflow/audit?limit=30") return jsonResponse({ items: [] });
      dryRunFetchCalls += 1;
      return jsonResponse({ outcome: "unmatched", assignments: [] });
    },
  });

  await view.load();
  await view.submitDryRun("<not-json>");

  assert.equal(dryRunFetchCalls, 0);
  assert.match(view.render(), /事件 JSON 格式无效/);
  assert.equal(view.render().includes("<not-json>"), false);
});

test("owner work form submits only structured business fields and preserves retry identity", async () => {
  const calls = [];
  const ids = [
    "123e4567-e89b-42d3-a456-426614174000",
    "123e4567-e89b-42d3-a456-426614174001",
  ];
  let ownerAttempts = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/workflow/routing") return jsonResponse(routingDefinition());
    if (url === "/api/workflow/assignments?limit=30") {
      return jsonResponse({ items: [] });
    }
    if (url === "/api/workflow/audit?limit=30") {
      return jsonResponse({ items: [] });
    }
    ownerAttempts += 1;
    if (ownerAttempts === 1) {
      return jsonResponse({ error: "temporarily unavailable" }, 503);
    }
    const submitted = JSON.parse(options.body);
    return jsonResponse({
      deduplicated: true,
      requestId: submitted.requestId,
      phase: "intaken",
      assignment: { target: { type: "role", id: "orchestrator" } },
      workItemId: `work-item-${"a".repeat(64)}`,
    });
  };
  const view = createWorkflowView({
    fetchImpl,
    requestIdFactory: () => ids.shift(),
  });
  await view.load();
  const draft = {
    workType: "development",
    priority: "high",
    title: "Implement bounded intake",
    description: "Use the trusted command-center route.",
    acceptanceCriteria: "One root\nNo injected role\n",
  };
  await view.submitOwnerRequest(draft);
  assert.match(view.render(), /temporarily unavailable/);
  await view.submitOwnerRequest(draft);

  const ownerCalls = calls.filter(({ url }) => url === "/api/work/requests");
  assert.equal(ownerCalls.length, 2);
  const first = JSON.parse(ownerCalls[0].options.body);
  const second = JSON.parse(ownerCalls[1].options.body);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), [
    "acceptanceCriteria",
    "description",
    "priority",
    "requestId",
    "schemaVersion",
    "title",
    "workType",
  ]);
  assert.equal(first.requestId, "123e4567-e89b-42d3-a456-426614174000");
  assert.deepEqual(first.acceptanceCriteria, ["One root", "No injected role"]);
  assert.equal("roleId" in first, false);
  assert.equal("nodeId" in first, false);
  assert.equal("permissions" in first, false);
  assert.deepEqual(ownerCalls[1].options.headers, {
    "content-type": "application/json",
    "x-mydashboard-action": "1",
  });
  const markup = view.render();
  assert.match(markup, /创建共享工作/);
  assert.match(markup, /页面不能指定/);
  assert.match(markup, /请求已存在，已返回同一任务/);
  assert.match(markup, /岗位 · orchestrator/);
  assert.equal(markup.includes("事件 JSON（使用当前配置模拟）"), true);
});

test("PR owner work submits a structured repository and number without browser authority fields", async () => {
  let submitted;
  const view = createWorkflowView({
    fetchImpl: async (url, options) => {
      if (url === "/api/workflow/routing") return jsonResponse(routingDefinition());
      if (url === "/api/workflow/assignments?limit=30") return jsonResponse({ items: [] });
      if (url === "/api/workflow/audit?limit=30") return jsonResponse({ items: [] });
      submitted = JSON.parse(options.body);
      return jsonResponse({
        deduplicated: false,
        requestId: submitted.requestId,
        phase: "intaken",
        assignment: { target: { type: "role", id: "pr-engineer" } },
        workItemId: `work-item-${"a".repeat(64)}`,
      }, 201);
    },
    requestIdFactory: () => "123e4567-e89b-42d3-a456-426614174000",
  });
  await view.load();
  await view.submitOwnerRequest({
    workType: "pull_request",
    priority: "high",
    title: "Review selected PR",
    description: "Use an independent owner-requested source.",
    acceptanceCriteria: "Bind the current Head",
    pullRequestRepository: "acme/repo",
    pullRequestNumber: "42",
  });

  assert.deepEqual(submitted.pullRequest, {
    repository: "acme/repo",
    number: 42,
  });
  assert.equal(submitted.schemaVersion, 2);
  assert.equal("roleId" in submitted, false);
  assert.match(view.render(), /pr-engineer/);
});
