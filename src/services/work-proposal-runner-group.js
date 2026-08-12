import { normalizeAbortSignal } from "../lib/structured-provider-request.js";

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
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("proposal runner group options are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => !["limit", "signal"].includes(key))) {
    throw new TypeError("proposal runner group options are invalid");
  }
  const descriptors = Object.fromEntries(
    ["limit", "signal"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(value, name),
    ]),
  );
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
      throw new TypeError("proposal runner group options are invalid");
    }
  }
  if (
    descriptors.limit &&
    (!Number.isSafeInteger(descriptors.limit.value) ||
      descriptors.limit.value < 1 ||
      descriptors.limit.value > 100)
  ) {
    throw new TypeError("proposal runner group limit is invalid");
  }
  const signal = normalizeAbortSignal(descriptors.signal?.value ?? null);
  return {
    ...(descriptors.limit ? { limit: descriptors.limit.value } : {}),
    ...(signal === null ? {} : { signal }),
  };
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
    options.signal?.throwIfAborted();
    const settled = await Promise.allSettled(
      this.#runners.map(({ runCycle }) => runCycle(options)),
    );
    options.signal?.throwIfAborted();
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
