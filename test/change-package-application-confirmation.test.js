import assert from "node:assert/strict";
import test from "node:test";

import {
  changePackageApplicationConfirmationId,
  createChangePackageApplicationConfirmationPlan,
  normalizeChangePackageApplicationEnvelope,
} from "../src/domain/change-package-application-confirmation.js";
import { createChangePackage } from "../src/domain/change-package-contract.js";
import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { digestValue } from "../src/domain/code-executor-contract.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const HEAD = "0123456789abcdef0123456789abcdef01234567";

function manifest() {
  return createChangePackage({
    job: { id: "code-job-1", revision: 7, recordDigest: SHA_A },
    proposal: { id: "proposal-1", contentDigest: SHA_B },
    grant: { digest: SHA_C },
    workspace: {
      id: "workspace-1",
      sourceRevision: SHA_A,
      workspaceRevision: SHA_B,
    },
    passedProfiles: [
      {
        id: "node-tests",
        configDigest: SHA_C,
        workspaceRevision: SHA_B,
        actionId: "test-action",
        attemptNumber: 2,
        imageId: "sha256:node-test-image",
        artifacts: {
          output: { path: "evidence/output.json", sha256: SHA_D, bytes: 12 },
          stdout: { path: "evidence/stdout.txt", sha256: SHA_D, bytes: 12 },
          stderr: { path: "evidence/stderr.txt", sha256: SHA_D, bytes: 12 },
        },
      },
    ],
    created: [{ path: "src/new.js", content: Buffer.from("new\n") }],
    modified: [
      {
        path: "src/app.js",
        beforeSha256: SHA_D,
        content: Buffer.from("changed\n"),
      },
    ],
    deleted: [{ path: "src/old.js", beforeSha256: SHA_C }],
  }).manifest;
}

function request(targetOverrides = {}) {
  return {
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    target: {
      workspaceId: "workspace-1",
      targetAuthorityDigest: "e".repeat(64),
      expectedHeadOid: HEAD,
      ...targetOverrides,
    },
  };
}

function envelope(planValue = plan()) {
  const queued = normalizeConfirmationPlan(planValue);
  return {
    schemaVersion: 1,
    id: queued.id,
    idempotencyKey: `confirmation-${queued.approvalBindingDigest}`,
    kind: queued.kind,
    requestedBy: queued.requestedBy,
    actor: queued.actor,
    target: queued.target,
    action: queued.action,
    displayedPayloadDigest: queued.displayedPayloadDigest,
    approvalBindingDigest: queued.approvalBindingDigest,
    execution: {
      requestId: "application-request-0001",
      attempt: 1,
      startedAt: "2026-08-02T03:00:00.000Z",
    },
  };
}

function plan() {
  return createChangePackageApplicationConfirmationPlan(manifest(), request());
}

function resign(value) {
  const approvalBindingDigest = digestValue({
    id: value.id,
    kind: value.kind,
    requestedBy: value.requestedBy,
    actor: value.actor,
    target: value.target,
    action: value.action,
    displayedPayloadDigest: value.displayedPayloadDigest,
  });
  return {
    ...value,
    approvalBindingDigest,
    idempotencyKey: `confirmation-${approvalBindingDigest}`,
  };
}

function assertInvalid(operation) {
  assert.throws(
    operation,
    (error) =>
      error?.code === "INVALID_CHANGE_PACKAGE_APPLICATION_CONFIRMATION",
  );
}

test("a verified package becomes one exact source-application confirmation", () => {
  const packageManifest = manifest();
  const value = createChangePackageApplicationConfirmationPlan(
    packageManifest,
    request(),
  );

  assert.equal(value.kind, "local.change-package-apply");
  assert.equal(
    value.id,
    changePackageApplicationConfirmationId(packageManifest, request()),
  );
  assert.deepEqual(value.actor, {
    provider: "local-code",
    accountId: "change-package-application-service",
  });
  assert.deepEqual(value.target, {
    provider: "local-code",
    resourceId: "workspace-1",
    version: HEAD,
  });
  assert.deepEqual(value.action, {
    type: "apply_change_package",
    packageId: packageManifest.packageId,
    packageDigest: packageManifest.packageDigest,
    job: packageManifest.job,
    proposal: packageManifest.proposal,
    grant: packageManifest.grant,
    workspace: packageManifest.workspace,
    changeSetDigest: digestValue(packageManifest.changes),
    testEvidenceDigest: digestValue(packageManifest.passedProfiles),
    targetAuthorityDigest: "e".repeat(64),
    expectedHeadOid: HEAD,
  });
  assert.deepEqual(value.display.payload, {
    actor: value.actor,
    target: value.target,
    action: value.action,
  });
  assert.equal(JSON.stringify(value.display).includes("src/app.js"), false);
  assert.equal(JSON.stringify(value.display).includes(":\\"), false);

  const queued = normalizeConfirmationPlan(value);
  assert.match(queued.displayedPayloadDigest, /^[a-f0-9]{64}$/);
  assert.match(queued.approvalBindingDigest, /^[a-f0-9]{64}$/);
});

test("package, Head, and target authority changes get distinct stable IDs", () => {
  const firstManifest = manifest();
  const first = createChangePackageApplicationConfirmationPlan(
    firstManifest,
    request(),
  );
  const repeated = createChangePackageApplicationConfirmationPlan(
    firstManifest,
    request(),
  );
  const changedManifest = createChangePackage({
    job: firstManifest.job,
    proposal: firstManifest.proposal,
    grant: firstManifest.grant,
    workspace: firstManifest.workspace,
    passedProfiles: firstManifest.passedProfiles,
    created: [{ path: "src/another.js", content: Buffer.from("another\n") }],
    modified: [],
    deleted: [],
  }).manifest;

  assert.equal(first.id, repeated.id);
  assert.notEqual(
    first.id,
    createChangePackageApplicationConfirmationPlan(changedManifest, request()).id,
  );
  assert.notEqual(
    first.id,
    createChangePackageApplicationConfirmationPlan(
      firstManifest,
      request({ expectedHeadOid: "f".repeat(40) }),
    ).id,
  );
  assert.notEqual(
    first.id,
    createChangePackageApplicationConfirmationPlan(
      firstManifest,
      request({ targetAuthorityDigest: "9".repeat(64) }),
    ).id,
  );
  assert.notEqual(
    first.id,
    createChangePackageApplicationConfirmationPlan(firstManifest, {
      ...request(),
      requestedBy: { roleId: "tester", workItemId: "work-2" },
    }).id,
  );
});

test("trusted target and package bindings fail closed", () => {
  const packageManifest = manifest();
  for (const target of [
    request({ workspaceId: "other-workspace" }),
    request({ expectedHeadOid: "A".repeat(40) }),
    request({ expectedHeadOid: "a".repeat(39) }),
    request({ targetAuthorityDigest: "not-a-digest" }),
  ]) {
    assertInvalid(() =>
      createChangePackageApplicationConfirmationPlan(packageManifest, target),
    );
  }

  assertInvalid(() =>
    createChangePackageApplicationConfirmationPlan(packageManifest, {
      ...request(),
      extra: true,
    }),
  );
  assertInvalid(() =>
    createChangePackageApplicationConfirmationPlan(
      { ...packageManifest, packageDigest: SHA_D },
      request(),
    ),
  );

  let getterCalls = 0;
  const target = {};
  Object.defineProperty(target, "workspaceId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "workspace-1";
    },
  });
  Object.defineProperty(target, "targetAuthorityDigest", {
    enumerable: true,
    value: "e".repeat(64),
  });
  Object.defineProperty(target, "expectedHeadOid", {
    enumerable: true,
    value: HEAD,
  });
  assertInvalid(() =>
    createChangePackageApplicationConfirmationPlan(manifest(), {
      requestedBy: request().requestedBy,
      target,
    }),
  );
  assert.equal(getterCalls, 0);
});

test("private queue envelopes normalize to frozen snapshots", () => {
  const input = envelope();
  const normalized = normalizeChangePackageApplicationEnvelope(input);

  assert.deepEqual(normalized, input);
  assert.notStrictEqual(normalized, input);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.action.workspace), true);
  input.action.workspace.id = "mutated";
  assert.equal(normalized.action.workspace.id, "workspace-1");
});

test("tampered, widened, forged, and malformed envelopes fail closed", () => {
  const input = envelope();
  const forgedAction = {
    ...input.action,
    changeSetDigest: "9".repeat(64),
  };
  const cases = [
    { ...input, extra: true },
    { ...input, kind: "local.code-job-create" },
    { ...input, target: { ...input.target, resourceId: "other-workspace" } },
    { ...input, action: { ...input.action, command: "git apply" } },
    resign({ ...input, action: forgedAction }),
    { ...input, idempotencyKey: `confirmation-${"0".repeat(64)}` },
    { ...input, execution: { ...input.execution, attempt: 0 } },
    { ...input, execution: { ...input.execution, startedAt: "not-a-time" } },
  ];

  for (const value of cases) {
    assertInvalid(() => normalizeChangePackageApplicationEnvelope(value));
  }

  let getterCalls = 0;
  const accessor = { ...input };
  Object.defineProperty(accessor, "action", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return input.action;
    },
  });
  assertInvalid(() => normalizeChangePackageApplicationEnvelope(accessor));
  assert.equal(getterCalls, 0);
});
