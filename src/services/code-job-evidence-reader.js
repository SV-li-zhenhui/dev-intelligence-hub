import { createHash } from "node:crypto";

import { normalizeChangePackageManifest } from "../domain/change-package-contract.js";

const JOB_ID = /^code-job-[a-f0-9]{55}$/;
const PACKAGE_ID = /^change-package-[a-f0-9]{64}$/;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_KINDS = new Set(["output", "stdout", "stderr"]);

export class CodeJobEvidenceReaderError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "CodeJobEvidenceReaderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function evidenceError(code, message, statusCode) {
  return new CodeJobEvidenceReaderError(code, message, statusCode);
}

function invalidRequest() {
  return evidenceError(
    "INVALID_CODE_JOB_EVIDENCE_REQUEST",
    "代码任务测试证据请求无效",
    400,
  );
}

function evidenceNotFound() {
  return evidenceError(
    "CODE_JOB_EVIDENCE_NOT_FOUND",
    "代码任务测试证据不存在",
    404,
  );
}

function staleEvidence() {
  return evidenceError(
    "CODE_JOB_EVIDENCE_STALE",
    "代码任务测试证据绑定已变化",
    409,
  );
}

function unavailableEvidence() {
  return evidenceError(
    "CODE_JOB_EVIDENCE_UNAVAILABLE",
    "代码任务测试证据暂时不可用",
    503,
  );
}

function corruptedEvidence() {
  return evidenceError(
    "CODE_JOB_EVIDENCE_CORRUPTED",
    "代码任务测试证据完整性校验失败",
    500,
  );
}

function packageReadFailure(error) {
  return [
    "CHANGE_PACKAGE_NOT_FOUND",
    "CHANGE_PACKAGE_CORRUPTED",
    "INVALID_CHANGE_PACKAGE_REQUEST",
  ].includes(error?.code)
    ? corruptedEvidence()
    : unavailableEvidence();
}

function artifactReadFailure(error) {
  return [
    "ARTIFACT_CORRUPTED",
    "ARTIFACT_NOT_FOUND",
    "INVALID_ARTIFACT_REF",
  ].includes(error?.code)
    ? corruptedEvidence()
    : unavailableEvidence();
}

function dataFields(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw error;
  }
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function exactFields(value, expected, error) {
  const fields = dataFields(value, error);
  if (
    fields.size !== expected.length ||
    expected.some((key) => !fields.has(key))
  ) {
    throw error;
  }
  return fields;
}

function requiredFields(value, expected, error) {
  const fields = dataFields(value, error);
  if (expected.some((key) => !fields.has(key))) throw error;
  return fields;
}

function methodDescriptor(value, method) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return null;
  }
  let owner = value;
  while (
    owner !== null &&
    owner !== Object.prototype &&
    owner !== Function.prototype
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, method);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return null;
}

function bindPort(value, method, name) {
  const descriptor = methodDescriptor(value, method);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw new TypeError(`${name} is invalid`);
  }
  return (...args) => Reflect.apply(descriptor.value, value, args);
}

function normalizeRequest(value) {
  const error = invalidRequest();
  const fields = exactFields(
    value,
    [
      "jobId",
      "packageId",
      "packageDigest",
      "profileId",
      "kind",
      "expectedSha256",
    ],
    error,
  );
  const request = Object.fromEntries(fields);
  if (
    typeof request.jobId !== "string" ||
    !JOB_ID.test(request.jobId) ||
    typeof request.packageId !== "string" ||
    !PACKAGE_ID.test(request.packageId) ||
    typeof request.packageDigest !== "string" ||
    !SHA256.test(request.packageDigest) ||
    request.packageId !== `change-package-${request.packageDigest}` ||
    typeof request.profileId !== "string" ||
    !PROFILE_ID.test(request.profileId) ||
    !EVIDENCE_KINDS.has(request.kind) ||
    typeof request.expectedSha256 !== "string" ||
    !SHA256.test(request.expectedSha256)
  ) {
    throw error;
  }
  return Object.freeze(request);
}

function authoritativeReceipt(detail, request) {
  if (detail === null) throw evidenceNotFound();
  const detailFields = requiredFields(
    detail,
    ["job", "changePackage"],
    corruptedEvidence(),
  );
  const jobFields = requiredFields(
    detailFields.get("job"),
    ["jobId"],
    corruptedEvidence(),
  );
  if (jobFields.get("jobId") !== request.jobId) throw corruptedEvidence();

  const packageFields = requiredFields(
    detailFields.get("changePackage"),
    ["status", "receipt"],
    corruptedEvidence(),
  );
  if (packageFields.get("status") !== "ready") throw staleEvidence();
  const receiptFields = requiredFields(
    packageFields.get("receipt"),
    ["packageId", "packageDigest"],
    corruptedEvidence(),
  );
  if (
    receiptFields.get("packageId") !== request.packageId ||
    receiptFields.get("packageDigest") !== request.packageDigest
  ) {
    throw staleEvidence();
  }
}

function normalizeManifest(value) {
  try {
    return normalizeChangePackageManifest(value);
  } catch {
    throw corruptedEvidence();
  }
}

function manifestArtifact(manifest, request) {
  if (
    manifest.packageId !== request.packageId ||
    manifest.packageDigest !== request.packageDigest ||
    manifest.job.id !== request.jobId
  ) {
    throw staleEvidence();
  }
  const profile = manifest.passedProfiles.find(
    ({ id }) => id === request.profileId,
  );
  if (profile === undefined) throw evidenceNotFound();
  const artifact = profile.artifacts[request.kind];
  if (
    artifact.path !==
      `${request.jobId}/${profile.actionId}/${request.kind}.json` ||
    artifact.sha256 !== request.expectedSha256
  ) {
    throw staleEvidence();
  }
  return artifact;
}

function contentSha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export class CodeJobEvidenceReader {
  #getJobDetail;
  #getPackage;
  #readArtifact;

  constructor(value = {}) {
    const fields = exactFields(
      value,
      ["codeJobReader", "changePackageReader", "auditArtifactReader"],
      new TypeError("code job evidence reader options are invalid"),
    );
    this.#getJobDetail = bindPort(
      fields.get("codeJobReader"),
      "getDetail",
      "code job reader",
    );
    this.#getPackage = bindPort(
      fields.get("changePackageReader"),
      "get",
      "change package reader",
    );
    this.#readArtifact = bindPort(
      fields.get("auditArtifactReader"),
      "read",
      "audit artifact reader",
    );
  }

  async read(value) {
    const request = normalizeRequest(value);
    let detail;
    try {
      detail = await this.#getJobDetail({ jobId: request.jobId });
    } catch {
      throw unavailableEvidence();
    }
    authoritativeReceipt(detail, request);

    let suppliedManifest;
    try {
      suppliedManifest = await this.#getPackage(request.packageId);
    } catch (error) {
      throw packageReadFailure(error);
    }
    const manifest = normalizeManifest(suppliedManifest);
    const artifact = manifestArtifact(manifest, request);

    let suppliedContent;
    try {
      suppliedContent = await this.#readArtifact({
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      });
    } catch (error) {
      throw artifactReadFailure(error);
    }
    if (
      !Buffer.isBuffer(suppliedContent) ||
      suppliedContent.length !== artifact.bytes ||
      contentSha256(suppliedContent) !== artifact.sha256
    ) {
      throw corruptedEvidence();
    }
    const content = Buffer.from(suppliedContent);
    return Object.freeze({
      jobId: request.jobId,
      packageId: request.packageId,
      packageDigest: request.packageDigest,
      profileId: request.profileId,
      kind: request.kind,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      content,
    });
  }
}
