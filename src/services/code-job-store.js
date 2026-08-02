import {
  cloneCodeJobValue,
  codeJobError,
  codeJobIdForGrant,
  createQueuedCodeJob,
  normalizeApprovedCodeJobRequest,
  normalizeCodeJob,
  normalizeCodeJobTimestamp,
  projectCodeJobForBrowser,
} from "../domain/code-job-contract.js";

export const CODE_JOB_STATE_KEY = "code-job-state";

const MAX_JOBS = 1_000;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const JOB_ID = /^code-job-[a-f0-9]{55}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function storeError(code, message, statusCode = 400, options) {
  return codeJobError(code, message, statusCode, options);
}

function invalidState(message = "代码任务持久化状态无效") {
  return storeError("CODE_JOB_STATE_INVALID", message, 500);
}

function corruptedState(cause) {
  return storeError("CODE_JOB_STATE_CORRUPTED", "代码任务持久化状态损坏", 500, {
    cause,
  });
}

function bindingConflict() {
  return storeError(
    "CODE_JOB_BINDING_CONFLICT",
    "代码任务已绑定不同的批准、提案或授权内容",
    409,
  );
}

function capacityExceeded() {
  return storeError("CODE_JOB_CAPACITY_EXCEEDED", "代码任务本地容量已满", 507);
}

function uncertainState(writeError, recoveryError) {
  return storeError(
    "CODE_JOB_STATE_UNCERTAIN",
    "代码任务持久化结果无法确认",
    500,
    { cause: new AggregateError([writeError, recoveryError]) },
  );
}

function validateDependency(value, methods, name) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${name} is invalid`);
  }
}

function plainDataKeys(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
  }
  return keys;
}

function assertExactKeys(value, expected, error) {
  const keys = plainDataKeys(value, error);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw error;
  }
  return value;
}

function denseArray(value, maximumLength, error) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

function safeInteger(value, minimum, maximum, error) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    throw error;
  }
  return value;
}

function normalizeLimits(value = {}) {
  const error = new TypeError("limits is invalid");
  const allowed = ["maximumJobs", "maximumStateBytes"];
  const keys = plainDataKeys(value, error);
  if (keys.some((key) => !allowed.includes(key))) throw error;
  const positive = (candidate, fallback, maximum) => {
    const resolved = candidate ?? fallback;
    if (
      !Number.isSafeInteger(resolved) ||
      resolved < 1 ||
      resolved > maximum
    ) {
      throw error;
    }
    return resolved;
  };
  return Object.freeze({
    maximumJobs: positive(value.maximumJobs, MAX_JOBS, MAX_JOBS),
    maximumStateBytes: positive(
      value.maximumStateBytes,
      MAX_STATE_BYTES,
      MAX_STATE_BYTES,
    ),
  });
}

function defaultState() {
  return { schemaVersion: 1, revision: 0, nextJobSequence: 1, jobs: [] };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeStateValue(value, limits) {
  const error = invalidState();
  assertExactKeys(
    value,
    ["schemaVersion", "revision", "nextJobSequence", "jobs"],
    error,
  );
  if (value.schemaVersion !== 1) throw error;
  const revision = safeInteger(
    value.revision,
    0,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const jobs = denseArray(value.jobs, limits.maximumJobs, error).map((entry) => {
    try {
      return normalizeCodeJob(entry);
    } catch {
      throw error;
    }
  });
  const unique = (selector) =>
    new Set(jobs.map(selector)).size === jobs.length;
  const nextJobSequence = safeInteger(
    value.nextJobSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    error,
  );
  const maximumRevision = jobs.reduce(
    (maximum, job) => Math.max(maximum, job.revision),
    0,
  );
  if (
    revision < jobs.length ||
    maximumRevision !== revision ||
    nextJobSequence !== jobs.length + 1 ||
    !unique((job) => job.sequence) ||
    !unique((job) => job.revision) ||
    !unique((job) => job.jobId) ||
    !unique((job) => job.proposal.proposalId) ||
    !unique((job) => job.approval.confirmationId) ||
    !unique((job) => job.approval.approvalBindingDigest)
  ) {
    throw error;
  }
  const created = [...jobs].sort((left, right) => left.sequence - right.sequence);
  for (let index = 0; index < created.length; index += 1) {
    if (
      created[index].sequence !== index + 1 ||
      (index > 0 &&
        Date.parse(created[index].createdAt) <
          Date.parse(created[index - 1].createdAt))
    ) {
      throw error;
    }
  }
  const state = { schemaVersion: 1, revision, nextJobSequence, jobs };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > limits.maximumStateBytes) {
    throw error;
  }
  return state;
}

function normalizeState(value, limits) {
  try {
    return normalizeStateValue(value, limits);
  } catch (error) {
    if (error?.code === "CODE_JOB_STATE_CORRUPTED") throw error;
    throw corruptedState(error);
  }
}

function normalizeJobId(value) {
  if (typeof value !== "string" || !JOB_ID.test(value)) {
    throw storeError("INVALID_CODE_JOB_QUERY", "代码任务查询无效");
  }
  return value;
}

function normalizeListOptions(value = {}) {
  const error = storeError("INVALID_CODE_JOB_QUERY", "代码任务查询无效");
  const keys = plainDataKeys(value, error);
  if (
    keys.some(
      (key) => !["limit", "cursor", "status", "order"].includes(key),
    )
  ) {
    throw error;
  }
  const rawLimit = Object.hasOwn(value, "limit") ? value.limit : 50;
  const parsedLimit =
    typeof rawLimit === "string" && /^[1-9][0-9]{0,2}$/.test(rawLimit)
      ? Number(rawLimit)
      : rawLimit;
  const order = value.order ?? "newest";
  const status = value.status ?? null;
  if (order !== "newest" || (status !== null && status !== "queued")) {
    throw error;
  }
  return {
    limit: safeInteger(parsedLimit, 1, 100, error),
    cursor:
      value.cursor === undefined ? null : normalizeJobId(value.cursor),
    status,
  };
}

function sameAuthorization(job, request) {
  return (
    job.jobId === codeJobIdForGrant(request.grant) &&
    job.approval.confirmationId === request.confirmationId &&
    job.approval.displayedPayloadDigest === request.displayedPayloadDigest &&
    job.approval.approvalBindingDigest === request.approvalBindingDigest &&
    job.proposal.proposalId === request.grant.proposalId &&
    job.proposal.contentDigest === request.grant.contentDigest &&
    sameValue(job.grant, request.grant)
  );
}

function creationResult(status, job) {
  return cloneCodeJobValue({
    status,
    receipt: { id: job.jobId, createdAt: job.createdAt },
    job: projectCodeJobForBrowser(job),
  });
}

function findBoundJob(state, request) {
  const jobId = codeJobIdForGrant(request.grant);
  return state.jobs.find(
    (job) =>
      job.jobId === jobId ||
      job.proposal.proposalId === request.grant.proposalId ||
      job.approval.confirmationId === request.confirmationId ||
      job.approval.approvalBindingDigest === request.approvalBindingDigest,
  ) || null;
}

export class CodeJobStore {
  constructor({
    store,
    exclusiveLease,
    operationQueue,
    clock = () => new Date(),
    limits = {},
  } = {}) {
    validateDependency(store, ["read", "write"], "store");
    validateDependency(exclusiveLease, ["run"], "exclusiveLease");
    validateDependency(operationQueue, ["enqueue"], "operationQueue");
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.store = store;
    this.exclusiveLease = exclusiveLease;
    this.operationQueue = operationQueue;
    this.clock = clock;
    this.limits = normalizeLimits(limits);
    this.state = defaultState();
    this.ready = false;
  }

  recover() {
    return this.operationQueue.enqueue(async () => {
      this.ready = false;
      return this.exclusiveLease.run(async () => {
        const durable = await this.store.read(CODE_JOB_STATE_KEY, defaultState());
        const recovered = normalizeState(durable, this.limits);
        this.#acceptDurableState(recovered);
        this.ready = true;
        return { revision: recovered.revision, count: recovered.jobs.length };
      });
    });
  }

  createApprovedJob(value) {
    const request = normalizeApprovedCodeJobRequest(value);
    return this.#mutate((state) => {
      const existing = findBoundJob(state, request);
      if (existing) {
        if (!sameAuthorization(existing, request)) throw bindingConflict();
        return {
          state,
          value: creationResult("already", existing),
          write: false,
        };
      }
      if (state.jobs.length >= this.limits.maximumJobs) throw capacityExceeded();
      const revision = state.revision + 1;
      const created = createQueuedCodeJob(request, {
        sequence: state.nextJobSequence,
        revision,
        createdAt: this.#now(state),
      });
      return {
        state: {
          ...state,
          revision,
          nextJobSequence: state.nextJobSequence + 1,
          jobs: [...state.jobs, created],
        },
        value: creationResult("applied", created),
        write: true,
      };
    });
  }

  reconcileApprovedJob(value) {
    const request = normalizeApprovedCodeJobRequest(value);
    return this.#query(() => {
      const existing = findBoundJob(this.state, request);
      if (!existing) return { status: "absent" };
      if (!sameAuthorization(existing, request)) throw bindingConflict();
      return creationResult("already", existing);
    });
  }

  get(value) {
    const jobId = normalizeJobId(value);
    return this.#query(() => {
      const job = this.state.jobs.find((candidate) => candidate.jobId === jobId);
      return job ? projectCodeJobForBrowser(job) : null;
    });
  }

  list(value = {}) {
    const { limit, cursor, status } = normalizeListOptions(value);
    return this.#query(() => {
      const ordered = this.state.jobs
        .filter((job) => status === null || job.status === status)
        .sort(
          (left, right) =>
            Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            right.sequence - left.sequence,
        );
      const cursorIndex = cursor === null
        ? -1
        : ordered.findIndex((job) => job.jobId === cursor);
      if (cursor !== null && cursorIndex < 0) {
        throw storeError("INVALID_CODE_JOB_QUERY", "代码任务查询游标无效");
      }
      const start = cursorIndex + 1;
      const page = ordered.slice(start, start + limit);
      return {
        revision: this.state.revision,
        total: ordered.length,
        items: page.map(projectCodeJobForBrowser),
        nextCursor:
          start + page.length < ordered.length ? page.at(-1).jobId : null,
      };
    });
  }

  listNewest(value = {}) {
    return this.list(value);
  }

  #query(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return operation();
    });
  }

  #mutate(operation) {
    return this.operationQueue.enqueue(() => {
      this.#assertReady();
      return this.exclusiveLease.run(async () => {
        const durable = await this.#readDurableState();
        const change = operation(durable);
        if (!change.write) return change.value;
        this.#assertCapacity(change.state);
        const candidate = normalizeState(change.state, this.limits);
        try {
          await this.store.write(CODE_JOB_STATE_KEY, candidate);
        } catch (writeError) {
          await this.#reconcileFailedWrite(writeError);
          throw writeError;
        }
        this.state = candidate;
        return change.value;
      });
    });
  }

  async #readDurableState() {
    try {
      const durable = normalizeState(
        await this.store.read(CODE_JOB_STATE_KEY, defaultState()),
        this.limits,
      );
      this.#acceptDurableState(durable);
      return durable;
    } catch (error) {
      this.ready = false;
      throw error;
    }
  }

  async #reconcileFailedWrite(writeError) {
    try {
      await this.#readDurableState();
    } catch (recoveryError) {
      this.ready = false;
      throw uncertainState(writeError, recoveryError);
    }
  }

  #acceptDurableState(durable) {
    if (durable.revision < this.state.revision) {
      throw storeError(
        "CODE_JOB_STATE_ROLLBACK",
        "代码任务持久化状态发生回退",
        500,
      );
    }
    if (durable.revision === this.state.revision && !sameValue(durable, this.state)) {
      throw storeError(
        "CODE_JOB_STATE_FORKED",
        "代码任务持久化状态发生分叉",
        500,
      );
    }
    this.state = durable;
  }

  #assertCapacity(state) {
    if (
      state.jobs.length > this.limits.maximumJobs ||
      Buffer.byteLength(JSON.stringify(state), "utf8") >
        this.limits.maximumStateBytes
    ) {
      throw capacityExceeded();
    }
  }

  #assertReady() {
    if (!this.ready) {
      throw storeError(
        "CODE_JOB_STORE_NOT_READY",
        "代码任务存储尚未完成恢复",
        503,
      );
    }
  }

  #now(state) {
    const error = storeError("CODE_JOB_CLOCK_INVALID", "代码任务时钟无效", 500);
    const now = normalizeCodeJobTimestamp(this.clock(), error);
    const latest = state.jobs.reduce(
      (maximum, job) =>
        Date.parse(job.updatedAt) > Date.parse(maximum) ? job.updatedAt : maximum,
      "1970-01-01T00:00:00.000Z",
    );
    if (Date.parse(now) < Date.parse(latest)) throw error;
    return now;
  }
}
