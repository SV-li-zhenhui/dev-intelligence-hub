import assert from "node:assert/strict";
import test from "node:test";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource } from "../src/domain/code-execution-source.js";
import {
  ControlledCodeExecutorError,
  digestValue,
  normalizeActionRequest,
  normalizeResumeRequest,
  normalizeRuntimeOptions,
  normalizeStartRequest,
} from "../src/domain/code-executor-contract.js";

const REVISION = "a".repeat(64);
const HEAD_REF_OID = "b".repeat(40);

function inputBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/repo",
    pullRequestNumber: 42,
    rootItemId: "work-item-pr-42",
    workKey: "github:dashboard:acme-repo:42",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: HEAD_REF_OID,
    eventId: "event-pr-42",
    eventDigest: "c".repeat(64),
    inputDigest: "d".repeat(64),
    ...overrides,
  };
}

function conflictInputBinding() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "1".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: HEAD_REF_OID,
  };
  return {
    ...inputBinding({ schemaVersion: 2 }),
    gitTarget,
  };
}

function executionSource() {
  const binding = conflictInputBinding();
  return createConflictCodeExecutionSource({
    inputBinding: binding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "2".repeat(64),
        status: "conflicted",
        baseCommitOid: binding.gitTarget.baseRefOid,
        headCommitOid: binding.gitTarget.headRefOid,
        mergeBaseOid: "3".repeat(40),
        resultTreeOid: "4".repeat(40),
        conflicts: [{ path: "src/value.js", mode: "100644" }],
        boundaryDigest: "5".repeat(64),
        evidenceDigest: "6".repeat(64),
        resultObjectDigest: "7".repeat(64),
        materialization: "full-tree",
      },
      gitTarget: binding.gitTarget,
    }),
  });
}

function assertInvalid(operation) {
  assert.throws(
    operation,
    (error) =>
      error instanceof ControlledCodeExecutorError &&
      error.code === "INVALID_EXECUTION_REQUEST",
  );
}

test("start and resume requests normalize exact plain DTOs", () => {
  const binding = inputBinding();
  const start = normalizeStartRequest({
    workspaceId: "dashboard",
    requestedBy: { workItemId: "PR-42", roleId: "pr-engineer" },
    sessionId: "session-1",
    inputBinding: binding,
  });

  assert.deepEqual(start, {
    sessionId: "session-1",
    workspaceId: "dashboard",
    requestedBy: { roleId: "pr-engineer", workItemId: "PR-42" },
    inputBinding: binding,
  });
  assert.equal(
    normalizeStartRequest({
      sessionId: "session-long-role",
      workspaceId: "dashboard",
      requestedBy: { roleId: "r".repeat(65), workItemId: "PR-43" },
      inputBinding: null,
    }).requestedBy.roleId.length,
    65,
  );
  assert.deepEqual(
    normalizeResumeRequest({ sessionId: "session-1", inputBinding: binding }),
    { sessionId: "session-1", inputBinding: binding },
  );
  assert.deepEqual(
    normalizeResumeRequest({ sessionId: "a".repeat(64), inputBinding: null }),
    { sessionId: "a".repeat(64), inputBinding: null },
  );

  assertInvalid(() =>
    normalizeStartRequest({
      sessionId: "session-1",
      workspaceId: "dashboard",
      requestedBy: { roleId: "pr-engineer", workItemId: null },
      inputBinding: null,
      command: "npm test",
    }),
  );
  assertInvalid(() =>
    normalizeStartRequest({
      sessionId: "Session-1",
      workspaceId: "dashboard",
      requestedBy: { roleId: "pr-engineer", workItemId: null },
      inputBinding: null,
    }),
  );
  assertInvalid(() =>
    normalizeStartRequest({
      sessionId: "session-1",
      workspaceId: "dashboard",
      requestedBy: { roleId: "pr-engineer", workItemId: "bad\u0000item" },
      inputBinding: null,
    }),
  );
  assertInvalid(() =>
    normalizeStartRequest({
      sessionId: "session-1",
      workspaceId: "dashboard",
      requestedBy: Object.assign(Object.create({ inherited: true }), {
        roleId: "pr-engineer",
        workItemId: null,
      }),
      inputBinding: null,
    }),
  );
  assertInvalid(() =>
    normalizeStartRequest({
      sessionId: "session-1",
      workspaceId: "dashboard",
      requestedBy: { roleId: "pr-engineer", workItemId: null },
    }),
  );
  assertInvalid(() => normalizeResumeRequest({ sessionId: "session-1" }));
  assertInvalid(() =>
    normalizeResumeRequest({
      sessionId: "session-1",
      inputBinding: null,
      workspaceId: "dashboard",
    }),
  );
  assertInvalid(() =>
    normalizeResumeRequest({
      sessionId: "a".repeat(65),
      inputBinding: null,
    }),
  );
});

test("start and resume bind a detached canonical pull request Head", () => {
  const supplied = inputBinding();
  const start = normalizeStartRequest({
    sessionId: "session-1",
    workspaceId: "dashboard",
    requestedBy: { roleId: "pr-engineer", workItemId: "PR-42" },
    inputBinding: supplied,
  });
  const resume = normalizeResumeRequest({
    sessionId: "session-1",
    inputBinding: supplied,
  });

  assert.deepEqual(start.inputBinding, inputBinding());
  assert.deepEqual(resume.inputBinding, inputBinding());
  assert.notStrictEqual(start.inputBinding, supplied);
  assert.notStrictEqual(resume.inputBinding, supplied);
  assert.notStrictEqual(start.inputBinding, resume.inputBinding);
  assert.deepEqual(Object.keys(start.inputBinding), [
    "schemaVersion",
    "kind",
    "repository",
    "pullRequestNumber",
    "rootItemId",
    "workKey",
    "inputRevision",
    "headRevision",
    "headRefOid",
    "eventId",
    "eventDigest",
    "inputDigest",
  ]);

  supplied.headRefOid = "e".repeat(40);
  start.inputBinding.repository = "other/repo";
  assert.equal(start.inputBinding.headRefOid, HEAD_REF_OID);
  assert.equal(resume.inputBinding.repository, "acme/repo");
  assert.equal(supplied.repository, "acme/repo");

  assert.equal(
    normalizeResumeRequest({
      sessionId: "session-1",
      inputBinding: inputBinding({ headRefOid: "f".repeat(64) }),
    }).inputBinding.headRefOid.length,
    64,
  );
});

test("conflict start and resume bind the complete atomic execution source", () => {
  const source = executionSource();
  const binding = source.inputBinding;
  const start = normalizeStartRequest({
    sessionId: "session-conflict",
    workspaceId: "dashboard",
    requestedBy: { roleId: "pr-engineer", workItemId: "PR-42" },
    inputBinding: binding,
    executionSource: source,
  });
  const resume = normalizeResumeRequest({
    sessionId: "session-conflict",
    inputBinding: binding,
    executionSource: source,
  });

  assert.deepEqual(start.executionSource, source);
  assert.deepEqual(resume.executionSource, source);
  assert.notEqual(start.executionSource, source);
  assertInvalid(() =>
    normalizeStartRequest({
      sessionId: "session-conflict",
      workspaceId: "dashboard",
      requestedBy: { roleId: "pr-engineer", workItemId: "PR-42" },
      inputBinding: inputBinding(),
      executionSource: source,
    }),
  );
  assertInvalid(() =>
    normalizeResumeRequest({
      sessionId: "session-conflict",
      inputBinding: binding,
      executionSource: {
        ...source,
        writeScope: { ...source.writeScope, paths: ["src/other.js"] },
      },
    }),
  );
});

test("execution input bindings reject malformed, forged, and accessor-backed DTOs", () => {
  let getterInvoked = false;
  const accessor = inputBinding();
  Object.defineProperty(accessor, "repository", {
    enumerable: true,
    get() {
      getterInvoked = true;
      return "acme/repo";
    },
  });
  const customPrototype = Object.assign(
    Object.create({ inherited: true }),
    inputBinding(),
  );
  const invalidBindings = [
    inputBinding({ headRefOid: "B".repeat(40) }),
    inputBinding({ headRefOid: "b".repeat(39) }),
    inputBinding({ headRefOid: "b".repeat(65) }),
    inputBinding({ eventDigest: "not-a-digest" }),
    { ...inputBinding(), extra: true },
    customPrototype,
    accessor,
  ];

  for (const candidate of invalidBindings) {
    assertInvalid(() =>
      normalizeStartRequest({
        sessionId: "session-1",
        workspaceId: "dashboard",
        requestedBy: { roleId: "pr-engineer", workItemId: "PR-42" },
        inputBinding: candidate,
      }),
    );
    assertInvalid(() =>
      normalizeResumeRequest({
        sessionId: "session-1",
        inputBinding: candidate,
      }),
    );
  }
  assert.equal(getterInvoked, false);
});

test("each semantic action has an exact, ordered normalized schema", () => {
  const cases = [
    [
      { path: "src", expectedWorkspaceRevision: REVISION, actionId: "a-1", type: "list_files" },
      {
        type: "list_files",
        actionId: "a-1",
        expectedWorkspaceRevision: REVISION,
        path: "src",
      },
    ],
    [
      {
        path: "src/app.js",
        type: "read_text",
        actionId: "a-2",
        expectedWorkspaceRevision: REVISION,
      },
      {
        type: "read_text",
        actionId: "a-2",
        expectedWorkspaceRevision: REVISION,
        path: "src/app.js",
      },
    ],
    [
      {
        query: "needle",
        path: "",
        type: "search_text",
        actionId: "a-3",
        expectedWorkspaceRevision: REVISION,
      },
      {
        type: "search_text",
        actionId: "a-3",
        expectedWorkspaceRevision: REVISION,
        path: "",
        query: "needle",
      },
    ],
    [
      {
        expectedSha256: null,
        content: "export const answer = 42;\n",
        path: "src/answer.js",
        type: "write_text",
        actionId: "a-4",
        expectedWorkspaceRevision: REVISION,
      },
      {
        type: "write_text",
        actionId: "a-4",
        expectedWorkspaceRevision: REVISION,
        path: "src/answer.js",
        content: "export const answer = 42;\n",
        expectedSha256: null,
      },
    ],
    [
      {
        profileId: "node-test",
        type: "run_profile",
        actionId: "a-5",
        expectedWorkspaceRevision: REVISION,
      },
      {
        type: "run_profile",
        actionId: "a-5",
        expectedWorkspaceRevision: REVISION,
        profileId: "node-test",
      },
    ],
    [
      { expectedWorkspaceRevision: REVISION, actionId: "a-6", type: "complete" },
      {
        type: "complete",
        actionId: "a-6",
        expectedWorkspaceRevision: REVISION,
      },
    ],
  ];

  for (const [action, expected] of cases) {
    const result = normalizeActionRequest({ action, sessionId: "session-1" });
    assert.deepEqual(result, { sessionId: "session-1", action: expected });
    assert.deepEqual(Object.keys(result.action), Object.keys(expected));
  }
});

test("action requests reject capabilities and malformed fields outside the contract", () => {
  const base = {
    type: "read_text",
    actionId: "action-1",
    expectedWorkspaceRevision: REVISION,
    path: "src/app.js",
  };

  for (const action of [
    { ...base, type: "delete" },
    { ...base, command: "npm" },
    { ...base, args: ["test"] },
    { ...base, env: { TOKEN: "secret" } },
    { ...base, cwd: "." },
    { ...base, workspacePath: "D:/repo" },
    { ...base, expectedWorkspaceRevision: "A".repeat(64) },
    { ...base, actionId: "action_1" },
    { ...base, path: 42 },
  ]) {
    assertInvalid(() =>
      normalizeActionRequest({ sessionId: "session-1", action }),
    );
  }

  assertInvalid(() =>
    normalizeActionRequest({ sessionId: "session-1", action: base, signal: null }),
  );
  assertInvalid(() =>
    normalizeActionRequest({
      sessionId: "session-1",
      action: { ...base, type: "write_text", content: "x", expectedSha256: "bad" },
    }),
  );
});

test("DTO validation rejects arrays, custom prototypes, inherited and accessor fields", () => {
  assertInvalid(() => normalizeResumeRequest(["session-1"]));
  assertInvalid(() =>
    normalizeResumeRequest(Object.assign(Object.create(null), {
      sessionId: "session-1",
      inputBinding: null,
    })),
  );
  assertInvalid(() =>
    normalizeResumeRequest(Object.create({
      sessionId: "session-1",
      inputBinding: null,
    })),
  );

  const accessor = { inputBinding: null };
  Object.defineProperty(accessor, "sessionId", {
    enumerable: true,
    get: () => "session-1",
  });
  assertInvalid(() => normalizeResumeRequest(accessor));

  const symbolKey = { sessionId: "session-1", inputBinding: null };
  symbolKey[Symbol("extra")] = true;
  assertInvalid(() => normalizeResumeRequest(symbolKey));
});

test("runtime options accept only an optional AbortSignal-like signal", () => {
  const controller = new AbortController();
  assert.deepEqual(normalizeRuntimeOptions(), { signal: null });
  assert.deepEqual(normalizeRuntimeOptions({}), { signal: null });
  assert.deepEqual(normalizeRuntimeOptions({ signal: null }), { signal: null });
  assert.equal(normalizeRuntimeOptions({ signal: controller.signal }).signal, controller.signal);

  for (const options of [
    { timeoutMs: 1_000 },
    { signal: undefined },
    { signal: { aborted: false } },
    null,
  ]) {
    assertInvalid(() => normalizeRuntimeOptions(options));
  }
});

test("digestValue recursively sorts JSON object keys", () => {
  const left = {
    z: [{ b: 2, a: 1 }],
    a: { d: 4, c: 3 },
  };
  const right = {
    a: { c: 3, d: 4 },
    z: [{ a: 1, b: 2 }],
  };

  assert.match(digestValue(left), /^[a-f0-9]{64}$/);
  assert.equal(digestValue(left), digestValue(right));
  assert.notEqual(digestValue(left), digestValue({ ...right, z: [{ a: 1, b: 3 }] }));
  const specialLeft = JSON.parse('{"z":1,"__proto__":{"safe":true}}');
  const specialRight = JSON.parse('{"__proto__":{"safe":true},"z":1}');
  assert.equal(digestValue(specialLeft), digestValue(specialRight));
  assertInvalid(() => digestValue({ value: undefined }));
  assertInvalid(() => digestValue({ value: Number.NaN }));
  const cyclic = {};
  cyclic.self = cyclic;
  assertInvalid(() => digestValue(cyclic));
});
