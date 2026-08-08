import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createApplication,
  createApplicationRuntimeLifecycle,
} from "./composition-root.js";
import { createApplicationWriterLease } from "./lib/application-writer-lease.js";
import { projectRoot as defaultProjectRoot } from "./lib/config.js";

const retainedLifecycleOwners = new Set();
const DEFAULT_CLEANUP_MAX_ATTEMPTS = 3;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
const MAX_CLEANUP_ATTEMPTS = 10;
const MAX_CLEANUP_TIMEOUT_MS = 120_000;

function normalizeCleanupPolicy(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("cleanupPolicy must be a record");
  }
  const maxAttempts = value.maxAttempts ?? DEFAULT_CLEANUP_MAX_ATTEMPTS;
  const timeoutMs = value.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_CLEANUP_ATTEMPTS
  ) {
    throw new TypeError("cleanupPolicy.maxAttempts must be an integer from 1 to 10");
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_CLEANUP_TIMEOUT_MS
  ) {
    throw new TypeError("cleanupPolicy.timeoutMs must be an integer from 1 to 120000");
  }
  return Object.freeze({ maxAttempts, timeoutMs });
}

function cleanupTimeoutError(timeoutMs) {
  const error = new Error(`CLI cleanup exceeded ${timeoutMs}ms`);
  error.code = "CLI_CLEANUP_TIMEOUT";
  return error;
}

function beforeCleanupDeadline(startOperation, deadline, timeoutMs) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(cleanupTimeoutError(timeoutMs));
  let operation;
  try {
    operation = Promise.resolve(startOperation());
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(cleanupTimeoutError(timeoutMs)),
      remaining,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function lifecycleCleanupError({
  code,
  operationError,
  cleanupErrors,
  lifecycle,
}) {
  const cleanupError = cleanupErrors[0] || null;
  const error = new AggregateError(
    [operationError, ...cleanupErrors].filter(Boolean),
    code === "CLI_CLEANUP_INCOMPLETE"
      ? "CLI operation ended before application cleanup completed"
      : "CLI application cleanup recovered after one or more failures",
  );
  error.name = code === "CLI_CLEANUP_INCOMPLETE"
    ? "CliCleanupIncompleteError"
    : "CliCleanupError";
  error.code = code;
  error.operationError = operationError;
  error.cleanupError = cleanupError;
  error.cleanupErrors = Object.freeze([...cleanupErrors]);
  error.lifecycle = lifecycle;
  return error;
}

function createCliLifecycleOwner({
  runtimeLifecycle,
  writerLease,
  cleanupPolicy,
}) {
  let writerLeaseAcquired = false;
  let writerLeaseReleased = false;
  let application = null;
  let applicationCleanupComplete = false;
  let activeCleanup = null;
  let activeWriterLeaseRelease = null;
  let recovery = null;
  let operationError = null;
  let observedRuntimeFailures = 0;
  let publishedCleanupErrors = 0;
  const cleanupErrors = [];
  let lifecycle;

  function cleanupComplete() {
    return application === null
      ? runtimeLifecycle.readStatus().complete
      : applicationCleanupComplete;
  }

  function recordCleanupError(error) {
    if (cleanupErrors[cleanupErrors.length - 1] !== error) {
      cleanupErrors.push(error);
    }
  }

  function consumeRuntimeFailures() {
    const failures = runtimeLifecycle.readStatus().failures;
    if (!Array.isArray(failures)) return [];
    const newFailures = failures.slice(observedRuntimeFailures);
    observedRuntimeFailures = failures.length;
    cleanupErrors.push(...newFailures);
    return failures;
  }

  function hasUnpublishedCleanupErrors() {
    return publishedCleanupErrors < cleanupErrors.length;
  }

  function publishCleanupErrors() {
    const unpublished = Object.freeze(
      cleanupErrors.slice(publishedCleanupErrors),
    );
    publishedCleanupErrors = cleanupErrors.length;
    return unpublished;
  }

  function beginCleanup() {
    if (cleanupComplete()) return Promise.resolve();
    if (activeCleanup) return activeCleanup;
    const attempt = Promise.resolve().then(() =>
      application === null
        ? runtimeLifecycle.close()
        : application.close(),
    );
    activeCleanup = attempt;
    void attempt.then(
      () => {
        consumeRuntimeFailures();
        if (application !== null) applicationCleanupComplete = true;
        if (activeCleanup === attempt) activeCleanup = null;
      },
      (error) => {
        const runtimeFailures = consumeRuntimeFailures();
        if (!runtimeFailures.includes(error)) recordCleanupError(error);
        if (activeCleanup === attempt) activeCleanup = null;
      },
    );
    return attempt;
  }

  async function runBoundedOperation({ isComplete, startOperation, deadline }) {
    for (
      let attempt = 0;
      attempt < cleanupPolicy.maxAttempts && !isComplete();
      attempt += 1
    ) {
      try {
        await beforeCleanupDeadline(
          startOperation,
          deadline,
          cleanupPolicy.timeoutMs,
        );
      } catch (error) {
        if (error.code === "CLI_CLEANUP_TIMEOUT") {
          recordCleanupError(error);
          break;
        }
      }
    }
  }

  function beginWriterLeaseRelease() {
    if (!writerLeaseAcquired || writerLeaseReleased) return Promise.resolve();
    if (activeWriterLeaseRelease) return activeWriterLeaseRelease;
    const attempt = Promise.resolve().then(() => writerLease.close());
    activeWriterLeaseRelease = attempt;
    void attempt.then(
      () => {
        writerLeaseReleased = true;
        retainedLifecycleOwners.delete(lifecycle);
        if (activeWriterLeaseRelease === attempt) {
          activeWriterLeaseRelease = null;
        }
      },
      (error) => {
        cleanupErrors.push(error);
        if (activeWriterLeaseRelease === attempt) {
          activeWriterLeaseRelease = null;
        }
      },
    );
    return attempt;
  }

  async function completeCleanup() {
    const deadline = Date.now() + cleanupPolicy.timeoutMs;
    consumeRuntimeFailures();
    await runBoundedOperation({
      isComplete: cleanupComplete,
      startOperation: beginCleanup,
      deadline,
    });
    consumeRuntimeFailures();
    if (cleanupComplete()) {
      await runBoundedOperation({
        isComplete: () => writerLeaseReleased,
        startOperation: beginWriterLeaseRelease,
        deadline,
      });
    }
    return lifecycle.readStatus();
  }

  const recover = () => {
    if (recovery) return recovery;
    const attempt = (async () => {
      const status = await completeCleanup();
      if (status.cleanup !== "complete" || status.writerLease !== "released") {
        retainedLifecycleOwners.add(lifecycle);
        throw lifecycleCleanupError({
          code: "CLI_CLEANUP_INCOMPLETE",
          operationError,
          cleanupErrors: publishCleanupErrors(),
          lifecycle,
        });
      }
      if (hasUnpublishedCleanupErrors()) {
        throw lifecycleCleanupError({
          code: "CLI_CLEANUP_FAILED",
          operationError,
          cleanupErrors: publishCleanupErrors(),
          lifecycle,
        });
      }
    })();
    recovery = attempt;
    void attempt.then(
      () => {},
      () => {
        if (recovery === attempt) recovery = null;
      },
    );
    return attempt;
  };

  lifecycle = Object.freeze({
    recover,
    readStatus() {
      return Object.freeze({
        cleanup: cleanupComplete() ? "complete" : "incomplete",
        writerLease: writerLeaseReleased ? "released" : "held",
      });
    },
  });

  return Object.freeze({
    async acquireWriterLease() {
      await writerLease.acquire();
      writerLeaseAcquired = true;
    },
    bindApplication(value) {
      application = value;
    },
    bindOperationError(error) {
      operationError = error;
    },
    completeCleanup,
    hasUnpublishedCleanupErrors,
    isWriterLeaseAcquired() {
      return writerLeaseAcquired;
    },
    lifecycle,
    publishCleanupErrors,
    retain() {
      retainedLifecycleOwners.add(lifecycle);
    },
  });
}

export async function runCli({
  arguments: arguments_ = process.argv.slice(2),
  projectRoot = defaultProjectRoot,
  createApplicationFn = createApplication,
  writerLeaseFactory = createApplicationWriterLease,
  cleanupPolicy: suppliedCleanupPolicy = {},
  write = console.log,
  writeError = console.error,
} = {}) {
  const [command, ...flags] = arguments_;
  if (command !== "refresh") {
    writeError("Usage: node src/cli.js refresh [--notify]");
    return { exitCode: 2 };
  }
  const cleanupPolicy = normalizeCleanupPolicy(suppliedCleanupPolicy);
  const writerLease = writerLeaseFactory({ projectRoot });
  const runtimeLifecycle = createApplicationRuntimeLifecycle();
  const lifecycleOwner = createCliLifecycleOwner({
    runtimeLifecycle,
    writerLease,
    cleanupPolicy,
  });
  let result = null;
  let operationError = null;
  try {
    await lifecycleOwner.acquireWriterLease();
    const application = await createApplicationFn({
      externalActions: false,
      runtimeLifecycle,
    });
    lifecycleOwner.bindApplication(application);
    const refreshResult = await application.refreshService.refresh({
      notify: flags.includes("--notify"),
    });
    const routing = application.workflowRouting
      ? await application.workflowRouting.ingestSnapshot({
          snapshot: await application.store.read("snapshot"),
        })
      : null;
    write(
      JSON.stringify(
        {
          refreshedAt: refreshResult.dashboard.meta.refreshedAt,
          counts: refreshResult.dashboard.counts,
          errors: refreshResult.dashboard.meta.errors,
          notification: refreshResult.notification,
          routing: routing
            ? {
                events: routing.events.length,
                assignments: routing.assignments.length,
              }
            : null,
        },
        null,
        2,
      ),
    );
    result = { exitCode: refreshResult.dashboard.meta.errors.length ? 1 : 0 };
  } catch (error) {
    operationError = error;
    lifecycleOwner.bindOperationError(error);
  }

  if (!lifecycleOwner.isWriterLeaseAcquired()) throw operationError;
  const cleanupStatus = await lifecycleOwner.completeCleanup();
  if (
    cleanupStatus.cleanup !== "complete" ||
    cleanupStatus.writerLease !== "released"
  ) {
    lifecycleOwner.retain();
    throw lifecycleCleanupError({
      code: "CLI_CLEANUP_INCOMPLETE",
      operationError,
      cleanupErrors: lifecycleOwner.publishCleanupErrors(),
      lifecycle: lifecycleOwner.lifecycle,
    });
  }
  if (lifecycleOwner.hasUnpublishedCleanupErrors()) {
    throw lifecycleCleanupError({
      code: "CLI_CLEANUP_FAILED",
      operationError,
      cleanupErrors: lifecycleOwner.publishCleanupErrors(),
      lifecycle: lifecycleOwner.lifecycle,
    });
  }
  if (operationError) throw operationError;
  return result;
}

export async function runCliProcess({
  runCliFn = runCli,
  writeError = (error) => console.error(error.stack || error.message),
  setExitCode = (exitCode) => {
    process.exitCode = exitCode;
  },
  terminate = (exitCode) => process.exit(exitCode),
} = {}) {
  try {
    const { exitCode } = await runCliFn();
    setExitCode(exitCode);
  } catch (error) {
    writeError(error);
    if (error?.code === "CLI_CLEANUP_INCOMPLETE") {
      terminate(1);
      return;
    }
    setExitCode(1);
  }
}

const invokedModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";

if (import.meta.url === invokedModule) {
  void runCliProcess();
}
