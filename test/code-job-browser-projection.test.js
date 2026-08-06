import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
  createQueuedCodeJob,
} from "../src/domain/code-job-contract.js";
import {
  normalizeCodeJobBrowserProjection,
  projectNormalizedCodeJobForBrowser,
} from "../src/domain/code-job-browser-projection.js";

const HEAD_REF_OID = "1".repeat(40);

function inputBinding() {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/widgets",
    pullRequestNumber: 17,
    rootItemId: "github:acme/widgets:pull-request:17",
    workKey: "github:acme/widgets:pull-request:17",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: HEAD_REF_OID,
    eventId: "event-1",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
  };
}

function grant({ bound }) {
  const content = {
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:acme/widgets:pull-request:17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation: "inspect",
    objective: "Inspect the retry race",
    acceptanceCriteria: ["Explain the failure"],
    evidence: ["A trusted workflow event requested diagnosis"],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  };
  return createCodeJobGrant(
    bound
      ? { schemaVersion: 2, ...content, inputBinding: inputBinding() }
      : content,
  );
}

function queuedJob({ bound }) {
  return createQueuedCodeJob(
    {
      confirmationId: "confirmation-code-job-approval-1",
      requestId: "approval-request-0001",
      displayedPayloadDigest: "d".repeat(64),
      approvalBindingDigest: "e".repeat(64),
      grant: grant({ bound }),
    },
    {
      sequence: 1,
      revision: 1,
      createdAt: "2026-08-02T06:00:00.000Z",
    },
  );
}

test("v2 browser projection preserves the exact pull request input binding", () => {
  const projection = projectNormalizedCodeJobForBrowser(
    queuedJob({ bound: true }),
  );

  assert.equal(projection.repository, "acme/widgets");
  assert.equal(projection.subject.number, 17);
  assert.deepEqual(projection.inputBinding, inputBinding());
  assert.equal(projection.inputBinding.headRefOid, HEAD_REF_OID);
  assert.deepEqual(normalizeCodeJobBrowserProjection(projection), projection);
});

test("v2 browser projection rejects repository and pull request mismatches", () => {
  const projection = projectNormalizedCodeJobForBrowser(
    queuedJob({ bound: true }),
  );
  const wrongRepository = structuredClone(projection);
  wrongRepository.inputBinding.repository = "acme/other";
  const wrongPullRequest = structuredClone(projection);
  wrongPullRequest.inputBinding.pullRequestNumber = 18;

  for (const candidate of [wrongRepository, wrongPullRequest]) {
    assert.throws(
      () => normalizeCodeJobBrowserProjection(candidate),
      TypeError,
    );
  }
});

test("legacy browser projections remain readable without an input binding", () => {
  const projection = projectNormalizedCodeJobForBrowser(
    queuedJob({ bound: false }),
  );

  assert.equal(Object.hasOwn(projection, "inputBinding"), false);
  assert.deepEqual(normalizeCodeJobBrowserProjection(projection), projection);
});
