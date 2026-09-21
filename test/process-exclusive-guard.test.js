import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ProcessExclusiveGuard,
} from "../src/lib/process-exclusive-guard.js";

const CHILD_MODE = process.env.MYDASHBOARD_GUARD_TEST_CHILD;
const CHILD_GUARD_NAME = process.env.MYDASHBOARD_GUARD_TEST_NAME;

function sendToParent(message) {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error("guard test child has no IPC channel"));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function runGuardChild() {
  const guard = new ProcessExclusiveGuard({ name: CHILD_GUARD_NAME });
  if (CHILD_MODE === "hold") {
    await guard.acquire();
    await sendToParent({ type: "acquired" });
    await new Promise(() => {});
    return;
  }

  let entered = false;
  try {
    await guard.run(() => {
      entered = true;
    });
    await sendToParent({ type: "attempt", entered, errorCode: null });
  } catch (error) {
    await sendToParent({
      type: "attempt",
      entered,
      errorCode: error?.code || "UNKNOWN",
    });
  } finally {
    await guard.close();
    process.disconnect();
  }
}

function uniqueGuardName() {
  return `mydashboard-test-${process.pid}-${randomUUID()}`;
}

function startChild(mode, name) {
  return fork(new URL(import.meta.url), [], {
    env: {
      ...process.env,
      MYDASHBOARD_GUARD_TEST_CHILD: mode,
      MYDASHBOARD_GUARD_TEST_NAME: name,
    },
    silent: true,
  });
}

function waitForMessage(child, expectedType) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`guard child timed out; stderr: ${stderr}`));
    }, 5_000);
    const handleStderr = (chunk) => {
      stderr += chunk;
    };
    const handleMessage = (message) => {
      if (message?.type !== expectedType) return;
      cleanup();
      resolve(message);
    };
    const handleExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `guard child exited before ${expectedType}: code=${code} signal=${signal}; stderr: ${stderr}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", handleMessage);
      child.off("exit", handleExit);
      child.stderr?.off("data", handleStderr);
    };

    child.on("message", handleMessage);
    child.once("exit", handleExit);
    child.stderr?.on("data", handleStderr);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

if (CHILD_MODE) {
  await runGuardChild();
} else {
  test("one guard instance serializes operations", async () => {
    const guard = new ProcessExclusiveGuard({ name: uniqueGuardName() });
    const events = [];
    let releaseFirst;
    let signalFirstStarted;
    const firstStarted = new Promise((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = guard.run(async () => {
      events.push("first:start");
      signalFirstStarted();
      await firstGate;
      events.push("first:end");
    });
    const second = guard.run(() => {
      events.push("second");
    });

    await firstStarted;
    assert.deepEqual(events, ["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second"]);
    await guard.close();
  });

  test("a competing process fails closed and a crashed owner releases the guard", async (context) => {
    const name = uniqueGuardName();
    const holder = startChild("hold", name);
    context.after(() => {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    });
    await waitForMessage(holder, "acquired");

    const contender = startChild("attempt", name);
    context.after(() => {
      if (contender.exitCode === null && contender.signalCode === null) contender.kill("SIGKILL");
    });
    const result = await waitForMessage(contender, "attempt");
    assert.deepEqual(result, {
      type: "attempt",
      entered: false,
      errorCode: "PROCESS_GUARD_HELD",
    });
    await waitForExit(contender);

    holder.kill("SIGKILL");
    await waitForExit(holder);

    const successor = new ProcessExclusiveGuard({ name });
    let successorEntered = false;
    await successor.run(() => {
      successorEntered = true;
    });
    assert.equal(successorEntered, true);
    await successor.close();
  });

test("close releases the OS handle and permanently closes that instance", async () => {
    const name = uniqueGuardName();
    const first = new ProcessExclusiveGuard({ name });
    await first.acquire();
    await first.close();

    await assert.rejects(
      first.run(() => {}),
      (error) => error.code === "PROCESS_GUARD_CLOSED",
    );

    const second = new ProcessExclusiveGuard({ name });
    await second.run(() => {});
    await second.close();
});

test("held assertions are valid only for the active OS-backed lease", async () => {
  const guard = new ProcessExclusiveGuard({ name: uniqueGuardName() });
  assert.throws(() => guard.assertHeld(), { code: "PROCESS_GUARD_NOT_HELD" });
  await guard.acquire();
  assert.equal(guard.assertHeld(), true);
  await guard.close();
  assert.throws(() => guard.assertHeld(), { code: "PROCESS_GUARD_NOT_HELD" });
});
}
