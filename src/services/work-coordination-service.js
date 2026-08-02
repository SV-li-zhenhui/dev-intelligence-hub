const SAFE_TRIGGER = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;

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

function stageFailure(stage, error) {
  const wrapped = new Error(`员工主动循环阶段失败: ${stage}`, { cause: error });
  wrapped.code = "WORK_COORDINATION_STAGE_FAILED";
  wrapped.stage = stage;
  return wrapped;
}

export class WorkCoordinationService {
  #intake;
  #reconcileAttention;
  #wakeConditions;
  #runWork;
  #dispatch;
  #defaults;
  #inFlight = null;

  constructor({
    ledger,
    attentionResultReconciler,
    conditionWaker,
    workLoop,
    dispatcher,
    intakeLimit = 100,
    workLimit = 20,
    dispatchLimit = 50,
    attentionLimit = 50,
    conditionLimit = 50,
  } = {}) {
    this.#intake = requirePort(ledger, "intake", "ledger");
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
      conditionLimit: positiveLimit(conditionLimit, "conditionLimit"),
    });
  }

  intake() {
    return this.#intake({ limit: this.#defaults.intakeLimit });
  }

  runCycle({ trigger = "scheduled" } = {}) {
    if (this.#inFlight) return this.#inFlight;
    const normalizedTrigger = safeTrigger(trigger);
    const execution = Promise.resolve().then(() =>
      this.#performCycle(normalizedTrigger),
    );
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #performCycle(trigger) {
    const stages = [
      ["attention_results", () =>
        this.#reconcileAttention({ limit: this.#defaults.attentionLimit })],
      ["conditions", () =>
        this.#wakeConditions({ limit: this.#defaults.conditionLimit })],
      ["work", () =>
        this.#runWork({
          trigger,
          intakeLimit: this.#defaults.intakeLimit,
          workLimit: this.#defaults.workLimit,
        })],
      ["dispatch", () =>
        this.#dispatch({ limit: this.#defaults.dispatchLimit })],
    ];
    const result = { trigger, stages: {} };
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
