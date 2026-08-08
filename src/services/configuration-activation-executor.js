import {
  normalizeConfigurationActivationEnvelope,
} from "../domain/configuration-activation-confirmation.js";
import { digestValue } from "../domain/code-executor-contract.js";
import { ActionAdmissionGateError } from "../lib/action-admission-gate.js";

const TRUSTED_OWNER = "owner:local";
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONFIGURATION_DIGEST = /^[a-f0-9]{64}$/;
const PRE_CUTOVER_FENCE_ERRORS = new Set([
  "RUNTIME_RESTART_REQUIRED",
  "RUNTIME_CONFIGURATION_NOT_READY",
  "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
]);

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

function expectedStoredBinding(action) {
  return Object.freeze({
    version: expectedVersion(action),
    configurationDigest: action.documentDigest,
  });
}

function sameConfigurationBinding(left, right) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left?.version === right?.version &&
      left?.configurationDigest === right?.configurationDigest)
  );
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

function reconciliationSnapshotFields(value, requestedVersion) {
  const revision = dataField(value, "revision");
  const activeVersion = dataField(value, "activeVersion");
  const active = dataField(value, "active");
  const observedVersion = dataField(value, "observedVersion");
  if (
    !revision.found ||
    !Number.isSafeInteger(revision.value) ||
    revision.value < 0 ||
    !activeVersion.found ||
    (activeVersion.value !== null &&
      (!Number.isSafeInteger(activeVersion.value) || activeVersion.value < 1)) ||
    !active.found ||
    !observedVersion.found ||
    revision.value < (activeVersion.value ?? 0) ||
    (activeVersion.value === null && active.value !== null) ||
    ((activeVersion.value ?? 0) < requestedVersion &&
      observedVersion.value !== null)
  ) {
    return null;
  }
  return {
    revision: revision.value,
    activeVersion: activeVersion.value,
    active: active.value,
    observedVersion: observedVersion.value,
  };
}

function activeSnapshotBinding(state) {
  if (state.activeVersion === null) {
    return { known: true, value: null };
  }
  const active = state.active;
  const version = dataField(active, "version");
  const configurationDigest = dataField(active, "configurationDigest");
  if (
    !version.found ||
    version.value !== state.activeVersion ||
    !configurationDigest.found ||
    typeof configurationDigest.value !== "string" ||
    !CONFIGURATION_DIGEST.test(configurationDigest.value)
  ) {
    return { known: false, value: null };
  }
  return {
    known: true,
    value: Object.freeze({
      version: version.value,
      configurationDigest: configurationDigest.value,
    }),
  };
}

function reconciliationOutcome(snapshot, envelope) {
  const action = envelope.action;
  const resultVersion = expectedVersion(action);
  const state = reconciliationSnapshotFields(snapshot, resultVersion);
  if (!state) {
    return {
      result: unknown("CONFIGURATION_STATE_PROTOCOL_ERROR"),
      storedActiveKnown: false,
      storedActive: null,
    };
  }
  const storedActive = activeSnapshotBinding(state);
  if (
    state.activeVersion !== null &&
    state.activeVersion >= resultVersion
  ) {
    const version = matchingVersion(state.observedVersion, action);
    return {
      result: version ? completed("already", envelope, version) : stale(),
      storedActiveKnown: storedActive.known,
      storedActive: storedActive.value,
    };
  }
  if (
    state.revision === action.expectedStateRevision &&
    state.activeVersion === action.expectedActiveVersion
  ) {
    return {
      result: absent(),
      storedActiveKnown: storedActive.known,
      storedActive: storedActive.value,
    };
  }
  if (
    state.revision < action.expectedStateRevision ||
    (action.expectedActiveVersion !== null &&
      (state.activeVersion === null ||
        state.activeVersion < action.expectedActiveVersion))
  ) {
    return {
      result: unknown("CONFIGURATION_STATE_PROTOCOL_ERROR"),
      storedActiveKnown: false,
      storedActive: null,
    };
  }
  return {
    result: stale(),
    storedActiveKnown: storedActive.known,
    storedActive: storedActive.value,
  };
}

function settleCutover(control, runtimeEffective, outcome) {
  if (["applied", "already"].includes(outcome.result.status)) {
    if (!outcome.storedActiveKnown || outcome.storedActive === null) {
      control.markUnknown();
      return;
    }
    control.commit(outcome.storedActive);
    return;
  }
  if (outcome.result.status === "absent") {
    if (
      outcome.storedActiveKnown &&
      sameConfigurationBinding(outcome.storedActive, runtimeEffective)
    ) {
      control.abort();
    } else {
      control.markUnknown();
    }
    return;
  }
  if (
    outcome.result.status === "stale" &&
    outcome.storedActiveKnown &&
    sameConfigurationBinding(outcome.storedActive, runtimeEffective)
  ) {
    control.abort();
    return;
  }
  if (
    outcome.result.status === "stale" &&
    outcome.storedActiveKnown &&
    outcome.storedActive !== null
  ) {
    control.commit(outcome.storedActive);
    return;
  }
  control.markUnknown();
}

export class ConfigurationActivationExecutor {
  #activation;
  #allowedActionTypes;
  #cutover;
  #readFenceStatus;
  #reconcileCutover;
  #readReconciliationSnapshot;

  constructor({
    activationExecutor,
    configurationReader,
    actionAdmissionGate,
    allowedActionTypes = Object.keys(ACTIONS),
  } = {}) {
    this.#activation = requirePort(
      activationExecutor,
      ["activateInitialization", "activateDraft", "activateRollback"],
      "configuration activation executor",
    );
    this.#readReconciliationSnapshot = requirePort(
      configurationReader,
      ["readActivationReconciliationSnapshot"],
      "configuration reader",
    ).readActivationReconciliationSnapshot;
    const cutoverFence = requirePort(
      actionAdmissionGate,
      ["cutover", "readStatus", "reconcileCutover"],
      "configuration action admission gate",
    );
    this.#cutover = cutoverFence.cutover;
    this.#readFenceStatus = cutoverFence.readStatus;
    this.#reconcileCutover = cutoverFence.reconcileCutover;
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
    return this.#runCutover(envelope, { execute: true });
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
    return this.#runCutover(envelope, { execute: false });
  }

  async #runCutover(envelope, { execute }) {
    const run = execute ? this.#cutover : this.#reconcileCutover;
    try {
      return await run(async (control) => {
        const runtimeEffective = this.#readFenceStatus().runtimeEffective;
        const outcome = execute
          ? await this.#executeEnvelope(envelope)
          : await this.#reconcileEnvelope(envelope);
        settleCutover(control, runtimeEffective, outcome);
        return outcome.result;
      });
    } catch (error) {
      // These errors are emitted before the cutover callback is admitted, so
      // no configuration write can have happened. A queued approval bound to
      // the superseded runtime is therefore stale, never outcome-unknown.
      if (
        execute &&
        error instanceof ActionAdmissionGateError &&
        PRE_CUTOVER_FENCE_ERRORS.has(error.code)
      ) {
        return stale();
      }
      throw error;
    }
  }

  async #executeEnvelope(envelope) {
    const definition = ACTIONS[envelope.action.type];
    try {
      const result = normalizeActivationResult(
        await this.#activation[definition.method](
          activationRequest(envelope.action),
        ),
        envelope,
      );
      if (result) {
        return {
          result,
          storedActiveKnown: true,
          storedActive: expectedStoredBinding(envelope.action),
        };
      }
    } catch {
      // A thrown result can be a lost acknowledgement, so evidence decides.
    }
    return this.#reconcileEnvelope(envelope);
  }

  async #reconcileEnvelope(envelope) {
    try {
      return reconciliationOutcome(
        await this.#readReconciliationSnapshot({
          version: expectedVersion(envelope.action),
        }),
        envelope,
      );
    } catch {
      return {
        result: unknown(),
        storedActiveKnown: false,
        storedActive: null,
      };
    }
  }
}
