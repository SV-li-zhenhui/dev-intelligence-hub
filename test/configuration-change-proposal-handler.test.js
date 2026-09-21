import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { ConfigurationChangeProposalHandler } from "../src/services/configuration-change-proposal-handler.js";
import { ConfigurationConfirmationRequester } from "../src/services/configuration-confirmation-requester.js";
import { ConfigurationStore } from "../src/services/configuration-store.js";
import { createWorkIntentPolicy } from "../src/services/work-intent-policy.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const baseConfiguration = JSON.parse(
  await readFile(path.join(projectRoot, "config.example.json"), "utf8"),
);

class MemoryStore {
  constructor(value = null) {
    this.value = structuredClone(value);
  }

  async read(_name, fallback = null) {
    return structuredClone(this.value ?? fallback);
  }

  async write(_name, value) {
    this.value = structuredClone(value);
  }
}

class ExclusiveLease {
  #queue = new OperationQueue();

  run(operation) {
    return this.#queue.enqueue(operation);
  }
}

class ConfirmationProducer {
  constructor() {
    this.items = new Map();
    this.enqueueCalls = 0;
    this.revision = 0;
  }

  async enqueue(value) {
    const plan = normalizeConfirmationPlan(value);
    const existing = this.items.get(plan.id);
    if (existing) {
      if (existing.approvalBindingDigest !== plan.approvalBindingDigest) {
        throw new Error("confirmation conflict");
      }
      return structuredClone(existing);
    }
    this.enqueueCalls += 1;
    this.revision += 1;
    const item = {
      id: plan.id,
      kind: plan.kind,
      status: "pending",
      queueRevision: this.revision,
      itemRevision: 1,
      requestedBy: plan.requestedBy,
      actor: plan.actor,
      target: plan.target,
      display: plan.display,
      displayedPayloadDigest: plan.displayedPayloadDigest,
      approvalBindingDigest: plan.approvalBindingDigest,
      retryable: false,
    };
    this.items.set(plan.id, item);
    return structuredClone(item);
  }

  async get(id) {
    const item = this.items.get(id);
    if (!item) {
      throw Object.assign(new Error("confirmation not found"), {
        code: "CONFIRMATION_NOT_FOUND",
      });
    }
    return structuredClone(item);
  }

  async invalidate(id, request) {
    const item = await this.get(id);
    this.revision += 1;
    const stale = {
      ...item,
      status: "stale",
      queueRevision: this.revision,
      itemRevision: item.itemRevision + 1,
      invalidation: {
        reason: request.reason,
        at: "2026-08-08T01:00:00.000Z",
      },
    };
    this.items.set(id, stale);
    return structuredClone(stale);
  }

  setStatus(id, status) {
    const item = this.items.get(id);
    this.revision += 1;
    this.items.set(id, {
      ...item,
      status,
      queueRevision: this.revision,
      itemRevision: item.itemRevision + 1,
      ...(status === "rejected"
        ? { rejection: { reason: "owner_rejected", at: "2026-08-08T01:00:00.000Z" } }
        : {}),
    });
  }
}

function clock() {
  return () => new Date("2026-08-08T00:00:00.000Z");
}

async function readyConfiguration(store = new MemoryStore()) {
  const configurations = new ConfigurationStore({
    store,
    exclusiveLease: new ExclusiveLease(),
    operationQueue: new OperationQueue(),
    clock: clock(),
  });
  await configurations.recover();
  if ((await configurations.readAuthoritySnapshot()).activeVersion === null) {
    await configurations.importBootstrap({
      configuration: baseConfiguration,
      importedBy: "test-bootstrap",
    });
  }
  return { configurations, store };
}

function event() {
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.created",
    occurredAt: "2026-08-08T00:00:00.000Z",
    source: { provider: "github", scopeId: "acme/repo" },
    subject: {
      id: "github:issue:acme/repo#17",
      repository: "acme/repo",
      number: 17,
    },
    payload: { number: 17, title: "Tune the worker schedule" },
  });
}

function proposal(changes = [
  {
    path: ["employees", "roles", "developer", "scheduleMinutes"],
    value: 15,
  },
]) {
  const trustedEvent = event();
  const bound = createWorkIntentPolicy({
    version: 1,
    configurationChangeRoles: ["developer"],
  }).bind({
    context: {
      assignmentId: "workflow-assignment-configuration",
      workItemId: "work-item-configuration",
      roleId: "developer",
      event: trustedEvent,
    },
    intent: {
      schemaVersion: 1,
      type: "propose_configuration_change",
      summary: "调整开发岗位巡检频率",
      reason: "当前任务积压需要更及时的巡检",
      dispatchIntentId: `work-dispatch-intent-${"f".repeat(64)}`,
      changes,
      evidence: ["queue-depth:12"],
    },
  });
  return normalizeBoundWorkProposal({
    proposalId: bound.intentId,
    policyVersion: bound.policyVersion,
    kind: bound.kind,
    requestedBy: bound.requestedBy,
    source: bound.source,
    binding: bound.binding,
    payload: bound.payload,
  });
}

function handler(configurations, confirmations) {
  const requester = new ConfigurationConfirmationRequester({
    simulator: configurations,
    confirmationProducer: confirmations,
  });
  return new ConfigurationChangeProposalHandler({
    configurationReader: configurations,
    configurationProposalPort: configurations,
    confirmationRequester: requester,
    clock: clock(),
    pollIntervalMs: 1_000,
  });
}

function input(bound, downstreamRef = null) {
  return {
    proposal: bound,
    status: downstreamRef === null ? "pending_delivery" : "waiting_confirmation",
    attempt: 1,
    downstreamRef,
  };
}

test("employee proposal creates one draft and one owner confirmation without activating", async () => {
  const { configurations } = await readyConfiguration();
  const confirmations = new ConfirmationProducer();
  const service = handler(configurations, confirmations);
  const bound = proposal();
  const before = await configurations.readActive();

  const waiting = await service.handle(input(bound));
  const active = await configurations.readActive();
  const draft = await configurations.readProposalDraft({
    proposalId: bound.proposalId,
    proposalContentDigest: bound.contentDigest,
  });

  assert.equal(waiting.status, "waiting_confirmation");
  assert.equal(confirmations.enqueueCalls, 1);
  assert.equal(active.version, before.version);
  assert.equal(
    active.configuration.employees.roles.developer.scheduleMinutes,
    before.configuration.employees.roles.developer.scheduleMinutes,
  );
  assert.equal(draft.draft.configuration.employees.roles.developer.scheduleMinutes, 15);
  assert.equal(
    confirmations.items.get(waiting.downstreamRef).requestedBy.roleId,
    "configuration-owner",
  );
  const displayedImpact = confirmations.items.get(waiting.downstreamRef).display
    .payload.impact;
  assert.equal(displayedImpact.changed, true);
  assert.equal(
    displayedImpact.restartRequired.paths.includes(
      "employees.roles.developer.scheduleMinutes",
    ),
    true,
  );
  assert.equal(
    Object.hasOwn(
      confirmations.items.get(waiting.downstreamRef).display.payload,
      "configuration",
    ),
    false,
    "the owner sees bounded impact metadata rather than configuration values",
  );

  const duplicate = await service.handle(input(bound, waiting.downstreamRef));
  assert.equal(duplicate.downstreamRef, waiting.downstreamRef);
  assert.equal(confirmations.enqueueCalls, 1);
});

test("restart and queue acknowledgement recovery never duplicate draft or confirmation", async () => {
  const first = await readyConfiguration();
  const confirmations = new ConfirmationProducer();
  const bound = proposal();
  const waiting = await handler(first.configurations, confirmations).handle(
    input(bound),
  );

  const recovered = await readyConfiguration(first.store);
  const replay = await handler(recovered.configurations, confirmations).handle(
    input(bound),
  );
  const snapshot = await recovered.configurations.readSnapshot();

  assert.equal(replay.downstreamRef, waiting.downstreamRef);
  assert.equal(confirmations.enqueueCalls, 1);
  assert.equal(
    snapshot.draftRevisions.filter(({ proposedBy }) =>
      proposedBy === `work-proposal:${bound.contentDigest}`).length,
    1,
  );
});

test("unknown, array, and type-changing paths fail before draft or confirmation", async () => {
  for (const changes of [
    [{ path: ["unknownField"], value: true }],
    [{ path: ["trackedRepositories", "0"], value: "acme/other" }],
    [{ path: ["refreshMinutes"], value: "15" }],
  ]) {
    const { configurations } = await readyConfiguration();
    const confirmations = new ConfirmationProducer();
    const result = await handler(configurations, confirmations).handle(
      input(proposal(changes)),
    );
    assert.equal(result.status, "failed");
    assert.equal(confirmations.enqueueCalls, 0);
    assert.equal((await configurations.readSnapshot()).draftRevisions.length, 0);
  }
});

test("an authority change between snapshot and Active read retries without creating a draft", async () => {
  const { configurations } = await readyConfiguration();
  const active = await configurations.readActive();
  let draftCreates = 0;
  let confirmationRequests = 0;
  const service = new ConfigurationChangeProposalHandler({
    configurationReader: {
      readAuthoritySnapshot: configurations.readAuthoritySnapshot.bind(
        configurations,
      ),
      async readActive() {
        return { ...active, version: active.version + 1 };
      },
    },
    configurationProposalPort: {
      async readProposalDraft() {
        return null;
      },
      async createProposalDraft() {
        draftCreates += 1;
      },
    },
    confirmationRequester: {
      async requestProposalDraftActivation() {
        confirmationRequests += 1;
      },
    },
  });

  await assert.rejects(
    service.handle(input(proposal())),
    (error) => error?.code === "CONFIGURATION_STATE_REVISION_CONFLICT",
  );
  assert.equal(draftCreates, 0);
  assert.equal(confirmationRequests, 0);
});

test("owner rejection converges the proposal without changing Active", async () => {
  const { configurations } = await readyConfiguration();
  const confirmations = new ConfirmationProducer();
  const service = handler(configurations, confirmations);
  const bound = proposal();
  const before = await configurations.readActive();
  const waiting = await service.handle(input(bound));
  confirmations.setStatus(waiting.downstreamRef, "rejected");

  const result = await service.handle(input(bound, waiting.downstreamRef));
  assert.equal(result.status, "rejected");
  assert.equal(
    (await configurations.readActive()).configuration.employees.roles.developer
      .scheduleMinutes,
    before.configuration.employees.roles.developer.scheduleMinutes,
  );
});

test("configuration proposal handler fails closed when any authority port is missing", async () => {
  const { configurations } = await readyConfiguration();
  const confirmations = new ConfirmationProducer();
  const requester = new ConfigurationConfirmationRequester({
    simulator: configurations,
    confirmationProducer: confirmations,
  });
  for (const options of [
    {
      configurationReader: {},
      configurationProposalPort: configurations,
      confirmationRequester: requester,
    },
    {
      configurationReader: configurations,
      configurationProposalPort: {},
      confirmationRequester: requester,
    },
    {
      configurationReader: configurations,
      configurationProposalPort: configurations,
      confirmationRequester: {},
    },
  ]) {
    assert.throws(() => new ConfigurationChangeProposalHandler(options), TypeError);
  }

  const incompleteRequester = new ConfigurationConfirmationRequester({
    simulator: configurations,
    confirmationProducer: { async enqueue() {} },
  });
  await assert.rejects(
    incompleteRequester.requestProposalDraftActivation({
      proposalId: "work-intent-configuration-change-1",
      proposalContentDigest: "a".repeat(64),
    }),
    TypeError,
  );
});
