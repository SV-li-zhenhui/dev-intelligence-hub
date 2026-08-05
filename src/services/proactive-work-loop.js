import { normalizeWorkDecision } from "../domain/work-intent.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DEFAULT_INTAKE_LIMIT = 100;
const DEFAULT_WORK_LIMIT = 20;
const MAX_PAGE_COUNT = 100;
const PAGE_SIZE = 100;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const ORCHESTRATOR_ROLE_ID = "orchestrator";
const ORCHESTRATOR_WORKER_ID = "employee-orchestrator";
const RUNTIME_ADMISSION_ERROR_CODES = new Set([
  "RUNTIME_RESTART_REQUIRED",
  "RUNTIME_CONFIGURATION_NOT_READY",
  "RUNTIME_CONFIGURATION_STATE_UNKNOWN",
]);

function requirePort(value, methods, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const port = {};
  try {
    for (const method of methods) {
      let current = value;
      let found = false;
      while (current !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(current, method);
        if (descriptor) {
          if (
            !("value" in descriptor) ||
            typeof descriptor.value !== "function"
          ) {
            throw new TypeError(`${name} is invalid`);
          }
          port[method] = descriptor.value.bind(value);
          found = true;
          break;
        }
        current = Object.getPrototypeOf(current);
      }
      if (!found) throw new TypeError(`${name} is invalid`);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  return Object.freeze(port);
}

function optionalPortMethod(value, method, name) {
  let current = value;
  try {
    while (current !== null && current !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "function"
        ) {
          throw new TypeError(`${name} is invalid`);
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw new TypeError(`${name} is invalid`, { cause: error });
  }
  return null;
}

function boundedString(value, name, maximumBytes = 128) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeRoleId(value) {
  if (typeof value !== "string" || !SAFE_ROLE_ID.test(value)) {
    throw new TypeError("roleId is invalid");
  }
  return value;
}

function dataEntries(value) {
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
  return entries;
}

function cycleOptions(value = {}) {
  const entries = dataEntries(value);
  if (!entries) throw new TypeError("runCycle options are invalid");
  const input = Object.fromEntries(entries);
  if (
    Object.keys(input).some(
      (key) =>
        !["trigger", "intakeLimit", "workLimit", "roleId"].includes(key),
    )
  ) {
    throw new TypeError("runCycle options are invalid");
  }
  return Object.freeze({
    trigger:
      input.trigger === undefined
        ? "scheduled"
        : boundedString(input.trigger, "trigger"),
    intakeLimit:
      input.intakeLimit === undefined
        ? DEFAULT_INTAKE_LIMIT
        : positiveInteger(input.intakeLimit, "intakeLimit", 100),
    workLimit:
      input.workLimit === undefined
        ? DEFAULT_WORK_LIMIT
        : positiveInteger(input.workLimit, "workLimit", 100),
    roleId: input.roleId === undefined ? null : safeRoleId(input.roleId),
  });
}

function normalizeLoopClock(clock) {
  let value;
  try {
    value = clock();
  } catch (error) {
    throw new TypeError("clock failed", { cause: error });
  }
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

function targetKey(target) {
  return `${target.type}:${target.id}`;
}

function isAvailable(item, now) {
  if (item.status === "queued") return true;
  if (item.status === "retry_wait") {
    return Date.parse(item.availableAt) <= Date.parse(now);
  }
  return (
    item.status === "working" &&
    typeof item.leaseUntil === "string" &&
    Date.parse(item.leaseUntil) <= Date.parse(now)
  );
}

function graphBlockedItemIds(items) {
  const statusById = new Map(items.map((item) => [item.itemId, item.status]));
  const childrenByParent = new Map();
  for (const item of items) {
    const parentItemId = item.graph?.parentItemId;
    if (typeof parentItemId !== "string") continue;
    const childIds = childrenByParent.get(parentItemId) ?? [];
    childIds.push(item.itemId);
    childrenByParent.set(parentItemId, childIds);
  }
  return new Set(
    items
      .filter((item) => {
        const dependencies = item.graph?.dependsOnItemIds;
        const blockedByDependency = Array.isArray(dependencies) &&
          dependencies.some(
            (dependencyId) => statusById.get(dependencyId) !== "completed",
          );
        const blockedByChild = (childrenByParent.get(item.itemId) ?? []).some(
          (childId) => statusById.get(childId) !== "completed",
        );
        return blockedByDependency || blockedByChild;
      })
      .map(({ itemId }) => itemId),
  );
}

function isConfiguredRootItem(item, resolution) {
  return (
    resolution.orchestrator === false &&
    resolution.roleId === ORCHESTRATOR_ROLE_ID &&
    item.currentTarget.type === "role" &&
    item.currentTarget.id === ORCHESTRATOR_ROLE_ID &&
    item.graph?.parentItemId === null
  );
}

function stableFailureCode(error) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    const code = descriptor && "value" in descriptor ? descriptor.value : null;
    if (
      typeof code === "string" &&
      /^[A-Z][A-Z0-9_]{0,127}$/.test(code)
    ) {
      return code;
    }
  } catch {
    // Errors are untrusted; fall through to one stable local classification.
  }
  return "ROLE_DECISION_FAILED";
}

function timeoutError(code) {
  return Object.assign(new Error(code), { code });
}

async function within(operation, durationMs, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(code)), durationMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function workerItemDto(item) {
  const {
    ownerId: _ownerId,
    leaseId: _leaseId,
    leaseUntil: _leaseUntil,
    ...visible
  } = item;
  return structuredClone(visible);
}

function orchestratorDecision(target) {
  const targetLabel = `${target.type}:${target.id}`;
  return {
    schemaVersion: 1,
    confidence: 100,
    summary: "需要用户决定缺失岗位的工作路由",
    intent: {
      schemaVersion: 1,
      type: "ask_user",
      summary: `目标 ${targetLabel} 当前没有可执行员工`,
      reason: "系统保留了原始分派，但无法安全替用户选择接手人",
      question: `工作原计划交给 ${targetLabel}，请决定由谁接手或如何重新路由。`,
      choices: [
        {
          id: "reroute",
          label: "重新路由",
          description: "选择另一个岗位或员工处理。",
        },
        {
          id: "take-over",
          label: "我来接手",
          description: "将该工作保留给用户亲自处理。",
        },
        {
          id: "keep-waiting",
          label: "继续等待",
          description: "保持工作不执行，等待目标岗位可用。",
        },
      ],
    },
  };
}

function activeQuestionTargets(items) {
  return new Set(
    items
      .filter((item) =>
        ["dispatch_pending", "waiting_user"].includes(item.status),
      )
      .map((item) => targetKey(item.currentTarget)),
  );
}

export class ProactiveWorkLoop {
  constructor({
    ledger,
    roleDirectory,
    clock = () => new Date(),
    leaseDurationMs = 2 * 60 * 1000,
    maxAttempts = 3,
    retryBaseMs = 30 * 1000,
    retryMaxMs = 15 * 60 * 1000,
    resolveTimeoutMs,
    decideTimeoutMs,
    roleContextAssembler,
    orchestratorService,
  } = {}) {
    this.ledger = requirePort(
      ledger,
      [
        "intake",
        "listItems",
        "claim",
        "stageIntent",
        "scheduleRetry",
        "transition",
      ],
      "ledger",
    );
    this.readItemForReconciliation = optionalPortMethod(
      ledger,
      "readItemForReconciliation",
      "ledger.readItemForReconciliation",
    );
    this.roleDirectory = requirePort(
      roleDirectory,
      ["resolve"],
      "roleDirectory",
    );
    if (typeof clock !== "function") throw new TypeError("clock is invalid");
    this.clock = clock;
    this.leaseDurationMs = positiveInteger(
      leaseDurationMs,
      "leaseDurationMs",
      24 * 60 * 60 * 1000,
    );
    if (this.leaseDurationMs < 1_000) {
      throw new TypeError("leaseDurationMs is invalid");
    }
    this.maxAttempts = positiveInteger(maxAttempts, "maxAttempts", 100);
    this.retryBaseMs = positiveInteger(
      retryBaseMs,
      "retryBaseMs",
      24 * 60 * 60 * 1000,
    );
    this.retryMaxMs = positiveInteger(
      retryMaxMs,
      "retryMaxMs",
      24 * 60 * 60 * 1000,
    );
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new TypeError("retryMaxMs is invalid");
    }
    this.resolveTimeoutMs = positiveInteger(
      resolveTimeoutMs ?? Math.min(10_000, this.leaseDurationMs - 1),
      "resolveTimeoutMs",
      24 * 60 * 60 * 1000,
    );
    this.decideTimeoutMs = positiveInteger(
      decideTimeoutMs ?? Math.min(60_000, this.leaseDurationMs - 1),
      "decideTimeoutMs",
      24 * 60 * 60 * 1000,
    );
    if (
      this.resolveTimeoutMs >= this.leaseDurationMs ||
      this.decideTimeoutMs >= this.leaseDurationMs
    ) {
      throw new TypeError("role timeouts must be shorter than leaseDurationMs");
    }
    if ((roleContextAssembler == null) !== (orchestratorService == null)) {
      throw new TypeError(
        "roleContextAssembler and orchestratorService must be configured together",
      );
    }
    this.roleContextAssembler = roleContextAssembler == null
      ? null
      : requirePort(
          roleContextAssembler,
          ["assemble"],
          "roleContextAssembler",
        );
    this.orchestratorService = orchestratorService == null
      ? null
      : requirePort(
          orchestratorService,
          ["execute"],
          "orchestratorService",
        );
    if (
      this.roleContextAssembler !== null &&
      this.resolveTimeoutMs + this.decideTimeoutMs >= this.leaseDurationMs
    ) {
      throw new TypeError(
        "context and decision timeouts must fit within leaseDurationMs",
      );
    }
    this.inFlightByScope = new Map();
    this.inFlightItemIds = new Set();
    this.inFlightQuestionTargets = new Set();
  }

  runCycle(input = {}) {
    const options = cycleOptions(input);
    const scope = options.roleId ?? "*";
    const running = this.inFlightByScope.get(scope);
    if (running) return running;
    const execution = this.#executeCycle(options);
    const tracked = execution.finally(() => {
      if (this.inFlightByScope.get(scope) === tracked) {
        this.inFlightByScope.delete(scope);
      }
    });
    this.inFlightByScope.set(scope, tracked);
    return tracked;
  }

  async #executeCycle(options) {
    const intake = await this.ledger.intake({ limit: options.intakeLimit });
    const items = await this.#listAllItems();
    const graphBlocked = graphBlockedItemIds(items);
    const activeQuestions = activeQuestionTargets(items);
    const resolutions = new Map();
    const outcomes = [];
    let claimedCount = 0;
    let claimAttempts = 0;
    let workAttempts = 0;

    for (const item of items) {
      if (workAttempts >= options.workLimit) break;
      if (!isAvailable(item, normalizeLoopClock(this.clock))) continue;
      if (
        options.roleId !== null &&
        options.roleId !== ORCHESTRATOR_ROLE_ID &&
        (item.currentTarget.type !== "role" ||
          item.currentTarget.id !== options.roleId)
      ) {
        continue;
      }
      const key = targetKey(item.currentTarget);
      let resolution;
      try {
        if (!resolutions.has(key)) {
          try {
            resolutions.set(key, await this.#resolve(item.currentTarget));
          } catch (error) {
            resolutions.set(key, { status: "resolution_failed", error });
          }
        }
        resolution = resolutions.get(key);
      } catch {
        outcomes.push({ itemId: item.itemId, status: "resolution_failed" });
        continue;
      }
      if (resolution.status === "resolution_failed") {
        outcomes.push({ itemId: item.itemId, status: "resolution_failed" });
        continue;
      }
      if (options.roleId !== null && resolution.roleId !== options.roleId) {
        continue;
      }
      if (resolution.status === "paused") {
        outcomes.push({ itemId: item.itemId, status: "paused" });
        continue;
      }
      const isGraphBlocked = graphBlocked.has(item.itemId);
      const configuredRoot = isConfiguredRootItem(item, resolution);
      if (
        (resolution.orchestrator || this.roleContextAssembler === null) &&
        isGraphBlocked
      ) {
        continue;
      }
      if (resolution.orchestrator && activeQuestions.has(key)) {
        outcomes.push({
          itemId: item.itemId,
          status: "missing_target_waiting",
        });
        continue;
      }
      let reservedQuestionTarget = false;
      if (resolution.orchestrator) {
        if (this.inFlightQuestionTargets.has(key)) {
          outcomes.push({
            itemId: item.itemId,
            status: "missing_target_waiting",
          });
          continue;
        }
        this.inFlightQuestionTargets.add(key);
        reservedQuestionTarget = true;
        let questionAlreadyExists;
        try {
          questionAlreadyExists = activeQuestionTargets(
            await this.#listAllItems(),
          ).has(key);
        } catch (error) {
          this.inFlightQuestionTargets.delete(key);
          throw error;
        }
        if (questionAlreadyExists) {
          this.inFlightQuestionTargets.delete(key);
          activeQuestions.add(key);
          outcomes.push({
            itemId: item.itemId,
            status: "missing_target_waiting",
          });
          continue;
        }
      }
      if (
        this.roleContextAssembler !== null &&
        !resolution.orchestrator &&
        !configuredRoot &&
        isGraphBlocked
      ) {
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
        outcomes.push({ itemId: item.itemId, status: "graph_blocked" });
        continue;
      }
      if (this.inFlightItemIds.has(item.itemId)) {
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
        outcomes.push({ itemId: item.itemId, status: "already_in_flight" });
        continue;
      }
      this.inFlightItemIds.add(item.itemId);
      try {
        workAttempts += 1;
        if (
          this.roleContextAssembler !== null &&
          configuredRoot
        ) {
          const processed = await this.#processConfiguredOrchestrator({
            item,
            worker: resolution,
            options,
            graphBlocked: isGraphBlocked,
          });
          claimAttempts += processed.claimAttempted ? 1 : 0;
          claimedCount += processed.claimed ? 1 : 0;
          outcomes.push({ itemId: item.itemId, ...processed.outcome });
          continue;
        }

        claimAttempts += 1;
        const claim = await this.#claim(item, resolution, options.intakeLimit);
        if (!claim.item) {
          outcomes.push({ itemId: item.itemId, status: claim.status });
          continue;
        }
        claimedCount += 1;
        const outcome = this.roleContextAssembler === null || resolution.orchestrator
          ? await this.#decideAndStage(claim.item, resolution, options)
          : await this.#processSpecialist(claim.item, resolution, options);
        outcomes.push({ itemId: item.itemId, ...outcome });
        if (
          resolution.orchestrator &&
          ["staged", "stage_recovered", "stage_uncertain"].includes(
            outcome.status,
          )
        ) {
          activeQuestions.add(key);
        }
      } finally {
        this.inFlightItemIds.delete(item.itemId);
        if (reservedQuestionTarget) this.inFlightQuestionTargets.delete(key);
      }
    }

    return {
      trigger: options.trigger,
      roleId: options.roleId,
      intake,
      scanned: items.length,
      workAttempts,
      claimAttempts,
      claimed: claimedCount,
      staged: outcomes.filter(({ status }) => status === "staged").length,
      recoveredStages: outcomes.filter(
        ({ status }) => status === "stage_recovered",
      ).length,
      retried: outcomes.filter(({ status }) => status === "retry_scheduled")
        .length,
      blocked: outcomes.filter(({ status }) => status === "blocked").length,
      orchestrated: outcomes.filter(({ status }) => status === "orchestrated")
        .length,
      submittedDeliveries: outcomes.filter(
        ({ status }) => status === "delivery_submitted",
      ).length,
      recoveredDeliveries: outcomes.filter(
        ({ status }) => status === "delivery_recovered",
      ).length,
      outcomes,
    };
  }

  async #resolve(target) {
    if (target.type !== "role") return this.#orchestrator(target);
    const candidate = await within(
      () => this.roleDirectory.resolve({ ...target }),
      this.resolveTimeoutMs,
      "ROLE_RESOLUTION_TIMEOUT",
    );
    if (candidate === null || candidate === undefined) {
      return this.#orchestrator(target);
    }
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      candidate.roleId !== target.id ||
      typeof candidate.enabled !== "boolean" ||
      typeof candidate.paused !== "boolean" ||
      typeof candidate.decide !== "function"
    ) {
      throw new TypeError("roleDirectory returned an invalid worker");
    }
    const workerId = boundedString(candidate.workerId, "workerId");
    if (!candidate.enabled || candidate.paused) {
      return {
        status: "paused",
        orchestrator: false,
        roleId: candidate.roleId,
        workerId,
      };
    }
    return {
      status: "active",
      orchestrator: false,
      roleId: candidate.roleId,
      workerId,
      decide: candidate.decide.bind(candidate),
    };
  }

  #orchestrator(target) {
    return {
      status: "active",
      orchestrator: true,
      roleId: ORCHESTRATOR_ROLE_ID,
      workerId: ORCHESTRATOR_WORKER_ID,
      decide: async () => orchestratorDecision(target),
    };
  }

  async #claim(item, worker, intakeLimit) {
    try {
      return {
        status: "claimed",
        item: await this.ledger.claim({
          itemId: item.itemId,
          expectedRevision: item.revision,
          workerId: worker.workerId,
          leaseDurationMs: this.leaseDurationMs,
        }),
      };
    } catch (error) {
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        throw error;
      }
      const observed = await this.#observeItem(item.itemId, intakeLimit);
      if (
        observed &&
        observed.status === "working" &&
        observed.ownerId === worker.workerId &&
        observed.revision === item.revision + 1 &&
        observed.attempt === item.attempt + 1 &&
        observed.inputDigest === item.inputDigest
      ) {
        return { status: "claim_recovered", item: observed };
      }
      return {
        status: observed ? "claim_not_acquired" : "claim_uncertain",
        item: null,
      };
    }
  }

  async #assembleContext(item, worker, options) {
    return within(
      () => this.roleContextAssembler.assemble({
        roleId: worker.roleId,
        item,
        trigger: options.trigger,
      }),
      this.resolveTimeoutMs,
      "ROLE_CONTEXT_TIMEOUT",
    );
  }

  async #decide(item, worker, options, context) {
    return normalizeWorkDecision(
      await within(
        () => worker.decide({
          item: workerItemDto(item),
          trigger: options.trigger,
          ...(context === undefined ? {} : { context }),
        }),
        this.decideTimeoutMs,
        "ROLE_DECISION_TIMEOUT",
      ),
    );
  }

  async #processConfiguredOrchestrator({
    item,
    worker,
    options,
    graphBlocked,
  }) {
    const packet = await this.#assembleContext(item, worker, options);
    const decision = await this.#decide(
      item,
      worker,
      options,
      packet.context,
    );
    if (decision.intent.type === "orchestrate") {
      const executed = await this.orchestratorService.execute({
        worker: { roleId: worker.roleId, workerId: worker.workerId },
        item,
        contextPacket: packet,
        intent: decision.intent,
      });
      return {
        claimAttempted: false,
        claimed: false,
        outcome: {
          status: "orchestrated",
          workerId: worker.workerId,
          action: decision.intent.action.type,
          applied: executed.applied,
        },
      };
    }
    if (decision.intent.type === "submit_delivery") {
      throw Object.assign(
        new Error("The configured root orchestrator cannot submit a delivery"),
        { code: "ORCHESTRATOR_DELIVERY_NOT_SUPPORTED" },
      );
    }
    if (graphBlocked) {
      return {
        claimAttempted: false,
        claimed: false,
        outcome: { status: "graph_blocked", workerId: worker.workerId },
      };
    }
    const claim = await this.#claim(item, worker, options.intakeLimit);
    if (!claim.item) {
      return {
        claimAttempted: true,
        claimed: false,
        outcome: { status: claim.status },
      };
    }
    return {
      claimAttempted: true,
      claimed: true,
      outcome: await this.#stageDecision(
        claim.item,
        worker,
        options,
        decision,
      ),
    };
  }

  async #processSpecialist(item, worker, options) {
    let packet;
    let decision;
    try {
      packet = await this.#assembleContext(item, worker, options);
      decision = await this.#decide(
        item,
        worker,
        options,
        packet.context,
      );
      if (decision.intent.type === "submit_delivery") {
        const executed = await this.orchestratorService.execute({
          worker: { roleId: worker.roleId, workerId: worker.workerId },
          item,
          contextPacket: packet,
          intent: decision.intent,
        });
        return {
          status: executed.recovered
            ? "delivery_recovered"
            : "delivery_submitted",
          workerId: worker.workerId,
          deliveryRevision: executed.deliveryRevision,
        };
      }
      if (decision.intent.type === "orchestrate") {
        throw Object.assign(
          new Error("A specialist cannot execute an orchestration action"),
          { code: "SPECIALIST_ORCHESTRATION_NOT_PERMITTED" },
        );
      }
    } catch (error) {
      if (RUNTIME_ADMISSION_ERROR_CODES.has(stableFailureCode(error))) {
        // Configuration cutover is not an employee failure. Keep the durable
        // claim intact so the item can be recomputed after restart.
        throw error;
      }
      return this.#recordFailure(item, worker.workerId, error, options);
    }
    return this.#stageDecision(item, worker, options, decision);
  }

  async #decideAndStage(item, worker, options) {
    let decision;
    try {
      decision = await this.#decide(item, worker, options);
    } catch (error) {
      return this.#recordFailure(item, worker.workerId, error, options);
    }

    return this.#stageDecision(item, worker, options, decision);
  }

  async #stageDecision(item, worker, options, decision) {
    try {
      await this.ledger.stageIntent({
        itemId: item.itemId,
        expectedRevision: item.revision,
        leaseId: item.leaseId,
        actorId: worker.workerId,
        roleId: worker.roleId,
        intent: decision.intent,
      });
      return { status: "staged", workerId: worker.workerId };
    } catch (error) {
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
      );
      if (
        ["dispatch_pending", "waiting_user"].includes(observed?.status) &&
        observed.inputDigest === item.inputDigest &&
        (observed.status === "waiting_user" ||
          observed.revision === item.revision + 1)
      ) {
        return { status: "stage_recovered", workerId: worker.workerId };
      }
      if (
        observed?.status === "working" &&
        observed.revision === item.revision &&
        observed.leaseId === item.leaseId
      ) {
        return this.#recordFailure(item, worker.workerId, error, options);
      }
      return {
        status: observed ? "stage_state_changed" : "stage_uncertain",
        workerId: worker.workerId,
      };
    }
  }

  async #recordFailure(item, actorId, error, options) {
    const code = stableFailureCode(error);
    const input = {
      itemId: item.itemId,
      expectedRevision: item.revision,
      leaseId: item.leaseId,
      actorId,
      reason:
        item.attempt >= this.maxAttempts
          ? "decision_attempts_exhausted"
          : "decision_failed",
    };
    try {
      if (item.attempt >= this.maxAttempts) {
        await this.ledger.transition({
          ...input,
          toStatus: "blocked",
          details: { code },
        });
        return { status: "blocked", workerId: actorId, code };
      }
      const exponent = Math.min(item.attempt - 1, 30);
      const delay = Math.min(
        this.retryMaxMs,
        this.retryBaseMs * 2 ** exponent,
      );
      await this.ledger.scheduleRetry({
        ...input,
        availableAt: new Date(
          Date.parse(normalizeLoopClock(this.clock)) + delay,
        ).toISOString(),
      });
      return { status: "retry_scheduled", workerId: actorId, code };
    } catch {
      const observed = await this.#observeItem(
        item.itemId,
        options.intakeLimit,
      );
      if (observed?.status === "blocked") {
        return { status: "blocked", workerId: actorId, code };
      }
      if (observed?.status === "retry_wait") {
        return { status: "retry_scheduled", workerId: actorId, code };
      }
      return {
        status: observed ? "failure_state_unchanged" : "failure_uncertain",
        workerId: actorId,
        code,
      };
    }
  }

  async #observeItem(itemId, intakeLimit) {
    try {
      if (this.readItemForReconciliation !== null) {
        return await this.readItemForReconciliation({ itemId });
      }
      await this.ledger.intake({ limit: Math.min(intakeLimit, 1) });
      return await this.#findItem(itemId);
    } catch {
      return null;
    }
  }

  async #findItem(itemId) {
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      const result = await this.ledger.listItems({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      const found = result.items.find((item) => item.itemId === itemId);
      if (found) return found;
      if (!result.nextCursor) return null;
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }

  async #listAllItems() {
    const items = [];
    let cursor = null;
    for (let page = 0; page < MAX_PAGE_COUNT; page += 1) {
      const result = await this.ledger.listItems({
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (!result || !Array.isArray(result.items)) {
        throw new TypeError("ledger listItems result is invalid");
      }
      items.push(...result.items);
      if (!result.nextCursor) return items;
      if (result.nextCursor === cursor) {
        throw new TypeError("ledger pagination did not advance");
      }
      cursor = result.nextCursor;
    }
    throw new TypeError("ledger pagination exceeded its safety bound");
  }
}
