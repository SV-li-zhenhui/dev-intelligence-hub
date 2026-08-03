import assert from "node:assert/strict";
import test from "node:test";
import { EmployeeRegistry } from "../src/services/employee-registry.js";
import { RoleWorkerDirectory } from "../src/services/role-worker-directory.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { ConfiguredRoleEmployee } from "../src/services/configured-role-employee.js";
import { RoleDecisionEngine } from "../src/services/role-decision-engine.js";

class MemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback = null) {
    return structuredClone(this.values.has(name) ? this.values.get(name) : fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function completeDecision(overrides = {}) {
  return {
    schemaVersion: 1,
    confidence: 88,
    summary: "已形成岗位判断。",
    intent: {
      schemaVersion: 1,
      type: "complete",
      summary: "工作已完成。",
      reason: "已经具备充分证据。",
      outcome: "done",
      evidence: ["验证记录"],
    },
    ...overrides,
  };
}

function orchestrationDecision() {
  const reason = "等待依赖任务恢复";
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "应暂停当前任务",
    intent: {
      schemaVersion: 1,
      type: "orchestrate",
      summary: "暂停当前任务",
      reason,
      action: {
        schemaVersion: 1,
        type: "pause",
        sourceTaskId: "work-item-root",
        sourceTaskRevision: 4,
        expectedGraphRevision: 8,
        reason,
      },
    },
  };
}

function deliveryDecision() {
  return {
    schemaVersion: 1,
    confidence: 89,
    summary: "提交岗位交付物",
    intent: {
      schemaVersion: 1,
      type: "submit_delivery",
      taskId: "work-item-development",
      expectedTaskRevision: 6,
      expectedGraphRevision: 9,
      contractRevision: 1,
      deliverableId: "implementation",
      summary: "实现与聚焦测试已经完成",
      reason: "当前证据满足交付条件",
      evidence: [{
        kind: "change-package",
        referenceId: "change-package:development:1",
        contentDigest: "a".repeat(64),
      }],
      artifact: null,
    },
  };
}

function definition(id, scheduleMinutes = 5) {
  return {
    id,
    name: `岗位 ${id}`,
    mission: `负责 ${id} 工作`,
    enabled: true,
    scheduleMinutes,
  };
}

function permissions(...allowedIntents) {
  return { allowedIntents };
}

function brain(overrides = {}) {
  return {
    provider: "local-brain",
    model: "role-model",
    remoteData: { requirements: false, code: false, memory: false },
    ...overrides,
  };
}

function fakeDecisionEngine(id, calls = []) {
  return {
    async decide(input) {
      calls.push({ id, input: structuredClone(input) });
      return completeDecision();
    },
    view() {
      return {
        definition: definition(id),
        permissions: permissions("complete"),
        brain: { ...brain(), remote: false },
      };
    },
  };
}

test("RoleDecisionEngine classifies context, routes the configured brain, and normalizes output", async () => {
  const calls = [];
  const router = {
    async generate(request) {
      calls.push(request);
      return JSON.stringify(completeDecision());
    },
    describe(config) {
      return Object.freeze({
        provider: config.provider,
        model: config.model,
        remote: true,
        remoteData: structuredClone(config.remoteData),
      });
    },
  };
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({
      provider: "remote-brain",
      remoteData: { requirements: true, code: true, memory: false },
    }),
    brainRouter: router,
    contextFactory: async ({ item, trigger }) => ({
      requirements: { trigger, title: item.event.subject.title },
      code: { files: ["src/app.js"] },
    }),
  });

  const result = await engine.decide({
    item: { event: { subject: { title: "修复登录" } } },
    trigger: "assigned",
  });

  assert.deepEqual(result, completeDecision());
  assert.deepEqual(calls[0].dataClasses, ["requirements", "code"]);
  assert.match(calls[0].messages[0].content, /developer/);
  assert.match(calls[0].messages[0].content, /untrusted|不可信/i);
  assert.deepEqual(JSON.parse(calls[0].messages[1].content), {
    requirements: { trigger: "assigned", title: "修复登录" },
    code: { files: ["src/app.js"] },
  });
  assert.equal(engine.view().brain.remoteData.memory, false);
});

test("RoleDecisionEngine uses supplied trusted context without invoking its legacy factory", async () => {
  let contextFactoryCalls = 0;
  let request;
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: {
      async generate(value) {
        request = value;
        return JSON.stringify(completeDecision());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
    contextFactory: async () => {
      contextFactoryCalls += 1;
      return { requirements: { forbidden: true } };
    },
  });
  const context = {
    requirements: { taskId: "task-1" },
    code: { acceptedDependencies: [] },
  };

  await engine.decide({
    item: { privateLease: "must-not-be-read" },
    trigger: "employee:developer",
    context,
  });

  assert.equal(contextFactoryCalls, 0);
  assert.deepEqual(JSON.parse(request.messages[1].content), context);
  assert.deepEqual(request.dataClasses, ["requirements", "code"]);
  await assert.rejects(
    engine.decide({ context: { secret: { value: true } } }),
    /role context is invalid/,
  );
});

test("RoleDecisionEngine rejects intents outside the independent role permissions", async () => {
  const forbidden = completeDecision({
    intent: {
      schemaVersion: 1,
      type: "propose_code_action",
      summary: "修改代码。",
      reason: "发现了缺陷。",
      operation: "modify",
      objective: "修复缺陷",
      acceptanceCriteria: ["测试通过"],
      evidence: ["失败测试"],
    },
  });
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("ask_user", "handoff", "complete"),
    brain: brain(),
    brainRouter: {
      async generate() {
        return JSON.stringify(forbidden);
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  await assert.rejects(
    engine.decide({ item: { id: "work-1" }, trigger: "assigned" }),
    (error) => error.code === "ROLE_INTENT_NOT_PERMITTED",
  );
});

test("RoleDecisionEngine permits configured orchestration and delivery intents", async () => {
  const responses = [orchestrationDecision(), deliveryDecision()];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("orchestrate", "submit_delivery"),
    brain: brain(),
    brainRouter: {
      async generate() {
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  const coordinated = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });
  const delivered = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });

  assert.equal(coordinated.intent.type, "orchestrate");
  assert.equal(coordinated.intent.action.type, "pause");
  assert.equal(delivered.intent.type, "submit_delivery");
  assert.deepEqual(engine.view().permissions.allowedIntents, [
    "orchestrate",
    "submit_delivery",
  ]);
});

test("RoleDecisionEngine explains and repairs the orchestration reason binding", async () => {
  const invalid = orchestrationDecision();
  invalid.intent.reason = "wrapper reason differs";
  const responses = [invalid, orchestrationDecision()];
  const requests = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("orchestrate"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        requests.push(request);
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  const result = await engine.decide();

  assert.equal(result.intent.action.type, "pause");
  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0].content, /exactly identical/);
  assert.match(requests[1].messages.at(-1).content, /exactly equal/);
});

test("RoleDecisionEngine retries one invalid structured response without replaying it", async () => {
  const calls = [];
  const invalidResponse = "untrusted invalid model output";
  const router = {
    async generate(request) {
      calls.push(request);
      return calls.length === 1
        ? invalidResponse
        : JSON.stringify(completeDecision());
    },
    describe(config) {
      return {
        provider: config.provider,
        model: config.model,
        remote: false,
        remoteData: structuredClone(config.remoteData),
      };
    },
  };
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
  });

  const result = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
    trigger: "assigned",
  });

  assert.equal(result.intent.type, "complete");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[1]).includes(invalidResponse), false);
  assert.match(calls[1].messages.at(-1).content, /corrected JSON object/);
});

test("the default role context separates PR code from minimum requirements data", async () => {
  let routed;
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        routed = request;
        return JSON.stringify(completeDecision());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  await engine.decide({
    item: {
      itemId: "work-1",
      ownerId: "internal-owner",
      assignment: { reason: "review_requested" },
      event: { eventType: "pull_request.observed" },
      decisionContext: { value: { answer: "check the boundary" } },
    },
    trigger: "assigned",
  });

  assert.deepEqual(routed.dataClasses, ["requirements", "code"]);
  assert.deepEqual(JSON.parse(routed.messages[1].content), {
    requirements: {
      trigger: "assigned",
      assignment: { reason: "review_requested" },
      decisionContext: { value: { answer: "check the boundary" } },
    },
    code: { event: { eventType: "pull_request.observed" } },
  });
});

test("the default PR context cannot cross a remote requirements denial", async () => {
  const calls = [];
  const router = new BrainRouter({
    providers: [
      {
        id: "remote-brain",
        remote: true,
        async generate(request) {
          calls.push(request);
          return JSON.stringify(completeDecision());
        },
      },
    ],
  });
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain({
      provider: "remote-brain",
      remoteData: { requirements: false, code: true, memory: false },
    }),
    brainRouter: router,
  });

  await assert.rejects(
    engine.decide({
      item: {
        event: { eventType: "pull_request.observed" },
        decisionContext: {
          source: "attention",
          value: { answer: "private requirement" },
        },
      },
      trigger: "assigned",
    }),
    (error) =>
      error.code === "REMOTE_DATA_NOT_AUTHORIZED" &&
      /requirements/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("four configured roles keep definition, permissions, brain, pause, and revision independent", async () => {
  const store = new MemoryStore();
  const roleSpecs = [
    ["orchestrator", ["ask_user", "handoff", "complete"], "orchestrator-model"],
    ["requirements-analyst", ["ask_user", "handoff", "complete"], "requirements-model"],
    ["developer", ["ask_user", "propose_code_action", "complete"], "developer-model"],
    ["tester", ["ask_user", "handoff", "complete"], "tester-model"],
  ];
  const employees = roleSpecs.map(([id, intents, model]) =>
    new ConfiguredRoleEmployee({
      definition: definition(id),
      permissions: permissions(...intents),
      brain: brain({ model }),
      decisionEngine: fakeDecisionEngine(id),
      store,
    }),
  );
  const registry = new EmployeeRegistry(employees);
  const before = await registry.list();
  const analyst = before.find(({ role }) => role.id === "requirements-analyst");
  await registry.control("requirements-analyst", "pause", analyst.role.revision);
  const after = await registry.list();

  assert.deepEqual(after.map(({ role }) => role.id), roleSpecs.map(([id]) => id));
  assert.equal(
    after.find(({ role }) => role.id === "requirements-analyst").role.paused,
    true,
  );
  assert.equal(
    after.find(({ role }) => role.id === "requirements-analyst").role.revision,
    1,
  );
  assert.equal(after.find(({ role }) => role.id === "developer").role.revision, 0);
  assert.equal(
    after.find(({ role }) => role.id === "developer").role.brain.model,
    "developer-model",
  );

  const restored = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("ask_user", "handoff", "complete"),
    brain: brain({ model: "requirements-model" }),
    decisionEngine: fakeDecisionEngine("requirements-analyst"),
    store,
  });
  assert.equal((await restored.roleView()).paused, true);
  assert.equal((await restored.roleView()).revision, 1);
});

test("the explicit role worker port resolves and decide never deadlocks an onRun central cycle", async () => {
  const store = new MemoryStore();
  const decideCalls = [];
  let employee;
  employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("developer", decideCalls),
    store,
    onRun: async ({ trigger }) => {
      const result = await employee.decide({ item: { itemId: "work-1" }, trigger });
      assert.equal(result.intent.type, "complete");
    },
  });
  const directory = new RoleWorkerDirectory({
    workers: [employee.asRoleWorker()],
    legacyOwnedRoleIds: [],
  });
  const resolved = await directory.resolve({ type: "role", id: "developer" });

  const run = employee.run({ trigger: "manual" });
  await Promise.race([
    run,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("configured role run deadlocked")), 200),
    ),
  ]);

  assert.equal(resolved.roleId, "developer");
  assert.equal(resolved.workerId, employee.workerId);
  assert.equal(resolved.paused, false);
  assert.equal(decideCalls.length, 1);
  assert.equal((await employee.view()).runCount, 1);
});

test("pausing a role invalidates a decision that is already in flight", async () => {
  const store = new MemoryStore();
  let entered;
  let release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const employee = new ConfiguredRoleEmployee({
    definition: definition("tester"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: {
      view() {
        return { brain: { remote: false } };
      },
      async decide() {
        entered();
        await gate;
        return completeDecision();
      },
    },
    store,
  });

  const deciding = employee.decide({ item: { itemId: "work-1" } });
  await started;
  await employee.control("pause", 0);
  release();

  await assert.rejects(deciding, (error) => error.code === "ROLE_PAUSED");
});

test("onRun self-control fails explicitly instead of deadlocking the role queue", async () => {
  const store = new MemoryStore();
  let employee;
  employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("developer"),
    store,
    onRun: async () => {
      const revision = (await employee.roleView()).revision;
      await employee.control("pause", revision);
    },
  });

  await assert.rejects(
    employee.run({ trigger: "manual" }),
    (error) => error.code === "ROLE_RUN_IN_PROGRESS",
  );
  assert.equal(employee.running, null);
  assert.equal((await employee.view()).lastErrorCode, "ROLE_RUN_IN_PROGRESS");
});

test("persisted failures and public state never contain provider secrets", async () => {
  const store = new MemoryStore();
  const secret = "provider-secret-value";
  const error = Object.assign(new Error(`vendor leaked ${secret}`), {
    code: "REMOTE_PROVIDER_FAILED",
  });
  const employee = new ConfiguredRoleEmployee({
    definition: definition("tester"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("tester"),
    store,
    onRun: async () => {
      throw error;
    },
  });

  await assert.rejects(employee.run({ trigger: "scheduled" }), (value) => value === error);
  const view = await employee.view();
  const persisted = await store.read("configured-role-tester-state");

  assert.equal(view.lastErrorCode, "REMOTE_PROVIDER_FAILED");
  assert.equal(JSON.stringify(view).includes(secret), false);
  assert.equal(JSON.stringify(persisted).includes(secret), false);
});
