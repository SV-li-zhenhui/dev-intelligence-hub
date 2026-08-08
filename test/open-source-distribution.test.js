import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
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
let trackedIndexEntries;

const trackedBlobModes = new Set(["100644", "100755", "120000"]);
const trackedPathDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

function runGitIn(
  repositoryRoot,
  arguments_,
  {
    encoding = arguments_.includes("-z") ? "buffer" : "utf8",
    input,
    timeout = 60_000,
    maxBuffer = 128 * 1024 * 1024,
  } = {},
) {
  return spawnSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding,
    ...(input === undefined ? {} : { input }),
    timeout,
    windowsHide: true,
    maxBuffer,
  });
}

function runGit(arguments_, timeout = 60_000) {
  return runGitIn(root, arguments_, { timeout });
}

function invalidTrackedIndex() {
  return new Error("invalid tracked Git index");
}

function parseTrackedIndexEntries(source) {
  if (!Buffer.isBuffer(source)) throw invalidTrackedIndex();
  const entries = [];
  const seenPaths = new Set();
  let offset = 0;
  while (offset < source.length) {
    const end = source.indexOf(0, offset);
    if (end < 0 || end === offset) throw invalidTrackedIndex();
    const record = source.subarray(offset, end);
    const separator = record.indexOf(9);
    if (separator <= 0 || separator === record.length - 1) {
      throw invalidTrackedIndex();
    }
    const metadata = record.subarray(0, separator).toString("ascii").match(
      /^H (100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u,
    );
    if (
      metadata === null ||
      metadata[3] !== "0" ||
      !trackedBlobModes.has(metadata[1])
    ) {
      throw invalidTrackedIndex();
    }
    let filePath;
    try {
      filePath = trackedPathDecoder.decode(record.subarray(separator + 1));
    } catch {
      throw invalidTrackedIndex();
    }
    if (
      filePath.length === 0 ||
      path.posix.isAbsolute(filePath) ||
      filePath.includes("\\") ||
      path.posix.normalize(filePath) !== filePath ||
      filePath === ".." ||
      filePath.startsWith("../") ||
      seenPaths.has(filePath)
    ) {
      throw invalidTrackedIndex();
    }
    seenPaths.add(filePath);
    entries.push({ mode: metadata[1], oid: metadata[2], filePath });
    offset = end + 1;
  }
  return entries;
}

function loadTrackedIndexEntries(repositoryRoot) {
  const listed = runGitIn(
    repositoryRoot,
    ["ls-files", "--stage", "-v", "-z"],
    { encoding: "buffer" },
  );
  assert.equal(listed.status, 0, "could not list tracked Git index");
  return parseTrackedIndexEntries(listed.stdout);
}

function parseBlobBatch(source, expectedObjectIds) {
  if (!Buffer.isBuffer(source)) throw new Error("invalid tracked Git object batch");
  const blobs = new Map();
  let offset = 0;
  for (const expectedObjectId of expectedObjectIds) {
    const headerEnd = source.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("invalid tracked Git object batch");
    const header = source.subarray(offset, headerEnd).toString("ascii").match(
      /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u,
    );
    const size = header === null ? Number.NaN : Number(header[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (
      header === null ||
      header[1] !== expectedObjectId ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      contentEnd >= source.length ||
      source[contentEnd] !== 10
    ) {
      throw new Error("invalid tracked Git object batch");
    }
    blobs.set(expectedObjectId, Buffer.from(source.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  if (offset !== source.length) throw new Error("invalid tracked Git object batch");
  return blobs;
}

function readTrackedBlobs(repositoryRoot, entries) {
  const objectIds = [...new Set(entries.map(({ oid }) => oid))];
  if (objectIds.length === 0) return new Map();
  const read = runGitIn(repositoryRoot, ["cat-file", "--batch"], {
    encoding: "buffer",
    input: Buffer.from(`${objectIds.join("\n")}\n`, "ascii"),
  });
  assert.equal(read.status, 0, "could not read tracked Git objects");
  return parseBlobBatch(read.stdout, objectIds);
}

function loadTrackedFiles() {
  if (trackedFiles) return trackedFiles;
  trackedIndexEntries ||= loadTrackedIndexEntries(root);
  trackedFiles = new Set(trackedIndexEntries.map(({ filePath }) => filePath));
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

const fakeCredentialMarkerPrefix = "PRIVACY_FAKE_CREDENTIAL_SHA256:";
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
const quotedPersonalIdentifier = /(["'`])\d{12,20}\1/gu;
const pullRequestIdentity = /\b[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*#\d+\b/gu;

function normalizedComparableText(value) {
  return value.replaceAll("\\", "/").toLowerCase();
}

function isPortableRepositoryIdentity(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(
    value,
  );
}

function collectCandidateIdentityStrings(value, collected = []) {
  if (typeof value === "string") {
    collected.push(value);
    return collected;
  }
  if (value === null || typeof value !== "object") return collected;
  for (const [key, entry] of Object.entries(value)) {
    collected.push(key);
    collectCandidateIdentityStrings(entry, collected);
  }
  return collected;
}

async function optionalLocalPrivacyDenylist() {
  const denied = new Set([
    normalizedComparableText(root),
    ...[process.env.USERPROFILE, process.env.HOME]
      .filter(Boolean)
      .map(normalizedComparableText),
  ]);

  for (const fileName of ["config.json", "config.local.json"]) {
    try {
      const configuration = JSON.parse(await readFile(path.join(root, fileName), "utf8"));
      for (const value of collectCandidateIdentityStrings(configuration)) {
        if (path.isAbsolute(value) || isPortableRepositoryIdentity(value)) {
          denied.add(normalizedComparableText(value));
        }
      }
    } catch {
      // Missing or invalid private configuration never weakens credential scanning.
    }
  }

  try {
    const ledger = await readFile(
      path.join(
        root,
        ".superpowers",
        "sdd",
        "2026-08-02-001-feat-complete-command-center-plan",
        "owner-acceptance-gates.local.md",
      ),
      "utf8",
    );
    for (const match of ledger.matchAll(pullRequestIdentity)) {
      denied.add(normalizedComparableText(match[0]));
      denied.add(normalizedComparableText(match[0].split("#", 1)[0]));
    }
  } catch {
    // The owner-only local ledger is intentionally optional in public exports.
  }

  return denied;
}

function hasAdjacentFakeCredentialMarker(text, match, consumedMarkers) {
  const matchIndex = match.index;
  const currentLineStart = text.lastIndexOf("\n", matchIndex) + 1;
  if (currentLineStart === 0) return false;
  const previousLineEnd = currentLineStart - 1;
  const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
  const marker = text.slice(previousLineStart, previousLineEnd).trim().match(
    new RegExp(`^// ${fakeCredentialMarkerPrefix}([0-9a-f]{64})$`, "u"),
  );
  if (!marker || consumedMarkers.has(previousLineStart)) return false;
  const digest = createHash("sha256").update(match[0], "utf8").digest("hex");
  if (marker[1] !== digest) return false;
  consumedMarkers.add(previousLineStart);
  return true;
}

function assertSafePrivacyValue({
  value,
  denied,
  subject,
  credentialMatchIsAllowed = () => false,
}) {
  for (const pattern of credentialPatterns) {
    for (const match of value.matchAll(pattern)) {
      assert.equal(
        credentialMatchIsAllowed(match),
        true,
        `a ${subject} contains an unmarked credential-shaped value`,
      );
    }
  }
  for (const pattern of userHomePatterns) {
    assert.doesNotMatch(value, pattern, `a ${subject} contains a user-home path`);
  }
  assert.doesNotMatch(
    value,
    quotedPersonalIdentifier,
    `a ${subject} contains a quoted personal identifier`,
  );

  const comparableValue = normalizedComparableText(value);
  for (const identifier of denied) {
    assert.equal(
      comparableValue.includes(identifier),
      false,
      `a ${subject} contains a private local identity`,
    );
  }
}

function assertSafeTrackedText({ filePath, source, denied }) {
  if (source.includes(0)) {
    throw new Error("NUL-bearing tracked Git blob cannot be privacy-scanned");
  }
  assertSafePrivacyValue({
    value: filePath,
    denied,
    subject: "tracked path",
  });

  const text = source.toString("utf8");
  const consumedFakeCredentialMarkers = new Set();
  assertSafePrivacyValue({
    value: text,
    denied,
    subject: "tracked text file",
    credentialMatchIsAllowed: (match) =>
      filePath.startsWith("test/") &&
      hasAdjacentFakeCredentialMarker(
        text,
        match,
        consumedFakeCredentialMarkers,
      ),
  });
}

function assertSafeTrackedGitTree({
  repositoryRoot,
  denied,
  selectedPaths = null,
}) {
  const clean = runGitIn(
    repositoryRoot,
    ["diff", "--quiet", "HEAD", "--"],
  );
  assert.equal(clean.status, 0, "tracked content differs from HEAD");

  const entries = repositoryRoot === root && trackedIndexEntries
    ? trackedIndexEntries
    : loadTrackedIndexEntries(repositoryRoot);
  if (repositoryRoot === root) trackedIndexEntries = entries;
  const selected = selectedPaths === null ? null : new Set(selectedPaths);
  const scannedEntries = selected === null
    ? entries
    : entries.filter(({ filePath }) => selected.has(filePath));
  if (selected !== null && scannedEntries.length !== selected.size) {
    throw new Error("tracked privacy selection is incomplete");
  }
  const blobs = readTrackedBlobs(repositoryRoot, scannedEntries);
  for (const { filePath, oid } of scannedEntries) {
    const source = blobs.get(oid);
    if (!source) throw new Error("tracked Git object is unavailable");
    assertSafeTrackedText({ filePath, source, denied });
  }
}

async function materializeTrackedFiles({
  repositoryRoot,
  destinationRoot,
  filePaths,
}) {
  const selected = new Set(filePaths);
  const entries = repositoryRoot === root && trackedIndexEntries
    ? trackedIndexEntries
    : loadTrackedIndexEntries(repositoryRoot);
  if (repositoryRoot === root) trackedIndexEntries = entries;
  const selectedEntries = entries.filter(({ filePath }) =>
    selected.has(filePath)
  );
  if (selectedEntries.length !== selected.size) {
    throw new Error("clean-room tracked input selection is incomplete");
  }
  if (selectedEntries.some(({ mode }) => mode === "120000")) {
    throw new Error("clean-room inputs must be regular tracked files");
  }
  const blobs = readTrackedBlobs(repositoryRoot, selectedEntries);
  for (const { filePath, mode, oid } of selectedEntries) {
    const source = blobs.get(oid);
    if (!source) throw new Error("clean-room tracked object is unavailable");
    const destination = localPath(destinationRoot, filePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, {
      mode: mode === "100755" ? 0o755 : 0o644,
    });
  }
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
  assertSafeTrackedGitTree({
    repositoryRoot: root,
    denied: await optionalLocalPrivacyDenylist(),
    selectedPaths: loadDistributionManifest(),
  });
});

test("whole tracked Git tree contains no private identifiers or credentials", async () => {
  assertSafeTrackedGitTree({
    repositoryRoot: root,
    denied: await optionalLocalPrivacyDenylist(),
  });
});

test("privacy scanner rejects unmarked synthetic credentials and permits marked test fixtures", () => {
  const syntheticCredential = ["sk", "live", "synthetic", "credential", "only", "for", "scanner"].join("-");
  const secondSyntheticCredential = ["sk", "live", "second", "synthetic", "credential", "for", "scanner"].join("-");
  const syntheticCredentialMarker = `${fakeCredentialMarkerPrefix}11c972c4d7167c096da8aa045a157509a7f04cf84e340ff809b230908f25e422`;
  const denied = new Set();
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "test/unmarked-fixture.test.js",
        source: Buffer.from(`const value = \"${syntheticCredential}\";`),
        denied,
      }),
    /unmarked credential-shaped value/u,
  );
  assert.doesNotThrow(() =>
    assertSafeTrackedText({
      filePath: "test/marked-fixture.test.js",
      source: Buffer.from(
        `// ${syntheticCredentialMarker}\nconst value = \"${syntheticCredential}\";`,
      ),
      denied,
    }),
  );
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "test/marked-plus-unmarked-fixture.test.js",
        source: Buffer.from(
          `// ${syntheticCredentialMarker}\nconst first = \"${syntheticCredential}\"; const second = \"${secondSyntheticCredential}\";`,
        ),
        denied,
      }),
    /unmarked credential-shaped value/u,
  );
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "test/non-adjacent-fixture.test.js",
        source: Buffer.from(
          `// ${syntheticCredentialMarker}\n\nconst value = \"${syntheticCredential}\";`,
        ),
        denied,
      }),
    /unmarked credential-shaped value/u,
  );
});

test("whole tracked privacy fails closed for NUL-bearing blobs", () => {
  const syntheticCredential = [
    "sk",
    "utf16",
    "credential",
    "must",
    "not",
    "bypass",
    "privacy",
  ].join("-");

  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: "docs/encoded-credential.md",
        source: Buffer.from(syntheticCredential, "utf16le"),
        denied: new Set(),
      }),
    /NUL-bearing tracked Git blob cannot be privacy-scanned/u,
  );
});

test("whole tracked privacy applies the same policy to tracked path names", () => {
  const syntheticCredential = [
    "sk",
    "path",
    "credential",
    "must",
    "not",
    "bypass",
    "privacy",
  ].join("-");
  const deniedRepositoryIdentity = [
    "private-owner",
    "private-repository",
  ].join("/");
  const fixtures = [
    {
      filePath: `docs/${syntheticCredential}.md`,
      denied: new Set(),
      expected: /tracked path contains an unmarked credential-shaped value/u,
    },
    {
      filePath: `${deniedRepositoryIdentity}/notes.md`,
      denied: new Set([deniedRepositoryIdentity]),
      expected: /tracked path contains a private local identity/u,
    },
  ];

  for (const fixture of fixtures) {
    assert.throws(
      () =>
        assertSafeTrackedText({
          filePath: fixture.filePath,
          source: Buffer.from("portable safe body\n"),
          denied: fixture.denied,
        }),
      fixture.expected,
    );
  }
});

test("tracked index parsing rejects unsafe metadata and path encoding", () => {
  const oid = "a".repeat(40);
  assert.deepEqual(
    parseTrackedIndexEntries(Buffer.from(`H 100644 ${oid} 0\ttest/safe.js\0`)),
    [{ mode: "100644", oid, filePath: "test/safe.js" }],
  );
  const bomPath = Buffer.concat([
    Buffer.from(`H 100644 ${oid} 0\t`),
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("test/not-a-test-fixture.js\0"),
  ]);
  const [decodedBomPath] = parseTrackedIndexEntries(bomPath);
  assert.equal(decodedBomPath.filePath, "\ufefftest/not-a-test-fixture.js");
  assert.equal(decodedBomPath.filePath.startsWith("test/"), false);

  for (const source of [
    Buffer.from(`H 100644 ${oid} 1\ttest/conflicted.js\0`),
    Buffer.from(`H 160000 ${oid} 0\tunsupported-submodule\0`),
    Buffer.from(`S 100644 ${oid} 0\tskip-worktree.js\0`),
    Buffer.from(`h 100644 ${oid} 0\tassume-unchanged.js\0`),
    Buffer.from(`H 100644 ${"a".repeat(39)} 0\tinvalid-object-id\0`),
    Buffer.concat([
      Buffer.from(`H 100644 ${oid} 0\tinvalid-`),
      Buffer.from([0xff, 0]),
    ]),
  ]) {
    assert.throws(
      () => parseTrackedIndexEntries(source),
      /invalid tracked Git index/u,
    );
  }
});

test("tracked symlink privacy scans its Git blob without reading an external target", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "privacy-git-fixture-"));
  const externalRoot = await mkdtemp(
    path.join(tmpdir(), "privacy-external-fixture-"),
  );
  context.after(async () => {
    assert.equal(path.dirname(fixtureRoot), path.resolve(tmpdir()));
    assert.equal(path.dirname(externalRoot), path.resolve(tmpdir()));
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  });

  const syntheticCredential = [
    "sk",
    "symlink",
    "blob",
    "must",
    "be",
    "scanned",
  ].join("-");
  const externalFile = path.join(externalRoot, syntheticCredential);
  const externalTarget = path.relative(fixtureRoot, externalFile)
    .replaceAll("\\", "/");
  await writeFile(externalFile, "safe external target content\n");

  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Privacy Fixture"],
    ["config", "user.email", "privacy-fixture@example.invalid"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  const stored = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: fixtureRoot,
    input: Buffer.from(externalTarget, "utf8"),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(stored.status, 0, "synthetic symlink blob creation failed");
  const symlinkOid = stored.stdout.trim();
  assert.match(symlinkOid, /^[0-9a-f]{40,64}$/u);
  for (const arguments_ of [
    ["update-index", "--add", "--cacheinfo", `120000,${symlinkOid},tracked-link`],
    ["commit", "--quiet", "-m", "synthetic symlink fixture"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  const trackedLink = path.join(fixtureRoot, "tracked-link");
  await symlink(
    externalRoot,
    trackedLink,
    process.platform === "win32" ? "junction" : "dir",
  );
  const entries = loadTrackedIndexEntries(fixtureRoot);
  const blobs = readTrackedBlobs(fixtureRoot, entries);
  const link = entries.find(({ filePath }) => filePath === "tracked-link");
  assert.ok(link);
  assert.throws(
    () =>
      assertSafeTrackedText({
        filePath: link.filePath,
        source: blobs.get(link.oid),
        denied: new Set(),
      }),
    /unmarked credential-shaped value/u,
  );
  const cleanOutput = path.join(fixtureRoot, "clean-output");
  await assert.rejects(
    materializeTrackedFiles({
      repositoryRoot: fixtureRoot,
      destinationRoot: cleanOutput,
      filePaths: ["tracked-link"],
    }),
    /regular tracked files/u,
  );
  assert.equal(existsSync(path.join(cleanOutput, "tracked-link")), false);
  assert.equal(
    await readFile(externalFile, "utf8"),
    "safe external target content\n",
  );
});

test("whole tracked Git privacy fails closed for dirty tracked content", async (context) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "privacy-dirty-fixture-"));
  context.after(async () => {
    assert.equal(path.dirname(fixtureRoot), path.resolve(tmpdir()));
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  for (const arguments_ of [
    ["init", "--quiet"],
    ["config", "user.name", "Privacy Fixture"],
    ["config", "user.email", "privacy-fixture@example.invalid"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  await writeFile(path.join(fixtureRoot, "tracked.txt"), "safe content\n");
  for (const arguments_ of [
    ["add", "tracked.txt"],
    ["commit", "--quiet", "-m", "synthetic clean fixture"],
  ]) {
    const result = spawnSync("git", arguments_, {
      cwd: fixtureRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, "synthetic Git fixture setup failed");
  }
  const dirtyCredential = [
    "sk",
    "dirty",
    "tracked",
    "content",
    "must",
    "not",
    "bypass",
  ].join("-");
  await writeFile(
    path.join(fixtureRoot, "tracked.txt"),
    `${dirtyCredential}\n`,
  );

  assert.throws(
    () =>
      assertSafeTrackedGitTree({
        repositoryRoot: fixtureRoot,
        denied: new Set(),
      }),
    /tracked content differs from HEAD/u,
  );
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
    }
    await materializeTrackedFiles({
      repositoryRoot: root,
      destinationRoot: cleanRoot,
      filePaths: sourceFiles,
    });

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
