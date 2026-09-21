import { OperationQueue } from "../lib/operation-queue.js";

function employeeError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function baseState() {
  return { revision: 0, paused: false };
}

function normalizeLifecycleState(state) {
  return {
    ...state,
    revision: Number.isInteger(state?.revision) ? state.revision : 0,
    paused: Boolean(state?.paused),
  };
}

function defaultRoleState(state, enabled) {
  if (!enabled) return "disabled";
  return state.paused ? "paused" : "observing";
}

export class EmployeeController {
  constructor({
    definition,
    store,
    stateKey,
    run,
    createState = baseState,
    normalizeState = (state) => state,
    resolveState = defaultRoleState,
    applyControl = (state, paused) => ({ ...state, paused }),
    projectRole = () => ({}),
    projectWork = () => ({}),
    operationQueue = null,
  }) {
    if (!definition?.id || typeof definition.id !== "string") {
      throw new Error("岗位 definition.id 不能为空");
    }
    if (!store || typeof store.read !== "function" || typeof store.write !== "function") {
      throw new Error("岗位必须配置可读写的状态存储");
    }
    if (!stateKey || typeof stateKey !== "string") {
      throw new Error("岗位 stateKey 不能为空");
    }
    if (typeof run !== "function") {
      throw new Error("岗位必须实现 run");
    }

    this.definition = Object.freeze({
      id: definition.id,
      name: definition.name || definition.id,
      mission: definition.mission || "",
      enabled: definition.enabled !== false,
    });
    this.store = store;
    this.stateKey = stateKey;
    this.runEmployee = run;
    this.createState = createState;
    this.normalizeState = normalizeState;
    this.resolveState = resolveState;
    this.applyControl = applyControl;
    this.projectRoleDetails = projectRole;
    this.projectWork = projectWork;
    this.operationQueue = operationQueue || new OperationQueue();
    this.running = null;
  }

  get id() {
    return this.definition.id;
  }

  run(options = {}) {
    if (this.running) return this.running;
    const operation = this.enqueue(async () => {
      const state = await this.readState();
      if (!this.definition.enabled || state.paused) {
        return this.project(state);
      }
      const runInput = {
        ...options,
        state,
      };
      if (options != null && Object.hasOwn(options, "signal")) {
        Object.defineProperty(runInput, "signal", {
          configurable: false,
          enumerable: false,
          value: options.signal,
          writable: false,
        });
      }
      const next = await this.runEmployee(runInput);
      return this.project(next || (await this.readState()));
    });
    const tracked = operation.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
    return tracked;
  }

  control(command, expectedRevision) {
    return this.enqueue(async () => {
      if (!["pause", "resume"].includes(command)) {
        throw employeeError(400, "command 只能是 pause 或 resume");
      }
      const state = await this.readState();
      this.assertRevision(state, expectedRevision);
      const paused = command === "pause";
      if (state.paused === paused) return this.project(state);
      const controlled = this.applyControl(state, paused);
      const next = await this.writeState({ ...controlled, paused });
      return this.project(next);
    });
  }

  async view() {
    return this.project(await this.readState());
  }

  async roleView() {
    return this.roleProjection(await this.readState());
  }

  enqueue(operation) {
    return this.operationQueue.enqueue(operation);
  }

  async readState() {
    const initial = this.createState();
    const stored = await this.store.read(this.stateKey, initial);
    return normalizeLifecycleState(this.normalizeState(stored));
  }

  async writeState(state, { bumpRevision = true } = {}) {
    const normalized = normalizeLifecycleState(state);
    const next = {
      ...normalized,
      revision: normalized.revision + (bumpRevision ? 1 : 0),
    };
    await this.store.write(this.stateKey, next);
    return next;
  }

  project(state) {
    const work = this.projectWork(state) || {};
    return {
      ...work,
      role: this.roleProjection(state),
    };
  }

  roleProjection(state) {
    return {
      ...(this.projectRoleDetails(state) || {}),
      id: this.definition.id,
      name: this.definition.name,
      mission: this.definition.mission,
      enabled: this.definition.enabled,
      state: this.resolveState(state, this.definition.enabled),
      revision: state.revision,
      paused: state.paused,
    };
  }

  assertRevision(state, expectedRevision) {
    if (!Number.isInteger(expectedRevision)) {
      throw employeeError(400, "expectedRevision 必须是整数");
    }
    if (state.revision !== expectedRevision) {
      throw employeeError(409, "员工状态已更新，请刷新后重新操作");
    }
  }
}
