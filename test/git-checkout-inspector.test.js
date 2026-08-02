import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitCheckoutInspector,
  GitCheckoutInspectorError,
} from "../src/adapters/git-checkout-inspector.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "git-inspector-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function output(stdout) {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1,
    truncated: false,
  };
}

function fakeRunner(root, { status = "", head = HEAD, repositoryRoot = root } = {}) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(structuredClone(request));
      if (request.args.includes("--verify")) return output(head);
      if (request.args.includes("--show-toplevel")) return output(repositoryRoot);
      return output(status);
    },
  };
}

test("uses only fixed read-only Git commands and returns bounded checkout facts", async (t) => {
  const root = await fixture(t);
  const runner = fakeRunner(root);
  const gitCommand = path.resolve("C:/trusted/bin/git.exe");
  const inspector = new GitCheckoutInspector({ gitCommand, processRunner: runner });

  assert.deepEqual(await inspector.inspect({ sourceRoot: root }), {
    headOid: HEAD,
    clean: true,
  });
  assert.deepEqual(
    runner.calls.map(({ args }) => args.slice(5)),
    [
      ["rev-parse", "--verify", "HEAD"],
      ["rev-parse", "--show-toplevel"],
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
    ],
  );
  for (const call of runner.calls) {
    assert.equal(call.command, gitCommand);
    assert.equal(call.cwd, path.resolve(root));
    assert.deepEqual(call.env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    });
    assert.equal(call.timeoutMs, 15_000);
    assert.equal("input" in call, false);
    assert.deepEqual(call.args.slice(0, 5), [
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
    ]);
  }
});

test("reports dirty status without exposing changed paths", async (t) => {
  const root = await fixture(t);
  const runner = fakeRunner(root, { status: " M src/private-name.js" });
  const inspector = new GitCheckoutInspector({
    gitCommand: path.resolve("C:/trusted/bin/git.exe"),
    processRunner: runner,
  });

  assert.deepEqual(await inspector.inspect({ sourceRoot: root }), {
    headOid: HEAD,
    clean: false,
  });
});

test("fails closed on command, Head, root, and process protocol changes", async (t) => {
  const root = await fixture(t);
  const otherRoot = await fixture(t);
  const cases = [
    fakeRunner(root, { head: HEAD.toUpperCase() }),
    fakeRunner(root, { repositoryRoot: otherRoot }),
    {
      async run() {
        return { ...output("value"), exitCode: 1 };
      },
    },
  ];

  for (const processRunner of cases) {
    const inspector = new GitCheckoutInspector({
      gitCommand: path.resolve("C:/trusted/bin/git.exe"),
      processRunner,
    });
    await assert.rejects(
      inspector.inspect({ sourceRoot: root }),
      (error) => error instanceof GitCheckoutInspectorError,
    );
  }
});

test("rejects widened requests and unsafe configuration without invoking accessors", async (t) => {
  const root = await fixture(t);
  const runner = fakeRunner(root);
  assert.throws(
    () => new GitCheckoutInspector({ gitCommand: "git", processRunner: runner }),
    (error) => error?.code === "INVALID_GIT_CHECKOUT_INSPECTOR_CONFIG",
  );
  const inspector = new GitCheckoutInspector({
    gitCommand: path.resolve("C:/trusted/bin/git.exe"),
    processRunner: runner,
  });
  await assert.rejects(
    inspector.inspect({ sourceRoot: root, command: "reset --hard" }),
    (error) => error?.code === "INVALID_GIT_CHECKOUT_INSPECTION",
  );

  let getterCalls = 0;
  const request = {};
  Object.defineProperty(request, "sourceRoot", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return root;
    },
  });
  await assert.rejects(
    inspector.inspect(request),
    (error) => error?.code === "INVALID_GIT_CHECKOUT_INSPECTION",
  );
  assert.equal(getterCalls, 0);
  assert.equal(runner.calls.length, 0);
});
