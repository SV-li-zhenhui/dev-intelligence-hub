import { createHash, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const OBJECT_IDENTITY = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const MAXIMUM_ARTIFACT_BYTES = 64 * 1024 * 1024;
const REQUIRED_UI_SCENARIOS = Object.freeze([
  "desktop-1440",
  "mobile-390",
  "confirmation-queue",
  "code-job-control-package-desktop-1100",
  "code-job-control-package-mobile-390",
  "external-review-confirmation",
  "system-status-initial-error",
  "system-status-stale-error",
  "system-status-stale-success",
]);

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function runtimeSourceIdentity(value) {
  if (
    !hasExactKeys(value, [
      "clean",
      "headOid",
      "runtimeByteCount",
      "runtimeDigest",
      "runtimeFileCount",
      "schemaVersion",
      "treeOid",
    ]) ||
    value.schemaVersion !== 1 ||
    !OBJECT_IDENTITY.test(value.headOid) ||
    !OBJECT_IDENTITY.test(value.treeOid) ||
    value.clean !== true ||
    !SHA_256.test(value.runtimeDigest) ||
    !Number.isSafeInteger(value.runtimeFileCount) ||
    value.runtimeFileCount <= 0 ||
    !Number.isSafeInteger(value.runtimeByteCount) ||
    value.runtimeByteCount <= 0
  ) {
    throw new Error("UI artifact runtime source identity is invalid");
  }
  return Object.freeze(structuredClone(value));
}

function liveServiceIdentity(value) {
  if (
    !hasExactKeys(value, [
      "instanceId",
      "processId",
      "runtimeSource",
      "startIdentity",
    ]) ||
    !Number.isSafeInteger(value.processId) ||
    value.processId <= 0 ||
    !UUID_V4.test(value.instanceId) ||
    !SHA_256.test(value.startIdentity)
  ) {
    throw new Error("UI artifact live service identity is invalid");
  }
  return Object.freeze({
    processId: value.processId,
    instanceId: value.instanceId,
    startIdentity: value.startIdentity,
    runtimeSource: runtimeSourceIdentity(value.runtimeSource),
  });
}

export function uiValidationCommandArguments({ runId, liveService }) {
  if (!UUID_V4.test(runId)) throw new Error("UI artifact run identity is invalid");
  const service = liveServiceIdentity(liveService);
  const source = service.runtimeSource;
  return [
    "--run-id",
    runId,
    "--process-id",
    String(service.processId),
    "--instance-id",
    service.instanceId,
    "--start-identity",
    service.startIdentity,
    "--head-oid",
    source.headOid,
    "--tree-oid",
    source.treeOid,
    "--runtime-digest",
    source.runtimeDigest,
    "--runtime-file-count",
    String(source.runtimeFileCount),
    "--runtime-byte-count",
    String(source.runtimeByteCount),
  ];
}

export function parseUiValidationCommandArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 18) {
    throw new Error("UI validation command arguments are invalid");
  }
  const names = [
    "--run-id",
    "--process-id",
    "--instance-id",
    "--start-identity",
    "--head-oid",
    "--tree-oid",
    "--runtime-digest",
    "--runtime-file-count",
    "--runtime-byte-count",
  ];
  if (names.some((name, index) => arguments_[index * 2] !== name)) {
    throw new Error("UI validation command arguments are invalid");
  }
  const runId = arguments_[1];
  const processId = Number(arguments_[3]);
  const runtimeFileCount = Number(arguments_[15]);
  const runtimeByteCount = Number(arguments_[17]);
  const source = {
    schemaVersion: 1,
    headOid: arguments_[9],
    treeOid: arguments_[11],
    clean: true,
    runtimeDigest: arguments_[13],
    runtimeFileCount,
    runtimeByteCount,
  };
  if (
    !UUID_V4.test(runId) ||
    String(processId) !== arguments_[3] ||
    String(runtimeFileCount) !== arguments_[15] ||
    String(runtimeByteCount) !== arguments_[17]
  ) {
    throw new Error("UI validation command arguments are invalid");
  }
  let liveService;
  try {
    liveService = liveServiceIdentity({
      processId,
      instanceId: arguments_[5],
      startIdentity: arguments_[7],
      runtimeSource: source,
    });
  } catch {
    throw new Error("UI validation command arguments are invalid");
  }
  return {
    runId,
    liveService,
    outputDirectory: `validation-artifacts/runs/${runId}/ui`,
  };
}

async function canonicalRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new TypeError("UI artifact repository root is invalid");
  }
  try {
    const resolved = path.resolve(root);
    const supplied = await lstat(resolved, { bigint: true });
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) {
      throw new Error("invalid root");
    }
    return await realpath(resolved);
  } catch {
    throw new Error("UI artifact repository root is invalid");
  }
}

function directoryIdentity(metadata) {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
  };
}

function sameDirectoryIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode
  );
}

async function inspectSafeDirectoryChain(root, segments) {
  const chain = [];
  let current = root;
  try {
    for (const segment of segments) {
      current = path.join(current, segment);
      const metadata = await lstat(current, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("unsafe directory");
      }
      chain.push(Object.freeze({
        path: current,
        identity: Object.freeze(directoryIdentity(metadata)),
      }));
    }
  } catch {
    throw new Error("UI artifact directory is unsafe");
  }
  return Object.freeze({ directory: current, chain: Object.freeze(chain) });
}

async function assertDirectoryChainUnchanged(snapshot) {
  try {
    for (const entry of snapshot.chain) {
      const metadata = await lstat(entry.path, { bigint: true });
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        !sameDirectoryIdentity(entry.identity, directoryIdentity(metadata))
      ) {
        throw new Error("changed directory");
      }
    }
  } catch {
    throw new Error("UI artifact directory changed during publication");
  }
}

async function syncDirectory(directory) {
  let handle = null;
  try {
    handle = await open(directory, fileConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)
    ) {
      return;
    }
    throw new Error("UI artifact directory could not be synchronized");
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
  }
}

export async function prepareUiArtifactDirectory({ root, runId }) {
  if (!UUID_V4.test(runId)) throw new Error("UI artifact run identity is invalid");
  const repositoryRoot = await canonicalRoot(root);
  const segments = ["validation-artifacts", "runs", runId, "ui"];
  let current = repositoryRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let created = false;
    try {
      await mkdir(current);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new Error("UI artifact directory could not be created");
      }
    }
    const inspected = await inspectSafeDirectoryChain(
      repositoryRoot,
      segments.slice(0, index + 1),
    );
    if (!created && index === segments.length - 1) {
      throw new Error("UI artifact run directory already exists");
    }
    current = inspected.directory;
  }
  const prepared = await inspectSafeDirectoryChain(repositoryRoot, segments);
  return Object.freeze({
    directory: prepared.directory,
    relativeDirectory: segments.join("/"),
  });
}

export async function prepareValidationRunDirectory({ root, runId }) {
  if (!UUID_V4.test(runId)) throw new Error("validation run identity is invalid");
  const repositoryRoot = await canonicalRoot(root);
  const segments = ["validation-artifacts", "runs", runId];
  let current = repositoryRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let created = false;
    try {
      await mkdir(current);
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new Error("validation run directory could not be created");
      }
    }
    await inspectSafeDirectoryChain(
      repositoryRoot,
      segments.slice(0, index + 1),
    );
    if (!created && index === segments.length - 1) {
      throw new Error("validation run directory already exists");
    }
  }
  const prepared = await inspectSafeDirectoryChain(repositoryRoot, segments);
  return Object.freeze({
    directory: prepared.directory,
    relativeDirectory: segments.join("/"),
  });
}

function metadataSnapshot(metadata) {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    links: metadata.nlink,
    size: metadata.size,
    modified: metadata.mtimeNs,
    changed: metadata.ctimeNs,
  };
}

function sameMetadata(left, right) {
  return Object.keys(left).every((field) => left[field] === right[field]);
}

async function readArtifact(root, relativePath) {
  const segments = relativePath.split("/");
  let current = root;
  const ancestors = [];
  try {
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const metadata = await lstat(current, { bigint: true });
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("unsafe ancestor");
      }
      ancestors.push({ path: current, metadata: metadataSnapshot(metadata) });
    }
    const absolutePath = path.join(root, ...segments);
    const pathMetadata = await lstat(absolutePath, { bigint: true });
    if (
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile() ||
      pathMetadata.nlink !== 1n ||
      pathMetadata.size < 1n ||
      pathMetadata.size > BigInt(MAXIMUM_ARTIFACT_BYTES)
    ) {
      throw new Error("unsafe artifact");
    }
    const initial = metadataSnapshot(pathMetadata);
    const flags = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0);
    const handle = await open(absolutePath, flags);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameMetadata(initial, metadataSnapshot(opened))) {
        throw new Error("changed artifact");
      }
      const contents = await handle.readFile();
      const finished = await handle.stat({ bigint: true });
      const finalPath = await lstat(absolutePath, { bigint: true });
      if (
        !sameMetadata(initial, metadataSnapshot(finished)) ||
        !sameMetadata(initial, metadataSnapshot(finalPath)) ||
        contents.length !== Number(finished.size)
      ) {
        throw new Error("changed artifact");
      }
      for (const ancestor of ancestors) {
        const metadata = await lstat(ancestor.path, { bigint: true });
        if (
          metadata.isSymbolicLink() ||
          !metadata.isDirectory() ||
          metadata.dev !== ancestor.metadata.device ||
          metadata.ino !== ancestor.metadata.inode ||
          metadata.mode !== ancestor.metadata.mode
        ) {
          throw new Error("changed ancestor");
        }
      }
      return Object.freeze({
        path: relativePath,
        bytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        contents,
      });
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    throw new Error(`UI artifact is unavailable or unsafe: ${relativePath}`);
  }
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

function pngDimensions(contents, label) {
  if (
    contents.length < 57 ||
    !contents.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error(`${label} is not a complete PNG image`);
  }
  let offset = PNG_SIGNATURE.length;
  let dimensions = null;
  let hasImageData = false;
  let ended = false;
  while (offset < contents.length) {
    if (offset + 12 > contents.length) {
      throw new Error(`${label} has a truncated PNG chunk`);
    }
    const length = contents.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > contents.length) {
      throw new Error(`${label} has a truncated PNG chunk`);
    }
    const typeBytes = contents.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = contents.subarray(offset + 8, offset + 8 + length);
    if (
      contents.readUInt32BE(offset + 8 + length) !==
      crc32(Buffer.concat([typeBytes, data]))
    ) {
      throw new Error(`${label} has an invalid PNG checksum`);
    }
    if (dimensions === null) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error(`${label} has no leading PNG header`);
      }
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      if (
        width === 0 ||
        height === 0 ||
        data[8] !== 8 ||
        ![0, 2, 3, 4, 6].includes(data[9]) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        ![0, 1].includes(data[12])
      ) {
        throw new Error(`${label} has an unsupported PNG header`);
      }
      dimensions = { width, height };
    } else if (type === "IHDR") {
      throw new Error(`${label} has duplicate PNG headers`);
    }
    if (type === "IDAT" && length > 0) hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== contents.length) {
        throw new Error(`${label} has an invalid PNG terminator`);
      }
      ended = true;
    }
    offset = end;
  }
  if (!dimensions || !hasImageData || !ended) {
    throw new Error(`${label} is not a complete PNG image`);
  }
  return dimensions;
}

function validateResults(contents, runId, liveService) {
  let results;
  try {
    results = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error("UI results are not valid JSON");
  }
  if (
    !hasExactKeys(results, [
      "details",
      "liveService",
      "runId",
      "scenarios",
      "schemaVersion",
      "status",
    ]) ||
    results.schemaVersion !== 1 ||
    results.runId !== runId ||
    results.status !== "passed" ||
    JSON.stringify(results.liveService) !== JSON.stringify(liveService) ||
    !Array.isArray(results.scenarios) ||
    results.scenarios.length !== REQUIRED_UI_SCENARIOS.length ||
    !Array.isArray(results.details) ||
    results.details.length !== REQUIRED_UI_SCENARIOS.length
  ) {
    throw new Error("UI results do not match the validation run");
  }
  for (let index = 0; index < REQUIRED_UI_SCENARIOS.length; index += 1) {
    const expectedName = REQUIRED_UI_SCENARIOS[index];
    const scenario = results.scenarios[index];
    if (
      !hasExactKeys(scenario, [
        "accessibilityFailures",
        "consoleErrors",
        "horizontalOverflow",
        "name",
        "pageErrors",
        "status",
      ]) ||
      scenario.name !== expectedName ||
      scenario.status !== "passed" ||
      scenario.consoleErrors !== 0 ||
      scenario.pageErrors !== 0 ||
      scenario.horizontalOverflow !== false ||
      scenario.accessibilityFailures !== 0 ||
      results.details[index]?.name !== expectedName
    ) {
      throw new Error("UI results contain an incomplete or failed scenario");
    }
  }
}

export async function buildUiArtifactReceipt({
  root,
  runId,
  liveService,
  completedAt,
}) {
  if (!UUID_V4.test(runId)) throw new Error("UI artifact run identity is invalid");
  if (!isCanonicalTimestamp(completedAt)) {
    throw new Error("UI artifact completion time is invalid");
  }
  const service = liveServiceIdentity(liveService);
  const repositoryRoot = await canonicalRoot(root);
  const relativeDirectory = `validation-artifacts/runs/${runId}/ui`;
  const results = await readArtifact(
    repositoryRoot,
    `${relativeDirectory}/results.json`,
  );
  validateResults(results.contents, runId, service);
  const desktop = await readArtifact(
    repositoryRoot,
    `${relativeDirectory}/desktop-1440.png`,
  );
  const mobile = await readArtifact(
    repositoryRoot,
    `${relativeDirectory}/mobile-390.png`,
  );
  const desktopImage = pngDimensions(desktop.contents, "desktop screenshot");
  const mobileImage = pngDimensions(mobile.contents, "mobile screenshot");
  if (desktopImage.width !== 1440 || desktopImage.height < 1000) {
    throw new Error("desktop screenshot dimensions are incomplete");
  }
  if (mobileImage.width !== 390 || mobileImage.height < 844) {
    throw new Error("mobile screenshot dimensions are incomplete");
  }

  return Object.freeze({
    schemaVersion: 1,
    runId,
    status: "passed",
    completedAt,
    liveService: service,
    scenarios: [...REQUIRED_UI_SCENARIOS],
    artifacts: [
      {
        kind: "results",
        path: results.path,
        bytes: results.bytes,
        sha256: results.sha256,
      },
      {
        kind: "desktop-screenshot",
        path: desktop.path,
        bytes: desktop.bytes,
        sha256: desktop.sha256,
        image: desktopImage,
      },
      {
        kind: "mobile-screenshot",
        path: mobile.path,
        bytes: mobile.bytes,
        sha256: mobile.sha256,
        image: mobileImage,
      },
    ],
  });
}

function assertReceiptShape(receipt) {
  if (
    !hasExactKeys(receipt, [
      "artifacts",
      "completedAt",
      "liveService",
      "runId",
      "scenarios",
      "schemaVersion",
      "status",
    ]) ||
    receipt.schemaVersion !== 1 ||
    !UUID_V4.test(receipt.runId) ||
    receipt.status !== "passed" ||
    !isCanonicalTimestamp(receipt.completedAt) ||
    !Array.isArray(receipt.scenarios) ||
    receipt.scenarios.length !== REQUIRED_UI_SCENARIOS.length ||
    receipt.scenarios.some(
      (scenario, index) => scenario !== REQUIRED_UI_SCENARIOS[index],
    ) ||
    !Array.isArray(receipt.artifacts) ||
    receipt.artifacts.length !== 3
  ) {
    throw new Error("UI artifact receipt is invalid");
  }
  liveServiceIdentity(receipt.liveService);
}

export async function writeUiArtifactReceipt({ root, receipt }) {
  assertReceiptShape(receipt);
  const repositoryRoot = await canonicalRoot(root);
  const parentSegments = ["validation-artifacts", "runs", receipt.runId];
  const parentBeforePublication = await inspectSafeDirectoryChain(
    repositoryRoot,
    parentSegments,
  );
  const relativePath =
    `validation-artifacts/runs/${receipt.runId}/ui-receipt.json`;
  const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.ui-receipt.${randomUUID()}.tmp`,
  );
  const contents = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  let handle = null;
  let temporaryExists = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(temporaryPath, absolutePath);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("UI artifact receipt already exists");
      }
      throw new Error("UI artifact receipt could not be published");
    }
    await unlink(temporaryPath);
    temporaryExists = false;
    await syncDirectory(parentBeforePublication.directory);
    await assertDirectoryChainUnchanged(parentBeforePublication);
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    if (temporaryExists) await unlink(temporaryPath).catch(() => {});
  }
  const published = await readArtifact(repositoryRoot, relativePath);
  if (
    published.bytes !== contents.length ||
    !published.contents.equals(contents)
  ) {
    throw new Error("UI artifact receipt changed during publication");
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: receipt.runId,
    path: relativePath,
    bytes: published.bytes,
    sha256: published.sha256,
  });
}

export async function verifyUiArtifactReceipt({
  root,
  envelope,
  expectedRunId,
  expectedLiveService,
}) {
  const service = liveServiceIdentity(expectedLiveService);
  const expectedPath =
    `validation-artifacts/runs/${expectedRunId}/ui-receipt.json`;
  if (
    !UUID_V4.test(expectedRunId) ||
    !hasExactKeys(envelope, [
      "bytes",
      "path",
      "runId",
      "schemaVersion",
      "sha256",
    ]) ||
    envelope.schemaVersion !== 1 ||
    envelope.runId !== expectedRunId ||
    envelope.path !== expectedPath ||
    !Number.isSafeInteger(envelope.bytes) ||
    envelope.bytes <= 0 ||
    !SHA_256.test(envelope.sha256)
  ) {
    throw new Error("UI artifact receipt envelope is invalid");
  }
  const repositoryRoot = await canonicalRoot(root);
  const receiptFile = await readArtifact(repositoryRoot, expectedPath);
  if (
    receiptFile.bytes !== envelope.bytes ||
    receiptFile.sha256 !== envelope.sha256
  ) {
    throw new Error("UI artifact receipt envelope does not match its file");
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptFile.contents.toString("utf8"));
    assertReceiptShape(receipt);
  } catch {
    throw new Error("UI artifact receipt file is invalid");
  }
  if (
    receipt.runId !== expectedRunId ||
    JSON.stringify(receipt.liveService) !== JSON.stringify(service)
  ) {
    throw new Error("UI artifact receipt does not match the validation run");
  }
  let rebuilt;
  try {
    rebuilt = await buildUiArtifactReceipt({
      root: repositoryRoot,
      runId: expectedRunId,
      liveService: service,
      completedAt: receipt.completedAt,
    });
  } catch {
    throw new Error("UI artifacts no longer match their receipt");
  }
  if (JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
    throw new Error("UI artifacts no longer match their receipt");
  }
  return Object.freeze({
    envelope: Object.freeze(structuredClone(envelope)),
    receipt: rebuilt,
  });
}
