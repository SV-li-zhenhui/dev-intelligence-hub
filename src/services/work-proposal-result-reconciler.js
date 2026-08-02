const MAX_BATCH = 100;
const SAFE_CODE_JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MEMORY_RECORD_ID = /^memory-[a-f0-9]{64}$/;
const CODE_JOB_OUTCOMES = new Set([
  "succeeded",
  "failed",
  "stale",
  "rejected",
  "unknown",
]);
const TERMINAL_CODE_JOB_STATUSES = new Set([
  "completed",
  "failed",
  "fenced",
  "cancelled",
]);
const CODE_JOB_STATUS_BY_OUTCOME = new Map([
  ["succeeded", "completed"],
  ["failed", "failed"],
  ["unknown", "fenced"],
  ["rejected", "cancelled"],
]);
const CODE_JOB_STATUSES = new Set([
  "queued",
  "starting",
  "active",
  "pausing",
  "unknown",
  "paused",
  "cancelling",
  ...TERMINAL_CODE_JOB_STATUSES,
]);
const BATCH_KEYS = Object.freeze([
  "items",
  "nextSequence",
  "highWatermark",
  "oldestAvailableSequence",
]);

export class WorkProposalResultReconcilerError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = "WorkProposalResultReconcilerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalidCodeJobEvidence() {
  return new WorkProposalResultReconcilerError(
    "WORK_PROPOSAL_CODE_JOB_EVIDENCE_INVALID",
    "工作提案的代码任务证据无效",
  );
}

function invalidBatch() {
  return new TypeError("proposal result batch is invalid");
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function ownDataField(value, key, error) {
  if (!isPlainObject(value)) throw error;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
  return descriptor.value;
}

function objectFields(value, { required, allowed = required }, error) {
  if (!isPlainObject(value)) throw error;
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  const fields = new Map(entries);
  if (required.some((key) => !fields.has(key))) throw error;
  return fields;
}

function arrayValues(value, maximum, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function boundMethod(value, method, name) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
  let owner = value;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, method);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${name} is invalid`);
      }
      return descriptor.value.bind(value);
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new TypeError(`${name} is invalid`);
}

function bindPort(value, methods, name) {
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, boundMethod(value, method, name)]),
    ),
  );
}

function constructorOptions(value) {
  return objectFields(
    value,
    {
      required: ["proposalConsumer", "ledger"],
      allowed: ["proposalConsumer", "ledger", "codeJobReader"],
    },
    new TypeError("WorkProposalResultReconciler options are invalid"),
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
  const error = new TypeError("ledger proposal checkpoint is invalid");
  const cursor = ownDataField(summary, "proposalCursor", error);
  if (!Number.isSafeInteger(cursor) || Object.is(cursor, -0) || cursor < 0) {
    throw error;
  }
  return cursor;
}

function safeSequence(value) {
  return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 1;
}

function normalizeGateBatch(value, checkpoint) {
  const error = invalidBatch();
  const fields = objectFields(
    value,
    { required: BATCH_KEYS },
    error,
  );
  const items = arrayValues(fields.get("items"), MAX_BATCH, error);
  const itemDetails = items.map((item) => ({
    item,
    sequence: ownDataField(item, "sequence", error),
    kind: ownDataField(item, "kind", error),
  }));
  const nextSequence = fields.get("nextSequence");
  const highWatermark = fields.get("highWatermark");
  const oldestAvailableSequence = fields.get("oldestAvailableSequence");
  if (
    !Number.isSafeInteger(nextSequence) ||
    Object.is(nextSequence, -0) ||
    nextSequence < 0 ||
    !Number.isSafeInteger(highWatermark) ||
    Object.is(highWatermark, -0) ||
    highWatermark < checkpoint ||
    nextSequence > highWatermark ||
    !(
      oldestAvailableSequence === null ||
      safeSequence(oldestAvailableSequence)
    ) ||
    (itemDetails.length === 0 && nextSequence !== checkpoint) ||
    (itemDetails.length > 0 &&
      (checkpoint === Number.MAX_SAFE_INTEGER ||
        itemDetails[0].sequence !== checkpoint + 1 ||
        itemDetails.some(
          ({ sequence }, index) =>
            !safeSequence(sequence) ||
            (index > 0 && sequence !== itemDetails[index - 1].sequence + 1),
        ) ||
        itemDetails.at(-1).sequence !== nextSequence))
  ) {
    throw error;
  }
  return {
    itemDetails,
    highWatermark,
    oldestAvailableSequence,
  };
}

function codeJobReference(result, outcome) {
  const error = invalidCodeJobEvidence();
  const evidence = arrayValues(
    ownDataField(result, "evidence", error),
    20,
    error,
  );
  if (evidence.some((entry) => typeof entry !== "string")) throw error;
  const references = evidence.filter((entry) => entry.startsWith("code-job:"));
  if (
    references.length > 1 ||
    (references.length === 1 &&
      !SAFE_CODE_JOB_ID.test(references[0].slice("code-job:".length)))
  ) {
    throw error;
  }
  const memoryReferences = evidence.filter((entry) => entry.startsWith("memory:"));
  if (references.length === 0) {
    if (outcome === "succeeded" || memoryReferences.length > 0) throw error;
    return null;
  }
  return {
    jobId: references[0].slice("code-job:".length),
    memoryReferences,
  };
}

function normalizeGateJob(value, expectedJobId) {
  const error = invalidCodeJobEvidence();
  const jobId = ownDataField(value, "jobId", error);
  const status = ownDataField(value, "status", error);
  const rawMemoryProjection = ownDataField(value, "memoryProjection", error);
  if (
    jobId !== expectedJobId ||
    !SAFE_CODE_JOB_ID.test(jobId) ||
    !CODE_JOB_STATUSES.has(status)
  ) {
    throw error;
  }
  if (rawMemoryProjection === null) {
    return { jobId, status, memoryProjection: null };
  }
  const memory = objectFields(
    rawMemoryProjection,
    { required: ["recordId", "projectedAt"] },
    error,
  );
  const recordId = memory.get("recordId");
  const projectedAt = memory.get("projectedAt");
  if (
    typeof recordId !== "string" ||
    !MEMORY_RECORD_ID.test(recordId) ||
    typeof projectedAt !== "string" ||
    !Number.isFinite(Date.parse(projectedAt)) ||
    new Date(Date.parse(projectedAt)).toISOString() !== projectedAt
  ) {
    throw error;
  }
  return {
    jobId,
    status,
    memoryProjection: { recordId, projectedAt },
  };
}

function memoryEvidenceMatches(references, recordId) {
  const expected = `memory:${recordId}`;
  return references.length === 1 && references[0] === expected;
}

export class WorkProposalResultReconciler {
  #readResultBatch;
  #getSummary;
  #applyProposalBatch;
  #getCodeJob = null;
  #inFlight = null;

  constructor(options = {}) {
    const fields = constructorOptions(options);
    this.#readResultBatch = bindPort(
      fields.get("proposalConsumer"),
      ["readResultBatch"],
      "proposalConsumer",
    ).readResultBatch;
    const ledgerPort = bindPort(
      fields.get("ledger"),
      ["getSummary", "applyProposalBatch"],
      "ledger",
    );
    this.#getSummary = ledgerPort.getSummary;
    this.#applyProposalBatch = ledgerPort.applyProposalBatch;
    if (fields.has("codeJobReader")) {
      this.#getCodeJob = bindPort(
        fields.get("codeJobReader"),
        ["get"],
        "codeJobReader",
      ).get;
    }
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

  async #isReady(result) {
    const error = invalidCodeJobEvidence();
    const outcome = ownDataField(result, "outcome", error);
    if (!CODE_JOB_OUTCOMES.has(outcome)) throw error;
    const reference = codeJobReference(result, outcome);
    if (reference === null) return true;
    const job = normalizeGateJob(await this.#getCodeJob(reference.jobId), reference.jobId);
    if (!TERMINAL_CODE_JOB_STATUSES.has(job.status)) return false;
    if (job.memoryProjection === null) return false;
    if (
      !memoryEvidenceMatches(
        reference.memoryReferences,
        job.memoryProjection.recordId,
      ) ||
      (CODE_JOB_STATUS_BY_OUTCOME.has(outcome) &&
        job.status !== CODE_JOB_STATUS_BY_OUTCOME.get(outcome))
    ) {
      throw error;
    }
    return true;
  }

  async #readyPrefix(batch, checkpoint) {
    const source = normalizeGateBatch(batch, checkpoint);
    const items = [];
    let nextSequence = checkpoint;
    for (const detail of source.itemDetails) {
      if (
        detail.kind === "code_action_proposal" &&
        !(await this.#isReady(detail.item))
      ) {
        break;
      }
      items.push(detail.item);
      nextSequence = detail.sequence;
    }
    return {
      items,
      nextSequence,
      highWatermark: source.highWatermark,
      oldestAvailableSequence: source.oldestAvailableSequence,
    };
  }

  async #run(limit) {
    const checkpoint = proposalCursor(await this.#getSummary());
    const batch = await this.#readResultBatch({
      afterSequence: checkpoint,
      limit,
    });
    // Release the proposal reader before the ledger acquires its writer.
    const applicable = this.#getCodeJob === null
      ? batch
      : await this.#readyPrefix(batch, checkpoint);
    return this.#applyProposalBatch(applicable);
  }
}
