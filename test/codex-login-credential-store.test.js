import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProductionCodexLoginCredentialStore,
  createTestCodexLoginCredentialStore,
  productionCodexLoginLocations,
} from "../src/lib/codex-login-credential-store.js";

const CREDENTIAL_LIMIT = 65_536;
const ENVELOPE_LIMIT = 192 * 1024;
const ENVELOPE_NAME = "credential.json";
const NOW = "2026-08-11T08:30:00.000Z";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureLocations(root) {
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "codex-home");
  const mirrorRoot = path.join(home, ".mydashboard-cli-credentials-v1");
  return {
    sourceFile: path.join(sourceRoot, "auth.json"),
    mirrorRoot,
    mirrorDirectory: path.join(mirrorRoot, "codex-login"),
    probeRoot: path.join(home, ".mydashboard-codex-login-probe-v1"),
  };
}

function directoryIdentity(directory, index = 1) {
  return Object.freeze({
    path: directory,
    device: "7",
    inode: String(index),
  });
}

function privateKey(directory, name) {
  return `${directory.path}\n${name}`;
}

function createHarness(root, source = Buffer.from("fictional-source-generation-one")) {
  const locations = fixtureLocations(root);
  const privateFiles = new Map();
  const temporaryFiles = new Map();
  const replacementEvents = [];
  const calls = [];
  let sourceBytes = Buffer.from(source);
  let sourceFailure = null;
  let nextFailure = null;
  let nextHold = null;
  const identities = new Map();
  const manager = {
    prepareCalls: [],
    validationCalls: 0,
  };
  const privateDirectoryManager = {
    async prepare({ directory, signal, validateLocation }) {
      assert.equal(signal instanceof AbortSignal, true);
      manager.prepareCalls.push(directory);
      manager.validationCalls += 1;
      await validateLocation();
      manager.validationCalls += 1;
      await validateLocation();
      if (!identities.has(directory)) {
        identities.set(directory, directoryIdentity(directory, identities.size + 1));
      }
      return identities.get(directory);
    },
  };

  function failure(method) {
    if (nextFailure?.method !== method) return null;
    const selected = nextFailure;
    nextFailure = null;
    return selected;
  }

  async function waitAtHold(method) {
    if (nextHold?.method !== method) return;
    const selected = nextHold;
    nextHold = null;
    selected.enteredResolve();
    await selected.released;
  }

  const filePort = {
    async readSource(options) {
      calls.push(["readSource", options.file, options.maximumBytes]);
      const selected = failure("readSource");
      if (selected) throw selected.error;
      if (sourceFailure) throw sourceFailure;
      return Buffer.from(sourceBytes);
    },
    async readPrivate(options) {
      calls.push(["readPrivate", options.directory.path, options.name, options.maximumBytes]);
      const selected = failure("readPrivate");
      if (selected) throw selected.error;
      const bytes = privateFiles.get(privateKey(options.directory, options.name));
      if (bytes === undefined) {
        if (options.required) throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
        return null;
      }
      return Buffer.from(bytes);
    },
    async writeNewPrivate(options) {
      calls.push(["writeNewPrivate", options.directory.path, options.name, options.bytes.length]);
      const selected = failure("writeNewPrivate");
      if (selected) throw selected.error;
      const key = privateKey(options.directory, options.name);
      if (privateFiles.has(key)) throw new Error("fixture target exists");
      privateFiles.set(key, Buffer.from(options.bytes));
    },
    async replacePrivate(options) {
      calls.push(["replacePrivate", options.directory.path, options.name, options.bytes.length]);
      await waitAtHold("replacePrivate");
      const selected = failure("replacePrivate");
      const key = privateKey(options.directory, options.name);
      if (!privateFiles.has(key)) throw new Error("fixture target missing");
      const phase = selected?.phase ?? "SUCCESS";
      const temporaryKey = `${key}\ntemporary`;
      const requested = Buffer.from(options.bytes);
      if (phase === "IDENTITY_REPLACEMENT") {
        replacementEvents.push([phase, "identity-check"]);
        throw selected.error;
      }
      const partialLength = Math.max(1, Math.floor(requested.length / 2));
      temporaryFiles.set(temporaryKey, requested.subarray(0, partialLength));
      replacementEvents.push([phase, "temporary-write"]);
      if (phase === "TEMPORARY_WRITE") {
        temporaryFiles.delete(temporaryKey);
        throw selected.error;
      }
      temporaryFiles.set(temporaryKey, requested);
      replacementEvents.push([phase, "flush"]);
      if (phase === "FLUSH") {
        temporaryFiles.delete(temporaryKey);
        throw selected.error;
      }
      replacementEvents.push([phase, "pre-commit-replace"]);
      if (phase === "PRE_COMMIT_REPLACE") {
        temporaryFiles.delete(temporaryKey);
        throw selected.error;
      }
      privateFiles.set(key, requested);
      temporaryFiles.delete(temporaryKey);
      replacementEvents.push([phase, "commit"]);
      replacementEvents.push([phase, "final-verify"]);
      if (phase === "FINAL_VERIFY") throw selected.error;
    },
    async removePrivate(options) {
      calls.push(["removePrivate", options.directory.path, options.name]);
      const selected = failure("removePrivate");
      if (selected) throw selected.error;
      privateFiles.delete(privateKey(options.directory, options.name));
    },
  };

  const dependencies = {
    async canonicalizePath(candidate) { return path.resolve(candidate); },
    filePort,
    privateDirectoryManager,
  };
  const options = {
    locations,
    protectedRoots: [path.join(root, "repository"), path.join(root, "data")],
    now: () => new Date(NOW),
  };

  return {
    calls,
    dependencies,
    filePort,
    locations,
    manager,
    options,
    privateFiles,
    replacementEvents,
    temporaryFiles,
    createStore(overrides = {}) {
      return createTestCodexLoginCredentialStore({ ...options, ...overrides }, dependencies);
    },
    envelopeBytes() {
      const identity = directoryIdentity(locations.mirrorDirectory, 2);
      return privateFiles.get(privateKey(identity, ENVELOPE_NAME));
    },
    privateBytes(directory, name = "auth.json") {
      return privateFiles.get(privateKey(directory, name));
    },
    setPrivate(directory, bytes, name = "auth.json") {
      privateFiles.set(privateKey(directory, name), Buffer.from(bytes));
    },
    setSource(bytes) {
      sourceBytes = Buffer.from(bytes);
      sourceFailure = null;
    },
    failSource(code, marker = "FICTIONAL_SOURCE_FAILURE_PRIVATE") {
      sourceFailure = Object.assign(new Error(marker), { code });
    },
    failNext(method, phase) {
      nextFailure = {
        method,
        phase,
        error: Object.assign(new Error(`FICTIONAL_${phase}_PRIVATE`), {
          code: `FICTIONAL_${phase}`,
          path: locations.mirrorDirectory,
        }),
      };
    },
    holdNext(method) {
      let enteredResolve;
      let releaseResolve;
      const entered = new Promise((resolve) => { enteredResolve = resolve; });
      const released = new Promise((resolve) => { releaseResolve = resolve; });
      nextHold = { method, enteredResolve, released };
      return { entered, release: releaseResolve };
    },
  };
}

function parseEnvelope(bytes) {
  return JSON.parse(bytes.toString("utf8"));
}

function serializedError(error) {
  return JSON.stringify({
    message: error?.message,
    code: error?.code,
    stack: error?.stack,
    fields: Object.fromEntries(Object.entries(error || {})),
  });
}

function assertRedacted(error, expectedCode, markers) {
  const serialized = serializedError(error);
  assert.equal(error?.code, expectedCode);
  assert.equal(markers.every((marker) => !serialized.includes(marker)), true, serialized);
  return true;
}

function secrecyMarkers(current, credentials, codexHomes = []) {
  return [
    ...credentials.flatMap((bytes) => [
      bytes.toString("utf8"),
      bytes.toString("base64"),
      sha256(bytes),
    ]),
    current.locations.sourceFile,
    current.locations.mirrorRoot,
    current.locations.mirrorDirectory,
    current.locations.probeRoot,
    ...codexHomes.map(({ path: directory }) => directory),
  ];
}

function assertSnapshotRedacted(snapshot, markers) {
  const reflected = JSON.stringify({
    descriptors: Object.getOwnPropertyDescriptors(snapshot),
    extensible: Object.isExtensible(snapshot),
    frozen: Object.isFrozen(snapshot),
    keys: Reflect.ownKeys(snapshot).map(String),
    prototype: Object.getPrototypeOf(snapshot),
  });
  assert.equal(markers.every((marker) => !reflected.includes(marker)), true, reflected);
}

test("production locations keep login state under the project-scoped private runtime", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-codex-store-locations-"));
  const home = path.join(root, "home");
  const codexRoot = path.join(root, "codex-home");
  const localAppData = path.join(root, "local-app-data");
  await mkdir(home);
  await mkdir(codexRoot);
  await mkdir(localAppData);
  const previousCodexHome = process.env.CODEX_HOME;
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousUserProfile = process.env.USERPROFILE;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(root, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = codexRoot;
  process.env.LOCALAPPDATA = localAppData;
  process.env.USERPROFILE = home;

  const projectRoot = await realpath(path.resolve(import.meta.dirname, ".."));
  const projectIdentity = process.platform === "win32"
    ? projectRoot.toUpperCase()
    : projectRoot;
  const projectDigest = createHash("sha256")
    .update(projectIdentity, "utf8")
    .digest("hex");
  const privateRuntime = path.join(
    localAppData,
    "MyDashboard",
    "runtime",
    projectDigest,
  );
  const mirrorRoot = path.join(privateRuntime, "cli-credentials-v1");

  assert.deepEqual(productionCodexLoginLocations(), {
    sourceFile: path.join(codexRoot, "auth.json"),
    mirrorRoot,
    mirrorDirectory: path.join(mirrorRoot, "codex-login"),
    probeRoot: path.join(privateRuntime, "codex-login-probe-v1"),
  });

  process.env.CODEX_HOME = "relative-codex-home";
  assert.throws(productionCodexLoginLocations, { code: "CODEX_LOGIN_SOURCE_UNSAFE" });
  process.env.CODEX_HOME = path.join(root, "missing-codex-home");
  assert.throws(productionCodexLoginLocations, { code: "CODEX_LOGIN_SOURCE_UNSAFE" });
});

test("default source is homedir .codex auth.json when CODEX_HOME is absent", (t) => {
  const previous = process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  delete process.env.CODEX_HOME;
  assert.equal(
    productionCodexLoginLocations().sourceFile,
    path.join(os.homedir(), ".codex", "auth.json"),
  );
});

test("every protected/source/mirror/probe overlap fails before private directory creation", async () => {
  const root = path.resolve("D:/fictional-task3-overlap-root");
  const baseline = fixtureLocations(root);
  const cases = [
    ["repository contains source", [path.join(root, "repository")], {
      ...baseline,
      sourceFile: path.join(root, "repository", "codex", "auth.json"),
    }],
    ["data is inside mirror", [path.join(baseline.mirrorRoot, "data")], baseline],
    ["backup contains probe", [path.join(root, "home")], baseline],
    ["workspace contains mirror", [path.join(root, "home")], baseline],
    ["CLI temp is inside source root", [path.join(root, "codex-home", "tmp")], baseline],
    ["source root contains protected root", [path.join(root, "codex-home", "repository")], baseline],
    ["mirror root contains protected root", [path.join(baseline.mirrorRoot, "repository")], baseline],
    ["probe root contains protected root", [path.join(baseline.probeRoot, "repository")], baseline],
  ];

  for (const [label, protectedRoots, locations] of cases) {
    const current = createHarness(path.join(root, label.replaceAll(" ", "-")));
    const store = createTestCodexLoginCredentialStore(
      { ...current.options, locations, protectedRoots },
      current.dependencies,
    );
    await assert.rejects(
      store.beginTask({ signal: AbortSignal.timeout(30_000) }),
      { code: "CODEX_LOGIN_BROKER_BLOCKED" },
      label,
    );
    assert.equal(current.manager.prepareCalls.length, 0, label);
  }
});

test("nested protected roots remain valid when every credential root is outside them", async () => {
  const root = path.resolve("D:/fictional-task3-nested-protected-roots");
  const current = createHarness(root);
  const repository = path.join(root, "repository");
  const store = current.createStore({
    protectedRoots: [
      repository,
      path.join(repository, "data"),
      path.join(repository, "backups"),
      path.join(repository, "workspaces", "primary"),
    ],
  });

  const snapshot = await store.beginTask({
    signal: AbortSignal.timeout(30_000),
  });

  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(current.manager.prepareCalls, [
    current.locations.mirrorRoot,
    current.locations.mirrorDirectory,
  ]);
});

test("different Windows volumes and UNC shares are isolated while same roots still overlap", {
  skip: process.platform === "win32" ? false : "requires Windows path-root semantics",
}, async (t) => {
  const isolatedCases = [
    ["different volumes", {
      sourceFile: "C:\\fictional-task3\\codex-home\\auth.json",
      mirrorRoot: "D:\\fictional-task3\\mirror-root",
      mirrorDirectory: "D:\\fictional-task3\\mirror-root\\codex-login",
      probeRoot: "E:\\fictional-task3\\probe-root",
    }, ["F:\\fictional-task3\\repository", "G:\\fictional-task3\\data"]],
    ["different UNC shares", {
      sourceFile: "\\\\fictional-host\\source-share\\codex-home\\auth.json",
      mirrorRoot: "\\\\fictional-host\\mirror-share\\mirror-root",
      mirrorDirectory: "\\\\fictional-host\\mirror-share\\mirror-root\\codex-login",
      probeRoot: "\\\\fictional-host\\probe-share\\probe-root",
    }, [
      "\\\\fictional-host\\repository-share\\repository",
      "\\\\fictional-host\\data-share\\data",
    ]],
  ];

  for (const [label, locations, protectedRoots] of isolatedCases) {
    await t.test(label, async () => {
      const current = createHarness(path.resolve(`D:/fictional-task3-${label.replaceAll(" ", "-")}`));
      const store = createTestCodexLoginCredentialStore(
        { ...current.options, locations, protectedRoots },
        current.dependencies,
      );
      await store.beginTask({ signal: AbortSignal.timeout(30_000) });
      assert.deepEqual(current.manager.prepareCalls, [
        locations.mirrorRoot,
        locations.mirrorDirectory,
      ]);
    });
  }

  const overlapCases = [
    ["same-volume ancestor", {
      sourceFile: "C:\\fictional-task3\\codex-home\\auth.json",
      mirrorRoot: "D:\\fictional-task3\\mirror-root",
      mirrorDirectory: "D:\\fictional-task3\\mirror-root\\codex-login",
      probeRoot: "E:\\fictional-task3\\probe-root",
    }, ["C:\\fictional-task3"]],
    ["same-share equality", {
      sourceFile: "\\\\fictional-host\\source-share\\codex-home\\auth.json",
      mirrorRoot: "\\\\fictional-host\\mirror-share\\mirror-root",
      mirrorDirectory: "\\\\fictional-host\\mirror-share\\mirror-root\\codex-login",
      probeRoot: "\\\\fictional-host\\probe-share\\probe-root",
    }, ["\\\\fictional-host\\source-share\\codex-home"]],
    ["same-share descendant", {
      sourceFile: "\\\\fictional-host\\source-share\\codex-home\\auth.json",
      mirrorRoot: "\\\\fictional-host\\mirror-share\\mirror-root",
      mirrorDirectory: "\\\\fictional-host\\mirror-share\\mirror-root\\codex-login",
      probeRoot: "\\\\fictional-host\\probe-share\\probe-root",
    }, ["\\\\fictional-host\\source-share\\codex-home\\private"]],
  ];

  for (const [label, locations, protectedRoots] of overlapCases) {
    await t.test(label, async () => {
      const current = createHarness(path.resolve(`D:/fictional-task3-${label.replaceAll(" ", "-")}`));
      const store = createTestCodexLoginCredentialStore(
        { ...current.options, locations, protectedRoots },
        current.dependencies,
      );
      await assert.rejects(
        store.beginTask({ signal: AbortSignal.timeout(30_000) }),
        { code: "CODEX_LOGIN_BROKER_BLOCKED" },
      );
      assert.equal(current.manager.prepareCalls.length, 0);
    });
  }
});

test("canonicalized aliases cannot bypass protected/source/isolated root separation", async () => {
  const root = path.resolve("D:/fictional-task3-canonical-overlap");
  const current = createHarness(root);
  const aliasProtected = path.join(root, "alias-to-source-root");
  let canonicalizationCalls = 0;
  const dependencies = {
    ...current.dependencies,
    async canonicalizePath(candidate) {
      canonicalizationCalls += 1;
      return candidate === aliasProtected
        ? path.dirname(current.locations.sourceFile)
        : path.resolve(candidate);
    },
  };
  const store = createTestCodexLoginCredentialStore({
    ...current.options,
    protectedRoots: [aliasProtected],
  }, dependencies);

  await assert.rejects(
    store.beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
  assert.equal(canonicalizationCalls >= 4, true);
  assert.equal(current.manager.prepareCalls.length, 0);
});

test("real filesystem aliases cannot bypass store root separation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-codex-store-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = createHarness(root);
  const sourceRoot = path.dirname(current.locations.sourceFile);
  const aliasProtected = path.join(root, "source-root-alias");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(path.dirname(current.locations.mirrorRoot), { recursive: true });
  try {
    await symlink(sourceRoot, aliasProtected, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
      t.skip(`filesystem alias capability unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  let canonicalizationCalls = 0;
  const dependencies = {
    ...current.dependencies,
    async canonicalizePath(candidate) {
      canonicalizationCalls += 1;
      let existing = path.resolve(candidate);
      const suffix = [];
      while (true) {
        try {
          return path.join(await realpath(existing), ...suffix);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          const parent = path.dirname(existing);
          if (parent === existing) throw error;
          suffix.unshift(path.basename(existing));
          existing = parent;
        }
      }
    },
  };
  const store = createTestCodexLoginCredentialStore({
    ...current.options,
    protectedRoots: [aliasProtected],
  }, dependencies);

  await assert.rejects(
    store.beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
  assert.equal(canonicalizationCalls >= 4, true);
  assert.equal(current.manager.prepareCalls.length, 0);
});

test("accessor and proxy option records are rejected without executing traps", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-traps"));
  let traps = 0;
  const accessorLocations = {};
  Object.defineProperty(accessorLocations, "sourceFile", {
    enumerable: true,
    get() {
      traps += 1;
      throw new Error("FICTIONAL_ACCESSOR_PRIVATE");
    },
  });
  for (const key of ["mirrorRoot", "mirrorDirectory", "probeRoot"]) {
    Object.defineProperty(accessorLocations, key, {
      enumerable: true,
      value: current.locations[key],
    });
  }
  const accessorStore = createTestCodexLoginCredentialStore(
    { ...current.options, locations: accessorLocations },
    current.dependencies,
  );
  await assert.rejects(
    accessorStore.beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );

  const proxyDependencies = new Proxy(current.dependencies, {
    getPrototypeOf() {
      traps += 1;
      throw new Error("FICTIONAL_PROXY_PRIVATE");
    },
  });
  const proxyStore = createTestCodexLoginCredentialStore(current.options, proxyDependencies);
  await assert.rejects(
    proxyStore.beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );

  const operation = {};
  Object.defineProperty(operation, "signal", {
    enumerable: true,
    get() {
      traps += 1;
      throw new Error("FICTIONAL_OPERATION_ACCESSOR_PRIVATE");
    },
  });
  await assert.rejects(current.createStore().beginTask(operation), {
    code: "CODEX_LOGIN_BROKER_BLOCKED",
  });

  const productionOptions = {};
  Object.defineProperty(productionOptions, "protectedRoots", {
    enumerable: true,
    get() {
      traps += 1;
      throw new Error("FICTIONAL_PRODUCTION_ACCESSOR_PRIVATE");
    },
  });
  assert.throws(
    () => createProductionCodexLoginCredentialStore(productionOptions),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
  assert.equal(traps, 0);
});

test("exact data records reject symbol own keys", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-exact-records"));
  const symbolOptions = { ...current.options };
  symbolOptions[Symbol("FICTIONAL_SYMBOL_PRIVATE")] = "FICTIONAL_SYMBOL_VALUE_PRIVATE";
  await assert.rejects(
    createTestCodexLoginCredentialStore(symbolOptions, current.dependencies)
      .beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
});

test("exact data records reject polluted descriptors without executing getters", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-polluted-record"));
  let traps = 0;
  const operation = {};
  Object.defineProperty(operation, "signal", {
    enumerable: true,
    get() {
      traps += 1;
      throw new Error("FICTIONAL_POLLUTED_RECORD_GETTER_PRIVATE");
    },
  });
  Object.defineProperty(Object.prototype, "value", {
    configurable: true,
    value: AbortSignal.timeout(30_000),
  });
  try {
    await assert.rejects(
      current.createStore().beginTask(operation),
      { code: "CODEX_LOGIN_BROKER_BLOCKED" },
    );
  } finally {
    delete Object.prototype.value;
  }
  assert.equal(traps, 0);
});

test("exact string arrays reject polluted descriptors without executing getters", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-polluted-array"));
  let traps = 0;
  const roots = [];
  Object.defineProperty(roots, "0", {
    enumerable: true,
    get() {
      traps += 1;
      throw new Error("FICTIONAL_POLLUTED_ARRAY_GETTER_PRIVATE");
    },
  });
  roots.length = 1;
  Object.defineProperty(Object.prototype, "value", {
    configurable: true,
    value: path.join(path.dirname(current.options.protectedRoots[0]), "independent-root"),
  });
  try {
    const store = createTestCodexLoginCredentialStore(
      { ...current.options, protectedRoots: roots },
      current.dependencies,
    );
    await assert.rejects(
      store.beginTask({ signal: AbortSignal.timeout(30_000) }),
      { code: "CODEX_LOGIN_BROKER_BLOCKED" },
    );
  } finally {
    delete Object.prototype.value;
  }
  assert.equal(traps, 0);
});

test("directory identities and protected-root arrays reject proxies and accessors with zero traps", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-deep-traps"));
  const store = current.createStore();
  const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  let identityTraps = 0;
  const proxyIdentity = new Proxy(
    directoryIdentity(path.join(current.locations.probeRoot, "proxy-identity"), 131),
    {
      isExtensible() {
        identityTraps += 1;
        throw new Error("FICTIONAL_IDENTITY_TRAP_PRIVATE");
      },
    },
  );
  await assert.rejects(
    store.stageTask({
      snapshot,
      codexHome: proxyIdentity,
      signal: AbortSignal.timeout(30_000),
    }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
  assert.equal(identityTraps, 0);

  let collectionTraps = 0;
  const proxyRoots = new Proxy([path.join(current.locations.probeRoot, "proxy-root")], {
    get() {
      collectionTraps += 1;
      throw new Error("FICTIONAL_ROOT_COLLECTION_TRAP_PRIVATE");
    },
  });
  const proxyRootStore = createTestCodexLoginCredentialStore(
    { ...current.options, protectedRoots: proxyRoots },
    current.dependencies,
  );
  await assert.rejects(
    proxyRootStore.beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );

  const accessorRoots = [];
  Object.defineProperty(accessorRoots, "0", {
    enumerable: true,
    get() {
      collectionTraps += 1;
      throw new Error("FICTIONAL_ROOT_ENTRY_TRAP_PRIVATE");
    },
  });
  accessorRoots.length = 1;
  const accessorRootStore = createTestCodexLoginCredentialStore(
    { ...current.options, protectedRoots: accessorRoots },
    current.dependencies,
  );
  await assert.rejects(
    accessorRootStore.beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
  assert.equal(collectionTraps, 0);
});

test("first source publishes one exact canonical envelope and an opaque owned snapshot", async () => {
  const source = Buffer.from("fictional-first-source-auth-json");
  const current = createHarness(path.resolve("D:/fictional-task3-first"), source);
  const store = current.createStore();
  const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });

  assert.deepEqual(Object.keys(snapshot), []);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(current.manager.prepareCalls, [
    current.locations.mirrorRoot,
    current.locations.mirrorDirectory,
  ]);
  assert.equal(current.manager.validationCalls, 4);
  const bytes = current.envelopeBytes();
  const envelope = parseEnvelope(bytes);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "credentialBase64",
    "credentialDigest",
    "schemaVersion",
    "sourceDigest",
    "updatedAt",
  ]);
  assert.deepEqual(envelope, {
    credentialBase64: source.toString("base64"),
    credentialDigest: sha256(source),
    schemaVersion: 1,
    sourceDigest: sha256(source),
    updatedAt: NOW,
  });
  assert.equal(
    bytes.toString("utf8"),
    `{"credentialBase64":"${source.toString("base64")}","credentialDigest":"${sha256(source)}","schemaVersion":1,"sourceDigest":"${sha256(source)}","updatedAt":"${NOW}"}\n`,
  );
  assert.equal(bytes.length <= ENVELOPE_LIMIT, true);

  const other = current.createStore();
  await assert.rejects(
    other.stageTask({
      snapshot,
      codexHome: directoryIdentity(path.join(current.locations.probeRoot, "foreign"), 41),
      signal: AbortSignal.timeout(30_000),
    }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
});

test("unchanged source uses captured refresh and a reconstructed store uses refreshed bytes", async () => {
  const initial = Buffer.from("fictional-unchanged-source");
  const refreshed = Buffer.from("fictional-refreshed-credential");
  const current = createHarness(path.resolve("D:/fictional-task3-refresh"), initial);
  const firstStore = current.createStore();
  const firstHome = directoryIdentity(path.join(current.locations.probeRoot, "first"), 51);
  const first = await firstStore.beginTask({ signal: AbortSignal.timeout(30_000) });
  await firstStore.stageTask({
    snapshot: first,
    codexHome: firstHome,
    signal: AbortSignal.timeout(30_000),
  });
  assert.deepEqual(current.privateBytes(firstHome), initial);
  current.setPrivate(firstHome, refreshed);
  await firstStore.captureTask({
    snapshot: first,
    codexHome: firstHome,
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(parseEnvelope(current.envelopeBytes()).sourceDigest, sha256(initial));
  assert.equal(parseEnvelope(current.envelopeBytes()).credentialDigest, sha256(refreshed));

  const reconstructed = current.createStore();
  const next = await reconstructed.beginTask({ signal: AbortSignal.timeout(30_000) });
  const nextHome = directoryIdentity(path.join(current.locations.probeRoot, "next"), 52);
  await reconstructed.stageTask({
    snapshot: next,
    codexHome: nextHome,
    signal: AbortSignal.timeout(30_000),
  });
  assert.deepEqual(current.privateBytes(nextHome), refreshed);
});

test("a changed source replaces the mirror generation and stages only new source bytes", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-generation"));
  const store = current.createStore();
  await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  const changed = Buffer.from("fictional-source-generation-two");
  current.setSource(changed);
  const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  const codexHome = directoryIdentity(path.join(current.locations.probeRoot, "changed"), 61);
  await store.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
  assert.deepEqual(current.privateBytes(codexHome), changed);
  assert.deepEqual(parseEnvelope(current.envelopeBytes()), {
    credentialBase64: changed.toString("base64"),
    credentialDigest: sha256(changed),
    schemaVersion: 1,
    sourceDigest: sha256(changed),
    updatedAt: NOW,
  });
});

test("logout removes a valid mirror while an unsafe source preserves but never uses it", async () => {
  const marker = "fictional-source-generation-one";
  const missing = createHarness(path.resolve("D:/fictional-task3-logout"), Buffer.from(marker));
  const missingStore = missing.createStore();
  await missingStore.beginTask({ signal: AbortSignal.timeout(30_000) });
  missing.failSource("ENOENT");
  await assert.rejects(
    missingStore.beginTask({ signal: AbortSignal.timeout(30_000) }),
    (error) => assertRedacted(error, "CODEX_LOGIN_FILE_UNAVAILABLE", [
      marker,
      missing.locations.sourceFile,
      missing.locations.mirrorDirectory,
      sha256(Buffer.from(marker)),
      Buffer.from(marker).toString("base64"),
    ]),
  );
  assert.equal(missing.envelopeBytes(), undefined);

  const unsafe = createHarness(path.resolve("D:/fictional-task3-unsafe"), Buffer.from(marker));
  const unsafeStore = unsafe.createStore();
  await unsafeStore.beginTask({ signal: AbortSignal.timeout(30_000) });
  const retained = Buffer.from(unsafe.envelopeBytes());
  unsafe.failSource("CODEX_CREDENTIAL_SOURCE_UNSAFE");
  await assert.rejects(
    unsafeStore.beginTask({ signal: AbortSignal.timeout(30_000) }),
    (error) => assertRedacted(error, "CODEX_LOGIN_SOURCE_UNSAFE", [marker]),
  );
  assert.deepEqual(unsafe.envelopeBytes(), retained);
});

test("missing, unsafe, and changed sources revoke probe and stale-snapshot credential use", async (t) => {
  for (const transition of ["missing", "unsafe", "changed"]) {
    await t.test(transition, async () => {
      const current = createHarness(path.resolve(`D:/fictional-task3-revoke-${transition}`));
      const store = current.createStore();
      const staleSnapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
      const probeHome = directoryIdentity(path.join(current.locations.probeRoot, `${transition}-probe`), 111);
      const taskHome = directoryIdentity(path.join(current.locations.probeRoot, `${transition}-task`), 112);

      if (transition === "missing") {
        current.failSource("ENOENT");
        await assert.rejects(
          store.beginTask({ signal: AbortSignal.timeout(30_000) }),
          { code: "CODEX_LOGIN_FILE_UNAVAILABLE" },
        );
      } else if (transition === "unsafe") {
        current.failSource("CODEX_CREDENTIAL_SOURCE_UNSAFE");
        await assert.rejects(
          store.beginTask({ signal: AbortSignal.timeout(30_000) }),
          { code: "CODEX_LOGIN_SOURCE_UNSAFE" },
        );
      } else {
        current.setSource(Buffer.from("fictional-source-generation-two"));
        await store.stageProbe({
          codexHome: probeHome,
          signal: AbortSignal.timeout(30_000),
        });
        assert.deepEqual(
          current.privateBytes(probeHome),
          Buffer.from("fictional-source-generation-two"),
        );
      }

      if (transition !== "changed") {
        await assert.rejects(
          store.stageProbe({ codexHome: probeHome, signal: AbortSignal.timeout(30_000) }),
        );
      }
      await assert.rejects(
        store.stageTask({
          snapshot: staleSnapshot,
          codexHome: taskHome,
          signal: AbortSignal.timeout(30_000),
        }),
        { code: "CODEX_LOGIN_BROKER_BLOCKED" },
      );
      if (transition === "changed") {
        assert.deepEqual(
          current.privateBytes(probeHome),
          Buffer.from("fictional-source-generation-two"),
        );
      } else {
        assert.equal(current.privateBytes(probeHome), undefined);
      }
      assert.equal(current.privateBytes(taskHome), undefined);
    });
  }
});

test("a restored machine with no source remains unavailable and creates no mirror envelope", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-restored-machine"));
  current.failSource("ENOENT", "FICTIONAL_RESTORED_MACHINE_NO_SOURCE");
  await assert.rejects(
    current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_FILE_UNAVAILABLE" },
  );
  assert.equal(current.envelopeBytes(), undefined);
  assert.deepEqual(current.manager.prepareCalls, [
    current.locations.mirrorRoot,
    current.locations.mirrorDirectory,
  ]);
});

test("corrupt, Base64, digest, and credential-bound envelopes block", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-corrupt"));
  const store = current.createStore();
  await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  const valid = parseEnvelope(current.envelopeBytes());
  const identity = directoryIdentity(current.locations.mirrorDirectory, 2);
  const key = privateKey(identity, ENVELOPE_NAME);
  const cases = [
    Buffer.from(JSON.stringify(valid), "utf8"),
    Buffer.from(`${JSON.stringify({ ...valid, schemaVersion: 2 })}\n`, "utf8"),
    Buffer.from(`${JSON.stringify({ ...valid, extra: "unknown" })}\n`, "utf8"),
    Buffer.from(`${JSON.stringify({ ...valid, credentialBase64: "eA" })}\n`, "utf8"),
    Buffer.from(`${JSON.stringify({ ...valid, credentialDigest: "0".repeat(64) })}\n`, "utf8"),
    Buffer.from(`${JSON.stringify({
      ...valid,
      credentialBase64: Buffer.alloc(CREDENTIAL_LIMIT + 1, 0x78).toString("base64"),
      credentialDigest: sha256(Buffer.alloc(CREDENTIAL_LIMIT + 1, 0x78)),
    })}\n`, "utf8"),
  ];

  for (const bytes of cases) {
    current.privateFiles.set(key, bytes);
    await assert.rejects(
      current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
      { code: "CODEX_LOGIN_BROKER_BLOCKED" },
    );
  }
});

test("envelopes over 192 KiB and invalid UTF-8 block before reconstruction", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-envelope-bound"));
  await current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) });
  const identity = directoryIdentity(current.locations.mirrorDirectory, 2);
  const key = privateKey(identity, ENVELOPE_NAME);

  for (const bytes of [
    Buffer.alloc(ENVELOPE_LIMIT + 1, 0x78),
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d, 0x0a]),
  ]) {
    current.privateFiles.set(key, bytes);
    await assert.rejects(
      current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
      { code: "CODEX_LOGIN_BROKER_BLOCKED" },
    );
    assert.deepEqual(current.privateFiles.get(key), bytes);
  }
});

test("an otherwise-valid envelope with a duplicate key is rejected", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-duplicate-envelope"));
  await current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) });
  const identity = directoryIdentity(current.locations.mirrorDirectory, 2);
  const key = privateKey(identity, ENVELOPE_NAME);
  const canonical = current.envelopeBytes().toString("utf8");
  const duplicate = canonical.replace(
    /^\{"credentialBase64":"([^"]+)",/u,
    `{"credentialBase64":"$1","credentialBase64":"$1",`,
  );
  current.privateFiles.set(key, Buffer.from(duplicate, "utf8"));

  await assert.rejects(
    current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
});

test("otherwise-valid reordered and whitespace-bearing envelopes are noncanonical", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-noncanonical-envelope"));
  await current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) });
  const identity = directoryIdentity(current.locations.mirrorDirectory, 2);
  const key = privateKey(identity, ENVELOPE_NAME);
  const envelope = parseEnvelope(current.envelopeBytes());
  const reordered = `${JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    sourceDigest: envelope.sourceDigest,
    credentialDigest: envelope.credentialDigest,
    credentialBase64: envelope.credentialBase64,
    updatedAt: envelope.updatedAt,
  })}\n`;
  const whitespace = current.envelopeBytes().toString("utf8").replace("{", "{ ");

  for (const text of [reordered, whitespace]) {
    current.privateFiles.set(key, Buffer.from(text, "utf8"));
    await assert.rejects(
      current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
      { code: "CODEX_LOGIN_BROKER_BLOCKED" },
    );
  }
});

test("source and staged credentials enforce 1..65,536 bytes", async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(CREDENTIAL_LIMIT + 1, 0x61)]) {
    const current = createHarness(path.resolve(`D:/fictional-task3-source-bound-${bytes.length}`), bytes);
    await assert.rejects(
      current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
      { code: "CODEX_LOGIN_SOURCE_UNSAFE" },
    );
    assert.equal(current.manager.prepareCalls.length, 0);
  }

  const maximum = Buffer.alloc(CREDENTIAL_LIMIT, 0x6d);
  const current = createHarness(path.resolve("D:/fictional-task3-maximum"), maximum);
  const store = current.createStore();
  const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  assert.equal(current.envelopeBytes().length < ENVELOPE_LIMIT, true);
  const codexHome = directoryIdentity(path.join(current.locations.probeRoot, "maximum"), 71);
  await store.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
  assert.deepEqual(current.privateBytes(codexHome), maximum);
  current.setPrivate(codexHome, Buffer.alloc(CREDENTIAL_LIMIT + 1, 0x62));
  await assert.rejects(
    store.captureTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
});

test("captured credentials enforce the 0, 1, 65,536, and 65,537-byte boundaries", async (t) => {
  const cases = [
    [0, false],
    [1, true],
    [CREDENTIAL_LIMIT, true],
    [CREDENTIAL_LIMIT + 1, false],
  ];

  for (const [length, accepted] of cases) {
    await t.test(`${length} bytes`, async () => {
      const source = Buffer.from("fictional-capture-bound-source");
      const current = createHarness(
        path.resolve(`D:/fictional-task3-capture-bound-${length}`),
        source,
      );
      const store = current.createStore();
      const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
      const codexHome = directoryIdentity(
        path.join(current.locations.probeRoot, `capture-${length}`),
        151,
      );
      await store.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
      const captured = Buffer.alloc(length, 0x63);
      current.setPrivate(codexHome, captured);

      if (!accepted) {
        await assert.rejects(
          store.captureTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) }),
          { code: "CODEX_LOGIN_BROKER_BLOCKED" },
        );
        assert.equal(parseEnvelope(current.envelopeBytes()).credentialDigest, sha256(source));
        return;
      }

      await store.captureTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
      const envelope = parseEnvelope(current.envelopeBytes());
      assert.equal(envelope.credentialDigest, sha256(captured));
      assert.equal(envelope.credentialBase64, captured.toString("base64"));
    });
  }
});

test("stageProbe uses only a valid current mirror and task staging creates only auth.json", async () => {
  const source = Buffer.from("fictional-probe-source");
  const current = createHarness(path.resolve("D:/fictional-task3-probe"), source);
  const store = current.createStore();
  const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  const taskHome = directoryIdentity(path.join(current.locations.probeRoot, "task"), 81);
  const probeHome = directoryIdentity(path.join(current.locations.probeRoot, "probe"), 82);
  await store.stageTask({ snapshot, codexHome: taskHome, signal: AbortSignal.timeout(30_000) });
  await store.stageProbe({ codexHome: probeHome, signal: AbortSignal.timeout(30_000) });
  assert.deepEqual(current.privateBytes(taskHome), source);
  assert.deepEqual(current.privateBytes(probeHome), source);
  assert.deepEqual(
    [...current.privateFiles.keys()].filter((key) => key.startsWith(`${taskHome.path}\n`)),
    [`${taskHome.path}\nauth.json`],
  );
});

test("a fresh probe stages validated host login without publishing a mirror", async () => {
  const source = Buffer.from("fictional-fresh-probe-source");
  const current = createHarness(
    path.resolve("D:/fictional-task3-fresh-probe"),
    source,
  );
  const store = current.createStore();
  const probeHome = directoryIdentity(
    path.join(current.locations.probeRoot, "fresh"),
    83,
  );

  await store.stageProbe({
    codexHome: probeHome,
    signal: AbortSignal.timeout(30_000),
  });

  assert.deepEqual(current.privateBytes(probeHome), source);
  assert.equal(current.envelopeBytes(), undefined);
});

test("probe preserves missing and unsafe host-source classifications", async (t) => {
  for (const [sourceCode, expectedCode] of [
    ["ENOENT", "CODEX_LOGIN_FILE_UNAVAILABLE"],
    ["CODEX_CREDENTIAL_SOURCE_UNSAFE", "CODEX_LOGIN_SOURCE_UNSAFE"],
  ]) {
    await t.test(expectedCode, async () => {
      const current = createHarness(
        path.resolve(`D:/fictional-task3-probe-${expectedCode.toLowerCase()}`),
      );
      current.failSource(sourceCode);
      const probeHome = directoryIdentity(
        path.join(current.locations.probeRoot, expectedCode.toLowerCase()),
        84,
      );

      await assert.rejects(
        current.createStore().stageProbe({
          codexHome: probeHome,
          signal: AbortSignal.timeout(30_000),
        }),
        { code: expectedCode },
      );
      assert.equal(current.privateBytes(probeHome), undefined);
    });
  }
});

test("capture publishes refresh only while the host source remains the snapshot generation", async () => {
  const initial = Buffer.from("fictional-capture-source");
  const current = createHarness(path.resolve("D:/fictional-task3-capture-generation"), initial);
  const store = current.createStore();
  const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  const before = Buffer.from(current.envelopeBytes());
  const codexHome = directoryIdentity(path.join(current.locations.probeRoot, "capture"), 91);
  await store.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
  current.setPrivate(codexHome, Buffer.from("fictional-captured-refresh"));
  current.setSource(Buffer.from("fictional-host-changed-during-task"));
  await assert.rejects(
    store.captureTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
  assert.deepEqual(current.envelopeBytes(), before);
});

test("a deferred obsolete capture cannot overwrite a newer source generation across stores", async () => {
  const oldSource = Buffer.from("fictional-raced-source-generation-one");
  const newSource = Buffer.from("fictional-raced-source-generation-two");
  const refreshed = Buffer.from("fictional-raced-refresh-from-old-generation");
  const current = createHarness(path.resolve("D:/fictional-task3-publication-race"), oldSource);
  const oldStore = current.createStore();
  const newStore = current.createStore();
  const snapshot = await oldStore.beginTask({ signal: AbortSignal.timeout(30_000) });
  const codexHome = directoryIdentity(path.join(current.locations.probeRoot, "publication-race"), 121);
  await oldStore.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
  current.setPrivate(codexHome, refreshed);

  const publication = current.holdNext("replacePrivate");
  const obsoleteCapture = oldStore.captureTask({
    snapshot,
    codexHome,
    signal: AbortSignal.timeout(30_000),
  });
  await publication.entered;
  current.setSource(newSource);
  const newerBegin = newStore.beginTask({ signal: AbortSignal.timeout(30_000) });
  publication.release();

  await assert.rejects(obsoleteCapture, { code: "CODEX_LOGIN_BROKER_BLOCKED" });
  const newerSnapshot = await newerBegin;
  const newerHome = directoryIdentity(path.join(current.locations.probeRoot, "publication-race-new"), 122);
  await newStore.stageTask({
    snapshot: newerSnapshot,
    codexHome: newerHome,
    signal: AbortSignal.timeout(30_000),
  });
  assert.deepEqual(current.privateBytes(newerHome), newSource);
  assert.equal(parseEnvelope(current.envelopeBytes()).sourceDigest, sha256(newSource));
  assert.equal(parseEnvelope(current.envelopeBytes()).credentialDigest, sha256(newSource));
});

test("replacement failure phases preserve one exact durable generation and no temporary state", async (t) => {
  const phases = [
    ["TEMPORARY_WRITE", ["temporary-write"], "initial"],
    ["FLUSH", ["temporary-write", "flush"], "initial"],
    ["PRE_COMMIT_REPLACE", ["temporary-write", "flush", "pre-commit-replace"], "initial"],
    ["FINAL_VERIFY", [
      "temporary-write",
      "flush",
      "pre-commit-replace",
      "commit",
      "final-verify",
    ], "refreshed"],
    ["IDENTITY_REPLACEMENT", ["identity-check"], "initial"],
  ];

  for (const [phase, expectedEvents, durableGeneration] of phases) {
    await t.test(phase, async () => {
      const initial = Buffer.from(`fictional-initial-${phase}`);
      const refreshed = Buffer.from(`fictional-refreshed-${phase}`);
      const current = createHarness(path.resolve(`D:/fictional-task3-race-${phase}`), initial);
      const store = current.createStore();
      const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
      const codexHome = directoryIdentity(path.join(current.locations.probeRoot, phase), 101);
      await store.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
      current.setPrivate(codexHome, refreshed);
      current.failNext("replacePrivate", phase);

      await assert.rejects(
        store.captureTask({
          snapshot,
          codexHome,
          signal: AbortSignal.timeout(30_000),
        }),
        (error) => assertRedacted(error, "CODEX_LOGIN_BROKER_BLOCKED", [
          ...secrecyMarkers(current, [initial, refreshed], [codexHome]),
          `FICTIONAL_${phase}_PRIVATE`,
        ]),
      );

      assert.deepEqual(
        current.replacementEvents
          .filter(([eventPhase]) => eventPhase === phase)
          .map(([, event]) => event),
        expectedEvents,
      );
      assert.equal(current.temporaryFiles.size, 0);
      const durable = parseEnvelope(current.envelopeBytes());
      const expected = durableGeneration === "initial" ? initial : refreshed;
      assert.equal(durable.credentialDigest, sha256(expected));
      assert.equal(Buffer.from(durable.credentialBase64, "base64").equals(expected), true);

      const recovered = current.createStore();
      const recoveredSnapshot = await recovered.beginTask({ signal: AbortSignal.timeout(30_000) });
      const recoveredHome = directoryIdentity(
        path.join(current.locations.probeRoot, `${phase}-ok`),
        102,
      );
      await recovered.stageTask({
        snapshot: recoveredSnapshot,
        codexHome: recoveredHome,
        signal: AbortSignal.timeout(30_000),
      });
      assert.deepEqual(current.privateBytes(recoveredHome), expected);
      assertSnapshotRedacted(recoveredSnapshot, secrecyMarkers(
        current,
        [initial, refreshed],
        [codexHome, recoveredHome],
      ));
    });
  }
});

test("source, envelope, stage, capture, and probe failures redact every private marker", async (t) => {
  const phases = ["SOURCE_READ", "ENVELOPE_READ", "STAGE", "CAPTURE", "PROBE"];
  for (const phase of phases) {
    await t.test(phase, async () => {
      const initial = Buffer.from(`fictional-initial-${phase}`);
      const refreshed = Buffer.from(`fictional-refreshed-${phase}`);
      const current = createHarness(path.resolve(`D:/fictional-task3-failure-${phase}`), initial);
      const store = current.createStore();
      const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
      const codexHome = directoryIdentity(path.join(current.locations.probeRoot, phase), 201);
      let operation;
      if (phase === "SOURCE_READ") {
        current.failNext("readSource", phase);
        operation = () => store.beginTask({ signal: AbortSignal.timeout(30_000) });
      } else if (phase === "ENVELOPE_READ") {
        current.failNext("readPrivate", phase);
        operation = () => current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) });
      } else if (phase === "STAGE") {
        current.failNext("writeNewPrivate", phase);
        operation = () => store.stageTask({
          snapshot,
          codexHome,
          signal: AbortSignal.timeout(30_000),
        });
      } else if (phase === "CAPTURE") {
        await store.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
        current.setPrivate(codexHome, refreshed);
        current.failNext("readPrivate", phase);
        operation = () => store.captureTask({
          snapshot,
          codexHome,
          signal: AbortSignal.timeout(30_000),
        });
      } else {
        current.failNext("writeNewPrivate", phase);
        operation = () => store.stageProbe({
          codexHome,
          signal: AbortSignal.timeout(30_000),
        });
      }

      await assert.rejects(operation(), (error) => assertRedacted(
        error,
        "CODEX_LOGIN_BROKER_BLOCKED",
        [
          ...secrecyMarkers(current, [initial, refreshed], [codexHome]),
          `FICTIONAL_${phase}_PRIVATE`,
        ],
      ));
      assertSnapshotRedacted(snapshot, secrecyMarkers(
        current,
        [initial, refreshed],
        [codexHome],
      ));
    });
  }
});

test("Task 2 short-read failures and Task 3 truncated envelopes fail at their own boundaries", async () => {
  const sourceShortRead = createHarness(path.resolve("D:/fictional-task3-source-short-read"));
  sourceShortRead.failNext("readSource", "SOURCE_SHORT_READ");
  await assert.rejects(
    sourceShortRead.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
    (error) => assertRedacted(error, "CODEX_LOGIN_BROKER_BLOCKED", [
      ...secrecyMarkers(sourceShortRead, [Buffer.from("fictional-source-generation-one")]),
      "FICTIONAL_SOURCE_SHORT_READ_PRIVATE",
    ]),
  );
  assert.equal(sourceShortRead.manager.prepareCalls.length, 0);

  const envelopeShortRead = createHarness(path.resolve("D:/fictional-task3-envelope-short-read"));
  await envelopeShortRead.createStore().beginTask({ signal: AbortSignal.timeout(30_000) });
  const identity = directoryIdentity(envelopeShortRead.locations.mirrorDirectory, 2);
  const key = privateKey(identity, ENVELOPE_NAME);
  const truncated = envelopeShortRead.envelopeBytes().subarray(0, -1);
  envelopeShortRead.privateFiles.set(key, truncated);
  await assert.rejects(
    envelopeShortRead.createStore().beginTask({ signal: AbortSignal.timeout(30_000) }),
    { code: "CODEX_LOGIN_BROKER_BLOCKED" },
  );
  assert.deepEqual(envelopeShortRead.privateFiles.get(key), truncated);
  }
);
