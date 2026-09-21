import assert from "node:assert/strict";
import test from "node:test";
import {
  createConfigurationActivationConfirmationPlan,
  isGitHubCredentialRecoveryActivationPlan,
  normalizeConfigurationActivationEnvelope,
} from "../src/domain/configuration-activation-confirmation.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { configurationImpactDigest } from "../src/services/configuration-state.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

function impact() {
  return {
    changed: true,
    beforeDigest: A,
    afterDigest: B,
    security_tightening: ["employees.roles.developer.enabled"],
    authority_expansion: ["trackedRepositories"],
    benign_claim_change: ["employees.roles.developer.brain.model"],
    restart_required: ["codeExecutor.enabled"],
  };
}

function prepared(kind) {
  const common = {
    expectedStateRevision: 7,
    expectedActiveVersion: 3,
    activeDigest: A,
    documentDigest: B,
    validationDigest: C,
    impactDigest: D,
    impact: impact(),
  };
  if (kind === "configuration.initialize") {
    return {
      ...common,
      kind,
      expectedActiveVersion: null,
      activeDigest: null,
      baselineDigest: A,
      draftId: "draft-1",
      draftRevision: 2,
      draftRevisionId: `configuration-draft-revision-${E}`,
    };
  }
  if (kind === "configuration.activate") {
    return {
      ...common,
      kind,
      draftId: "draft-2",
      draftRevision: 4,
      draftRevisionId: `configuration-draft-revision-${E}`,
    };
  }
  return {
    ...common,
    kind: "configuration.rollback",
    targetVersion: 1,
    targetDigest: E,
    documentDigest: E,
  };
}

function envelope(plan) {
  const normalized = normalizeConfirmationPlan(plan);
  return {
    schemaVersion: 1,
    id: normalized.id,
    idempotencyKey: `confirmation-${normalized.approvalBindingDigest}`,
    kind: normalized.kind,
    requestedBy: normalized.requestedBy,
    actor: normalized.actor,
    target: normalized.target,
    action: normalized.action,
    displayedPayloadDigest: normalized.displayedPayloadDigest,
    approvalBindingDigest: normalized.approvalBindingDigest,
    execution: {
      requestId: "configuration-request-1",
      attempt: 1,
      startedAt: "2026-08-05T01:02:03.000Z",
    },
  };
}

test("all configuration changes become one digest-only owner confirmation kind", () => {
  const expectedTypes = new Map([
    ["configuration.initialize", "initialize_from_draft"],
    ["configuration.activate", "activate_draft"],
    ["configuration.rollback", "activate_rollback"],
  ]);
  for (const [kind, actionType] of expectedTypes) {
    const plan = createConfigurationActivationConfirmationPlan(prepared(kind));
    assert.equal(plan.kind, "local.configuration-activate");
    assert.equal(plan.requestedBy.roleId, "configuration-owner");
    assert.equal(plan.actor.accountId, "owner:local");
    assert.equal(plan.action.type, actionType);
    assert.match(plan.id, /^confirmation-configuration-[a-f0-9]{64}$/);
    assert.deepEqual(
      normalizeConfigurationActivationEnvelope(envelope(plan)).action,
      plan.action,
    );
    const serialized = JSON.stringify(plan);
    for (const forbidden of [
      '"configuration"',
      '"employees"',
      '"brainProviders"',
      '"writablePaths"',
      '"activatedBy"',
      '"executor"',
      '"token"',
      '"secret"',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  }
});

test("the modal shows bounded impact names without configuration values", () => {
  const input = prepared("configuration.activate");
  input.impact.authority_expansion = Array.from(
    { length: 20 },
    (_, index) => `trackedRepositories.${index}`,
  );
  const plan = createConfigurationActivationConfirmationPlan(input);
  assert.equal(plan.display.payload.impact.changed, true);
  assert.equal(plan.display.payload.impact.authorityExpansion.count, 20);
  assert.equal(plan.display.payload.impact.authorityExpansion.paths.length, 12);
  assert.deepEqual(plan.display.payload.impact.restartRequired.paths, [
    "codeExecutor.enabled",
  ]);
  assert.equal(plan.display.evidence.some((entry) => entry.includes(B)), true);
  assert.equal(Object.isFrozen(plan), true);
});

test("the confirmation summary counts unique changed paths across overlapping classifications", () => {
  const input = prepared("configuration.activate");
  input.impact.authority_expansion = [
    "employees.roles.developer.brain.remoteData.code",
  ];
  input.impact.restart_required = [
    "employees.roles.developer.brain.remoteData.code",
    "employees.roles.developer.brain.model",
  ];
  input.impact.benign_claim_change = [
    "employees.roles.developer.brain.model",
  ];

  const plan = createConfigurationActivationConfirmationPlan(input);

  assert.equal(plan.display.summary, "该配置影响 3 个已识别路径。");
});

test("prepared bindings and private envelopes reject accessors and tampering", () => {
  const hostile = prepared("configuration.initialize");
  let reads = 0;
  Object.defineProperty(hostile, "documentDigest", {
    enumerable: true,
    get() {
      reads += 1;
      return B;
    },
  });
  assert.throws(
    () => createConfigurationActivationConfirmationPlan(hostile),
    /configuration activation/i,
  );
  assert.equal(reads, 0);

  const plan = createConfigurationActivationConfirmationPlan(
    prepared("configuration.rollback"),
  );
  const forged = envelope(plan);
  forged.actor.accountId = "employee:developer";
  assert.throws(
    () => normalizeConfigurationActivationEnvelope(forged),
    /configuration activation/i,
  );
});

test("credential recovery activation requires one complete digest-bound impact", () => {
  const input = prepared("configuration.activate");
  input.impact = {
    changed: true,
    beforeDigest: input.activeDigest,
    afterDigest: input.documentDigest,
    security_tightening: ["githubActions.credentialMode"],
    authority_expansion: ["githubActions.credentialMode"],
    benign_claim_change: [],
    restart_required: [
      "githubActions.credentialMode",
      "githubActions.tokenEnv",
    ],
  };
  input.impactDigest = configurationImpactDigest(input.impact);
  const plan = createConfigurationActivationConfirmationPlan(input);

  assert.equal(isGitHubCredentialRecoveryActivationPlan(plan), true);

  const wrongDigest = structuredClone(plan);
  wrongDigest.action.impactDigest = C;
  assert.equal(isGitHubCredentialRecoveryActivationPlan(wrongDigest), false);

  const incomplete = structuredClone(plan);
  incomplete.display.payload.impact.restartRequired.count = 3;
  assert.equal(isGitHubCredentialRecoveryActivationPlan(incomplete), false);

  const expanded = structuredClone(plan);
  expanded.display.payload.impact.restartRequired.paths.push(
    "githubActions.actorAccountId",
  );
  expanded.display.payload.impact.restartRequired.count = 3;
  assert.equal(isGitHubCredentialRecoveryActivationPlan(expanded), false);

  const rollback = structuredClone(plan);
  rollback.action.type = "activate_rollback";
  assert.equal(isGitHubCredentialRecoveryActivationPlan(rollback), false);

  const hostile = structuredClone(plan);
  let reads = 0;
  Object.defineProperty(hostile, "action", {
    enumerable: true,
    get() {
      reads += 1;
      return plan.action;
    },
  });
  assert.equal(isGitHubCredentialRecoveryActivationPlan(hostile), false);
  assert.equal(reads, 0);
  assert.equal(
    isGitHubCredentialRecoveryActivationPlan(new Proxy(plan, {})),
    false,
  );
});
