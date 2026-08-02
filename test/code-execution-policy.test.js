import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeExecutionPolicy,
  CodeExecutionError,
  normalizeWorkspacePath,
  validateExecutionId,
  validateWorkspaceId,
} from "../src/domain/code-execution-policy.js";

test("workspace paths normalize separators without allowing traversal", () => {
  assert.equal(normalizeWorkspacePath("src\\feature\\index.js"), "src/feature/index.js");
  assert.throws(
    () => normalizeWorkspacePath("src/../config.local.json"),
    (error) =>
      error instanceof CodeExecutionError && error.code === "INVALID_PATH",
  );
});

test("unsafe ids and Windows path edge cases are rejected", () => {
  assert.equal(validateWorkspaceId("dashboard-one"), "dashboard-one");
  assert.equal(validateExecutionId("run-123"), "run-123");
  for (const unsafe of [
    "/src/app.js",
    "C:\\src\\app.js",
    "C:src\\app.js",
    "\\\\server\\share\\app.js",
    "\\\\?\\C:\\app.js",
    "\\\\.\\pipe\\name",
    "src//app.js",
    "src/./app.js",
    "src/../app.js",
    "src/app.js\0",
    "src/app.js:secret",
    "src/name. ",
    "src/CON.txt",
    "src/com9.js",
    "src/LPT1",
  ]) {
    assert.throws(
      () => normalizeWorkspacePath(unsafe),
      (error) => error.code === "INVALID_PATH",
      unsafe,
    );
  }
  assert.throws(
    () => validateWorkspaceId("Dashboard"),
    (error) => error.code === "INVALID_WORKSPACE_ID",
  );
  assert.throws(
    () => validateExecutionId("../run"),
    (error) => error.code === "INVALID_EXECUTION_ID",
  );
});

test("sensitive paths stay excluded and callers cannot widen write access", () => {
  const policy = new CodeExecutionPolicy({
    writablePaths: ["src", "README.md"],
    excludePaths: ["src/private"],
  });

  for (const sensitive of [
    ".git/config",
    "node_modules/pkg/index.js",
    "data/state.json",
    ".env.production",
    "config.local.json",
    "src/server.key",
    "src/private/note.txt",
  ]) {
    assert.throws(
      () => policy.assertAccessible(sensitive),
      (error) => error.code === "PATH_EXCLUDED",
      sensitive,
    );
  }
  assert.equal(policy.assertWritable("src/app.js"), "src/app.js");
  assert.throws(
    () => policy.assertWritable("package.json"),
    (error) => error.code === "WRITE_NOT_ALLOWED",
  );

  if (process.platform === "win32") {
    assert.throws(
      () => policy.assertAccessible("SRC/PRIVATE/note.txt"),
      (error) => error.code === "PATH_EXCLUDED",
    );
    assert.equal(policy.assertWritable("SRC/app.js"), "SRC/app.js");
  } else {
    assert.equal(policy.assertAccessible("SRC/PRIVATE/note.txt"), "SRC/PRIVATE/note.txt");
    assert.throws(
      () => policy.assertWritable("SRC/app.js"),
      (error) => error.code === "WRITE_NOT_ALLOWED",
    );
  }
});
