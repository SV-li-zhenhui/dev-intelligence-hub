import {
  cloneConfirmationValue,
  ConfirmationQueueError,
  defaultConfirmationState,
  normalizeConfirmationInvalidation,
  normalizeConfirmationPlan,
  normalizeConfirmationReceipt,
  normalizeConfirmationRequest,
  normalizeConfirmationState,
} from "../domain/confirmation-contract.js";
import { OperationQueue } from "../lib/operation-queue.js";

const STATE_KEY = "confirmation-queue";
const MAX_ITEMS = 1_000;

export class ConfirmationExecutionError extends Error {
  constructor(code, outcome, { cause } = {}) {
    super(
      outcome === "absent"
        ? "外部动作已确认未发生"
        : "外部动作结果无法确认",
      cause === undefined ? undefined : { cause },
    );
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) {
      throw new TypeError("Confirmation execution error code is invalid");
    }
    if (!new Set(["absent", "unknown"]).has(outcome)) {
      throw new TypeError("Confirmation execution outcome is invalid");
    }
    this.name = "ConfirmationExecutionError";
    this.code = code;
    this.outcome = outcome;
  }
}

function queueError(code, message, statusCode) {
  return new ConfirmationQueueError(code, message, statusCode);
}

function clone(value) {
  return cloneConfirmationValue(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeReceipt(value) {
  try {
    return normalizeConfirmationReceipt(value);
  } catch (error) {
    throw new ConfirmationExecutionError(
      "EXTERNAL_PROTOCOL_ERROR",
      "unknown",
      { cause: error },
    );
  }
}

function normalizeExecutorResult(value) {
  if (!isObject(value) || typeof value.status !== "string") {
    return { status: "unknown", code: "EXTERNAL_PROTOCOL_ERROR" };
  }
  if (value.status === "applied" || value.status === "already") {
    try {
      return {
        status: value.status,
        receipt: normalizeReceipt(value.receipt),
      };
    } catch (error) {
      return { status: "unknown", code: error.code };
    }
  }
  if (value.status === "stale") return { status: "stale" };
  if (value.status === "absent") {
    return {
      status: "absent",
      code:
        typeof value.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(value.code)
          ? value.code
          : "EXTERNAL_ACTION_ABSENT",
    };
  }
  if (value.status === "error") {
    const outcome = value.error?.trust === "absent" ? "absent" : "unknown";
    const code =
      typeof value.error?.code === "string" &&
      /^[A-Z][A-Z0-9_]{2,63}$/.test(value.error.code)
        ? value.error.code
        : "EXTERNAL_OUTCOME_UNKNOWN";
    return { status: outcome, code };
  }
  return { status: "unknown", code: "EXTERNAL_PROTOCOL_ERROR" };
}

function errorOutcome(error) {
  if (error instanceof ConfirmationExecutionError) {
    return { status: error.outcome, code: error.code };
  }
  return { status: "unknown", code: "EXTERNAL_OUTCOME_UNKNOWN" };
}

function byCreation(left, right) {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export class ConfirmationQueue {
  constructor({
    store,
    executor,
    operationQueue = new OperationQueue(),
    exclusiveLease,
    clock = () => new Date(),
  }) {
    if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
      throw new TypeError("store must provide read and write");
    }
    if (
      !executor ||
      typeof executor.execute !== "function" ||
      typeof executor.reconcile !== "function"
    ) {
      throw new TypeError("executor must provide execute and reconcile");
    }
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("operationQueue must provide enqueue");
    }
    if (!exclusiveLease || typeof exclusiveLease.run !== "function") {
      throw new TypeError("exclusiveLease must provide run");
    }
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.store = store;
    this.executor = executor;
    this.operationQueue = operationQueue;
    this.exclusiveLease = exclusiveLease;
    this.clock = clock;
    this.state = defaultConfirmationState();
    this.ready = false;
    this.recoveryPromise = null;
    this.liveRequests = new Map();
    this.producerVetoes = new Map();
  }

  async recover() {
    if (this.ready) return this.next();
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.operationQueue.enqueue(() =>
        this.exclusiveLease.run(async () => {
          this.ready = false;
          await this.#reload();
          const recoverableIds = this.state.items
            .filter(
              (item) =>
                item.status === "executing" ||
                (item.status === "failed" && item.failure?.outcome === "unknown"),
            )
            .map((item) => item.id);
          for (const id of recoverableIds) await this.#recoverItem(id);
          this.ready = true;
          return this.#projectNext();
        }),
      );
    }
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async enqueue(input) {
    this.#assertReady();
    const plan = normalizeConfirmationPlan(input);
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        await this.#reload();
        const existing = this.#find(plan.id);
        if (existing) {
          if (existing.approvalBindingDigest !== plan.approvalBindingDigest) {
            throw queueError(
              "CONFIRMATION_ID_CONFLICT",
              "同一确认 ID 已绑定其他动作",
              409,
            );
          }
          if (this.#isProducerVetoed(existing)) {
            return this.#invalidate(
              existing.id,
              this.producerVetoes.get(existing.id),
            );
          }
          return this.#projectItem(existing);
        }
        if (this.state.items.length >= MAX_ITEMS) {
          throw queueError(
            "CONFIRMATION_QUEUE_CAPACITY",
            "确认队列已达到容量上限",
            507,
          );
        }
        const timestamp = this.#now();
        let item = {
          ...plan,
          status: "pending",
          itemRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          execution: null,
          receipt: null,
          failure: null,
          rejection: null,
          invalidation: null,
        };
        const veto = this.producerVetoes.get(item.id);
        if (this.#isProducerVetoed(item)) {
          item = {
            ...item,
            status: "stale",
            invalidation: { ...clone(veto), at: timestamp },
          };
        }
        await this.#persist({
          ...this.state,
          revision: this.state.revision + 1,
          items: [...this.state.items, item],
        });
        return this.#projectItem(this.#find(plan.id));
      }),
    );
  }

  async next() {
    this.#assertReady();
    return this.#projectNext();
  }

  async get(id) {
    this.#assertReady();
    const item = this.#requireItem(id);
    return this.#projectItem(item);
  }

  async approve(id, input) {
    this.#assertReady();
    const request = normalizeConfirmationRequest(input);
    return this.#runIdempotent("approve", id, request, () =>
      this.#approve(id, request),
    );
  }

  async retry(id, input) {
    this.#assertReady();
    const request = normalizeConfirmationRequest(input);
    return this.#runIdempotent("retry", id, request, () =>
      this.#retry(id, request),
    );
  }

  async reject(id, input) {
    this.#assertReady();
    const request = normalizeConfirmationRequest(input, { allowReason: true });
    return this.#runIdempotent("reject", id, request, () =>
      this.#reject(id, request),
    );
  }

  async invalidate(id, input) {
    this.#assertReady();
    const invalidation = normalizeConfirmationInvalidation(input);
    return this.operationQueue.enqueue(() =>
      this.exclusiveLease.run(async () => {
        const previousVeto = this.producerVetoes.get(id);
        this.#setProducerVeto(id, invalidation);
        try {
          await this.#reload();
          return await this.#invalidate(id, invalidation);
        } catch (error) {
          if (previousVeto) {
            this.producerVetoes.set(id, previousVeto);
          } else if (
            [
              "CONFIRMATION_PRODUCER_MISMATCH",
              "CONFIRMATION_NOT_INVALIDATABLE",
            ].includes(error?.code)
          ) {
            this.producerVetoes.delete(id);
          }
          throw error;
        }
      }),
    );
  }

  #runIdempotent(operation, id, request, task) {
    const key = [
      operation,
      id,
      request.requestId,
      request.displayedPayloadDigest,
      request.approvalBindingDigest,
    ].join("\u0000");
    const active = this.liveRequests.get(key);
    if (active) return active;
    const promise = this.operationQueue
      .enqueue(() =>
        this.exclusiveLease.run(async () => {
          await this.#reload();
          return task();
        }),
      )
      .finally(() => {
        if (this.liveRequests.get(key) === promise) this.liveRequests.delete(key);
      });
    this.liveRequests.set(key, promise);
    return promise;
  }

  async #approve(id, request) {
    const item = this.#requireItem(id);
    this.#assertBinding(item, request, { revisions: item.status === "pending" });
    if (["completed", "stale"].includes(item.status)) {
      return this.#projectItem(item);
    }
    this.#assertNotProducerVetoed(item);
    if (item.status !== "pending") {
      throw queueError(
        "CONFIRMATION_NOT_PENDING",
        "该动作已不在待确认状态",
        409,
      );
    }
    return this.#execute(item, request);
  }

  async #retry(id, request) {
    let item = this.#requireItem(id);
    this.#assertBinding(item, request, { revisions: true });
    this.#assertNotProducerVetoed(item);
    if (item.status !== "failed" || !item.failure?.retryable) {
      throw queueError(
        "CONFIRMATION_NOT_RETRYABLE",
        "该动作不能安全重试",
        409,
      );
    }

    const reconciled = await this.#invokeReconcile(item);
    if (reconciled.status !== "absent") {
      await this.#finalize(item, reconciled);
      return this.#projectItem(this.#requireItem(id));
    }
    item = this.#requireItem(id);
    return this.#execute(item, request);
  }

  async #reject(id, request) {
    const item = this.#requireItem(id);
    this.#assertBinding(item, request, {
      revisions: item.status === "pending" || item.status === "failed",
    });
    if (item.status === "rejected" && item.rejection?.requestId === request.requestId) {
      return this.#projectItem(item);
    }
    this.#assertNotProducerVetoed(item);
    if (!new Set(["pending", "failed"]).has(item.status)) {
      throw queueError(
        "CONFIRMATION_NOT_REJECTABLE",
        "该动作不能再拒绝",
        409,
      );
    }
    const timestamp = this.#now();
    await this.#replaceItem(item.id, {
      ...item,
      status: "rejected",
      itemRevision: item.itemRevision + 1,
      updatedAt: timestamp,
      execution: null,
      receipt: null,
      failure: null,
      rejection: {
        requestId: request.requestId,
        reason: request.reason || "",
        at: timestamp,
      },
      invalidation: null,
    });
    return this.#projectItem(this.#requireItem(id));
  }

  async #invalidate(id, invalidation) {
    const item = this.#requireItem(id);
    if (
      item.approvalBindingDigest !== invalidation.approvalBindingDigest ||
      item.requestedBy.roleId !== invalidation.requestedBy.roleId ||
      item.requestedBy.workItemId !== invalidation.requestedBy.workItemId
    ) {
      throw queueError(
        "CONFIRMATION_PRODUCER_MISMATCH",
        "只有原岗位可以使该确认项失效",
        409,
      );
    }
    if (item.status === "stale") return this.#projectItem(item);
    const provenAbsent =
      item.status === "failed" && item.failure?.outcome === "absent";
    if (item.status !== "pending" && !provenAbsent) {
      throw queueError(
        "CONFIRMATION_NOT_INVALIDATABLE",
        "该动作已不能安全失效",
        409,
      );
    }

    this.#setProducerVeto(item.id, invalidation);
    const timestamp = this.#now();
    await this.#replaceItem(item.id, {
      ...item,
      status: "stale",
      itemRevision: item.itemRevision + 1,
      updatedAt: timestamp,
      receipt: null,
      failure: null,
      rejection: null,
      invalidation: { ...invalidation, at: timestamp },
    });
    return this.#projectItem(this.#requireItem(id));
  }

  async #execute(item, request) {
    const timestamp = this.#now();
    const executing = {
      ...item,
      status: "executing",
      itemRevision: item.itemRevision + 1,
      updatedAt: timestamp,
      execution: {
        requestId: request.requestId,
        attempt: (item.execution?.attempt || 0) + 1,
        startedAt: timestamp,
        outcome: "unknown",
      },
      receipt: null,
      failure: null,
      rejection: null,
      invalidation: null,
    };
    await this.#replaceItem(item.id, executing);
    const outcome = await this.#invokeExecute(executing);
    await this.#finalize(executing, outcome);
    return this.#projectItem(this.#requireItem(item.id));
  }

  async #recoverItem(id) {
    const item = this.#requireItem(id);
    const outcome = await this.#invokeReconcile(item);
    if (
      item.status === "failed" &&
      item.failure?.outcome === "unknown" &&
      outcome.status === "unknown"
    ) {
      return;
    }
    await this.#finalize(item, outcome);
  }

  async #invokeExecute(item) {
    try {
      return normalizeExecutorResult(
        await this.executor.execute(this.#privateEnvelope(item)),
      );
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async #invokeReconcile(item) {
    try {
      return normalizeExecutorResult(
        await this.executor.reconcile(this.#privateEnvelope(item)),
      );
    } catch (error) {
      return errorOutcome(error);
    }
  }

  async #finalize(item, outcome) {
    const current = this.#requireItem(item.id);
    const timestamp = this.#now();
    const execution = {
      ...(current.execution || item.execution),
      outcome: outcome.status,
    };
    let finalized;
    if (outcome.status === "applied" || outcome.status === "already") {
      finalized = {
        ...current,
        status: "completed",
        execution,
        receipt: outcome.receipt,
        failure: null,
        invalidation: null,
      };
    } else if (outcome.status === "stale") {
      finalized = {
        ...current,
        status: "stale",
        execution,
        receipt: null,
        failure: null,
        invalidation: null,
      };
    } else {
      const failureOutcome = outcome.status === "absent" ? "absent" : "unknown";
      finalized = {
        ...current,
        status: "failed",
        execution: { ...execution, outcome: failureOutcome },
        receipt: null,
        invalidation: null,
        failure: {
          code: outcome.code || "EXTERNAL_OUTCOME_UNKNOWN",
          outcome: failureOutcome,
          retryable: failureOutcome === "absent",
          at: timestamp,
        },
      };
    }
    await this.#replaceItem(item.id, {
      ...finalized,
      itemRevision: current.itemRevision + 1,
      updatedAt: timestamp,
    });
  }

  #privateEnvelope(item) {
    return clone({
      schemaVersion: 1,
      id: item.id,
      idempotencyKey: `confirmation-${item.approvalBindingDigest}`,
      kind: item.kind,
      requestedBy: item.requestedBy,
      actor: item.actor,
      target: item.target,
      action: item.action,
      displayedPayloadDigest: item.displayedPayloadDigest,
      approvalBindingDigest: item.approvalBindingDigest,
      execution: {
        requestId: item.execution.requestId,
        attempt: item.execution.attempt,
        startedAt: item.execution.startedAt,
      },
    });
  }

  #assertBinding(item, request, { revisions }) {
    if (
      request.displayedPayloadDigest !== item.displayedPayloadDigest ||
      request.approvalBindingDigest !== item.approvalBindingDigest
    ) {
      throw queueError(
        "CONFIRMATION_BINDING_MISMATCH",
        "确认内容已变化，请重新查看",
        409,
      );
    }
    if (
      revisions &&
      (request.expectedQueueRevision !== this.state.revision ||
        request.expectedItemRevision !== item.itemRevision)
    ) {
      throw queueError(
        "CONFIRMATION_REVISION_CONFLICT",
        "确认队列已变化，请重新查看",
        409,
      );
    }
  }

  #setProducerVeto(id, invalidation) {
    this.producerVetoes.set(id, clone(invalidation));
  }

  #isProducerVetoed(item) {
    const veto = this.producerVetoes.get(item.id);
    return Boolean(
      veto &&
        veto.approvalBindingDigest === item.approvalBindingDigest &&
        veto.requestedBy.roleId === item.requestedBy.roleId &&
        veto.requestedBy.workItemId === item.requestedBy.workItemId,
    );
  }

  #assertNotProducerVetoed(item) {
    if (this.#isProducerVetoed(item)) {
      throw queueError(
        "CONFIRMATION_INVALIDATION_PENDING",
        "该动作正在失效，不能再由用户执行",
        409,
      );
    }
  }

  #projectNext() {
    const pending = this.state.items
      .filter(
        (item) => item.status === "pending" && !this.#isProducerVetoed(item),
      )
      .sort(byCreation);
    const retryable = this.state.items
      .filter(
        (item) =>
          item.status === "failed" &&
          item.failure?.retryable &&
          !this.#isProducerVetoed(item),
      )
      .sort(byCreation);
    const actionable = [...pending, ...retryable];
    return {
      queueRevision: this.state.revision,
      pendingCount: actionable.length,
      item: actionable.length ? this.#projectItem(actionable[0]) : null,
    };
  }

  #projectItem(item) {
    return clone({
      id: item.id,
      kind: item.kind,
      status: item.status,
      queueRevision: this.state.revision,
      itemRevision: item.itemRevision,
      requestedBy: item.requestedBy,
      actor: item.actor,
      target: item.target,
      display: item.display,
      displayedPayloadDigest: item.displayedPayloadDigest,
      approvalBindingDigest: item.approvalBindingDigest,
      retryable: Boolean(item.failure?.retryable),
      ...(item.receipt ? { receipt: item.receipt } : {}),
      ...(item.failure ? { failure: item.failure } : {}),
      ...(item.rejection ? { rejection: item.rejection } : {}),
      ...(item.invalidation ? { invalidation: item.invalidation } : {}),
    });
  }

  async #replaceItem(id, replacement) {
    const index = this.state.items.findIndex((item) => item.id === id);
    if (index < 0) throw queueError("CONFIRMATION_NOT_FOUND", "找不到确认项", 404);
    const items = [...this.state.items];
    items[index] = replacement;
    await this.#persist({
      ...this.state,
      revision: this.state.revision + 1,
      items,
    });
  }

  async #persist(state) {
    const normalized = normalizeConfirmationState(state);
    await this.store.write(STATE_KEY, normalized);
    this.state = normalized;
  }

  async #reload() {
    this.state = normalizeConfirmationState(
      await this.store.read(STATE_KEY, defaultConfirmationState()),
    );
  }

  #find(id) {
    return this.state.items.find((item) => item.id === id) || null;
  }

  #requireItem(id) {
    if (typeof id !== "string" || !id) {
      throw queueError("INVALID_CONFIRMATION_REQUEST", "确认 ID 无效", 400);
    }
    const item = this.#find(id);
    if (!item) throw queueError("CONFIRMATION_NOT_FOUND", "找不到确认项", 404);
    return item;
  }

  #assertReady() {
    if (!this.ready) {
      throw queueError(
        "CONFIRMATION_QUEUE_NOT_READY",
        "确认队列尚未完成恢复",
        503,
      );
    }
  }

  #now() {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("clock must return a valid Date");
    }
    return value.toISOString();
  }
}
