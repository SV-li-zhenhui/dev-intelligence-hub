import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ManagedProcess,
  ManagedProcessError,
  ManagedProcessRunner,
} from "../src/lib/managed-process.js";

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.ended = false;
    this.input = undefined;
  }

  end(input) {
    this.ended = true;
    this.input = input;
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4321;
    this.stdin = new FakeStream();
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
  }
}

function withDeadline(promise, timeoutMs = 100) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("TEST_PROCESS_STALLED")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

test("managed processes spawn without a shell and preserve ordered output", async () => {
  const child = new FakeChild();
  let invocation;
  const lines = [];
  const process = new ManagedProcess({
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });

  process.start({
    command: "C:\\Tools\\docker.exe",
    args: ["version"],
    env: { SystemRoot: "C:\\Windows" },
    onLine: (event) => lines.push(event),
  });
  child.stdout.emit("data", Buffer.from("one\ntw"));
  child.stderr.emit("data", Buffer.from("warn\n"));
  child.stdout.emit("data", Buffer.from("o"));
  child.emit("close", 0, null);
  await process.done;

  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.deepEqual(invocation.options.env, { SystemRoot: "C:\\Windows" });
  assert.equal(child.stdin.ended, true);
  assert.deepEqual(lines, [
    { sequence: 1, stream: "stdout", line: "one" },
    { sequence: 2, stream: "stderr", line: "warn" },
    { sequence: 3, stream: "stdout", line: "two" },
  ]);
});

test("managed runners send bounded request input through stdin instead of argv", async () => {
  const child = new FakeChild();
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({ spawnImpl: () => child }),
  });
  const running = runner.run({
    command: "C:\\Tools\\gh.exe",
    args: ["api", "--input", "-"],
    env: {},
    input: '{"body":"private review"}',
  });

  child.stdout.emit("data", Buffer.from("{}\n"));
  child.emit("close", 0, null);
  const result = await running;

  assert.equal(child.stdin.ended, true);
  assert.equal(child.stdin.input, '{"body":"private review"}');
  assert.equal(result.stdout, "{}");
});

test("managed runners reject oversized stdin before spawning", async () => {
  let spawned = false;
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({
        spawnImpl: () => {
          spawned = true;
          return new FakeChild();
        },
      }),
  });

  await assert.rejects(
    runner.run({
      command: "C:\\Tools\\gh.exe",
      input: "x".repeat(1024 * 1024 + 1),
    }),
    (error) =>
      error instanceof ManagedProcessError &&
      error.code === "INVALID_PROCESS_INPUT",
  );
  assert.equal(spawned, false);
});

test("managed runners contain stdin EPIPE failures", async () => {
  const child = new FakeChild();
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({
        spawnImpl: () => child,
        treeTerminator: async () => child.emit("close", 1, null),
      }),
  });
  const running = runner.run({
    command: "C:\\Tools\\gh.exe",
    args: ["api", "--input", "-"],
    input: "payload",
  });

  child.stdin.emit("error", Object.assign(new Error("broken pipe"), {
    code: "EPIPE",
  }));

  await assert.rejects(
    running,
    (error) =>
      error instanceof ManagedProcessError && error.code === "PROCESS_FAILED",
  );
});

test("managed process stop terminates the complete process tree", async () => {
  const child = new FakeChild();
  const terminated = [];
  const process = new ManagedProcess({
    spawnImpl: () => child,
    treeTerminator: async (pid, options) => {
      terminated.push({ pid, options });
      child.emit("close", 137, "SIGKILL");
    },
  });

  process.start({ command: "C:\\Tools\\docker.exe", args: [], env: {} });
  await process.stop({ gracefulMs: 0 });

  assert.equal(child.stdin.ended, true);
  assert.deepEqual(terminated, [
    { pid: 4321, options: { force: true, timeoutMs: 5_000 } },
  ]);
});

test("managed runners fail with stable timeout and output-limit errors", async () => {
  for (const scenario of ["timeout", "output-limit"]) {
    const child = new FakeChild();
    const runner = new ManagedProcessRunner({
      managedProcessFactory: () =>
        new ManagedProcess({
          spawnImpl: () => child,
          maxOutputBytes: scenario === "output-limit" ? 3 : 1024,
          treeTerminator: async () => child.emit("close", 137, "SIGKILL"),
        }),
    });
    const running = runner.run({
      command: "C:\\Tools\\docker.exe",
      args: [],
      env: {},
      timeoutMs: scenario === "timeout" ? 5 : 1_000,
    });
    if (scenario === "output-limit") {
      child.stdout.emit("data", Buffer.from("ok\n"));
      child.stdout.emit("data", Buffer.from("1234"));
    } else {
      child.stdout.emit("data", Buffer.from("before timeout\n"));
    }

    await assert.rejects(
      running,
      (error) =>
        error instanceof ManagedProcessError &&
        error.code ===
          (scenario === "timeout" ? "PROCESS_TIMEOUT" : "PROCESS_OUTPUT_LIMIT") &&
        error.details?.stdout ===
          (scenario === "timeout" ? "before timeout" : "ok") &&
        error.details?.exitCode === 137 &&
        error.details?.truncated === (scenario === "output-limit"),
    );
  }
});

test("managed runners wait for delayed close after direct kill fallback", async () => {
  const child = new FakeChild();
  let directKills = 0;
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  child.kill = () => {
    directKills += 1;
    setTimeout(() => child.emit("close", 137, "SIGKILL"), 10);
    return true;
  };
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({
        spawnImpl: () => child,
        terminationTimeoutMs: 50,
        treeTerminator: async () => {
          throw new Error("taskkill failed");
        },
      }),
  });

  await assert.rejects(
    withDeadline(
      runner.run({
        command: "C:\\Tools\\docker.exe",
        args: [],
        env: {},
        timeoutMs: 1,
      }),
      200,
    ),
    (error) =>
      error instanceof ManagedProcessError &&
      error.code === "PROCESS_STOP_FAILED",
  );
  assert.equal(directKills, 1);
  assert.equal(closed, true);
});

test("managed runners bound waiting when direct kill never closes the process", async () => {
  const child = new FakeChild();
  let directKills = 0;
  child.kill = () => {
    directKills += 1;
    return true;
  };
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({
        spawnImpl: () => child,
        terminationTimeoutMs: 5,
        treeTerminator: async () => {
          throw new Error("taskkill failed");
        },
      }),
  });

  await assert.rejects(
    withDeadline(
      runner.run({
        command: "C:\\Tools\\docker.exe",
        args: [],
        env: {},
        timeoutMs: 1,
      }),
    ),
    (error) =>
      error instanceof ManagedProcessError &&
      error.code === "PROCESS_STOP_FAILED",
  );
  assert.equal(directKills, 1);
});

test("managed runners wait for direct kill after a successful tree request stalls", async () => {
  const child = new FakeChild();
  let directKills = 0;
  let closed = false;
  child.once("close", () => {
    closed = true;
  });
  child.kill = () => {
    directKills += 1;
    setTimeout(() => child.emit("close", 137, "SIGKILL"), 10);
    return true;
  };
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({
        spawnImpl: () => child,
        terminationTimeoutMs: 20,
        treeTerminator: async () => {},
      }),
  });

  await assert.rejects(
    withDeadline(
      runner.run({
        command: "C:\\Tools\\docker.exe",
        args: [],
        env: {},
        timeoutMs: 1,
      }),
      100,
    ),
    (error) =>
      error instanceof ManagedProcessError &&
      error.code === "PROCESS_STOP_FAILED",
  );
  assert.equal(directKills, 1);
  assert.equal(closed, true);
});

test("managed runners bound a tree terminator that never settles", async () => {
  const child = new FakeChild();
  let directKills = 0;
  child.kill = () => {
    directKills += 1;
    return true;
  };
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({
        spawnImpl: () => child,
        terminationTimeoutMs: 5,
        treeTerminator: () => new Promise(() => {}),
      }),
  });

  await assert.rejects(
    withDeadline(
      runner.run({
        command: "C:\\Tools\\docker.exe",
        args: [],
        env: {},
        timeoutMs: 5,
      }),
    ),
    (error) =>
      error instanceof ManagedProcessError &&
      error.code === "PROCESS_STOP_FAILED",
  );
  assert.equal(directKills, 1);
});

test("managed runners do not wait for close after a process error", async () => {
  const child = new FakeChild();
  const runner = new ManagedProcessRunner({
    managedProcessFactory: () =>
      new ManagedProcess({
        spawnImpl: () => child,
        terminationTimeoutMs: 5,
        treeTerminator: async () => child.emit("close", 137, "SIGKILL"),
      }),
  });
  const running = runner.run({
    command: "C:\\Tools\\docker.exe",
    args: [],
    env: {},
    timeoutMs: 1_000,
  });
  child.emit("error", new Error("spawn failed"));

  await assert.rejects(
    withDeadline(running),
    (error) =>
      error instanceof ManagedProcessError && error.code === "PROCESS_FAILED",
  );
});
