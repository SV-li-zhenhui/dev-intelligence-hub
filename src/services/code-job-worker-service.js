import { OperationQueue } from "../lib/operation-queue.js";
import { packCodeJobBrainContext } from "./code-job-context-packer.js";
import {
  assertSessionBinding,
  bindTrustedAction,
  cleanText,
  isAuthorityErrorCode,
  isDeterministicFailureCode,
  isFencingExecutorCode,
  isRestartRequiredCode,
  modelObservation,
  normalizeActionResponse,
  normalizeCycleOptions,
  observationDetail,
  positiveInteger,
  requiresOperatorPause,
  safeErrorCode,
  sameValue,
  selectCycleCandidates,
  successfulProfiles,
  terminalResult,
  trustedObservationAction,
  workerError,
} from "./code-job-worker-policy.js";

export { CodeJobWorkerError } from "./code-job-worker-policy.js";

const RUNNABLE_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "fenced"]);

function requirePort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, value[method].bind(value)]),
    ),
  );
}

export class CodeJobWorkerService {
  #jobs;
  #executor;
  #brain;
  #verifyGrant;
  #queue;
  #maxTurns;
  #observationLimit;
  #runnableCursor;
  #reconcilableCursor;
  #preferReconcilable;

  constructor({
    jobStore,
    executor,
    brainDirectory,
    grantVerifier,
    operationQueue = new OperationQueue(),
    maxTurns = 64,
    observationLimit = 20,
  } = {}) {
    this.#jobs = requirePort(
      jobStore,
      [
        "listRunnable",
        "listReconcilable",
        "getForWorker",
        "claimStarting",
        "activate",
        "acknowledgeAbsentSession",
        "acknowledgeStartedSession",
        "prepareAction",
        "admitAction",
        "acknowledgeAbsentAction",
        "markActionUnknown",
        "recordObservation",
        "pause",
        "complete",
        "fail",
        "fence",
      ],
      "code job worker store",
    );
    this.#executor = requirePort(
      executor,
      [
        "start",
        "view",
        "resume",
        "perform",
        "getActionResult",
        "reconcileAction",
      ],
      "controlled code executor",
    );
    this.#brain = requirePort(brainDirectory, ["decide"], "code job brain");
    this.#verifyGrant = requirePort(
      grantVerifier,
      ["verify"],
      "code job grant verifier",
    ).verify;
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("code job worker queue is invalid");
    }
    this.#queue = operationQueue;
    this.#maxTurns = positiveInteger(maxTurns, "maxTurns", 128);
    this.#observationLimit = positiveInteger(
      observationLimit,
      "observationLimit",
      100,
    );
    this.#runnableCursor = 0;
    this.#reconcilableCursor = 0;
    this.#preferReconcilable = true;
    Object.freeze(this);
  }

  runCycle(value = {}) {
    const options = normalizeCycleOptions(value);
    return this.#queue.enqueue(() => this.#runCycle(options));
  }

  async #runCycle(options) {
    const query = {
      limit: options.limit,
      ...(options.roleId === null ? {} : { roleId: options.roleId }),
    };
    const reconcilable = await this.#jobs.listReconcilable({
      ...query,
      afterSequence: this.#reconcilableCursor,
    });
    const runnable = await this.#jobs.listRunnable({
      ...query,
      afterSequence: this.#runnableCursor,
    });
    const selection = selectCycleCandidates(
      reconcilable.items,
      runnable.items,
      options.limit,
      this.#preferReconcilable,
    );
    this.#preferReconcilable = selection.preferReconcilable;
    const selected = { items: selection.selected };
    const lastReconcilable = selected.items.findLast(
      ({ status }) => status === "unknown",
    );
    const lastRunnable = selected.items.findLast(
      ({ status }) => status !== "unknown",
    );
    if (lastReconcilable) this.#reconcilableCursor = lastReconcilable.sequence;
    if (lastRunnable) this.#runnableCursor = lastRunnable.sequence;
    const outcomes = [];
    for (const selectedJob of selected.items) {
      try {
        outcomes.push(await this.#process(selectedJob.jobId));
      } catch (error) {
        outcomes.push(await this.#handleFailure(selectedJob.jobId, error));
      }
    }
    return {
      selected: selected.items.length,
      processed: outcomes.length,
      succeeded: outcomes.filter(({ status }) => status === "completed").length,
      fenced: outcomes.filter(({ status }) => status === "fenced").length,
      failed: outcomes.filter(({ status }) => status === "failed").length,
      outcomes,
    };
  }

  async #process(jobId) {
    let job = await this.#requireRunnableJob(jobId);
    if (job.status === "unknown") {
      return this.#reconcileUnknown(job);
    }
    if (!RUNNABLE_STATUSES.has(job.status)) {
      return { jobId, status: job.status, actionType: null };
    }

    if (job.status === "queued") {
      job = (await this.#jobs.claimStarting({
        jobId,
        expectedRevision: job.revision,
      })).job;
    }

    if (job.status === "starting") {
      await this.#verifyAuthority(job.grant);
      let session = await this.#viewOptionalSession(job.jobId);
      if (session === null) {
        await this.#verifyAuthority(job.grant);
        session = await this.#executor.start({
          sessionId: job.jobId,
          workspaceId: job.grant.workspaceId,
          requestedBy: job.grant.requestedBy,
        });
      }
      let current = await this.#jobs.getForWorker(job.jobId);
      if (
        current?.status === "pausing" &&
        current.execution.pause?.from === "starting"
      ) {
        return this.#reconcileStartingPause(current, session);
      }
      if (current?.status !== "starting") {
        return {
          jobId: job.jobId,
          status: current?.status ?? "missing",
          actionType: null,
        };
      }
      job = current;
      if (session.status === "interrupted") {
        await this.#verifyAuthority(job.grant);
        session = await this.#executor.resume({ sessionId: job.jobId });
      }
      current = await this.#jobs.getForWorker(job.jobId);
      if (
        current?.status === "pausing" &&
        current.execution.pause?.from === "starting"
      ) {
        return this.#reconcileStartingPause(current, session);
      }
      if (current?.status !== "starting") {
        return {
          jobId: job.jobId,
          status: current?.status ?? "missing",
          actionType: null,
        };
      }
      job = current;
      if (session.status === "failed") {
        return this.#finishFailed(job, session.error);
      }
      if (session.status !== "active") {
        throw workerError(
          "CODE_JOB_SESSION_NOT_ACTIVE",
          "Controlled executor did not activate the claimed session",
        );
      }
      assertSessionBinding(job, session);
      job = (await this.#jobs.activate({
        jobId,
        expectedRevision: job.revision,
        workspaceRevision: session.workspaceRevision,
      })).job;
    }

    if (job.status === "pausing") {
      if (job.execution.pause?.from === "starting") {
        return this.#reconcileStartingPause(job);
      }
      if (job.execution.pendingAction === null) {
        throw workerError(
          "CODE_JOB_PENDING_ACTION_MISSING",
          "Pausing code job lost its admitted action",
        );
      }
      return this.#continuePending(job);
    }
    if (job.status !== "active") {
      return { jobId, status: job.status, actionType: null };
    }
    if (job.execution.pendingAction !== null) {
      return this.#continuePending(job);
    }

    const durableObservation = job.execution.observations.at(-1);
    if (
      durableObservation?.actionType === "complete" &&
      durableObservation.status === "succeeded"
    ) {
      return this.#completeObservedJob(job, durableObservation);
    }

    await this.#verifyAuthority(job.grant);
    let session = await this.#executor.view({ sessionId: job.jobId });
    if (session.status === "failed") {
      return this.#finishFailed(job, session.error);
    }
    if (session.status === "completed") {
      return this.#recoverCompleted(job, session);
    }
    if (session.status === "interrupted") {
      await this.#verifyAuthority(job.grant);
      session = await this.#executor.resume({ sessionId: job.jobId });
    }
    if (session.status !== "active") {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Controlled executor session is not ready for another action",
      );
    }
    assertSessionBinding(job, session);
    if (job.execution.workspaceRevision !== session.workspaceRevision) {
      throw workerError(
        "CODE_JOB_WORKSPACE_DIVERGED",
        "Code job and controlled executor workspace revisions diverged",
      );
    }

    if (job.execution.turn >= this.#maxTurns) {
      return this.#finishFailed(job, {
        code: "CODE_JOB_TURN_LIMIT",
        message: "Code job reached its configured turn limit",
      });
    }

    const passedProfiles = successfulProfiles(job, session);
    const remainingProfiles = job.grant.requiredProfiles.filter(
      ({ id }) => !passedProfiles.has(id),
    );
    const observations = job.execution.observations
      .slice(-this.#observationLimit)
      .map(modelObservation);
    await this.#verifyAuthority(job.grant);
    const brainContext = packCodeJobBrainContext({
      task: {
        operation: job.grant.operation,
        repository: job.grant.repository,
        objective: job.grant.objective,
        acceptanceCriteria: job.grant.acceptanceCriteria,
        evidence: job.grant.evidence,
      },
      capabilities: {
        allowedActions: job.grant.allowedActions,
        writablePaths: job.grant.writablePaths,
        requiredProfilesRemaining: remainingProfiles.length,
      },
      turn: job.execution.turn + 1,
      observations,
    });
    const decision = await this.#brain.decide(
      {
        roleId: job.grant.requestedBy.roleId,
        ...brainContext,
      },
      {
        beforeGenerate: () => this.#verifyAuthority(job.grant),
      },
    );
    const action = bindTrustedAction(
      job,
      session,
      decision.action,
      remainingProfiles,
    );
    await this.#verifyAuthority(job.grant);
    job = (await this.#jobs.prepareAction({
      jobId,
      expectedRevision: job.revision,
      action,
    })).job;
    await this.#verifyAuthority(job.grant);
    return this.#performPending(job, session);
  }

  async #reconcileStartingPause(job, knownSession = null) {
    const session = knownSession ?? await this.#viewOptionalSession(job.jobId);
    if (session === null) {
      const changed = await this.#jobs.acknowledgeAbsentSession({
        jobId: job.jobId,
        expectedRevision: job.revision,
      });
      return {
        jobId: job.jobId,
        status: changed.job.status,
        actionType: null,
      };
    }
    if (session.status === "failed") {
      return this.#finishFailed(job, session.error);
    }
    if (!["active", "interrupted"].includes(session.status)) {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Admitted session start is still being reconciled",
      );
    }
    assertSessionBinding(job, session);
    const changed = await this.#jobs.acknowledgeStartedSession({
      jobId: job.jobId,
      expectedRevision: job.revision,
      workspaceRevision: session.workspaceRevision,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: null,
    };
  }

  async #continuePending(job) {
    let authorityError = null;
    if (job.status !== "pausing") {
      try {
        await this.#verifyAuthority(job.grant);
      } catch (error) {
        authorityError = error;
      }
    }

    if (
      authorityError !== null &&
      job.execution.actionAdmission === null
    ) {
      throw authorityError;
    }

    let reconciled;
    try {
      reconciled = await this.#executor.reconcileAction({
        sessionId: job.jobId,
        action: job.execution.pendingAction.action,
      });
    } catch (error) {
      if (authorityError && error?.code === "SESSION_NOT_FOUND") {
        throw authorityError;
      }
      throw error;
    }

    if (reconciled.status === "running") {
      throw workerError(
        "CODE_JOB_ACTION_BUSY",
        "Prepared action is still running in the controlled executor",
      );
    }
    if (reconciled.status === "terminal") {
      const outcome = await this.#performPending(job, reconciled.session, {
        reconcileExisting: true,
        reconciled,
      });
      if (authorityError && outcome.status !== "completed") {
        throw authorityError;
      }
      return outcome;
    }
    if (reconciled.status !== "absent") {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Controlled executor returned an invalid reconciliation result",
      );
    }
    if (job.status === "pausing") {
      const admission = job.execution.actionAdmission;
      if (admission === null) {
        throw workerError(
          "CODE_JOB_ADMISSION_MISSING",
          "Pausing code job lost its action admission",
        );
      }
      const changed = await this.#jobs.acknowledgeAbsentAction({
        jobId: job.jobId,
        expectedRevision: job.revision,
        actionId: admission.actionId,
        actionDigest: admission.actionDigest,
        epoch: admission.epoch,
      });
      return {
        jobId: job.jobId,
        status: changed.job.status,
        actionType: null,
      };
    }
    if (authorityError) throw authorityError;

    await this.#verifyAuthority(job.grant);
    let session = await this.#executor.view({ sessionId: job.jobId });
    if (session.status === "interrupted") {
      await this.#verifyAuthority(job.grant);
      session = await this.#executor.resume({ sessionId: job.jobId });
    }
    if (session.status !== "active") {
      throw workerError(
        "CODE_JOB_SESSION_BUSY",
        "Controlled executor session is not ready for a prepared action",
      );
    }
    assertSessionBinding(job, session);
    return this.#performPending(job, session);
  }

  async #reconcileUnknown(job) {
    const pending = job.execution.pendingAction;
    const admission = job.execution.actionAdmission;
    if (pending === null || admission === null) {
      throw workerError(
        "CODE_JOB_ADMISSION_MISSING",
        "Unknown code job lost its durable action admission",
      );
    }
    const reconciled = await this.#executor.reconcileAction({
      sessionId: job.jobId,
      action: pending.action,
    });
    if (reconciled.status === "running") {
      return {
        jobId: job.jobId,
        status: "unknown",
        actionType: pending.action.type,
      };
    }
    if (reconciled.status === "terminal") {
      if (reconciled.action?.status === "interrupted") {
        const interrupted = normalizeActionResponse(pending, reconciled);
        assertSessionBinding(job, interrupted.session);
        if (
          interrupted.action.workspaceRevisionAfter !== null ||
          interrupted.session.workspaceRevision !==
            job.execution.workspaceRevision
        ) {
          throw workerError(
            "CODE_JOB_WORKSPACE_DIVERGED",
            "Interrupted action recovery does not match the trusted workspace",
          );
        }
        let recoveredSession = interrupted.session;
        if (recoveredSession.status === "interrupted") {
          recoveredSession = await this.#executor.resume({
            sessionId: job.jobId,
          });
          assertSessionBinding(job, recoveredSession);
        }
        if (
          recoveredSession.status !== "active" ||
          recoveredSession.workspaceRevision !== job.execution.workspaceRevision ||
          recoveredSession.attempt.number <= interrupted.action.attemptNumber
        ) {
          throw workerError(
            "CODE_JOB_SESSION_DIVERGED",
            "Interrupted action did not recover into a later trusted attempt",
          );
        }
        return this.#performPending(job, recoveredSession, {
          reconcileExisting: true,
          reconciled: { ...reconciled, session: recoveredSession },
          acceptInterrupted: true,
        });
      }
      return this.#performPending(job, reconciled.session, {
        reconcileExisting: true,
        reconciled,
      });
    }
    if (reconciled.status !== "absent") {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Controlled executor returned an invalid unknown-action reconciliation",
      );
    }
    const changed = await this.#jobs.acknowledgeAbsentAction({
      jobId: job.jobId,
      expectedRevision: job.revision,
      actionId: admission.actionId,
      actionDigest: admission.actionDigest,
      epoch: admission.epoch,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: pending.action.type,
    };
  }

  async #performPending(
    job,
    session,
    {
      reconcileExisting = false,
      reconciled = null,
      acceptInterrupted = false,
    } = {},
  ) {
    const pending = job.execution.pendingAction;
    if (pending === null) {
      throw workerError(
        "CODE_JOB_PENDING_ACTION_MISSING",
        "Code job lost its prepared action before execution",
      );
    }
    if (
      !reconcileExisting &&
      pending.action.expectedWorkspaceRevision !== session.workspaceRevision
    ) {
      throw workerError(
        "CODE_JOB_WORKSPACE_DIVERGED",
        "Prepared action no longer matches the controlled workspace revision",
      );
    }
    let result;
    let response;
    if (reconcileExisting) {
      const current = reconciled ?? await this.#executor.reconcileAction({
        sessionId: job.jobId,
        action: pending.action,
      });
      if (current.status === "absent") {
        throw workerError(
          "CODE_JOB_SESSION_DIVERGED",
          "Executor lost an action that was already observed",
        );
      }
      if (current.status === "running") {
        throw workerError(
          "CODE_JOB_ACTION_BUSY",
          "Prepared action is still running in the controlled executor",
        );
      }
      response = normalizeActionResponse(pending, current);
      result = current.result;
    } else {
      const fresh = await this.#jobs.getForWorker(job.jobId);
      if (
        fresh?.status !== "active" ||
        fresh.execution.pendingAction?.actionDigest !== pending.actionDigest
      ) {
        return {
          jobId: job.jobId,
          status: fresh?.status ?? "missing",
          actionType: null,
        };
      }
      job = fresh;
      await this.#verifyAuthority(job.grant);
      job = (await this.#jobs.admitAction({
        jobId: job.jobId,
        expectedRevision: job.revision,
        actionId: pending.actionId,
        actionDigest: pending.actionDigest,
      })).job;
      response = normalizeActionResponse(
        pending,
        await this.#executor.perform({
          sessionId: job.jobId,
          action: pending.action,
        }),
      );
    }
    assertSessionBinding(job, response.session);
    if (
      !reconcileExisting &&
      ["succeeded", "failed"].includes(response.action.status)
    ) {
      const audited = await this.#executor.getActionResult({
        sessionId: job.jobId,
        actionId: pending.actionId,
      });
      if (
        audited?.action?.id !== response.action.id ||
        audited.action.type !== response.action.type ||
        audited.action.status !== response.action.status ||
        audited.action.workspaceRevisionBefore !==
          pending.action.expectedWorkspaceRevision
      ) {
        throw workerError(
          "CODE_JOB_AUDIT_RESULT_INVALID",
          "Audited executor result does not match the performed action",
        );
      }
      response = { ...response, action: audited.action };
      result = audited.result;
    } else if (!reconcileExisting) {
      result = { error: response.action.error };
    }
    const status = response.action.status;
    if (
      response.action.workspaceRevisionAfter !== null &&
      response.action.workspaceRevisionAfter !== response.session.workspaceRevision
    ) {
      throw workerError(
        "CODE_JOB_EXECUTOR_RESULT_INVALID",
        "Executor action result is bound to a different workspace revision",
      );
    }
    if (status === "interrupted" && !acceptInterrupted) {
      throw workerError(
        safeErrorCode(response.action.error, "CODE_JOB_ACTION_INTERRUPTED"),
        "Controlled executor reported an uncertain action result",
      );
    }
    const detail = observationDetail(pending.action, response, result);
    const latest = await this.#jobs.getForWorker(job.jobId);
    if (
      !latest ||
      !["active", "pausing", "unknown"].includes(latest.status) ||
      latest.execution.pendingAction?.actionDigest !== pending.actionDigest
    ) {
      return {
        jobId: job.jobId,
        status: latest?.status ?? "missing",
        actionType: null,
      };
    }
    job = latest;
    const admission = latest.status === "unknown"
      ? latest.execution.actionAdmission
      : null;
    if (latest.status === "unknown" && admission === null) {
      throw workerError(
        "CODE_JOB_ADMISSION_MISSING",
        "Unknown code job lost its durable action admission",
      );
    }
    job = (await this.#jobs.recordObservation({
      jobId: job.jobId,
      expectedRevision: job.revision,
      actionId: pending.actionId,
      status,
      workspaceRevision: response.session.workspaceRevision,
      detail,
      ...(admission === null
        ? {}
        : {
            actionDigest: admission.actionDigest,
            epoch: admission.epoch,
          }),
    })).job;
    if (pending.action.type === "complete" && status === "succeeded") {
      job = (await this.#jobs.complete({
        jobId: job.jobId,
        expectedRevision: job.revision,
        result: terminalResult(
          job,
          pending.action,
          detail,
          response.session.workspaceRevision,
        ),
      })).job;
      return { jobId: job.jobId, status: "completed", actionType: "complete" };
    }
    return {
      jobId: job.jobId,
      status: job.status,
      actionType: pending.action.type,
    };
  }

  async #recoverCompleted(job, session) {
    assertSessionBinding(job, session);
    if (job.execution.pendingAction !== null) {
      throw workerError(
        "CODE_JOB_SESSION_DIVERGED",
        "Executor completion has no matching terminal action to reconcile",
      );
    }
    const observation = job.execution.observations.at(-1);
    if (
      observation?.actionType !== "complete" ||
      observation.status !== "succeeded"
    ) {
      throw workerError(
        "CODE_JOB_SESSION_DIVERGED",
        "Executor completion is missing its durable code job observation",
      );
    }
    return this.#completeObservedJob(job, observation);
  }

  async #completeObservedJob(job, observation) {
    trustedObservationAction(observation);
    job = (await this.#jobs.complete({
      jobId: job.jobId,
      expectedRevision: job.revision,
      result: terminalResult(
        job,
        observation.action,
        observation.detail,
        observation.workspaceRevision,
      ),
    })).job;
    return { jobId: job.jobId, status: "completed", actionType: "complete" };
  }

  async #finishFailed(job, error) {
    const result = {
      schemaVersion: 1,
      code: safeErrorCode(error),
      message: cleanText(error?.message ?? "Code job execution failed", 2_048),
    };
    const current = await this.#jobs.getForWorker(job.jobId);
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      return { jobId: job.jobId, status: current?.status ?? "missing", actionType: null };
    }
    const changed = await this.#jobs.fail({
      jobId: job.jobId,
      expectedRevision: current.revision,
      result,
    });
    return {
      jobId: job.jobId,
      status: changed.job.status,
      actionType: null,
      code: result.code,
    };
  }

  async #handleFailure(jobId, error) {
    const code = safeErrorCode(error);
    let current;
    try {
      current = await this.#jobs.getForWorker(jobId);
    } catch (readError) {
      return {
        jobId,
        status: "retry",
        actionType: null,
        code,
        readCode: safeErrorCode(readError),
      };
    }
    if (current?.status === "unknown") {
      return {
        jobId,
        status: "unknown",
        actionType: current.execution.pendingAction?.action.type ?? null,
        code,
      };
    }
    const admission = current?.execution?.actionAdmission ?? null;
    const pending = current?.execution?.pendingAction ?? null;
    if (admission !== null && pending !== null) {
      try {
        const changed = await this.#jobs.markActionUnknown({
          jobId,
          expectedRevision: current.revision,
          actionId: admission.actionId,
          actionDigest: admission.actionDigest,
          epoch: admission.epoch,
          code,
          message: "受控动作结果无法确认，必须先与执行器对账",
        });
        return {
          jobId,
          status: changed.job.status,
          actionType: pending.action.type,
          code,
        };
      } catch (unknownError) {
        const latest = await this.#jobs.getForWorker(jobId);
        return {
          jobId,
          status: latest?.status === "unknown" ? "unknown" : "retry",
          actionType: latest?.execution?.pendingAction?.action.type ?? null,
          code,
          unknownCode: safeErrorCode(unknownError),
        };
      }
    }
    if (isRestartRequiredCode(code)) {
      return {
        jobId,
        status: "restart_required",
        actionType: current?.execution?.pendingAction?.action.type ?? null,
        code,
      };
    }
    if (
      isDeterministicFailureCode(code) &&
      current &&
      !TERMINAL_STATUSES.has(current.status)
    ) {
      return this.#finishFailed(current, error);
    }
    if (
      requiresOperatorPause(code) &&
      current &&
      !TERMINAL_STATUSES.has(current.status)
    ) {
      if (["pausing", "paused"].includes(current.status)) {
        return {
          jobId,
          status: current.status,
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
        };
      }
      try {
        const changed = await this.#jobs.pause({
          jobId,
          expectedRevision: current.revision,
          reason: `等待人工处理（${code}）`,
        });
        return {
          jobId,
          status: changed.job.status,
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
        };
      } catch (pauseError) {
        return {
          jobId,
          status: "retry",
          actionType: current.execution.pendingAction?.action.type ?? null,
          code,
          pauseCode: safeErrorCode(pauseError),
        };
      }
    }
    if (
      current &&
      ["pausing", "paused"].includes(current.status) &&
      ["CODE_JOB_REVISION_CONFLICT", "CODE_JOB_TRANSITION_CONFLICT"].includes(
        code,
      )
    ) {
      return {
        jobId,
        status: current.status,
        actionType: current.execution.pendingAction?.action.type ?? null,
        code,
      };
    }
    if (isAuthorityErrorCode(code) || isFencingExecutorCode(code)) {
      try {
        if (current && !TERMINAL_STATUSES.has(current.status)) {
          const changed = await this.#jobs.fence({
            jobId,
            expectedRevision: current.revision,
            result: {
              schemaVersion: 1,
              code,
              message: cleanText(error?.message ?? "Code job was fenced", 2_048),
            },
          });
          return { jobId, status: changed.job.status, actionType: null, code };
        }
        return { jobId, status: current?.status ?? "missing", actionType: null, code };
      } catch (fenceError) {
        return {
          jobId,
          status: "retry",
          actionType: null,
          code,
          fenceCode: safeErrorCode(fenceError),
        };
      }
    }
    return { jobId, status: "retry", actionType: null, code };
  }

  async #requireRunnableJob(jobId) {
    const job = await this.#jobs.getForWorker(jobId);
    if (!job) {
      throw workerError("CODE_JOB_NOT_FOUND", "Selected code job no longer exists");
    }
    if (!RUNNABLE_STATUSES.has(job.status)) {
      return job;
    }
    return job;
  }

  async #verifyAuthority(grant) {
    const current = await this.#verifyGrant(grant);
    if (!sameValue(current, grant)) {
      throw workerError(
        "CODE_JOB_AUTHORITY_PROTOCOL_ERROR",
        "Grant verifier returned a different code job authority",
      );
    }
    return current;
  }

  async #viewOptionalSession(sessionId) {
    try {
      return await this.#executor.view({ sessionId });
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") return null;
      throw error;
    }
  }

}
