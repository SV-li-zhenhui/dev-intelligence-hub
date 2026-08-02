function runnerPort(value, index) {
  if (!value || typeof value.runCycle !== "function") {
    throw new TypeError(`runners[${index}] must provide runCycle`);
  }
  return Object.freeze({ runCycle: value.runCycle.bind(value) });
}

function normalizeOptions(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => key !== "limit")
  ) {
    throw new TypeError("proposal runner group options are invalid");
  }
  if (
    value.limit !== undefined &&
    (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)
  ) {
    throw new TypeError("proposal runner group limit is invalid");
  }
  return value.limit === undefined ? {} : { limit: value.limit };
}

export class WorkProposalRunnerGroup {
  #runners;

  constructor({ runners = [] } = {}) {
    if (
      !Array.isArray(runners) ||
      Object.getPrototypeOf(runners) !== Array.prototype ||
      runners.length < 1 ||
      runners.length > 16
    ) {
      throw new TypeError("runners are invalid");
    }
    this.#runners = runners.map(runnerPort);
    Object.freeze(this);
  }

  async runCycle(value = {}) {
    const options = normalizeOptions(value);
    const settled = await Promise.allSettled(
      this.#runners.map(({ runCycle }) => runCycle(options)),
    );
    const failures = settled
      .filter(({ status }) => status === "rejected")
      .map(({ reason }) => reason);
    if (failures.length) {
      throw new AggregateError(
        failures,
        "one or more work proposal runners failed",
      );
    }
    return Object.freeze({
      runners: Object.freeze(settled.map(({ value: result }) => result)),
    });
  }
}

export function createWorkProposalRunnerGroup(runners) {
  const configured = runners.filter(Boolean);
  if (configured.length === 0) return null;
  if (configured.length === 1) return configured[0];
  return new WorkProposalRunnerGroup({ runners: configured });
}
