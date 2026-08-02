import { OperationQueue } from "../lib/operation-queue.js";
import { EmployeeController } from "./employee-controller.js";
import { normalizeBrainConfig } from "./brain-router.js";
import {
  normalizeRoleDefinition,
  normalizeRolePermissions,
  RoleDecisionEngine,
} from "./role-decision-engine.js";

const SAFE_STATE_KEY = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;

export class ConfiguredRoleEmployeeError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "ConfiguredRoleEmployeeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function employeeError(code, message, statusCode) {
  return new ConfiguredRoleEmployeeError(code, message, statusCode);
}

function safeWorkerId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 128
  ) {
    throw new TypeError("workerId is invalid");
  }
  return value;
}

function safeStateKey(value) {
  if (typeof value !== "string" || !SAFE_STATE_KEY.test(value)) {
    throw new TypeError("stateKey is invalid");
  }
  return value;
}

function isoTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw new TypeError("clock is invalid");
  }
  return timestamp;
}

function safeTrigger(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 128
  ) {
    throw new TypeError("trigger is invalid");
  }
  return value;
}

function stableErrorCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : null;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code)) {
      return code;
    }
  } catch {
    // Untrusted errors collapse to one local classification.
  }
  return "ROLE_RUN_FAILED";
}

function dataObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function exactData(value, keys) {
  const object = dataObject(value);
  if (
    !object ||
    Object.keys(object).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(object, key))
  ) {
    throw employeeError(
      "CONFIGURED_ROLE_STATE_CORRUPTED",
      "Configured role state is corrupted",
      503,
    );
  }
  return object;
}

function normalizeLastRun(value) {
  if (value === null) return null;
  const lastRun = exactData(value, ["trigger", "at"]);
  return {
    trigger: safeTrigger(lastRun.trigger),
    at: isoTimestamp(lastRun.at),
  };
}

function normalizeState(value) {
  const state = exactData(value, [
    "schemaVersion",
    "revision",
    "paused",
    "runCount",
    "lastRun",
    "lastErrorCode",
  ]);
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    typeof state.paused !== "boolean" ||
    !Number.isSafeInteger(state.runCount) ||
    state.runCount < 0 ||
    typeof state.lastErrorCode !== "string" ||
    (state.lastErrorCode && !/^[A-Z][A-Z0-9_]{0,127}$/.test(state.lastErrorCode))
  ) {
    throw employeeError(
      "CONFIGURED_ROLE_STATE_CORRUPTED",
      "Configured role state is corrupted",
      503,
    );
  }
  return {
    schemaVersion: 1,
    revision: state.revision,
    paused: state.paused,
    runCount: state.runCount,
    lastRun: normalizeLastRun(state.lastRun),
    lastErrorCode: state.lastErrorCode,
  };
}

function requireDecisionEngine(value) {
  if (
    !value ||
    typeof value.decide !== "function" ||
    typeof value.view !== "function"
  ) {
    throw new TypeError("decisionEngine is invalid");
  }
  return Object.freeze({
    decide: value.decide.bind(value),
    view: value.view.bind(value),
  });
}

function safeBrainProjection(brain, engine) {
  let engineView;
  try {
    engineView = engine.view();
  } catch {
    throw new TypeError("decisionEngine view is invalid");
  }
  return Object.freeze({
    provider: brain.provider,
    model: brain.model,
    remote: engineView?.brain?.remote === true,
    remoteData: Object.freeze({ ...brain.remoteData }),
  });
}

export class ConfiguredRoleEmployee {
  #controller;
  #decisionEngine;
  #workerPort;

  constructor({
    definition: definitionValue,
    permissions: permissionsValue,
    brain: brainValue,
    brainRouter,
    contextFactory,
    decisionEngine: suppliedDecisionEngine,
    store,
    onRun = async () => {},
    clock = () => new Date(),
    workerId,
    stateKey,
    initialPaused = false,
    operationQueue = new OperationQueue(),
  } = {}) {
    if (typeof onRun !== "function") throw new TypeError("onRun is invalid");
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    if (typeof initialPaused !== "boolean") {
      throw new TypeError("initialPaused is invalid");
    }
    const definition = normalizeRoleDefinition(definitionValue);
    const permissions = normalizeRolePermissions(permissionsValue);
    const brain = normalizeBrainConfig(brainValue);
    this.roleId = definition.id;
    this.workerId = safeWorkerId(workerId ?? `configured-${definition.id}`);
    this.scheduleMinutes = definition.scheduleMinutes;
    this.#decisionEngine = requireDecisionEngine(
      suppliedDecisionEngine ??
        new RoleDecisionEngine({
          definition,
          permissions,
          brain,
          brainRouter,
          ...(contextFactory ? { contextFactory } : {}),
        }),
    );
    const brainProjection = safeBrainProjection(brain, this.#decisionEngine);
    let controller;
    controller = new EmployeeController({
      definition,
      store,
      stateKey: safeStateKey(
        stateKey ?? `configured-role-${definition.id}-state`,
      ),
      operationQueue,
      createState: () => ({
        schemaVersion: 1,
        revision: 0,
        paused: initialPaused,
        runCount: 0,
        lastRun: null,
        lastErrorCode: "",
      }),
      normalizeState,
      resolveState: (state, enabled) => {
        if (!enabled) return "disabled";
        return state.paused ? "paused" : "observing";
      },
      projectRole: (state) => ({
        workerId: this.workerId,
        permissions: { allowedIntents: [...permissions.allowedIntents] },
        brain: {
          ...brainProjection,
          remoteData: { ...brainProjection.remoteData },
        },
        lastRun: state.lastRun ? { ...state.lastRun } : null,
        lastErrorCode: state.lastErrorCode,
      }),
      projectWork: (state) => ({
        workerId: this.workerId,
        runCount: state.runCount,
        lastRun: state.lastRun ? { ...state.lastRun } : null,
        lastErrorCode: state.lastErrorCode,
      }),
      run: async ({ state, trigger = "scheduled" }) => {
        const normalizedTrigger = safeTrigger(trigger);
        let failure = null;
        try {
          await onRun({
            roleId: this.roleId,
            workerId: this.workerId,
            trigger: normalizedTrigger,
          });
        } catch (error) {
          failure = error;
        }
        const next = await controller.writeState({
          ...state,
          runCount: state.runCount + 1,
          lastRun: { trigger: normalizedTrigger, at: isoTimestamp(clock()) },
          lastErrorCode: failure ? stableErrorCode(failure) : "",
        });
        if (failure) throw failure;
        return next;
      },
    });
    this.#controller = controller;
    this.#workerPort = Object.freeze({
      roleId: this.roleId,
      workerId: this.workerId,
      view: this.workerView.bind(this),
      decide: this.decide.bind(this),
    });
    Object.freeze(this);
  }

  get id() {
    return this.#controller.id;
  }

  get running() {
    return this.#controller.running;
  }

  view() {
    return this.#controller.view();
  }

  roleView() {
    return this.#controller.roleView();
  }

  run(options = {}) {
    return this.#controller.run(options);
  }

  control(command, expectedRevision) {
    if (this.#controller.running) {
      return Promise.reject(
        employeeError(
          "ROLE_RUN_IN_PROGRESS",
          "Configured role cannot be controlled while its run is in progress",
          409,
        ),
      );
    }
    return this.#controller.control(command, expectedRevision);
  }

  async workerView() {
    const role = await this.#controller.roleView();
    return { enabled: role.enabled, paused: role.paused };
  }

  async decide(input) {
    const before = await this.#controller.roleView();
    if (!before.enabled) {
      throw employeeError("ROLE_DISABLED", "Configured role is disabled", 409);
    }
    if (before.paused) {
      throw employeeError("ROLE_PAUSED", "Configured role is paused", 409);
    }
    const decision = await this.#decisionEngine.decide(input);
    const after = await this.#controller.roleView();
    if (!after.enabled) {
      throw employeeError("ROLE_DISABLED", "Configured role is disabled", 409);
    }
    if (after.paused) {
      throw employeeError("ROLE_PAUSED", "Configured role is paused", 409);
    }
    if (after.revision !== before.revision) {
      throw employeeError(
        "ROLE_STATE_CHANGED",
        "Configured role state changed while deciding",
        409,
      );
    }
    return decision;
  }

  asRoleWorker() {
    return this.#workerPort;
  }
}
