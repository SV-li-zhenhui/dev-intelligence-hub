const SAFE_TRIGGER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const NO_ROLE_SCOPE = "*";

function requirePort(value, method, name) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${name} must provide ${method}`);
  }
  return value[method].bind(value);
}

function positiveLimit(value, name, maximum = 100) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeTrigger(value) {
  if (typeof value !== "string" || !SAFE_TRIGGER.test(value)) {
    throw new TypeError("trigger is invalid");
  }
  return value;
}

function safeRoleId(value) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw new TypeError("roleId is invalid");
  }
  return value;
}

function cycleOptions(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(
      (key) => !["trigger", "includeWork", "roleId"].includes(key),
    )
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  const includeWork = value.includeWork ?? true;
  if (typeof includeWork !== "boolean") {
    throw new TypeError("includeWork is invalid");
  }
  const roleId = value.roleId == null ? null : safeRoleId(value.roleId);
  if (!includeWork && roleId !== null) {
    throw new TypeError("roleId requires includeWork");
  }
  return Object.freeze({
    trigger: safeTrigger(value.trigger ?? "scheduled"),
    includeWork,
    roleId,
  });
}

async function skipProposalExecution() {
  return { skipped: "not_configured" };
}

async function skipCodeJobs() {
  return { skipped: "not_configured" };
}

async function skipCodeJobChangePackages() {
  return { skipped: "not_configured" };
}

async function skipCodeJobMemory() {
  return { skipped: "not_configured" };
}

function stageFailure(stage, error) {
  const wrapped = new Error(`员工主动循环阶段失败: ${stage}`, { cause: error });
  wrapped.code = "WORK_COORDINATION_STAGE_FAILED";
  wrapped.stage = stage;
  return wrapped;
}

export class WorkCoordinationService {
  #intake;
  #runCodeJobs;
  #dispatchCodeJobChangePackages;
  #projectCodeJobMemory;
  #runProposals;
  #reconcileProposals;
  #reconcileAttention;
  #wakeConditions;
  #runWork;
  #dispatch;
  #defaults;
  #inFlightByScope = new Map();
  #cycleTail = Promise.resolve();

  constructor({
    ledger,
    codeJobRunner,
    codeJobChangePackageDispatcher,
    codeJobMemoryProjector,
    proposalRunner,
    proposalResultReconciler,
    attentionResultReconciler,
    conditionWaker,
    workLoop,
    dispatcher,
    intakeLimit = 100,
    workLimit = 20,
    dispatchLimit = 50,
    attentionLimit = 50,
    proposalLimit = 50,
    conditionLimit = 50,
    codeJobLimit = 10,
    codeJobMemoryLimit = 50,
  } = {}) {
    this.#intake = requirePort(ledger, "intake", "ledger");
    this.#runCodeJobs = codeJobRunner == null
      ? skipCodeJobs
      : requirePort(codeJobRunner, "runCycle", "codeJobRunner");
    this.#dispatchCodeJobChangePackages =
      codeJobChangePackageDispatcher == null
        ? skipCodeJobChangePackages
        : requirePort(
            codeJobChangePackageDispatcher,
            "runCycle",
            "codeJobChangePackageDispatcher",
          );
    this.#projectCodeJobMemory = codeJobMemoryProjector == null
      ? skipCodeJobMemory
      : requirePort(
          codeJobMemoryProjector,
          "runCycle",
          "codeJobMemoryProjector",
        );
    this.#runProposals = proposalRunner == null
      ? skipProposalExecution
      : requirePort(proposalRunner, "runCycle", "proposalRunner");
    this.#reconcileProposals = requirePort(
      proposalResultReconciler,
      "runCycle",
      "proposalResultReconciler",
    );
    this.#reconcileAttention = requirePort(
      attentionResultReconciler,
      "runCycle",
      "attentionResultReconciler",
    );
    this.#wakeConditions = requirePort(
      conditionWaker,
      "runCycle",
      "conditionWaker",
    );
    this.#runWork = requirePort(workLoop, "runCycle", "workLoop");
    this.#dispatch = requirePort(dispatcher, "dispatchPending", "dispatcher");
    this.#defaults = Object.freeze({
      intakeLimit: positiveLimit(intakeLimit, "intakeLimit"),
      workLimit: positiveLimit(workLimit, "workLimit"),
      dispatchLimit: positiveLimit(dispatchLimit, "dispatchLimit"),
      attentionLimit: positiveLimit(attentionLimit, "attentionLimit"),
      proposalLimit: positiveLimit(proposalLimit, "proposalLimit"),
      conditionLimit: positiveLimit(conditionLimit, "conditionLimit"),
      codeJobLimit: positiveLimit(codeJobLimit, "codeJobLimit"),
      codeJobMemoryLimit: positiveLimit(
        codeJobMemoryLimit,
        "codeJobMemoryLimit",
      ),
    });
  }

  intake() {
    return this.#intake({ limit: this.#defaults.intakeLimit });
  }

  runCycle(input = {}) {
    const options = cycleOptions(input);
    const scope = options.includeWork
      ? `work:${options.roleId ?? NO_ROLE_SCOPE}`
      : "housekeeping";
    const running = this.#inFlightByScope.get(scope);
    if (running) return running;
    const execution = this.#cycleTail.then(() => this.#performCycle(options));
    const tracked = execution.finally(() => {
      if (this.#inFlightByScope.get(scope) === tracked) {
        this.#inFlightByScope.delete(scope);
      }
    });
    this.#inFlightByScope.set(scope, tracked);
    this.#cycleTail = tracked.catch(() => {});
    return tracked;
  }

  async #performCycle(options) {
    const stages = [
      ["code_jobs", () =>
        this.#runCodeJobs({
          limit: this.#defaults.codeJobLimit,
          ...(options.includeWork && options.roleId !== null
            ? { roleId: options.roleId }
            : {}),
        })],
      ["code_job_change_packages", () =>
        this.#dispatchCodeJobChangePackages({
          limit: this.#defaults.codeJobLimit,
        })],
      ["code_job_memory", () =>
        this.#projectCodeJobMemory({
          limit: this.#defaults.codeJobMemoryLimit,
        })],
      ["proposal_execution", () =>
        this.#runProposals({ limit: this.#defaults.proposalLimit })],
      ["proposal_results", () =>
        this.#reconcileProposals({ limit: this.#defaults.proposalLimit })],
      ["attention_results", () =>
        this.#reconcileAttention({ limit: this.#defaults.attentionLimit })],
      ["conditions", () =>
        this.#wakeConditions({ limit: this.#defaults.conditionLimit })],
    ];
    if (options.includeWork) {
      stages.push([
        "work",
        () =>
          this.#runWork({
            trigger: options.trigger,
            intakeLimit: this.#defaults.intakeLimit,
            workLimit: this.#defaults.workLimit,
            ...(options.roleId === null ? {} : { roleId: options.roleId }),
          }),
      ]);
    }
    stages.push([
      "dispatch",
      () => this.#dispatch({ limit: this.#defaults.dispatchLimit }),
    ]);
    const result = {
      trigger: options.trigger,
      includeWork: options.includeWork,
      roleId: options.roleId,
      stages: {},
    };
    const failures = [];
    for (const [name, operation] of stages) {
      try {
        result.stages[name] = { ok: true, result: await operation() };
      } catch (error) {
        const failure = stageFailure(name, error);
        failures.push(failure);
        result.stages[name] = { ok: false, code: failure.code };
      }
    }
    if (failures.length) {
      const error = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "员工主动循环有多个阶段失败");
      Object.defineProperty(error, "result", {
        configurable: false,
        enumerable: false,
        value: structuredClone(result),
        writable: false,
      });
      throw error;
    }
    return result;
  }
}
