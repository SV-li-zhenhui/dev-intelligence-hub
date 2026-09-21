import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTestKnownCliLocator,
  KnownCliLocator,
  materializeVerifiedCliDescriptor,
  pinGitHubCliDescriptor,
} from "../src/lib/known-cli-locator.js";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}

async function regularFile(file) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "fixture", "utf8");
}

async function nativeExecutable(file) {
  await regularFile(file);
  await chmod(file, 0o755);
}

async function npmCliLayout(root, kind) {
  if (kind === "codex-cli") {
    const packageRoot = path.join(root, "node_modules", "@openai", "codex");
    const nativeRoot = path.join(
      packageRoot,
      "node_modules",
      "@openai",
      "codex-win32-x64",
    );
    await writeJson(path.join(packageRoot, "package.json"), {
      name: "@openai/codex",
      version: "0.147.0",
      bin: { codex: "bin/codex.js" },
      optionalDependencies: {
        "@openai/codex-win32-x64": "npm:@openai/codex@0.147.0-win32-x64",
      },
    });
    await writeJson(path.join(nativeRoot, "package.json"), {
      name: "@openai/codex",
      version: "0.147.0-win32-x64",
      os: ["win32"],
      cpu: ["x64"],
    });
    const executable = path.join(
      nativeRoot,
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    await regularFile(executable);
    return { packageRoot, nativeRoot, executable };
  }

  const packageRoot = path.join(
    root,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
  );
  const nativeRoot = path.join(
    packageRoot,
    "node_modules",
    "@anthropic-ai",
    "claude-code-win32-x64",
  );
  await writeJson(path.join(packageRoot, "package.json"), {
    name: "@anthropic-ai/claude-code",
    version: "2.1.222",
    bin: { claude: "bin/claude.exe" },
    optionalDependencies: {
      "@anthropic-ai/claude-code-win32-x64": "2.1.222",
    },
  });
  await writeJson(path.join(nativeRoot, "package.json"), {
    name: "@anthropic-ai/claude-code-win32-x64",
    version: "2.1.222",
    os: ["win32"],
    cpu: ["x64"],
  });
  const executable = path.join(packageRoot, "bin", "claude.exe");
  await regularFile(executable);
  await regularFile(path.join(nativeRoot, "claude.exe"));
  return { packageRoot, nativeRoot, executable };
}

function windowsLocator(pathValue) {
  return createTestKnownCliLocator({
    pathValue,
    platform: "win32",
    arch: "x64",
  });
}

test("known CLI locator rejects unverified standalone executables", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-direct-");
  for (const [kind, filename] of [
    ["codex-cli", "codex.exe"],
    ["claude-cli", "claude.exe"],
  ]) {
    await regularFile(path.join(directory, filename));
    await assert.rejects(
      windowsLocator(directory).resolve(kind),
      { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
    );
  }
});

test("known CLI locator honors cancellation before package discovery", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-cancelled-");
  const controller = new AbortController();
  const reason = new Error("private discovery cancellation");
  controller.abort(reason);

  await assert.rejects(
    windowsLocator(directory).resolve("codex-cli", {
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
});

test("known CLI locator derives verified native npm package executables", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-npm-");
  const expected = new Map();
  for (const kind of ["codex-cli", "claude-cli"]) {
    expected.set(kind, (await npmCliLayout(directory, kind)).executable);
  }

  const locator = windowsLocator(directory);
  for (const [kind, executable] of expected) {
    const resolved = await locator.resolve(kind);
    assert.deepEqual(resolved, {
      command: executable,
      prefixArgs: [],
    });
    assert.equal(path.isAbsolute(resolved.command), true);
    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(Object.isFrozen(resolved.prefixArgs), true);
  }
});

test("known CLI locator rejects an oversized sparse manifest before parsing", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-large-manifest-");
  const layout = await npmCliLayout(directory, "codex-cli");
  const handle = await open(path.join(layout.packageRoot, "package.json"), "w");
  try {
    await handle.truncate(32 * 1024 * 1024);
  } finally {
    await handle.close();
  }

  await assert.rejects(
    windowsLocator(directory).resolve("codex-cli"),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("known CLI locator enforces tested package version ranges", async (t) => {
  const codexRoot = await temporaryDirectory(t, "known-cli-old-codex-");
  const codex = await npmCliLayout(codexRoot, "codex-cli");
  await writeJson(path.join(codex.packageRoot, "package.json"), {
    name: "@openai/codex",
    version: "0.146.9",
    bin: { codex: "bin/codex.js" },
    optionalDependencies: {
      "@openai/codex-win32-x64": "npm:@openai/codex@0.146.9-win32-x64",
    },
  });
  await writeJson(path.join(codex.nativeRoot, "package.json"), {
    name: "@openai/codex",
    version: "0.146.9-win32-x64",
    os: ["win32"],
    cpu: ["x64"],
  });
  await assert.rejects(
    windowsLocator(codexRoot).resolve("codex-cli"),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );

  const futureCodexRoot = await temporaryDirectory(t, "known-cli-future-codex-");
  const futureCodex = await npmCliLayout(futureCodexRoot, "codex-cli");
  await writeJson(path.join(futureCodex.packageRoot, "package.json"), {
    name: "@openai/codex",
    version: "0.152.0",
    bin: { codex: "bin/codex.js" },
    optionalDependencies: {
      "@openai/codex-win32-x64": "npm:@openai/codex@0.152.0-win32-x64",
    },
  });
  await writeJson(path.join(futureCodex.nativeRoot, "package.json"), {
    name: "@openai/codex",
    version: "0.152.0-win32-x64",
    os: ["win32"],
    cpu: ["x64"],
  });
  await assert.rejects(
    windowsLocator(futureCodexRoot).resolve("codex-cli"),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );

  const futureMinorClaudeRoot = await temporaryDirectory(
    t,
    "known-cli-future-minor-claude-",
  );
  const futureMinorClaude = await npmCliLayout(
    futureMinorClaudeRoot,
    "claude-cli",
  );
  await writeJson(path.join(futureMinorClaude.packageRoot, "package.json"), {
    name: "@anthropic-ai/claude-code",
    version: "2.2.0",
    bin: { claude: "bin/claude.exe" },
    optionalDependencies: {
      "@anthropic-ai/claude-code-win32-x64": "2.2.0",
    },
  });
  await writeJson(path.join(futureMinorClaude.nativeRoot, "package.json"), {
    name: "@anthropic-ai/claude-code-win32-x64",
    version: "2.2.0",
    os: ["win32"],
    cpu: ["x64"],
  });
  await assert.rejects(
    windowsLocator(futureMinorClaudeRoot).resolve("claude-cli"),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );

  const claudeRoot = await temporaryDirectory(t, "known-cli-future-claude-");
  const claude = await npmCliLayout(claudeRoot, "claude-cli");
  await writeJson(path.join(claude.packageRoot, "package.json"), {
    name: "@anthropic-ai/claude-code",
    version: "3.0.0",
    bin: { claude: "bin/claude.exe" },
    optionalDependencies: {
      "@anthropic-ai/claude-code-win32-x64": "3.0.0",
    },
  });
  await writeJson(path.join(claude.nativeRoot, "package.json"), {
    name: "@anthropic-ai/claude-code-win32-x64",
    version: "3.0.0",
    os: ["win32"],
    cpu: ["x64"],
  });
  await assert.rejects(
    windowsLocator(claudeRoot).resolve("claude-cli"),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("known CLI locator accepts the validated Codex 0.151 line", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-codex-0151-");
  const layout = await npmCliLayout(directory, "codex-cli");
  await writeJson(path.join(layout.packageRoot, "package.json"), {
    name: "@openai/codex",
    version: "0.151.0",
    bin: { codex: "bin/codex.js" },
    optionalDependencies: {
      "@openai/codex-win32-x64": "npm:@openai/codex@0.151.0-win32-x64",
    },
  });
  await writeJson(path.join(layout.nativeRoot, "package.json"), {
    name: "@openai/codex",
    version: "0.151.0-win32-x64",
    os: ["win32"],
    cpu: ["x64"],
  });

  const resolved = await windowsLocator(directory).resolve("codex-cli");
  assert.equal(resolved.command, layout.executable);
});

test("known CLI locator rejects unsupported IDs, relative roots, and command shims", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-closed-");
  await regularFile(path.join(directory, "codex.cmd"));
  await regularFile(path.join(directory, "claude.ps1"));

  for (const [locator, kind] of [
    [windowsLocator(directory), "shell-cli"],
    [windowsLocator("relative-path-entry"), "codex-cli"],
    [windowsLocator(directory), "codex-cli"],
    [windowsLocator(directory), "claude-cli"],
  ]) {
    await assert.rejects(
      locator.resolve(kind),
      (error) =>
        error?.code === "STRUCTURED_PROVIDER_UNAVAILABLE" &&
        !error.message.includes(directory) &&
        !error.message.includes(kind),
    );
  }
});

test("known CLI locator rejects malformed npm package identities", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-identity-");
  const { packageRoot } = await npmCliLayout(directory, "codex-cli");
  const packageFile = path.join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(packageFile, "utf8"));
  manifest.name = "@attacker/codex";
  await writeFile(packageFile, JSON.stringify(manifest), "utf8");

  await assert.rejects(
    windowsLocator(directory).resolve("codex-cli"),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("known CLI locator rejects symlinked package paths", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-symlink-");
  const npmTarget = path.join(directory, "npm-target");
  const npmLink = path.join(directory, "npm-link");
  await npmCliLayout(npmTarget, "claude-cli");
  await symlink(
    npmTarget,
    npmLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    windowsLocator(npmLink).resolve("claude-cli"),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("known CLI locator discovers project-local .bin and hoisted native packages", async (t) => {
  const project = await temporaryDirectory(t, "known-cli-project-local-");
  const expected = new Map();
  for (const kind of ["codex-cli", "claude-cli"]) {
    const layout = await npmCliLayout(project, kind);
    const packageName = kind === "codex-cli"
      ? "codex-win32-x64"
      : "claude-code-win32-x64";
    const hoistedRoot = path.join(
      project,
      "node_modules",
      kind === "codex-cli" ? "@openai" : "@anthropic-ai",
      packageName,
    );
    await rename(layout.nativeRoot, hoistedRoot);
    if (kind === "codex-cli") {
      const relativeExecutable = path.relative(
        layout.nativeRoot,
        layout.executable,
      );
      expected.set(kind, path.join(hoistedRoot, relativeExecutable));
    } else {
      expected.set(kind, layout.executable);
    }
  }
  const binDirectory = path.join(project, "node_modules", ".bin");
  await mkdir(binDirectory, { recursive: true });

  const locator = windowsLocator(binDirectory);
  for (const [kind, executable] of expected) {
    assert.equal((await locator.resolve(kind)).command, executable);
  }
});

test("verified CLI descriptors reject forgery and executable replacement", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-revalidate-");
  const layout = await npmCliLayout(directory, "codex-cli");
  const descriptor = await windowsLocator(directory).resolve("codex-cli");

  const materialized = await materializeVerifiedCliDescriptor(descriptor);
  assert.equal(materialized.command, layout.executable);
  assert.deepEqual(materialized.prefixArgs, []);
  assert.match(materialized.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    materializeVerifiedCliDescriptor({
      command: layout.executable,
      prefixArgs: [],
    }),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );

  await writeFile(layout.executable, "replacement fixture", "utf8");
  await assert.rejects(
    materializeVerifiedCliDescriptor(descriptor),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("verified descriptors rehash same-size replacements with restored metadata", async (t) => {
  const directory = await temporaryDirectory(t, "known-cli-rehash-");
  const layout = await npmCliLayout(directory, "codex-cli");
  const fixedTime = new Date("2026-08-08T01:02:03.000Z");
  await utimes(layout.executable, fixedTime, fixedTime);
  const descriptor = await windowsLocator(directory).resolve("codex-cli");

  await writeFile(layout.executable, "changed", "utf8");
  await utimes(layout.executable, fixedTime, fixedTime);

  await assert.rejects(
    materializeVerifiedCliDescriptor(descriptor),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("pinned GitHub CLI descriptors accept only the fixed native executable identity", async (t) => {
  const directory = await temporaryDirectory(t, "known-gh-cli-");
  const filename = process.platform === "win32" ? "gh.exe" : "gh";
  const executable = path.join(directory, filename);
  await nativeExecutable(executable);

  const descriptor = await pinGitHubCliDescriptor(executable);
  assert.deepEqual(descriptor, { command: executable, prefixArgs: [] });
  assert.match(
    (await materializeVerifiedCliDescriptor(descriptor)).sha256,
    /^[a-f0-9]{64}$/,
  );

  await assert.rejects(
    pinGitHubCliDescriptor(path.join(directory, "gh-wrapper.exe")),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  await assert.rejects(
    pinGitHubCliDescriptor(filename),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("pinned GitHub CLI descriptors reject links, aliases, and replacement", async (t) => {
  const directory = await temporaryDirectory(t, "known-gh-cli-identity-");
  const filename = process.platform === "win32" ? "gh.exe" : "gh";
  const executable = path.join(directory, filename);
  await nativeExecutable(executable);
  const descriptor = await pinGitHubCliDescriptor(executable);

  const alias = path.join(directory, `alias-${filename}`);
  await link(executable, alias);
  await assert.rejects(
    materializeVerifiedCliDescriptor(descriptor),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
  await rm(alias);

  const targetDirectory = path.join(directory, "target");
  const linkedDirectory = path.join(directory, "linked");
  await mkdir(targetDirectory);
  await nativeExecutable(path.join(targetDirectory, filename));
  await symlink(
    targetDirectory,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    pinGitHubCliDescriptor(path.join(linkedDirectory, filename)),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );

  await writeFile(executable, "replaced", "utf8");
  await assert.rejects(
    materializeVerifiedCliDescriptor(descriptor),
    { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
  );
});

test("known CLI locator authority is immutable after construction", async (t) => {
  const originalRoot = await temporaryDirectory(t, "known-cli-fixed-root-");
  const redirectedRoot = await temporaryDirectory(t, "known-cli-redirect-root-");
  await npmCliLayout(originalRoot, "codex-cli");
  const redirected = await npmCliLayout(redirectedRoot, "codex-cli");
  const locator = windowsLocator(originalRoot);

  assert.equal(Object.isFrozen(locator), true);
  assert.throws(() => {
    locator.searchRoots = [redirectedRoot];
  }, TypeError);
  assert.notEqual(
    (await locator.resolve("codex-cli")).command,
    redirected.executable,
  );
  assert.throws(
    () => new KnownCliLocator({
      pathValue: redirectedRoot,
      platform: "win32",
      arch: "x64",
    }),
    /Production CLI locator.*replacement dependencies/,
  );
});

test("the first supervised CLI release fails closed outside Windows x64", async () => {
  for (const [platform, arch] of [
    ["win32", "arm64"],
    ["linux", "x64"],
    ["darwin", "x64"],
  ]) {
    const locator = createTestKnownCliLocator({
      pathValue: path.parse(process.cwd()).root,
      platform,
      arch,
    });
    await assert.rejects(
      locator.resolve("codex-cli"),
      { code: "STRUCTURED_PROVIDER_UNAVAILABLE" },
    );
  }
});
