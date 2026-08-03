import { randomUUID } from "node:crypto";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { WorkGraphStore } from "./services/work-graph-store.js";
import { WorkLedgerService } from "./services/work-ledger-service.js";
import { workLedgerError } from "./services/work-ledger-values.js";

const GUARD_NAME = "mydashboard-work-ledger-v1";
const ORCHESTRATOR_PRINCIPAL_ID = "employee-orchestrator";
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
  "cancelGraphTask",
  "stageIntent",
  "claimIntent",
  "ackIntent",
  "applyAttentionBatch",
  "applyProposalBatch",
  "wakeCondition",
]);

function runtimeClosedError() {
  return workLedgerError(
    "WORK_LEDGER_RUNTIME_CLOSED",
    "工作台账运行时已关闭",
    503,
  );
}

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
  let accepting = true;
  const acceptedOperations = new Set();
  const admit = (operation) => {
    if (!accepting) return Promise.reject(runtimeClosedError());
    let result;
    try {
      result = Promise.resolve(operation());
    } catch (error) {
      result = Promise.reject(error);
    }
    acceptedOperations.add(result);
    result.then(
      () => acceptedOperations.delete(result),
      () => acceptedOperations.delete(result),
    );
    return result;
  };
  const close = () => {
    accepting = false;
    closePromise ||= Promise.allSettled([...acceptedOperations]).then(() =>
      guard.close(),
    );
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
    const graph = new WorkGraphStore({ ledger: service });
    const graphReader = graph.reader();
    const graphPlanner = graph.planner({
      principalId: ORCHESTRATOR_PRINCIPAL_ID,
      scopeRootTaskId: null,
    });
    const runtime = {
      graphReader: Object.freeze({
        getSnapshot: () => admit(() => graphReader.getSnapshot()),
      }),
      graphPlanner: Object.freeze({
        createChild: (command) => admit(() => graphPlanner.createChild(command)),
        reviseAcceptanceContract: (command) =>
          admit(() => graphPlanner.reviseAcceptanceContract(command)),
        decideDelivery: (command) =>
          admit(() => graphPlanner.decideDelivery(command)),
      }),
      graphMemoryProjectionSource: Object.freeze({
        readBatch: (options) =>
          admit(() => service.readGraphMemoryProjectionBatch(options)),
        ack: (receipt) =>
          admit(() => service.acknowledgeGraphMemoryProjection(receipt)),
        ackBatch: (request) =>
          admit(() => service.acknowledgeGraphMemoryProjectionBatch(request)),
      }),
      close,
    };
    for (const method of RUNTIME_METHODS) {
      runtime[method] = (...args) => admit(() => service[method](...args));
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
