import { Worker } from "node:worker_threads";
import { prepareWorkLedgerCandidate } from
  "./work-ledger-candidate-validation.js";
import { WORK_LEDGER_STATE_SCHEMA_VERSION } from "./work-ledger-state.js";
import {
  hasExactLedgerKeys,
  isPlainLedgerObject,
  ledgerDataEntries,
  workLedgerError,
} from "./work-ledger-values.js";

const WORKER_URL = new URL("./work-ledger-candidate-worker.js", import.meta.url);
const WORKER_EXEC_ARGV = process.execArgv.filter(
  (argument) => !argument.startsWith("--input-type"),
);
const WORKER_OPTIONS = WORKER_EXEC_ARGV.length === process.execArgv.length
  ? undefined
  : { execArgv: WORKER_EXEC_ARGV };

const WORK_LEDGER_STATE_KEYS = Object.freeze([
  "schemaVersion",
  "revision",
  "intakeCursor",
  "sourceHighWatermark",
  "attentionCursor",
  "attentionHighWatermark",
  "proposalCursor",
  "proposalHighWatermark",
  "timelineStartSequence",
  "nextTimelineSequence",
  "items",
  "timeline",
  "outbox",
  "graphMemoryProjection",
]);
const SERIALIZED_ERROR_KEYS = new Set([
  "name",
  "message",
  "code",
  "statusCode",
  "cause",
]);

function transportDataError(message) {
  return new TypeError(`work ledger candidate transport is unsafe: ${message}`);
}

function appendTransportArrayValues(value, pending) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw transportDataError("array prototype is not preserved");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    throw transportDataError("array fields are not dense enumerable data");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw transportDataError("array fields are not dense enumerable data");
    }
    pending.push(descriptor.value);
  }
}

function appendTransportObjectValues(value, pending) {
  const entries = ledgerDataEntries(value);
  if (entries === null) {
    throw transportDataError("object fields are not plain enumerable data");
  }
  for (const [, child] of entries) pending.push(child);
}

function assertStructuredCloneStableLedgerData(...roots) {
  const pending = [...roots];
  const inspected = new WeakSet();
  while (pending.length > 0) {
    const value = pending.pop();
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      continue;
    }
    if (typeof value !== "object") {
      throw transportDataError("value is not JSON-compatible data");
    }
    if (inspected.has(value)) continue;
    inspected.add(value);
    if (Array.isArray(value)) {
      appendTransportArrayValues(value, pending);
      continue;
    }
    appendTransportObjectValues(value, pending);
  }
}

function isDenseTransportArray(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function isPreparedStateEnvelope(value, expectedRevision) {
  return (
    hasExactLedgerKeys(value, WORK_LEDGER_STATE_KEYS) &&
    value.schemaVersion === WORK_LEDGER_STATE_SCHEMA_VERSION &&
    value.revision === expectedRevision &&
    Number.isSafeInteger(value.revision) &&
    isDenseTransportArray(value.items) &&
    isDenseTransportArray(value.timeline) &&
    isDenseTransportArray(value.outbox) &&
    isPlainLedgerObject(value.graphMemoryProjection)
  );
}

function isSerializedCandidateError(value, depth = 0) {
  const entries = ledgerDataEntries(value);
  if (entries === null) return false;
  const keys = new Set(entries.map(([key]) => key));
  if (
    !keys.has("name") ||
    !keys.has("message") ||
    [...keys].some((key) => !SERIALIZED_ERROR_KEYS.has(key)) ||
    typeof value.name !== "string" ||
    typeof value.message !== "string" ||
    (keys.has("code") && typeof value.code !== "string") ||
    (keys.has("statusCode") && !Number.isSafeInteger(value.statusCode))
  ) {
    return false;
  }
  if (!keys.has("cause")) return true;
  return depth < 4 && isSerializedCandidateError(value.cause, depth + 1);
}

function isExpectedWorkerResponse(message, expectation) {
  if (message?.ok === false) {
    return hasExactLedgerKeys(message, ["requestId", "ok", "error"]) &&
      isSerializedCandidateError(message.error);
  }
  if (message?.ok !== true) return false;
  if (expectation.type === "prepare") {
    return hasExactLedgerKeys(message, ["requestId", "ok", "normalized"]) &&
      isPreparedStateEnvelope(message.normalized, expectation.expectedRevision);
  }
  return (
    (expectation.type === "commit" || expectation.type === "discard") &&
    hasExactLedgerKeys(message, ["requestId", "ok"])
  );
}

function deserializeWorkLedgerCandidateError(value) {
  const cause = value?.cause === undefined
    ? undefined
    : deserializeWorkLedgerCandidateError(value.cause);
  const options = cause === undefined ? undefined : { cause };
  const error = value?.name === "TypeError"
    ? new TypeError(value.message, options)
    : new Error(value?.message ?? "员工工作台账候选状态处理失败", options);
  if (typeof value?.code === "string") error.code = value.code;
  if (Number.isSafeInteger(value?.statusCode)) error.statusCode = value.statusCode;
  return error;
}

function candidateProcessorUnavailable(cause) {
  return workLedgerError(
    "WORK_LEDGER_STATE_CORRUPTED",
    "拒绝写入未经验证的员工工作台账",
    503,
    { cause },
  );
}

class LocalWorkLedgerCandidateProcessor {
  constructor() {
    this.prepared = false;
    this.closed = false;
  }

  async prepare(request) {
    if (this.closed) {
      throw candidateProcessorUnavailable(new Error("processor closed"));
    }
    if (this.prepared) {
      throw candidateProcessorUnavailable(
        new Error("candidate already prepared"),
      );
    }
    const normalized = prepareWorkLedgerCandidate(request);
    this.prepared = true;
    return normalized;
  }

  async commit() {
    if (!this.prepared) {
      throw candidateProcessorUnavailable(
        new Error("candidate is not prepared"),
      );
    }
    this.prepared = false;
  }

  async discard() {
    this.prepared = false;
  }

  async close() {
    this.closed = true;
    this.prepared = false;
  }
}

export function createLocalWorkLedgerCandidateProcessor() {
  return new LocalWorkLedgerCandidateProcessor();
}

class WorkerWorkLedgerCandidateProcessor {
  constructor({
    workerFactory = () => new Worker(WORKER_URL, WORKER_OPTIONS),
  } = {}) {
    if (typeof workerFactory !== "function") {
      throw new TypeError("workerFactory must be a function");
    }
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.syncedState = null;
    this.preparedState = null;
    this.preparedId = null;
    this.preparing = false;
    this.closed = false;
  }

  async prepare({ previousState, candidate, limits, appendGraphMemory = true }) {
    if (this.preparing || this.preparedId !== null) {
      throw candidateProcessorUnavailable(
        new Error("candidate already prepared"),
      );
    }
    const requestId = this.nextRequestId++;
    this.preparing = true;
    try {
      const synchronizeState = previousState !== this.syncedState;
      try {
        assertStructuredCloneStableLedgerData(
          candidate,
          limits,
          ...(synchronizeState ? [previousState] : []),
        );
      } catch (error) {
        throw candidateProcessorUnavailable(error);
      }
      const response = await this.#call({
        type: "prepare",
        requestId,
        candidate,
        limits,
        appendGraphMemory,
        ...(synchronizeState ? { previousState } : {}),
      });
      this.preparedState = response.normalized;
      this.preparedId = requestId;
      return response.normalized;
    } finally {
      this.preparing = false;
    }
  }

  async commit() {
    if (this.preparedId === null) {
      throw candidateProcessorUnavailable(new Error("candidate is not prepared"));
    }
    const preparedId = this.preparedId;
    const preparedState = this.preparedState;
    try {
      await this.#call({
        type: "commit",
        requestId: this.nextRequestId++,
        preparedId,
      });
      this.syncedState = preparedState;
    } catch (error) {
      this.syncedState = null;
      throw error;
    } finally {
      this.preparedId = null;
      this.preparedState = null;
    }
  }

  async discard() {
    if (this.preparedId === null) return;
    const preparedId = this.preparedId;
    try {
      await this.#call({
        type: "discard",
        requestId: this.nextRequestId++,
        preparedId,
      });
    } catch (error) {
      this.syncedState = null;
      throw error;
    } finally {
      this.preparedId = null;
      this.preparedState = null;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.syncedState = null;
    this.preparedId = null;
    this.preparedState = null;
    this.preparing = false;
    const failure = candidateProcessorUnavailable(new Error("processor closed"));
    for (const { reject } of this.pending.values()) reject(failure);
    this.pending.clear();
    if (worker === null) return;
    await worker.terminate();
  }

  #call(message) {
    if (this.closed) {
      return Promise.reject(
        candidateProcessorUnavailable(new Error("processor closed")),
      );
    }
    let worker;
    try {
      worker = this.#ensureWorker();
    } catch (error) {
      return Promise.reject(candidateProcessorUnavailable(error));
    }
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, {
        resolve,
        reject,
        type: message.type,
        expectedRevision: message.type === "prepare"
          ? message.candidate?.revision
          : null,
      });
      try {
        worker.postMessage(message);
      } catch (error) {
        this.pending.delete(message.requestId);
        if (this.pending.size === 0) worker.unref();
        reject(candidateProcessorUnavailable(error));
      }
    });
  }

  #ensureWorker() {
    if (this.worker !== null) return this.worker;
    const worker = this.workerFactory();
    if (
      !worker ||
      typeof worker.on !== "function" ||
      typeof worker.postMessage !== "function" ||
      typeof worker.terminate !== "function" ||
      typeof worker.ref !== "function" ||
      typeof worker.unref !== "function"
    ) {
      throw new TypeError("work ledger candidate worker is invalid");
    }
    this.worker = worker;
    worker.on("message", (message) => this.#onMessage(worker, message));
    worker.on("error", (error) => this.#onWorkerFailure(worker, error));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.#onWorkerFailure(
          worker,
          new Error(`candidate worker exited with code ${code}`),
        );
      }
    });
    worker.unref();
    return worker;
  }

  #onMessage(worker, message) {
    if (this.worker !== worker) return;
    const response = this.pending.get(message?.requestId);
    if (!response || !isExpectedWorkerResponse(message, response)) {
      this.#invalidateWorkerProtocol(worker);
      return;
    }
    this.pending.delete(message.requestId);
    if (this.pending.size === 0) worker.unref();
    if (message.ok === true) {
      response.resolve(message);
      return;
    }
    response.reject(deserializeWorkLedgerCandidateError(message.error));
  }

  #invalidateWorkerProtocol(worker) {
    this.#onWorkerFailure(
      worker,
      new TypeError("candidate worker returned an invalid response"),
    );
    try {
      worker.unref();
      Promise.resolve(worker.terminate()).catch(() => {});
    } catch {
      // The worker is already detached from authoritative state.
    }
  }

  #onWorkerFailure(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    this.syncedState = null;
    this.preparedId = null;
    this.preparedState = null;
    this.preparing = false;
    const failure = candidateProcessorUnavailable(error);
    for (const { reject } of this.pending.values()) reject(failure);
    this.pending.clear();
  }
}

export function createWorkerWorkLedgerCandidateProcessor(options) {
  return new WorkerWorkLedgerCandidateProcessor(options);
}
