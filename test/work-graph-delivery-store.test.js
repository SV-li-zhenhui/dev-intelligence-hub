import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { workGraphMemoryRecordReceipt } from "../src/domain/work-graph-memory-event.js";
import { WorkGraphStore } from "../src/services/work-graph-store.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";

const STATE_KEY = "work-ledger-state";
const NOW = "2026-08-03T01:00:00.000Z";

class MemoryStore {
  constructor() {
    this.values = new Map();
    this.writes = [];
    this.nextWriteError = null;
  }

  async read(name, fallback = null) {
    return this.values.has(name)
      ? structuredClone(this.values.get(name))
      : structuredClone(fallback);
  }

  async write(name, value) {
    if (this.nextWriteError) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    const copy = structuredClone(value);
    this.values.set(name, copy);
    this.writes.push({ name, value: copy });
  }

  failNextWrite(error = new Error("durable write failed")) {
    this.nextWriteError = error;
  }
}

class ExclusiveLease {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

class AssignmentSource {
  constructor(records) {
    this.records = records;
  }

  async readAssignmentBatch({ afterSequence, limit }) {
    const items = this.records
      .filter(({ sequence }) => sequence > afterSequence)
      .slice(0, limit);
    return structuredClone({
      items,
      nextSequence: items.at(-1)?.sequence ?? afterSequence,
      highWatermark: this.records.at(-1)?.sequence ?? 0,
      oldestAvailableSequence: this.records[0]?.sequence ?? 1,
    });
  }
}

function assignment(sequence) {
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: "2026-08-03T00:00:00.000Z",
    source: { provider: "github", scopeId: "delivery-tests" },
    subject: {
      id: `issue-${sequence}`,
      repository: "acme/dashboard",
      number: sequence,
    },
    payload: { number: sequence, title: `Issue ${sequence}` },
  });
  return {
    sequence,
    assignment: {
      assignmentId: `assignment-${sequence}`,
      eventId: event.eventId,
      target: { type: "role", id: "orchestrator" },
      reason: "delivery-test",
    },
    event,
  };
}

function createService({
  store,
  lease,
  source,
  idPrefix = "lease",
  clock = () => NOW,
  limits,
}) {
  let nextId = 1;
  return new WorkLedgerService({
    store,
    assignmentSource: source,
    exclusiveLease: lease,
    clock,
    idFactory: () => `${idPrefix}-${nextId++}`,
    ...(limits ? { limits } : {}),
  });
}

async function fixture(rootCount = 1, clock = () => NOW, limits) {
  const store = new MemoryStore();
  const lease = new ExclusiveLease();
  const source = new AssignmentSource(
    Array.from({ length: rootCount }, (_, index) => assignment(index + 1)),
  );
  const service = createService({ store, lease, source, clock, limits });
  await service.recover();
  await service.intake();
  return { store, lease, source, service };
}

function acceptanceContract({ revision = 1, version = "v1", one = false } = {}) {
  const expectedDeliverables = [
    {
      deliverableId: "implementation",
      kind: "change-package",
      description: `可验证的实现结果 ${version}`,
      required: true,
    },
  ];
  if (!one) {
    expectedDeliverables.push({
      deliverableId: "test-report",
      kind: "test-report",
      description: `自动化验证结果 ${version}`,
      required: true,
    });
  }
  return {
    revision,
    acceptanceCriteria: [
      { criterionId: "implemented", description: `实现约定行为 ${version}` },
      { criterionId: "tested", description: `通过自动化验证 ${version}` },
    ],
    expectedDeliverables,
  };
}

function createChildCommand(parent, graphRevision, contract) {
  return {
    parentTaskId: parent.itemId,
    childKey: "delivery-work",
    work: {
      title: "实现可验收交付",
      description: "提交证据并由协调员工验收。",
    },
    target: { type: "role", id: "developer" },
    dependsOnTaskIds: [],
    acceptanceContract: contract,
    leaseId: null,
    expectedGraphRevision: graphRevision,
    expectedTaskRevisions: [
      { taskId: parent.itemId, revision: parent.revision },
    ],
  };
}

function coordinator(graph, scopeRootTaskId = null, principalId = "orchestrator") {
  return graph.planner({ principalId, scopeRootTaskId });
}

function evidence(seed = "a") {
  return [{
    kind: "change-package",
    referenceId: `package:${seed}`,
    contentDigest: seed.repeat(64),
  }];
}

function submissionCommand({
  task,
  graphRevision,
  deliveryRevision = task.graph.deliveries.length + 1,
  contractRevision = task.graph.acceptanceContracts.at(-1).revision,
  deliverableId = "implementation",
  summary = "实现已完成并通过验证",
  proof = evidence("a"),
}) {
  return {
    deliveryRevision,
    contractRevision,
    deliverableId,
    summary,
    evidence: proof,
    expectedGraphRevision: graphRevision,
    expectedTaskRevision: task.revision,
  };
}

function decisionCommand({
  task,
  graphRevision,
  submittedDeliveryRevision,
  decision = "accept",
  reason = "证据满足验收契约",
}) {
  return {
    taskId: task.itemId,
    submittedDeliveryRevision,
    decision,
    reason,
    expectedGraphRevision: graphRevision,
    expectedTaskRevision: task.revision,
  };
}

async function itemById(service, itemId) {
  const item = (await service.listItems()).items.find(
    (candidate) => candidate.itemId === itemId,
  );
  assert.ok(item, `missing work item ${itemId}`);
  return item;
}

async function graphRevision(service) {
  return (await service.getGraphSnapshot()).graph.revision;
}

async function graphTimelineTypes(service, itemId) {
  return (await service.listTimeline({ limit: 100 })).items
    .filter(
      (entry) =>
        entry.itemId === itemId &&
        ["graph_acceptance_", "graph_delivery_"].some((prefix) =>
          entry.type.startsWith(prefix)
        ),
    )
    .map(({ type }) => type);
}

async function provisionGraphTask({
  rootCount = 1,
  contract,
  clock = () => NOW,
  limits,
} = {}) {
  const environment = await fixture(rootCount, clock, limits);
  const { service } = environment;
  const roots = (await service.listItems()).items;
  const parent = roots.at(-1);
  const graph = new WorkGraphStore({ ledger: service });
  const created = await coordinator(graph).createChild(
    createChildCommand(parent, await graphRevision(service), contract),
  );
  const task = await itemById(service, created.taskId);
  return { ...environment, roots, parent, graph, task };
}

async function claimTask(service, task, workerId = "developer") {
  return service.claim({
    itemId: task.itemId,
    expectedRevision: task.revision,
    workerId,
    leaseDurationMs: 30_000,
  });
}

function deliverer(graph, task, {
  principalId = task.ownerId,
  scopeRootTaskId = null,
  leaseId = task.leaseId,
} = {}) {
  return graph.deliverer({
    principalId,
    scopeRootTaskId,
    taskId: task.itemId,
    leaseId,
  });
}

async function submitCurrent({
  graph,
  service,
  task,
  deliverableId = "implementation",
  proof = evidence("a"),
  summary,
}) {
  const command = submissionCommand({
    task,
    graphRevision: await graphRevision(service),
    deliverableId,
    proof,
    ...(summary === undefined ? {} : { summary }),
  });
  const result = await deliverer(graph, task).submitDelivery(command);
  return { command, result, task: await itemById(service, task.itemId) };
}

test("queued acceptance contracts are revisioned and normalized idempotently", async () => {
  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  const planner = coordinator(graph);
  const revisedContract = acceptanceContract({ revision: 2, version: "v2" });
  const command = {
    taskId: task.itemId,
    acceptanceContract: revisedContract,
    reason: "验收范围已澄清",
    expectedGraphRevision: await graphRevision(service),
    expectedTaskRevision: task.revision,
  };

  const revised = await planner.reviseAcceptanceContract(command);
  assert.equal(revised.applied, true);
  assert.equal(revised.contractRevision, 2);
  const stored = await itemById(service, task.itemId);
  assert.equal(stored.graph.acceptanceContracts[0].recordedAt, NOW);
  assert.equal(stored.graph.acceptanceContracts[1].recordedAt, NOW);
  const projected = await graph.reader().getSnapshot();
  const projectedTask = projected.graph.tasks.find(
    ({ taskId }) => taskId === task.itemId,
  );
  assert.equal(
    Object.hasOwn(projectedTask.acceptanceContracts[0], "recordedAt"),
    false,
  );
  const writesAfterRevision = store.writes.length;

  const replay = await planner.reviseAcceptanceContract({
    ...command,
    acceptanceContract: {
      ...revisedContract,
      acceptanceCriteria: [...revisedContract.acceptanceCriteria].reverse(),
      expectedDeliverables: [...revisedContract.expectedDeliverables].reverse(),
    },
  });
  assert.equal(replay.applied, false);
  assert.equal(store.writes.length, writesAfterRevision);
  assert.deepEqual(
    await graphTimelineTypes(service, task.itemId),
    ["graph_acceptance_revised"],
  );

  await assert.rejects(
    planner.reviseAcceptanceContract({
      ...command,
      acceptanceContract: {
        ...revisedContract,
        acceptanceCriteria: revisedContract.acceptanceCriteria.map((entry) =>
          entry.criterionId === "implemented"
            ? { ...entry, description: "不同的验收内容" }
            : entry),
      },
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_CONTRACT_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterRevision);

  await assert.rejects(
    planner.reviseAcceptanceContract({
      ...command,
      acceptanceContract: { ...revisedContract, recordedAt: NOW },
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  );
});

test("trusted command times are durable and idempotent across the delivery lifecycle", async () => {
  let now = "2026-08-03T01:00:00.000Z";
  const { service, graph, task } = await provisionGraphTask({
    contract: acceptanceContract({ one: true }),
    clock: () => now,
  });
  const planner = coordinator(graph);
  const revisedContract = acceptanceContract({
    revision: 2,
    version: "v2",
    one: true,
  });
  const revisionCommand = {
    taskId: task.itemId,
    acceptanceContract: revisedContract,
    reason: "按最新范围验收",
    expectedGraphRevision: await graphRevision(service),
    expectedTaskRevision: task.revision,
  };

  now = "2026-08-04T02:00:00.000Z";
  await planner.reviseAcceptanceContract(revisionCommand);
  now = "2026-08-04T03:00:00.000Z";
  await planner.reviseAcceptanceContract(revisionCommand);
  let current = await itemById(service, task.itemId);
  assert.equal(
    current.graph.acceptanceContracts[1].recordedAt,
    "2026-08-04T02:00:00.000Z",
  );

  now = "2026-08-05T03:00:00.000Z";
  const working = await claimTask(service, current);
  const submitCommand = submissionCommand({
    task: working,
    graphRevision: await graphRevision(service),
  });
  await deliverer(graph, working).submitDelivery(submitCommand);
  now = "2026-08-05T03:30:00.000Z";
  await deliverer(graph, working).submitDelivery(submitCommand);
  current = await itemById(service, task.itemId);
  assert.equal(
    current.graph.deliveries[0].recordedAt,
    "2026-08-05T03:00:00.000Z",
  );

  const decideCommand = decisionCommand({
    task: current,
    graphRevision: await graphRevision(service),
    submittedDeliveryRevision: 1,
  });
  now = "2026-08-06T04:00:00.000Z";
  await planner.decideDelivery(decideCommand);
  now = "2026-08-06T05:00:00.000Z";
  await planner.decideDelivery(decideCommand);
  current = await itemById(service, task.itemId);
  assert.equal(
    current.graph.deliveries[1].recordedAt,
    "2026-08-06T04:00:00.000Z",
  );
});

test("every graph history change is atomically queued and acknowledged in order", async () => {
  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract({ one: true }),
  });
  const planner = coordinator(graph);
  await planner.reviseAcceptanceContract({
    taskId: task.itemId,
    acceptanceContract: acceptanceContract({
      revision: 2,
      version: "v2",
      one: true,
    }),
    reason: "明确最终验收范围",
    expectedGraphRevision: await graphRevision(service),
    expectedTaskRevision: task.revision,
  });
  let current = await itemById(service, task.itemId);
  current = await claimTask(service, current);
  await deliverer(graph, current).submitDelivery(submissionCommand({
    task: current,
    graphRevision: await graphRevision(service),
    contractRevision: 2,
  }));
  current = await itemById(service, task.itemId);
  await planner.decideDelivery(decisionCommand({
    task: current,
    graphRevision: await graphRevision(service),
    submittedDeliveryRevision: 1,
  }));

  const firstBatch = await service.readGraphMemoryProjectionBatch({ limit: 2 });
  assert.equal(firstBatch.cursor, 0);
  assert.equal(firstBatch.highWatermark, 5);
  assert.equal(firstBatch.items.length, 2);
  assert.deepEqual(
    (await service.readGraphMemoryProjectionBatch({ limit: 100 })).items.map(
      ({ kind }) => kind,
    ),
    [
      "acceptance_contract",
      "acceptance_contract",
      "acceptance_contract",
      "delivery_submitted",
      "delivery_accepted",
    ],
  );

  const firstReceipts = firstBatch.items.map(workGraphMemoryRecordReceipt);
  const writesBeforeBatch = store.writes.length;
  const applied = await service.acknowledgeGraphMemoryProjectionBatch({
    receipts: firstReceipts,
  });
  assert.deepEqual(applied, {
    status: "applied",
    cursor: 2,
    highWatermark: 5,
  });
  assert.equal(store.writes.length, writesBeforeBatch + 1);
  const writesAfterAck = store.writes.length;
  assert.deepEqual(
    await service.acknowledgeGraphMemoryProjection(firstReceipts.at(-1)),
    { status: "already", cursor: 2, highWatermark: 5 },
  );
  assert.equal(store.writes.length, writesAfterAck);

  const nextBatch = await service.readGraphMemoryProjectionBatch({ limit: 2 });
  const nextReceipts = nextBatch.items.map(workGraphMemoryRecordReceipt);
  const forgedReceipts = structuredClone(nextReceipts);
  forgedReceipts[1].memoryRecordId = `memory-${"0".repeat(64)}`;
  forgedReceipts[1].memoryRecordDigest = "0".repeat(64);
  await assert.rejects(
    service.acknowledgeGraphMemoryProjectionBatch({
      receipts: forgedReceipts,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_MEMORY_BINDING_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterAck);
  store.failNextWrite();
  await assert.rejects(
    service.acknowledgeGraphMemoryProjectionBatch({ receipts: nextReceipts }),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.deepEqual(
    (await service.readGraphMemoryProjectionBatch({ limit: 2 })).items.map(
      ({ eventId }) => eventId,
    ),
    nextBatch.items.map(({ eventId }) => eventId),
  );
  assert.equal(
    (await service.acknowledgeGraphMemoryProjectionBatch({
      receipts: nextReceipts,
    })).cursor,
    4,
  );
});

test("graph memory capacity rejects graph mutation atomically and permits retry after acknowledgement", async () => {
  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract({ one: true }),
    limits: { graphMemoryOutboxLimit: 2 },
  });
  const planner = coordinator(graph);
  const before = await store.read(STATE_KEY);
  const writesBefore = store.writes.length;

  await assert.rejects(
    planner.reviseAcceptanceContract({
      taskId: task.itemId,
      acceptanceContract: acceptanceContract({
        revision: 2,
        version: "capacity-retry",
        one: true,
      }),
      reason: "验证容量恢复",
      expectedGraphRevision: await graphRevision(service),
      expectedTaskRevision: task.revision,
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_MEMORY_CAPACITY_EXCEEDED",
  );
  assert.equal(store.writes.length, writesBefore);
  assert.deepEqual(await store.read(STATE_KEY), before);

  const firstEvent = (await service.readGraphMemoryProjectionBatch({ limit: 1 }))
    .items[0];
  await service.acknowledgeGraphMemoryProjection(
    workGraphMemoryRecordReceipt(firstEvent),
  );
  const current = await itemById(service, task.itemId);
  await planner.reviseAcceptanceContract({
    taskId: current.itemId,
    acceptanceContract: acceptanceContract({
      revision: 2,
      version: "capacity-retry",
      one: true,
    }),
    reason: "验证容量恢复",
    expectedGraphRevision: await graphRevision(service),
    expectedTaskRevision: current.revision,
  });
  assert.equal(
    (await itemById(service, task.itemId)).graph.acceptanceContracts.length,
    2,
  );
});

test("acceptance revisions reject unchanged content and non-queued tasks without writes", async (t) => {
  await t.test("unchanged content", async () => {
    const { service, store, graph, task } = await provisionGraphTask({
      contract: acceptanceContract(),
    });
    const writesBefore = store.writes.length;

    await assert.rejects(
      coordinator(graph).reviseAcceptanceContract({
        taskId: task.itemId,
        acceptanceContract: acceptanceContract({ revision: 2 }),
        reason: "没有实际变化",
        expectedGraphRevision: await graphRevision(service),
        expectedTaskRevision: task.revision,
      }),
      (error) => error.code === "WORK_LEDGER_GRAPH_CONTRACT_CONFLICT",
    );
    assert.equal(store.writes.length, writesBefore);
  });

  await t.test("working task", async () => {
    const { service, store, graph, task } = await provisionGraphTask({
      contract: acceptanceContract(),
    });
    const working = await claimTask(service, task);
    const writesBefore = store.writes.length;

    await assert.rejects(
      coordinator(graph).reviseAcceptanceContract({
        taskId: working.itemId,
        acceptanceContract: acceptanceContract({ revision: 2, version: "v2" }),
        reason: "工作中不可改约",
        expectedGraphRevision: await graphRevision(service),
        expectedTaskRevision: working.revision,
      }),
      (error) => error.code === "WORK_LEDGER_GRAPH_TASK_CONFLICT",
    );
    assert.equal(store.writes.length, writesBefore);
  });
});

test("only the exact bound lease owner can submit and submission clears the lease", async () => {
  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  const working = await claimTask(service, task, "developer");
  const command = submissionCommand({
    task: working,
    graphRevision: await graphRevision(service),
  });
  const writesBefore = store.writes.length;

  await assert.rejects(
    deliverer(graph, working, { leaseId: "wrong-lease" })
      .submitDelivery(command),
    (error) => error.code === "WORK_LEDGER_LEASE_CONFLICT",
  );
  await assert.rejects(
    deliverer(graph, working, { principalId: "different-employee" })
      .submitDelivery(command),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_AUTHORITY_DENIED" &&
      error.statusCode === 403,
  );
  assert.equal(store.writes.length, writesBefore);

  const submitted = await deliverer(graph, working).submitDelivery(command);
  assert.equal(submitted.applied, true);
  assert.equal(submitted.deliveryStatus, "submitted");
  assert.equal(submitted.taskStatus, "waiting_external");
  const current = await itemById(service, task.itemId);
  assert.equal(current.status, "waiting_external");
  assert.equal(current.statusReason, "delivery_submitted");
  assert.equal(current.ownerId, null);
  assert.equal(current.leaseId, null);
  assert.equal(current.leaseUntil, null);
  assert.equal(current.graph.deliveries[0].recordedAt, NOW);
  const projected = await graph.reader().getSnapshot();
  const projectedTask = projected.graph.tasks.find(
    ({ taskId }) => taskId === task.itemId,
  );
  assert.equal(Object.hasOwn(projectedTask.deliveries[0], "recordedAt"), false);
});

test("stale, unknown, and duplicate submissions converge without an unintended write", async () => {
  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  const working = await claimTask(service, task);
  const currentRevision = await graphRevision(service);
  const valid = submissionCommand({ task: working, graphRevision: currentRevision });
  const writesBefore = store.writes.length;

  await assert.rejects(
    deliverer(graph, working).submitDelivery({
      ...valid,
      expectedGraphRevision: currentRevision - 1,
    }),
    (error) => error.code === "WORK_LEDGER_STATE_REVISION_CONFLICT",
  );
  await assert.rejects(
    deliverer(graph, working).submitDelivery({
      ...valid,
      deliverableId: "unknown-deliverable",
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
  );
  assert.equal(store.writes.length, writesBefore);

  const first = await deliverer(graph, working).submitDelivery(valid);
  assert.equal(first.applied, true);
  const writesAfterSubmit = store.writes.length;
  const replay = await deliverer(graph, working).submitDelivery(valid);
  assert.equal(replay.applied, false);
  assert.equal(store.writes.length, writesAfterSubmit);

  await assert.rejects(
    deliverer(graph, working).submitDelivery({
      ...valid,
      summary: "相同 revision 的不同内容",
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
  );
  const waiting = await itemById(service, task.itemId);
  await assert.rejects(
    deliverer(graph, working).submitDelivery(submissionCommand({
      task: waiting,
      graphRevision: await graphRevision(service),
      deliveryRevision: 2,
    })),
    (error) => error.code === "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterSubmit);
});

test("a delivery decision is evidence-bound, replayable, and cannot be changed", async () => {
  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  const working = await claimTask(service, task);
  const submitted = await submitCurrent({
    graph,
    service,
    task: working,
    proof: evidence("b"),
  });
  const command = decisionCommand({
    task: submitted.task,
    graphRevision: await graphRevision(service),
    submittedDeliveryRevision: submitted.result.deliveryRevision,
  });

  const accepted = await coordinator(graph).decideDelivery(command);
  assert.equal(accepted.applied, true);
  assert.equal(accepted.deliveryStatus, "accepted");
  assert.equal(accepted.taskStatus, "queued");
  const current = await itemById(service, task.itemId);
  assert.equal(current.graph.deliveries[0].recordedAt, NOW);
  assert.equal(current.graph.deliveries[1].recordedAt, NOW);
  assert.deepEqual(current.graph.deliveries[1].evidence, evidence("b"));
  assert.deepEqual(
    current.graph.deliveries[1].evidence,
    current.graph.deliveries[0].evidence,
  );
  const writesAfterDecision = store.writes.length;

  const replay = await coordinator(graph).decideDelivery(command);
  assert.equal(replay.applied, false);
  assert.equal(store.writes.length, writesAfterDecision);
  await assert.rejects(
    coordinator(graph).decideDelivery({
      ...command,
      decision: "reject",
      reason: "改成拒绝",
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
  );
  await assert.rejects(
    coordinator(graph).decideDelivery({
      ...command,
      reason: "改变同一结论的说明",
    }),
    (error) => error.code === "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
  );
  assert.equal(store.writes.length, writesAfterDecision);
  assert.deepEqual(
    await graphTimelineTypes(service, task.itemId),
    ["graph_delivery_submitted", "graph_delivery_accepted"],
  );
});

test("a rejected delivery can be reworked, resubmitted, and accepted", async () => {
  const { service, graph, task } = await provisionGraphTask({
    contract: acceptanceContract({ one: true }),
  });
  let working = await claimTask(service, task);
  const first = await submitCurrent({
    graph,
    service,
    task: working,
    proof: evidence("c"),
  });
  const rejected = await coordinator(graph).decideDelivery(decisionCommand({
    task: first.task,
    graphRevision: await graphRevision(service),
    submittedDeliveryRevision: 1,
    decision: "reject",
    reason: "缺少边界场景验证",
  }));
  assert.equal(rejected.deliveryStatus, "rejected");
  assert.equal(rejected.taskStatus, "queued");
  let current = await itemById(service, task.itemId);
  assert.deepEqual(current.graph.deliveries[1].evidence, evidence("c"));

  working = await claimTask(service, current);
  const second = await submitCurrent({
    graph,
    service,
    task: working,
    proof: evidence("d"),
    summary: "补齐边界验证后重新提交",
  });
  assert.equal(second.result.deliveryRevision, 3);
  const accepted = await coordinator(graph).decideDelivery(decisionCommand({
    task: second.task,
    graphRevision: await graphRevision(service),
    submittedDeliveryRevision: 3,
    reason: "返工证据满足要求",
  }));
  assert.equal(accepted.deliveryRevision, 4);
  assert.equal(accepted.taskStatus, "completed");
  current = await itemById(service, task.itemId);
  assert.deepEqual(
    current.graph.deliveries.map(({ status }) => status),
    ["submitted", "rejected", "submitted", "accepted"],
  );
  assert.deepEqual(current.graph.deliveries[3].evidence, evidence("d"));
  assert.deepEqual(
    await graphTimelineTypes(service, task.itemId),
    [
      "graph_delivery_submitted",
      "graph_delivery_rejected",
      "graph_delivery_submitted",
      "graph_delivery_accepted",
    ],
  );
});

test("partial acceptance stays queued until the final required deliverable is accepted", async () => {
  const { service, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  let working = await claimTask(service, task);
  let submitted = await submitCurrent({
    graph,
    service,
    task: working,
    deliverableId: "implementation",
    proof: evidence("e"),
  });
  const partial = await coordinator(graph).decideDelivery(decisionCommand({
    task: submitted.task,
    graphRevision: await graphRevision(service),
    submittedDeliveryRevision: 1,
  }));
  assert.equal(partial.taskStatus, "queued");

  let current = await itemById(service, task.itemId);
  working = await claimTask(service, current);
  submitted = await submitCurrent({
    graph,
    service,
    task: working,
    deliverableId: "test-report",
    proof: evidence("f"),
  });
  assert.equal(submitted.result.deliveryRevision, 3);
  const complete = await coordinator(graph).decideDelivery(decisionCommand({
    task: submitted.task,
    graphRevision: await graphRevision(service),
    submittedDeliveryRevision: 3,
  }));
  assert.equal(complete.deliveryRevision, 4);
  assert.equal(complete.taskStatus, "completed");
  current = await itemById(service, task.itemId);
  assert.equal(current.status, "completed");
  assert.equal(current.statusReason, "deliverables_accepted");
});

test("a failed durable submission has no ghost write and the exact retry succeeds", async () => {
  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  const working = await claimTask(service, task);
  const command = submissionCommand({
    task: working,
    graphRevision: await graphRevision(service),
  });
  const writesBefore = store.writes.length;
  store.failNextWrite();

  await assert.rejects(
    deliverer(graph, working).submitDelivery(command),
    (error) => error.code === "WORK_LEDGER_STATE_WRITE_FAILED",
  );
  assert.equal(store.writes.length, writesBefore);
  let current = await itemById(service, task.itemId);
  assert.equal(current.status, "working");
  assert.deepEqual(current.graph.deliveries, []);

  const retried = await deliverer(graph, working).submitDelivery(command);
  assert.equal(retried.applied, true);
  current = await itemById(service, task.itemId);
  assert.equal(current.status, "waiting_external");
  assert.equal(current.graph.deliveries.length, 1);
});

test("two services racing different content for one delivery revision have one winner", async () => {
  const { service, store, lease, source, graph, task } =
    await provisionGraphTask({ contract: acceptanceContract() });
  const working = await claimTask(service, task);
  const contender = createService({
    store,
    lease,
    source,
    idPrefix: "contender-lease",
  });
  await contender.recover();
  const contenderGraph = new WorkGraphStore({ ledger: contender });
  const revision = await graphRevision(service);
  const writesBefore = store.writes.length;
  const firstCommand = submissionCommand({
    task: working,
    graphRevision: revision,
    proof: evidence("1"),
  });
  const secondCommand = submissionCommand({
    task: working,
    graphRevision: revision,
    proof: evidence("2"),
  });

  const settled = await Promise.allSettled([
    deliverer(graph, working).submitDelivery(firstCommand),
    deliverer(contenderGraph, working).submitDelivery(secondCommand),
  ]);
  assert.equal(settled.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(settled.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(
    settled.find(({ status }) => status === "rejected").reason.code,
    "WORK_LEDGER_GRAPH_DELIVERY_CONFLICT",
  );
  assert.equal(store.writes.length, writesBefore + 1);
  const durable = store.values.get(STATE_KEY);
  const durableTask = durable.items.find(({ itemId }) => itemId === task.itemId);
  assert.equal(durableTask.graph.deliveries.length, 1);
});

test("deliverer and coordinator scopes cannot cross their bound subtree", async () => {
  const { service, store, roots, graph, task } = await provisionGraphTask({
    rootCount: 2,
    contract: acceptanceContract(),
  });
  const outsideRoot = roots[0];
  const working = await claimTask(service, task);
  const command = submissionCommand({
    task: working,
    graphRevision: await graphRevision(service),
  });
  const writesBefore = store.writes.length;

  await assert.rejects(
    deliverer(graph, working, { scopeRootTaskId: outsideRoot.itemId })
      .submitDelivery(command),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_SCOPE_DENIED" &&
      error.statusCode === 403,
  );
  assert.equal(store.writes.length, writesBefore);

  await deliverer(graph, working).submitDelivery(command);
  const waiting = await itemById(service, task.itemId);
  const writesAfterSubmit = store.writes.length;
  await assert.rejects(
    coordinator(graph, outsideRoot.itemId).decideDelivery(decisionCommand({
      task: waiting,
      graphRevision: await graphRevision(service),
      submittedDeliveryRevision: 1,
    })),
    (error) =>
      error.code === "WORK_LEDGER_GRAPH_SCOPE_DENIED" &&
      error.statusCode === 403,
  );
  assert.equal(store.writes.length, writesAfterSubmit);
});

test("delivery ports and commands reject accessors without invoking them", async () => {
  let portAccessorInvoked = false;
  const hostileLedger = {
    getGraphSnapshot() {},
    createGraphChild() {},
    reviseGraphAcceptance() {},
    decideGraphDelivery() {},
  };
  Object.defineProperty(hostileLedger, "submitGraphDelivery", {
    get() {
      portAccessorInvoked = true;
      return () => {};
    },
  });
  assert.throws(
    () => new WorkGraphStore({ ledger: hostileLedger }),
    TypeError,
  );
  assert.equal(portAccessorInvoked, false);

  const { service, store, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  const working = await claimTask(service, task);
  const command = submissionCommand({
    task: working,
    graphRevision: await graphRevision(service),
  });
  let commandAccessorInvoked = false;
  Object.defineProperty(command, "evidence", {
    enumerable: true,
    get() {
      commandAccessorInvoked = true;
      return evidence("9");
    },
  });
  const writesBefore = store.writes.length;

  await assert.rejects(
    deliverer(graph, working).submitDelivery(command),
    (error) => error.code === "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  );
  assert.equal(commandAccessorInvoked, false);
  assert.equal(store.writes.length, writesBefore);
});

test("delivery commands are snapshotted before entering the ledger queue", async () => {
  const { service, graph, task } = await provisionGraphTask({
    contract: acceptanceContract(),
  });
  const working = await claimTask(service, task);
  const command = submissionCommand({
    task: working,
    graphRevision: await graphRevision(service),
    summary: "调用时的交付说明",
    proof: evidence("8"),
  });

  const pending = deliverer(graph, working).submitDelivery(command);
  command.summary = "调用后的篡改说明";
  command.evidence[0].referenceId = "package:mutated";
  command.evidence[0].contentDigest = "7".repeat(64);
  await pending;

  const current = await itemById(service, task.itemId);
  assert.equal(current.graph.deliveries[0].summary, "调用时的交付说明");
  assert.deepEqual(current.graph.deliveries[0].evidence, evidence("8"));
});
