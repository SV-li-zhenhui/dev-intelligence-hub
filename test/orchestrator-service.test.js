import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createRequirementSpec } from "../src/domain/requirement-spec-contract.js";
import { deliveryAcceptanceContractDigest } from
  "../src/domain/delivery-evidence-contract.js";
import { createWorkGraphSnapshot } from "../src/domain/work-graph-contract.js";
import {
  OrchestratorService,
  OrchestratorServiceError,
} from "../src/services/orchestrator-service.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";

const INPUT_DIGEST = "a".repeat(64);
const CONTEXT_DIGEST = "b".repeat(64);
const EXTERNAL_DIGEST = "c".repeat(64);

function deliverableEvidence(kind = "change-package", suffix = "1") {
  return {
    kind,
    referenceId: `artifact:${kind}:${suffix}`,
    contentDigest: EXTERNAL_DIGEST,
  };
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

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
}

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
  event,
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
    context: {
      requirements,
      ...(event === undefined ? {} : { code: { sourceEvent: event } }),
    },
    acceptedInputs,
    contextDigest: CONTEXT_DIGEST,
  };
}

function structuredTriageEvent(capability) {
  return {
    eventType: "pull_request.owner_requested",
    source: { provider: "local-owner", scopeId: "owner-request:test" },
    payload: {
      workType: "general",
      nextAction: capability === "development" ? "fix_ci" : "review",
      suggestedCapability: capability,
      expectedHeadRefOid: "d".repeat(40),
    },
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
    "resumeTask",
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

function serviceFrom(
  fakes,
  capabilityRoles = {
    development: "developer",
    testing: "tester",
  },
  actionAdmissionGate,
) {
  return new OrchestratorService({
    ...fakes.ports,
    capabilityRoles,
    ...(actionAdmissionGate === undefined ? {} : { actionAdmissionGate }),
  });
}

function rootFixture({
  submitted = false,
  externalEvidence = [deliverableEvidence()],
  childContract = contract(),
} = {}) {
  const root = task({ taskId: "root", revision: 3 });
  const child = task({
    taskId: "root/child",
    revision: submitted ? 2 : 1,
    parentTaskId: root.taskId,
    role: "developer",
    acceptanceContract: childContract,
    deliveries: submitted
      ? [
          {
            deliverableId: childContract.expectedDeliverables[0].deliverableId,
            revision: 1,
            contractRevision: 1,
            status: "submitted",
            summary: "实现说明",
            evidence: [
              ...externalEvidence,
              workInputEvidence({
                taskId: "root/child",
                responsibility: { type: "role", id: "developer" },
              }),
            ],
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

function executeDeliveryDecision(fakes, fixture, type) {
  return serviceFrom(fakes).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate({
      ...commonAction(type, fixture.child, fixture.view),
      submittedDeliveryRevision: 1,
    }),
  });
}

function assertNoTrustedMutation(calls) {
  assert.equal(calls.plannerFactory.length, 0);
  assert.equal(calls.delivererFactory.length, 0);
  assert.equal(calls.planner.length, 0);
  assert.equal(calls.delivery.length, 0);
}

test("maps all eight orchestration actions to the least-authority planner commands", async (t) => {
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
      name: "resume",
      build: ({ child, view }) => commonAction("resume", child, view),
      method: "resumeTask",
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
        verifier: () => true,
        plannerResult: (method, command) => ({
          applied: true,
          taskId: method === "createChild" ? "root/new-child" : command.taskId,
          deliveryRevision: command.submittedDeliveryRevision + 1,
          ownerId: "private-owner",
          leaseId: "private-lease",
          evidence: [{ private: true }],
        }),
      });
      const admissions = [];
      const result = await serviceFrom(fakes, undefined, {
        run(operation) {
          admissions.push(scenario.name);
          return operation();
        },
      }).execute({
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
      assert.deepEqual(admissions, [scenario.name]);
      assert.equal(Object.isFrozen(fakes.calls.planner[0].command), true);
      assert.equal(Object.isFrozen(result), true);
      assert.doesNotMatch(JSON.stringify(result), /private-owner|private-lease|evidence/);
    });
  }
});

test("structured PR triage creates exactly one child for its trusted capability", async (t) => {
  for (const capability of ["development", "pr-review"]) {
    await t.test(capability, async () => {
      const root = task({ taskId: `root-${capability}`, revision: 1 });
      const view = graphView([root], 1);
      const item = itemFor(root);
      const packet = packetFor(view, root, {
        roleId: "orchestrator",
        directChildren: [],
        event: structuredTriageEvent(capability),
      });
      const fakes = fakePorts({ packet, views: view });
      const reason = "Create the trusted triage child";
      const result = await serviceFrom(fakes, {
        development: "developer",
        "pr-review": "pr-engineer",
      }).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item,
        contextPacket: packet,
        intent: orchestrate({
          ...commonAction("decompose", root, view, reason),
          childKey: `triage-${capability}`,
          work: { title: "Handle PR", description: "Use trusted PR intake" },
          capability,
          dependsOn: [],
          acceptanceContract: contract({
            kind: capability === "development"
              ? "change-package"
              : "github-review",
          }),
        }),
      });

      assert.equal(result.action, "decompose");
      assert.deepEqual(fakes.calls.planner[0].command.target, {
        type: "role",
        id: capability === "development" ? "developer" : "pr-engineer",
      });
    });
  }
});

test("structured PR triage rejects capability drift, a second child, and premature control", async (t) => {
  const cases = [
    {
      name: "mismatched capability",
      children: [],
      action(root, view) {
        return {
          ...commonAction("decompose", root, view),
          childKey: "wrong-capability",
          work: { title: "Wrong", description: "Must be rejected" },
          capability: "pr-review",
          dependsOn: [],
          acceptanceContract: contract({ kind: "github-review" }),
        };
      },
    },
    {
      name: "second child",
      children: [task({
        taskId: "root/existing",
        parentTaskId: "root",
        role: "developer",
      })],
      action(root, view) {
        return {
          ...commonAction("decompose", root, view),
          childKey: "duplicate",
          work: { title: "Duplicate", description: "Must be rejected" },
          capability: "development",
          dependsOn: [],
          acceptanceContract: contract(),
        };
      },
    },
    {
      name: "premature pause",
      children: [],
      action: (root, view) => commonAction("pause", root, view),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = task({ taskId: "root", revision: 1 });
      const view = graphView([root, ...scenario.children], 1);
      const item = itemFor(root);
      const packet = packetFor(view, root, {
        roleId: "orchestrator",
        directChildren: scenario.children,
        event: structuredTriageEvent("development"),
      });
      const fakes = fakePorts({ packet, views: view });
      await assert.rejects(
        serviceFrom(fakes, {
          development: "developer",
          "pr-review": "pr-engineer",
        }).execute({
          worker: {
            roleId: "orchestrator",
            workerId: "employee-orchestrator",
          },
          item,
          contextPacket: packet,
          intent: orchestrate(scenario.action(root, view)),
        }),
        (error) => error.code === "ORCHESTRATOR_AUTHORITY_DENIED",
      );
      assertNoTrustedMutation(fakes.calls);
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

test("classifies context reassembly failures without hiding availability", async (t) => {
  await t.test("preserves the service-owned context timeout", async () => {
    const fixture = rootFixture();
    let contextSignal;
    const fakes = fakePorts({
      packet(input) {
        contextSignal = input.signal;
        return new Promise(() => {});
      },
      views: fixture.view,
    });
    const service = new OrchestratorService({
      ...fakes.ports,
      evidenceVerificationTimeoutMs: 1,
    });

    await assert.rejects(
      service.execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE" &&
        error.statusCode === 503,
    );

    assert.equal(contextSignal instanceof AbortSignal, true);
    assert.equal(contextSignal.aborted, true);
    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("maps a producer 5xx to context unavailable", async () => {
    const fixture = rootFixture();
    const outage = Object.assign(new Error("evidence catalog unavailable"), {
      code: "ROLE_CONTEXT_EVIDENCE_UNAVAILABLE",
      statusCode: 503,
    });
    const fakes = fakePorts({
      packet() {
        throw outage;
      },
      views: fixture.view,
    });

    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_CONTEXT_UNAVAILABLE" &&
        error.statusCode === 503 &&
        error.cause === outage,
    );

    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("maps a producer binding mismatch to stale", async () => {
    const fixture = rootFixture();
    const mismatch = Object.assign(new Error("task revision changed"), {
      code: "ROLE_CONTEXT_STALE",
      statusCode: 409,
    });
    const fakes = fakePorts({
      packet() {
        throw mismatch;
      },
      views: fixture.view,
    });

    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_CONTEXT_STALE" &&
        error.statusCode === 409 &&
        error.cause === mismatch,
    );

    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });
});

test("an expired root lease does not constrain orchestration evidence reads", async () => {
  const fixture = rootFixture();
  const now = Date.parse("2026-08-03T08:00:00.000Z");
  fixture.item.status = "working";
  fixture.item.ownerId = "previous-orchestrator";
  fixture.item.leaseId = "expired-root-lease";
  fixture.item.leaseUntil = new Date(now - 1_000).toISOString();
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  const service = new OrchestratorService({
    ...fakes.ports,
    clock: () => new Date(now),
  });

  const result = await service.execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
  });

  assert.equal(result.applied, true);
  assert.equal(fakes.calls.assemble.length, 1);
  assert.equal(fakes.calls.planner.length, 1);
});

test("rejects locally unbound submissions before applying lease deadlines", async (t) => {
  const now = Date.parse("2026-08-03T08:00:00.000Z");

  await t.test("root orchestrator", async () => {
    const fixture = rootFixture();
    fixture.item.status = "working";
    fixture.item.ownerId = "employee-orchestrator";
    fixture.item.leaseId = "expired-root-lease";
    fixture.item.leaseUntil = new Date(now - 1_000).toISOString();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    const service = new OrchestratorService({
      ...fakes.ports,
      clock: () => new Date(now),
    });

    await assert.rejects(
      service.execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: {
          schemaVersion: 1,
          type: "submit_delivery",
          taskId: fixture.root.taskId,
          expectedTaskRevision: fixture.root.revision,
          expectedGraphRevision: fixture.view.graph.revision,
          contractRevision: 1,
          deliverableId: "implementation",
          summary: "不允许的根任务交付",
          reason: "根编排者不能提交岗位交付",
          evidence: [],
          artifact: null,
        },
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_AUTHORITY_DENIED" &&
        error.statusCode === 403,
    );

    assert.equal(fakes.calls.assemble.length, 0);
    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("wrong lease owner", async () => {
    const fixture = specialistFixture();
    fixture.item.ownerId = "another-developer";
    fixture.item.leaseUntil = new Date(now - 1_000).toISOString();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    const service = new OrchestratorService({
      ...fakes.ports,
      clock: () => new Date(now),
    });

    await assert.rejects(
      service.execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_AUTHORITY_DENIED" &&
        error.statusCode === 403,
    );

    assert.equal(fakes.calls.assemble.length, 0);
    assert.equal(fakes.calls.graphReads, 0);
    assertNoTrustedMutation(fakes.calls);
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

function signedContextPacket(packet, view) {
  const result = structuredClone(packet);
  result.binding.graphRevision = view.graph.revision;
  result.binding.graphContentDigest = view.graph.contentDigest;
  result.context.requirements.graph = {
    graphId: view.graph.graphId,
    revision: view.graph.revision,
    contentDigest: view.graph.contentDigest,
  };
  result.contextDigest = digest({
    domain: "mydashboard-role-context/v1",
    binding: result.binding,
    dataClasses: Object.keys(result.context).sort(),
    context: result.context,
  });
  return result;
}

test("scoped decisions survive unrelated graph changes with authenticated context", async (t) => {
  for (const role of ["orchestrator", "developer"]) {
    await t.test(role, async () => {
      const fixture = role === "orchestrator" ? rootFixture() : specialistFixture();
      const changed = graphView([
        ...fixture.view.graph.tasks,
        task({ taskId: "unrelated-root" }),
      ], fixture.view.graph.revision + 1);
      const original = signedContextPacket(fixture.packet, fixture.view);
      const fresh = signedContextPacket(original, changed);
      const fakes = fakePorts({ packet: fresh, views: changed });
      await serviceFrom(fakes).execute({
        worker: { roleId: role, workerId: `employee-${role}` },
        item: fixture.item,
        contextPacket: original,
        intent: role === "orchestrator"
          ? orchestrate(commonAction("pause", fixture.child, fixture.view))
          : submitIntent(fixture),
      });
      const command = role === "orchestrator"
        ? fakes.calls.planner[0].command
        : fakes.calls.delivery[0];
      assert.equal(command.expectedGraphRevision, changed.graph.revision);
      assert.equal(original.binding.graphRevision, fixture.view.graph.revision);
    });
  }
});

test("scoped rebase rejects changed inputs, forged digests and intent revisions", async (t) => {
  for (const mutation of [
    "task", "source", "acceptedInputs", "contract", "originalDigest",
    "freshDigest", "intentRevision", "sameRevision", "rollback", "inconsistentGraph",
  ]) {
    await t.test(mutation, async () => {
      const fixture = rootFixture();
      if (mutation === "rollback") {
        fixture.view = graphView(fixture.view.graph.tasks, fixture.view.graph.revision + 1);
      }
      const changed = graphView([
        ...fixture.view.graph.tasks,
        task({ taskId: "unrelated-root" }),
      ], fixture.view.graph.revision + (mutation === "sameRevision" ? 0 : mutation === "rollback" ? -1 : 1));
      const original = signedContextPacket(fixture.packet, fixture.view);
      let fresh = signedContextPacket(original, changed);
      if (mutation === "task") fresh.binding.taskRevision += 1;
      if (mutation === "source") fresh.context.requirements.source = { head: "new" };
      if (mutation === "acceptedInputs") fresh.acceptedInputs = [{ changed: true }];
      if (mutation === "contract") fresh.binding.contractRevision += 1;
      fresh = signedContextPacket(fresh, changed);
      if (mutation === "inconsistentGraph") {
        fresh.context.requirements.graph.revision += 1;
        fresh.contextDigest = digest({
          domain: "mydashboard-role-context/v1",
          binding: fresh.binding,
          dataClasses: Object.keys(fresh.context).sort(),
          context: fresh.context,
        });
      }
      if (mutation === "originalDigest") original.contextDigest = "f".repeat(64);
      if (mutation === "freshDigest") fresh.contextDigest = "f".repeat(64);
      const action = commonAction("pause", fixture.child, fixture.view);
      if (mutation === "intentRevision") action.expectedGraphRevision = changed.graph.revision;
      const fakes = fakePorts({ packet: fresh, views: changed });
      await assert.rejects(serviceFrom(fakes).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: original,
        intent: orchestrate(action),
      }), (error) => error.code === "ORCHESTRATOR_CONTEXT_STALE");
      assertNoTrustedMutation(fakes.calls);
    });
  }
});

test("submits ordinary and requirement-spec deliveries with trusted evidence", async (t) => {
  await t.test("ordinary delivery", async () => {
    const fixture = specialistFixture();
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
    let admissions = 0;
    const result = await serviceFrom(fakes, undefined, {
      run(operation) {
        admissions += 1;
        return operation();
      },
    }).execute({
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
    assert.equal(admissions, 1);
    assert.equal(Object.isFrozen(fakes.calls.delivery[0]), true);
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

test("requires requirement-spec deliverable id and kind in both directions", async (t) => {
  const mismatches = [
    {
      name: "reserved id with a non-requirement kind",
      deliverableId: "requirement-spec",
      kind: "change-package",
      artifact: {
        title: "需求规格",
        problem: "需要验证保留交付物绑定",
        requirements: ["交付物 ID 与 kind 必须一致"],
        acceptanceCriteria: ["不一致绑定在执行前被拒绝"],
        openQuestions: [],
      },
    },
    {
      name: "reserved kind with a non-requirement id",
      deliverableId: "implementation",
      kind: "requirement-spec",
    },
  ];

  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async () => {
      const fixture = specialistFixture(mismatch);
      const fakes = fakePorts({
        packet: fixture.packet,
        views: fixture.view,
        verifier: () => true,
      });

      await assert.rejects(
        serviceFrom(fakes).execute({
          worker: { roleId: "developer", workerId: "employee-developer" },
          item: fixture.item,
          contextPacket: fixture.packet,
          intent: submitIntent(fixture, {
            deliverableId: mismatch.deliverableId,
            artifact: mismatch.artifact ?? null,
          }),
        }),
        (error) =>
          error instanceof OrchestratorServiceError &&
          error.code === "ORCHESTRATOR_EVIDENCE_REJECTED" &&
          error.statusCode === 409,
      );

      assert.equal(fakes.calls.verify.length, 0);
      assertNoTrustedMutation(fakes.calls);
    });
  }
});

test("configuration-first admission performs no trusted graph mutation", async (t) => {
  await t.test("orchestration", async () => {
    const fixture = rootFixture();
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    await assert.rejects(
      serviceFrom(fakes, undefined, gate).execute({
        worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
      }),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    assert.equal(fakes.calls.planner.length, 0);
    assert.equal(fakes.calls.delivery.length, 0);
  });

  await t.test("delivery submission", async () => {
    const fixture = specialistFixture();
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    await assert.rejects(
      serviceFrom(fakes, undefined, gate).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture),
      }),
      (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
    );

    assert.equal(fakes.calls.planner.length, 0);
    assert.equal(fakes.calls.delivery.length, 0);
  });
});

test("mutation-first admission releases cutover before graph storage settles", async () => {
  const fixture = rootFixture();
  const gate = readyActionAdmissionGate();
  const mutationEntered = deferred();
  const mutationResult = deferred();
  const fakes = fakePorts({
    packet: fixture.packet,
    views: fixture.view,
    plannerResult(method, command) {
      mutationEntered.resolve({ method, command });
      return mutationResult.promise;
    },
  });
  const execution = serviceFrom(fakes, undefined, gate).execute({
    worker: { roleId: "orchestrator", workerId: "employee-orchestrator" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: orchestrate(commonAction("pause", fixture.child, fixture.view)),
  });
  const admitted = await mutationEntered.promise;
  const cutover = activateNextConfiguration(gate);
  const cutoverFinishedFirst = await Promise.race([
    cutover.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);

  mutationResult.resolve({ applied: true, taskId: fixture.child.taskId });
  await cutover;
  const result = await execution;

  assert.equal(cutoverFinishedFirst, true);
  assert.equal(gate.readStatus().mode, "restart_required");
  assert.equal(admitted.method, "pauseTask");
  assert.equal(Object.isFrozen(admitted.command), true);
  assert.equal(fakes.calls.planner.length, 1);
  assert.equal(result.applied, true);
});

test("requires matching authoritative evidence before accepting non-requirement deliveries", async (t) => {
  await t.test("trusted text reports do not require external evidence", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [],
      childContract: contract({
        deliverableId: "analysis-report",
        kind: "text-report",
      }),
    });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    const result = await executeDeliveryDecision(
      fakes,
      fixture,
      "accept_delivery",
    );

    assert.equal(result.action, "accept_delivery");
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.planner.length, 1);
  });

  await t.test("legacy evidence-free submission cannot be accepted", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [],
    });
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });

    await assert.rejects(
      executeDeliveryDecision(fakes, fixture, "accept_delivery"),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_REJECTED",
    );
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  await t.test("supporting evidence cannot replace the contract evidence kind", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [deliverableEvidence("test-report")],
    });
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });

    await assert.rejects(
      executeDeliveryDecision(fakes, fixture, "accept_delivery"),
      (error) => error.code === "ORCHESTRATOR_EVIDENCE_REJECTED",
    );
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  await t.test("matching evidence still requires a configured verifier", async () => {
    const fixture = rootFixture({ submitted: true });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    await assert.rejects(
      executeDeliveryDecision(fakes, fixture, "accept_delivery"),
      (error) =>
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE",
    );
    assert.equal(fakes.calls.plannerFactory.length, 0);
  });

  await t.test("verified primary and supporting evidence can be accepted", async () => {
    const primary = deliverableEvidence();
    const supporting = deliverableEvidence("test-report");
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [supporting, primary],
    });
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier: () => true,
    });

    await executeDeliveryDecision(fakes, fixture, "accept_delivery");

    assert.deepEqual(
      fakes.calls.verify.map(({ evidence }) => evidence.kind),
      ["change-package", "test-report"],
    );
    assert.equal(fakes.calls.planner.length, 1);
  });

  await t.test("returning incomplete evidence remains allowed", async () => {
    const fixture = rootFixture({
      submitted: true,
      externalEvidence: [],
    });
    const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });

    const result = await executeDeliveryDecision(
      fakes,
      fixture,
      "return_delivery",
    );

    assert.equal(result.action, "return_delivery");
    assert.equal(fakes.calls.verify.length, 0);
    assert.equal(fakes.calls.planner.length, 1);
  });
});

test("rejects a delivery bound to a superseded acceptance contract", async () => {
  const base = rootFixture({ submitted: true });
  const child = {
    ...base.child,
    acceptanceContracts: [
      ...base.child.acceptanceContracts,
      { ...contract(), revision: 2 },
    ],
  };
  const view = graphView(
    [base.root, child, base.dependency],
    base.view.graph.revision,
  );
  const fixture = {
    ...base,
    child,
    view,
    packet: packetFor(view, base.root, {
      roleId: "orchestrator",
      directChildren: [child, base.dependency],
    }),
  };
  const fakes = fakePorts({
    packet: fixture.packet,
    views: fixture.view,
    verifier: () => true,
  });

  await assert.rejects(
    executeDeliveryDecision(fakes, fixture, "accept_delivery"),
    (error) =>
      error instanceof OrchestratorServiceError &&
      error.code === "ORCHESTRATOR_CONTEXT_STALE" &&
      error.statusCode === 409,
  );

  assert.equal(fakes.calls.verify.length, 0);
  assertNoTrustedMutation(fakes.calls);
});

test("rechecks graph authority after successful evidence verification", async (t) => {
  const changes = [
    {
      name: "graph revision changed",
      currentView(fixture) {
        return graphView(
          [fixture.root, fixture.child, fixture.dependency],
          fixture.view.graph.revision + 1,
        );
      },
    },
    {
      name: "graph content digest changed",
      currentView(fixture) {
        return graphView(
          [
            { ...fixture.root, status: "in_progress" },
            fixture.child,
            fixture.dependency,
          ],
          fixture.view.graph.revision,
        );
      },
    },
  ];

  for (const change of changes) {
    await t.test(change.name, async () => {
      const fixture = rootFixture({ submitted: true });
      const changedView = change.currentView(fixture);
      const fakes = fakePorts({
        packet: fixture.packet,
        views: [fixture.view, changedView],
        verifier: () => true,
      });

      await assert.rejects(
        executeDeliveryDecision(fakes, fixture, "accept_delivery"),
        (error) =>
          error instanceof OrchestratorServiceError &&
          error.code === "ORCHESTRATOR_CONTEXT_STALE" &&
          error.statusCode === 409,
      );

      assert.equal(fakes.calls.verify.length, 1);
      assert.equal(fakes.calls.graphReads, 2);
      assertNoTrustedMutation(fakes.calls);
    });
  }
});

test("fails closed on unverifiable caller evidence before obtaining a deliverer", async (t) => {
  const evidence = {
    kind: "change-package",
    referenceId: "artifact:change-package:1",
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
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_REJECTED" &&
        error.statusCode === 409,
    );
    assert.equal(fakes.calls.verify.length, 1);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("transient verifier failure is retryable and mutation-free", async () => {
    const fixture = specialistFixture();
    const outage = new Error("evidence registry unavailable");
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier() {
        throw outage;
      },
    });

    await assert.rejects(
      serviceFrom(fakes).execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE" &&
        error.statusCode === 503 &&
        error.cause === outage,
    );

    assert.equal(fakes.calls.verify.length, 1);
    assertNoTrustedMutation(fakes.calls);
  });

  await t.test("timed-out verification cannot mutate late and can be retried", async () => {
    const fixture = specialistFixture();
    const lateVerification = deferred();
    let verificationAttempts = 0;
    let timedOutSignal;
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier(input) {
        verificationAttempts += 1;
        if (verificationAttempts === 1) {
          timedOutSignal = input.signal;
          return lateVerification.promise;
        }
        return true;
      },
    });
    const service = new OrchestratorService({
      ...fakes.ports,
      evidenceVerificationTimeoutMs: 1,
    });
    const execute = () => service.execute({
      worker: { roleId: "developer", workerId: "employee-developer" },
      item: fixture.item,
      contextPacket: fixture.packet,
      intent: submitIntent(fixture, { evidence: [evidence] }),
    });

    await assert.rejects(
      execute(),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE" &&
        error.statusCode === 503,
    );
    assert.equal(timedOutSignal instanceof AbortSignal, true);
    assert.equal(timedOutSignal.aborted, true);
    assert.equal(fakes.calls.verify.length, 1);
    assertNoTrustedMutation(fakes.calls);

    lateVerification.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    assertNoTrustedMutation(fakes.calls);

    const result = await execute();

    assert.equal(result.applied, true);
    assert.equal(verificationAttempts, 2);
    assert.equal(fakes.calls.verify.length, 2);
    assert.equal(fakes.calls.delivererFactory.length, 1);
    assert.equal(fakes.calls.delivery.length, 1);
  });

  await t.test("verification timeout preserves a mutation margin inside the work lease", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = specialistFixture();
    const now = Date.parse("2026-08-03T08:00:00.000Z");
    fixture.item.leaseUntil = new Date(now + 30_000).toISOString();
    let verificationSignal;
    const fakes = fakePorts({
      packet: fixture.packet,
      views: fixture.view,
      verifier(input) {
        verificationSignal = input.signal;
        return new Promise(() => {});
      },
    });
    const service = new OrchestratorService({
      ...fakes.ports,
      evidenceVerificationTimeoutMs: 60_000,
      evidenceMutationMarginMs: 20_000,
      clock: () => new Date(now),
    });

    const execution = assert.rejects(
      service.execute({
        worker: { roleId: "developer", workerId: "employee-developer" },
        item: fixture.item,
        contextPacket: fixture.packet,
        intent: submitIntent(fixture, { evidence: [evidence] }),
      }),
      (error) =>
        error instanceof OrchestratorServiceError &&
        error.code === "ORCHESTRATOR_EVIDENCE_VERIFIER_UNAVAILABLE",
    );

    try {
      for (
        let attempt = 0;
        verificationSignal === undefined && attempt < 100;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      assert.equal(verificationSignal instanceof AbortSignal, true);

      t.mock.timers.tick(8_000);
      await Promise.resolve();
      assert.equal(verificationSignal.aborted, false);

      t.mock.timers.tick(3_000);
      await Promise.resolve();
      assert.equal(verificationSignal.aborted, true);
      await execution;
    } finally {
      t.mock.timers.runAll();
      t.mock.timers.reset();
    }
    assertNoTrustedMutation(fakes.calls);
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
    assert.equal(fakes.calls.verify.length, 1);
    const [{ signal, ...authority }] = fakes.calls.verify;
    assert.deepEqual(authority, {
      taskId: fixture.specialist.taskId,
      roleId: "developer",
      contractRevision: 1,
      contractDigest: deliveryAcceptanceContractDigest(
        fixture.specialist.acceptanceContracts.at(-1),
      ),
      deliverableId: "implementation",
      evidence,
    });
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, false);
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

test("does not retry a synchronously failed CAS command", async () => {
  const fixture = rootFixture();
  const conflict = Object.assign(new Error("CAS conflict"), {
    code: "WORK_LEDGER_STALE_REVISION",
  });
  const fakes = fakePorts({
    packet: fixture.packet,
    views: fixture.view,
  });
  fakes.ports.scopedGraphPlannerFactory.forRoot = (request) => {
    fakes.calls.plannerFactory.push(request);
    return {
      pauseTask(command) {
        fakes.calls.planner.push({ method: "pauseTask", command });
        throw conflict;
      },
    };
  };
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

test("a synchronous delivery-port failure still enters exact recovery", async () => {
  const fixture = specialistFixture();
  const uncertain = new Error("synchronous write result unknown");
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
  });
  fakes.ports.graphDelivererFactory.forClaim = (request) => {
    fakes.calls.delivererFactory.push(request);
    return {
      submitDelivery(command) {
        fakes.calls.delivery.push(command);
        throw uncertain;
      },
    };
  };

  const result = await serviceFrom(fakes).execute({
    worker: { roleId: "developer", workerId: "employee-developer" },
    item: fixture.item,
    contextPacket: fixture.packet,
    intent: submitIntent(fixture),
  });

  assert.equal(result.recovered, true);
  assert.equal(fakes.calls.delivery.length, 1);
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
    verifier: () => true,
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
  assert.equal(fakes.calls.graphReads, 3);
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

test("rejects an explicit invalid action admission gate", () => {
  const fixture = rootFixture();
  const fakes = fakePorts({ packet: fixture.packet, views: fixture.view });
  assert.throws(
    () => serviceFrom(fakes, undefined, null),
    /actionAdmissionGate is invalid/,
  );
});
