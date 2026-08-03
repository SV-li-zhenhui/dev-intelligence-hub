import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createRequirementSpec } from "../src/domain/requirement-spec-contract.js";
import { createWorkGraphSnapshot } from "../src/domain/work-graph-contract.js";
import {
  OrchestratorService,
  OrchestratorServiceError,
} from "../src/services/orchestrator-service.js";

const INPUT_DIGEST = "a".repeat(64);
const CONTEXT_DIGEST = "b".repeat(64);
const EXTERNAL_DIGEST = "c".repeat(64);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function contract({
  deliverableId = "implementation",
  kind = "change-package",
  required = true,
} = {}) {
  return {
    revision: 1,
    acceptanceCriteria: [
      { criterionId: "done", description: "交付物满足契约" },
    ],
    expectedDeliverables: [
      {
        deliverableId,
        kind,
        description: "受信任的交付物",
        required,
      },
    ],
  };
}

function task({
  taskId,
  revision = 1,
  parentTaskId = null,
  status = "pending",
  role = "orchestrator",
  acceptanceContract = contract({ required: false }),
  deliveries = [],
  dependsOn = [],
} = {}) {
  return {
    taskId,
    revision,
    parentTaskId,
    status,
    responsibility: { type: "role", id: role },
    acceptanceContracts: [acceptanceContract],
    deliveries,
    dependsOn,
  };
}

function graphView(tasks, revision = Math.max(1, ...tasks.map(({ revision: value }) => value))) {
  return {
    schemaVersion: 1,
    graph: createWorkGraphSnapshot({
      graphId: "work-ledger",
      revision,
      tasks,
    }),
    taskStates: [],
  };
}

function itemFor(graphTask, {
  status = "queued",
  ownerId = null,
  leaseId = null,
} = {}) {
  return {
    itemId: graphTask.taskId,
    revision: graphTask.revision,
    inputDigest: INPUT_DIGEST,
    status,
    ownerId,
    leaseId,
    currentTarget: { ...graphTask.responsibility },
  };
}

function packetFor(view, graphTask, {
  roleId = graphTask.responsibility.id,
  acceptedInputs = [],
  directChildren,
} = {}) {
  const requirements = {
    trigger: "scheduled",
    ...(directChildren
      ? {
          coordination: {
            schemaVersion: 1,
            rootTaskId: graphTask.taskId,
            directChildren: directChildren.map((child) => ({
              taskId: child.taskId,
            })),
          },
          childDeliveries: directChildren.flatMap((child) => {
            const submitted = child.deliveries.at(-1);
            return submitted?.status === "submitted"
              ? [{
                  taskId: child.taskId,
                  state: "submitted",
                  submittedDeliveryRevision: submitted.revision,
                }]
              : [];
          }),
        }
      : {}),
  };
  return {
    schemaVersion: 1,
    binding: {
      roleId,
      taskId: graphTask.taskId,
      taskRevision: graphTask.revision,
      inputDigest: INPUT_DIGEST,
      graphId: view.graph.graphId,
      graphRevision: view.graph.revision,
      graphContentDigest: view.graph.contentDigest,
      contractRevision: graphTask.acceptanceContracts.at(-1).revision,
    },
    context: { requirements },
    acceptedInputs,
    contextDigest: CONTEXT_DIGEST,
  };
}

function workInputEvidence(graphTask, acceptedInputs = [], contextDigest = CONTEXT_DIGEST) {
  return {
    kind: "work-inputs",
    referenceId: `work-inputs:${graphTask.taskId}:${contextDigest}`,
    contentDigest: digest({
      domain: "mydashboard-work-inputs/v1",
      taskId: graphTask.taskId,
      roleId: graphTask.responsibility.id,
      contextDigest,
      acceptedInputs,
    }),
  };
}

function orchestrate(action, summary = "协调下一步") {
  return {
    schemaVersion: 1,
    type: "orchestrate",
    summary,
    reason: action.reason,
    action,
  };
}

function commonAction(type, source, view, reason = "当前任务需要协调") {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: source.taskId,
    sourceTaskRevision: source.revision,
    expectedGraphRevision: view.graph.revision,
    reason,
  };
}

function fakePorts({ packet, views, plannerResult, deliveryResult, verifier } = {}) {
  const calls = {
    assemble: [],
    graphReads: 0,
    plannerFactory: [],
    delivererFactory: [],
    planner: [],
    delivery: [],
    verify: [],
  };
  const snapshots = Array.isArray(views) ? views : [views];
  const planner = {};
  for (const method of [
    "createChild",
    "reassignTask",
    "decideDelivery",
    "stageEscalation",
    "pauseTask",
    "cancelTask",
  ]) {
    planner[method] = async (command) => {
      calls.planner.push({ method, command });
      if (plannerResult instanceof Error) throw plannerResult;
      return typeof plannerResult === "function"
        ? plannerResult(method, command)
        : (plannerResult ?? {
            applied: true,
            taskId: command.taskId ?? "root/new-child",
            deliveryRevision: command.submittedDeliveryRevision + 1,
            ownerId: "must-not-leak",
            leaseId: "must-not-leak",
            evidence: [{ secret: true }],
          });
    };
  }
  const ports = {
    contextAssembler: {
      async assemble(input) {
        calls.assemble.push(input);
        return typeof packet === "function" ? packet(input) : packet;
      },
    },
    graphReader: {
      async getSnapshot() {
        const index = Math.min(calls.graphReads, snapshots.length - 1);
        calls.graphReads += 1;
        const snapshot = snapshots[index];
        return typeof snapshot === "function" ? snapshot() : snapshot;
      },
    },
    scopedGraphPlannerFactory: {
      forRoot(request) {
        calls.plannerFactory.push(request);
        return planner;
      },
    },
    graphDelivererFactory: {
      forClaim(request) {
        calls.delivererFactory.push(request);
        return {
          async submitDelivery(command) {
            calls.delivery.push(command);
            if (deliveryResult instanceof Error) throw deliveryResult;
            return typeof deliveryResult === "function"
              ? deliveryResult(command)
              : (deliveryResult ?? {
                  applied: true,
                  ownerId: "must-not-leak",
                  leaseId: "must-not-leak",
                  evidence: [{ secret: true }],
                });
          },
        };
      },
    },
    ...(verifier === undefined
      ? {}
      : {
          evidenceVerifier: {
            async verify(input) {
              calls.verify.push(input);
              return verifier(input);
            },
          },
        }),
  };
  return { calls, ports };
}

function serviceFrom(fakes, capabilityRoles = {
  development: "developer",
  testing: "tester",
}) {
  return new OrchestratorService({ ...fakes.ports, capabilityRoles });
}

function rootFixture({ submitted = false } = {}) {
  const root = task({ taskId: "root", revision: 3 });
  const child = task({
    taskId: "root/child",
    revision: submitted ? 2 : 1,
    parentTaskId: root.taskId,
    role: "developer",
    acceptanceContract: contract(),
    deliveries: submitted
      ? [
          {
            deliverableId: "implementation",
            revision: 1,
            contractRevision: 1,
            status: "submitted",
            summary: "实现说明",
            evidence: [workInputEvidence({
              taskId: "root/child",
              responsibility: { type: "role", id: "developer" },
            })],
          },
        ]
      : [],
  });
  const dependency = task({
    taskId: "root/dependency",
    revision: 1,
    parentTaskId: root.taskId,
    status: "completed",
    role: "tester",
    acceptanceContract: contract({ required: false }),
  });
  const view = graphView([root, child, dependency], 3);
  const item = itemFor(root);
  const packet = packetFor(view, root, {
    roleId: "orchestrator",
    directChildren: [child, dependency],
  });
  return { root, child, dependency, view, item, packet };
}

test("maps all seven orchestration actions to the least-authority planner commands", async (t) => {
  const scenarios = [
    {
      name: "decompose",
      build({ root, dependency, view }) {
        return {
          ...commonAction("decompose", root, view),
          childKey: "implementation",
          work: { title: "实现", description: "完成受控实现" },
          capability: "development",
          dependsOn: [{ taskId: dependency.taskId, revision: dependency.revision }],
          acceptanceContract: contract(),
        };
      },
      method: "createChild",
      expected({ root, dependency, view }) {
        return {
          parentTaskId: root.taskId,
          childKey: "implementation",
          work: { title: "实现", description: "完成受控实现" },
          target: { type: "role", id: "developer" },
          dependsOnTaskIds: [dependency.taskId],
          acceptanceContract: contract(),
          leaseId: null,
          expectedGraphRevision: view.graph.revision,
          expectedTaskRevisions: [
            { taskId: root.taskId, revision: root.revision },
            { taskId: dependency.taskId, revision: dependency.revision },
          ],
        };
      },
    },
    {
      name: "assign",
      build: ({ child, view }) => ({
        ...commonAction("assign", child, view),
        capability: "testing",
      }),
      method: "reassignTask",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        target: { type: "role", id: "tester" },
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "accept_delivery",
      submitted: true,
      build: ({ child, view }) => ({
        ...commonAction("accept_delivery", child, view),
        submittedDeliveryRevision: 1,
      }),
      method: "decideDelivery",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        submittedDeliveryRevision: 1,
        decision: "accept",
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "return_delivery",
      submitted: true,
      build: ({ child, view }) => ({
        ...commonAction("return_delivery", child, view),
        submittedDeliveryRevision: 1,
      }),
      method: "decideDelivery",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        submittedDeliveryRevision: 1,
        decision: "reject",
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "escalate",
      build: ({ child, view }) => ({
        ...commonAction("escalate", child, view),
        question: "是否允许扩展范围？",
        choices: [
          { id: "yes", label: "允许", description: "继续推进" },
          { id: "no", label: "拒绝", description: "保持范围" },
        ],
      }),
      method: "stageEscalation",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
        summary: "协调下一步",
        question: "是否允许扩展范围？",
        choices: [
          { id: "yes", label: "允许", description: "继续推进" },
          { id: "no", label: "拒绝", description: "保持范围" },
        ],
      }),
    },
    {
      name: "pause",
      build: ({ child, view }) => commonAction("pause", child, view),
      method: "pauseTask",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
    {
      name: "cancel",
      build: ({ child, view }) => commonAction("cancel", child, view),
      method: "cancelTask",
      expected: ({ child, view }) => ({
        taskId: child.taskId,
        reason: "当前任务需要协调",
        expectedGraphRevision: view.graph.revision,
        expectedTaskRevision: child.revision,
      }),
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = rootFixture({ submitted: scenario.submitted });
      const fakes = fakePorts({
        packet: fixture.packet,
        views: fixture.view,
        plannerResult: (method, command) => ({
          applied: true,
          taskId: method === "createChild" ? "root/new-child" : command.taskId,
          deliveryRevision: command.submittedDeliveryRevision + 1,
          ownerId: "private-owner",
          leaseId: "private-lease",
          evidence: [{ private: true }],
        }),
      });
      const result = await serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(scenario.build(fixture)),
      });

      assert.deepEqual(fakes.calls.plannerFactory, [
        { scopeRootTaskId: fixture.root.taskId },
      ]);
      assert.deepEqual(fakes.calls.planner, [
        { method: scenario.method, command: scenario.expected(fixture) },
      ]);
      assert.equal(result.action, scenario.name);
      assert.equal(result.applied, true);
      assert.equal(Object.isFrozen(result), true);
      assert.doesNotMatch(JSON.stringify(result), /private-owner|private-lease|evidence/);
    });
  }
});

test("rejects oversized requirement input sets before creating a graph planner", async () => {
  function completedDependency(taskId, deliverableCount) {
    const expectedDeliverables = [];
    const deliveries = [];
    for (let index = 0; index < deliverableCount; index += 1) {
      const deliverableId = `artifact-${index}`;
      const records = [{
        kind: "artifact",
        referenceId: `${taskId}:${deliverableId}`,
        contentDigest: EXTERNAL_DIGEST,
      }];
      expectedDeliverables.push({
        deliverableId,
        kind: "change-package",
        description: `Accepted input ${index}`,
        required: true,
      });
      deliveries.push(
        {
          deliverableId,
          revision: deliveries.length + 1,
          contractRevision: 1,
          status: "submitted",
          summary: `Submitted input ${index}`,
          evidence: records,
        },
        {
          deliverableId,
          revision: deliveries.length + 2,
          contractRevision: 1,
          status: "accepted",
          summary: `Accepted input ${index}`,
          evidence: records,
        },
      );
    }
    return task({
      taskId,
      revision: deliveries.length + 1,
      parentTaskId: "root",
      status: "completed",
      role: "developer",
      acceptanceContract: {
        revision: 1,
        acceptanceCriteria: [
          { criterionId: "done", description: "Inputs are accepted" },
        ],
        expectedDeliverables,
      },
      deliveries,
    });
  }

  const root = task({ taskId: "root", revision: 3 });
  const first = completedDependency("root/dependency-a", 64);
  const second = completedDependency("root/dependency-b", 1);
  const view = graphView([root, first, second], first.revision + 1);
  const item = itemFor(root);
  const packet = packetFor(view, root, {
    roleId: "orchestrator",
    directChildren: [first, second],
  });
  const fakes = fakePorts({ packet, views: view });
  const reason = "Create a bounded requirement task";

  await assert.rejects(
    serviceFrom(fakes, { requirements: "requirements-analyst" }).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item,
      contextPacket: packet,
      intent: orchestrate({
        ...commonAction("decompose", root, view, reason),
        childKey: "requirements",
        work: { title: "Requirements", description: "Clarify the scope" },
        capability: "requirements",
        dependsOn: [first, second].map(({ taskId, revision }) => ({
          taskId,
          revision,
        })),
        acceptanceContract: contract({
          deliverableId: "requirement-spec",
          kind: "requirement-spec",
        }),
      }),
    }),
    (error) =>
      error instanceof OrchestratorServiceError &&
      error.code === "ORCHESTRATOR_REQUIREMENT_INPUT_BUDGET_EXCEEDED",
  );
  assert.equal(fakes.calls.plannerFactory.length, 0);
  assert.equal(fakes.calls.delivererFactory.length, 0);
  assert.equal(fakes.calls.planner.length, 0);
});

test("rejects stale context and unauthorized orchestration before either factory", async (t) => {
  await t.test("stale packet", async () => {
    const fixture = rootFixture();
    const fresh = structuredClone(fixture.packet);
    fresh.contextDigest = "d".repeat(64);
    const fakes = fakePorts({ packet: fresh, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_CONTEXT_STALE",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.delivererFactory.length, 0);
    assert.equal(fakes.calls.graphReads, 0);
  });

  await t.test("wrong orchestrator principal", async () => {
    const fixture = rootFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "lookalike" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.delivererFactory.length, 0);
  });
});

function specialistFixture({
  deliverableId = "implementation",
  kind = "change-package",
} = {}) {
  const root = task({ taskId: "root", revision: 1 });
  const specialist = task({
    taskId: "root/specialist",
    revision: 1,
    parentTaskId: root.taskId,
    status: "in_progress",
    role: "developer",
    acceptanceContract: contract({ deliverableId, kind }),
  });
  const view = graphView([root, specialist], 2);
  const item = itemFor(specialist, {
    status: "working",
    ownerId: "employee-developer",
    leaseId: "lease-secret",
  });
  const packet = packetFor(view, specialist);
  return { root, specialist, view, item, packet };
}

function submitIntent(fixture, {
  deliverableId = "implementation",
  artifact = null,
  evidence = [],
} = {}) {
  return {
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: fixture.specialist.taskId,
    expectedTaskRevision: fixture.specialist.revision,
    expectedGraphRevision: fixture.view.graph.revision,
    contractRevision: 1,
    deliverableId,
    summary: "完成交付",
    reason: "契约要求已满足",
    evidence,
    artifact,
  };
}

test("submits ordinary and requirement-spec deliveries with trusted evidence and no caller verifier", async (t) => {
  await t.test("ordinary delivery", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    const result = await serviceFrom(fakes).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture),
    });
    assert.deepEqual(fakes.calls.delivererFactory, [{
      scopeRootTaskId: fixture.specialist.taskId,
      taskId: fixture.specialist.taskId,
      workerId: "employee-developer",
      leaseId: "lease-secret",
    }]);
    assert.equal(fakes.calls.delivery.length, 1);
    assert.deepEqual(fakes.calls.delivery[0].evidence, [
      workInputEvidence(fixture.specialist),
    ]);
    assert.equal(result.applied, true);
    assert.doesNotMatch(JSON.stringify(result), /lease-secret|work-inputs|evidence/);
  });

  await t.test("requirement specification", async () => {
    const fixture = specialistFixture({
      deliverableId: "requirement-spec",
      kind: "requirement-spec",
    });
    const artifact = {
      title: "统一需求",
      problem: "当前需求需要形成可追溯规格",
      requirements: ["记录完整需求"],
      acceptanceCriteria: ["规格可被后续岗位消费"],
      openQuestions: [],
    };
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await serviceFrom(fakes).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture, {
        deliverableId: "requirement-spec",
        artifact,
      }),
    });
    const command = fakes.calls.delivery[0];
    const spec = JSON.parse(command.summary);
    assert.equal(spec.sourceTask.taskId, fixture.specialist.taskId);
    assert.equal(spec.sourceTask.taskRevision, fixture.specialist.revision);
    assert.equal(spec.sourceTask.graphRevision, fixture.view.graph.revision);
    assert.deepEqual(command.evidence.map(({ kind }) => kind), [
      "requirement-spec",
      "work-inputs",
    ]);
    assert.equal(command.evidence[0].contentDigest, spec.contentDigest);
  });
});

test("fails closed on unverifiable caller evidence before obtaining a deliverer", async (t) => {
  const evidence = {
    kind: "test-report",
    referenceId: "artifact:test-report:1",
    contentDigest: EXTERNAL_DIGEST,
  };

  await t.test("verifier is absent", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE",
    );
    assert.equal(fakes.calls.delivererFactory.length, 0);
    assert.equal(fakes.calls.delivery.length, 0);
  });

  await t.test("verifier rejects the record", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => false,
    });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_REJECTED",
    );
    assert.equal(fakes.calls.verify.length, 1);
    assert.equal(fakes.calls.delivererFactory.length, 0);
  });

  await t.test("verifier authorizes the exact evidence binding", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });
    await serviceFrom(fakes).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture, { evidence: [evidence] }),
    });
    assert.deepEqual(fakes.calls.verify, [{
      taskId: fixture.specialist.taskId,
      deliverableId: "implementation",
      evidence,
    }]);
    assert.equal(fakes.calls.delivery.length, 1);
  });
});

function requirementAcceptanceFixture({ tamperSpec = false } = {}) {
  const root = task({ taskId: "root", revision: 3 });
  const shell = task({
    taskId: "root/requirements",
    revision: 2,
    parentTaskId: root.taskId,
    role: "requirements",
    acceptanceContract: contract({
      deliverableId: "requirement-spec",
      kind: "requirement-spec",
    }),
  });
  const spec = createRequirementSpec({
    draft: {
      title: "需求规格",
      problem: "需求需要结构化交接",
      requirements: ["保留需求来源"],
      acceptanceCriteria: ["后续岗位可验证输入"],
      openQuestions: [],
    },
    revision: 1,
    sourceTask: {
      taskId: shell.taskId,
      taskRevision: 1,
      graphRevision: 2,
    },
    acceptedInputs: [],
  });
  const requirements = {
    ...shell,
    deliveries: [{
      deliverableId: "requirement-spec",
      revision: 1,
      contractRevision: 1,
      status: "submitted",
      summary: JSON.stringify(spec),
      evidence: [
        {
          kind: "requirement-spec",
          referenceId: `requirement-spec:${shell.taskId}:1`,
          contentDigest: tamperSpec ? "f".repeat(64) : spec.contentDigest,
        },
        workInputEvidence(shell),
      ],
    }],
  };
  const view = graphView([root, requirements], 3);
  const item = itemFor(root);
  const packet = packetFor(view, root, {
    roleId: "orchestrator",
    directChildren: [requirements],
  });
  return { root, requirements, view, item, packet };
}

test("validates trusted work-input and requirement-spec evidence before acceptance", async (t) => {
  await t.test("valid reserved evidence is accepted", async () => {
    const fixture = requirementAcceptanceFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await serviceFrom(fakes).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: orchestrate({
        ...commonAction("accept_delivery", fixture.requirements, fixture.view),
        submittedDeliveryRevision: 1,
      }),
    });
    assert.equal(fakes.calls.plannerFactory.length, 1);
    assert.equal(fakes.calls.planner[0].method, "decideDelivery");
  });

  await t.test("tampered requirement-spec evidence is rejected", async () => {
    const fixture = requirementAcceptanceFixture({ tamperSpec: true });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate({
          ...commonAction("accept_delivery", fixture.requirements, fixture.view),
          submittedDeliveryRevision: 1,
        }),
      }),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_REJECTED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.planner.length, 0);
  });
});

test("does not retry a failed CAS command", async () => {
  const fixture = rootFixture();
  const conflict = Object.assign(new Error("CAS conflict"), {
    code: "WORK_LEDGER_STALE_REVISION",
  });
  const fakes = fakePorts({
    packet: fixture.packet,
    views: fixture.view,
    plannerResult: conflict,
  });
  await assert.rejects(
    serviceFrom(fakes).execute({
      worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
    }),
    (error) => error === conflict,
  );
  assert.equal(fakes.calls.plannerFactory.length, 1);
  assert.equal(fakes.calls.planner.length, 1);
  assert.equal(fakes.calls.graphReads, 1);
});

test("reconciles an exact uncertain delivery submission without issuing it twice", async () => {
  const fixture = specialistFixture();
  const uncertain = new Error("write result unknown");
  let fakes;
  fakes = fakePorts({
    packet: fixture.packet,
    views: [
      fixture.view,
      () => {
        const command = fakes.calls.delivery[0];
        const submitted = {
          ...fixture.specialist,
          revision: 2,
          deliveries: [{
            deliverableId: command.deliverableId,
            revision: command.deliveryRevision,
            contractRevision: command.contractRevision,
            status: "submitted",
            summary: command.summary,
            evidence: command.evidence,
          }],
        };
        return graphView([fixture.root, submitted], 3);
      },
    ],
    deliveryResult: uncertain,
  });
  const result = await serviceFrom(fakes).execute({
    worker: { roleId: "developer", workerId: "employee-developer" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: submitIntent(fixture),
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "delivery",
    action: "submit_delivery",
    applied: false,
    recovered: true,
    rootTaskId: "root",
    taskId: fixture.specialist.taskId,
    deliveryRevision: 1,
  });
  assert.equal(fakes.calls.delivery.length, 1);
  assert.equal(fakes.calls.delivererFactory.length, 1);
  assert.equal(fakes.calls.graphReads, 2);
});

test("reconciles an exact uncertain delivery decision without deciding twice", async () => {
  const fixture = rootFixture({ submitted: true });
  const uncertain = new Error("decision result unknown");
  let fakes;
  fakes = fakePorts({
    packet: fixture.packet,
    views: [
      fixture.view,
      () => {
        const command = fakes.calls.planner[0].command;
        const submitted = fixture.child.deliveries[0];
        const completed = {
          ...fixture.child,
          revision: 3,
          status: "completed",
          deliveries: [
            submitted,
            {
              deliverableId: submitted.deliverableId,
              revision: 2,
              contractRevision: submitted.contractRevision,
              status: "accepted",
              summary: command.reason,
              evidence: submitted.evidence,
            },
          ],
        };
        return graphView([fixture.root, completed, fixture.dependency], 4);
      },
    ],
    plannerResult: uncertain,
  });
  const result = await serviceFrom(fakes).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate({
      ...commonAction("accept_delivery", fixture.child, fixture.view),
      submittedDeliveryRevision: 1,
    }),
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "orchestration",
    action: "accept_delivery",
    applied: false,
    recovered: true,
    rootTaskId: fixture.root.taskId,
    taskId: fixture.child.taskId,
    deliveryRevision: 2,
  });
  assert.equal(fakes.calls.planner.length, 1);
  assert.equal(fakes.calls.plannerFactory.length, 1);
  assert.equal(fakes.calls.graphReads, 2);
});

test("rejects stale graph bindings and hidden child actions before planner creation", async (t) => {
  await t.test("graph content changed", async () => {
    const fixture = rootFixture();
    const changedChild = { ...fixture.child, revision: 2 };
    const changedView = graphView(
      [fixture.root, changedChild, fixture.dependency],
      4,
    );
    const fakes = fakePorts({ packet: fixture.packet, views: changedView });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error.code === "ORCHESTRATOR_CONTEXT_STALE",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
    assert.equal(fakes.calls.delivererFactory.length, 0);
  });

  await t.test("source child was not visible in the original packet", async () => {
    const fixture = rootFixture();
    const packet = packetFor(fixture.view, fixture.root, {
      roleId: "orchestrator",
      directChildren: [fixture.dependency],
    });
    const fakes = fakePorts({ packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  for (const type of ["accept_delivery", "return_delivery"]) {
    await t.test(`${type} cannot decide a submission outside the review window`, async () => {
      const fixture = rootFixture({ submitted: true });
      const packet = structuredClone(fixture.packet);
      packet.context.requirements.childDeliveries = [];
      const fakes = fakePorts({ packet, views: fixture.view });

      await assert.rejects(
        serviceFrom(fakes).execute({
          worker: {
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
          },
          item: fixture.item,
          contextPacket: packet,
          intent: orchestrate({
            ...commonAction(type, fixture.child, fixture.view),
            submittedDeliveryRevision: 1,
          }),
        }),
        (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
      );
      assert.equal(fakes.calls.plannerFactory.length, 0);
      assert.equal(fakes.calls.delivererFactory.length, 0);
      assert.equal(fakes.calls.planner.length, 0);
    });
  }

  await t.test("capability has no trusted role mapping", async () => {
    const fixture = rootFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    await assert.rejects(
      serviceFrom(fakes, {}).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate({
          ...commonAction("assign", fixture.child, fixture.view),
          capability: "development",
        }),
      }),
      (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });
});

test("propagates the original uncertain-write error when recovery content differs", async () => {
  const fixture = specialistFixture();
  const uncertain = new Error("write result unknown");
  let fakes;
  fakes = fakePorts({
    packet: fixture.packet,
    views: [
      fixture.view,
      () => {
        const command = fakes.calls.delivery[0];
        const submitted = {
          ...fixture.specialist,
          revision: 2,
          deliveries: [{
            deliverableId: command.deliverableId,
            revision: command.deliveryRevision,
            contractRevision: command.contractRevision,
            status: "submitted",
            summary: "different content",
            evidence: command.evidence,
          }],
        };
        return graphView([fixture.root, submitted], 3);
      },
    ],
    deliveryResult: uncertain,
  });
  await assert.rejects(
    serviceFrom(fakes).execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture),
    }),
    (error) => error === uncertain,
  );
  assert.equal(fakes.calls.delivery.length, 1);
  assert.equal(fakes.calls.graphReads, 2);
});

test("does not invoke accessor properties while validating constructor ports", () => {
  let getterCalls = 0;
  const accessorPort = {};
  Object.defineProperty(accessorPort, "assemble", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => ({});
    },
  });
  const fixture = rootFixture();
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  assert.throws(
    () => new OrchestratorService({
      ...fakes.ports,
      contextAssembler: accessorPort,
      capabilityRoles: {},
    }),
    TypeError,
  );
  assert.equal(getterCalls, 0);
});
