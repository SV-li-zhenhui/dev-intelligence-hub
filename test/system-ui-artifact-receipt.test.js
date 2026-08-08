import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

const RUN_ID = "12345678-1234-4123-8123-123456789abc";
const SCENARIOS = [
  "desktop-1440",
  "mobile-390",
  "confirmation-queue",
  "code-job-control-package-desktop-1100",
  "code-job-control-package-mobile-390",
  "external-review-confirmation",
  "system-status-initial-error",
  "system-status-stale-error",
  "system-status-stale-success",
];

function runtimeSource() {
  return {
    schemaVersion: 1,
    headOid: "a".repeat(40),
    treeOid: "b".repeat(40),
    clean: true,
    runtimeDigest: "c".repeat(64),
    runtimeFileCount: 440,
    runtimeByteCount: 1_234_567,
  };
}

function liveService() {
  return {
    processId: 2468,
    instanceId: RUN_ID,
    startIdentity: "d".repeat(64),
    runtimeSource: runtimeSource(),
  };
}

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const pixels = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND"),
  ]);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function loadReceiptModule() {
  try {
    return await import("../scripts/system-ui-artifact-receipt.mjs");
  } catch (error) {
    assert.fail(`UI artifact receipt module is unavailable: ${error.message}`);
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-ui-receipt-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const relativeDirectory = `validation-artifacts/runs/${RUN_ID}/ui`;
  const directory = path.join(root, ...relativeDirectory.split("/"));
  await mkdir(directory, { recursive: true });
  const service = liveService();
  const results = {
    schemaVersion: 1,
    runId: RUN_ID,
    status: "passed",
    liveService: service,
    scenarios: SCENARIOS.map((name) => ({
      name,
      status: "passed",
      consoleErrors: 0,
      pageErrors: 0,
      horizontalOverflow: false,
      accessibilityFailures: 0,
    })),
    details: SCENARIOS.map((name) => ({ name })),
  };
  const files = {
    results: Buffer.from(`${JSON.stringify(results, null, 2)}\n`, "utf8"),
    desktop: png(1440, 1000),
    mobile: png(390, 844),
  };
  await writeFile(path.join(directory, "results.json"), files.results);
  await writeFile(path.join(directory, "desktop-1440.png"), files.desktop);
  await writeFile(path.join(directory, "mobile-390.png"), files.mobile);
  return { files, root, service };
}

test("prepares one exclusive run directory without recursive traversal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-ui-output-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { prepareUiArtifactDirectory } = await loadReceiptModule();

  const prepared = await prepareUiArtifactDirectory({ root, runId: RUN_ID });

  assert.equal(
    prepared.relativeDirectory,
    `validation-artifacts/runs/${RUN_ID}/ui`,
  );
  assert.equal((await lstat(prepared.directory)).isDirectory(), true);
  await assert.rejects(
    prepareUiArtifactDirectory({ root, runId: RUN_ID }),
    /UI artifact run directory already exists/u,
  );
});

test("refuses a linked UI artifact ancestor before creating through it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydashboard-ui-output-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "mydashboard-ui-outside-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  t.after(() => rm(outside, { force: true, recursive: true }));
  try {
    await symlink(
      outside,
      path.join(root, "validation-artifacts"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
      t.skip("directory links are unavailable on this host");
      return;
    }
    throw error;
  }
  const { prepareUiArtifactDirectory } = await loadReceiptModule();

  await assert.rejects(
    prepareUiArtifactDirectory({ root, runId: RUN_ID }),
    /UI artifact directory is unsafe/u,
  );
  await assert.rejects(
    lstat(path.join(outside, "runs")),
    (error) => error?.code === "ENOENT",
  );
});

test("builds a run-bound receipt for complete UI results and real PNGs", async (t) => {
  const setup = await fixture(t);
  const { buildUiArtifactReceipt } = await loadReceiptModule();

  const receipt = await buildUiArtifactReceipt({
    root: setup.root,
    runId: RUN_ID,
    liveService: setup.service,
    completedAt: "2026-08-09T01:02:03.000Z",
  });

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.runId, RUN_ID);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.completedAt, "2026-08-09T01:02:03.000Z");
  assert.deepEqual(receipt.liveService, setup.service);
  assert.deepEqual(receipt.scenarios, SCENARIOS);
  assert.deepEqual(
    receipt.artifacts.map(({ kind, path: artifactPath, bytes, sha256: digest }) => ({
      kind,
      path: artifactPath,
      bytes,
      sha256: digest,
    })),
    [
      {
        kind: "results",
        path: `validation-artifacts/runs/${RUN_ID}/ui/results.json`,
        bytes: setup.files.results.length,
        sha256: sha256(setup.files.results),
      },
      {
        kind: "desktop-screenshot",
        path: `validation-artifacts/runs/${RUN_ID}/ui/desktop-1440.png`,
        bytes: setup.files.desktop.length,
        sha256: sha256(setup.files.desktop),
      },
      {
        kind: "mobile-screenshot",
        path: `validation-artifacts/runs/${RUN_ID}/ui/mobile-390.png`,
        bytes: setup.files.mobile.length,
        sha256: sha256(setup.files.mobile),
      },
    ],
  );
  assert.deepEqual(receipt.artifacts[1].image, { width: 1440, height: 1000 });
  assert.deepEqual(receipt.artifacts[2].image, { width: 390, height: 844 });
  assert.equal(JSON.stringify(receipt).includes(setup.root), false);
  assert.deepEqual(
    JSON.parse(await readFile(
      path.join(
        setup.root,
        "validation-artifacts/runs",
        RUN_ID,
        "ui/results.json",
      ),
      "utf8",
    )),
    JSON.parse(setup.files.results.toString("utf8")),
  );
});

test("writes once and revalidates every UI artifact from the parent receipt", async (t) => {
  const setup = await fixture(t);
  const {
    buildUiArtifactReceipt,
    verifyUiArtifactReceipt,
    writeUiArtifactReceipt,
  } = await loadReceiptModule();
  const receipt = await buildUiArtifactReceipt({
    root: setup.root,
    runId: RUN_ID,
    liveService: setup.service,
    completedAt: "2026-08-09T01:02:03.000Z",
  });

  const envelope = await writeUiArtifactReceipt({
    root: setup.root,
    receipt,
  });

  assert.deepEqual(envelope, {
    schemaVersion: 1,
    runId: RUN_ID,
    path: `validation-artifacts/runs/${RUN_ID}/ui-receipt.json`,
    bytes: envelope.bytes,
    sha256: envelope.sha256,
  });
  assert.equal(envelope.bytes > 0, true);
  assert.match(envelope.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    await verifyUiArtifactReceipt({
      root: setup.root,
      envelope,
      expectedRunId: RUN_ID,
      expectedLiveService: setup.service,
    }),
    { envelope, receipt },
  );
  await assert.rejects(
    writeUiArtifactReceipt({ root: setup.root, receipt }),
    /UI artifact receipt already exists/u,
  );

  await assert.rejects(
    writeUiArtifactReceipt({
      root: setup.root,
      receipt: { ...receipt, completedAt: "not-a-timestamp" },
    }),
    /UI artifact receipt is invalid/u,
  );

  await writeFile(
    path.join(
      setup.root,
      "validation-artifacts/runs",
      RUN_ID,
      "ui/mobile-390.png",
    ),
    png(390, 900),
  );
  await assert.rejects(
    verifyUiArtifactReceipt({
      root: setup.root,
      envelope,
      expectedRunId: RUN_ID,
      expectedLiveService: setup.service,
    }),
    /UI artifacts no longer match their receipt/u,
  );
});

test("uses one exact CLI contract for the UI validation run identity", async () => {
  const {
    parseUiValidationCommandArguments,
    uiValidationCommandArguments,
  } = await loadReceiptModule();
  const service = liveService();
  const arguments_ = [
    "--run-id",
    RUN_ID,
    "--process-id",
    "2468",
    "--instance-id",
    RUN_ID,
    "--start-identity",
    "d".repeat(64),
    "--head-oid",
    "a".repeat(40),
    "--tree-oid",
    "b".repeat(40),
    "--runtime-digest",
    "c".repeat(64),
    "--runtime-file-count",
    "440",
    "--runtime-byte-count",
    "1234567",
  ];

  assert.deepEqual(
    uiValidationCommandArguments({ runId: RUN_ID, liveService: service }),
    arguments_,
  );
  assert.deepEqual(parseUiValidationCommandArguments(arguments_), {
    runId: RUN_ID,
    liveService: service,
    outputDirectory:
      `validation-artifacts/runs/${RUN_ID}/ui`,
  });
  assert.throws(
    () => parseUiValidationCommandArguments([...arguments_, "--extra"]),
    /UI validation command arguments are invalid/u,
  );
});
