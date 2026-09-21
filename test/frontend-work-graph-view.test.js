import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWorkView } from "../public/work-view.js";
import {
  normalizeWorkGraphSnapshot,
  renderWorkGraph,
} from "../public/work-graph-view.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function response(value, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return structuredClone(value);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function graphSnapshot({ revision = 7, title = "总任务" } = {}) {
  const emptyContract = {
    revision: 1,
    acceptanceCriteria: [],
    expectedDeliverables: [],
  };
  const deliveryEvidence = [
    {
      kind: "artifact",
      referenceId: "artifact-build-output",
      contentDigest: "b".repeat(64),
    },
  ];
  return {
    schemaVersion: 2,
    totalTaskCount: 3,
    graph: {
      schemaVersion: 1,
      graphId: "work-ledger",
      revision,
      tasks: [
        {
          taskId: "task-root",
          revision: 2,
          parentTaskId: null,
          responsibility: { type: "role", id: "orchestrator<script>" },
          acceptanceContract: emptyContract,
          latestDeliveries: [],
          history: { acceptanceContractCount: 1, deliveryCount: 0 },
          dependsOn: [],
        },
        {
          taskId: "task-research",
          revision: 1,
          parentTaskId: "task-root",
          responsibility: { type: "person", id: "analyst" },
          acceptanceContract: emptyContract,
          latestDeliveries: [],
          history: { acceptanceContractCount: 1, deliveryCount: 0 },
          dependsOn: [],
        },
        {
          taskId: "task-build",
          revision: 3,
          parentTaskId: "task-root",
          responsibility: { type: "role", id: "developer" },
          acceptanceContract: {
              revision: 1,
              acceptanceCriteria: [
                {
                  criterionId: "tests-pass",
                  description: "测试必须通过 <safe>",
                },
              ],
              expectedDeliverables: [
                {
                  deliverableId: "implementation",
                  kind: "change-package",
                  description: "受控代码变更",
                  required: true,
                },
                {
                  deliverableId: "test-report",
                  kind: "test-report",
                  description: "测试报告",
                  required: true,
                },
              ],
            },
          latestDeliveries: [
            {
              deliverableId: "implementation",
              revision: 2,
              contractRevision: 1,
              status: "accepted",
              summary: "实现已验收 <ok>",
              evidence: deliveryEvidence,
            },
          ],
          history: { acceptanceContractCount: 1, deliveryCount: 2 },
          dependsOn: ["task-research"],
        },
      ],
    },
    taskStates: [
      {
        taskId: "task-root",
        taskRevision: 2,
        ledgerStatus: "waiting_user",
        ownerId: null,
        statusReason: "等待确认 <script>alert(1)</script>",
        updatedAt: "2026-08-03T03:59:00.000Z",
        work: { title, description: "统筹子任务" },
      },
      {
        taskId: "task-research",
        taskRevision: 1,
        ledgerStatus: "completed",
        ownerId: "employee-analyst",
        statusReason: null,
        updatedAt: "2026-08-03T03:58:00.000Z",
        work: { title: "梳理需求", description: null },
      },
      {
        taskId: "task-build",
        taskRevision: 3,
        ledgerStatus: "working",
        ownerId: "employee-developer",
        statusReason: null,
        updatedAt: "2026-08-03T03:59:30.000Z",
        work: { title: "实现 <command-center>", description: "只读图界面" },
      },
    ],
  };
}

function readFetch(graphResult) {
  return async (url) => {
    if (url === "/api/work/daily/summary") {
      return response({ itemCounts: {}, safeguards: {} });
    }
    if (url === "/api/work/daily/items?limit=50&order=newest") {
      return response({ items: [{ assignmentId: "ledger-stays-visible", status: "queued" }] });
    }
    if (url === "/api/work/timeline?limit=50&order=newest") {
      return response({ items: [] });
    }
    if (url === "/api/code/jobs?limit=50&order=newest") {
      return response({ enabled: false, items: [] });
    }
    if (url === "/api/work/graph") return graphResult();
    throw new Error(`unexpected URL: ${url}`);
  };
}

test("shared work graph renders a safe task tree with authoritative ledger status", () => {
  const snapshot = normalizeWorkGraphSnapshot(graphSnapshot());
  const html = renderWorkGraph(
    { loaded: true, loading: false, error: "", snapshot },
    { now: Date.parse("2026-08-03T04:00:00.000Z") },
  );

  assert.match(html, /共享任务图/);
  assert.match(html, /3 TASKS · REVISION 7 · READ ONLY/);
  assert.match(html, /根任务/);
  assert.match(html, /子任务 · 父任务 总任务/);
  assert.match(html, /前置依赖/);
  assert.match(html, /task-research/);
  assert.match(html, /岗位 · orchestrator&lt;script&gt;/);
  assert.match(html, /当前执行[^]*employee-developer/);
  assert.match(html, /status-waiting_user[^>]*>等待你答复/);
  assert.match(html, /实现 &lt;command-center&gt;/);
  assert.match(html, /等待确认 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /验收契约 R1/);
  assert.match(html, /测试必须通过 &lt;safe&gt;/);
  assert.match(html, /受控代码变更/);
  assert.match(html, /已接受/);
  assert.match(html, /实现已验收 &lt;ok&gt;/);
  assert.match(html, /artifact-build-output/);
  assert.match(html, /测试报告/);
  assert.match(html, /未提交/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<(?:button|form|input)\b/);
  assert.doesNotMatch(html, /data-(?:create|edit|assign|complete|cancel)/);
});

test("a submitted deliverable is labeled as waiting for review", () => {
  const value = graphSnapshot();
  value.taskStates[2].ledgerStatus = "waiting_external";
  value.taskStates[2].ownerId = null;
  value.taskStates[2].statusReason = "delivery_submitted";

  const html = renderWorkGraph({
    snapshot: normalizeWorkGraphSnapshot(value),
  });

  assert.match(html, /等待交付审核/);
});

test("a paused graph task keeps its explicit ledger status presentation", () => {
  const value = graphSnapshot();
  value.taskStates[2].ledgerStatus = "paused";
  value.taskStates[2].ownerId = null;
  value.taskStates[2].statusReason = "orchestrator-paused";

  const html = renderWorkGraph({
    snapshot: normalizeWorkGraphSnapshot(value),
  });

  assert.match(html, /status-paused[^>]*>已暂停/);
  assert.doesNotMatch(html, /未知状态 · paused/);
});

test("shared work graph rejects mismatched and cyclic browser projections", () => {
  const legacy = graphSnapshot();
  legacy.schemaVersion = 1;
  delete legacy.totalTaskCount;
  assert.throws(
    () => normalizeWorkGraphSnapshot(legacy),
    /工作图数据格式无效/,
  );

  const invalidTotal = graphSnapshot();
  invalidTotal.totalTaskCount = 2;
  assert.throws(
    () => normalizeWorkGraphSnapshot(invalidTotal),
    /工作图数据格式无效/,
  );

  const mismatched = graphSnapshot();
  mismatched.taskStates[0].taskRevision = 99;
  assert.throws(
    () => normalizeWorkGraphSnapshot(mismatched),
    /工作图数据格式无效/,
  );

  const cyclic = graphSnapshot();
  cyclic.graph.tasks[0].parentTaskId = "task-build";
  assert.throws(
    () => normalizeWorkGraphSnapshot(cyclic),
    /工作图数据格式无效/,
  );

  const dependencyCycle = graphSnapshot();
  dependencyCycle.graph.tasks[1].dependsOn = ["task-build"];
  assert.throws(
    () => normalizeWorkGraphSnapshot(dependencyCycle),
    /工作图数据格式无效/,
  );

  const duplicateDependency = graphSnapshot();
  duplicateDependency.graph.tasks[2].dependsOn = [
    "task-research",
    "task-research",
  ];
  assert.throws(
    () => normalizeWorkGraphSnapshot(duplicateDependency),
    /工作图数据格式无效/,
  );

  const danglingDependency = graphSnapshot();
  danglingDependency.graph.tasks[2].dependsOn = ["task-not-in-window"];
  assert.throws(
    () => normalizeWorkGraphSnapshot(danglingDependency),
    /工作图数据格式无效/,
  );

  const extraField = graphSnapshot();
  extraField.graph.tasks[0].internalOnly = "must not cross the HTTP boundary";
  assert.throws(
    () => normalizeWorkGraphSnapshot(extraField),
    /工作图数据格式无效/,
  );
});

test("server-selected graph windows render their total task count", () => {
  const value = graphSnapshot();
  const contract = value.graph.tasks[0].acceptanceContract;
  value.totalTaskCount = 400;
  value.graph.tasks = Array.from({ length: 300 }, (_, index) => ({
    taskId: `task-${String(index).padStart(3, "0")}`,
    revision: 1,
    parentTaskId: null,
    responsibility: { type: "role", id: "orchestrator" },
    acceptanceContract: structuredClone(contract),
    latestDeliveries: [],
    history: { acceptanceContractCount: 1, deliveryCount: 0 },
    dependsOn: [],
  }));
  value.taskStates = value.graph.tasks.map((task, index) => ({
    taskId: task.taskId,
    taskRevision: 1,
    ledgerStatus: "queued",
    ownerId: null,
    statusReason: null,
    updatedAt: new Date(Date.parse("2026-08-03T04:00:00.000Z") - index * 1_000)
      .toISOString(),
    work: { title: `任务 ${index}`, description: null },
  }));

  const html = renderWorkGraph({
    snapshot: normalizeWorkGraphSnapshot(value),
  });

  assert.equal((html.match(/class="work-graph-card"/g) || []).length, 300);
  assert.match(html, /显示按最新更新选出的任务及其必需上下文 300 \/ 400 项/);
});

test("a graph read failure does not blank the core work ledger", async () => {
  const view = createWorkView({
    fetchImpl: readFetch(() =>
      response({ error: "graph projection unavailable" }, false, 503),
    ),
  });

  await view.load();

  assert.match(view.render(), /ledger-stays-visible/);
  assert.match(view.render(), /共享任务图暂不可读取/);
  assert.match(view.render(), /graph projection unavailable/);
  assert.equal(view.needsLoad(), true);
});

test("a failed graph refresh keeps the last complete snapshot visibly marked", async () => {
  let failGraph = false;
  const view = createWorkView({
    fetchImpl: readFetch(() =>
      failGraph
        ? response({ error: "temporary graph failure" }, false, 503)
        : response(graphSnapshot({ title: "last-good-graph" }))),
  });

  await view.load();
  failGraph = true;
  await view.load();

  const html = view.render();
  assert.match(html, /last-good-graph/);
  assert.match(html, /刷新共享任务图失败/);
  assert.match(html, /temporary graph failure/);
  assert.match(html, /上次成功读取的 revision 7/);
});

test("an older graph response cannot replace a newer complete snapshot", async () => {
  const firstGraph = deferred();
  let graphRequest = 0;
  const view = createWorkView({
    fetchImpl: readFetch(() => {
      graphRequest += 1;
      return graphRequest === 1
        ? firstGraph.promise
        : response(graphSnapshot({ revision: 9, title: "newest-graph" }));
    }),
  });

  const firstLoad = view.load();
  const secondLoad = view.load();
  await secondLoad;
  firstGraph.resolve(response(graphSnapshot({ revision: 8, title: "stale-graph" })));
  await firstLoad;

  const html = view.render();
  assert.match(html, /newest-graph/);
  assert.match(html, /REVISION 9/);
  assert.doesNotMatch(html, /stale-graph/);
  assert.equal(view.needsLoad(), false);
});

test("shared graph frontend remains a read-only GET consumer", async () => {
  const workViewSource = await readFile(
    path.resolve(testDirectory, "../public/work-view.js"),
    "utf8",
  );
  const graphViewSource = await readFile(
    path.resolve(testDirectory, "../public/work-graph-view.js"),
    "utf8",
  );
  const stylesSource = await readFile(
    path.resolve(testDirectory, "../public/styles.css"),
    "utf8",
  );
  const graphReader = workViewSource.slice(
    workViewSource.indexOf("async function readWorkGraph"),
    workViewSource.indexOf("async function reloadCodeJobs"),
  );

  assert.match(graphReader, /fetchImpl\("\/api\/work\/graph"/);
  assert.doesNotMatch(graphReader, /method\s*:/);
  assert.doesNotMatch(graphReader, /x-mydashboard-action/);
  assert.doesNotMatch(graphViewSource, /<(?:button|form|input)\b/);
  assert.doesNotMatch(graphViewSource, /data-(?:create|edit|assign|complete|cancel)/);
  assert.match(
    stylesSource,
    /\.work-graph-children \.work-graph-children\s*\{[^}]*margin-left:\s*0;[^}]*padding-left:\s*0;/s,
  );
});
