import { OperationQueue } from "./operation-queue.js";

const contexts = new WeakMap();
const CALLBACKS = new Map([
  ["perform_action", "performAction"],
  ["read_source", "readSource"],
  ["get_state", "getState"],
]);

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function stateFor(context) {
  const state = context && typeof context === "object" ? contexts.get(context) : null;
  if (!state) throw failure("CODE_EXECUTION_CONTEXT_INVALID");
  return state;
}

// A serialized model input cannot recreate this authority. Callbacks retain
// job ownership, workspace revision, audit and executor validation on the host.
export function createCodeExecutionContext({ performAction, readSource, getState, close } = {}) {
  if ([performAction, readSource, getState].some((callback) => typeof callback !== "function") ||
      (close !== undefined && typeof close !== "function")) {
    throw failure("CODE_EXECUTION_CONTEXT_INVALID");
  }
  const context = Object.freeze({});
  contexts.set(context, {
    callbacks: { performAction, readSource, getState, close },
    controller: new AbortController(), started: false, revoked: false,
    queue: new OperationQueue(), closing: null, removeParentAbort: null,
  });
  return context;
}

export function isCodeExecutionContext(value) {
  return value !== null && typeof value === "object" && contexts.has(value);
}

function assertActive(state) {
  if (state.revoked) throw failure("CODE_EXECUTION_SESSION_REVOKED");
}

export function revokeCodeExecutionContext(context, { abortActive = false } = {}) {
  const state = stateFor(context);
  state.revoked = true;
  if (abortActive && !state.controller.signal.aborted) {
    state.controller.abort(failure("CODE_EXECUTION_SESSION_REVOKED"));
  }
}

// Revocation denies admission before draining. A pause does not interrupt a
// write already admitted by the host; cancellation can explicitly abort it.
export function closeCodeExecutionContext(context) {
  const state = stateFor(context);
  revokeCodeExecutionContext(context);
  return state.closing ??= (async () => {
    try {
      await state.queue.tail;
      return await state.callbacks.close?.();
    } finally {
      state.removeParentAbort?.();
    }
  })();
}

export function beginCodeExecutionSession(context, { signal = null } = {}) {
  const state = stateFor(context);
  assertActive(state);
  if (state.started) throw failure("CODE_EXECUTION_SESSION_ALREADY_STARTED");
  state.started = true;
  const onAbort = () => revokeCodeExecutionContext(context, { abortActive: true });
  signal?.addEventListener("abort", onAbort, { once: true });
  state.removeParentAbort = () => signal?.removeEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();
  return Object.freeze({
    assertActive: () => assertActive(state),
    invoke(name, args) {
      try {
        assertActive(state);
        const callback = CALLBACKS.get(name);
        if (!callback) throw failure("CODE_EXECUTION_TOOL_NOT_ALLOWED");
        return state.queue.enqueue(async () => {
          assertActive(state);
          return await state.callbacks[callback](args, { signal: state.controller.signal });
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
    revoke: (options) => revokeCodeExecutionContext(context, options),
    close: () => closeCodeExecutionContext(context),
  });
}
