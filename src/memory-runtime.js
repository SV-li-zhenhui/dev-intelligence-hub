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

function requireAuthoritySource(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value.readStatus !== "function"
  ) {
    throw new TypeError("memory authority source is invalid");
  }
  return Object.freeze({ readStatus: value.readStatus.bind(value) });
}

function authorityNotCurrent() {
  return Object.assign(
    new Error("记忆权威投影尚未追平当前工作台账"),
    { code: "MEMORY_AUTHORITY_NOT_CURRENT", statusCode: 503 },
  );
}

export async function createMemoryRuntime({
  store,
  operationQueue = new OperationQueue(),
  maximumRecords,
  maximumStateBytes,
  createGuard = (options) => new ProcessExclusiveGuard(options),
  authoritySource = null,
  confirmationAuthoritySource = null,
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
    const boundAuthoritySource = authoritySource === null
      ? null
      : requireAuthoritySource(authoritySource);
    const boundConfirmationAuthoritySource =
      confirmationAuthoritySource === null
        ? null
        : requireAuthoritySource(confirmationAuthoritySource);
    const assertAuthorityCurrent = async () => {
      if (
        boundAuthoritySource === null &&
        boundConfirmationAuthoritySource === null
      ) {
        if (journal.requiresLiveAuthority()) throw authorityNotCurrent();
        return null;
      }
      if (boundAuthoritySource === null && journal.requiresLiveAuthority()) {
        throw authorityNotCurrent();
      }
      const [status, confirmationStatus] = await Promise.all([
        boundAuthoritySource === null
          ? null
          : boundAuthoritySource.readStatus(),
        boundConfirmationAuthoritySource === null
          ? null
          : boundConfirmationAuthoritySource.readStatus(),
      ]);
      const local = journal.getAuthorityState();
      const localProjection = journal.getAuthorityProjectionState();
      const graph = status?.graph;
      if (
        (boundAuthoritySource !== null &&
          (
            !Number.isSafeInteger(status?.ledgerRevision) ||
            status.ledgerRevision !== local.workLedgerRevision ||
            !Number.isSafeInteger(graph?.cursor) ||
            graph.cursor !== graph.highWatermark ||
            local.cursor !== graph.cursor ||
            local.checkpointDigest !== graph.checkpointDigest ||
            graph.checkpointDigest !== graph.highWatermarkDigest ||
            local.authorityStateDigest !== graph.authorityStateDigest ||
            localProjection.workLedgerRevision !== status.ledgerRevision ||
            localProjection.authorityStateDigest !== graph.authorityStateDigest
          )) ||
        (boundConfirmationAuthoritySource !== null &&
          (
            !Number.isSafeInteger(confirmationStatus?.highWatermark) ||
            confirmationStatus.highWatermark !==
              localProjection.confirmationHighWatermark
          ))
      ) {
        throw authorityNotCurrent();
      }
      return { status, confirmationStatus, local, localProjection };
    };
    return Object.freeze({
      producer: frozenPort(journal, ["append", "appendBatch"]),
      lifecycleProducer: frozenPort(journal, [
        "appendWorkItems",
        "appendGraphEvents",
        "appendProjectionRecords",
        "appendAuthorityProjection",
        "adoptGraphCheckpoint",
      ]),
      search: Object.freeze({
        search: async (value) => {
          await assertAuthorityCurrent();
          return journal.search(value);
        },
        getHealth: async () => {
          const authority = await assertAuthorityCurrent();
          return Object.freeze({
            ...journal.getHealth(),
            authorityCurrent: true,
            ...(authority === null
              ? {}
              : {
                  workLedgerRevision: authority.local.workLedgerRevision,
                  graphMemoryCursor: authority.local.cursor,
                  ...(authority.confirmationStatus === null
                    ? {}
                    : {
                        confirmationMemoryHighWatermark:
                          authority.localProjection
                            .confirmationHighWatermark,
                      }),
                }),
          });
        },
      }),
      contextReader: Object.freeze({
        readRecords: async (value) => {
          await assertAuthorityCurrent();
          return journal.readRecords(value);
        },
      }),
      authorityReader: frozenPort(journal, [
        "getAuthorityState",
        "getAuthorityProjectionState",
        "requiresAuthorityProjectionCheckpoint",
      ]),
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
