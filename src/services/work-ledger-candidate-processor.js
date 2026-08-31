import { Worker } from "node:worker_threads";
import { prepareWorkLedgerCandidate } from
  "./work-ledger-candidate-validation.js";
import { workLedgerError } from "./work-ledger-values.js";

const WORKER_URL = new URL("./work-ledger-candidate-worker.js", import.meta.url);
const WORKER_EXEC_ARGV = process.execArgv.filter(
  (argument) => !argument.startsWith("--input-type"),
);
const WORKER_OPTIONS = WORKER_EXEC_ARGV.length === process.execArgv.length
  ? undefined
  : { execArgv: WORKER_EXEC_ARGV };

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
      const response = await this.#call({
        type: "prepare",
        requestId,
        candidate,
        limits,
        appendGraphMemory,
        ...(previousState === this.syncedState ? {} : { previousState }),
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
      this.pending.set(message.requestId, { resolve, reject });
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
    if (!response) return;
    this.pending.delete(message.requestId);
    if (this.pending.size === 0) worker.unref();
    if (message.ok === true) {
      response.resolve(message);
      return;
    }
    response.reject(deserializeWorkLedgerCandidateError(message.error));
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
