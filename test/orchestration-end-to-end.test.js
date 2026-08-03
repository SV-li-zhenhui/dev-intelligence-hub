import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { OrchestratorService } from "../src/services/orchestrator-service.js";
import { ProactiveWorkLoop } from "../src/services/proactive-work-loop.js";
import { RoleContextAssembler } from "../src/services/role-context-assembler.js";
import { WorkGraphStore } from "../src/services/work-graph-store.js";
import { WorkIntentDispatcher } from "../src/services/work-intent-dispatcher.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";

const NOW = "2026-08-03T08:00:00.000Z";

class MemoryStore {
  values = new Map();

  async read(name, fallback = null) {
    return this.values.has(name)
      ? structuredClone(this.values.get(name))
      : structuredClone(fallback);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

class ExclusiveLease {
  tail = Promise.resolve();

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

class AssignmentSource {
  constructor(record) {
    this.record = record;
  }

  async readAssignmentBatch({ afterSequence }) {
    const items = afterSequence < 1 ? [structuredClone(this.record)] : [];
    return {
      items,
      nextSequence: items.length ? 1 : afterSequence,
      highWatermark: 1,
      oldestAvailableSequence: 1,
    };
  }
}

class RoleDirectory {
  constructor(workers) {
    this.workers = new Map(workers.map((worker) => [worker.roleId, worker]));
  }

  async resolve(target) {
    return this.workers.get(target.id) ?? null;
  }
}

function worker(roleId, decide, workerId = `employee-${roleId}`) {
  return {
    roleId,
    workerId,
    enabled: true,
    paused: false,
    decide,
  };
}

function decision(intent, summary) {
  return {
    schemaVersion: 1,
    confidence: 95,
    summary,
    intent,
  };
}

function orchestrationIntent(context, action, summary) {
  return decision({
    schemaVersion: 1,
    type: "orchestrate",
    summary,
    reason: action.reason,
    action,
  }, summary);
}

function actionBase(context, source, type, reason) {
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: source.taskId,
    sourceTaskRevision: source.taskRevision ?? source.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    reason,
  };
}

function acceptanceContract(deliverableId, kind, description) {
  return {
    revision: 1,
    acceptanceCriteria: [
      {
        criterionId: "verified",
        description: "交付内容与证据满足当前任务约定",
      },
    ],
    expectedDeliverables: [
      { deliverableId, kind, description, required: true },
    ],
  };
}

function decompose(context, { childKey, title, capability, dependsOn, contract }) {
  const current = context.requirements.currentTask;
  const reason = `创建 ${title} 岗位任务`;
  return orchestrationIntent(
    context,
    {
      ...actionBase(context, current, "decompose", reason),
      childKey,
      work: { title, description: `${title} 围绕共享任务树交付结果。` },
      capability,
      dependsOn: dependsOn.map(({ taskId, taskRevision }) => ({
        taskId,
        revision: taskRevision,
      })),
      acceptanceContract: contract,
    },
    reason,
  );
}

function decideDelivery(context, child, type, summary) {
  const delivery = child.deliverables.find(({ state }) => state === "submitted");
  const reason = type === "accept_delivery"
    ? "交付满足验收契约"
    : "测试结果需要返工后重新提交";
  return orchestrationIntent(
    context,
    {
      ...actionBase(context, child, type, reason),
      submittedDeliveryRevision: delivery.submittedDeliveryRevision,
    },
    summary,
  );
}

function completeRoot() {
  return decision({
    schemaVersion: 1,
    type: "complete",
    summary: "需求、开发和测试交付均已验收",
    reason: "共享任务树中的所有直属任务均已完成",
    outcome: "done",
    evidence: [],
  }, "根任务可以完成");
}

function childByTitle(context, title) {
  return context.requirements.coordination.directChildren.find(
    ({ work }) => work.title === title,
  );
}

function orchestratorDecision({ context }) {
  const requirements = childByTitle(context, "Requirements");
  const development = childByTitle(context, "Development");
  const testing = childByTitle(context, "Testing");

  if (!requirements) {
    return decompose(context, {
      childKey: "requirements",
      title: "Requirements",
      capability: "requirements",
      dependsOn: [],
      contract: acceptanceContract(
        "requirement-spec",
        "requirement-spec",
        "可追溯的需求规格",
      ),
    });
  }
  if (requirements.deliverables[0].state === "submitted") {
    return decideDelivery(
      context,
      requirements,
      "accept_delivery",
      "接受需求规格",
    );
  }
  if (requirements.status === "completed" && !development) {
    return decompose(context, {
      childKey: "development",
      title: "Development",
      capability: "development",
      dependsOn: [requirements],
      contract: acceptanceContract(
        "implementation",
        "change-package",
        "受控实现变更",
      ),
    });
  }
  if (development?.deliverables[0].state === "submitted") {
    return decideDelivery(
      context,
      development,
      "accept_delivery",
      "接受开发交付",
    );
  }
  if (development?.status === "completed" && !testing) {
    return decompose(context, {
      childKey: "testing",
      title: "Testing",
      capability: "testing",
      dependsOn: [development],
      contract: acceptanceContract(
        "test-report",
        "test-report",
        "自动化测试报告",
      ),
    });
  }
  if (testing?.deliverables[0].state === "submitted") {
    const firstAttempt = testing.deliverables[0].submittedDeliveryRevision === 1;
    return decideDelivery(
      context,
      testing,
      firstAttempt ? "return_delivery" : "accept_delivery",
      firstAttempt ? "退回失败测试" : "接受返工后的测试报告",
    );
  }
  if (
    [requirements, development, testing].every(
      ({ status }) => status === "completed",
    )
  ) {
    return completeRoot();
  }
  throw new Error("orchestrator fixture reached an unexpected graph state");
}

function submitDelivery({ context, item }, deliverableId, artifact, summary) {
  const current = context.requirements.currentTask;
  return decision({
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: current.taskId,
    expectedTaskRevision: current.revision,
    expectedGraphRevision: context.requirements.graph.revision,
    contractRevision: current.acceptanceContract.revision,
    deliverableId,
    summary,
    reason: "完成当前岗位交付",
    evidence: [],
    artifact,
  }, `${item.itemId} 提交 ${deliverableId}`);
}

function requirementDraft() {
  return {
    title: "多岗位共享交付流程",
    problem: "多个岗位必须在同一任务树中传递经过验收的输入。",
    requirements: ["开发只读取已验收规格", "测试只读取已验收实现"],
    acceptanceCriteria: ["测试失败可退回返工", "最终根任务可完成"],
    openQuestions: [],
  };
}

async function fixture() {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: NOW,
    source: { provider: "github", scopeId: "command-center" },
    subject: { id: "issue-901", repository: "acme/dashboard", number: 901 },
    payload: { number: 901, title: "Build one shared delivery loop" },
  });
  const source = new AssignmentSource({
    sequence: 1,
    assignment: {
      assignmentId: "assignment-shared-loop",
      eventId: event.eventId,
      target: { type: "role", id: "orchestrator" },
      reason: "coordinate_delivery",
    },
    event,
  });
  let nextLease = 1;
  const ledger = new WorkLedgerService({
    store: new MemoryStore(),
    assignmentSource: source,
    exclusiveLease: new ExclusiveLease(),
    clock: () => NOW,
    idFactory: () => `lease-${nextLease++}`,
  });
  await ledger.recover();
  const graph = new WorkGraphStore({ ledger });
  const graphReader = graph.reader();
  const contextAssembler = new RoleContextAssembler({ graphReader });
  const orchestratorService = new OrchestratorService({
    contextAssembler,
    graphReader,
    scopedGraphPlannerFactory: {
      forRoot({ scopeRootTaskId }) {
        return graph.planner({
          principalId: "employee-orchestrator",
          scopeRootTaskId,
        });
      },
    },
    graphDelivererFactory: {
      forClaim({ scopeRootTaskId, taskId, workerId, leaseId }) {
        return graph.deliverer({
          principalId: workerId,
          scopeRootTaskId,
          taskId,
          leaseId,
        });
      },
    },
    capabilityRoles: {
      requirements: "requirements-analyst",
      development: "developer",
      testing: "tester",
    },
  });
  let testingAttempts = 0;
  const workers = [
    worker(
      "orchestrator",
      orchestratorDecision,
      "employee-orchestrator",
    ),
    worker("requirements-analyst", (input) => submitDelivery(
      input,
      "requirement-spec",
      requirementDraft(),
      "需求规格完成",
    )),
    worker("developer", (input) => submitDelivery(
      input,
      "implementation",
      null,
      "实现完成并通过开发验证",
    )),
    worker("tester", (input) => {
      testingAttempts += 1;
      return submitDelivery(
        input,
        "test-report",
        null,
        testingAttempts === 1
          ? "测试失败：边界场景未通过"
          : "返工后全部测试通过",
      );
    }),
  ];
  const loop = new ProactiveWorkLoop({
    ledger,
    roleDirectory: new RoleDirectory(workers),
    roleContextAssembler: contextAssembler,
    orchestratorService,
    clock: () => NOW,
    leaseDurationMs: 120_000,
    resolveTimeoutMs: 5_000,
    decideTimeoutMs: 30_000,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
  });
  return { ledger, graphReader, loop, getTestingAttempts: () => testingAttempts };
}

test("requirements, development, and testing iteratively complete one shared task tree", async () => {
  const { ledger, graphReader, loop, getTestingAttempts } = await fixture();

  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "requirements-analyst" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "developer" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "tester" });
  await loop.runCycle({ roleId: "orchestrator" });
  await loop.runCycle({ roleId: "tester" });
  await loop.runCycle({ roleId: "orchestrator" });
  const finalCycle = await loop.runCycle({ roleId: "orchestrator" });

  assert.equal(finalCycle.staged, 1);
  const dispatcher = new WorkIntentDispatcher({
    ledger,
    policy: createWorkIntentPolicy({
      capabilityRoles: {
        requirements: "requirements-analyst",
        development: "developer",
        testing: "tester",
      },
    }),
    attentionProducer: { async create() {} },
    proposalProducer: { async create() {} },
    clock: () => NOW,
  });
  const dispatched = await dispatcher.dispatchPending();

  assert.equal(dispatched.delivered, 1);
  assert.equal(getTestingAttempts(), 2);
  const snapshot = await graphReader.getSnapshot();
  assert.equal(snapshot.graph.tasks.length, 4);
  assert.deepEqual(
    snapshot.graph.tasks.map(({ status }) => status),
    ["completed", "completed", "completed", "completed"],
  );
  const testing = snapshot.graph.tasks.find(
    (task) => snapshot.taskStates.find(
      ({ taskId }) => taskId === task.taskId,
    ).work.title === "Testing",
  );
  assert.deepEqual(
    testing.deliveries.map(({ status }) => status),
    ["submitted", "rejected", "submitted", "accepted"],
  );
  const items = await ledger.listItems({ limit: 100 });
  assert.equal(items.items.length, 4);
  assert.equal(new Set(items.items.map(({ itemId }) => itemId)).size, 4);
});
