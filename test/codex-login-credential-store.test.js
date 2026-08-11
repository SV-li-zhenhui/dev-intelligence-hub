import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  const calls = [];
  let sourceBytes = Buffer.from(source);
  let sourceFailure = null;
  let nextFailure = null;
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
      const selected = failure("replacePrivate");
      const key = privateKey(options.directory, options.name);
      if (selected?.commit) privateFiles.set(key, Buffer.from(options.bytes));
      if (selected) throw selected.error;
      if (!privateFiles.has(key)) throw new Error("fixture target missing");
      privateFiles.set(key, Buffer.from(options.bytes));
    },
    async removePrivate(options) {
      calls.push(["removePrivate", options.directory.path, options.name]);
      const selected = failure("removePrivate");
      if (selected) throw selected.error;
      privateFiles.delete(privateKey(options.directory, options.name));
    },
  };

  const dependencies = { filePort, privateDirectoryManager };
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
    failNext(method, phase, { commit = false } = {}) {
      nextFailure = {
        method,
        commit,
        error: Object.assign(new Error(`FICTIONAL_${phase}_PRIVATE`), {
          code: `FICTIONAL_${phase}`,
          path: locations.mirrorDirectory,
        }),
      };
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

test("production locations use an existing absolute CODEX_HOME and fixed private siblings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-codex-store-locations-"));
  const home = path.join(root, "home");
  const codexRoot = path.join(root, "codex-home");
  await mkdir(home);
  await mkdir(codexRoot);
  const previousCodexHome = process.env.CODEX_HOME;
  const previousUserProfile = process.env.USERPROFILE;
  t.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(root, { recursive: true, force: true });
  });
  process.env.CODEX_HOME = codexRoot;
  process.env.USERPROFILE = home;

  assert.deepEqual(productionCodexLoginLocations(), {
    sourceFile: path.join(codexRoot, "auth.json"),
    mirrorRoot: path.join(home, ".mydashboard-cli-credentials-v1"),
    mirrorDirectory: path.join(home, ".mydashboard-cli-credentials-v1", "codex-login"),
    probeRoot: path.join(home, ".mydashboard-codex-login-probe-v1"),
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

test("corrupt, noncanonical, duplicate-key, Base64, digest, and credential-bound envelopes block", async () => {
  const current = createHarness(path.resolve("D:/fictional-task3-corrupt"));
  const store = current.createStore();
  await store.beginTask({ signal: AbortSignal.timeout(30_000) });
  const valid = parseEnvelope(current.envelopeBytes());
  const identity = directoryIdentity(current.locations.mirrorDirectory, 2);
  const key = privateKey(identity, ENVELOPE_NAME);
  const cases = [
    Buffer.from(JSON.stringify(valid), "utf8"),
    Buffer.from(`{"schemaVersion":1,"schemaVersion":1}\n`, "utf8"),
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

test("source, staged, and captured auth credentials independently enforce 1..65,536 bytes", async () => {
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

test("all port failure phases fail closed, redact private data, and leave one usable generation", async () => {
  const phases = [
    ["readSource", "SOURCE_READ", false],
    ["readPrivate", "ENVELOPE_READ", false],
    ["replacePrivate", "TEMPORARY_WRITE", false],
    ["replacePrivate", "FLUSH", false],
    ["replacePrivate", "REPLACE", false],
    ["replacePrivate", "FINAL_VERIFY", true],
    ["writeNewPrivate", "STAGE", false],
    ["readPrivate", "CAPTURE", false],
  ];

  for (const [method, phase, commit] of phases) {
    const initial = Buffer.from(`fictional-initial-${phase}`);
    const refreshed = Buffer.from(`fictional-refreshed-${phase}`);
    const current = createHarness(path.resolve(`D:/fictional-task3-race-${phase}`), initial);
    const store = current.createStore();
    const snapshot = await store.beginTask({ signal: AbortSignal.timeout(30_000) });
    const codexHome = directoryIdentity(path.join(current.locations.probeRoot, phase), 101);

    let operation;
    if (method === "readSource") {
      current.failNext(method, phase, { commit });
      operation = () => store.beginTask({ signal: AbortSignal.timeout(30_000) });
    } else if (phase === "ENVELOPE_READ") {
      current.failNext(method, phase, { commit });
      operation = () => current.createStore().beginTask({ signal: AbortSignal.timeout(30_000) });
    } else if (phase === "STAGE") {
      current.failNext(method, phase, { commit });
      operation = () => store.stageTask({
        snapshot,
        codexHome,
        signal: AbortSignal.timeout(30_000),
      });
    } else {
      await store.stageTask({ snapshot, codexHome, signal: AbortSignal.timeout(30_000) });
      current.setPrivate(codexHome, refreshed);
      current.failNext(method, phase, { commit });
      operation = () => store.captureTask({
        snapshot,
        codexHome,
        signal: AbortSignal.timeout(30_000),
      });
    }

    await assert.rejects(operation(), (error) => assertRedacted(
      error,
      "CODEX_LOGIN_BROKER_BLOCKED",
      [
        initial.toString("utf8"),
        refreshed.toString("utf8"),
        current.locations.sourceFile,
        current.locations.mirrorDirectory,
        sha256(initial),
        initial.toString("base64"),
        refreshed.toString("base64"),
      ],
    ));

    if (!["SOURCE_READ", "ENVELOPE_READ", "STAGE"].includes(phase)) {
      const recovered = current.createStore();
      const recoveredSnapshot = await recovered.beginTask({ signal: AbortSignal.timeout(30_000) });
      const recoveredHome = directoryIdentity(path.join(current.locations.probeRoot, `${phase}-ok`), 102);
      await recovered.stageTask({
        snapshot: recoveredSnapshot,
        codexHome: recoveredHome,
        signal: AbortSignal.timeout(30_000),
      });
      const recoveredBytes = current.privateBytes(recoveredHome);
      assert.equal(recoveredBytes.equals(initial) || recoveredBytes.equals(refreshed), true, phase);
    }
  }
});
