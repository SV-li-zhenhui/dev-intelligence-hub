import path from "node:path";
import { codeJobError } from "./domain/code-job-contract.js";
import { projectRoot } from "./lib/config.js";
import { OperationQueue } from "./lib/operation-queue.js";
import { ProcessExclusiveGuard } from "./lib/process-exclusive-guard.js";
import { StateStore } from "./lib/state-store.js";
import { CodeJobApprovalExecutor } from "./services/code-job-approval-executor.js";
import { CodeJobStore } from "./services/code-job-store.js";

const GUARD_NAME = "mydashboard-code-job-v1";

function runtimeClosedError() {
  return codeJobError(
    "CODE_JOB_RUNTIME_CLOSED",
    "代码任务运行时已关闭",
    503,
  );
}

function validateGuard(value) {
  if (
    !value ||
    typeof value.acquire !== "function" ||
    typeof value.run !== "function" ||
    typeof value.close !== "function"
  ) {
    throw new TypeError("code job guard is invalid");
  }
  return value;
}

function validateStore(value) {
  if (
    !value ||
    typeof value.read !== "function" ||
    typeof value.write !== "function"
  ) {
    throw new TypeError("code job durable store is invalid");
  }
  return value;
}

function runtimeDataDirectory(value) {
  if (value === undefined) return path.join(projectRoot, "data");
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new TypeError("code job dataDirectory must be an absolute path");
  }
  return path.resolve(value);
}

function frozenPort(methods) {
  return Object.freeze(methods);
}

function operationAdmission() {
  let accepting = true;
  const active = new Set();
  return Object.freeze({
    run(operation) {
      if (!accepting) return Promise.reject(runtimeClosedError());
      let result;
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
      active.add(result);
      result.then(
        () => active.delete(result),
        () => active.delete(result),
      );
      return result;
    },
    stop() {
      accepting = false;
      return [...active];
    },
  });
}

export async function createCodeJobRuntime({
  store,
  grantVerifier,
  dataDirectory,
  operationQueue = new OperationQueue(),
  clock,
  limits,
  createGuard = (options) => new ProcessExclusiveGuard(options),
} = {}) {
  if (typeof createGuard !== "function") {
    throw new TypeError("createGuard must be a function");
  }
  const durableStore = validateStore(
    store === undefined
      ? new StateStore(runtimeDataDirectory(dataDirectory))
      : store,
  );
  const guard = validateGuard(createGuard({ name: GUARD_NAME }));
  const admission = operationAdmission();
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    const accepted = admission.stop();
    closePromise = Promise.allSettled(accepted).then(() => guard.close());
    return closePromise;
  };

  try {
    await guard.acquire();
    const jobs = new CodeJobStore({
      store: durableStore,
      exclusiveLease: guard,
      operationQueue,
      ...(clock ? { clock } : {}),
      ...(limits ? { limits } : {}),
    });
    await jobs.recover();
    const approvalExecutor = new CodeJobApprovalExecutor({
      codeJobStore: jobs,
      grantVerifier,
    });
    return Object.freeze({
      confirmationExecutor: frozenPort({
        execute: (value) => admission.run(() => approvalExecutor.execute(value)),
        reconcile: (value) =>
          admission.run(() => approvalExecutor.reconcile(value)),
      }),
      reader: frozenPort({
        get: (value) => admission.run(() => jobs.get(value)),
        list: (value) => admission.run(() => jobs.list(value)),
        listNewest: (value) => admission.run(() => jobs.listNewest(value)),
      }),
      close,
    });
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure after releasing the independent guard.
    }
    throw error;
  }
}
