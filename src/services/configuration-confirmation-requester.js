import {
  createConfigurationActivationConfirmationPlan,
} from "../domain/configuration-activation-confirmation.js";

const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/;
const INVALID_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SHA256 = /^[a-f0-9]{64}$/;

function methodDescriptor(value, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }
  let owner = value;
  while (
    owner !== null &&
    owner !== Object.prototype &&
    owner !== Function.prototype
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function requirePort(value, methods, name) {
  const port = {};
  for (const method of methods) {
    const descriptor = methodDescriptor(value, method);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new TypeError(`${name} is invalid`);
    }
    port[method] = (...args) => Reflect.apply(descriptor.value, value, args);
  }
  return Object.freeze(port);
}

function optionalMethod(value, name) {
  const descriptor = methodDescriptor(value, name);
  return descriptor && "value" in descriptor && typeof descriptor.value === "function"
    ? (...args) => Reflect.apply(descriptor.value, value, args)
    : null;
}

function exactDataFields(value, names) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("configuration confirmation request is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  ) {
    throw new TypeError("configuration confirmation request is invalid");
  }
  const fields = new Map();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("configuration confirmation request is invalid");
    }
    fields.set(name, descriptor.value);
  }
  return fields;
}

function safeId(value, name) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_TEXT_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 256 ||
    !SAFE_ID.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function integer(value, name, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function initializationRequest(value) {
  const fields = exactDataFields(value, [
    "draftId",
    "draftRevision",
    "expectedStateRevision",
  ]);
  return Object.freeze({
    draftId: safeId(fields.get("draftId"), "draftId"),
    draftRevision: integer(fields.get("draftRevision"), "draftRevision", 1),
    expectedStateRevision: integer(
      fields.get("expectedStateRevision"),
      "expectedStateRevision",
      0,
    ),
  });
}

function draftActivationRequest(value) {
  const fields = exactDataFields(value, [
    "draftId",
    "draftRevision",
    "expectedStateRevision",
    "expectedActiveVersion",
  ]);
  return Object.freeze({
    draftId: safeId(fields.get("draftId"), "draftId"),
    draftRevision: integer(fields.get("draftRevision"), "draftRevision", 1),
    expectedStateRevision: integer(
      fields.get("expectedStateRevision"),
      "expectedStateRevision",
      0,
    ),
    expectedActiveVersion: integer(
      fields.get("expectedActiveVersion"),
      "expectedActiveVersion",
      1,
    ),
  });
}

function rollbackRequest(value) {
  const fields = exactDataFields(value, [
    "targetVersion",
    "expectedStateRevision",
    "expectedActiveVersion",
  ]);
  return Object.freeze({
    targetVersion: integer(fields.get("targetVersion"), "targetVersion", 1),
    expectedStateRevision: integer(
      fields.get("expectedStateRevision"),
      "expectedStateRevision",
      0,
    ),
    expectedActiveVersion: integer(
      fields.get("expectedActiveVersion"),
      "expectedActiveVersion",
      1,
    ),
  });
}

function proposalDraftActivationRequest(value) {
  const fields = exactDataFields(value, [
    "proposalId",
    "proposalContentDigest",
  ]);
  return Object.freeze({
    proposalId: safeId(fields.get("proposalId"), "proposalId"),
    proposalContentDigest: (() => {
      const digest = safeId(
        fields.get("proposalContentDigest"),
        "proposalContentDigest",
      );
      if (!SHA256.test(digest)) {
        throw new TypeError("proposalContentDigest is invalid");
      }
      return digest;
    })(),
  });
}

function recoveryPreparation(value) {
  const fields = exactDataFields(value, ["prepared", "current"]);
  if (typeof fields.get("current") !== "boolean") {
    throw new TypeError("configuration proposal preparation is invalid");
  }
  return { prepared: fields.get("prepared"), current: fields.get("current") };
}

function errorCode(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "code");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function proposalStale() {
  return Object.assign(new Error("configuration proposal is stale"), {
    code: "CONFIGURATION_PROPOSAL_STALE",
  });
}

export class ConfigurationConfirmationRequester {
  #simulator;
  #enqueue;
  #get;
  #invalidate;
  #prepareProposalDraftActivation;

  constructor({ simulator, confirmationProducer } = {}) {
    this.#simulator = requirePort(
      simulator,
      ["prepareInitialization", "prepareDraftActivation", "prepareRollback"],
      "configuration simulator",
    );
    this.#enqueue = requirePort(
      confirmationProducer,
      ["enqueue"],
      "confirmation producer",
    ).enqueue;
    this.#get = optionalMethod(confirmationProducer, "get");
    this.#invalidate = optionalMethod(confirmationProducer, "invalidate");
    this.#prepareProposalDraftActivation = optionalMethod(
      simulator,
      "prepareProposalDraftActivation",
    );
    Object.freeze(this);
  }

  async requestInitialization(value) {
    return this.#request(
      "prepareInitialization",
      initializationRequest(value),
    );
  }

  async requestDraftActivation(value) {
    return this.#request(
      "prepareDraftActivation",
      draftActivationRequest(value),
    );
  }

  async requestRollback(value) {
    return this.#request("prepareRollback", rollbackRequest(value));
  }

  async requestProposalDraftActivation(value) {
    if (
      this.#get === null ||
      this.#invalidate === null ||
      this.#prepareProposalDraftActivation === null
    ) {
      throw new TypeError("configuration proposal recovery ports are unavailable");
    }
    const request = proposalDraftActivationRequest(value);
    const recovery = recoveryPreparation(
      await this.#prepareProposalDraftActivation(request),
    );
    const recoveredPlan = createConfigurationActivationConfirmationPlan(
      recovery.prepared,
    );
    let existing;
    try {
      existing = await this.#get(recoveredPlan.id);
    } catch (error) {
      if (errorCode(error) !== "CONFIRMATION_NOT_FOUND") throw error;
    }
    if (existing !== undefined) {
      if (
        recovery.current ||
        !["pending", "failed"].includes(existing.status) ||
        (existing.status === "failed" && existing.retryable !== true)
      ) {
        return existing;
      }
      return this.#invalidate(existing.id, {
        requestedBy: recoveredPlan.requestedBy,
        approvalBindingDigest: existing.approvalBindingDigest,
        reason: "configuration_authority_changed",
      });
    }
    if (!recovery.current) throw proposalStale();
    const action = recoveredPlan.action;
    const currentPrepared = await this.#simulator.prepareDraftActivation({
      draftId: action.draftId,
      draftRevision: action.draftRevision,
      expectedStateRevision: action.expectedStateRevision,
      expectedActiveVersion: action.expectedActiveVersion,
    });
    const currentPlan = createConfigurationActivationConfirmationPlan(
      currentPrepared,
    );
    if (JSON.stringify(currentPlan) !== JSON.stringify(recoveredPlan)) {
      throw proposalStale();
    }
    return this.#enqueue(currentPlan);
  }

  async #request(method, request) {
    const prepared = await this.#simulator[method](request);
    const plan = createConfigurationActivationConfirmationPlan(prepared);
    return this.#enqueue(plan);
  }
}
