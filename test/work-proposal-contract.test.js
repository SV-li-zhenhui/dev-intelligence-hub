import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  assertWorkProposalAuthorityBinding,
  normalizeBoundWorkProposal,
  normalizeWorkProposalAdvanceRequest,
} from "../src/domain/work-proposal-contract.js";

function boundProposal(overrides = {}) {
  return {
    proposalId: "work-intent-proposal-1",
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    binding: {
      repository: "acme/widgets",
      pullRequestNumber: 42,
      headRefOid: "a".repeat(40),
    },
    payload: {
      verdict: "comment",
      body: "Please cover the retry branch.",
    },
    ...overrides,
  };
}

async function observePrimitiveErrorAllocation() {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const NativeError = globalThis.Error;
    let allocations = 0;
    globalThis.Error = class CountingError extends NativeError {
      constructor(...args) {
        super(...args);
        allocations += 1;
      }
    };

    void import(workerData).then((contract) => {
      allocations = 0;
      contract.workProposalDataEntries({ value: 1 });
      contract.workProposalArrayValues([1], 1);
      contract.boundedWorkProposalText("valid", "value");
      contract.safeWorkProposalInteger(1, "value");
      const validAllocations = allocations;
      let failure = null;
      try {
        contract.boundedWorkProposalText("", "value");
      } catch (error) {
        failure = { code: error.code, name: error.name };
      }
      parentPort.postMessage({
        validAllocations,
        invalidAllocations: allocations - validAllocations,
        failure,
      });
    }, (error) => {
      parentPort.postMessage({ importError: error.message });
    });
  `, {
    eval: true,
    workerData: new URL(
      "../src/domain/work-proposal-contract.js",
      import.meta.url,
    ).href,
  });
  const exit = once(worker, "exit");
  const [observation] = await once(worker, "message");
  const [exitCode] = await exit;
  assert.equal(exitCode, 0);
  assert.equal(observation.importError, undefined);
  return observation;
}

test("proposal authority binding has one task, role, and dispatch validator", () => {
  const proposal = normalizeBoundWorkProposal(boundProposal());
  const evidenceTarget = {
    schemaVersion: 1,
    taskId: proposal.requestedBy.workItemId,
    roleId: proposal.requestedBy.roleId,
    contractRevision: 2,
    contractDigest: "c".repeat(64),
    deliverables: [{ deliverableId: "review", kind: "review-report" }],
  };
  assert.doesNotThrow(() =>
    assertWorkProposalAuthorityBinding(proposal, {
      evidenceTarget,
      dispatchIntentId: `work-dispatch-intent-${"d".repeat(64)}`,
    }),
  );

  for (const binding of [
    { evidenceTarget: { ...evidenceTarget, roleId: "developer" } },
    { dispatchIntentId: "work-dispatch-intent-invalid" },
  ]) {
    assert.throws(
      () => assertWorkProposalAuthorityBinding(proposal, binding),
      (error) => error.code === "INVALID_WORK_PROPOSAL",
    );
  }
});

test("bound proposals are canonical pure data with a stable content digest", () => {
  const first = normalizeBoundWorkProposal(boundProposal());
  const reordered = normalizeBoundWorkProposal({
    ...boundProposal(),
    binding: {
      headRefOid: "a".repeat(40),
      pullRequestNumber: 42,
      repository: "acme/widgets",
    },
  });

  assert.match(first.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.contentDigest, reordered.contentDigest);
  assert.deepEqual(first.binding, reordered.binding);

  const unicodeKeys = normalizeBoundWorkProposal(
    boundProposal({ payload: { "é": 1, "e\u0301": 2 } }),
  );
  const reversedUnicodeKeys = normalizeBoundWorkProposal(
    boundProposal({ payload: { "e\u0301": 2, "é": 1 } }),
  );
  assert.equal(unicodeKeys.contentDigest, reversedUnicodeKeys.contentDigest);
  assert.deepEqual(unicodeKeys.payload, reversedUnicodeKeys.payload);

  assert.throws(
    () => normalizeBoundWorkProposal({ ...boundProposal(), extra: true }),
    (error) => error.code === "INVALID_WORK_PROPOSAL",
  );

  const accessor = boundProposal();
  Object.defineProperty(accessor, "payload", {
    enumerable: true,
    get() {
      return {};
    },
  });
  assert.throws(
    () => normalizeBoundWorkProposal(accessor),
    (error) => error.code === "INVALID_WORK_PROPOSAL",
  );

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => normalizeBoundWorkProposal(boundProposal({ payload: cyclic })),
    (error) => error.code === "INVALID_WORK_PROPOSAL",
  );

  assert.throws(
    () =>
      normalizeBoundWorkProposal(
        boundProposal({ payload: { body: "x".repeat(33 * 1024) } }),
      ),
    (error) => error.code === "INVALID_WORK_PROPOSAL",
  );
});

test("valid proposal primitives allocate their default error only on failure", async () => {
  const observation = await observePrimitiveErrorAllocation();

  assert.deepEqual(observation, {
    validAllocations: 0,
    invalidAllocations: 1,
    failure: {
      code: "INVALID_WORK_PROPOSAL",
      name: "WorkProposalError",
    },
  });
});

test("runner transitions expose only bounded lifecycle variants", () => {
  const common = {
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    expectedRevision: 2,
    runnerId: "github-runner",
    leaseId: "work-proposal-lease-1",
  };
  const unknown = normalizeWorkProposalAdvanceRequest({
    ...common,
    transition: {
      status: "unknown",
      summary: "The downstream outcome cannot be proven.",
      evidence: ["reconciliation returned no authoritative receipt"],
    },
  });
  assert.equal(unknown.transition.status, "unknown");

  assert.throws(
    () =>
      normalizeWorkProposalAdvanceRequest({
        ...common,
        transition: { status: "pending_delivery" },
      }),
    (error) => error.code === "INVALID_WORK_PROPOSAL_RUNNER_REQUEST",
  );
  assert.throws(
    () =>
      normalizeWorkProposalAdvanceRequest({
        ...common,
        transition: {
          status: "running",
          downstreamRef: "session-1",
          nextAttemptAt: "2026-08-02T03:00:00.000Z",
          arbitraryCommand: "rm -rf",
        },
      }),
    (error) => error.code === "INVALID_WORK_PROPOSAL_RUNNER_REQUEST",
  );
  assert.throws(
    () =>
      normalizeWorkProposalAdvanceRequest({
        ...common,
        transition: {
          status: "running",
          downstreamRef: "session-1",
          nextAttemptAt: new Date(Number.NaN),
        },
      }),
    (error) => error.code === "INVALID_WORK_PROPOSAL_RUNNER_REQUEST",
  );
});
