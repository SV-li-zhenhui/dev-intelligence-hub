import assert from "node:assert/strict";
import test from "node:test";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
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

function askUserDecision() {
  return {
    schemaVersion: 1,
    confidence: 82,
    summary: "需要继续确认型号范围。",
    intent: {
      schemaVersion: 1,
      type: "ask_user",
      summary: "确认 RTX 5060 系列的具体型号范围",
      reason: "系列可能包含不同型号和显存规格。",
      question: "RTX 5060 系列具体包含哪些型号？",
      choices: [{
        id: "all-5060-models",
        label: "全部 5060 系列",
        description: "覆盖 RTX 5060、RTX 5060 Ti 及计划出货的显存规格。",
      }],
    },
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

function triageDecompositionDecision(capability = "development") {
  const reason = "Create the trusted PR triage child";
  return {
    schemaVersion: 1,
    confidence: 91,
    summary: "Create one specialist child",
    intent: {
      schemaVersion: 1,
      type: "orchestrate",
      summary: "Create one specialist child",
      reason,
      action: {
        schemaVersion: 1,
        type: "decompose",
        sourceTaskId: "work-item-root",
        sourceTaskRevision: 4,
        expectedGraphRevision: 8,
        reason,
        childKey: "trusted-triage",
        work: { title: "Handle PR", description: "Use trusted intake" },
        capability,
        dependsOn: [],
        acceptanceContract: {
          revision: 1,
          acceptanceCriteria: [{
            criterionId: "done",
            description: "Trusted triage completed",
          }],
          expectedDeliverables: [{
            deliverableId: "implementation",
            kind: capability === "development"
              ? "change-package"
              : "github-review",
            description: "Trusted specialist delivery",
            required: true,
          }],
        },
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

function fakeDecisionEngine(
  id,
  calls = [],
  { remote = false, availabilityCalls = null, availabilityError = null } = {},
) {
  const engine = {
    async decide(input) {
      calls.push({ id, input: structuredClone(input) });
      return completeDecision();
    },
    view() {
      return {
        definition: definition(id),
        permissions: permissions("complete"),
        brain: { ...brain(), remote },
      };
    },
  };
  if (availabilityCalls !== null) {
    engine.checkAvailability = async (input) => {
      availabilityCalls.push({ id, input });
      if (availabilityError) throw availabilityError;
    };
  }
  return engine;
}

function assignedTask(eventType, suffix = "1") {
  const assignmentId = `assignment-${suffix}`;
  return {
    itemId: `work-item-${suffix}`,
    kind: "assignment",
    assignmentId,
    assignment: {
      assignmentId,
      target: { type: "role", id: "developer" },
    },
    event: { eventType },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    item: {
      event: {
        eventType: "pull_request.updated",
        subject: {
          repository: "example/software",
          number: 24256,
          title: "修复登录",
        },
      },
    },
    trigger: "assigned",
  });

  assert.deepEqual(result, completeDecision());
  assert.deepEqual(calls[0].dataClasses, ["requirements", "code"]);
  assert.match(calls[0].messages[0].content, /developer/);
  assert.match(calls[0].messages[0].content, /untrusted|不可信/i);
  assert.match(
    calls[0].messages[0].content,
    /modify produces change-package.*verify produces test-report/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /prose-only specialist work.*text-report.*first return any submitted delivery/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /Use decompose to create each new specialist child.*never assign a task to its current role/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /dependsOn.*completed visible direct children/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /pull_request\.owner_requested.*suggested capability.*decompose/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /Never pause the current root merely to wait for normal child work/i,
  );
  assert.match(
    calls[0].messages[0].content,
    /multiple compatible expected deliverables.*deliverableId|deliverableId.*multiple compatible expected deliverables/i,
  );
  assert.deepEqual(JSON.parse(calls[0].messages[1].content), {
    requirements: { trigger: "assigned", title: "修复登录" },
    code: { files: ["src/app.js"] },
  });
  assert.equal(engine.view().brain.remoteData.memory, false);
  assert.equal(
    calls[0].sessionKey,
    "github:pull_request:example/software#24256",
  );
});

test("RoleDecisionEngine reuses one entity session across roles and event revisions", async () => {
  const sessionKeys = [];
  const router = {
    async generate(request) {
      sessionKeys.push(request.sessionKey);
      return JSON.stringify(completeDecision());
    },
    describe(config) {
      return { ...config, remote: false };
    },
  };
  const developer = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
    contextFactory: async () => ({ requirements: { taskId: "task-1" } }),
  });
  const reviewer = new RoleDecisionEngine({
    definition: definition("pr-engineer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
    contextFactory: async () => ({ requirements: { taskId: "task-2" } }),
  });
  const event = {
    eventType: "issue.updated",
    subject: {
      repository: "example/product",
      number: 12953,
      title: "数据库保存问题",
    },
  };

  await developer.decide({ item: { event }, trigger: "assigned" });
  await reviewer.decide({
    item: {
      event: {
        ...event,
        eventType: "issue.commented",
      },
    },
    trigger: "user_answered",
  });

  assert.deepEqual(sessionKeys, [
    "github:issue:example/product#12953",
    "github:issue:example/product#12953",
  ]);
});

test("RoleDecisionEngine checks its configured provider without generating a decision", async () => {
  const availabilityCalls = [];
  let generateCalls = 0;
  const router = {
    async generate() {
      generateCalls += 1;
      return JSON.stringify(completeDecision());
    },
    async checkAvailability(config, options) {
      availabilityCalls.push({ config, options });
    },
    describe(config) {
      return { ...config, remote: false };
    },
  };
  const configuredBrain = brain({ model: "availability-model" });
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: configuredBrain,
    brainRouter: router,
  });
  const controller = new AbortController();

  await engine.checkAvailability({ signal: controller.signal });

  assert.equal(generateCalls, 0);
  assert.equal(availabilityCalls.length, 1);
  assert.deepEqual(availabilityCalls[0].config, configuredBrain);
  assert.strictEqual(availabilityCalls[0].options.signal, controller.signal);
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

test("requirements analyst cannot ask again after the owner answered the task consultation", async () => {
  const calls = [];
  const responses = [askUserDecision(), completeDecision()];
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("ask_user", "handoff", "complete"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        calls.push(request);
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });
  const result = await engine.decide({
    item: { event: { eventType: "issue.updated" } },
    context: {
      requirements: {
        decisionContext: {
          source: "attention",
          outcome: "answered",
          value: { answer: { type: "text", text: "是 5060 系列" } },
        },
      },
    },
  });

  assert.equal(result.intent.type, "complete");
  assert.equal(calls.length, 2);
  assert.match(
    calls[1].messages.at(-1).content,
    /do not return ask_user again/u,
  );
  assert.match(
    calls[0].messages[0].content,
    /family or series answer as an inclusive scope boundary/u,
  );
});

test("requirements analyst repeated attention is rejected when correction also asks again", async () => {
  let calls = 0;
  const engine = new RoleDecisionEngine({
    definition: definition("requirements-analyst"),
    permissions: permissions("ask_user", "handoff", "complete"),
    brain: brain(),
    brainRouter: {
      async generate() {
        calls += 1;
        return JSON.stringify(askUserDecision());
      },
      describe() {
        return { ...brain(), remote: false, singleAttempt: true };
      },
    },
  });

  await assert.rejects(
    engine.decide({
      item: { event: { eventType: "issue.updated" } },
      context: {
        requirements: {
          decisionContext: {
            source: "attention",
            outcome: "answered",
            value: {
              answer: { type: "choice", choiceId: "all-5060-models" },
            },
          },
        },
      },
    }),
    (error) => error.code === "ROLE_DECISION_REPEATED_ATTENTION",
  );
  assert.equal(calls, 1);
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

test("RoleDecisionEngine rejects premature completion of initial structured PR triage", async () => {
  const responses = [completeDecision(), triageDecompositionDecision()];
  const calls = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("complete", "orchestrate"),
    brain: brain(),
    brainRouter: {
      async generate(request) {
        calls.push(request);
        return JSON.stringify(responses.shift());
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });
  const context = {
    requirements: {
      coordination: { directChildren: [] },
    },
    code: {
      sourceEvent: {
        eventType: "pull_request.owner_requested",
        source: { provider: "local-owner" },
        payload: {
          workType: "general",
          nextAction: "fix_ci",
          suggestedCapability: "development",
          expectedHeadRefOid: "a".repeat(40),
        },
      },
    },
  };

  const result = await engine.decide({ context });

  assert.equal(calls.length, 2);
  assert.equal(result.intent.type, "orchestrate");
  assert.equal(result.intent.action.type, "decompose");
  assert.equal(result.intent.action.capability, "development");
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

test("RoleDecisionEngine never starts a correction CLI after invalid output", async () => {
  const calls = [];
  const engine = new RoleDecisionEngine({
    definition: definition("orchestrator"),
    permissions: permissions("complete"),
    brain: brain({ provider: "cli" }),
    brainRouter: {
      async generate(request) {
        calls.push(structuredClone(request));
        return "invalid CLI output";
      },
      describe(config) {
        return {
          provider: config.provider,
          model: config.model,
          remote: true,
          remoteData: structuredClone(config.remoteData),
          singleAttempt: true,
        };
      },
    },
  });

  await assert.rejects(
    engine.decide(),
    (error) => error?.code === "STRUCTURED_BRAIN_RESPONSE_INVALID",
  );
  assert.equal(calls.length, 1);
});

test("RoleDecisionEngine admits each provider request without holding the gate for network time", async () => {
  const digest = (value) => value.repeat(64);
  const gate = new ActionAdmissionGate();
  gate.bindEffective({ version: 1, configurationDigest: digest("a") });
  const responses = [deferred(), deferred()];
  const bothEntered = deferred();
  let generateCalls = 0;
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    actionAdmissionGate: Object.freeze({ run: gate.run.bind(gate) }),
    brainRouter: {
      generate() {
        const response = responses[generateCalls];
        generateCalls += 1;
        if (generateCalls === responses.length) bothEntered.resolve();
        return response.promise;
      },
      describe() {
        return { ...brain(), remote: false };
      },
    },
  });

  const validDecision = engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });
  const invalidDecision = engine.decide({
    item: { event: { eventType: "issue.updated" } },
  });
  await bothEntered.promise;

  const cutover = gate.cutover(({ commit }) => {
    commit({ version: 2, configurationDigest: digest("b") });
    return "stored-v2";
  });
  assert.equal(await cutover, "stored-v2");
  assert.equal(gate.readStatus().mode, "restart_required");

  responses[0].resolve(JSON.stringify(completeDecision()));
  responses[1].resolve("invalid response");

  assert.equal((await validDecision).intent.type, "complete");
  await assert.rejects(
    invalidDecision,
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  await assert.rejects(
    engine.decide({ item: { event: { eventType: "issue.updated" } } }),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  assert.equal(generateCalls, 2);
});

test("RoleDecisionEngine forwards cancellation and rejects a late provider result", async () => {
  const pending = deferred();
  let providerInput = null;
  const router = new BrainRouter({
    providers: [{
      id: "local-brain",
      remote: false,
      async generate(input) {
        providerInput = input;
        await pending.promise;
        return JSON.stringify(completeDecision());
      },
    }],
  });
  const engine = new RoleDecisionEngine({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    brainRouter: router,
  });
  const controller = new AbortController();
  const deadline = Object.assign(new Error("role decision timed out"), {
    code: "ROLE_DECISION_TIMEOUT",
  });
  const decision = engine.decide({
    item: null,
    context: { requirements: { task: "bounded" } },
    signal: controller.signal,
  });
  while (providerInput === null) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  controller.abort(deadline);
  pending.resolve();

  await assert.rejects(decision, (error) => error === deadline);
  assert.strictEqual(providerInput.signal, controller.signal);
  assert.equal(providerInput.signal.aborted, true);
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

test("all shipped roles pause, restart, and resume independently", async () => {
  const store = new MemoryStore();
  const roleSpecs = [
    ["pr-engineer", ["ask_user", "propose_github_review", "complete"], "pr-model"],
    ["orchestrator", ["ask_user", "handoff", "complete"], "orchestrator-model"],
    ["requirements-analyst", ["ask_user", "handoff", "complete"], "requirements-model"],
    ["developer", ["ask_user", "propose_code_action", "complete"], "developer-model"],
    ["tester", ["ask_user", "handoff", "complete"], "tester-model"],
  ];
  const createRegistry = () => new EmployeeRegistry(
    roleSpecs.map(([id, intents, model]) =>
      new ConfiguredRoleEmployee({
        definition: definition(id),
        permissions: permissions(...intents),
        brain: brain({ model }),
        decisionEngine: fakeDecisionEngine(id),
        store,
      }),
    ),
  );
  let registry = createRegistry();

  for (const [roleId] of roleSpecs) {
    const before = await registry.list();
    const selected = before.find(({ role }) => role.id === roleId).role;
    await registry.control(roleId, "pause", selected.revision);
    const paused = await registry.list();
    assert.deepEqual(
      paused.map(({ role }) => role.id),
      roleSpecs.map(([id]) => id),
    );
    assert.deepEqual(
      paused.filter(({ role }) => role.paused).map(({ role }) => role.id),
      [roleId],
    );

    registry = createRegistry();
    const restarted = await registry.list();
    const restoredRole = restarted.find(({ role }) => role.id === roleId).role;
    assert.equal(restoredRole.paused, true);
    assert.equal(restoredRole.revision, selected.revision + 1);
    assert.deepEqual(
      restarted.filter(({ role }) => role.paused).map(({ role }) => role.id),
      [roleId],
    );

    await registry.control(roleId, "resume", restoredRole.revision);
    registry = createRegistry();
    const resumed = await registry.list();
    assert.equal(resumed.every(({ role }) => role.paused === false), true);
  }

  const final = await registry.list();
  assert.deepEqual(
    final.map(({ role }) => role.brain.model),
    roleSpecs.map(([, , model]) => model),
  );
});

test("task brain is safely projected while non-task activity keeps routine routing", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({
      provider: "remote-task-brain",
      model: "high-capability-model",
      remoteData: { requirements: true, code: true, memory: false },
    }),
    decisionEngine: fakeDecisionEngine("developer", routineCalls),
    taskDecisionEngine: fakeDecisionEngine("developer", taskCalls, {
      remote: true,
    }),
    store: new MemoryStore(),
  });

  const view = await employee.roleView();
  assert.equal(view.brain.model, "routine-model");
  assert.deepEqual(view.taskBrain, {
    provider: "remote-task-brain",
    model: "high-capability-model",
    remote: true,
    remoteData: { requirements: true, code: true, memory: false },
  });

  const decision = await employee.decide({ item: { itemId: "work-1" } });
  assert.equal(decision.intent.type, "complete");
  await employee.decide({
    item: { event: { eventType: "pull_request.updated" } },
    context: { code: { untrustedClaim: "this is assigned work" } },
  });
  assert.equal(routineCalls.length, 2);
  assert.equal(taskCalls.length, 0);
});

test("assigned PR work uses the task brain while assigned issue work stays routine", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("requirements-analyst", routineCalls),
    taskDecisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      taskCalls,
    ),
    store: new MemoryStore(),
  });

  await employee.decide({ item: assignedTask("issue.updated", "issue") });
  await employee.decide({
    item: assignedTask("pull_request.updated", "pull-request"),
  });
  const sourceBoundPullRequest = assignedTask(
    "issue.updated",
    "source-bound-pull-request",
  );
  sourceBoundPullRequest.source = {
    kind: "pull_request",
    current: { event: { eventType: "pull_request.updated" } },
  };
  await employee.decide({ item: sourceBoundPullRequest });

  assert.equal(routineCalls.length, 1);
  assert.equal(taskCalls.length, 2);
  assert.equal(routineCalls[0].input.item.event.eventType, "issue.updated");
  assert.equal(
    taskCalls[0].input.item.event.eventType,
    "pull_request.updated",
  );
});

test("availability preflight uses the same routine and task brain selection as decide", async () => {
  const routineDecisions = [];
  const taskDecisions = [];
  const routineAvailability = [];
  const taskAvailability = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      routineDecisions,
      { availabilityCalls: routineAvailability },
    ),
    taskDecisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      taskDecisions,
      { availabilityCalls: taskAvailability },
    ),
    store: new MemoryStore(),
  });
  const controller = new AbortController();

  await employee.checkAvailability({
    item: assignedTask("issue.updated", "routine-availability"),
    signal: controller.signal,
  });
  await employee.asRoleWorker().checkAvailability({
    item: assignedTask("pull_request.updated", "task-availability"),
    signal: controller.signal,
  });

  assert.equal(routineDecisions.length, 0);
  assert.equal(taskDecisions.length, 0);
  assert.equal(routineAvailability.length, 1);
  assert.equal(taskAvailability.length, 1);
  assert.strictEqual(routineAvailability[0].input.signal, controller.signal);
  assert.strictEqual(taskAvailability[0].input.signal, controller.signal);
});

test("availability preflight propagates the selected task-brain failure", async () => {
  const expected = Object.assign(new Error("login unavailable"), {
    code: "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
  });
  const routineAvailability = [];
  const taskAvailability = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("requirements-analyst", [], {
      availabilityCalls: routineAvailability,
    }),
    taskDecisionEngine: fakeDecisionEngine("requirements-analyst", [], {
      availabilityCalls: taskAvailability,
      availabilityError: expected,
    }),
    store: new MemoryStore(),
  });

  await assert.rejects(
    employee.checkAvailability({
      item: assignedTask("pull_request.updated", "failed-availability"),
    }),
    (error) => error === expected,
  );
  assert.equal(routineAvailability.length, 0);
  assert.equal(taskAvailability.length, 1);
});

test("every assigned task for a code-capable role uses the task brain", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("developer", routineCalls),
    taskDecisionEngine: fakeDecisionEngine("developer", taskCalls),
    store: new MemoryStore(),
  });

  await employee.decide({ item: assignedTask("issue.updated", "code-task") });

  assert.equal(routineCalls.length, 0);
  assert.equal(taskCalls.length, 1);
});

test("task-risk work fails closed when no task brain is configured", async () => {
  const codeRoutineCalls = [];
  const codeEmployee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({ model: "routine-model" }),
    decisionEngine: fakeDecisionEngine("developer", codeRoutineCalls),
    store: new MemoryStore(),
  });

  await assert.rejects(
    codeEmployee.decide({
      item: assignedTask("issue.updated", "missing-code-brain"),
    }),
    (error) =>
      error instanceof Error &&
      error.code === "ROLE_TASK_BRAIN_NOT_CONFIGURED" &&
      error.statusCode === 503,
  );
  assert.equal(codeRoutineCalls.length, 0);
  await assert.rejects(
    codeEmployee.checkAvailability({
      item: assignedTask("issue.updated", "missing-code-brain-preflight"),
    }),
    (error) => error?.code === "ROLE_TASK_BRAIN_NOT_CONFIGURED",
  );
  assert.equal(codeRoutineCalls.length, 0);

  const prRoutineCalls = [];
  const prEmployee = new ConfiguredRoleEmployee({
    definition: definition("requirements-analyst"),
    permissions: permissions("complete"),
    brain: brain({ model: "routine-model" }),
    decisionEngine: fakeDecisionEngine(
      "requirements-analyst",
      prRoutineCalls,
    ),
    store: new MemoryStore(),
  });
  await assert.rejects(
    prEmployee.decide({
      item: assignedTask("pull_request.updated", "missing-pr-brain"),
    }),
    (error) => error.code === "ROLE_TASK_BRAIN_NOT_CONFIGURED",
  );
  assert.equal(prRoutineCalls.length, 0);
});

test("malformed assigned-task bindings reach neither decision engine", async () => {
  const routineCalls = [];
  const taskCalls = [];
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete", "propose_code_action"),
    brain: brain({ model: "routine-model" }),
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("developer", routineCalls),
    taskDecisionEngine: fakeDecisionEngine("developer", taskCalls),
    store: new MemoryStore(),
  });
  const missingAssignment = assignedTask(
    "pull_request.updated",
    "missing-assignment",
  );
  delete missingAssignment.assignment;
  const mismatchedAssignment = assignedTask(
    "pull_request.updated",
    "mismatched-assignment",
  );
  mismatchedAssignment.assignment.assignmentId = "assignment-other";
  const malformedEvent = assignedTask(
    "pull_request.updated",
    "malformed-event",
  );
  malformedEvent.event = { eventType: null };

  for (const item of [
    missingAssignment,
    mismatchedAssignment,
    malformedEvent,
  ]) {
    await assert.rejects(
      employee.decide({ item }),
      (error) =>
        error.code === "ROLE_TASK_BINDING_INVALID" &&
        error.statusCode === 409,
    );
  }
  assert.equal(routineCalls.length, 0);
  assert.equal(taskCalls.length, 0);
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

test("a configured role exposes a bounded work-cycle outcome summary", async () => {
  const employee = new ConfiguredRoleEmployee({
    definition: definition("orchestrator"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("orchestrator"),
    store: new MemoryStore(),
    onRun: async () => ({
      stages: {
        work: {
          ok: true,
          result: {
            scanned: 12,
            workAttempts: 2,
            outcomes: [
              {
                itemId: "private-item-1",
                status: "degraded",
                code: "STRUCTURED_PROVIDER_UNAVAILABLE",
              },
              { itemId: "private-item-2", status: "orchestrated" },
            ],
          },
        },
      },
    }),
  });

  await employee.run({ trigger: "manual" });

  const view = await employee.roleView();
  assert.equal(
    view.lastRun.summary,
    "扫描 12 项，尝试 2 项：degraded 1（STRUCTURED_PROVIDER_UNAVAILABLE）、orchestrated 1",
  );
  assert.equal(JSON.stringify(view).includes("private-item"), false);
});

test("an employee run forwards its shutdown signal and performs no state write after abort", async () => {
  const store = new MemoryStore();
  const started = deferred();
  let observedSignal = null;
  const employee = new ConfiguredRoleEmployee({
    definition: definition("developer"),
    permissions: permissions("complete"),
    brain: brain(),
    decisionEngine: fakeDecisionEngine("developer"),
    store,
    onRun: async ({ signal }) => {
      observedSignal = signal;
      started.resolve();
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  });
  const controller = new AbortController();
  const running = employee.run({ trigger: "manual", signal: controller.signal });
  await started.promise;
  const reason = Object.assign(new Error("shutdown"), {
    code: "LIFECYCLE_SHUTDOWN_ABORTED",
  });
  controller.abort(reason);

  await assert.rejects(
    Promise.race([
      running,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("employee did not abort")),
        50,
      )),
    ]),
    (error) => error === reason,
  );
  assert.strictEqual(observedSignal, controller.signal);
  assert.equal((await employee.view()).runCount, 0);
});

test("pausing a role invalidates a task-brain decision already in flight", async () => {
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
    taskBrain: brain({ model: "task-model" }),
    decisionEngine: fakeDecisionEngine("tester"),
    taskDecisionEngine: {
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

  const deciding = employee.decide({
    item: assignedTask("pull_request.updated", "in-flight"),
  });
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
