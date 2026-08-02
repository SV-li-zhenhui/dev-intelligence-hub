import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { LocalMemoryJournal } from "./services/local-memory-journal.js";

const GUARD_NAME = "mydashboard-unified-memory-v1";

function requireGuard(value) {
  if (
    !value ||
    typeof value.acquire !== "function" ||
    typeof value.run !== "function" ||
    typeof value.close !== "function"
  ) {
    throw new TypeError("memory guard is invalid");
  }
  return value;
}

function frozenPort(source, methods) {
  return Object.freeze(
    Object.fromEntries(
      methods.map((method) => [method, source[method].bind(source)]),
    ),
  );
}

export async function createMemoryRuntime({
  store,
  operationQueue = new OperationQueue(),
  maximumRecords,
  maximumStateBytes,
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const guard = requireGuard(createGuard({ name: GUARD_NAME }));
  let closePromise = null;
  const close = () => {
    closePromise ||= Promise.resolve().then(() => guard.close());
    return closePromise;
  };
  try {
    await guard.acquire();
    const journal = new LocalMemoryJournal({
      store,
      exclusiveLease: guard,
      operationQueue,
      ...(maximumRecords === undefined ? {} : { maximumRecords }),
      ...(maximumStateBytes === undefined ? {} : { maximumStateBytes }),
    });
    await journal.recover();
    return Object.freeze({
      producer: frozenPort(journal, ["append", "appendBatch"]),
      search: frozenPort(journal, ["search", "getHealth"]),
      receiptVerifier: Object.freeze({
        verify: journal.verifyReceipt.bind(journal),
      }),
      maintenance: frozenPort(journal, ["rebuildIndex"]),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Keep the original recovery failure while the runtime remains closed.
    }
    throw error;
  }
}
