import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const maximumDiagnosticCharacters = 8_000;

function diagnostic(result) {
  return [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .slice(-maximumDiagnosticCharacters);
}

function npmInvocation(arguments_) {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const npmCli = candidates.find(
    (candidate) => typeof candidate === "string" && existsSync(candidate),
  );
  if (npmCli) {
    return { command: process.execPath, arguments: [npmCli, ...arguments_] };
  }
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      arguments: ["/d", "/s", "/c", `npm ${arguments_.join(" ")}`],
    };
  }
  return { command: "npm", arguments: arguments_ };
}

function runNpm(arguments_, cwd, timeout = 120_000) {
  const invocation = npmInvocation(arguments_);
  return spawnSync(invocation.command, invocation.arguments, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function managerPowerShell() {
  if (process.platform === "win32") {
    const executable = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    return existsSync(executable) ? executable : null;
  }
  const located = spawnSync("which", ["pwsh"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return located.status === 0 ? located.stdout.trim() : null;
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function cleanManagerEnvironment(cleanRoot) {
  const environment = {};
  const replacedNames = new Set([
    "home",
    "localappdata",
    "path",
    "temp",
    "tmp",
    "userprofile",
    "xdg_runtime_dir",
  ]);
  const sensitiveName =
    /(?:token|secret|password|credential|cookie|api[_-]?key|auth|proxy|github|openai|doubao|ark)/iu;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      replacedNames.has(name.toLowerCase()) ||
      name.startsWith("MYDASHBOARD_") ||
      sensitiveName.test(name)
    ) {
      continue;
    }
    environment[name] = value;
  }
  const home = path.join(cleanRoot, "clean-home");
  const localAppData = path.join(cleanRoot, "clean-local-app-data");
  const temporary = path.join(cleanRoot, "clean-temp");
  const runtime = path.join(cleanRoot, "clean-runtime");
  Object.assign(environment, {
    HOME: home,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    USERPROFILE: home,
    XDG_RUNTIME_DIR: runtime,
    [process.platform === "win32" ? "Path" : "PATH"]:
      path.dirname(process.execPath),
  });
  return { environment, directories: [home, localAppData, temporary, runtime] };
}

function runManager({ executable, rootDirectory, environment, action }) {
  const arguments_ = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    ...(process.platform === "win32"
      ? ["-ExecutionPolicy", "Bypass"]
      : []),
    "-File",
    path.join(rootDirectory, "scripts", "Manage-MyDashboard.ps1"),
    "-Action",
    action,
    "-TimeoutSeconds",
    "45",
  ];
  return spawnSync(executable, arguments_, {
    cwd: rootDirectory,
    encoding: "utf8",
    env: environment,
    timeout: 90_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function managedRuntimeInfo(rootDirectory, environment) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(rootDirectory, "scripts", "launch-mydashboard-process.mjs"),
      "--runtime-info",
    ],
    {
      cwd: rootDirectory,
      encoding: "utf8",
      env: environment,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  assert.equal(
    result.status,
    0,
    `managed runtime identity failed:\n${diagnostic(result)}`,
  );
  return JSON.parse(result.stdout);
}

async function pollJson(url, timeoutMilliseconds = 45_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastFailure = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const text = await response.text();
      if (response.status === 200) {
        return { body: JSON.parse(text), text };
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error?.name || "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`local server did not become ready: ${lastFailure}`);
}

async function waitUntilStopped(url, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("managed server still accepts connections after shutdown");
}

let distributionManifest;
let trackedFiles;

function runGit(arguments_, timeout = 60_000) {
  return spawnSync("git", arguments_, {
    cwd: root,
    encoding: arguments_.includes("-z") ? "buffer" : "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function loadTrackedFiles() {
  if (trackedFiles) return trackedFiles;
  const listed = runGit(["ls-files", "-z"]);
  assert.equal(
    listed.status,
    0,
    `git ls-files failed:\n${diagnostic(listed)}`,
  );
  trackedFiles = new Set(
    listed.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((filePath) => filePath.replaceAll("\\", "/")),
  );
  return trackedFiles;
}

function loadDistributionManifest() {
  if (distributionManifest) return distributionManifest;
  const packed = runNpm(
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    root,
    60_000,
  );
  assert.equal(
    packed.status,
    0,
    `npm pack --dry-run failed:\n${diagnostic(packed)}`,
  );
  const report = JSON.parse(packed.stdout);
  assert.equal(report.length, 1);
  distributionManifest = report[0].files.map(({ path: filePath }) => filePath);
  return distributionManifest;
}

function assertPortablePackagePath(filePath) {
  assert.equal(path.posix.isAbsolute(filePath), false, filePath);
  assert.equal(filePath.includes("\\"), false, filePath);
  assert.equal(path.posix.normalize(filePath), filePath, filePath);
  assert.equal(filePath === ".." || filePath.startsWith("../"), false, filePath);
}

function localPath(rootDirectory, portablePath) {
  return path.join(rootDirectory, ...portablePath.split("/"));
}

test("npm distribution contains the safe bootstrap and excludes local runtime state", () => {
  const files = loadDistributionManifest();
  const included = new Set(files);
  for (const filePath of files) assertPortablePackagePath(filePath);

  for (const required of [
    "CONTRIBUTING.md",
    "SECURITY.md",
    "config.example.json",
    "docs/ARCHITECTURE.md",
    "docs/OPERATIONS.md",
    "docs/PRIVACY.md",
    "package.json",
    "README.md",
    "src/lib/config.js",
    "src/server.js",
  ]) {
    assert.equal(included.has(required), true, `missing ${required}`);
  }

  for (const forbidden of [
    "config.json",
    "config.local.json",
    ".env",
    ".env.local",
    "DEVELOPMENT_PLAN.md",
    "validation-notes.md",
  ]) {
    assert.equal(
      included.has(forbidden),
      false,
      `packaged private file ${forbidden}`,
    );
  }

  for (const filePath of files) {
    assert.doesNotMatch(
      filePath,
      /^(?:data|logs|backups|restore-control|validation-artifacts|node_modules|\.review-runs|playwright-report|test-results|test|test-support|docs\/(?:plans|reviews))(?:\/|$)/u,
    );
  }
});

test("distribution and clean-room inputs come only from the committed tree", () => {
  const sourceFiles = new Set([
    ...loadDistributionManifest(),
    ".gitignore",
    "package-lock.json",
  ]);
  const tracked = loadTrackedFiles();
  for (const filePath of sourceFiles) {
    assert.equal(tracked.has(filePath), true, `untracked release input ${filePath}`);
  }

  const dirty = runGit(["diff", "--quiet", "HEAD", "--", ...sourceFiles]);
  assert.equal(
    dirty.status,
    0,
    "release inputs differ from HEAD; commit them before clean-room acceptance",
  );
});

test("distributable text contains no high-confidence live credential or private machine path", async () => {
  const credentialPatterns = [
    new RegExp(`\\b${["gh", "p_"].join("")}[A-Za-z0-9]{30,}\\b`, "gu"),
    new RegExp(`\\b${["github", "_pat_"].join("")}[A-Za-z0-9_]{40,}\\b`, "gu"),
    new RegExp(`\\b${["sk", "-"].join("")}[A-Za-z0-9_-]{20,}\\b`, "gu"),
    new RegExp(`\\b${["AK", "IA"].join("")}[0-9A-Z]{16}\\b`, "gu"),
    new RegExp(`\\b${["AI", "za"].join("")}[0-9A-Za-z_-]{30,}\\b`, "gu"),
    new RegExp(`\\b${["xox", "b-"].join("")}[A-Za-z0-9-]{20,}\\b`, "gu"),
  ];
  const userHomePatterns = [
    /[A-Za-z]:[\\/]Users[\\/](?!<(?:user|username)>)[^\\/\s"']+/giu,
    /\/Users\/(?!<(?:user|username)>)[^/\s"']+/giu,
    /\/home\/(?!<(?:user|username)>)[^/\s"']+/giu,
  ];
  const projectPaths = new Set([
    root,
    root.replaceAll("\\", "/"),
    root.replaceAll("/", "\\"),
  ].map((projectPath) => projectPath.toLowerCase()));

  for (const filePath of loadDistributionManifest()) {
    const source = await readFile(localPath(root, filePath));
    if (source.includes(0)) continue;
    const text = source.toString("utf8");
    for (const pattern of credentialPatterns) {
      for (const match of text.matchAll(pattern)) {
        const explicitFixture =
          filePath.startsWith("test/") &&
          /(?:never|not[-_]a[-_]real|must[-_]not|do[-_]not|example|fixture)/iu.test(
            match[0],
          );
        assert.equal(
          explicitFixture,
          true,
          `${filePath} contains a credential-shaped value`,
        );
      }
    }
    for (const pattern of userHomePatterns) {
      assert.doesNotMatch(text, pattern, `${filePath} contains a user-home path`);
    }

    if (!filePath.startsWith("test/")) {
      const comparableText = text.toLowerCase();
      assert.equal(
        comparableText.includes("svisions/oct-software"),
        false,
        `${filePath} contains a private repository identity`,
      );
      assert.equal(
        comparableText.includes("#23178"),
        false,
        `${filePath} contains a private pull-request identity`,
      );
      for (const projectPath of projectPaths) {
        assert.equal(
          comparableText.includes(projectPath),
          false,
          `${filePath} contains the source checkout path`,
        );
      }
    }
  }
});

test(
  "a clean source payload installs and composes without private config.json",
  async (context) => {
    const cleanRoot = await mkdtemp(
      path.join(tmpdir(), "mydashboard-clean-source-"),
    );
    let fallbackStop = null;
    let managedProcessId = null;
    let managedLiveUrl = null;
    context.after(async () => {
      if (fallbackStop) {
        const stopped = fallbackStop();
        if (
          stopped.status !== 0 &&
          Number.isInteger(managedProcessId) &&
          managedProcessId > 0
        ) {
          try {
            process.kill(managedProcessId);
            await waitUntilStopped(managedLiveUrl, 5_000);
          } catch {
            // The exact managed fixture process is already gone.
          }
        }
      }
      assert.equal(path.dirname(cleanRoot), path.resolve(tmpdir()));
      await rm(cleanRoot, { recursive: true, force: true });
    });

    const sourceFiles = new Set([
      ...loadDistributionManifest(),
      // npm intentionally omits lockfiles from tarballs; a clean source checkout
      // includes these files and therefore supports npm ci and ignore-boundary
      // verification without copying any ignored private configuration.
      ".gitignore",
      "package-lock.json",
    ]);
    for (const filePath of sourceFiles) {
      assertPortablePackagePath(filePath);
      const destination = localPath(cleanRoot, filePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(localPath(root, filePath), destination);
    }

    assert.equal(existsSync(path.join(cleanRoot, "config.json")), false);
    assert.equal(existsSync(path.join(cleanRoot, "config.local.json")), false);

    const installed = runNpm(
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ],
      cleanRoot,
    );
    assert.equal(
      installed.status,
      0,
      `clean npm ci failed:\n${diagnostic(installed)}`,
    );

    const probeSource = [
      'import { loadConfigBootstrap } from "./src/lib/config.js";',
      'import { normalizeConfigurationDocument } from "./src/domain/configuration-contract.js";',
      // Import the executable module too: its dependency graph must be loadable in
      // a clean checkout, while its main guard keeps this probe side-effect free.
      'await import("./src/server.js");',
      "const bootstrap = await loadConfigBootstrap();",
      "if (bootstrap.bootstrapError !== null) throw new Error('bootstrap error');",
      "const configuration = normalizeConfigurationDocument(bootstrap.candidate);",
      "if (configuration.codeExecutor.enabled !== false) throw new Error('executor enabled');",
      "if (configuration.githubActions.enabled !== false) throw new Error('actions enabled');",
      "if (configuration.memory.enabled !== false) throw new Error('memory enabled');",
      "process.stdout.write('SAFE_BOOTSTRAP_OK');",
    ].join("\n");
    const probed = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", probeSource],
      {
        cwd: cleanRoot,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.equal(
      probed.status,
      0,
      `clean safe-bootstrap probe failed:\n${diagnostic(probed)}`,
    );
    assert.equal(probed.stdout, "SAFE_BOOTSTRAP_OK");

    const powershell = managerPowerShell();
    if (process.platform === "win32") {
      assert.notEqual(
        powershell,
        null,
        "Windows release validation requires PowerShell for managed-start verification",
      );
    }
    await context.test(
      "the clean payload starts, reports status, and stops through its trusted manager",
      { skip: process.platform !== "win32" && powershell === null },
      async () => {
        const port = await availablePort();
        const examplePath = path.join(cleanRoot, "config.example.json");
        const example = JSON.parse(await readFile(examplePath, "utf8"));
        example.port = port;
        await writeFile(examplePath, `${JSON.stringify(example, null, 2)}\n`);

        const { environment, directories } = cleanManagerEnvironment(cleanRoot);
        for (const directory of directories) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }
        const managerOptions = {
          executable: powershell,
          rootDirectory: cleanRoot,
          environment,
        };
        const runtimeInfo = managedRuntimeInfo(cleanRoot, environment);
        const started = runManager({ ...managerOptions, action: "Start" });
        const managedLog = started.status === 0
          ? ""
          : await readFile(
              path.join(runtimeInfo.runtimeDirectory, "logs", "server.log"),
              "utf8",
            ).catch(() => "<managed log unavailable>");
        assert.equal(
          started.status,
          0,
          `clean managed start failed:\n${diagnostic(started)}\n${managedLog.slice(-maximumDiagnosticCharacters)}`,
        );
        fallbackStop = () =>
          runManager({ ...managerOptions, action: "Stop" });

        managedLiveUrl = `http://127.0.0.1:${port}/api/live`;
        const live = await pollJson(managedLiveUrl);
        assert.equal(live.body.schemaVersion, 1);
        assert.equal(live.body.live, true);
        assert.equal(live.body.service, "mydashboard");
        assert.equal(live.body.managed, true);
        assert.equal(live.body.lifecycleState, "running");
        assert.equal(Number.isInteger(live.body.processId), true);
        managedProcessId = live.body.processId;

        const status = await pollJson(
          `http://127.0.0.1:${port}/api/system/status`,
        );
        assert.equal(status.body.liveness.live, true);
        assert.equal(status.body.readiness.schemaVersion, 1);
        assert.equal(status.body.maintenance.mode, "open");
        assert.equal(Array.isArray(status.body.backups.items), true);

        const dashboard = await pollJson(
          `http://127.0.0.1:${port}/api/dashboard`,
        );
        assert.deepEqual(dashboard.body.meta.errors, []);
        assert.equal(dashboard.body.meta.sources.github, 0);

        const managedStatus = runManager({ ...managerOptions, action: "Status" });
        assert.equal(
          managedStatus.status,
          0,
          `clean managed status failed:\n${diagnostic(managedStatus)}`,
        );
        assert.match(managedStatus.stdout, new RegExp(`PID ${managedProcessId}`));

        const responseText = `${live.text}\n${status.text}\n${dashboard.text}`.toLowerCase();
        for (const privatePath of [
          cleanRoot,
          root,
          process.env.USERPROFILE,
          process.env.HOME,
        ].filter(Boolean)) {
          for (const spelling of [
            privatePath,
            privatePath.replaceAll("\\", "/"),
            privatePath.replaceAll("/", "\\"),
          ]) {
            assert.equal(responseText.includes(spelling.toLowerCase()), false);
          }
        }

        const stopped = fallbackStop();
        assert.equal(
          stopped.status,
          0,
          `clean managed stop failed:\n${diagnostic(stopped)}`,
        );
        assert.match(stopped.stdout, /stopped gracefully/iu);
        fallbackStop = null;
        await waitUntilStopped(managedLiveUrl);
      },
    );
  },
);
