import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApplication } from "../src/composition-root.js";
import { StateStore } from "../src/lib/state-store.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const committedConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);

class TestGuard {
  async acquire() {}
  run(operation) { return operation(); }
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

function applicationConfiguration() {
  const config = structuredClone(committedConfiguration);
  config.workflowRouting.enabled = true;
  config.workflowRouting.rules = [
    {
      id: "configuration-issue-to-developer",
      source: "root",
      enabled: true,
      priority: 100,
      fallback: false,
      condition: {
        op: "oneOf",
        path: "eventType",
        values: ["issue.created"],
      },
      targets: [{ type: "role", id: "developer" }],
      onMatch: "stop",
    },
  ];
  config.workCoordination.enabled = true;
  config.workCoordination.policy.configurationChangeRoles = ["developer"];
  config.employees.roles.developer.initialPaused = false;
  config.employees.roles.developer.taskBrain = structuredClone(
    config.employees.roles.developer.brain,
  );
  config.employees.roles.developer.permissions.allowedIntents.push(
    "propose_configuration_change",
  );
  return config;
}

function issueEvent(occurredAt) {
  return {
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt,
    source: { provider: "github", scopeId: "configuration-local-fixture" },
    subject: {
      id: "github:issue:acme/configuration#17",
      repository: "acme/configuration",
      number: 17,
    },
    payload: {
      number: 17,
      title: "Increase developer inspection cadence",
    },
  };
}

function brainFetch(calls) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const context = JSON.parse(body.messages[1].content);
    calls.push(structuredClone(context));
    const prior = context.requirements?.decisionContext;
    const intent = prior?.source === "proposal"
      ? {
          schemaVersion: 1,
          type: "complete",
          summary: "配置提案结果已经收敛",
          reason: "owner 已处理版本化配置确认",
          outcome: "done",
          evidence: [prior.referenceId],
        }
      : {
          schemaVersion: 1,
          type: "propose_configuration_change",
          summary: "提高开发岗位巡检频率",
          reason: "当前 Issue 要求更快发现任务积压",
          changes: [
            {
              path: [
                "employees",
                "roles",
                "developer",
                "scheduleMinutes",
              ],
              value: 15,
            },
          ],
          evidence: ["issue:17"],
        };
    return textResponse({
      message: {
        content: JSON.stringify({
          schemaVersion: 1,
          confidence: 96,
          summary: intent.summary,
          intent,
        }),
      },
    });
  };
}

function approvalRequest(item) {
  return {
    requestId: "approve-configuration-proposal-e2e",
    expectedQueueRevision: item.queueRevision,
    expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest,
    approvalBindingDigest: item.approvalBindingDigest,
  };
}

async function createTestApplication({ config, store, root, clock, calls }) {
  return createApplication({
    config,
    versionedConfiguration: true,
    store,
    operationsRuntimeFactory: () => Object.freeze({}),
    configurationRuntimeDependencies: { createGuard: guardFactory, clock },
    confirmationRuntimeDependencies: {
      dataDirectory: path.join(root, "confirmation"),
      createGuard: guardFactory,
      clock,
    },
    workflowRoutingDependencies: { createGuard: guardFactory, clock },
    ownerWorkRequestDependencies: { createGuard: guardFactory, clock },
    workLedgerDependencies: { createGuard: guardFactory, clock },
    attentionInboxDependencies: { createGuard: guardFactory, clock },
    workProposalDependencies: { createGuard: guardFactory, clock },
    prEngineerExclusiveGuardFactory: guardFactory,
    workCoordinationDependencies: {
      clock,
      brainDependencies: { fetch: brainFetch(calls) },
    },
  });
}

test("production application routes an employee configuration proposal through owner activation and restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "configuration-proposal-app-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = applicationConfiguration();
  const store = new StateStore(path.join(root, "state"));
  const calls = [];
  let now = Date.parse("2026-08-08T01:00:00.000Z");
  const clock = () => new Date(now);
  let application = await createTestApplication({
    config,
    store,
    root,
    clock,
    calls,
  });
  t.after(async () => application?.close());

  const routed = await application.workflowRouting.ingest({
    event: issueEvent(clock().toISOString()),
  });
  assert.deepEqual(routed.assignments.map(({ target }) => target), [
    { type: "role", id: "developer" },
  ]);

  const first = await application.workCoordination.runCycle({
    trigger: "u12:configuration-proposal",
    includeWork: true,
    roleId: "developer",
  });
  assert.equal(first.stages.work.result.staged, 1, JSON.stringify({ first, calls }));
  assert.equal(first.stages.dispatch.result.delivered, 1);
  const initiallyStaged = (await application.workLedgerView.listItems()).items[0];
  assert.equal(
    initiallyStaged.status,
    "waiting_external",
    JSON.stringify({ first, calls }),
  );
  now += 60_000;
  const proposalCycle = await application.workCoordination.runCycle({
    trigger: "u12:configuration-proposal-runner",
  });

  const queued = await application.confirmationQueue.next();
  assert.equal(queued.pendingCount, 1, JSON.stringify(proposalCycle));
  assert.equal(queued.item.kind, "local.configuration-activate");
  assert.equal(
    queued.item.display.payload.action.type,
    "activate_draft",
  );
  assert.equal(queued.item.requestedBy.roleId, "configuration-owner");
  const before = await application.configuration.reader.readActive();
  assert.equal(
    before.configuration.employees.roles.developer.scheduleMinutes,
    3,
  );
  const draftSnapshot = await application.configuration.reader.readSnapshot();
  assert.equal(draftSnapshot.draftRevisions.length, 1);
  assert.equal(
    draftSnapshot.draftRevisions[0].configuration.employees.roles.developer
      .scheduleMinutes,
    15,
  );

  const activated = await application.confirmationQueue.approve(
    queued.item.id,
    approvalRequest(queued.item),
  );
  assert.equal(activated.status, "completed");
  const after = await application.configuration.reader.readActive();
  assert.equal(after.version, before.version + 1);
  assert.equal(
    after.configuration.employees.roles.developer.scheduleMinutes,
    15,
  );

  await application.close();
  application = await createTestApplication({
    config,
    store,
    root,
    clock,
    calls,
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    now += 60_000;
    await application.workCoordination.runCycle({
      trigger: `u12:configuration-recovery-${cycle}`,
    });
  }
  let item = (await application.workLedgerView.listItems()).items[0];
  assert.equal(item.status, "completed");
  assert.equal(
    (await application.configuration.reader.readSnapshot()).draftRevisions.length,
    1,
  );
  const history = await application.confirmationQueue.historyReader.list({
    limit: 20,
  });
  assert.equal(
    history.items.filter(({ kind }) => kind === "local.configuration-activate")
      .length,
    1,
  );
  assert.equal(calls.length, 1);
});
