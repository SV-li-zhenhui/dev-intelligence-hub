import { randomUUID } from "node:crypto";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { WorkLedgerService } from "./services/work-ledger-service.js";

const GUARD_NAME = "mydashboard-work-ledger-v1";
const RUNTIME_METHODS = Object.freeze([
  "getSummary",
  "listItems",
  "listTimeline",
  "listOutbox",
  "intake",
  "claim",
  "transition",
  "scheduleRetry",
  "handoff",
  "complete",
  "stageIntent",
  "claimIntent",
  "ackIntent",
  "applyAttentionBatch",
  "applyProposalBatch",
  "wakeCondition",
]);

export async function createWorkLedgerRuntime({
  store,
  assignmentSource,
  operationQueue,
  clock,
  idFactory = randomUUID,
  limits,
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const guard = createGuard({ name: GUARD_NAME });
  if (
    !guard ||
    typeof guard.acquire !== "function" ||
    typeof guard.run !== "function" ||
    typeof guard.close !== "function"
  ) {
    throw new TypeError("work ledger guard is invalid");
  }
  let closePromise = null;
  const close = () => {
    closePromise ||= Promise.resolve().then(() => guard.close());
    return closePromise;
  };

  try {
    await guard.acquire();
    const service = new WorkLedgerService({
      store,
      assignmentSource,
      exclusiveLease: guard,
      idFactory,
      ...(operationQueue ? { operationQueue } : {}),
      ...(clock ? { clock } : {}),
      ...(limits ? { limits } : {}),
    });
    await service.recover();
    const runtime = { close };
    for (const method of RUNTIME_METHODS) {
      runtime[method] = (...args) => service[method](...args);
    }
    return Object.freeze(runtime);
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure while the ledger remains fail closed.
    }
    throw error;
  }
}
