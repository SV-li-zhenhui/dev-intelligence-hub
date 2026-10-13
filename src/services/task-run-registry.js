import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { OperationQueue } from "../lib/operation-queue.js";
import { withTaskExecution } from '../lib/task-execution-context.js';

export const TASK_RUN_STATE_KEY = "task-run-settings";
const MAX_RECORDS = 1_000;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_INSTRUCTIONS = 20;
const MAX_INSTRUCTION_BYTES = 4_000;
const MAX_ROUNDS = 5;
const KINDS = new Set(["work-item", "code-job"]);
const PRIORITIES = new Map([["normal", 0], ["high", 1], ["urgent", 2]]);
const MODES = new Set(["active", "paused", "cancelled"]);
const STORED_PHASES = new Set(["idle", "waiting_checkpoint", "paused", "cancelled"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/u;

export class TaskRunControlError extends Error {
  constructor(code, message, statusCode = 409, options) {
    super(message, options);
    this.name = "TaskRunControlError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function registryError(code, message, statusCode = 409) {
  return new TaskRunControlError(code, message, statusCode);
}

function invalidInput() {
  return registryError("TASK_RUN_INPUT_INVALID", "运行任务控制输入无效", 400);
}

function invalidState() {
  return registryError("TASK_RUN_STATE_INVALID", "运行任务设置状态无效", 500);
}

function conflict() {
  return registryError("TASK_RUN_CONFLICT", "任务运行或修订号已变化，请刷新后重试");
}

function capacityExceeded() {
  return registryError("TASK_RUN_CAPACITY_EXCEEDED", "运行任务设置容量已满", 507);
}

function heldError(mode) {
  return mode === "cancelled"
    ? registryError("TASK_RUN_CANCELLED", "任务已在安全检查点取消")
    : registryError("TASK_RUN_PAUSED", "任务已在安全检查点暂停");
}

function plainKeys(value, error) {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw error;
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable ||
        !("value" in descriptor)) throw error;
  }
  return keys;
}

function exactKeys(value, required, optional, error) {
  const keys = plainKeys(value, error);
  if (required.some((key) => !keys.includes(key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw error;
  }
}

function denseArray(value, maximum, error) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) throw error;
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    entries.push(descriptor.value);
  }
  return entries;
}

function revision(value, error) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw error;
  return value;
}

function increment(value) {
  if (value === Number.MAX_SAFE_INTEGER) throw capacityExceeded();
  return value + 1;
}

function identifier(value, error) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw error;
  return value;
}

function identity(kind, taskId, error = invalidInput()) {
  if (!KINDS.has(kind)) throw error;
  identifier(taskId, error);
  return `${kind}:${taskId}`;
}

function timestamp(value, error) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) throw error;
  return value;
}

function displayText(value, maximum, error) {
  if (typeof value !== "string" || value.length > MAX_STATE_BYTES) throw error;
  const cleaned = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(cleaned, "utf8") <= maximum) return cleaned;
  let result = "";
  let size = 0;
  for (const character of cleaned) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > maximum) break;
    result += character;
    size += bytes;
  }
  return result;
}

function normalizeTask(value, error = invalidInput(), stored = false) {
  exactKeys(value, ["kind", "taskId", "roleId", "title", "subject", "revision"], ["leaseId"], error);
  identity(value.kind, value.taskId, error);
  identifier(value.roleId, error);
  revision(value.revision, error);
  if ("leaseId" in value) identifier(value.leaseId, error);
  const title = displayText(value.title, 500, error);
  const subject = displayText(value.subject, 1_000, error);
  if (stored && (title !== value.title || subject !== value.subject)) throw error;
  return {
    kind: value.kind,
    taskId: value.taskId,
    roleId: value.roleId,
    title,
    subject,
    revision: value.revision,
    ...("leaseId" in value ? { leaseId: value.leaseId } : {}),
  };
}

function instructionText(value, error) {
  if (typeof value !== "string" || !value.trim() ||
      Buffer.byteLength(value, "utf8") > MAX_INSTRUCTION_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw error;
  return value.trim();
}

function normalizeControl(value) {
  const error = invalidInput();
  const keys = plainKeys(value, error);
  if (!keys.includes("command")) throw error;
  const commandFields = {
    instruct: ["instruction"], priority: ["priority"], pause: [], resume: [], cancel: [],
  };
  if (typeof value.command !== "string" || !Object.hasOwn(commandFields, value.command)) throw error;
  exactKeys(value, ["runId", "expectedRevision", "command", ...commandFields[value.command]], [], error);
  if (typeof value.runId !== "string" || !UUID.test(value.runId)) throw error;
  revision(value.expectedRevision, error);
  if (value.command === "instruct") return { ...value, instruction: instructionText(value.instruction, error) };
  if (value.command === "priority" && !PRIORITIES.has(value.priority)) throw error;
  return { ...value };
}

function normalizeRecord(value) {
  const error = invalidState();
  exactKeys(value, ["task", "runId", "revision", "startedAt", "priority", "instructions",
    "appliedRevision", "pendingCommand", "mode", "phase"], ["stopUnconfirmed","terminalStatus"], error);
  if ("stopUnconfirmed" in value && (value.stopUnconfirmed !== true || value.pendingCommand === null)) throw error;
  if ('terminalStatus' in value && (!['completed','failed','fenced','cancelled'].includes(value.terminalStatus) || value.pendingCommand !== null || value.mode !== 'active')) throw error;
  const task = normalizeTask(value.task, error, true);
  if (typeof value.runId !== "string" || !UUID.test(value.runId) ||
      !PRIORITIES.has(value.priority) || !MODES.has(value.mode) ||
      !STORED_PHASES.has(value.phase)) throw error;
  timestamp(value.startedAt, error);
  revision(value.revision, error);
  revision(value.appliedRevision, error);
  if (value.revision === 0 || value.appliedRevision > value.revision) throw error;
  const instructions = denseArray(value.instructions, MAX_INSTRUCTIONS, error).map((entry) => {
    exactKeys(entry, ["text", "at"], [], error);
    if (instructionText(entry.text, error) !== entry.text) throw error;
    timestamp(entry.at, error);
    return { text: entry.text, at: entry.at };
  });
  if (instructions.length > value.revision) throw error;
  const expectedCommand = { active: null, paused: "pause", cancelled: "cancel" }[value.mode];
  if (value.pendingCommand !== null && value.pendingCommand !== expectedCommand) throw error;
  if ((value.pendingCommand !== null) !== (value.phase === "waiting_checkpoint") ||
      (value.pendingCommand === null && value.phase !== (value.mode === "active" ? "idle" : value.mode))) {
    throw error;
  }
  return { ...value, task, instructions };
}

function emptyState() {
  return { schemaVersion: 1, revision: 0, records: [] };
}

function normalizeState(value) {
  const error = invalidState();
  exactKeys(value, ["schemaVersion", "revision", "records"], [], error);
  if (value.schemaVersion !== 1) throw error;
  revision(value.revision, error);
  const records = denseArray(value.records, MAX_RECORDS, error).map(normalizeRecord);
  const keys = records.map(({ task }) => identity(task.kind, task.taskId, error));
  if (new Set(keys).size !== keys.length || records.some((entry) => entry.revision > value.revision)) throw error;
  const state = { schemaVersion: 1, revision: value.revision, records };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_STATE_BYTES) throw error;
  return state;
}

function findRecord(state, key) {
  return state.records.find(({ task }) => identity(task.kind, task.taskId) === key);
}

function defaultRecord(run) {
  return {
    task: run.task,
    runId: run.runId,
    revision: 0,
    startedAt: run.startedAt,
    priority: "normal",
    instructions: [],
    appliedRevision: 0,
    pendingCommand: null,
    mode: "active",
    phase: "idle",
  };
}

function runView(record, run) {
  const { task } = record;
  const waiting = record.pendingCommand !== null ||
    (run && record.instructions.length !== run.instructionCount);
  return {
    kind: task.kind,
    taskId: task.taskId,
    runId: run?.runId ?? record.runId,
    revision: record.revision,
    roleId: task.roleId,
    title: task.title,
    subject: task.subject,
    startedAt: run?.startedAt ?? record.startedAt,
    phase: run ? (waiting ? "waiting_checkpoint" : "running") :
      (record.pendingCommand === null ? record.terminalStatus ?? record.phase : "control_failed"),
    priority: record.priority,
    instructions: record.instructions.map((entry) => ({ ...entry })),
    appliedRevision: run?.appliedRevision ?? record.appliedRevision,
    pendingCommand: record.pendingCommand,
    mode: run ? "active" : record.mode,
    active: Boolean(run),
    live: Boolean(run?.liveControl),
    progress: run?.progress ?? '',
    lastActivityAt: run?.lastActivityAt ?? record.startedAt,
    instructionReceipt: run?.instructionReceipt ?? (run?.liveControl ? 'ready' : 'checkpoint'),
    stopUnconfirmed: record.stopUnconfirmed === true,
  };
}

export class TaskRunRegistry {
  #queue = new OperationQueue();
  #active = new Map();
  #knownState = null;

  constructor({ store, clock = () => new Date(), settleControl, verifyStopped = async () => false } = {}) {
    if (!store || typeof store.read !== "function" || typeof store.write !== "function" ||
        typeof clock !== "function" || typeof settleControl !== "function" || typeof verifyStopped !== 'function') {
      throw new TypeError("TaskRunRegistry dependencies are invalid");
    }
    this.store = store;
    this.clock = clock;
    this.settleControl = settleControl;
    this.verifyStopped = verifyStopped;
  }

  async run(input, operation, {repeatOnInstruction = true} = {}) {
    const task = normalizeTask(input);
    if (typeof operation !== "function") throw new TypeError("operation must be a function");
    const run = await this.#queue.enqueue(() => this.#register(task));
    run.repeatOnInstruction = repeatOnInstruction;
    try {
      let instructions = run.instructions;
      for (let round = 1; ; round += 1) {
        let result;
        const context = {
          reportProgress: (text) => { run.progress = displayText(text, 500, invalidInput()); run.lastActivityAt = this.#now(); },
          registerLiveControl: (control) => {
            if (typeof control?.steer !== 'function' || typeof control?.interrupt !== 'function') throw invalidInput();
            run.liveControl = control;
            return () => { if (run.liveControl === control) run.liveControl = null; };
          },
          confirmStopped: () => { run.stoppedConfirmed = true; },
        };
        try { result = await withTaskExecution(context, () => operation({ instructions: [...instructions] })); }
        catch (error) {
          await this.#queue.enqueue(async () => {
            const state = await this.#readState();
            const current = findRecord(state, run.key);
            if (!current || current.mode === 'active') return;
            if (error?.code === 'STRUCTURED_PROVIDER_REAP_FAILED' && !run.stoppedConfirmed) {
              throw new TaskRunControlError('TASK_RUN_CONTROL_PENDING','停止尚未确认，等待维护核实',409,{cause:error});
            }
            await this.#checkpoint(run,round);
          });
          throw error;
        }
        const checkpoint = await this.#queue.enqueue(() => this.#checkpoint(run, round));
        if (checkpoint.done) return result;
        instructions = checkpoint.instructions;
      }
    } finally {
      // The final checkpoint and every control share this queue, closing acceptance before dispatch.
      await this.#queue.enqueue(() => {
        if (this.#active.get(run.key) === run) this.#active.delete(run.key);
      });
    }
  }

  async list() {
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      const items = [...this.#active].map(([key, run]) => runView(findRecord(state, key) ?? defaultRecord(run), run));
      const held = state.records.filter((record) => {
        const key = identity(record.task.kind, record.task.taskId);
        return !this.#active.has(key) && (record.mode === "paused" || record.pendingCommand !== null);
      }).map((record) => runView(record));
      return { enabled: true, items, held };
    });
  }

  async reconcile() {
    return this.#queue.enqueue(async () => {
      let state = await this.#readState();
      const pending = state.records.filter((entry) => entry.pendingCommand &&
        !this.#active.has(identity(entry.task.kind,entry.task.taskId))).slice(0,20);
      for (const record of pending) {
        try { await this.#settleHeld(state,record); } catch { /* Keep unresolved holds available for maintenance. */ }
        state = await this.#readState();
      }
    });
  }

  async get(kind, taskId) {
    const key = identity(kind, taskId);
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      const run = this.#active.get(key);
      const record = findRecord(state, key) ?? (run && defaultRecord(run));
      if (!record) throw registryError("TASK_RUN_NOT_FOUND", "运行任务不存在", 404);
      return runView(record, run);
    });
  }

  async control(kind, taskId, input) {
    const key = identity(kind, taskId);
    const command = normalizeControl(input);
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      const run = this.#active.get(key);
      const current = findRecord(state, key) ?? (run && defaultRecord(run));
      if (!current) throw registryError("TASK_RUN_NOT_FOUND", "运行任务不存在", 404);
      if (command.runId !== (run?.runId ?? current.runId) ||
          command.expectedRevision !== current.revision) throw conflict();
      return this.#applyControl(state, current, run, command);
    });
  }

  async order(items, kind, idKey) {
    if (!KINDS.has(kind) || typeof idKey !== "string" || !idKey ||
        ["__proto__", "constructor", "prototype"].includes(idKey)) throw invalidInput();
    const candidates = denseArray(items, 10_000, invalidInput()).map((item, index) => {
      plainKeys(item, invalidInput());
      return { item, index, key: identity(kind, item[idKey]) };
    });
    return this.#queue.enqueue(async () => {
      const state = await this.#readState();
      const settings = new Map(state.records.map((entry) => [identity(entry.task.kind, entry.task.taskId), entry]));
      return candidates.filter(({ key,item }) => (settings.get(key)?.mode ?? "active") === "active" ||
        (kind === 'code-job' && ['pausing','cancelling','unknown'].includes(item.status)))
        .sort((a, b) => PRIORITIES.get(settings.get(b.key)?.priority ?? "normal") -
          PRIORITIES.get(settings.get(a.key)?.priority ?? "normal") || a.index - b.index)
        .map(({ item }) => item);
    });
  }

  async #register(task) {
    const key = identity(task.kind, task.taskId);
    const state = await this.#readState();
    if (this.#active.has(key)) throw conflict();
    const current = findRecord(state, key);
    if (current && current.mode !== "active") throw heldError(current.mode);
    const run = {
      key, task, runId: randomUUID(), startedAt: this.#now(),
      appliedRevision: current?.revision ?? 0,
      instructionCount: current?.instructions.length ?? 0,
      instructions: current?.instructions.map(({ text }) => text) ?? [],
    };
    if (current) {
      await this.#writeRecord(state, {
        ...current, task, runId: run.runId, startedAt: run.startedAt,
        appliedRevision: run.appliedRevision,
      });
    }
    this.#active.set(key, run);
    return run;
  }

  async #applyControl(state, current, run, input) {
    const { command } = input;
    if ((["instruct", "pause"].includes(command) && !run) ||
        (command === "cancel" && !run && current.mode === "active")) {
      throw registryError("TASK_RUN_NOT_ACTIVE", "任务当前没有正在运行的模型回合");
    }
    if (command === "resume") return this.#resume(state, current, run);
    if ((command === "pause" && current.mode !== "active") ||
        (command === "cancel" && current.mode === "cancelled" && current.pendingCommand === null)) {
      throw conflict();
    }
    const candidate = {
      ...current,
      revision: increment(current.revision),
      appliedRevision: run?.appliedRevision ?? current.appliedRevision,
    };
    if (command === "instruct") {
      if (current.instructions.length === MAX_INSTRUCTIONS) throw capacityExceeded();
      candidate.instructions = [...current.instructions, { text: input.instruction, at: this.#now() }];
    } else if (command === "priority") {
      candidate.priority = input.priority;
    } else {
      candidate.mode = command === "pause" ? "paused" : "cancelled";
      candidate.pendingCommand = command;
      candidate.phase = "waiting_checkpoint";
      if (run?.repeatOnInstruction) candidate.stopUnconfirmed = true;
    }
    const committed = await this.#writeRecord(state, candidate);
    if (run?.liveControl && command === 'instruct') {
      try {
        await run.liveControl.steer(input.instruction, `${run.runId}:${candidate.revision}`);
        run.instructionCount = candidate.instructions.length;
        run.appliedRevision = candidate.revision;
        run.instructionReceipt = 'submitted';
      } catch (cause) {
        run.instructionReceipt = 'failed';
        throw new TaskRunControlError('TASK_RUN_STEER_FAILED','追加要求未确认送达；已保存，将在安全检查点续接',409,{cause});
      }
    } else if (run?.liveControl && ['pause','cancel'].includes(command)) {
      await run.liveControl.interrupt();
    }
    if (command === "cancel" && !run) {
      return runView(await this.#settleHeld(committed, candidate));
    }
    return runView(candidate, run);
  }

  async #resume(state, current, run) {
    if (run || current.mode !== "paused") throw conflict();
    if (current.pendingCommand) {
      current = await this.#settleHeld(state,current);
      if (current.pendingCommand) throw registryError('TASK_RUN_CONTROL_PENDING','停止尚未确认，不能恢复');
      if (current.terminalStatus) throw registryError('TASK_RUN_TERMINAL','原任务已结束，请刷新查看最终状态');
      state = await this.#readState();
    }
    await this.settleControl({ task: structuredClone(current.task), command: "resume" });
    const candidate = {
      ...current, revision: increment(current.revision), mode: "active",
      phase: "idle", pendingCommand: null,
    };
    await this.#writeRecord(state, candidate);
    return runView(candidate);
  }

  async #checkpoint(run, round) {
    let state = await this.#readState();
    let current = findRecord(state, run.key);
    if (current && current.mode !== "active") {
      let settled;
      try {
        if (current.stopUnconfirmed) {
          const {stopUnconfirmed,...confirmed} = current;
          state = await this.#writeRecord(state,confirmed);
          current = confirmed;
        }
        settled = await this.#settleHeld(state, current);
      } catch(cause) {
        throw new TaskRunControlError('TASK_RUN_CONTROL_PENDING','控制已保存，等待台账核对',409,{cause});
      }
      this.#active.delete(run.key);
      if (settled.terminalStatus) return {done:true};
      if (settled.pendingCommand) throw registryError('TASK_RUN_CONTROL_PENDING','停止请求已保存，等待执行器核对');
      throw heldError(current.mode);
    }
    if (run.repeatOnInstruction && current && current.instructions.length !== run.instructionCount) {
      if (round >= MAX_ROUNDS) {
        current = {
          ...current, revision: increment(current.revision), mode: "paused",
          phase: "waiting_checkpoint", pendingCommand: "pause",
          appliedRevision: run.appliedRevision,
        };
        state = await this.#writeRecord(state, current);
        try {
          const settled = await this.#settleHeld(state, current);
          if (settled.pendingCommand) throw registryError('TASK_RUN_CONTROL_PENDING','补充要求变化过于频繁，暂停仍等待核对');
        } catch(cause) {
          if (cause instanceof TaskRunControlError) throw cause;
          throw new TaskRunControlError('TASK_RUN_CONTROL_PENDING','补充要求变化过于频繁，暂停仍等待核对',409,{cause});
        }
        this.#active.delete(run.key);
        throw registryError("TASK_RUN_ADJUSTMENT_LIMIT", "任务补充要求变化过于频繁，已暂停等待恢复");
      }
      run.appliedRevision = current.revision;
      run.instructionCount = current.instructions.length;
      return { done: false, instructions: current.instructions.map(({ text }) => text) };
    }
    if (current && current.appliedRevision !== run.appliedRevision) {
      await this.#writeRecord(state, { ...current, appliedRevision: run.appliedRevision });
    }
    this.#active.delete(run.key);
    return { done: true };
  }

  async #settleHeld(state, current) {
    if (current.stopUnconfirmed && !(await this.verifyStopped(structuredClone(current.task)))) return current;
    const command = current.mode === "paused" ? "pause" : "cancel";
    const outcome = await this.settleControl({ task: structuredClone(current.task), command });
    if (outcome?.pending) return current;
    const {stopUnconfirmed,...record} = current;
    const settled = outcome?.terminalStatus ? {...record,pendingCommand:null,phase:'idle',mode:'active',terminalStatus:outcome.terminalStatus} :
      { ...record, pendingCommand: null, phase: current.mode };
    await this.#writeRecord(state, settled);
    return settled;
  }

  async #readState() {
    const state = normalizeState(await this.store.read(TASK_RUN_STATE_KEY, emptyState()));
    if (this.#knownState && (state.revision < this.#knownState.revision ||
        state.revision === this.#knownState.revision && JSON.stringify(state) !== JSON.stringify(this.#knownState))) {
      throw invalidState();
    }
    this.#knownState = state;
    return state;
  }

  async #writeRecord(state, record) {
    const key = identity(record.task.kind, record.task.taskId);
    const index = state.records.findIndex(({ task }) => identity(task.kind, task.taskId) === key);
    const records = [...state.records];
    if (index < 0) records.push(record);
    else records[index] = record;
    if (records.length > MAX_RECORDS) throw capacityExceeded();
    const candidate = { schemaVersion: 1, revision: increment(state.revision), records };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_STATE_BYTES) throw capacityExceeded();
    const normalized = normalizeState(candidate);
    await this.store.write(TASK_RUN_STATE_KEY, normalized);
    this.#knownState = normalized;
    return normalized;
  }

  #now() {
    const value = this.clock();
    const error = registryError("TASK_RUN_CLOCK_INVALID", "运行任务时钟无效", 500);
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw error;
      return value.toISOString();
    }
    return timestamp(value, error);
  }
}
