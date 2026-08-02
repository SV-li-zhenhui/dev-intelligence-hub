const MAX_BATCH = 100;

function bindPort(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.fromEntries(
    methods.map((method) => [method, value[method].bind(value)]),
  );
}

function cycleLimit(value = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== "limit")) {
    throw new TypeError("runCycle options are invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "limit");
  if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
    throw new TypeError("runCycle options are invalid");
  }
  const limit = descriptor ? descriptor.value : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new TypeError(`limit must be between 1 and ${MAX_BATCH}`);
  }
  return limit;
}

function proposalCursor(summary) {
  if (
    summary === null ||
    typeof summary !== "object" ||
    Array.isArray(summary) ||
    !Number.isSafeInteger(summary.proposalCursor) ||
    summary.proposalCursor < 0
  ) {
    throw new TypeError("ledger proposal checkpoint is invalid");
  }
  return summary.proposalCursor;
}

export class WorkProposalResultReconciler {
  #readResultBatch;
  #getSummary;
  #applyProposalBatch;
  #inFlight = null;

  constructor({ proposalConsumer, ledger } = {}) {
    this.#readResultBatch = bindPort(
      proposalConsumer,
      ["readResultBatch"],
      "proposalConsumer",
    ).readResultBatch;
    const ledgerPort = bindPort(
      ledger,
      ["getSummary", "applyProposalBatch"],
      "ledger",
    );
    this.#getSummary = ledgerPort.getSummary;
    this.#applyProposalBatch = ledgerPort.applyProposalBatch;
  }

  runCycle(options = {}) {
    if (this.#inFlight) return this.#inFlight;
    const limit = cycleLimit(options);
    const execution = Promise.resolve().then(() => this.#run(limit));
    const tracked = execution.finally(() => {
      if (this.#inFlight === tracked) this.#inFlight = null;
    });
    this.#inFlight = tracked;
    return tracked;
  }

  async #run(limit) {
    const checkpoint = proposalCursor(await this.#getSummary());
    const batch = await this.#readResultBatch({
      afterSequence: checkpoint,
      limit,
    });
    // Release the proposal reader before the ledger acquires its writer.
    return this.#applyProposalBatch(batch);
  }
}
