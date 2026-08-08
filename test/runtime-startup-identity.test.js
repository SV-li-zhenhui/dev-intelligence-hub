import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function git(root, ...arguments_) {
  await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-startup-identity-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/app.js"), "export const version = 1;\n");
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "runtime-startup-fixture",
    private: true,
    type: "module",
    files: ["src/"],
  }, null, 2)}\n`);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.email", "startup@example.invalid");
  await git(root, "config", "user.name", "Startup Fixture");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "startup fixture");
  return root;
}

async function loadStartupIdentity() {
  try {
    return await import("../src/lib/runtime-startup-identity.js");
  } catch (error) {
    assert.fail(`runtime startup identity module is unavailable: ${error.message}`);
  }
}

test("startup identity remains stable across application module loading", async (t) => {
  const root = await fixture(t);
  const {
    captureRuntimeStartupIdentity,
    verifyRuntimeStartupIdentity,
  } = await loadStartupIdentity();

  const captured = await captureRuntimeStartupIdentity(root);

  assert.deepEqual(
    await verifyRuntimeStartupIdentity(root, captured),
    captured,
  );
});

test("startup identity rejects source changed while application modules load", async (t) => {
  const root = await fixture(t);
  const {
    captureRuntimeStartupIdentity,
    verifyRuntimeStartupIdentity,
  } = await loadStartupIdentity();
  const captured = await captureRuntimeStartupIdentity(root);
  await writeFile(path.join(root, "src/app.js"), "export const version = 2;\n");
  await git(root, "add", "src/app.js");
  await git(root, "commit", "--quiet", "-m", "replace application source");

  await assert.rejects(
    verifyRuntimeStartupIdentity(root, captured),
    /runtime source changed while application modules loaded/u,
  );
});
