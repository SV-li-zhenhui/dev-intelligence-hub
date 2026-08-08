import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplication } from "../src/composition-root.js";
import { StateStore } from "../src/lib/state-store.js";

const CHANGE_PACKAGE_EVIDENCE = Object.freeze({
  kind: "change-package",
  referenceId: "change-package:command-center:implementation",
  contentDigest: "1".repeat(64),
});
const FAILED_TEST_EVIDENCE = Object.freeze({
  kind: "test-report",
  referenceId: "test-report:command-center:failed",
  contentDigest: "2".repeat(64),
});
const PASSED_TEST_EVIDENCE = Object.freeze({
  kind: "test-report",
  referenceId: "test-report:command-center:passed",
  contentDigest: "3".repeat(64),
});

class TestGuard {
  async acquire() {}

  run(operation) {
    return operation();
  }

  async close() {}
}

function guardFactory() {
  return new TestGuard();
}

function textResponse(value) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    }),
  };
}

function decision(intent, summary = intent.summary) {
  return {
    schemaVersion: 1,
    confidence: 97,
    summary,
    intent,
  };
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

function orchestrate(context, action, summary) {
  return decision({
    schemaVersion: 1,
    type: "orchestrate",
    summary,
    reason: action.reason,
    action,
  }, summary);
}

function acceptanceContract(deliverableId, kind, description) {
  return {
    revision: 1,
    acceptanceCriteria: [{
      criterionId: "verified",
      description: "The submitted artifact and its trusted evidence satisfy the task.",
    }],
    expectedDeliverables: [{
      deliverableId,
      kind,
      description,
      required: true,
    }],
  };
}

function childByTitle(context, title) {
  return context.requirements.coordination.directChildren.find(
    ({ work }) => work.title === title,
  );
}

function decompose(context, {
  childKey,
  title,
  capability,
  dependsOn = [],
  contract,
}) {
  const root = context.requirements.currentTask;
  const reason = `Create the ${title} task in the shared command graph.`;
  return orchestrate(context, {
    ...actionBase(context, root, "decompose", reason),
    childKey,
    work: {
      title,
      description: `${title} contributes one accepted input to the same Issue graph.`,
    },
    capability,
    dependsOn: dependsOn.map(({ taskId, taskRevision, revision }) => ({
      taskId,
      revision: taskRevision ?? revision,
    })),
    acceptanceContract: contract,
  }, reason);
}

function decideDelivery(context, child, type) {
  const submitted = child.deliverables.find(({ state }) => state === "submitted");
  const reason = type === "accept_delivery"
    ? `Accept the verified ${child.work.title} delivery.`
    : `Return the failed ${child.work.title} delivery for rework.`;
  return orchestrate(context, {
    ...actionBase(context, child, type, reason),
    submittedDeliveryRevision: submitted.submittedDeliveryRevision,
  }, reason);
}

function controlTask(context, child, type) {
  const reason = type === "pause"
    ? "Pause testing at the explicit command-center checkpoint."
    : "Resume testing after the command-center checkpoint is acknowledged.";
  return orchestrate(
    context,
    actionBase(context, child, type, reason),
    reason,
  );
}

function completeRoot() {
  return decision({
    schemaVersion: 1,
    type: "complete",
    summary: "The Issue requirements, implementation, and repaired tests are accepted.",
    reason: "Every required child in the shared graph has an accepted delivery.",
    outcome: "done",
    evidence: [],
  });
}

function orchestrationDecision(context, state) {
  const requirements = childByTitle(context, "Requirements");
  const development = childByTitle(context, "Development");
  const testing = childByTitle(context, "Testing");

  if (!requirements) {
    return decompose(context, {
      childKey: "requirements",
      title: "Requirements",
      capability: "requirements",
      contract: acceptanceContract(
        "requirement-spec",
        "requirement-spec",
        "A traceable requirement specification.",
      ),
    });
  }
  if (requirements.deliverables[0].state === "submitted") {
    return decideDelivery(context, requirements, "accept_delivery");
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
        "A bounded implementation change package.",
      ),
    });
  }
  if (development?.deliverables[0].state === "submitted") {
    return decideDelivery(context, development, "accept_delivery");
  }
  if (development?.status === "completed" && !testing) {
    return decompose(context, {
      childKey: "testing",
      title: "Testing",
      capability: "testing",
      dependsOn: [development],
      contract: acceptanceContract(
        "verification",
        "test-report",
        "A repeatable verification report.",
      ),
    });
  }
  if (
    testing?.status === "pending" &&
    testing.deliverables[0].state === "none" &&
    state.testingControl === "not-paused"
  ) {
    state.testingControl = "pause-requested";
    return controlTask(context, testing, "pause");
  }
  if (testing?.status === "paused") {
    state.testingControl = "resumed";
    return controlTask(context, testing, "resume");
  }
  if (testing?.deliverables[0].state === "submitted") {
    const submitted = context.code.childDeliveries.find(
      ({ taskId, state }) => taskId === testing.taskId && state === "submitted",
    );
    const failed = submitted.evidence.some(
      ({ referenceId }) => referenceId === FAILED_TEST_EVIDENCE.referenceId,
    );
    return decideDelivery(
      context,
      testing,
      failed ? "return_delivery" : "accept_delivery",
    );
  }
  if (
    [requirements, development, testing].every(
      ({ status }) => status === "completed",
    )
  ) {
    return completeRoot();
  }
  throw new Error("command-center orchestrator reached an unexpected graph state");
}

function requirementDraft() {
  return {
    title: "Issue command-center acceptance flow",
    problem: "One Issue must remain traceable across requirements, development, and testing.",
    requirements: [
      "Development consumes only an accepted requirement specification.",
      "Testing consumes only an accepted implementation.",
      "A failed test delivery is returned and replaced before completion.",
    ],
    acceptanceCriteria: [
      "The shared graph reaches a terminal accepted state.",
      "The terminal history is searchable in local memory.",
    ],
    openQuestions: [],
  };
}

function submitDelivery(context, {
  deliverableId,
  summary,
  evidence = [],
  artifact = null,
}) {
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
    reason: "The assigned specialist completed the bounded deliverable.",
    evidence,
    artifact,
  });
}

function roleDecision(model, context, state) {
  if (model === "command-orchestrator") {
    return orchestrationDecision(context, state);
  }
  if (model === "requirements-brain") {
    return submitDelivery(context, {
      deliverableId: "requirement-spec",
      summary: "The requirement specification is ready.",
      artifact: requirementDraft(),
    });
  }
  if (model === "development-brain") {
    state.developmentContexts.push(structuredClone(context));
    return submitDelivery(context, {
      deliverableId: "implementation",
      summary: "The implementation package is ready.",
      evidence: [CHANGE_PACKAGE_EVIDENCE],
    });
  }
  assert.equal(model, "testing-brain");
  state.testingContexts.push(structuredClone(context));
  const evidence = state.testingContexts.length === 1
    ? FAILED_TEST_EVIDENCE
    : PASSED_TEST_EVIDENCE;
  return submitDelivery(context, {
    deliverableId: "verification",
    summary: evidence === FAILED_TEST_EVIDENCE
      ? "Boundary verification failed and requires rework."
      : "The repaired boundary verification passed.",
    evidence: [evidence],
  });
}

function createBrainFetch(state) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const context = JSON.parse(body.messages[1].content);
    state.brainCalls.push({
      url,
      model: body.model,
      context: structuredClone(context),
    });
    const response = roleDecision(body.model, context, state);
    return textResponse({ message: { content: JSON.stringify(response) } });
  };
}

function role(name, model, allowedIntents, workerId = undefined) {
  return {
    name,
    mission: `${name} advances one bounded part of the shared Issue graph.`,
    enabled: true,
    scheduleMinutes: 0,
    initialPaused: false,
    ...(workerId === undefined ? {} : { workerId }),
    permissions: { allowedIntents },
    brain: {
      provider: "fixture-local",
      model,
      remoteData: { requirements: false, code: false, memory: false },
    },
  };
}

function config() {
  return {
    port: 4173,
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    dingtalk: { enabled: false },
    githubActions: { enabled: false },
    codeExecutor: { enabled: false },
    changePackages: { enabled: false },
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [{
        id: "issue-to-command-orchestrator",
        source: "root",
        enabled: true,
        priority: 100,
        fallback: false,
        condition: { op: "equals", path: "eventType", value: "issue.created" },
        targets: [{ type: "role", id: "orchestrator" }],
        onMatch: "stop",
      }],
    },
    workCoordination: {
      enabled: true,
      intakeLimit: 20,
      workLimit: 20,
      dispatchLimit: 20,
      attentionLimit: 20,
      proposalLimit: 20,
      conditionLimit: 20,
      codeJobLimit: 20,
      codeJobMemoryLimit: 20,
      leaseDurationMs: 60_000,
      resolveTimeoutMs: 5_000,
      decisionTimeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 1_000,
      retryMaxMs: 2_000,
      factMaximumAgeMs: 60_000,
      policy: {
        version: 2,
        capabilityRoles: {
          requirements: "requirements-analyst",
          development: "developer",
          testing: "tester",
        },
        githubReviewRoles: [],
        codeActionRoles: [],
        codeOperationsByRole: {},
        workspaceByRepository: {},
      },
    },
    memory: {
      enabled: true,
      maximumRecords: 2_000,
      maximumStateBytes: 16 * 1024 * 1024,
    },
    brainProviders: {
      "fixture-local": {
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434",
      },
    },
    employees: {
      prReviewer: { enabled: false },
      roles: {
        orchestrator: role(
          "Command orchestrator",
          "command-orchestrator",
          ["orchestrate", "complete"],
          "employee-orchestrator",
        ),
        "requirements-analyst": role(
          "Requirements analyst",
          "requirements-brain",
          ["submit_delivery"],
        ),
        developer: role(
          "Developer",
          "development-brain",
          ["submit_delivery"],
        ),
        tester: role(
          "Tester",
          "testing-brain",
          ["submit_delivery"],
        ),
      },
    },
  };
}

function issueEvent(occurredAt) {
  return {
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt,
    source: { provider: "github", scopeId: "command-center-local-fixture" },
    subject: {
      id: "github:issue:acme/command-center#901",
      repository: "acme/command-center",
      number: 901,
    },
    payload: {
      number: 901,
      title: "Command center Issue acceptance flow",
      description: "Coordinate requirements, implementation, failure rework, and acceptance.",
      state: "OPEN",
      labels: ["command-center", "acceptance"],
    },
  };
}

test("one routed Issue crosses the composed shared graph, rework loop, and local memory archive", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "command-center-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse("2026-08-08T01:00:00.000Z");
  const clock = () => new Date(now);
  let nextLease = 1;
  const state = {
    brainCalls: [],
    developmentContexts: [],
    testingContexts: [],
    testingControl: "not-paused",
  };
  const verifiedEvidence = [];
  const authoritativeEvidence = new Map([
    [CHANGE_PACKAGE_EVIDENCE.referenceId, CHANGE_PACKAGE_EVIDENCE],
    [FAILED_TEST_EVIDENCE.referenceId, FAILED_TEST_EVIDENCE],
    [PASSED_TEST_EVIDENCE.referenceId, PASSED_TEST_EVIDENCE],
  ]);
  const application = await createApplication({
    config: config(),
    versionedConfiguration: false,
    externalActions: false,
    store: new StateStore(path.join(root, "state")),
    operationsRuntimeFactory: () => Object.freeze({}),
    workflowRoutingDependencies: { createGuard: guardFactory, clock },
    workLedgerDependencies: {
      createGuard: guardFactory,
      clock,
      idFactory: () => `command-center-lease-${nextLease++}`,
    },
    attentionInboxDependencies: { createGuard: guardFactory, clock },
    workProposalDependencies: { createGuard: guardFactory, clock },
    codeJobRuntimeDependencies: {
      dataDirectory: path.join(root, "code-jobs"),
      createGuard: guardFactory,
      clock,
    },
    memoryRuntimeDependencies: { createGuard: guardFactory },
    prEngineerExclusiveGuardFactory: guardFactory,
    workCoordinationDependencies: {
      clock,
      brainDependencies: { fetch: createBrainFetch(state) },
      evidenceVerifier: {
        async verify(input) {
          const { signal, ...visible } = input;
          assert.equal(signal instanceof AbortSignal, true);
          verifiedEvidence.push(structuredClone(visible));
          const expected = authoritativeEvidence.get(input.evidence.referenceId);
          return expected && input.evidence.kind === expected.kind &&
              input.evidence.contentDigest === expected.contentDigest
            ? structuredClone(input.evidence)
            : false;
        },
      },
    },
  });
  t.after(() => application.close());

  const event = issueEvent(clock().toISOString());
  const routed = await application.workflowRouting.ingest({ event });
  assert.equal(routed.assignments.length, 1);
  assert.deepEqual(routed.assignments[0].target, {
    type: "role",
    id: "orchestrator",
  });

  const runRole = async (roleId) => {
    const result = await application.workCoordination.runCycle({
      trigger: `u12:${roleId}`,
      includeWork: true,
      roleId,
    });
    now += 60_000;
    return result;
  };
  for (const roleId of [
    "orchestrator",
    "requirements-analyst",
    "orchestrator",
    "orchestrator",
    "developer",
    "orchestrator",
    "orchestrator",
    "orchestrator",
    "orchestrator",
    "tester",
    "orchestrator",
    "tester",
    "orchestrator",
    "orchestrator",
  ]) {
    await runRole(roleId);
  }

  const snapshot = await application.workGraphView.getSnapshot();
  assert.equal(snapshot.graph.tasks.length, 4);
  assert.deepEqual(
    snapshot.graph.tasks.map(({ status }) => status),
    ["completed", "completed", "completed", "completed"],
  );
  const stateByTitle = new Map(
    snapshot.taskStates.map((entry) => [entry.work.title, entry]),
  );
  const taskByTitle = (title) => snapshot.graph.tasks.find(
    ({ taskId }) => taskId === stateByTitle.get(title).taskId,
  );
  const requirements = taskByTitle("Requirements");
  const development = taskByTitle("Development");
  const testing = taskByTitle("Testing");
  assert.deepEqual(development.dependsOn, [requirements.taskId]);
  assert.deepEqual(testing.dependsOn, [development.taskId]);
  assert.deepEqual(
    testing.deliveries.map(({ status }) => status),
    ["submitted", "rejected", "submitted", "accepted"],
  );
  assert.deepEqual(
    testing.deliveries
      .filter(({ status }) => status === "submitted")
      .map(({ evidence }) => evidence.find(({ kind }) => kind === "test-report").referenceId),
    [FAILED_TEST_EVIDENCE.referenceId, PASSED_TEST_EVIDENCE.referenceId],
  );
  assert.equal(state.testingControl, "resumed");
  const timeline = await application.workLedgerView.listTimeline({
    limit: 100,
  });
  assert.deepEqual(
    timeline.items
      .filter(
        ({ itemId, type }) => itemId === testing.taskId && type === "transitioned",
      )
      .map(({ details }) => details.toStatus)
      .filter((status) => ["paused", "queued"].includes(status)),
    ["paused", "queued"],
  );

  assert.equal(state.developmentContexts.length, 1);
  assert.equal(state.testingContexts.length, 2);
  assert.equal(
    state.developmentContexts[0].requirements.acceptedDependencies[0].taskId,
    requirements.taskId,
  );
  for (const context of state.testingContexts) {
    assert.equal(
      context.code.acceptedDependencies[0].taskId,
      development.taskId,
    );
  }
  assert.equal(
    verifiedEvidence.some(
      ({ evidence }) => evidence.referenceId === FAILED_TEST_EVIDENCE.referenceId,
    ),
    true,
  );
  assert.equal(
    state.brainCalls.every(({ url }) => url === "http://127.0.0.1:11434/api/chat"),
    true,
  );

  await application.memoryProjector.runCycle();
  const memory = await application.memorySearch.search({
    q: "Command center Issue acceptance flow",
    limit: 50,
  });
  assert.ok(memory.items.length > 0);
  assert.equal(
    memory.items.some(({ source }) => source.kind === "work-item"),
    true,
  );
  assert.equal(
    memory.items.some(({ event }) => event === "work.completed"),
    true,
  );
  const deliveryMemory = await application.memorySearch.search({
    q: "Testing",
    eventType: "work.delivery_accepted",
    limit: 20,
  });
  assert.equal(
    deliveryMemory.items.some(
      ({ source }) => source.kind === "work-delivery",
    ),
    true,
  );

  const assignments = await application.workflowRouting.listAssignments({
    limit: 20,
  });
  assert.equal(assignments.items.length, 1);
  assert.equal(assignments.items[0].eventId, routed.event.eventId);
  const ledger = await application.workLedgerView.listItems({ limit: 20 });
  assert.equal(ledger.items.length, 4);
  assert.equal(ledger.items.every(({ status }) => status === "completed"), true);
});
