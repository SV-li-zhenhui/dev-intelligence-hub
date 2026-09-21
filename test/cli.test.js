import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createApplication } from "../src/composition-root.js";
import { runCli, runCliProcess } from "../src/cli.js";
import {
  createApplicationWriterLease,
} from "../src/lib/application-writer-lease.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

function minimalApplicationConfig() {
  return {
    refreshMinutes: 10,
    trackedRepositories: [],
    prResponsibility: {},
    brain: { enabled: false },
    employees: { prReviewer: { enabled: false } },
    dingtalk: { enabled: false },
    githubActions: { enabled: false },
    codeExecutor: { enabled: false },
  };
}

function memoryStore() {
  return {
    async read(_key, fallback = null) {
      return fallback;
    },
    async write() {},
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function temporaryProjectRoot(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "mydashboard-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI module executes when launched directly", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(projectRoot, "src", "cli.js"), "not-a-command"],
    { cwd: projectRoot, encoding: "utf8", windowsHide: true },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node src\/cli\.js refresh/u);
});

test("direct CLI entry terminates on incomplete cleanup without releasing ownership", async () => {
  const events = [];
  const cleanupFailure = new Error("cleanup remained incomplete");
  cleanupFailure.code = "CLI_CLEANUP_INCOMPLETE";
  cleanupFailure.lifecycle = {
    async recover() {
      events.push("unsafe-recovery");
    },
  };

  await runCliProcess({
    async runCliFn() {
      events.push("run-cli");
      throw cleanupFailure;
    },
    writeError(error) {
      events.push(`error:${error.message}`);
    },
    setExitCode(exitCode) {
      events.push(`exit-code:${exitCode}`);
    },
    terminate(exitCode) {
      events.push(`terminate:${exitCode}`);
    },
  });

  assert.deepEqual(events, [
    "run-cli",
    "error:cleanup remained incomplete",
    "terminate:1",
  ]);
});

test("direct CLI terminal policy exits while a real writer lease remains held", async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const cliModuleUrl = new URL("../src/cli.js", import.meta.url).href;
  const writerLeaseModuleUrl = new URL(
    "../src/lib/application-writer-lease.js",
    import.meta.url,
  ).href;
  const childScript = `
    import { runCliProcess } from ${JSON.stringify(cliModuleUrl)};
    import { createApplicationWriterLease } from ${JSON.stringify(writerLeaseModuleUrl)};
    const writerLease = createApplicationWriterLease({ projectRoot: process.argv[1] });
    await writerLease.acquire();
    process.stdout.write("lease-held\\n");
    const failure = Object.assign(new Error("cleanup remained incomplete"), {
      code: "CLI_CLEANUP_INCOMPLETE",
    });
    await runCliProcess({
      runCliFn: async () => { throw failure; },
      writeError() {},
    });
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childScript, isolatedProjectRoot],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "lease-held\n");
  assert.equal(result.stderr, "");
});

function applicationFor(events) {
  return {
    refreshService: {
      async refresh() {
        events.push("refresh");
        return {
          dashboard: {
            meta: { refreshedAt: "2026-08-08T01:02:03.004Z", errors: [] },
            counts: { pullRequests: 1 },
          },
          notification: null,
        };
      },
    },
    store: {
      async read(name) {
        assert.equal(name, "snapshot");
        return { schemaVersion: 1 };
      },
    },
    workflowRouting: {
      async ingestSnapshot({ snapshot }) {
        assert.deepEqual(snapshot, { schemaVersion: 1 });
        events.push("workflow-routing");
        return { events: [], assignments: [] };
      },
    },
    async close() {
      events.push("application-close");
    },
  };
}

function observedWriterLease(options, events) {
  const lease = createApplicationWriterLease(options);
  return {
    async acquire() {
      events.push("lease-acquire");
      await lease.acquire();
    },
    async close() {
      events.push("lease-release");
      await lease.close();
    },
  };
}

function recordingWriterLease(events) {
  return {
    async acquire() {
      events.push("lease-acquire");
    },
    async close() {
      events.push("lease-release");
    },
  };
}

test("refresh CLI excludes a held project writer before constructing the application", async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const holder = createApplicationWriterLease({ projectRoot: isolatedProjectRoot });
  const events = [];
  t.after(() => holder.close());
  await holder.acquire();

  await assert.rejects(
    runCli({
      arguments: ["refresh"],
      projectRoot: isolatedProjectRoot,
      createApplicationFn: async () => {
        events.push("application-create");
        return applicationFor(events);
      },
    }),
    { code: "PROCESS_GUARD_HELD" },
  );
  assert.deepEqual(events, []);
});

test("application writer lease preserves a manager-supplied project digest", async (t) => {
  const projectDigest = "a".repeat(64);
  const lease = createApplicationWriterLease({ projectRoot, projectDigest });
  t.after(() => lease.close());

  assert.equal(lease.name, `mydashboard-data-writer-${projectDigest}`);
});

test("refresh CLI holds its project writer through application shutdown", async () => {
  const isolatedProjectRoot = await mkdtemp(path.join(tmpdir(), "mydashboard-cli-"));
  const events = [];
  try {
    const result = await runCli({
      arguments: ["refresh"],
      projectRoot: isolatedProjectRoot,
      createApplicationFn: async () => {
        events.push("application-create");
        return applicationFor(events);
      },
      writerLeaseFactory(options) {
        return observedWriterLease(options, events);
      },
      write() {},
    });

    assert.deepEqual(result, { exitCode: 0 });
    assert.deepEqual(events, [
      "lease-acquire",
      "application-create",
      "refresh",
      "workflow-routing",
      "application-close",
      "lease-release",
    ]);
  } finally {
    await rm(isolatedProjectRoot, { recursive: true, force: true });
  }
});

test(
  "pending construction cleanup reaches the CLI deadline with its lease held",
  { timeout: 2_000 },
  async (t) => {
    const isolatedProjectRoot = await temporaryProjectRoot(t);
    const events = [];
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const startupFailure = new Error("workflow startup failed");
    const running = runCli({
      arguments: ["refresh"],
      projectRoot: isolatedProjectRoot,
      createApplicationFn: ({ runtimeLifecycle }) => createApplication({
        config: minimalApplicationConfig(),
        store: memoryStore(),
        externalActions: false,
        runtimeLifecycle,
        codeExecutorRuntimeFactory: async () => ({
          async close() {
            events.push("runtime-close");
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          },
        }),
        workflowRoutingRuntimeFactory: async () => {
          throw startupFailure;
        },
      }),
      writerLeaseFactory(options) {
        return observedWriterLease(options, events);
      },
      cleanupPolicy: { maxAttempts: 2, timeoutMs: 20 },
      write() {},
    }).then(
      () => null,
      (error) => error,
    );
    await cleanupStarted.promise;

    const stillPending = Symbol("still pending");
    const beforeRelease = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve(stillPending), 250)),
    ]);
    try {
      assert.notStrictEqual(
        beforeRelease,
        stillPending,
        "runCli remained trapped inside composition cleanup",
      );
      assert.equal(beforeRelease.code, "CLI_CLEANUP_INCOMPLETE");
      assert.strictEqual(beforeRelease.operationError, startupFailure);
      assert.deepEqual(beforeRelease.lifecycle.readStatus(), {
        cleanup: "incomplete",
        writerLease: "held",
      });
      assert.deepEqual(events, ["lease-acquire", "runtime-close"]);
    } finally {
      releaseCleanup.resolve();
      const settled = await running;
      if (settled?.lifecycle?.readStatus().writerLease === "held") {
        await settled.lifecycle.recover();
      }
    }

    assert.deepEqual(events, [
      "lease-acquire",
      "runtime-close",
      "lease-release",
    ]);
  },
);

test(
  "late construction cleanup failure is published once after safe recovery",
  { timeout: 2_000 },
  async (t) => {
    const isolatedProjectRoot = await temporaryProjectRoot(t);
    const events = [];
    const firstClose = deferred();
    const startupFailure = new Error("workflow startup failed");
    const lateCleanupFailure = new Error("executor cleanup failed late");
    let closeAttempts = 0;

    const failure = await runCli({
      arguments: ["refresh"],
      projectRoot: isolatedProjectRoot,
      createApplicationFn: ({ runtimeLifecycle }) => createApplication({
        config: minimalApplicationConfig(),
        store: memoryStore(),
        externalActions: false,
        runtimeLifecycle,
        codeExecutorRuntimeFactory: async () => ({
          async close() {
            closeAttempts += 1;
            events.push(`runtime-close-${closeAttempts}`);
            if (closeAttempts === 1) await firstClose.promise;
          },
        }),
        workflowRoutingRuntimeFactory: async () => {
          throw startupFailure;
        },
      }),
      writerLeaseFactory() {
        return recordingWriterLease(events);
      },
      cleanupPolicy: { maxAttempts: 2, timeoutMs: 20 },
      write() {},
    }).then(
      () => null,
      (error) => error,
    );

    assert.equal(failure.code, "CLI_CLEANUP_INCOMPLETE");
    assert.strictEqual(failure.operationError, startupFailure);
    assert.equal(failure.cleanupErrors.length, 1);
    assert.equal(failure.cleanupErrors[0].code, "CLI_CLEANUP_TIMEOUT");
    assert.deepEqual(failure.lifecycle.readStatus(), {
      cleanup: "incomplete",
      writerLease: "held",
    });
    assert.deepEqual(events, ["lease-acquire", "runtime-close-1"]);

    firstClose.reject(lateCleanupFailure);
    const recoveryFailure = await failure.lifecycle.recover().then(
      () => null,
      (error) => error,
    );

    assert.notStrictEqual(
      recoveryFailure,
      null,
      "recovery resolved without publishing the late cleanup failure",
    );
    assert.equal(recoveryFailure.code, "CLI_CLEANUP_FAILED");
    assert.strictEqual(recoveryFailure.operationError, startupFailure);
    assert.strictEqual(recoveryFailure.cleanupError, lateCleanupFailure);
    assert.deepEqual(recoveryFailure.cleanupErrors, [lateCleanupFailure]);
    assert.deepEqual(recoveryFailure.errors, [
      startupFailure,
      lateCleanupFailure,
    ]);
    assert.equal(failure.cleanupErrors.length, 1);
    assert.equal(failure.cleanupErrors[0].code, "CLI_CLEANUP_TIMEOUT");
    assert.deepEqual(events, [
      "lease-acquire",
      "runtime-close-1",
      "runtime-close-2",
      "lease-release",
    ]);
    assert.deepEqual(failure.lifecycle.readStatus(), {
      cleanup: "complete",
      writerLease: "released",
    });

    await failure.lifecycle.recover();
    assert.deepEqual(events, [
      "lease-acquire",
      "runtime-close-1",
      "runtime-close-2",
      "lease-release",
    ]);
  },
);

test("construction cleanup failure retains recoverable writer ownership until runtimes close", async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const events = [];
  const startupFailure = new Error("workflow startup failed");
  const cleanupFailure = new Error("executor cleanup failed");
  let cleanupAttempts = 0;
  let cleanupCanComplete = false;

  const failure = await runCli({
    arguments: ["refresh"],
    projectRoot: isolatedProjectRoot,
    createApplicationFn: ({ runtimeLifecycle }) => createApplication({
      config: minimalApplicationConfig(),
      store: memoryStore(),
      externalActions: false,
      runtimeLifecycle,
      codeExecutorRuntimeFactory: async () => ({
        async close() {
          cleanupAttempts += 1;
          events.push(`runtime-close-${cleanupAttempts}`);
          if (!cleanupCanComplete) throw cleanupFailure;
        },
      }),
      workflowRoutingRuntimeFactory: async () => {
        throw startupFailure;
      },
    }),
    writerLeaseFactory(options) {
      return observedWriterLease(options, events);
    },
    cleanupPolicy: { maxAttempts: 1, timeoutMs: 200 },
    write() {},
  }).then(
    () => null,
    (error) => error,
  );

  try {
    assert.deepEqual(events, [
      "lease-acquire",
      "runtime-close-1",
    ]);
    assert.equal(failure.code, "CLI_CLEANUP_INCOMPLETE");
    assert.strictEqual(failure.operationError, startupFailure);
    assert.strictEqual(failure.cleanupError, cleanupFailure);
    assert.deepEqual(failure.lifecycle.readStatus(), {
      cleanup: "incomplete",
      writerLease: "held",
    });

    cleanupCanComplete = true;
    await failure.lifecycle.recover();
    assert.deepEqual(events, [
      "lease-acquire",
      "runtime-close-1",
      "runtime-close-2",
      "lease-release",
    ]);
    assert.deepEqual(failure.lifecycle.readStatus(), {
      cleanup: "complete",
      writerLease: "released",
    });
  } finally {
    cleanupCanComplete = true;
    if (failure?.lifecycle?.readStatus().writerLease === "held") {
      await failure.lifecycle.recover().catch(() => {});
    }
  }
});

test("recovered construction cleanup reports every runtime failure once", async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const events = [];
  const startupFailure = new Error("operations startup failed");
  const workflowCleanupFailure = new Error("workflow cleanup failed once");
  const executorCleanupFailure = new Error("executor cleanup failed once");
  let workflowCloseAttempts = 0;
  let executorCloseAttempts = 0;

  const failure = await runCli({
    arguments: ["refresh"],
    projectRoot: isolatedProjectRoot,
    createApplicationFn: ({ runtimeLifecycle }) => createApplication({
      config: minimalApplicationConfig(),
      store: memoryStore(),
      externalActions: false,
      runtimeLifecycle,
      codeExecutorRuntimeFactory: async () => ({
        async close() {
          executorCloseAttempts += 1;
          events.push(`executor-close-${executorCloseAttempts}`);
          if (executorCloseAttempts === 1) throw executorCleanupFailure;
        },
      }),
      workflowRoutingRuntimeFactory: async () => ({
        async close() {
          workflowCloseAttempts += 1;
          events.push(`workflow-close-${workflowCloseAttempts}`);
          if (workflowCloseAttempts === 1) throw workflowCleanupFailure;
        },
      }),
      operationsRuntimeFactory() {
        throw startupFailure;
      },
    }),
    writerLeaseFactory() {
      return recordingWriterLease(events);
    },
    cleanupPolicy: { maxAttempts: 2, timeoutMs: 200 },
    write() {},
  }).then(
    () => null,
    (error) => error,
  );

  assert.equal(failure.code, "CLI_CLEANUP_FAILED");
  assert.strictEqual(failure.operationError, startupFailure);
  assert.strictEqual(failure.cleanupError, workflowCleanupFailure);
  assert.deepEqual(failure.cleanupErrors, [
    workflowCleanupFailure,
    executorCleanupFailure,
  ]);
  assert.deepEqual(failure.errors, [
    startupFailure,
    workflowCleanupFailure,
    executorCleanupFailure,
  ]);
  assert.deepEqual(events, [
    "lease-acquire",
    "workflow-close-1",
    "executor-close-1",
    "workflow-close-2",
    "executor-close-2",
    "lease-release",
  ]);
});

test("transient application close failure retries before lease release and remains reported", async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const events = [];
  const closeFailure = new Error("application close failed once");
  let closeAttempts = 0;

  const failure = await runCli({
    arguments: ["refresh"],
    projectRoot: isolatedProjectRoot,
    createApplicationFn: async () => {
      const application = applicationFor(events);
      application.close = async () => {
        closeAttempts += 1;
        events.push(`application-close-${closeAttempts}`);
        if (closeAttempts === 1) throw closeFailure;
      };
      return application;
    },
    writerLeaseFactory() {
      return recordingWriterLease(events);
    },
    cleanupPolicy: { maxAttempts: 2, timeoutMs: 200 },
    write() {},
  }).then(
    () => null,
    (error) => error,
  );

  assert.deepEqual(events, [
    "lease-acquire",
    "refresh",
    "workflow-routing",
    "application-close-1",
    "application-close-2",
    "lease-release",
  ]);
  assert.equal(failure.code, "CLI_CLEANUP_FAILED");
  assert.strictEqual(failure.cleanupError, closeFailure);
  assert.deepEqual(failure.lifecycle.readStatus(), {
    cleanup: "complete",
    writerLease: "released",
  });
});

test("bounded close rejection retains ownership and later recovery releases in order", async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const events = [];
  const closeFailure = new Error("application close remains unavailable");
  let closeAttempts = 0;
  let closeCanComplete = false;

  const failure = await runCli({
    arguments: ["refresh"],
    projectRoot: isolatedProjectRoot,
    createApplicationFn: async () => {
      const application = applicationFor(events);
      application.close = async () => {
        closeAttempts += 1;
        events.push(`application-close-${closeAttempts}`);
        if (!closeCanComplete) throw closeFailure;
      };
      return application;
    },
    writerLeaseFactory() {
      return recordingWriterLease(events);
    },
    cleanupPolicy: { maxAttempts: 2, timeoutMs: 200 },
    write() {},
  }).then(
    () => null,
    (error) => error,
  );

  assert.equal(failure.code, "CLI_CLEANUP_INCOMPLETE");
  assert.deepEqual(events, [
    "lease-acquire",
    "refresh",
    "workflow-routing",
    "application-close-1",
    "application-close-2",
  ]);
  assert.deepEqual(failure.lifecycle.readStatus(), {
    cleanup: "incomplete",
    writerLease: "held",
  });

  closeCanComplete = true;
  await failure.lifecycle.recover();
  assert.deepEqual(events, [
    "lease-acquire",
    "refresh",
    "workflow-routing",
    "application-close-1",
    "application-close-2",
    "application-close-3",
    "lease-release",
  ]);
});

test(
  "timed-out application close stays owned until the pending cleanup completes",
  { timeout: 1_000 },
  async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const events = [];
  const releaseClose = deferred();

  const failure = await runCli({
    arguments: ["refresh"],
    projectRoot: isolatedProjectRoot,
    createApplicationFn: async () => {
      const application = applicationFor(events);
      application.close = () => {
        events.push("application-close-pending");
        return releaseClose.promise;
      };
      return application;
    },
    writerLeaseFactory() {
      return recordingWriterLease(events);
    },
    cleanupPolicy: { maxAttempts: 2, timeoutMs: 20 },
    write() {},
  }).then(
    () => null,
    (error) => error,
  );

  assert.equal(failure.code, "CLI_CLEANUP_INCOMPLETE");
  assert.deepEqual(events, [
    "lease-acquire",
    "refresh",
    "workflow-routing",
    "application-close-pending",
  ]);
  assert.deepEqual(failure.lifecycle.readStatus(), {
    cleanup: "incomplete",
    writerLease: "held",
  });

  releaseClose.resolve();
  await failure.lifecycle.recover();
  assert.deepEqual(events, [
    "lease-acquire",
    "refresh",
    "workflow-routing",
    "application-close-pending",
    "lease-release",
  ]);
  },
);

test(
  "pending writer lease release is bounded, coalesced, terminal, and recoverable",
  { timeout: 2_000 },
  async () => {
    const events = [];
    const closeStarted = deferred();
    const releaseClose = deferred();
    let closeCalls = 0;
    let closeReleased = false;
    const running = runCli({
      arguments: ["refresh"],
      createApplicationFn: async () => applicationFor(events),
      writerLeaseFactory() {
        return {
          async acquire() {
            events.push("lease-acquire");
          },
          close() {
            closeCalls += 1;
            events.push(`lease-close-${closeCalls}`);
            closeStarted.resolve();
            return releaseClose.promise;
          },
        };
      },
      cleanupPolicy: { maxAttempts: 2, timeoutMs: 20 },
      write() {},
    }).then(
      (result) => result,
      (error) => error,
    );
    await closeStarted.promise;

    const stillPending = Symbol("still pending");
    const firstOutcome = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve(stillPending), 250)),
    ]);
    try {
      assert.notStrictEqual(
        firstOutcome,
        stillPending,
        "runCli remained blocked on writer lease close",
      );
      assert.equal(firstOutcome.code, "CLI_CLEANUP_INCOMPLETE");
      assert.deepEqual(firstOutcome.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "held",
      });
      assert.equal(closeCalls, 1);
      assert.deepEqual(events, [
        "lease-acquire",
        "refresh",
        "workflow-routing",
        "application-close",
        "lease-close-1",
      ]);

      const terminalEvents = [];
      await runCliProcess({
        async runCliFn() {
          throw firstOutcome;
        },
        writeError(error) {
          terminalEvents.push(`error:${error.code}`);
        },
        setExitCode(exitCode) {
          terminalEvents.push(`exit-code:${exitCode}`);
        },
        terminate(exitCode) {
          terminalEvents.push(`terminate:${exitCode}`);
        },
      });
      assert.deepEqual(terminalEvents, [
        "error:CLI_CLEANUP_INCOMPLETE",
        "terminate:1",
      ]);

      const pendingRecovery = await firstOutcome.lifecycle.recover().then(
        () => null,
        (error) => error,
      );
      assert.notStrictEqual(pendingRecovery, null);
      assert.equal(pendingRecovery.code, "CLI_CLEANUP_INCOMPLETE");
      assert.deepEqual(pendingRecovery.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "held",
      });
      assert.equal(closeCalls, 1);

      closeReleased = true;
      releaseClose.resolve();
      await firstOutcome.lifecycle.recover();
      assert.deepEqual(firstOutcome.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "released",
      });
      assert.equal(closeCalls, 1);
    } finally {
      if (!closeReleased) releaseClose.resolve();
      const settled = await running;
      if (settled?.lifecycle?.readStatus().writerLease === "held") {
        await settled.lifecycle.recover().catch(() => {});
        await settled.lifecycle.recover().catch(() => {});
      }
    }
  },
);

test(
  "late writer lease rejection is published once after successful retry",
  { timeout: 2_000 },
  async () => {
    const events = [];
    const closeStarted = deferred();
    const firstClose = deferred();
    const operationFailure = new Error("refresh failed");
    const lateLeaseFailure = new Error("writer lease close failed late");
    let closeCalls = 0;
    let firstCloseSettled = false;
    const running = runCli({
      arguments: ["refresh"],
      createApplicationFn: async () => {
        const application = applicationFor(events);
        application.refreshService.refresh = async () => {
          events.push("refresh");
          throw operationFailure;
        };
        return application;
      },
      writerLeaseFactory() {
        return {
          async acquire() {
            events.push("lease-acquire");
          },
          close() {
            closeCalls += 1;
            events.push(`lease-close-${closeCalls}`);
            if (closeCalls === 1) {
              closeStarted.resolve();
              return firstClose.promise;
            }
            return Promise.resolve();
          },
        };
      },
      cleanupPolicy: { maxAttempts: 2, timeoutMs: 20 },
      write() {},
    }).then(
      () => null,
      (error) => error,
    );
    await closeStarted.promise;

    const stillPending = Symbol("still pending");
    const failure = await Promise.race([
      running,
      new Promise((resolve) => setTimeout(() => resolve(stillPending), 250)),
    ]);
    try {
      assert.notStrictEqual(
        failure,
        stillPending,
        "runCli remained blocked on writer lease close",
      );
      assert.equal(failure.code, "CLI_CLEANUP_INCOMPLETE");
      assert.strictEqual(failure.operationError, operationFailure);
      assert.equal(failure.cleanupErrors.length, 1);
      assert.equal(failure.cleanupErrors[0].code, "CLI_CLEANUP_TIMEOUT");
      assert.deepEqual(failure.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "held",
      });

      firstCloseSettled = true;
      firstClose.reject(lateLeaseFailure);
      const recoveryFailure = await failure.lifecycle.recover().then(
        () => null,
        (error) => error,
      );

      assert.notStrictEqual(
        recoveryFailure,
        null,
        "recovery resolved without publishing the late lease failure",
      );
      assert.equal(recoveryFailure.code, "CLI_CLEANUP_FAILED");
      assert.strictEqual(recoveryFailure.operationError, operationFailure);
      assert.strictEqual(recoveryFailure.cleanupError, lateLeaseFailure);
      assert.deepEqual(recoveryFailure.cleanupErrors, [lateLeaseFailure]);
      assert.deepEqual(recoveryFailure.errors, [
        operationFailure,
        lateLeaseFailure,
      ]);
      assert.deepEqual(failure.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "released",
      });
      assert.equal(closeCalls, 2);
      assert.deepEqual(events, [
        "lease-acquire",
        "refresh",
        "application-close",
        "lease-close-1",
        "lease-close-2",
      ]);

      await failure.lifecycle.recover();
      assert.equal(closeCalls, 2);
    } finally {
      if (!firstCloseSettled) firstClose.reject(lateLeaseFailure);
      const settled = await running;
      if (settled?.lifecycle?.readStatus().writerLease === "held") {
        await settled.lifecycle.recover().catch(() => {});
        await settled.lifecycle.recover().catch(() => {});
      }
    }
  },
);

test(
  "same-object writer lease rejections publish one event per close attempt",
  async () => {
    const events = [];
    const sharedCloseFailure = new Error("writer lease close failed");
    let closeAttempts = 0;
    const failure = await runCli({
      arguments: ["refresh"],
      createApplicationFn: async () => applicationFor(events),
      writerLeaseFactory() {
        return {
          async acquire() {
            events.push("lease-acquire");
          },
          async close() {
            closeAttempts += 1;
            events.push(`lease-close-${closeAttempts}`);
            if (closeAttempts <= 4) throw sharedCloseFailure;
          },
        };
      },
      cleanupPolicy: { maxAttempts: 2, timeoutMs: 200 },
      write() {},
    }).then(
      () => null,
      (error) => error,
    );

    try {
      assert.notStrictEqual(failure, null);
      assert.equal(failure.code, "CLI_CLEANUP_INCOMPLETE");
      assert.equal(failure.operationError, null);
      assert.deepEqual(failure.cleanupErrors, [
        sharedCloseFailure,
        sharedCloseFailure,
      ]);
      assert.deepEqual(failure.errors, [
        sharedCloseFailure,
        sharedCloseFailure,
      ]);
      assert.deepEqual(failure.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "held",
      });
      assert.deepEqual(events, [
        "lease-acquire",
        "refresh",
        "workflow-routing",
        "application-close",
        "lease-close-1",
        "lease-close-2",
      ]);

      const recoveryFailure = await failure.lifecycle.recover().then(
        () => null,
        (error) => error,
      );
      assert.notStrictEqual(recoveryFailure, null);
      assert.equal(recoveryFailure.code, "CLI_CLEANUP_INCOMPLETE");
      assert.deepEqual(recoveryFailure.cleanupErrors, [
        sharedCloseFailure,
        sharedCloseFailure,
      ]);
      assert.deepEqual(recoveryFailure.errors, [
        sharedCloseFailure,
        sharedCloseFailure,
      ]);
      assert.notStrictEqual(
        recoveryFailure.cleanupErrors,
        failure.cleanupErrors,
      );
      assert.deepEqual(failure.cleanupErrors, [
        sharedCloseFailure,
        sharedCloseFailure,
      ]);
      assert.deepEqual(failure.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "held",
      });
      assert.deepEqual(events, [
        "lease-acquire",
        "refresh",
        "workflow-routing",
        "application-close",
        "lease-close-1",
        "lease-close-2",
        "lease-close-3",
        "lease-close-4",
      ]);

      await failure.lifecycle.recover();
      assert.deepEqual(failure.lifecycle.readStatus(), {
        cleanup: "complete",
        writerLease: "released",
      });
      assert.equal(closeAttempts, 5);
      const releasedEvents = [...events];

      await failure.lifecycle.recover();
      assert.equal(closeAttempts, 5);
      assert.deepEqual(events, releasedEvents);
      assert.deepEqual(failure.cleanupErrors, [
        sharedCloseFailure,
        sharedCloseFailure,
      ]);
      assert.deepEqual(recoveryFailure.cleanupErrors, [
        sharedCloseFailure,
        sharedCloseFailure,
      ]);
    } finally {
      for (
        let attempt = 0;
        attempt < 3 &&
        failure?.lifecycle?.readStatus().writerLease === "held";
        attempt += 1
      ) {
        await failure.lifecycle.recover().catch(() => {});
      }
    }
  },
);

test("an expired cleanup deadline starts no additional close attempt", async (t) => {
  const isolatedProjectRoot = await temporaryProjectRoot(t);
  const events = [];
  const closeFailure = new Error("application close reached its deadline");
  let now = 1_000;
  let closeAttempts = 0;
  let closeCanComplete = false;
  t.mock.method(Date, "now", () => now);

  const failure = await runCli({
    arguments: ["refresh"],
    projectRoot: isolatedProjectRoot,
    createApplicationFn: async () => {
      const application = applicationFor(events);
      application.close = async () => {
        closeAttempts += 1;
        events.push(`application-close-${closeAttempts}`);
        if (!closeCanComplete) {
          now = 1_100;
          throw closeFailure;
        }
      };
      return application;
    },
    writerLeaseFactory() {
      return recordingWriterLease(events);
    },
    cleanupPolicy: { maxAttempts: 2, timeoutMs: 100 },
    write() {},
  }).then(
    () => null,
    (error) => error,
  );

  try {
    assert.equal(failure.code, "CLI_CLEANUP_INCOMPLETE");
    assert.equal(closeAttempts, 1);
    assert.deepEqual(events, [
      "lease-acquire",
      "refresh",
      "workflow-routing",
      "application-close-1",
    ]);
  } finally {
    closeCanComplete = true;
    now = 2_000;
    if (failure?.lifecycle?.readStatus().writerLease === "held") {
      await failure.lifecycle.recover();
    }
  }

  assert.deepEqual(events, [
    "lease-acquire",
    "refresh",
    "workflow-routing",
    "application-close-1",
    "application-close-2",
    "lease-release",
  ]);
});
