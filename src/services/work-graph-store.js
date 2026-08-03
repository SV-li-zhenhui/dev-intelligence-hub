import {
  boundedLedgerString,
  canonicalLedgerValue,
  hasExactLedgerKeys,
} from "./work-ledger-values.js";

function bindDataMethod(value, methodName, portName) {
  if (value === null || !["object", "function"].includes(typeof value)) {
    throw new TypeError(`${portName} is invalid`);
  }
  let owner = value;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new TypeError(`${portName} is invalid`);
      }
      return descriptor.value.bind(value);
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new TypeError(`${portName} is invalid`);
}

function normalizePlannerAuthority(value) {
  if (!hasExactLedgerKeys(value, ["principalId", "scopeRootTaskId"])) {
    throw new TypeError("work graph planner authority is invalid");
  }
  let actorId;
  let scopeRootTaskId;
  try {
    actorId = boundedLedgerString(value.principalId, "principalId", 128);
    scopeRootTaskId = value.scopeRootTaskId === null
      ? null
      : boundedLedgerString(value.scopeRootTaskId, "scopeRootTaskId", 192);
  } catch {
    throw new TypeError("work graph planner authority is invalid");
  }
  return Object.freeze({ actorId, scopeRootTaskId });
}

function snapshotCommand(value) {
  return canonicalLedgerValue(value, {
    maximumEntries: 20_000,
    maximumStringBytes: 16 * 1024,
    errorCode: "WORK_LEDGER_GRAPH_COMMAND_INVALID",
  });
}

export class WorkGraphStore {
  #getSnapshot;
  #createChild;

  constructor(value = {}) {
    if (!hasExactLedgerKeys(value, ["ledger"])) {
      throw new TypeError("WorkGraphStore options are invalid");
    }
    this.#getSnapshot = bindDataMethod(
      value.ledger,
      "getGraphSnapshot",
      "work graph reader port",
    );
    this.#createChild = bindDataMethod(
      value.ledger,
      "createGraphChild",
      "work graph planner port",
    );
    Object.freeze(this);
  }

  reader() {
    return Object.freeze({
      getSnapshot: () => this.#getSnapshot(),
    });
  }

  planner(authority) {
    const trustedAuthority = normalizePlannerAuthority(authority);
    return Object.freeze({
      createChild: (command) => {
        let snapshot;
        try {
          snapshot = snapshotCommand(command);
        } catch (error) {
          return Promise.reject(error);
        }
        return this.#createChild({
          authority: trustedAuthority,
          command: snapshot,
        });
      },
    });
  }
}
