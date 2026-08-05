import assert from "node:assert/strict";
import test from "node:test";

import {
  createProposalDeliveryEvidenceTarget,
  deliveryEvidenceKindsForProposal,
} from "../src/domain/delivery-evidence-contract.js";

function expected(deliverableId, kind) {
  return {
    deliverableId,
    kind,
    description: `${deliverableId} delivery`,
    required: true,
  };
}

function contract(expectedDeliverables = [
  expected("implementation", "change-package"),
  expected("verification", "test-report"),
  expected("review", "review-report"),
]) {
  return {
    revision: 3,
    acceptanceCriteria: [
      { criterionId: "done", description: "Authoritative evidence exists" },
    ],
    expectedDeliverables,
  };
}

function target(proposal, overrides = {}) {
  return createProposalDeliveryEvidenceTarget({
    taskId: "task-42",
    roleId: "developer",
    acceptanceContract: contract(),
    proposal,
    ...overrides,
  });
}

test("proposal actions expose one canonical evidence-kind policy", () => {
  assert.deepEqual(
    deliveryEvidenceKindsForProposal({
      kind: "code_action_proposal",
      operation: "modify",
    }),
    ["change-package"],
  );
  assert.deepEqual(
    deliveryEvidenceKindsForProposal({
      kind: "code_action_proposal",
      operation: "verify",
    }),
    ["test-report"],
  );
  assert.deepEqual(
    deliveryEvidenceKindsForProposal({
      kind: "github_review_proposal",
    }),
    ["github-review", "review-report"],
  );
  assert.deepEqual(
    deliveryEvidenceKindsForProposal({
      kind: "code_action_proposal",
      operation: "inspect",
    }),
    [],
  );
});

test("proposal targets auto-select the sole compatible deliverable", () => {
  assert.deepEqual(
    target({ kind: "code_action_proposal", operation: "modify" }).deliverables,
    [{ deliverableId: "implementation", kind: "change-package" }],
  );
  assert.deepEqual(
    target({ kind: "code_action_proposal", operation: "verify" }).deliverables,
    [{ deliverableId: "verification", kind: "test-report" }],
  );
  assert.deepEqual(
    target({ kind: "github_review_proposal" }).deliverables,
    [{ deliverableId: "review", kind: "review-report" }],
  );
});

test("explicit incompatible selectors and inspect authority fail closed", () => {
  const cases = [
    [
      { kind: "code_action_proposal", operation: "modify" },
      "verification",
    ],
    [
      { kind: "code_action_proposal", operation: "verify" },
      "implementation",
    ],
    [{ kind: "github_review_proposal" }, "implementation"],
    [
      { kind: "code_action_proposal", operation: "inspect" },
      "implementation",
    ],
  ];
  for (const [proposal, deliverableId] of cases) {
    assert.throws(
      () => target(proposal, { deliverableId }),
      /incompatible with the proposal action/,
    );
  }
  assert.throws(
    () => target({ kind: "code_action_proposal", operation: "inspect" }),
    /cannot produce an expected deliverable/,
  );
});

test("multiple compatible deliverables require an explicit selector", () => {
  const acceptanceContract = contract([
    expected("implementation-primary", "change-package"),
    expected("implementation-secondary", "change-package"),
    expected("verification", "test-report"),
  ]);
  const proposal = { kind: "code_action_proposal", operation: "modify" };
  assert.throws(
    () => target(proposal, { acceptanceContract }),
    /required for multiple compatible deliverables/,
  );
  assert.deepEqual(
    target(proposal, {
      acceptanceContract,
      deliverableId: "implementation-secondary",
    }).deliverables,
    [{
      deliverableId: "implementation-secondary",
      kind: "change-package",
    }],
  );
});
