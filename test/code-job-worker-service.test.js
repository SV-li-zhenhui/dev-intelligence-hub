import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
} from "../src/domain/code-job-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource } from "../src/domain/code-execution-source.js";
import { digestValue } from "../src/domain/code-executor-contract.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { CodeJobBrainDirectory } from "../src/services/code-job-brain-directory.js";
import { CodeJobWorkerService } from "../src/services/code-job-worker-service.js";
import { modelObservation, observationDetail } from "../src/services/code-job-worker-policy.js";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);
const FILE_SHA = "c".repeat(64);
const PROFILE_DIGEST = "d".repeat(64);

function pullRequestInputBinding(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/dashboard",
    pullRequestNumber: 42,
    rootItemId: "github:acme/dashboard:pull-request:42",
    workKey: "pr-work-42",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: "1".repeat(40),
    eventId: "pull-request-event-42",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
    ...overrides,
  };
}

function conflictInputBinding() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/dashboard",
    baseRefName: "main",
    baseRefOid: "4".repeat(40),
    headRepository: "contributor/dashboard",
    headRefName: "fix/conflict",
    headRefOid: "1".repeat(40),
  };
  return pullRequestInputBinding({ schemaVersion: 2, gitTarget });
}

function conflictExecutionSource(binding) {
  return createConflictCodeExecutionSource({
    inputBinding: binding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "5".repeat(64),
        status: "conflicted",
        baseCommitOid: binding.gitTarget.baseRefOid,
        headCommitOid: binding.gitTarget.headRefOid,
        mergeBaseOid: "6".repeat(40),
        resultTreeOid: "7".repeat(40),
        conflicts: [{ path: "src/app.js", mode: "100644" }],
        boundaryDigest: "8".repeat(64),
        evidenceDigest: "9".repeat(64),
        resultObjectDigest: "a".repeat(64),
        materialization: "full-tree",
      },
      gitTarget: binding.gitTarget,
    }),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readyActionAdmissionGate() {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version: 1,
    configurationDigest: "1".repeat(64),
  });
  return gate;
}

function activateNextConfiguration(gate) {
  return gate.cutover(({ commit }) => {
    commit({
      version: 2,
      configurationDigest: "2".repeat(64),
    });
    return "activated-v2";
  });
}

class IntegrationMemoryStore {
  constructor() {
    this.values = new Map();
  }

  async read(name, fallback) {
    const value = this.values.get(name);
    return structuredClone(value === undefined ? fallback : value);
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function grant(overrides = {}) {
  return {
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    workspaceId: "dashboard",
    repository: "acme/dashboard",
    operation: "modify",
    objective: "Repair the state transition.",
    acceptanceCriteria: ["The regression test passes."],
    evidence: ["A stale transition overwrites current state."],
    summary: "Repair the transition safely.",
    allowedActions: [
      "list_files",
      "read_text",
      "search_text",
      "write_text",
      "run_profile",
      "complete",
    ],
    writablePaths: ["src", "test"],
    requiredProfiles: [{ id: "node-tests", configDigest: PROFILE_DIGEST }],
    brainDigest: "1".repeat(64),
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    jobId: "code-job-1111111111111111111111111111111111111111111111111111111",
    sequence: 1,
    status: "queued",
    revision: 1,
    grant: grant(),
    execution: {
      sessionId: null,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
      cancellationSettlement: null,
    },
    ...overrides,
  };
}

function observation(action, {
  status = "succeeded",
  workspaceRevision = REVISION_A,
  actionAttemptNumber = 1,
  result = {},
} = {}) {
  const detail = {
    schemaVersion: 1,
    executor: {
      sessionStatus: "active",
      sessionAttemptNumber: actionAttemptNumber,
      actionStatus: status,
      actionAttemptNumber,
    },
    result: structuredClone(result),
  };
  return {
    turn: 1,
    actionId: action.actionId,
    actionType: action.type,
    actionDigest: digestValue(action),
    action: structuredClone(action),
    status,
    workspaceRevision,
    detail,
    detailDigest: digestValue(detail),
    recordedAt: "2026-08-01T00:00:00.000Z",
  };
}

class FakeJobStore {
  constructor(jobs, events = []) {
    this.jobs = new Map(jobs.map((entry) => {
      const copy = structuredClone(entry);
      copy.execution.actionAdmission ??= null;
      copy.execution.uncertainty ??= null;
      return [entry.jobId, copy];
    }));
    this.events = events;
    this.completionRequests = [];
    this.beforeAdmit = null;
    this.afterAdmit = null;
  }

  async listRunnable({ limit, roleId } = {}) {
    return {
      revision: 1,
      items: [...this.jobs.values()]
        .filter(
          (entry) =>
            ["queued", "starting", "active", "pausing", "cancelling"].includes(entry.status) &&
            (roleId === undefined || entry.grant.requestedBy.roleId === roleId),
        )
        .slice(0, limit)
        .map((entry) => structuredClone(entry)),
    };
  }

  async listReconcilable({ limit, roleId } = {}) {
    return {
      revision: 1,
      items: [...this.jobs.values()]
        .filter(
          (entry) =>
            entry.status === "unknown" &&
            (roleId === undefined || entry.grant.requestedBy.roleId === roleId),
        )
        .slice(0, limit)
        .map((entry) => structuredClone(entry)),
    };
  }

  async getForWorker(jobId) {
    const entry = this.jobs.get(jobId);
    return entry ? structuredClone(entry) : null;
  }

  #mutate(jobId, expectedRevision, operation, event) {
    const current = this.jobs.get(jobId);
    assert.equal(current.revision, expectedRevision);
    operation(current);
    current.revision += 1;
    this.events.push(event);
    return { status: "applied", job: structuredClone(current) };
  }

  async claimStarting({ jobId, expectedRevision }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.status = "starting";
      current.execution.sessionId = current.jobId;
    }, "claim");
  }

  async activate({ jobId, expectedRevision, workspaceRevision }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.status = "active";
      current.execution.workspaceRevision = workspaceRevision;
    }, "activate");
  }

  async acknowledgeAbsentSession({ jobId, expectedRevision }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.ok(["pausing", "unknown"].includes(current.status));
      assert.equal(current.execution.pause.from, "starting");
      current.status = "paused";
    }, "session-absent");
  }

  async acknowledgeStartedSession({
    jobId,
    expectedRevision,
    workspaceRevision,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.equal(current.status, "pausing");
      assert.equal(current.execution.pause.from, "starting");
      current.status = "paused";
      current.execution.workspaceRevision = workspaceRevision;
      current.execution.pause.from = "active";
    }, "session-started");
  }

  async finalizeCancellation({
    jobId,
    expectedRevision,
    settlement,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.equal(current.status, "cancelling");
      current.status = "cancelled";
      current.execution.workspaceRevision = settlement.trustedWorkspaceRevision;
      current.execution.cancellationSettlement = {
        kind: settlement.kind,
        sessionId: settlement.sessionId,
        cancellationDigest: settlement.cancellationDigest,
        workspaceRevision: settlement.trustedWorkspaceRevision,
        proofDigest: settlement.proofDigest,
        settledAt: settlement.settledAt,
      };
      current.execution.pendingAction = null;
      current.execution.actionAdmission = null;
      current.execution.pause = null;
      current.execution.uncertainty = null;
    }, "cancelled");
  }

  async prepareAction({ jobId, expectedRevision, action }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.execution.pendingAction = {
        turn: current.execution.turn + 1,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action: structuredClone(action),
        preparedAt: "2026-08-01T00:00:01.000Z",
      };
      current.execution.actionAdmission = null;
    }, "prepare");
  }

  async admitAction({ jobId, expectedRevision, actionId, actionDigest }) {
    if (this.beforeAdmit) await this.beforeAdmit();
    const current = this.jobs.get(jobId);
    if (current.status !== "active" || current.revision !== expectedRevision) {
      throw Object.assign(new Error("admission lost the state race"), {
        code: "CODE_JOB_TRANSITION_CONFLICT",
      });
    }
    const changed = this.#mutate(jobId, expectedRevision, (entry) => {
      assert.equal(entry.execution.pendingAction.actionId, actionId);
      assert.equal(entry.execution.pendingAction.actionDigest, actionDigest);
      entry.execution.actionAdmission = {
        actionId,
        actionDigest,
        epoch: expectedRevision + 1,
        admittedAt: "2026-08-01T00:00:01.500Z",
      };
    }, "admit");
    if (this.afterAdmit) await this.afterAdmit();
    return changed;
  }

  async acknowledgeAbsentAction({
    jobId,
    expectedRevision,
    actionId,
    actionDigest,
    epoch,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.ok(["pausing", "unknown", "cancelling"].includes(current.status));
      assert.equal(current.execution.pendingAction.actionId, actionId);
      assert.equal(current.execution.pendingAction.actionDigest, actionDigest);
      assert.equal(current.execution.actionAdmission.epoch, epoch);
      current.status = current.status === "cancelling"
        ? "cancelled"
        : current.status === "unknown" &&
        current.execution.uncertainty?.from === "active"
          ? "active"
          : "paused";
      current.execution.pendingAction = current.status === "cancelled"
        ? null
        : current.execution.pendingAction;
      current.execution.actionAdmission = null;
      current.execution.uncertainty = null;
      if (current.status === "cancelled") current.execution.pause = null;
    }, "pause-acknowledged");
  }

  async markActionUnknown({
    jobId,
    expectedRevision,
    actionId,
    actionDigest,
    epoch,
    code,
    message,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      assert.ok(["active", "pausing"].includes(current.status));
      assert.equal(current.execution.pendingAction.actionId, actionId);
      assert.equal(current.execution.pendingAction.actionDigest, actionDigest);
      assert.equal(current.execution.actionAdmission.epoch, epoch);
      const from = current.status;
      current.status = "unknown";
      current.execution.uncertainty = {
        from: from === "pausing" ? "pausing" : "active",
        code,
        message,
        at: "2026-08-01T00:00:01.875Z",
      };
    }, "unknown");
  }

  async pause({ jobId, expectedRevision, reason }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      const from = current.status;
      if (from === "unknown") {
        assert.equal(current.execution.uncertainty.from, "active");
        current.execution.pause = {
          from: "active",
          reason,
          at: "2026-08-01T00:00:01.750Z",
        };
        current.execution.uncertainty.from = "pausing";
        return;
      }
      current.status =
        from === "starting" ||
        (from === "active" && current.execution.actionAdmission !== null)
          ? "pausing"
          : "paused";
      current.execution.pause = {
        from,
        reason,
        at: "2026-08-01T00:00:01.750Z",
      };
    }, "pause");
  }

  async cancel({ jobId, expectedRevision, reason }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      const requestedFrom = current.status;
      const mustReconcile = current.execution.sessionId !== null;
      current.status = mustReconcile ? "cancelling" : "cancelled";
      const detail = {
        schemaVersion: 1,
        outcome: "cancelled",
        code: "CODE_JOB_CANCELLED",
        message: "cancelled by test",
        reason,
        requestedFrom,
      };
      current.execution.result = {
        kind: "cancelled",
        detail,
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-01T00:00:02.000Z",
      };
      if (!mustReconcile) {
        current.execution.pendingAction = null;
        current.execution.actionAdmission = null;
        current.execution.pause = null;
        current.execution.uncertainty = null;
      }
    }, "cancel");
  }

  async recordObservation({
    jobId,
    expectedRevision,
    actionId,
    status,
    workspaceRevision,
    detail,
  }) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      const pending = current.execution.pendingAction;
      assert.equal(pending.actionId, actionId);
      current.execution.workspaceRevision = workspaceRevision;
      current.execution.turn = pending.turn;
      current.execution.pendingAction = null;
      current.execution.actionAdmission = null;
      current.status = current.status === "cancelling"
        ? "cancelled"
        : current.status === "unknown" &&
        current.execution.uncertainty?.from === "active"
          ? "active"
          : current.status === "pausing" || current.status === "unknown"
            ? "paused"
            : current.status;
      current.execution.uncertainty = null;
      if (current.status === "cancelled") current.execution.pause = null;
      current.execution.observations.push({
        turn: pending.turn,
        actionId,
        actionType: pending.action.type,
        actionDigest: pending.actionDigest,
        action: structuredClone(pending.action),
        status,
        workspaceRevision,
        detail: structuredClone(detail),
        detailDigest: digestValue(detail),
        recordedAt: "2026-08-01T00:00:02.000Z",
      });
    }, "observe");
  }

  async complete(value) {
    this.completionRequests.push(structuredClone(value));
    const { jobId, expectedRevision, result } = value;
    return this.#terminal(jobId, expectedRevision, "completed", result);
  }

  async fail({ jobId, expectedRevision, result }) {
    return this.#terminal(jobId, expectedRevision, "failed", result);
  }

  async fence({ jobId, expectedRevision, result }) {
    return this.#terminal(jobId, expectedRevision, "fenced", result);
  }

  #terminal(jobId, expectedRevision, status, result) {
    return this.#mutate(jobId, expectedRevision, (current) => {
      current.status = status;
      current.execution.pendingAction = null;
      current.execution.result = { kind: status, detail: structuredClone(result) };
    }, status);
  }
}

class FakeExecutor {
  constructor(jobValue, events = [], { sessionStatus = "active", attempt = 1 } = {}) {
    this.events = events;
    this.calls = [];
    this.last = null;
    this.lastSignal = null;
    this.exists = !["queued", "starting"].includes(jobValue.status);
    this.session = {
      id: jobValue.jobId,
      workspaceId: jobValue.grant.workspaceId,
      requestedBy: structuredClone(jobValue.grant.requestedBy),
      inputBinding: Object.hasOwn(jobValue.grant, "inputBinding")
        ? structuredClone(jobValue.grant.inputBinding)
        : null,
      ...(Object.hasOwn(jobValue.grant, "executionSource")
        ? { executionSource: structuredClone(jobValue.grant.executionSource) }
        : {}),
      status: sessionStatus,
      workspaceRevision: REVISION_A,
      requiredProfiles: jobValue.grant.requiredProfiles.map(({ id }) => id),
      attempt: { number: attempt, status: sessionStatus },
      actions: [],
      error: null,
    };
  }

  async start(value) {
    this.calls.push({ method: "start", value: structuredClone(value) });
    this.events.push("executor.start");
    this.exists = true;
    return structuredClone(this.session);
  }

  async view(value) {
    this.calls.push({ method: "view", value: structuredClone(value) });
    if (!this.exists) {
      throw Object.assign(new Error("missing"), { code: "SESSION_NOT_FOUND" });
    }
    return structuredClone(this.session);
  }

  async resume(value) {
    this.calls.push({ method: "resume", value: structuredClone(value) });
    this.events.push("executor.resume");
    this.session.status = "active";
    this.session.attempt = {
      number: this.session.attempt.number + 1,
      status: "active",
    };
    return structuredClone(this.session);
  }

  async perform(value, { signal = null } = {}) {
    this.lastSignal = signal;
    this.calls.push({ method: "perform", value: structuredClone(value) });
    this.events.push("executor.perform");
    const action = value.action;
    let result;
    if (action.type === "list_files") result = ["src/app.js"];
    if (action.type === "read_text") {
      result = {
        path: action.path,
        content: "export const value = 1;\n",
        sha256: FILE_SHA,
        bytes: 24,
      };
    }
    if (action.type === "search_text") result = { matches: [], truncated: false };
    if (action.type === "write_text") {
      this.session.workspaceRevision = REVISION_B;
      result = {
        path: action.path,
        sha256: "e".repeat(64),
        bytes: Buffer.byteLength(action.content),
        beforeWorkspaceRevision: REVISION_A,
        workspaceRevision: REVISION_B,
      };
    }
    if (action.type === "run_profile") {
      result = {
        exitCode: 0,
        signal: null,
        durationMs: 10,
        imageId: `sha256:${"f".repeat(64)}`,
        profileFingerprint: PROFILE_DIGEST,
        timedOut: false,
        stdout: "ok",
        stderr: "",
      };
    }
    if (action.type === "complete") {
      this.session.status = "completed";
      this.session.attempt.status = "completed";
      result = {
        created: [],
        modified: [{
          path: "src/app.js",
          beforeSha256: FILE_SHA,
          afterSha256: "e".repeat(64),
        }],
        deleted: [],
      };
    }
    this.last = {
      session: structuredClone(this.session),
      action: {
        id: action.actionId,
        type: action.type,
        status: "succeeded",
        attemptNumber: this.session.attempt.number,
        workspaceRevisionBefore: action.expectedWorkspaceRevision,
        workspaceRevisionAfter: this.session.workspaceRevision,
        error: null,
      },
      result,
    };
    const existingIndex = this.session.actions.findIndex(
      ({ id }) => id === this.last.action.id,
    );
    if (existingIndex < 0) this.session.actions.push(structuredClone(this.last.action));
    else this.session.actions[existingIndex] = structuredClone(this.last.action);
    this.last.session = structuredClone(this.session);
    return structuredClone(this.last);
  }

  async getActionResult(value) {
    this.calls.push({ method: "getActionResult", value: structuredClone(value) });
    return structuredClone({ action: this.last.action, result: this.last.result });
  }

  async reconcileAction(value) {
    this.calls.push({ method: "reconcileAction", value: structuredClone(value) });
    const action = this.session.actions.find(
      ({ id }) => id === value.action.actionId,
    );
    if (!action) {
      return { status: "absent", session: structuredClone(this.session) };
    }
    if (action.status === "running") {
      return {
        status: "running",
        session: structuredClone(this.session),
        action: structuredClone(action),
      };
    }
    const result = value.action.type === "complete"
      ? {
          created: [],
          modified: [{
            path: "src/app.js",
            beforeSha256: FILE_SHA,
            afterSha256: "e".repeat(64),
          }],
          deleted: [],
        }
      : { error: action.error };
    return {
      status: "terminal",
      session: structuredClone(this.session),
      action: structuredClone(action),
      result,
    };
  }

  async reconcileCancellation(value) {
    this.calls.push({
      method: "reconcileCancellation",
      value: structuredClone(value),
    });
    const settledAt = "2026-08-01T00:00:03.000Z";
    if (!this.exists) {
      const proof = {
        schemaVersion: 1,
        kind: "controlled_execution_absent",
        sessionId: value.sessionId,
        cancellationDigest: value.cancellationDigest,
        sourceRevision: null,
        trustedWorkspaceRevision: null,
        actionResolution: null,
        sandboxCleanupConfirmed: true,
        discardedAttempts: [],
        settledAt,
      };
      return {
        status: "settled",
        session: null,
        proof: { ...proof, proofDigest: digestValue(proof) },
      };
    }
    if (this.session.actions.some(({ status }) => status === "running")) {
      throw Object.assign(new Error("controlled action is still running"), {
        code: "CANCELLATION_PENDING",
      });
    }
    const expected = value.expectedAction;
    const action = expected === null
      ? null
      : this.session.actions.find(({ id }) => id === expected.actionId);
    const actionResolution = expected === null
      ? null
      : {
          actionId: expected.actionId,
          actionDigest: expected.actionDigest,
          disposition: action === undefined
            ? "absent"
            : action.status === "succeeded"
              ? "audited_succeeded"
              : action.status === "failed"
                ? "audited_failed"
                : "discarded_unknown",
          workspaceRevisionBefore:
            action?.workspaceRevisionBefore ?? value.expectedWorkspaceRevision,
          workspaceRevisionAfter: action?.workspaceRevisionAfter ?? null,
        };
    this.session.status = "cancelled";
    this.session.attempt.status = "cancelled";
    this.session.cleanupPending = false;
    this.session.updatedAt = settledAt;
    const proof = {
      schemaVersion: 1,
      kind: "controlled_execution_cancelled",
      sessionId: value.sessionId,
      cancellationDigest: value.cancellationDigest,
      sourceRevision: REVISION_A,
      trustedWorkspaceRevision: this.session.workspaceRevision,
      actionResolution,
      sandboxCleanupConfirmed: true,
      discardedAttempts: Array.from(
        { length: this.session.attempt.number },
        (_, index) => ({
          attemptNumber: index + 1,
          executionId: `attempt-${index + 1}`,
          disposition: "discarded",
        }),
      ),
      settledAt,
    };
    return {
      status: "settled",
      session: structuredClone(this.session),
      proof: { ...proof, proofDigest: digestValue(proof) },
    };
  }
}

function brain(responses, calls = []) {
  return {
    calls,
    async decide(value) {
      calls.push(structuredClone(value));
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return {
        schemaVersion: 1,
        confidence: 90,
        summary: "Proceed safely.",
        reason: "The observation supports this action.",
        action: structuredClone(next),
      };
    },
  };
}

function verifier(events, error = null) {
  return {
    async verify(value) {
      events.push("verify");
      if (error) throw error;
      return structuredClone(value);
    },
  };
}

test("a queued job is started and one semantic action is durably executed", async () => {
  const events = [];
  const initial = job();
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }], brainCalls),
    grantVerifier: verifier(events),
    actionAdmissionGate: {
      async run(operation) {
        events.push("admission-gate-enter");
        const result = await operation();
        events.push("admission-gate-exit");
        return result;
      },
    },
  });

  const result = await worker.runCycle({ limit: 1, roleId: "developer" });

  assert.equal(result.processed, 1);
  assert.equal(result.outcomes[0].actionType, "read_text");
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(stored.status, "active");
  assert.equal(stored.execution.turn, 1);
  assert.equal(stored.execution.pendingAction, null);
  const performed = executor.calls.find(({ method }) => method === "perform").value.action;
  assert.match(performed.actionId, /^action-[a-f0-9]{55}$/);
  assert.equal(performed.expectedWorkspaceRevision, REVISION_A);
  const startIndex = events.indexOf("executor.start");
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "start").value,
    {
      sessionId: initial.jobId,
      workspaceId: initial.grant.workspaceId,
      requestedBy: initial.grant.requestedBy,
      inputBinding: null,
    },
  );
  const startAdmissionEnter = events.lastIndexOf(
    "admission-gate-enter",
    startIndex,
  );
  const startAdmissionExit = events.indexOf(
    "admission-gate-exit",
    startIndex,
  );
  assert.deepEqual(
    events.slice(startAdmissionEnter, startAdmissionExit + 1),
    [
      "admission-gate-enter",
      "verify",
      "executor.start",
      "admission-gate-exit",
    ],
  );
  const actionIndex = events.indexOf("admit");
  const actionAdmissionEnter = events.lastIndexOf(
    "admission-gate-enter",
    actionIndex,
  );
  const actionAdmissionExit = events.indexOf(
    "admission-gate-exit",
    actionIndex,
  );
  assert.equal(events[actionIndex - 1], "verify");
  assert.deepEqual(
    events.slice(actionAdmissionEnter, actionAdmissionExit + 1),
    ["admission-gate-enter", "verify", "admit", "admission-gate-exit"],
  );
  assert.equal(
    events[events.indexOf("executor.perform") - 1],
    "admission-gate-exit",
  );
  assert.deepEqual(Object.keys(brainCalls[0]), [
    "roleId",
    "task",
    "capabilities",
    "turn",
    "observations",
  ]);
  assert.equal(JSON.stringify(brainCalls[0]).includes("workspaceRevision"), false);
});

test("worker keeps every code turn for one Issue in the same brain session", async () => {
  const initial = job({
    grant: grant({
      subject: { number: 17 },
      inputBinding: null,
    }),
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }], brainCalls),
    grantVerifier: verifier([]),
  });

  await worker.runCycle({ limit: 1, roleId: "developer" });

  assert.equal(
    brainCalls[0].sessionKey,
    "github:issue:acme/dashboard#17",
  );
});

test("worker forwards an exact PR input binding when starting a session", async () => {
  const inputBinding = pullRequestInputBinding();
  const initial = job({ grant: grant({ inputBinding }) });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier([]),
  });

  await worker.runCycle({ limit: 1, roleId: "developer" });

  assert.deepEqual(
    executor.calls.find(({ method }) => method === "start").value.inputBinding,
    inputBinding,
  );
});

test("worker forwards the complete sealed conflict source when starting a session", async () => {
  const inputBinding = conflictInputBinding();
  const executionSource = conflictExecutionSource(inputBinding);
  const initial = job({
    grant: grant({
      schemaVersion: 3,
      inputBinding,
      executionSource,
      writablePaths: ["src/app.js"],
    }),
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier([]),
  });

  await worker.runCycle({ limit: 1, roleId: "developer" });

  const started = executor.calls.find(({ method }) => method === "start").value;
  assert.deepEqual(started.inputBinding, inputBinding);
  assert.deepEqual(started.executionSource, executionSource);
});

test("session input binding tampering fences before brain or executor actions", async (t) => {
  const cases = [
    ["missing", (session) => delete session.inputBinding],
    ["repository", (session) => {
      session.inputBinding.repository = "acme/other";
    }],
    ["pull request", (session) => {
      session.inputBinding.pullRequestNumber += 1;
    }],
    ["Head", (session) => {
      session.inputBinding.headRefOid = "4".repeat(40);
    }],
    ["event", (session) => {
      session.inputBinding.eventId = "pull-request-event-foreign";
    }],
  ];

  for (const [name, tamper] of cases) {
    await t.test(name, async () => {
      const inputBinding = pullRequestInputBinding();
      const initial = job({
        grant: grant({ inputBinding }),
        status: "active",
        revision: 3,
        execution: {
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          turn: 0,
          pendingAction: null,
          actionAdmission: null,
          observations: [],
          result: null,
          pause: null,
          uncertainty: null,
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      tamper(executor.session);
      const brainCalls = [];
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain(
          [{ type: "read_text", path: "src/app.js" }],
          brainCalls,
        ),
        grantVerifier: verifier([]),
      });

      const result = await worker.runCycle({ limit: 1, roleId: "developer" });

      assert.equal(result.outcomes[0].status, "fenced");
      assert.equal(
        result.outcomes[0].code,
        "CODE_JOB_SESSION_BINDING_INVALID",
      );
      assert.equal(brainCalls.length, 0);
      assert.equal(
        executor.calls.some(({ method }) => method === "perform"),
        false,
      );
    });
  }
});

test("session conflict-source tampering fences before brain or executor actions", async (t) => {
  const cases = [
    ["missing", (session) => delete session.executionSource],
    ["added field", (session) => {
      session.executionSource = {
        ...session.executionSource,
        forged: true,
      };
    }],
    ["preparation", (session) => {
      session.executionSource.preparationBinding.preparationId = "f".repeat(64);
    }],
    ["write scope", (session) => {
      session.executionSource.writeScope.paths = ["src/other.js"];
    }],
  ];

  for (const [name, tamper] of cases) {
    await t.test(name, async () => {
      const inputBinding = conflictInputBinding();
      const executionSource = conflictExecutionSource(inputBinding);
      const initial = job({
        grant: grant({
          schemaVersion: 3,
          inputBinding,
          executionSource,
          writablePaths: ["src/app.js"],
        }),
        status: "active",
        revision: 3,
        execution: {
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          turn: 0,
          pendingAction: null,
          actionAdmission: null,
          observations: [],
          result: null,
          pause: null,
          uncertainty: null,
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      tamper(executor.session);
      const brainCalls = [];
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain(
          [{ type: "read_text", path: "src/app.js" }],
          brainCalls,
        ),
        grantVerifier: verifier([]),
      });

      const result = await worker.runCycle({ limit: 1, roleId: "developer" });

      assert.equal(result.outcomes[0].status, "fenced");
      assert.equal(
        result.outcomes[0].code,
        "CODE_JOB_SESSION_BINDING_INVALID",
      );
      assert.equal(brainCalls.length, 0);
      assert.equal(
        executor.calls.some(({ method }) => method === "perform"),
        false,
      );
    });
  }
});

test("failed, running, and absent executor results cannot bypass the PR Head fence", async (t) => {
  const inputBinding = pullRequestInputBinding();

  await t.test("failed session", async () => {
    const initial = job({
      grant: grant({ inputBinding }),
      status: "active",
      revision: 3,
      execution: {
        ...job().execution,
        sessionId: job().jobId,
        workspaceRevision: REVISION_A,
      },
    });
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial, [], { sessionStatus: "failed" });
    executor.session.inputBinding.headRefOid = "4".repeat(40);
    executor.session.error = { code: "FAILED", message: "wrong Head" };
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([]),
      grantVerifier: verifier([]),
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(result.outcomes[0].code, "CODE_JOB_SESSION_BINDING_INVALID");
  });

  for (const status of ["running", "absent"]) {
    await t.test(`${status} reconciliation`, async () => {
      const action = {
        type: "read_text",
        actionId: `head-fence-${status}`,
        expectedWorkspaceRevision: REVISION_A,
        path: "src/app.js",
      };
      const actionDigest = digestValue(action);
      const initial = job({
        grant: grant({ inputBinding }),
        status: "unknown",
        revision: 7,
        execution: {
          ...job().execution,
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          pendingAction: {
            turn: 1,
            actionId: action.actionId,
            actionDigest,
            action,
            preparedAt: "2026-08-01T00:00:01.000Z",
          },
          actionAdmission: {
            actionId: action.actionId,
            actionDigest,
            epoch: 6,
            admittedAt: "2026-08-01T00:00:01.500Z",
          },
          uncertainty: {
            from: "active",
            code: "AUDIT_BACKEND_UNAVAILABLE",
            at: "2026-08-01T00:00:02.000Z",
          },
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      executor.session.inputBinding.headRefOid = "5".repeat(40);
      if (status === "running") {
        executor.session.actions.push({
          id: action.actionId,
          type: action.type,
          status: "running",
          attemptNumber: 1,
          workspaceRevisionBefore: REVISION_A,
          workspaceRevisionAfter: null,
          error: null,
        });
      }
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain([]),
        grantVerifier: verifier([]),
      });

      const result = await worker.runCycle();

      assert.equal(result.outcomes[0].status, "unknown");
      assert.equal(
        result.outcomes[0].code,
        "CODE_JOB_SESSION_BINDING_INVALID",
      );
      assert.notEqual(
        (await store.getForWorker(initial.jobId)).execution.actionAdmission,
        null,
      );
      assert.equal(
        executor.calls.some(({ method }) => method === "perform"),
        false,
      );
    });
  }
});

test("start and resume responses cannot change the sealed input binding", async (t) => {
  const inputBinding = pullRequestInputBinding();

  await t.test("start omits binding", async () => {
    const initial = job({ grant: grant({ inputBinding }) });
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial);
    delete executor.session.inputBinding;
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(
      result.outcomes[0].code,
      "CODE_JOB_SESSION_BINDING_INVALID",
    );
    assert.equal(brainCalls.length, 0);
    assert.equal(
      executor.calls.some(({ method }) => method === "perform"),
      false,
    );
  });

  await t.test("resume changes Head", async () => {
    const initial = job({
      grant: grant({ inputBinding }),
      status: "starting",
      revision: 2,
      execution: {
        sessionId: job().jobId,
        workspaceRevision: null,
        turn: 0,
        pendingAction: null,
        actionAdmission: null,
        observations: [],
        result: null,
        pause: null,
        uncertainty: null,
      },
    });
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial, [], {
      sessionStatus: "interrupted",
    });
    executor.exists = true;
    const resume = executor.resume.bind(executor);
    executor.resume = async (value) => {
      const session = await resume(value);
      session.inputBinding.headRefOid = "5".repeat(40);
      return session;
    };
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(
      result.outcomes[0].code,
      "CODE_JOB_SESSION_BINDING_INVALID",
    );
    assert.equal(brainCalls.length, 0);
    assert.equal(
      executor.calls.some(({ method }) => method === "perform"),
      false,
    );
  });
});

test("durable admission is the authorization cutover for one immutable action", async () => {
  const events = [];
  const initial = job();
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  let revoked = false;
  store.afterAdmit = async () => {
    revoked = true;
  };
  const grantVerifier = {
    async verify(value) {
      events.push("verify");
      if (revoked) {
        throw Object.assign(new Error("authority changed after admission"), {
          code: "INVALID_CODE_JOB_AUTHORITY",
        });
      }
      return structuredClone(value);
    },
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain(
      [{ type: "read_text", path: "src/app.js" }],
      brainCalls,
    ),
    grantVerifier,
  });

  const admittedCycle = await worker.runCycle({ limit: 1 });
  const performCount = executor.calls.filter(
    ({ method }) => method === "perform",
  ).length;
  const fencedCycle = await worker.runCycle({ limit: 1 });

  assert.equal(admittedCycle.outcomes[0].actionType, "read_text");
  assert.equal(performCount, 1);
  assert.equal(fencedCycle.outcomes[0].status, "fenced");
  assert.equal(fencedCycle.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
  assert.equal(
    executor.calls.filter(({ method }) => method === "perform").length,
    1,
  );
  assert.equal(brainCalls.length, 1);
});

test("configuration activation and action admission resolve revocation races", async (t) => {
  function preparedJob(actionId) {
    const action = {
      type: "list_files",
      actionId,
      expectedWorkspaceRevision: REVISION_A,
      path: "",
    };
    return job({
      status: "active",
      revision: 3,
      execution: {
        sessionId: job().jobId,
        workspaceRevision: REVISION_A,
        turn: 0,
        pendingAction: {
          turn: 1,
          actionId,
          actionDigest: digestValue(action),
          action,
          preparedAt: "2026-08-01T00:00:01.000Z",
        },
        actionAdmission: null,
        observations: [],
        result: null,
        pause: null,
      },
    });
  }

  function activeVerifier(activeVersion, events) {
    return {
      async verify(value) {
        events.push(`verify-v${activeVersion()}`);
        if (activeVersion() !== 1) {
          throw Object.assign(new Error("configuration authority changed"), {
            code: "INVALID_CODE_JOB_AUTHORITY",
          });
        }
        return structuredClone(value);
      },
    };
  }

  await t.test("activation first fences the waiting action", async () => {
    const gate = new ActionAdmissionGate();
    gate.bindEffective({
      version: 1,
      configurationDigest: "1".repeat(64),
    });
    const activationEntered = deferred();
    const releaseActivation = deferred();
    let activeVersion = 1;
    const activation = gate.run(async () => {
      activationEntered.resolve();
      await releaseActivation.promise;
      activeVersion = 2;
    });
    await activationEntered.promise;

    const events = [];
    const initial = preparedJob("activation-first-action");
    const store = new FakeJobStore([initial], events);
    const executor = new FakeExecutor(initial, events);
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([]),
      grantVerifier: activeVerifier(() => activeVersion, events),
      actionAdmissionGate: gate,
    });
    const cycle = worker.runCycle();

    await Promise.resolve();
    assert.equal(events.includes("admit"), false);
    releaseActivation.resolve();
    await activation;
    const result = await cycle;

    assert.equal(result.outcomes[0].status, "fenced");
    assert.equal(result.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
    assert.equal(events.includes("admit"), false);
    assert.equal(events.includes("executor.perform"), false);
  });

  await t.test("admission first preserves only its immutable action", async () => {
    const gate = new ActionAdmissionGate();
    gate.bindEffective({
      version: 1,
      configurationDigest: "1".repeat(64),
    });
    let activeVersion = 1;
    const events = [];
    const initial = preparedJob("admission-first-action");
    const store = new FakeJobStore([initial], events);
    const executor = new FakeExecutor(initial, events);
    const admissionPersisted = deferred();
    const releaseAdmission = deferred();
    store.afterAdmit = async () => {
      admissionPersisted.resolve();
      await releaseAdmission.promise;
    };
    const performEntered = deferred();
    const releasePerform = deferred();
    const perform = executor.perform.bind(executor);
    executor.perform = async (...args) => {
      performEntered.resolve();
      await releasePerform.promise;
      return perform(...args);
    };
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([]),
      grantVerifier: activeVerifier(() => activeVersion, events),
      actionAdmissionGate: gate,
    });
    const cycle = worker.runCycle();
    await admissionPersisted.promise;
    const activation = gate.run(() => {
      activeVersion = 2;
    });

    await Promise.resolve();
    assert.equal(activeVersion, 1);
    releaseAdmission.resolve();
    await performEntered.promise;
    await activation;
    assert.equal(activeVersion, 2);
    releasePerform.resolve();
    const first = await cycle;
    const second = await worker.runCycle();

    assert.equal(first.outcomes[0].actionType, "list_files");
    assert.equal(second.outcomes[0].status, "fenced");
    assert.equal(
      executor.calls.filter(({ method }) => method === "perform").length,
      1,
    );
  });
});

test("pause during admitted session start waits for start reconciliation", async () => {
  const events = [];
  const initial = job();
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const entered = deferred();
  const release = deferred();
  const start = executor.start.bind(executor);
  executor.start = async (value) => {
    entered.resolve();
    await release.promise;
    return start(value);
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier(events),
  });

  const cycle = worker.runCycle();
  await entered.promise;
  const starting = await store.getForWorker(initial.jobId);
  const pausing = await store.pause({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "pause session start",
  });
  release.resolve();
  const result = await cycle;
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(pausing.job.status, "pausing");
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.pause.from, "active");
  assert.equal(stored.execution.workspaceRevision, REVISION_A);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
});

test("write actions receive only a trusted current-revision file hash", async () => {
  const readAction = {
    type: "read_text",
    actionId: "read-current",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  };
  const readObservation = observation(readAction, {
    result: {
      path: "src/app.js",
      content: "old",
      sha256: FILE_SHA,
      bytes: 3,
      truncated: false,
    },
  });
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      observations: [readObservation],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([
      { type: "write_text", path: "src/app.js", content: "new" },
    ], brainCalls),
    grantVerifier: verifier(events),
  });

  await worker.runCycle();

  const action = executor.calls.find(({ method }) => method === "perform").value.action;
  assert.equal(action.expectedSha256, FILE_SHA);
  assert.equal(action.expectedWorkspaceRevision, REVISION_A);
  const modelContext = JSON.stringify(brainCalls[0]);
  for (const forbidden of [FILE_SHA, "actionId", "profileId", "workspaceRevision"]) {
    assert.equal(modelContext.includes(forbidden), false);
  }
});

function trustedRead(content, { id = "read-current", truncated = false } = {}) {
  return observation({
    type: "read_text",
    actionId: id,
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  }, { result: {
    path: "src/app.js", content, sha256: FILE_SHA,
    bytes: Buffer.byteLength(content), truncated,
  } });
}

test("read observations report every content truncation to the model", async (t) => {
  for (const content of ["x".repeat(30 * 1024), "字".repeat(10 * 1024)]) {
    await t.test(`UTF-8 bytes ${Buffer.byteLength(content)}`, () => {
      const rendered = JSON.parse(modelObservation(trustedRead(content)).detail);
      assert.equal(rendered.truncated, true);
      assert.ok(Buffer.byteLength(rendered.content) <= 24 * 1024);
      assert.equal(rendered.content.includes("\uFFFD"), false);
    });
  }
  const read = trustedRead("prefix", { truncated: true });
  const detail = observationDetail(read.action, {
    session: { status: "active", attempt: { number: 1 } },
    action: { status: "succeeded", attemptNumber: 1 },
  }, read.detail.result);
  assert.equal(detail.result.truncated, true);
});

test("whole-file writes pause when the latest trusted read is not fully visible", async (t) => {
  const large = "x".repeat(30 * 1024);
  const unrelated = observation({
    type: "list_files", path: "", actionId: "list-later",
    expectedWorkspaceRevision: REVISION_A,
  }, { result: { files: ["src/app.js"] } });
  const cases = [
    { name: "30 KiB read", observations: [trustedRead(large)] },
    { name: "UTF-8 read", observations: [trustedRead("字".repeat(10 * 1024))] },
    { name: "executor truncated read", observations: [trustedRead("prefix", { truncated: true })] },
    { name: "escaped JSON exceeds detail limit", observations: [trustedRead("\"".repeat(20 * 1024))] },
    { name: "latest incomplete read shadows complete read", observations: [trustedRead("old", { id: "older-read" }), trustedRead(large)] },
    { name: "observation history omitted", observations: [trustedRead("old"), unrelated], observationLimit: 1 },
    { name: "packer summarizes read", observations: [trustedRead("old"), ...Array.from({ length: 6 }, (_, i) => observation({
      type: "read_text", path: `test/other-${i}.js`, actionId: `other-${i}`,
      expectedWorkspaceRevision: REVISION_A,
    }, { result: { content: "x".repeat(24 * 1024), truncated: false } }))] },
    { name: "packer omits all observations", observations: [trustedRead("old")], fillFixedContext: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const initial = job({ status: "active", execution: {
        ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
        turn: scenario.observations.length, observations: scenario.observations,
      } });
      if (scenario.fillFixedContext) {
        const fixed = {
          task: {
            operation: initial.grant.operation, repository: initial.grant.repository,
            objective: "", acceptanceCriteria: initial.grant.acceptanceCriteria,
            evidence: initial.grant.evidence,
          },
          capabilities: {
            allowedActions: initial.grant.allowedActions, writablePaths: initial.grant.writablePaths,
            requiredProfilesRemaining: 1,
          },
          turn: initial.execution.turn + 1, observations: [],
        };
        initial.grant.objective = "x".repeat(128 * 1024 - Buffer.byteLength(JSON.stringify(fixed)) - 10);
      }
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      const calls = [];
      const worker = new CodeJobWorkerService({
        jobStore: store, executor, grantVerifier: verifier([]),
        brainDirectory: brain([{ type: "write_text", path: "src/app.js", content: "replacement" }], calls),
        ...(scenario.observationLimit ? { observationLimit: scenario.observationLimit } : {}),
      });
      const result = await worker.runCycle();
      assert.equal(result.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
      assert.equal(result.outcomes[0].status, "paused");
      assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
      const stored = await store.getForWorker(initial.jobId);
      assert.match(stored.execution.pause.reason, /src\/app\.js/);
      assert.equal(stored.execution.pause.reason.includes("replacement"), false);
    });
  }
});

test("absent legacy prepared overwrite requires a fully visible trusted read", async () => {
  const action = {
    type: "write_text", path: "src/app.js", content: "replacement",
    actionId: "legacy-overwrite", expectedWorkspaceRevision: REVISION_A,
    expectedSha256: FILE_SHA,
  };
  const initial = job({ status: "active", execution: {
    ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
    turn: 1, observations: [trustedRead("x".repeat(30 * 1024))],
    pendingAction: {
      turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action,
      preparedAt: "2026-08-01T00:00:01.000Z",
    },
  } });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({
    jobStore: store, executor, grantVerifier: verifier([]), brainDirectory: brain([]),
  });
  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.deepEqual(executor.calls.find(({ method }) => method === "reconcileAction").value.action, action);
  assert.deepEqual((await store.getForWorker(initial.jobId)).execution.pendingAction.action, action);
});

test("admitted legacy overwrite pauses after absent reconciliation without performing", async () => {
  const action = {
    type: "write_text", path: "src/app.js", content: "replacement",
    actionId: "admitted-legacy-overwrite", expectedWorkspaceRevision: REVISION_A,
    expectedSha256: FILE_SHA,
  };
  const initial = job({ status: "active", execution: {
    ...job().execution, sessionId: job().jobId, workspaceRevision: REVISION_A,
    turn: 1, observations: [trustedRead("x".repeat(30 * 1024))],
    pendingAction: { turn: 2, actionId: action.actionId, actionDigest: digestValue(action), action, preparedAt: "2026-08-01T00:00:01.000Z" },
    actionAdmission: { actionId: action.actionId, actionDigest: digestValue(action), epoch: 2, admittedAt: "2026-08-01T00:00:01.500Z" },
  } });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const worker = new CodeJobWorkerService({ jobStore: store, executor, grantVerifier: verifier([]), brainDirectory: brain([]) });
  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].code, "CODE_BRAIN_INCOMPLETE_READ");
  // Existing recovery first reconciles the durable admission, then pauses.
  await worker.runCycle();
  await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.actionAdmission, null);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.deepEqual(stored.execution.pendingAction.action, action);
});

test("a prepared action is retried exactly without asking the brain again", async () => {
  const pendingAction = {
    type: "list_files",
    actionId: "action-prepared",
    expectedWorkspaceRevision: REVISION_A,
    path: "",
  };
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: pendingAction.actionId,
        actionDigest: digestValue(pendingAction),
        action: pendingAction,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
  });

  await worker.runCycle();

  assert.equal(brainCalls.length, 0);
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "perform").value.action,
    pendingAction,
  );
  assert.equal(events[events.indexOf("admit") - 1], "verify");
  assert.equal(events[events.indexOf("executor.perform") - 1], "admit");
});

test("a non-admitted prepared action fences once when executor authority changed", async () => {
  const action = {
    type: "list_files",
    actionId: "action-prepared-fenced",
    expectedWorkspaceRevision: REVISION_A,
    path: "",
  };
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.reconcileAction = async () => {
    throw Object.assign(new Error("profile authority changed"), {
      code: "PROFILE_CONFIG_CHANGED",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "fenced");
  assert.equal(first.outcomes[0].code, "PROFILE_CONFIG_CHANGED");
  assert.equal(second.selected, 0);
  assert.equal((await store.getForWorker(initial.jobId)).status, "fenced");
});

test("revoked authority blocks reconciliation of a newly prepared action", async () => {
  const action = {
    type: "list_files",
    actionId: "action-prepared-revoked",
    expectedWorkspaceRevision: REVISION_A,
    path: "",
  };
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest: digestValue(action),
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const revoked = Object.assign(new Error("authority revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([], revoked),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.equal(result.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
  assert.deepEqual(executor.calls, []);
});

test("pause winning before action admission prevents executor perform", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  store.beforeAdmit = async () => {
    const current = await store.getForWorker(initial.jobId);
    await store.pause({
      jobId: current.jobId,
      expectedRevision: current.revision,
      reason: "pause won admission",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier(events),
  });

  const result = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.actionAdmission, null);
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
});

test("pause during an admitted action stays pausing until result reconciliation", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const entered = deferred();
  const release = deferred();
  const perform = executor.perform.bind(executor);
  executor.perform = async (value) => {
    entered.resolve();
    await release.promise;
    return perform(value);
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier(events),
  });

  const cycle = worker.runCycle();
  await entered.promise;
  const admitted = await store.getForWorker(initial.jobId);
  const pausing = await store.pause({
    jobId: admitted.jobId,
    expectedRevision: admitted.revision,
    reason: "pause in flight",
  });
  release.resolve();
  const result = await cycle;
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(pausing.job.status, "pausing");
  assert.equal(result.outcomes[0].status, "paused");
  assert.equal(stored.status, "paused");
  assert.equal(stored.execution.turn, 1);
  assert.equal(stored.execution.pendingAction, null);
  assert.equal(stored.execution.actionAdmission, null);
});

test("the real job store and worker preserve an in-flight pause across durable CAS", async () => {
  const jobs = new CodeJobStore({
    store: new IntegrationMemoryStore(),
    exclusiveLease: { run: (operation) => operation() },
    operationQueue: new OperationQueue(),
    clock: () => new Date("2026-08-02T08:00:00.000Z"),
    memoryReceiptVerifier: {
      async verify(value) {
        return { ...structuredClone(value), persisted: true };
      },
    },
  });
  await jobs.recover();
  const sealedGrant = createCodeJobGrant({
    proposalId: "integration-pause-proposal",
    contentDigest: "1".repeat(64),
    policyVersion: 1,
    requestedBy: { roleId: "developer", workItemId: "integration-work" },
    source: { assignmentId: "integration-assignment", eventId: "integration-event" },
    subject: {
      id: "github:acme/dashboard:pull-request:9",
      repository: "acme/dashboard",
      number: 9,
    },
    repository: "acme/dashboard",
    workspaceId: "dashboard",
    workspaceAuthorityDigest: "2".repeat(64),
    operation: "inspect",
    objective: "Inspect one file without losing an in-flight pause.",
    acceptanceCriteria: ["The admitted action is reconciled before pausing."],
    evidence: ["A pause can race an executor response."],
    summary: "Prove the durable pause boundary.",
    reason: "The worker and store need one integrated safety proof.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect],
    writablePaths: [],
    requiredProfiles: [{ id: "node-tests", configDigest: PROFILE_DIGEST }],
    brainDigest: "3".repeat(64),
  });
  const created = await jobs.createApprovedJob({
    confirmationId: "confirmation-integration-pause",
    requestId: "request-integration-pause",
    displayedPayloadDigest: "4".repeat(64),
    approvalBindingDigest: "5".repeat(64),
    grant: sealedGrant,
  });
  const durableJob = await jobs.getForWorker(created.job.jobId);
  const executor = new FakeExecutor(durableJob);
  const entered = deferred();
  const release = deferred();
  const perform = executor.perform.bind(executor);
  executor.perform = async (value) => {
    entered.resolve();
    await release.promise;
    return perform(value);
  };
  const worker = new CodeJobWorkerService({
    jobStore: jobs,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: { verify: async (value) => structuredClone(value) },
  });

  const cycle = worker.runCycle();
  await entered.promise;
  const admitted = await jobs.getForWorker(created.job.jobId);
  const pausing = await jobs.pause({
    jobId: admitted.jobId,
    expectedRevision: admitted.revision,
    reason: "用户要求暂停正在执行的任务",
  });
  release.resolve();
  const outcome = await cycle;
  const paused = await jobs.getForWorker(created.job.jobId);

  assert.equal(pausing.job.status, "pausing");
  assert.equal(outcome.outcomes[0].status, "paused");
  assert.equal(paused.status, "paused");
  assert.equal(paused.execution.turn, 1);
  assert.equal(paused.execution.pendingAction, null);
  assert.equal(paused.execution.actionAdmission, null);
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
});

test("interrupted action results retain admission until trusted reconciliation", async (t) => {
  for (const pauseDuringAction of [false, true]) {
    await t.test(
      pauseDuringAction ? "pausing origin" : "active origin",
      async () => {
        const inputBinding = pullRequestInputBinding();
        const initial = job({
          grant: grant({ inputBinding }),
          status: "active",
          revision: 3,
          execution: {
            sessionId: job().jobId,
            workspaceRevision: REVISION_A,
            turn: 0,
            pendingAction: null,
            actionAdmission: null,
            observations: [],
            result: null,
            pause: null,
            uncertainty: null,
          },
        });
        const store = new FakeJobStore([initial]);
        const executor = new FakeExecutor(initial);
        const perform = executor.perform.bind(executor);
        executor.perform = async (value) => {
          const response = await perform(value);
          if (pauseDuringAction) {
            const current = await store.getForWorker(initial.jobId);
            await store.pause({
              jobId: current.jobId,
              expectedRevision: current.revision,
              reason: "用户要求动作后暂停",
            });
          }
          response.action.status = "interrupted";
          response.action.error = {
            code: "RESULT_UNKNOWN",
            message: "Action result could not be proven",
          };
          response.action.workspaceRevisionAfter = null;
          executor.session.status = "interrupted";
          executor.session.attempt.status = "interrupted";
          executor.session.workspaceRevision = REVISION_A;
          const storedAction = executor.session.actions.find(
            ({ id }) => id === response.action.id,
          );
          storedAction.status = "interrupted";
          storedAction.workspaceRevisionAfter = null;
          storedAction.error = structuredClone(response.action.error);
          response.session = structuredClone(executor.session);
          response.result = { error: structuredClone(response.action.error) };
          return response;
        };
        const brainCalls = [];
        const worker = new CodeJobWorkerService({
          jobStore: store,
          executor,
          brainDirectory: brain(
            [{ type: "write_text", path: "src/app.js", content: "changed\n" }],
            brainCalls,
          ),
          grantVerifier: verifier([]),
        });

        const uncertainCycle = await worker.runCycle();
        const unknown = await store.getForWorker(initial.jobId);

        assert.equal(uncertainCycle.outcomes[0].status, "unknown");
        assert.equal(uncertainCycle.outcomes[0].code, "RESULT_UNKNOWN");
        assert.equal(unknown.status, "unknown");
        assert.notEqual(unknown.execution.pendingAction, null);
        assert.notEqual(unknown.execution.actionAdmission, null);
        assert.equal(unknown.execution.observations.length, 0);
        assert.equal(
          unknown.execution.uncertainty.from,
          pauseDuringAction ? "pausing" : "active",
        );
        assert.equal(unknown.execution.uncertainty.code, "RESULT_UNKNOWN");
        assert.equal(
          unknown.execution.pause?.reason ?? null,
          pauseDuringAction ? "用户要求动作后暂停" : null,
        );

        const reconciledCycle = await worker.runCycle();
        const reconciled = await store.getForWorker(initial.jobId);
        assert.equal(
          reconciledCycle.outcomes[0].status,
          pauseDuringAction ? "paused" : "active",
        );
        assert.equal(
          reconciled.status,
          pauseDuringAction ? "paused" : "active",
        );
        assert.equal(reconciled.execution.pendingAction, null);
        assert.equal(reconciled.execution.actionAdmission, null);
        assert.equal(reconciled.execution.uncertainty, null);
        assert.equal(
          executor.calls.filter(({ method }) => method === "perform").length,
          1,
        );
        assert.equal(
          executor.calls.filter(({ method }) => method === "resume").length,
          1,
        );
        assert.deepEqual(
          executor.calls.find(({ method }) => method === "resume").value,
          { sessionId: initial.jobId, inputBinding },
        );
        assert.equal(brainCalls.length, 1);
      },
    );
  }
});

test("interrupted recovery converges after a lost resume acknowledgement", async () => {
  const action = {
    type: "write_text",
    actionId: "write-with-lost-resume-ack",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
    content: "changed\n",
    expectedSha256: FILE_SHA,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "unknown",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 7,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: {
        from: "active",
        code: "RESULT_UNKNOWN",
        message: "受控动作结果无法确认，必须先与执行器对账",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.session.actions = [{
    id: action.actionId,
    type: action.type,
    status: "interrupted",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: { code: "RESULT_UNKNOWN", message: "Result unknown" },
  }];
  const resume = executor.resume.bind(executor);
  const actionAdmissionGate = readyActionAdmissionGate();
  await activateNextConfiguration(actionAdmissionGate);
  let loseAcknowledgement = true;
  executor.resume = async (value) => {
    const session = await resume(value);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw Object.assign(new Error("resume acknowledgement lost"), {
        code: "STATE_WRITE_FAILED",
      });
    }
    return session;
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
    actionAdmissionGate,
  });

  const lostAckCycle = await worker.runCycle();
  const recoveredCycle = await worker.runCycle();
  const recovered = await store.getForWorker(initial.jobId);

  assert.equal(lostAckCycle.outcomes[0].status, "unknown");
  assert.equal(recoveredCycle.outcomes[0].status, "active");
  assert.equal(recovered.status, "active");
  assert.equal(recovered.execution.pendingAction, null);
  assert.equal(recovered.execution.actionAdmission, null);
  assert.equal(recovered.execution.uncertainty, null);
  assert.equal(
    executor.calls.filter(({ method }) => method === "resume").length,
    1,
  );
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "resume").value,
    { sessionId: initial.jobId, inputBinding: null },
  );
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
  assert.equal(actionAdmissionGate.readStatus().mode, "restart_required");
});

test("the host selects fixed profiles and completes only after current-attempt proof", async () => {
  const profileAction = {
    type: "run_profile",
    actionId: "profile-current",
    expectedWorkspaceRevision: REVISION_A,
    profileId: "node-tests",
  };
  const profileObservation = observation(profileAction, {
    result: { exitCode: 0, stdout: "ok", stderr: "" },
  });
  const initial = job({
    grant: grant({ schemaVersion: 2, inputBinding: null }),
    status: "active",
    revision: 5,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      observations: [profileObservation],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([
      { type: "complete", outcome: "fixed", evidence: ["tests"] },
    ], brainCalls),
    grantVerifier: verifier(events),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(brainCalls[0].capabilities.requiredProfilesRemaining, 0);
  assert.equal(result.outcomes[0].status, "completed");
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(stored.status, "completed");
  assert.equal(stored.execution.result.detail.manifest.modified[0].path, "src/app.js");
  assert.equal(store.completionRequests.length, 1);
  assert.equal(store.completionRequests[0].changePackageDelivery, true);
});

test("a changed PR Head fences the job before brain or executor access", async () => {
  const inputBinding = {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/dashboard",
    pullRequestNumber: 17,
    rootItemId: "work-root-17",
    workKey: `pr-work-${"2".repeat(64)}`,
    inputRevision: 1,
    headRevision: 1,
    headRefOid: "a".repeat(40),
    eventId: "event-17",
    eventDigest: "3".repeat(64),
    inputDigest: "4".repeat(64),
  };
  const initial = job({ grant: grant({ inputBinding }) });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const currentHead = "b".repeat(40);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify(value) {
        events.push("verify");
        if (value.inputBinding.headRefOid !== currentHead) {
          throw Object.assign(new Error("PR Head changed"), {
            code: "INVALID_CODE_JOB_AUTHORITY",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.equal(
    executor.calls.some(({ method }) =>
      ["start", "view", "resume", "perform", "reconcileAction"].includes(method),
    ),
    false,
  );
  assert.equal(brainCalls.length, 0);
});

test("revoked active authority fences before session context reaches the worker", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const authorityError = Object.assign(new Error("revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events, authorityError),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.deepEqual(executor.calls, []);
  assert.equal(brainCalls.length, 0);
});

test("an already-completed executor action is reconciled after authority revocation", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-before-revocation",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    status: "active",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: {
        turn: 2,
        actionId: completeAction.actionId,
        actionDigest: digestValue(completeAction),
        action: completeAction,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: completeAction.actionId,
        actionDigest: digestValue(completeAction),
        epoch: 7,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [observation({
        type: "run_profile",
        actionId: "profile-before-complete",
        expectedWorkspaceRevision: REVISION_A,
        profileId: "node-tests",
      })],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  executor.session.status = "completed";
  executor.session.attempt.status = "completed";
  executor.session.actions = [{
    id: completeAction.actionId,
    type: "complete",
    status: "succeeded",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: REVISION_A,
    error: null,
  }];
  const authorityError = Object.assign(new Error("revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier(events, authorityError),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(events.includes("verify"), true);
  assert.deepEqual(
    executor.calls.map(({ method }) => method),
    ["reconcileAction"],
  );
  assert.equal((await store.getForWorker(initial.jobId)).status, "completed");
});

test("an unknown completed action reconciles directly to the completed terminal state", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-from-unknown",
    expectedWorkspaceRevision: REVISION_A,
  };
  const actionDigest = digestValue(completeAction);
  const initial = job({
    status: "unknown",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: {
        turn: 2,
        actionId: completeAction.actionId,
        actionDigest,
        action: completeAction,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: completeAction.actionId,
        actionDigest,
        epoch: 6,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [observation({
        type: "run_profile",
        actionId: "profile-before-unknown-complete",
        expectedWorkspaceRevision: REVISION_A,
        profileId: "node-tests",
      })],
      result: null,
      pause: {
        from: "active",
        reason: "执行结果待对账（EXECUTION_FENCED）",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.status = "completed";
  executor.session.attempt.status = "completed";
  executor.session.actions = [{
    id: completeAction.actionId,
    type: "complete",
    status: "succeeded",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: REVISION_A,
    error: null,
  }];
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal((await store.getForWorker(initial.jobId)).status, "completed");
  assert.equal(brainCalls.length, 0);
  assert.deepEqual(
    executor.calls.map(({ method }) => method),
    ["reconcileAction"],
  );
});

test("a durable complete observation finishes locally after authority revocation", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-observed-before-revocation",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    grant: grant({ schemaVersion: 2, inputBinding: null }),
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction, {
        result: {
          created: [],
          modified: [],
          deleted: [],
        },
      })],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const authorityError = Object.assign(new Error("revoked"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier(events, authorityError),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.deepEqual(executor.calls, []);
  assert.equal(events.includes("verify"), false);
  assert.equal((await store.getForWorker(initial.jobId)).status, "completed");
  assert.equal(store.completionRequests.length, 1);
  assert.equal(store.completionRequests[0].changePackageDelivery, true);
});

test("a durable schema v3 conflict completion keeps its sealed source and opens package delivery", async () => {
  const inputBinding = conflictInputBinding();
  const executionSource = conflictExecutionSource(inputBinding);
  const completeAction = {
    type: "complete",
    actionId: "complete-sealed-conflict",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    grant: grant({
      schemaVersion: 3,
      inputBinding,
      executionSource,
      writablePaths: ["src/app.js"],
    }),
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction, {
        result: { created: [], modified: [], deleted: [] },
      })],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor: new FakeExecutor(initial),
    brainDirectory: brain([]),
    grantVerifier: verifier([], new Error("durable recovery must not re-enter authority")),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(store.completionRequests.length, 1);
  assert.equal(store.completionRequests[0].changePackageDelivery, true);
  assert.deepEqual(initial.grant.executionSource, executionSource);
});

test("a durable legacy PR completion recovers locally without opening a new package", async () => {
  const completeAction = {
    type: "complete",
    actionId: "legacy-complete-observed-before-upgrade",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    grant: grant({
      schemaVersion: 2,
      inputBinding: pullRequestInputBinding(),
    }),
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction)],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor: new FakeExecutor(initial, events),
    brainDirectory: brain([]),
    grantVerifier: verifier(events, new Error("must not verify recovery")),
    changePackageDeliveryEnabled: true,
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "completed");
  assert.equal(events.includes("verify"), false);
  assert.equal(store.completionRequests.length, 1);
  assert.equal("changePackageDelivery" in store.completionRequests[0], false);
});

test("change package delivery defaults off and requires a strict boolean", async () => {
  const completeAction = {
    type: "complete",
    actionId: "complete-without-delivery",
    expectedWorkspaceRevision: REVISION_A,
  };
  const initial = job({
    status: "active",
    revision: 8,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      actionAdmission: null,
      observations: [observation(completeAction)],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const dependencies = {
    jobStore: store,
    executor: new FakeExecutor(initial),
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  };
  const worker = new CodeJobWorkerService(dependencies);

  await worker.runCycle();

  assert.equal(store.completionRequests.length, 1);
  assert.equal("changePackageDelivery" in store.completionRequests[0], false);
  for (const invalid of [null, 0, 1, "true", {}, []]) {
    assert.throws(
      () => new CodeJobWorkerService({
        ...dependencies,
        changePackageDeliveryEnabled: invalid,
      }),
      /changePackageDeliveryEnabled must be a boolean/,
    );
  }
});

test("resuming an interrupted session invalidates prior-attempt profile proof", async () => {
  const inputBinding = pullRequestInputBinding();
  const oldProfileAction = {
    type: "run_profile",
    actionId: "profile-old-attempt",
    expectedWorkspaceRevision: REVISION_A,
    profileId: "node-tests",
  };
  const initial = job({
    grant: grant({ inputBinding }),
    status: "active",
    revision: 5,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 1,
      pendingAction: null,
      observations: [observation(oldProfileAction, { actionAttemptNumber: 1 })],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events, {
    sessionStatus: "interrupted",
    attempt: 1,
  });
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "run_profile" }], brainCalls),
    grantVerifier: verifier(events),
  });

  await worker.runCycle();

  assert.equal(brainCalls[0].capabilities.requiredProfilesRemaining, 1);
  const action = executor.calls.find(({ method }) => method === "perform").value.action;
  assert.equal(action.profileId, "node-tests");
  assert.deepEqual(
    executor.calls.find(({ method }) => method === "resume").value,
    { sessionId: initial.jobId, inputBinding },
  );
});

test("an uncertain audited result enters durable unknown and reconciles without replay", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  executor.getActionResult = async () => {
    throw Object.assign(new Error("corrupt artifact"), {
      code: "AUDIT_BACKEND_UNAVAILABLE",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }]),
    grantVerifier: verifier(events),
  });

  const first = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "unknown");
  const unknown = await store.getForWorker(initial.jobId);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.execution.pendingAction.action.type, "read_text");
  assert.notEqual(unknown.execution.actionAdmission, null);
  assert.equal(unknown.execution.pause, null);
  assert.equal(unknown.execution.uncertainty.from, "active");
  assert.equal(unknown.execution.uncertainty.code, "AUDIT_BACKEND_UNAVAILABLE");
  assert.equal((await store.listRunnable()).items.length, 0);
  assert.equal((await store.listReconcilable()).items.length, 1);

  const second = await worker.runCycle();

  assert.equal(second.outcomes[0].status, "active");
  const reconciled = await store.getForWorker(initial.jobId);
  assert.equal(reconciled.status, "active");
  assert.equal(reconciled.execution.pendingAction, null);
  assert.equal(reconciled.execution.actionAdmission, null);
  assert.equal(reconciled.execution.uncertainty, null);
  assert.equal(executor.calls.filter(({ method }) => method === "perform").length, 1);
  assert.equal(executor.calls.filter(({ method }) => method === "reconcileAction").length, 1);
});

test("unknown reconciliation failures remain isolated from brains and execution", async () => {
  const action = {
    type: "read_text",
    actionId: "turn-1-unknown-reconcile",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "unknown",
    revision: 7,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 6,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: {
        from: "active",
        reason: "执行结果待对账（AUDIT_BACKEND_UNAVAILABLE）",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const queued = job({
    jobId: "code-job-2222222222222222222222222222222222222222222222222222222",
    sequence: 2,
  });
  const store = new FakeJobStore([queued, initial]);
  const executor = new FakeExecutor(initial);
  executor.reconcileAction = async (value) => {
    executor.calls.push({ method: "reconcileAction", value: structuredClone(value) });
    throw Object.assign(new Error("audit still unavailable"), {
      code: "AUDIT_BACKEND_UNAVAILABLE",
    });
  };
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle({ limit: 1 });
  const next = await worker.runCycle({ limit: 1 });

  assert.equal(result.selected, 1);
  assert.equal(result.outcomes[0].status, "unknown");
  assert.equal(next.selected, 1);
  assert.equal(next.outcomes[0].jobId, queued.jobId);
  assert.equal((await store.getForWorker(initial.jobId)).status, "unknown");
  assert.equal(brainCalls.length, 0);
  const executorMethods = executor.calls.map(({ method }) => method);
  assert.equal(executorMethods[0], "reconcileAction");
  assert.equal(
    executorMethods.filter((method) => method === "reconcileAction").length,
    1,
  );
  assert.equal(executorMethods.includes("perform"), false);
});

test("deterministic context overflow fails once instead of retrying forever", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const brainCalls = [];
  const overflow = Object.assign(new Error("context overflow"), {
    code: "CODE_BRAIN_CONTEXT_TOO_LARGE",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([overflow], brainCalls),
    grantVerifier: verifier(events),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "failed");
  assert.equal(first.outcomes[0].code, "CODE_BRAIN_CONTEXT_TOO_LARGE");
  assert.equal(second.selected, 0);
  assert.equal(brainCalls.length, 1);
  assert.equal((await store.getForWorker(initial.jobId)).status, "failed");
});

test("stable brain configuration failures pause instead of spinning forever", async (t) => {
  for (const code of [
    "BRAIN_CREDENTIAL_UNAVAILABLE",
    "BRAIN_PROVIDER_NOT_CONFIGURED",
    "CODE_BRAIN_ROLE_NOT_CONFIGURED",
    "CODE_TASK_BRAIN_NOT_CONFIGURED",
    "CODE_BRAIN_PATH_INVALID",
    "CODE_BRAIN_COMPLETION_NOT_READY",
    "REMOTE_DATA_NOT_AUTHORIZED",
    "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    "STRUCTURED_PROVIDER_UNAVAILABLE",
    "STRUCTURED_PROVIDER_CANCELLED",
    "STRUCTURED_PROVIDER_TIMEOUT",
    "STRUCTURED_PROVIDER_OUTPUT_LIMIT",
    "STRUCTURED_PROVIDER_PROCESS_FAILED",
    "STRUCTURED_PROVIDER_REAP_FAILED",
    "STRUCTURED_PROVIDER_REQUEST_TOO_LARGE",
    "STRUCTURED_PROVIDER_REQUEST_FAILED",
    "STRUCTURED_PROVIDER_HTTP_FAILED",
    "STRUCTURED_PROVIDER_RESPONSE_TOO_LARGE",
    "STRUCTURED_PROVIDER_RESPONSE_INVALID",
    "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  ]) {
    await t.test(code, async () => {
      const initial = job({
        status: "active",
        revision: 3,
        execution: {
          sessionId: job().jobId,
          workspaceRevision: REVISION_A,
          turn: 0,
          pendingAction: null,
          actionAdmission: null,
          observations: [],
          result: null,
          pause: null,
        },
      });
      const store = new FakeJobStore([initial]);
      const executor = new FakeExecutor(initial);
      const brainCalls = [];
      const failure = Object.assign(new Error("brain needs operator action"), {
        code,
      });
      const worker = new CodeJobWorkerService({
        jobStore: store,
        executor,
        brainDirectory: brain([failure], brainCalls),
        grantVerifier: verifier([]),
      });

      const first = await worker.runCycle();
      const second = await worker.runCycle();

      assert.equal(first.outcomes[0].status, "paused");
      assert.equal(first.outcomes[0].code, code);
      assert.equal(second.selected, 0);
      assert.equal((await store.getForWorker(initial.jobId)).status, "paused");
      assert.equal(brainCalls.length, 1);
    });
  }
});

test("proactive-only task-brain setup failure does not broaden Code Job pause policy", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const brainCalls = [];
  const failure = Object.assign(new Error("role task brain is unavailable"), {
    code: "ROLE_TASK_BRAIN_NOT_CONFIGURED",
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([failure], brainCalls),
    grantVerifier: verifier([]),
  });

  const cycle = await worker.runCycle();

  assert.equal(cycle.outcomes[0].status, "retry");
  assert.equal(cycle.outcomes[0].code, "ROLE_TASK_BRAIN_NOT_CONFIGURED");
  assert.equal((await store.getForWorker(initial.jobId)).status, "active");
  assert.equal(brainCalls.length, 1);
});

test("two locally invalid model responses pause once without another cycle call", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const providerCalls = [];
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      async generate(value) {
        providerCalls.push(structuredClone(value));
        return "not json";
      },
      describe(brainConfig) {
        return { ...brainConfig, remote: false };
      },
    },
    roles: {
      developer: {
        taskBrain: {
          provider: "brain-one",
          model: "qwen3.5:9b",
          remoteData: { requirements: false, code: false, memory: false },
        },
      },
    },
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: directory,
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "paused");
  assert.equal(first.outcomes[0].code, "CODE_BRAIN_RESPONSE_INVALID");
  assert.equal(second.selected, 0);
  assert.equal(providerCalls.length, 2);
  assert.equal((await store.getForWorker(initial.jobId)).status, "paused");
});

test("revocation after an invalid response blocks the correction provider call", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const providerCalls = [];
  let revoked = false;
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      async generate(value) {
        providerCalls.push(structuredClone(value));
        revoked = true;
        return "not json";
      },
      describe(brainConfig) {
        return { ...brainConfig, remote: false };
      },
    },
    roles: {
      developer: {
        taskBrain: {
          provider: "brain-one",
          model: "qwen3.5:9b",
          remoteData: { requirements: false, code: false, memory: false },
        },
      },
    },
  });
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: directory,
    grantVerifier: {
      async verify(value) {
        if (revoked) {
          throw Object.assign(new Error("revoked before correction"), {
            code: "INVALID_CODE_JOB_AUTHORITY",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "fenced");
  assert.equal(result.outcomes[0].code, "INVALID_CODE_JOB_AUTHORITY");
  assert.equal(providerCalls.length, 1);
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
});

test("workspace divergence fences once instead of retaining the oldest retry slot", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.workspaceRevision = REVISION_B;
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "fenced");
  assert.equal(first.outcomes[0].code, "CODE_JOB_WORKSPACE_DIVERGED");
  assert.equal(second.selected, 0);
});

test("session binding divergence fences once instead of retrying forever", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.workspaceId = "another-workspace";
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const second = await worker.runCycle();

  assert.equal(first.outcomes[0].status, "fenced");
  assert.equal(first.outcomes[0].code, "CODE_JOB_SESSION_BINDING_INVALID");
  assert.equal(second.selected, 0);
});

test("a cancelled admitted action is reconciled without entering the executor", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  store.afterAdmit = async () => {
    const admitted = await store.getForWorker(initial.jobId);
    await store.cancel({
      jobId: admitted.jobId,
      expectedRevision: admitted.revision,
      reason: "cancel won after admission",
    });
  };
  const decisions = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "read_text", path: "src/app.js" }], decisions),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(result.outcomes[0].status, "cancelled");
  assert.equal(result.cancelled, 1);
  assert.equal(stored.status, "cancelled");
  assert.equal(decisions.length, 1);
  assert.equal(
    executor.calls.some(({ method }) => method === "perform"),
    false,
  );
});

test("cancellation carries the sealed PR Head and rejects a mismatched settlement", async () => {
  const inputBinding = pullRequestInputBinding();
  const initial = job({
    grant: grant({ inputBinding }),
    status: "active",
    revision: 3,
    execution: {
      ...job().execution,
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
    },
  });
  const store = new FakeJobStore([initial]);
  await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "cancel exact PR Head",
  });
  const executor = new FakeExecutor(initial);
  executor.session.inputBinding.headRefOid = "6".repeat(40);
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();
  const request = executor.calls.find(
    ({ method }) => method === "reconcileCancellation",
  ).value;

  assert.deepEqual(request.inputBinding, inputBinding);
  assert.equal(result.outcomes[0].status, "cancelling");
  assert.equal(result.outcomes[0].code, "CODE_JOB_SESSION_BINDING_INVALID");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelling");
});

test("durable cancellation aborts an in-flight action only as a best effort", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  const entered = deferred();
  const release = deferred();
  executor.perform = async (_value, { signal }) => {
    executor.lastSignal = signal;
    entered.resolve(signal);
    await release.promise;
    throw Object.assign(new Error("action aborted"), {
      code: "CODE_JOB_ACTION_INTERRUPTED",
    });
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([{ type: "run_profile", profileId: "node-tests" }]),
    grantVerifier: verifier([]),
  });

  const cycle = worker.runCycle();
  const signal = await entered.promise;
  assert.equal(signal.aborted, false);
  const admitted = await store.getForWorker(initial.jobId);
  const cancelling = await store.cancel({
    jobId: admitted.jobId,
    expectedRevision: admitted.revision,
    reason: "stop the running profile",
  });
  assert.equal(cancelling.job.status, "cancelling");
  assert.equal(worker.requestCancellation(initial.jobId), true);
  assert.equal(signal.aborted, true);
  release.resolve();

  const first = await cycle;
  assert.equal(first.outcomes[0].status, "cancelling");
  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelled");
  assert.equal(worker.requestCancellation(initial.jobId), false);
});

test("cancelling work waits for running actions before cleanup settlement", async () => {
  const action = {
    type: "complete",
    actionId: "cancel-running-action",
    expectedWorkspaceRevision: REVISION_A,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial);
  executor.session.actions.push({
    id: action.actionId,
    type: action.type,
    status: "running",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: null,
  });
  const cancelling = await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "wait for exact reconciliation",
  });
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify() {
        throw new Error("cancelling work must not re-check revoked authority");
      },
    },
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal((await store.getForWorker(initial.jobId)).revision,
    cancelling.job.revision);

  executor.session.actions[0] = {
    ...executor.session.actions[0],
    status: "succeeded",
    workspaceRevisionAfter: REVISION_A,
  };
  executor.session.status = "completed";
  executor.session.attempt.status = "completed";
  const second = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.execution.observations.length, 0);
  assert.equal(store.completionRequests.length, 0);
  assert.equal(brainCalls.length, 0);
});

test("a cancelling admitted session converges after the executor is absent", async () => {
  const initial = job({
    status: "starting",
    revision: 2,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "cancel session start",
  });
  const executor = new FakeExecutor(initial);
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const result = await worker.runCycle();
  assert.equal(result.outcomes[0].status, "cancelled");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelled");
  assert.equal(brainCalls.length, 0);
  assert.equal(executor.calls.filter(({ method }) => method === "start").length, 0);
});

test("an interrupted action is settled only by cleanup proof without replay", async () => {
  const action = {
    type: "write_text",
    actionId: "cancel-unknown-write",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
    content: "export const value = 2;\n",
    expectedFileSha256: FILE_SHA,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  await store.cancel({
    jobId: initial.jobId,
    expectedRevision: initial.revision,
    reason: "stop an uncertain write",
  });
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.session.actions.push({
    id: action.actionId,
    type: action.type,
    status: "interrupted",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: {
      code: "RESULT_UNKNOWN",
      message: "the write may have changed the isolated workspace",
      details: { cleanupPending: true },
    },
  });
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(first.outcomes[0].status, "cancelled");
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.execution.observations.length, 0);
  assert.equal(stored.execution.pendingAction, null);
  assert.equal(stored.execution.actionAdmission, null);
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(store.completionRequests.length, 0);
  assert.equal(brainCalls.length, 0);
});

test("cancel-first transition prevents an admitted session start", async () => {
  const initial = job();
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const transitionQueue = new OperationQueue();
  const sessionTransitionLease = {
    run(operation) { return transitionQueue.enqueue(operation); },
  };
  const beforeStartAdmission = deferred();
  const releaseVerification = deferred();
  let verifyCount = 0;
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    sessionTransitionLease,
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 2) {
          beforeStartAdmission.resolve();
          await releaseVerification.promise;
        }
        return structuredClone(value);
      },
    },
  });

  const cycle = worker.runCycle();
  await beforeStartAdmission.promise;
  const starting = await store.getForWorker(initial.jobId);
  const cancellation = sessionTransitionLease.run(() => store.cancel({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "cancel wins the session admission",
  }));
  await cancellation;
  releaseVerification.resolve();
  const result = await cycle;

  assert.equal(result.outcomes[0].status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "start"), false);
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(brainCalls.length, 0);
  assert.ok(events.indexOf("cancel") > events.indexOf("claim"));
});

test("configuration-first admission claims no new work and starts or resumes no session", async (t) => {
  await t.test("start", async () => {
    const initial = job();
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const events = [];
    const store = new FakeJobStore([initial], events);
    const executor = new FakeExecutor(initial);
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
      actionAdmissionGate: gate,
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "restart_required");
    assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
    assert.equal(executor.calls.some(({ method }) => method === "start"), false);
    assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
    assert.equal(brainCalls.length, 0);
    assert.equal(events.includes("claim"), false);
    assert.equal((await store.getForWorker(initial.jobId)).status, "queued");
  });

  await t.test("resume", async () => {
    const initial = job({
      status: "starting",
      revision: 2,
      execution: {
        sessionId: job().jobId,
        workspaceRevision: null,
        turn: 0,
        pendingAction: null,
        actionAdmission: null,
        observations: [],
        result: null,
        pause: null,
        uncertainty: null,
      },
    });
    const gate = readyActionAdmissionGate();
    await activateNextConfiguration(gate);
    const store = new FakeJobStore([initial]);
    const executor = new FakeExecutor(initial, [], {
      sessionStatus: "interrupted",
    });
    executor.exists = true;
    const brainCalls = [];
    const worker = new CodeJobWorkerService({
      jobStore: store,
      executor,
      brainDirectory: brain([], brainCalls),
      grantVerifier: verifier([]),
      actionAdmissionGate: gate,
    });

    const result = await worker.runCycle();

    assert.equal(result.outcomes[0].status, "restart_required");
    assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
    assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
    assert.equal(brainCalls.length, 0);
    assert.equal((await store.getForWorker(initial.jobId)).status, "starting");
  });
});

test("claim-first admission releases cutover before durable storage settles", async () => {
  const initial = job();
  const events = [];
  const store = new FakeJobStore([initial], events);
  const claimStarting = store.claimStarting.bind(store);
  const claimEntered = deferred();
  const releaseClaim = deferred();
  store.claimStarting = async (input) => {
    claimEntered.resolve();
    await releaseClaim.promise;
    return claimStarting(input);
  };
  const executor = new FakeExecutor(initial, events);
  const gate = readyActionAdmissionGate();
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
    actionAdmissionGate: gate,
  });

  const cycle = worker.runCycle();
  await claimEntered.promise;
  const cutover = activateNextConfiguration(gate);
  const cutoverFinishedFirst = await Promise.race([
    cutover.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  releaseClaim.resolve();
  await cutover;
  const result = await cycle;
  const stored = await store.getForWorker(initial.jobId);

  assert.equal(cutoverFinishedFirst, true);
  assert.equal(result.outcomes[0].status, "restart_required");
  assert.equal(result.outcomes[0].code, "RUNTIME_RESTART_REQUIRED");
  assert.equal(stored.status, "starting");
  assert.equal(events.filter((event) => event === "claim").length, 1);
  assert.equal(executor.calls.some(({ method }) => method === "start"), false);
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(brainCalls.length, 0);
});

test("start-first admission releases the gate before the long start settles", async () => {
  const initial = job();
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events);
  const startEntered = deferred();
  const startResult = deferred();
  executor.start = (value) => {
    executor.calls.push({ method: "start", value: structuredClone(value) });
    events.push("executor.start");
    startEntered.resolve();
    return startResult.promise;
  };
  const transitionQueue = new OperationQueue();
  const sessionTransitionLease = {
    run(operation) { return transitionQueue.enqueue(operation); },
  };
  const actionAdmissionGate = readyActionAdmissionGate();
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
    sessionTransitionLease,
    actionAdmissionGate,
  });

  const cycle = worker.runCycle();
  await startEntered.promise;
  const cutover = activateNextConfiguration(actionAdmissionGate);
  assert.equal(
    await Promise.race([
      cutover,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );
  const starting = await store.getForWorker(initial.jobId);
  const cancellation = sessionTransitionLease.run(() => store.cancel({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "cancel after start admission",
  }));
  const observed = await Promise.race([
    cancellation.then(() => "cancelled"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 30)),
  ]);

  assert.equal(observed, "cancelled");
  assert.equal(events.indexOf("executor.start") < events.indexOf("cancel"), true);
  executor.exists = true;
  startResult.resolve(structuredClone(executor.session));
  const result = await cycle;

  assert.ok(["cancelling", "cancelled"].includes(result.outcomes[0].status));
  assert.equal(
    executor.calls.filter(({ method }) => method === "start").length,
    1,
  );
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(brainCalls.length, 0);
  assert.equal(actionAdmissionGate.readStatus().mode, "restart_required");
});

test("resume-first admission releases the gate before the long resume settles", async () => {
  const initial = job({
    status: "starting",
    revision: 2,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const events = [];
  const store = new FakeJobStore([initial], events);
  const executor = new FakeExecutor(initial, events, {
    sessionStatus: "interrupted",
  });
  executor.exists = true;
  const resumeEntered = deferred();
  const resumeResult = deferred();
  executor.resume = (value) => {
    executor.calls.push({ method: "resume", value: structuredClone(value) });
    events.push("executor.resume");
    resumeEntered.resolve();
    return resumeResult.promise;
  };
  const transitionQueue = new OperationQueue();
  const sessionTransitionLease = {
    run(operation) { return transitionQueue.enqueue(operation); },
  };
  const actionAdmissionGate = readyActionAdmissionGate();
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: verifier(events),
    sessionTransitionLease,
    actionAdmissionGate,
  });

  const cycle = worker.runCycle();
  await resumeEntered.promise;
  const cutover = activateNextConfiguration(actionAdmissionGate);
  assert.equal(
    await Promise.race([
      cutover,
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]),
    "activated-v2",
  );
  const starting = await store.getForWorker(initial.jobId);
  const cancellation = sessionTransitionLease.run(() => store.cancel({
    jobId: starting.jobId,
    expectedRevision: starting.revision,
    reason: "cancel after resume admission",
  }));
  const observed = await Promise.race([
    cancellation.then(() => "cancelled"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 30)),
  ]);

  assert.equal(observed, "cancelled");
  assert.equal(events.indexOf("executor.resume") < events.indexOf("cancel"), true);
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelling");
  resumeResult.resolve({
    ...structuredClone(executor.session),
    status: "active",
    attempt: { number: 2, status: "active" },
  });
  const result = await cycle;

  assert.equal(result.outcomes[0].status, "cancelling");
  assert.equal(
    executor.calls.filter(({ method }) => method === "resume").length,
    1,
  );
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(brainCalls.length, 0);
  assert.equal(actionAdmissionGate.readStatus().mode, "restart_required");
});

test("cancellation committed during starting recovery prevents session resume", async () => {
  const initial = job({
    status: "starting",
    revision: 2,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: null,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.exists = true;
  let verifyCount = 0;
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 2) {
          const current = await store.getForWorker(initial.jobId);
          await store.cancel({
            jobId: current.jobId,
            expectedRevision: current.revision,
            reason: "cancel before session recovery",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(brainCalls.length, 0);

  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
});

test("cancellation committed during idle recovery prevents session resume", async () => {
  const initial = job({
    status: "active",
    revision: 3,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: null,
      actionAdmission: null,
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  let verifyCount = 0;
  const brainCalls = [];
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([], brainCalls),
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 2) {
          const current = await store.getForWorker(initial.jobId);
          await store.cancel({
            jobId: current.jobId,
            expectedRevision: current.revision,
            reason: "cancel before idle recovery",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const result = await worker.runCycle();

  assert.equal(result.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);
  assert.equal(brainCalls.length, 0);
  const settled = await worker.runCycle();
  assert.equal(settled.outcomes[0].status, "cancelled");
});

test("cancellation committed during prepared recovery prevents session resume", async () => {
  const action = {
    type: "read_text",
    actionId: "cancel-before-prepared-resume",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "active",
    revision: 4,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: null,
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  let verifyCount = 0;
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: {
      async verify(value) {
        verifyCount += 1;
        if (verifyCount === 3) {
          const current = await store.getForWorker(initial.jobId);
          await store.cancel({
            jobId: current.jobId,
            expectedRevision: current.revision,
            reason: "cancel before prepared recovery",
          });
        }
        return structuredClone(value);
      },
    },
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);

  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
});

test("cancellation committed during unknown recovery prevents session resume", async () => {
  const action = {
    type: "write_text",
    actionId: "cancel-before-unknown-resume",
    expectedWorkspaceRevision: REVISION_A,
    path: "src/app.js",
    content: "export const value = 3;\n",
    expectedFileSha256: FILE_SHA,
  };
  const actionDigest = digestValue(action);
  const initial = job({
    status: "unknown",
    revision: 5,
    execution: {
      sessionId: job().jobId,
      workspaceRevision: REVISION_A,
      turn: 0,
      pendingAction: {
        turn: 1,
        actionId: action.actionId,
        actionDigest,
        action,
        preparedAt: "2026-08-01T00:00:01.000Z",
      },
      actionAdmission: {
        actionId: action.actionId,
        actionDigest,
        epoch: 4,
        admittedAt: "2026-08-01T00:00:01.500Z",
      },
      observations: [],
      result: null,
      pause: null,
      uncertainty: {
        from: "active",
        code: "RESULT_UNKNOWN",
        message: "the action result requires reconciliation",
        at: "2026-08-01T00:00:02.000Z",
      },
    },
  });
  const store = new FakeJobStore([initial]);
  const executor = new FakeExecutor(initial, [], { sessionStatus: "interrupted" });
  executor.session.actions.push({
    id: action.actionId,
    type: action.type,
    status: "interrupted",
    attemptNumber: 1,
    workspaceRevisionBefore: REVISION_A,
    workspaceRevisionAfter: null,
    error: { code: "RESULT_UNKNOWN", message: "result unknown" },
  });
  const reconcile = executor.reconcileAction.bind(executor);
  let cancelled = false;
  executor.reconcileAction = async (value) => {
    const result = await reconcile(value);
    if (!cancelled) {
      cancelled = true;
      const current = await store.getForWorker(initial.jobId);
      await store.cancel({
        jobId: current.jobId,
        expectedRevision: current.revision,
        reason: "cancel before unknown recovery",
      });
    }
    return result;
  };
  const worker = new CodeJobWorkerService({
    jobStore: store,
    executor,
    brainDirectory: brain([]),
    grantVerifier: verifier([]),
  });

  const first = await worker.runCycle();
  assert.equal(first.outcomes[0].status, "cancelling");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
  assert.equal(executor.calls.some(({ method }) => method === "perform"), false);

  const second = await worker.runCycle();
  assert.equal(second.outcomes[0].status, "cancelled");
  assert.equal((await store.getForWorker(initial.jobId)).status, "cancelled");
  assert.equal(executor.calls.some(({ method }) => method === "resume"), false);
});
