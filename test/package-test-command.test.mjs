import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const standaloneEnvironment = { ...process.env };
delete standaloneEnvironment.NODE_TEST_CONTEXT;

test("the package script admits its priority entry before a deep direct-test glob", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "u11-native-cli-red-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const projectDirectory = path.join(
    root,
    "controlled-deep-checkout-segment-000000000001",
    "controlled-deep-checkout-segment-000000000002",
    "controlled-deep-checkout-segment-000000000003",
  );
  const controlledTestDirectory = path.join(projectDirectory, "test");
  const stateDirectory = path.join(projectDirectory, "state");
  mkdirSync(controlledTestDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });

  const packageScript = JSON.parse(
    readFileSync(path.join(testDirectory, "..", "package.json"), "utf8"),
  ).scripts.test;
  writeFileSync(
    path.join(projectDirectory, "package.json"),
    `${JSON.stringify({
      name: "controlled-u11-package-script",
      private: true,
      type: "module",
      scripts: { test: packageScript },
    }, null, 2)}\n`,
  );

  writeFileSync(
    path.join(controlledTestDirectory, "00-u9-priority.mjs"),
    'import "./u9-priority-implementation.mjs";\n',
  );
  writeFileSync(
    path.join(controlledTestDirectory, "u9-priority-implementation.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'import test from "node:test";',
      'import { setTimeout as delay } from "node:timers/promises";',
      '',
      'const stateDirectory = process.env.U11_PACKAGE_STATE_DIRECTORY;',
      'const admittedCount = () => readdirSync(stateDirectory)',
      '  .filter((name) => name.endsWith(".admitted")).length;',
      'test("priority", async () => {',
      '  const deadline = Date.now() + 10_000;',
      '  while (admittedCount() < 3 && Date.now() < deadline) await delay(10);',
      '  await delay(500);',
      '  assert.equal(admittedCount(), 3, "priority entry was not one of exactly four admitted files");',
      '  writeFileSync(path.join(stateDirectory, "priority.done"), "", { flag: "wx" });',
      '  writeFileSync(path.join(stateDirectory, "priority.latch"), "ready", { flag: "wx" });',
      '});',
      '',
    ].join("\n"),
  );

  const ordinaryFiles = [];
  const expandedArguments = [
    path.join(controlledTestDirectory, "00-u9-priority.mjs"),
  ];
  while (Buffer.byteLength(expandedArguments.join(" "), "utf8") <= 32_767) {
    const logicalName = `ordinary-${String(ordinaryFiles.length).padStart(3, "0")}`;
    const fileName = `${logicalName}-${"x".repeat(24)}.test.js`;
    ordinaryFiles.push({ fileName, logicalName });
    expandedArguments.push(path.join(controlledTestDirectory, fileName));
  }
  assert.ok(ordinaryFiles.length > 4);

  for (const { fileName, logicalName } of ordinaryFiles) {
    writeFileSync(
      path.join(controlledTestDirectory, fileName),
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'import test from "node:test";',
        'import { setTimeout as delay } from "node:timers/promises";',
        '',
        'const stateDirectory = process.env.U11_PACKAGE_STATE_DIRECTORY;',
        'const latchPath = path.join(stateDirectory, "priority.latch");',
        'const missedPath = path.join(stateDirectory, "priority-missed-first-window");',
        `test(${JSON.stringify(logicalName)}, async () => {`,
        `  writeFileSync(path.join(stateDirectory, ${JSON.stringify(`${logicalName}.admitted`)}), "", { flag: "wx" });`,
        '  const deadline = Date.now() + 15_000;',
        '  while (!existsSync(latchPath)) {',
        '    if (existsSync(missedPath)) {',
        '      throw new Error("priority entry missed the first concurrency-four window");',
        '    }',
        '    if (Date.now() >= deadline) {',
        '      try {',
        '        writeFileSync(missedPath, "missed", { flag: "wx" });',
        '      } catch (error) {',
        '        if (error.code !== "EEXIST") throw error;',
        '      }',
        '      throw new Error("priority entry missed the first concurrency-four window");',
        '    }',
        '    await delay(10);',
        '  }',
        `  writeFileSync(path.join(stateDirectory, ${JSON.stringify(`${logicalName}.done`)}), "", { flag: "wx" });`,
        '});',
        '',
      ].join("\n"),
    );
  }
  writeFileSync(
    path.join(controlledTestDirectory, "ordinary-module.test.mjs"),
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'import test from "node:test";',
      'import { setTimeout as delay } from "node:timers/promises";',
      '',
      'const stateDirectory = process.env.U11_PACKAGE_STATE_DIRECTORY;',
      'const latchPath = path.join(stateDirectory, "priority.latch");',
      'test("ordinary module test", async () => {',
      '  const deadline = Date.now() + 15_000;',
      '  while (!existsSync(latchPath)) {',
      '    if (Date.now() >= deadline) throw new Error("priority latch unavailable");',
      '    await delay(10);',
      '  }',
      '  writeFileSync(path.join(stateDirectory, "ordinary-module.done"), "", { flag: "wx" });',
      '});',
      '',
    ].join("\n"),
  );
  const expectedCoreDone = [
    "ordinary-module.done",
    "priority.done",
    ...ordinaryFiles.map(({ logicalName }) => `${logicalName}.done`),
  ].sort((left, right) => left.localeCompare(right, "en"));
  writeFileSync(
    path.join(controlledTestDirectory, "open-source-distribution.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { readdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'import test from "node:test";',
      '',
      'const stateDirectory = process.env.U11_PACKAGE_STATE_DIRECTORY;',
      'test("distribution runs after the concurrent core suite", () => {',
      '  const completed = readdirSync(stateDirectory)',
      '    .filter((name) => name.endsWith(".done"))',
      '    .sort((left, right) => left.localeCompare(right, "en"));',
      `  assert.deepEqual(completed, ${JSON.stringify(expectedCoreDone)});`,
      '  writeFileSync(path.join(stateDirectory, "distribution.done"), "", { flag: "wx" });',
      '});',
      '',
    ].join("\n"),
  );

  const npmExecutable = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : "npm";
  const npmArguments = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm test"]
    : ["test"];
  const result = spawnSync(npmExecutable, npmArguments, {
    cwd: projectDirectory,
    encoding: "utf8",
    env: {
      ...standaloneEnvironment,
      U11_PACKAGE_STATE_DIRECTORY: stateDirectory,
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90_000,
    windowsHide: true,
  });

  assert.equal(
    result.status,
    0,
    `controlled package script failed\nerror: ${result.error?.stack ?? "none"}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.signal, null);
  assert.match(result.stdout, /TAP version 13/u);
  assert.equal(
    readdirSync(stateDirectory).includes("priority-missed-first-window"),
    false,
  );
  assert.deepEqual(
    readdirSync(stateDirectory)
      .filter((name) => name.endsWith(".done"))
      .sort((left, right) => left.localeCompare(right, "en")),
    [
      "distribution.done",
      "ordinary-module.done",
      "priority.done",
      ...ordinaryFiles.map(({ logicalName }) => `${logicalName}.done`),
    ].sort((left, right) => left.localeCompare(right, "en")),
  );
});
