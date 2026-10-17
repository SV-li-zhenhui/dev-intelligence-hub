import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { codeJobIdForGrant } from "../domain/code-job-contract.js";
import { samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";

export function approveOwnPrAction(confirmations, item) {
  const digest = createHash("sha256").update(item.id + ":" + item.approvalBindingDigest).digest("hex");
  return confirmations.approve(item.id, {
    requestId: `auto-own-pr-repair-v1-${digest.slice(0, 48)}`,
    expectedQueueRevision: item.queueRevision, expectedItemRevision: item.itemRevision,
    displayedPayloadDigest: item.displayedPayloadDigest, approvalBindingDigest: item.approvalBindingDigest,
  });
}

export function repairCommitMatchesJob({ evidence, receipt, record, grant, sourceKind, requireProfiles = false }) {
  return evidence.evidenceDigest === receipt.evidenceDigest && evidence.commit.oid === receipt.commitOid &&
    evidence.package.job.id === record.jobId && evidence.executionSource.kind === sourceKind &&
    codeJobIdForGrant(grant) === record.jobId && evidence.package.grant.digest === grant.grantDigest &&
    evidence.package.proposal.id === grant.proposalId && evidence.package.proposal.contentDigest === grant.contentDigest &&
    evidence.workspace.id === grant.workspaceId && isDeepStrictEqual(evidence.executionSource, grant.executionSource) &&
    (!requireProfiles || grant.requiredProfiles.length > 0) && evidence.tests.profiles.length === grant.requiredProfiles.length &&
    grant.requiredProfiles.every(required => evidence.tests.profiles.some(profile => profile.id === required.id &&
      profile.configDigest === required.configDigest && profile.workspaceRevision === evidence.workspace.workspaceRevision)) &&
    samePullRequestExecutionBinding(evidence.executionSource.inputBinding, record.inputBinding);
}
