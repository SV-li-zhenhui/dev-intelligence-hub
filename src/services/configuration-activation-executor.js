import {
  normalizeConfigurationActivationEnvelope,
} from "../domain/configuration-activation-confirmation.js";
import { digestValue } from "../domain/code-executor-contract.js";

const TRUSTED_OWNER = "owner:local";
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const ACTIONS = Object.freeze({
  initialize_from_draft: Object.freeze({
    method: "activateInitialization",
    kind: "configuration.initialize",
    source: "initialization",
  }),
  activate_draft: Object.freeze({
    method: "activateDraft",
    kind: "configuration.activate",
    source: "draft",
  }),
  activate_rollback: Object.freeze({
    method: "activateRollback",
    kind: "configuration.rollback",
    source: "rollback",
  }),
});

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

function normalizeAllowedActionTypes(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new TypeError("allowed configuration activation actions are invalid");
  }
  const result = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (
      !descriptor?.enumerable ||
      !("value" in descriptor) ||
      !Object.hasOwn(ACTIONS, descriptor.value) ||
      result.has(descriptor.value)
    ) {
      throw new TypeError(
        "allowed configuration activation actions are invalid",
      );
    }
    result.add(descriptor.value);
  }
  return result;
}

function unknown(code = "CONFIGURATION_ACTIVATION_OUTCOME_UNKNOWN") {
  return Object.freeze({
    status: "error",
    error: Object.freeze({ code, trust: "unknown" }),
  });
}

function invalidApproval() {
  return unknown("INVALID_CONFIGURATION_ACTIVATION_APPROVAL");
}

function absent() {
  return Object.freeze({
    status: "absent",
    code: "CONFIGURATION_ACTIVATION_NOT_APPLIED",
  });
}

function stale() {
  return Object.freeze({ status: "stale" });
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    CANONICAL_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function dataField(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { found: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor?.enumerable && "value" in descriptor
    ? { found: true, value: descriptor.value }
    : { found: false };
}

function activationRequest(action) {
  const definition = ACTIONS[action.type];
  const common = {
    kind: definition.kind,
    expectedStateRevision: action.expectedStateRevision,
    expectedActiveVersion: action.expectedActiveVersion,
    activeDigest: action.activeDigest,
    documentDigest: action.documentDigest,
    validationDigest: action.validationDigest,
    impactDigest: action.impactDigest,
  };
  if (action.type === "initialize_from_draft") {
    return {
      ...common,
      baselineDigest: action.baselineDigest,
      draftId: action.draftId,
      draftRevision: action.draftRevision,
      draftRevisionId: action.draftRevisionId,
      activatedBy: TRUSTED_OWNER,
    };
  }
  if (action.type === "activate_draft") {
    return {
      ...common,
      draftId: action.draftId,
      draftRevision: action.draftRevision,
      draftRevisionId: action.draftRevisionId,
      activatedBy: TRUSTED_OWNER,
    };
  }
  return {
    ...common,
    targetVersion: action.targetVersion,
    targetDigest: action.targetDigest,
    activatedBy: TRUSTED_OWNER,
  };
}

function expectedVersion(action) {
  return action.expectedActiveVersion === null
    ? 1
    : action.expectedActiveVersion + 1;
}

function expectedVersionBinding(action) {
  const definition = ACTIONS[action.type];
  return {
    version: expectedVersion(action),
    configurationDigest: action.documentDigest,
    source: definition.source,
    previousVersion: action.expectedActiveVersion,
    draftRevisionId:
      action.type === "activate_rollback" ? null : action.draftRevisionId,
    rollbackOf:
      action.type === "activate_rollback" ? action.targetVersion : null,
    activatedBy: TRUSTED_OWNER,
    impactDigest: action.impactDigest,
  };
}

function matchingVersion(value, action) {
  const expected = expectedVersionBinding(action);
  for (const [name, expectedValue] of Object.entries(expected)) {
    const field = dataField(value, name);
    if (!field.found || field.value !== expectedValue) return null;
  }
  const activatedAt = dataField(value, "activatedAt");
  if (!activatedAt.found || !canonicalTimestamp(activatedAt.value)) return null;
  return { ...expected, activatedAt: activatedAt.value };
}

function receipt(envelope, version) {
  const id = `configuration-activation-${digestValue({
    confirmationId: envelope.id,
    approvalBindingDigest: envelope.approvalBindingDigest,
    configurationVersion: version.version,
    configurationDigest: version.configurationDigest,
  })}`;
  return Object.freeze({ id, createdAt: version.activatedAt });
}

function completed(status, envelope, version) {
  return Object.freeze({ status, receipt: receipt(envelope, version) });
}

function normalizeActivationResult(value, envelope) {
  const applied = dataField(value, "applied");
  const active = dataField(value, "active");
  if (
    !applied.found ||
    typeof applied.value !== "boolean" ||
    !active.found
  ) {
    return null;
  }
  const version = matchingVersion(active.value, envelope.action);
  if (!version) return null;
  return completed(applied.value ? "applied" : "already", envelope, version);
}

function snapshotFields(value) {
  const revision = dataField(value, "revision");
  const activeVersion = dataField(value, "activeVersion");
  const versions = dataField(value, "versions");
  if (
    !revision.found ||
    !Number.isSafeInteger(revision.value) ||
    revision.value < 0 ||
    !activeVersion.found ||
    (activeVersion.value !== null &&
      (!Number.isSafeInteger(activeVersion.value) || activeVersion.value < 1)) ||
    !versions.found ||
    !Array.isArray(versions.value) ||
    Object.getPrototypeOf(versions.value) !== Array.prototype ||
    Reflect.ownKeys(versions.value).length !== versions.value.length + 1 ||
    (activeVersion.value === null
      ? versions.value.length !== 0
      : versions.value.length !== activeVersion.value) ||
    revision.value < versions.value.length
  ) {
    return null;
  }
  for (let index = 0; index < versions.value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      versions.value,
      `${index}`,
    );
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
  }
  return {
    revision: revision.value,
    activeVersion: activeVersion.value,
    versions: versions.value,
  };
}

function reconcileSnapshot(snapshot, envelope) {
  const state = snapshotFields(snapshot);
  if (!state) return unknown("CONFIGURATION_STATE_PROTOCOL_ERROR");
  const action = envelope.action;
  const resultVersion = expectedVersion(action);
  if (state.versions.length >= resultVersion) {
    const version = matchingVersion(state.versions[resultVersion - 1], action);
    return version ? completed("already", envelope, version) : stale();
  }
  if (
    state.revision === action.expectedStateRevision &&
    state.activeVersion === action.expectedActiveVersion
  ) {
    return absent();
  }
  if (
    state.revision < action.expectedStateRevision ||
    (action.expectedActiveVersion !== null &&
      (state.activeVersion === null ||
        state.activeVersion < action.expectedActiveVersion))
  ) {
    return unknown("CONFIGURATION_STATE_PROTOCOL_ERROR");
  }
  return stale();
}

export class ConfigurationActivationExecutor {
  #activation;
  #allowedActionTypes;
  #readSnapshot;

  constructor({
    activationExecutor,
    configurationReader,
    allowedActionTypes = Object.keys(ACTIONS),
  } = {}) {
    this.#activation = requirePort(
      activationExecutor,
      ["activateInitialization", "activateDraft", "activateRollback"],
      "configuration activation executor",
    );
    this.#readSnapshot = requirePort(
      configurationReader,
      ["readSnapshot"],
      "configuration reader",
    ).readSnapshot;
    this.#allowedActionTypes = normalizeAllowedActionTypes(allowedActionTypes);
    Object.freeze(this);
  }

  async execute(value) {
    let envelope;
    try {
      envelope = normalizeConfigurationActivationEnvelope(value);
    } catch {
      return invalidApproval();
    }
    if (!this.#allowedActionTypes.has(envelope.action.type)) return stale();
    const definition = ACTIONS[envelope.action.type];
    try {
      const result = normalizeActivationResult(
        await this.#activation[definition.method](
          activationRequest(envelope.action),
        ),
        envelope,
      );
      if (result) return result;
    } catch {
      // A thrown result can be a lost acknowledgement, so evidence decides.
    }
    return this.#reconcileEnvelope(envelope);
  }

  async reconcile(value) {
    let envelope;
    try {
      envelope = normalizeConfigurationActivationEnvelope(value);
    } catch {
      return invalidApproval();
    }
    // Reconciliation stays policy-independent because an executing item may
    // have crossed the side-effect boundary under an earlier runtime policy.
    return this.#reconcileEnvelope(envelope);
  }

  async #reconcileEnvelope(envelope) {
    try {
      return reconcileSnapshot(await this.#readSnapshot(), envelope);
    } catch {
      return unknown();
    }
  }
}
