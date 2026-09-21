import { parentPort } from "node:worker_threads";
import {
  prepareWorkLedgerCandidate,
  serializeWorkLedgerCandidateError,
} from "./work-ledger-candidate-validation.js";

if (parentPort === null) {
  throw new Error("work ledger candidate worker requires a parent port");
}

let committedState = null;
let prepared = null;

function protocolError(message) {
  return Object.assign(new Error(message), {
    code: "WORK_LEDGER_STATE_CORRUPTED",
    statusCode: 503,
  });
}

function prepare(message) {
  if (Object.hasOwn(message, "previousState")) {
    committedState = message.previousState;
    prepared = null;
  }
  if (committedState === null) {
    throw protocolError("candidate worker has no committed state");
  }
  const normalized = prepareWorkLedgerCandidate({
    previousState: committedState,
    candidate: message.candidate,
    limits: message.limits,
    appendGraphMemory: message.appendGraphMemory,
  });
  prepared = { preparedId: message.requestId, state: normalized };
  return { normalized };
}

function commit(message) {
  if (prepared?.preparedId !== message.preparedId) {
    throw protocolError("candidate worker commit does not match prepared state");
  }
  committedState = prepared.state;
  prepared = null;
  return {};
}

function discard(message) {
  if (prepared?.preparedId !== message.preparedId) {
    throw protocolError("candidate worker discard does not match prepared state");
  }
  prepared = null;
  return {};
}

function handle(message) {
  switch (message?.type) {
    case "prepare":
      return prepare(message);
    case "commit":
      return commit(message);
    case "discard":
      return discard(message);
    default:
      throw protocolError("candidate worker request is invalid");
  }
}

parentPort.on("message", (message) => {
  try {
    const result = handle(message);
    parentPort.postMessage({ requestId: message.requestId, ok: true, ...result });
  } catch (error) {
    parentPort.postMessage({
      requestId: message?.requestId,
      ok: false,
      error: serializeWorkLedgerCandidateError(error),
    });
  }
});
