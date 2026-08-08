import assert from "node:assert/strict";
import test from "node:test";

import {
  PullRequestExternalActionTransportError,
  createPullRequestExternalActionExecutor,
} from "../src/services/pull-request-external-action-executor.js";
import {
  externalActionControlledCommit,
  externalActionOid,
  pullRequestExternalActionBinding,
  pullRequestExternalActionEnvelope,
  pullRequestExternalActionPlan,
} from "./support/pull-request-external-action-fixture.js";

const RECEIPT_AT = "2026-08-08T06:08:09.012Z";
const ACTION_TYPES = ["comment", "review", "update_branch", "push", "merge"];

function proposalAction(type, binding) {
  return {
    comment: { type, body: "Post this comment." },
    review: { type, verdict: "approve", body: "Review passed." },
    update_branch: { type },
    push: {
      type,
      controlledCommitEvidence: externalActionControlledCommit(binding),
    },
    merge: { type, method: "squash" },
  }[type];
}

function envelopeFor(type, binding = pullRequestExternalActionBinding()) {
  return pullRequestExternalActionEnvelope(
    pullRequestExternalActionPlan(proposalAction(type, binding), { binding }),
  );
}

function receipt(id, suffix) {
  return {
    id,
    url: `https://github.com/acme/repo/${suffix}`,
    createdAt: RECEIPT_AT,
  };
}

function observationFor(envelope, overrides = {}) {
  const actionType = envelope.action.type;
  const actionEvidence = {
    pull_request_comment: { kind: "marker_records", records: [] },
    pull_request_review: { kind: "marker_records", records: [] },
    pull_request_update_branch: { kind: "head_commit", commit: null },
    pull_request_push: { kind: "head_ref" },
    pull_request_merge: { kind: "merge_state", merge: null },
  }[actionType];
  return {
    schemaVersion: 1,
    actorAccountId: envelope.actor.accountId,
    gitTarget: structuredClone(envelope.action.inputBinding.gitTarget),
    state: "open",
    actionEvidence,
    ...structuredClone(overrides),
  };
}

function completedObservation(envelope, marker) {
  const current = observationFor(envelope);
  if (envelope.action.type === "pull_request_comment") {
    current.actionEvidence.records = [{
      marker,
      actorAccountId: envelope.actor.accountId,
      body: envelope.action.body,
      receipt: receipt("101", "pull/42"),
    }];
    return current;
  }
  if (envelope.action.type === "pull_request_review") {
    current.actionEvidence.records = [{
      marker,
      actorAccountId: envelope.actor.accountId,
      body: envelope.action.body,
      reviewEvent: envelope.action.reviewEvent,
      headOid: envelope.action.inputBinding.gitTarget.headRefOid,
      receipt: receipt("202", "pull/42"),
    }];
    return current;
  }
  if (envelope.action.type === "pull_request_update_branch") {
    const nextHead = externalActionOid("7");
    current.gitTarget.headRefOid = nextHead;
    current.actionEvidence.commit = {
      oid: nextHead,
      parents: [envelope.action.expectedHeadOid, envelope.action.expectedBaseOid],
      receipt: receipt(nextHead, "pull/42"),
    };
    return current;
  }
  if (envelope.action.type === "pull_request_push") {
    current.gitTarget.headRefOid = envelope.action.controlledCommitEvidence.commit.oid;
    return current;
  }
  current.state = "merged";
  current.gitTarget.baseRefOid = externalActionOid("8");
  current.actionEvidence.merge = {
    marker,
    actorAccountId: envelope.actor.accountId,
    expectedHeadOid: envelope.action.expectedHeadOid,
    method: envelope.action.method,
    receipt: receipt(externalActionOid("8"), "pull/42"),
  };
  return current;
}

function mutableTransport(envelope, { loseResponse = false } = {}) {
  let observation = observationFor(envelope);
  const calls = [];
  return {
    calls,
    setObservation(value) {
      observation = structuredClone(value);
    },
    async observe(input) {
      calls.push({ method: "observe", input: structuredClone(input) });
      return structuredClone(observation);
    },
    async perform(input) {
      calls.push({ method: "perform", input: structuredClone(input) });
      observation = completedObservation(envelope, input.marker);
      if (loseResponse) {
        throw new PullRequestExternalActionTransportError(
          "GITHUB_RESPONSE_LOST",
          "unknown",
        );
      }
      return { accepted: true };
    },
  };
}

function acceptingAuthority(binding) {
  return { async verify() { return structuredClone(binding); } };
}

function acceptingCommit(evidence) {
  return {
    async verify({ evidenceId }) {
      assert.equal(evidenceId, evidence.evidenceId);
      return structuredClone(evidence);
    },
  };
}

function executorFor(envelope, transport, overrides = {}) {
  return createPullRequestExternalActionExecutor({
    enabledActions: ACTION_TYPES,
    credentialProvider: () => "runtime-secret",
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
    ...(envelope.action.controlledCommitEvidence
      ? {
          controlledCommitVerifier: acceptingCommit(
            envelope.action.controlledCommitEvidence,
          ),
        }
      : {}),
    ...overrides,
  });
}

test("external actions are disabled by default and missing credentials never reach transport", async () => {
  const envelope = envelopeFor("comment");
  let credentials = 0;
  const transport = {
    observe() { throw new Error("must not observe"); },
    perform() { throw new Error("must not perform"); },
  };
  const disabled = createPullRequestExternalActionExecutor({
    credentialProvider() { credentials += 1; return "secret"; },
    transport,
  });

  assert.deepEqual(await disabled.execute(envelope), { status: "stale" });
  assert.deepEqual(await disabled.reconcile(envelope), { status: "stale" });
  assert.equal(credentials, 0);

  const enabled = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialProvider() { credentials += 1; return null; },
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
  });
  assert.deepEqual(await enabled.execute(envelope), {
    status: "error",
    error: { code: "GITHUB_CREDENTIAL_MISSING", trust: "absent" },
  });
  assert.equal(credentials, 1);
});

test("all five actions execute once and reconcile from action-specific proof", async () => {
  for (const type of ACTION_TYPES) {
    const envelope = envelopeFor(type);
    const transport = mutableTransport(envelope);
    const executor = executorFor(envelope, transport);

    const applied = await executor.execute(envelope);
    const repeated = await executor.execute(envelope);
    const already = await executor.reconcile(envelope);

    assert.equal(applied.status, "applied", type);
    assert.equal(repeated.status, "already", type);
    assert.equal(already.status, "already", type);
    assert.deepEqual(already.receipt, applied.receipt, type);
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      1,
      type,
    );
    const performed = transport.calls.find(({ method }) => method === "perform");
    assert.equal(performed.input.credential, "runtime-secret");
    assert.equal(performed.input.repository, "acme/repo");
    assert.equal(performed.input.pullRequestNumber, 42);
    assert.equal(JSON.stringify(applied).includes("runtime-secret"), false);
  }
});

test("a lost mutation response is unknown until reconciliation proves already", async () => {
  for (const type of ACTION_TYPES) {
    const envelope = envelopeFor(type);
    const transport = mutableTransport(envelope, { loseResponse: true });
    const executor = executorFor(envelope, transport);

    assert.deepEqual(await executor.execute(envelope), {
      status: "error",
      error: { code: "GITHUB_RESPONSE_LOST", trust: "unknown" },
    }, type);
    assert.equal((await executor.reconcile(envelope)).status, "already", type);
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      1,
      type,
    );
  }
});

test("stale target or authority never performs an external action", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const stale = observationFor(envelope);
  stale.gitTarget.headRefOid = externalActionOid("9");
  transport.setObservation(stale);
  const executor = executorFor(envelope, transport);

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(transport.calls.some(({ method }) => method === "perform"), false);

  const currentTransport = mutableTransport(envelope);
  let checks = 0;
  const revoked = executorFor(envelope, currentTransport, {
    inputAuthorityVerifier: {
      async verify() {
        checks += 1;
        if (checks === 1) return structuredClone(envelope.action.inputBinding);
        throw new Error("revoked");
      },
    },
  });
  assert.deepEqual(await revoked.execute(envelope), { status: "stale" });
  assert.equal(currentTransport.calls.some(({ method }) => method === "perform"), false);
});

test("stale input authority is fenced before credentials or transport", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  let credentials = 0;
  const executor = executorFor(envelope, transport, {
    credentialProvider() {
      credentials += 1;
      return "runtime-secret";
    },
    inputAuthorityVerifier: {
      async verify() {
        throw new Error("the PR Head changed before owner confirmation");
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(credentials, 0);
  assert.deepEqual(transport.calls, []);
});

test("lost response recovery proves completion after authority is revoked", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope, { loseResponse: true });
  let revoked = false;
  let authorityChecks = 0;
  const executor = executorFor(envelope, transport, {
    inputAuthorityVerifier: {
      async verify() {
        authorityChecks += 1;
        if (revoked) throw new Error("the PR Head changed before recovery");
        return structuredClone(envelope.action.inputBinding);
      },
    },
  });

  assert.equal((await executor.execute(envelope)).error.trust, "unknown");
  revoked = true;
  const callsBeforeRecovery = transport.calls.length;
  const checksBeforeRecovery = authorityChecks;

  assert.equal((await executor.reconcile(envelope)).status, "already");
  assert.equal(transport.calls.length, callsBeforeRecovery + 1);
  assert.equal(transport.calls.at(-1).method, "observe");
  assert.equal(
    transport.calls.filter(({ method }) => method === "perform").length,
    1,
  );
  assert.equal(authorityChecks, checksBeforeRecovery);
});

test("absent recovery proof checks revoked authority after one observation", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  let credentials = 0;
  const executor = executorFor(envelope, transport, {
    credentialProvider() {
      credentials += 1;
      return "runtime-secret";
    },
    inputAuthorityVerifier: {
      async verify() {
        throw new Error("the PR Head changed before recovery");
      },
    },
  });

  assert.deepEqual(await executor.reconcile(envelope), { status: "stale" });
  assert.equal(credentials, 1);
  assert.deepEqual(
    transport.calls.map(({ method }) => method),
    ["observe"],
  );
});

test("recovery without credentials remains unknown and never performs", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    credentialProvider() { return null; },
  });

  assert.deepEqual(await executor.reconcile(envelope), {
    status: "error",
    error: { code: "GITHUB_CREDENTIAL_MISSING", trust: "unknown" },
  });
  assert.deepEqual(transport.calls, []);
});

test("authority revoked during the final observation is fenced before perform", async () => {
  const envelope = envelopeFor("comment");
  const base = mutableTransport(envelope);
  let observations = 0;
  let revoked = false;
  const transport = {
    calls: base.calls,
    async observe(input) {
      observations += 1;
      const result = await base.observe(input);
      if (observations === 2) revoked = true;
      return result;
    },
    perform: base.perform.bind(base),
  };
  const executor = executorFor(envelope, transport, {
    inputAuthorityVerifier: {
      async verify() {
        if (revoked) throw new Error("revoked while observing");
        return structuredClone(envelope.action.inputBinding);
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(observations, 2);
  assert.equal(transport.calls.some(({ method }) => method === "perform"), false);
});

test("push verifies sealed controlled evidence before any credential or transport call", async () => {
  const envelope = envelopeFor("push");
  let credentials = 0;
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    credentialProvider() { credentials += 1; return "secret"; },
    controlledCommitVerifier: {
      async verify() {
        const changed = structuredClone(envelope.action.controlledCommitEvidence);
        changed.evidenceDigest = "0".repeat(64);
        return changed;
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(credentials, 0);
  assert.equal(transport.calls.length, 0);
});

test("push revalidates controlled evidence after the final observation before perform", async () => {
  for (const failure of ["mismatch", "unavailable"]) {
    const envelope = envelopeFor("push");
    const transport = mutableTransport(envelope);
    let evidenceChecks = 0;
    const executor = executorFor(envelope, transport, {
      controlledCommitVerifier: {
        async verify() {
          evidenceChecks += 1;
          if (evidenceChecks === 1) {
            return structuredClone(envelope.action.controlledCommitEvidence);
          }
          if (failure === "unavailable") {
            throw new Error("controlled evidence disappeared while observing");
          }
          const changed = structuredClone(
            envelope.action.controlledCommitEvidence,
          );
          changed.evidenceDigest = "0".repeat(64);
          return changed;
        },
      },
    });

    assert.deepEqual(
      await executor.execute(envelope),
      failure === "mismatch"
        ? { status: "stale" }
        : {
            status: "error",
            error: {
              code: "CONTROLLED_COMMIT_VERIFIER_UNAVAILABLE",
              trust: "absent",
            },
          },
      failure,
    );
    assert.equal(evidenceChecks, 2, failure);
    assert.deepEqual(
      transport.calls.map(({ method }) => method),
      ["observe", "observe"],
      failure,
    );
  }
});

test("push recovery uses sealed proof when the current evidence verifier is unavailable", async () => {
  const envelope = envelopeFor("push");
  let credentials = 0;
  const transport = mutableTransport(envelope);
  transport.setObservation(completedObservation(envelope, "unused"));
  const executor = executorFor(envelope, transport, {
    credentialProvider() { credentials += 1; return "secret"; },
    controlledCommitVerifier: {
      async verify() { throw new Error("sealed store temporarily unavailable"); },
    },
  });

  assert.equal((await executor.reconcile(envelope)).status, "already");
  assert.equal(credentials, 1);
  assert.deepEqual(
    transport.calls.map(({ method }) => method),
    ["observe"],
  );
});

test("update and merge completion proof fails closed when corrupted", async () => {
  const updateEnvelope = envelopeFor("update_branch");
  const updateTransport = mutableTransport(updateEnvelope);
  const wrongParents = completedObservation(updateEnvelope, "unused");
  wrongParents.actionEvidence.commit.parents.reverse();
  updateTransport.setObservation(wrongParents);
  assert.deepEqual(
    await executorFor(updateEnvelope, updateTransport).reconcile(updateEnvelope),
    { status: "stale" },
  );

  const mergeEnvelope = envelopeFor("merge");
  const mergeTransport = mutableTransport(mergeEnvelope);
  const missingMarker = completedObservation(
    mergeEnvelope,
    `<!-- mydashboard-action:v1:${"f".repeat(64)} -->`,
  );
  mergeTransport.setObservation(missingMarker);
  assert.deepEqual(
    await executorFor(mergeEnvelope, mergeTransport).reconcile(mergeEnvelope),
    {
      status: "error",
      error: { code: "GITHUB_COMPLETION_PROOF_CONFLICT", trust: "unknown" },
    },
  );
});
