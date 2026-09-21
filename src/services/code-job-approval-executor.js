import {
  codeJobIdForGrant,
  normalizeApprovedCodeJobRequest,
} from "../domain/code-job-contract.js";
import { codeJobConfirmationIdForGrant } from "../domain/code-action-proposal-confirmation.js";
import { digestValue } from "../domain/code-executor-contract.js";

const SHA256 = /^[a-f0-9]{64}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function exactObject(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("code job approval envelope is invalid");
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        DANGEROUS_KEYS.has(key) ||
        !keys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw new TypeError("code job approval envelope is invalid");
  }
  return value;
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function normalizeEnvelope(value) {
  exactObject(value, [
    "schemaVersion",
    "id",
    "idempotencyKey",
    "kind",
    "requestedBy",
    "actor",
    "target",
    "action",
    "displayedPayloadDigest",
    "approvalBindingDigest",
    "execution",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "local.code-job-create") {
    throw new TypeError("code job approval envelope is invalid");
  }
  exactObject(value.actor, ["provider", "accountId"]);
  exactObject(value.target, ["provider", "resourceId", "version"]);
  exactObject(value.action, ["type", "grant"]);
  exactObject(value.execution, ["requestId", "attempt", "startedAt"]);
  if (
    value.actor.provider !== "local-code" ||
    value.actor.accountId !== "controlled-code-executor" ||
    value.target.provider !== "local-code" ||
    value.action.type !== "create_code_job" ||
    !Number.isSafeInteger(value.execution.attempt) ||
    value.execution.attempt < 1 ||
    !validTimestamp(value.execution.startedAt) ||
    typeof value.displayedPayloadDigest !== "string" ||
    !SHA256.test(value.displayedPayloadDigest) ||
    typeof value.approvalBindingDigest !== "string" ||
    !SHA256.test(value.approvalBindingDigest) ||
    value.idempotencyKey !== `confirmation-${value.approvalBindingDigest}`
  ) {
    throw new TypeError("code job approval envelope is invalid");
  }
  const request = normalizeApprovedCodeJobRequest({
    confirmationId: value.id,
    requestId: value.execution.requestId,
    displayedPayloadDigest: value.displayedPayloadDigest,
    approvalBindingDigest: value.approvalBindingDigest,
    grant: value.action.grant,
  });
  const expectedApprovalBindingDigest = digestValue({
    id: value.id,
    kind: value.kind,
    requestedBy: value.requestedBy,
    actor: value.actor,
    target: value.target,
    action: value.action,
    displayedPayloadDigest: value.displayedPayloadDigest,
  });
  if (
    value.id !== codeJobConfirmationIdForGrant(request.grant) ||
    value.approvalBindingDigest !== expectedApprovalBindingDigest ||
    value.target.resourceId !== request.grant.workspaceId ||
    value.target.version !== request.grant.contentDigest ||
    digestValue(value.requestedBy) !== digestValue(request.grant.requestedBy)
  ) {
    throw new TypeError("code job approval envelope is invalid");
  }
  return request;
}

function requireStore(value) {
  if (
    !value ||
    typeof value.createApprovedJob !== "function" ||
    typeof value.reconcileApprovedJob !== "function"
  ) {
    throw new TypeError("codeJobStore is invalid");
  }
  return Object.freeze({
    createApprovedJob: value.createApprovedJob.bind(value),
    reconcileApprovedJob: value.reconcileApprovedJob.bind(value),
  });
}

function requireGrantVerifier(value) {
  if (!value || typeof value.verify !== "function") {
    throw new TypeError("grantVerifier is invalid");
  }
  return value.verify.bind(value);
}

function unknown(code = "CODE_JOB_OUTCOME_UNKNOWN") {
  return {
    status: "error",
    error: {
      trust: "unknown",
      code: /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
        ? code
        : "CODE_JOB_OUTCOME_UNKNOWN",
    },
  };
}

function stableCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStoreOutcome(value, request) {
  if (value?.status === "absent") {
    return { status: "absent", code: "CODE_JOB_NOT_CREATED" };
  }
  if (!new Set(["applied", "already"]).has(value?.status)) {
    return unknown("CODE_JOB_STORE_PROTOCOL_ERROR");
  }
  const expectedId = codeJobIdForGrant(request.grant);
  if (
    value.receipt?.id !== expectedId ||
    (value.receipt.createdAt !== undefined &&
      !validTimestamp(value.receipt.createdAt))
  ) {
    return unknown("CODE_JOB_STORE_PROTOCOL_ERROR");
  }
  return {
    status: value.status,
    receipt: {
      id: expectedId,
      ...(value.receipt.createdAt === undefined
        ? {}
        : { createdAt: value.receipt.createdAt }),
    },
  };
}

export class CodeJobApprovalExecutor {
  #createApprovedJob;
  #reconcileApprovedJob;
  #verifyGrant;

  constructor({ codeJobStore, grantVerifier } = {}) {
    const store = requireStore(codeJobStore);
    this.#createApprovedJob = store.createApprovedJob;
    this.#reconcileApprovedJob = store.reconcileApprovedJob;
    this.#verifyGrant = requireGrantVerifier(grantVerifier);
    Object.freeze(this);
  }

  async execute(value) {
    let request;
    try {
      request = normalizeEnvelope(value);
    } catch {
      return unknown("INVALID_CODE_JOB_APPROVAL");
    }
    const authorization = await this.#authorization(request);
    if (authorization !== null) return authorization;
    try {
      return normalizeStoreOutcome(
        await this.#createApprovedJob(request),
        request,
      );
    } catch (error) {
      try {
        const reconciled = normalizeStoreOutcome(
          await this.#reconcileApprovedJob(request),
          request,
        );
        if (reconciled.status === "already") return reconciled;
        if (reconciled.status === "absent") return reconciled;
      } catch (reconcileError) {
        return unknown(stableCode(reconcileError) || stableCode(error));
      }
      return unknown(stableCode(error));
    }
  }

  async reconcile(value) {
    let request;
    try {
      request = normalizeEnvelope(value);
    } catch {
      return unknown("INVALID_CODE_JOB_APPROVAL");
    }
    try {
      const reconciled = normalizeStoreOutcome(
        await this.#reconcileApprovedJob(request),
        request,
      );
      if (reconciled.status !== "absent") return reconciled;
      const authorization = await this.#authorization(request);
      return authorization ?? reconciled;
    } catch (error) {
      return unknown(stableCode(error));
    }
  }

  async #authorization(request) {
    try {
      const verified = await this.#verifyGrant(structuredClone(request.grant));
      if (digestValue(verified) !== digestValue(request.grant)) {
        return unknown("CODE_JOB_AUTHORITY_PROTOCOL_ERROR");
      }
      return null;
    } catch (error) {
      return error?.code === "INVALID_CODE_JOB_AUTHORITY"
        ? { status: "stale" }
        : unknown("CODE_JOB_AUTHORITY_UNKNOWN");
    }
  }
}
