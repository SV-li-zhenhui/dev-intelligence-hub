import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/lib/command-runner.js";

test("runCommand passes an explicit environment without mutating the parent", async () => {
  const key = "MY_DASHBOARD_COMMAND_RUNNER_ENV_TEST";
  const original = process.env[key];
  const expected = "explicit-child-value";

  const output = await runCommand(
    process.execPath,
    ["-e", `process.stdout.write(process.env.${key} || "missing")`],
    { env: { ...process.env, [key]: expected } },
  );

  assert.equal(output, expected);
  assert.equal(process.env[key], original);
});
