import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createChangePackage } from "../src/domain/change-package-contract.js";
import {
  CodeJobEvidenceReader,
  CodeJobEvidenceReaderError,
} from "../src/services/code-job-evidence-reader.js";

const JOB_ID = `code-job-${"a".repeat(55)}`;
const OTHER_JOB_ID = `code-job-${"b".repeat(55)}`;
const WORKSPACE_REVISION = "c".repeat(64);
const PROFILE_ID = "node-tests";
const ACTION_ID = "test-action-1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceContent() {
  return {
    output: Buffer.from('{"exitCode":0}\n'),
    stdout: Buffer.from('"tests passed\\n"\n'),
    stderr: Buffer.from('""\n'),
  };
}

function evidenceRef(jobId, actionId, kind, content, pathOverride) {
  return {
    path: pathOverride ?? `${jobId}/${actionId}/${kind}.json`,
    sha256: sha256(content),
    bytes: content.length,
  };
}

function createManifest({
  jobId = JOB_ID,
  profileId = PROFILE_ID,
  actionId = ACTION_ID,
  pathOverride,
} = {}) {
  const content = evidenceContent();
  const artifacts = Object.fromEntries(
    Object.entries(content).map(([kind, bytes]) => [
      kind,
      evidenceRef(jobId, actionId, kind, bytes, pathOverride?.[kind]),
    ]),
  );
  const manifest = createChangePackage({
    job: { id: jobId, revision: 8, recordDigest: "d".repeat(64) },
    proposal: { id: "proposal-1", contentDigest: "e".repeat(64) },
    grant: { digest: "f".repeat(64) },
    workspace: {
      id: "dashboard",
      sourceRevision: "1".repeat(64),
      workspaceRevision: WORKSPACE_REVISION,
    },
    passedProfiles: [{
      id: profileId,
      configDigest: "2".repeat(64),
      workspaceRevision: WORKSPACE_REVISION,
      actionId,
      attemptNumber: 1,
      imageId: `sha256:${"3".repeat(64)}`,
      artifacts,
    }],
    created: [],
    modified: [],
    deleted: [],
  }).manifest;
  return { manifest, content };
}

function requestFor(manifest, overrides = {}) {
  const profile = manifest.passedProfiles[0];
  const kind = overrides.kind ?? "stdout";
  return {
    jobId: manifest.job.id,
    packageId: manifest.packageId,
    packageDigest: manifest.packageDigest,
    profileId: profile.id,
    kind,
    expectedSha256: profile.artifacts[kind].sha256,
    ...overrides,
  };
}

function fixture({ manifest = createManifest().manifest, detail, read } = {}) {
  const calls = { details: [], packages: [], artifacts: [] };
  const readyDetail = detail === undefined ? {
    job: { jobId: manifest.job.id },
    changePackage: {
      status: "ready",
      receipt: {
        packageId: manifest.packageId,
        packageDigest: manifest.packageDigest,
        deliveredAt: "2026-08-03T01:00:00.000Z",
      },
    },
  } : detail;
  const contentByPath = new Map(
    Object.values(manifest.passedProfiles[0]?.artifacts ?? {}).map((artifact) => [
      artifact.path,
      evidenceContent()[artifact.path.slice(artifact.path.lastIndexOf("/") + 1, -5)],
    ]),
  );
  const reader = new CodeJobEvidenceReader({
    codeJobReader: {
      marker: "job-reader",
      async getDetail(value) {
        assert.equal(this.marker, "job-reader");
        calls.details.push(value);
        return readyDetail;
      },
    },
    changePackageReader: {
      marker: "package-reader",
      async get(value) {
        assert.equal(this.marker, "package-reader");
        calls.packages.push(value);
        return manifest;
      },
    },
    auditArtifactReader: {
      marker: "artifact-reader",
      async read(value) {
        assert.equal(this.marker, "artifact-reader");
        calls.artifacts.push(value);
        if (read) return read(value);
        return Buffer.from(contentByPath.get(value.path));
      },
    },
  });
  return { reader, calls };
}

function hasCode(code) {
  return (error) =>
    error instanceof CodeJobEvidenceReaderError && error.code === code;
}

test("reader returns exact immutable-bound evidence bytes for every public kind", async () => {
  const { manifest, content } = createManifest();
  const setup = fixture({ manifest });

  for (const kind of ["output", "stdout", "stderr"]) {
    const request = requestFor(manifest, { kind });
    const result = await setup.reader.read(request);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(result, {
      jobId: JOB_ID,
      packageId: manifest.packageId,
      packageDigest: manifest.packageDigest,
      profileId: PROFILE_ID,
      kind,
      sha256: manifest.passedProfiles[0].artifacts[kind].sha256,
      bytes: content[kind].length,
      content: content[kind],
    });
    assert.deepEqual(setup.calls.artifacts.at(-1), {
      ...manifest.passedProfiles[0].artifacts[kind],
    });
  }
  assert.deepEqual(setup.calls.details, [
    { jobId: JOB_ID },
    { jobId: JOB_ID },
    { jobId: JOB_ID },
  ]);
  assert.deepEqual(setup.calls.packages, [
    manifest.packageId,
    manifest.packageId,
    manifest.packageId,
  ]);
});

test("returned content cannot mutate the artifact reader's retained bytes", async () => {
  const { manifest, content } = createManifest();
  const retained = Buffer.from(content.stdout);
  const setup = fixture({ manifest, read: () => retained });
  const request = requestFor(manifest);

  const first = await setup.reader.read(request);
  first.content.fill(0);
  const second = await setup.reader.read(request);

  assert.deepEqual(second.content, content.stdout);
  assert.deepEqual(retained, content.stdout);
});

test("additive application projections do not invalidate the authoritative receipt", async () => {
  const { manifest, content } = createManifest();
  const setup = fixture({
    manifest,
    detail: {
      job: { jobId: JOB_ID, revision: 8 },
      changePackage: {
        status: "ready",
        receipt: {
          packageId: manifest.packageId,
          packageDigest: manifest.packageDigest,
          deliveredAt: "2026-08-03T01:00:00.000Z",
          applicationProjectionRevision: 4,
        },
        application: {
          status: "pending",
          confirmationId: "confirmation-change-package-1",
        },
      },
    },
  });

  const result = await setup.reader.read(requestFor(manifest));

  assert.deepEqual(result.content, content.stdout);
  assert.deepEqual(setup.calls.packages, [manifest.packageId]);
});

test("request shape, identifiers, kinds, and accessors fail closed", async () => {
  const { manifest } = createManifest();
  const setup = fixture({ manifest });
  const valid = requestFor(manifest);
  let getterCalls = 0;
  const accessor = { ...valid };
  Object.defineProperty(accessor, "jobId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return JOB_ID;
    },
  });

  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, jobId: "code-job-1" },
    { ...valid, packageDigest: "0".repeat(64) },
    { ...valid, profileId: "../profile" },
    { ...valid, kind: "input" },
    { ...valid, expectedSha256: "0".repeat(63) },
    accessor,
  ]) {
    await assert.rejects(
      setup.reader.read(invalid),
      hasCode("INVALID_CODE_JOB_EVIDENCE_REQUEST"),
    );
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(setup.calls.details, []);
});

test("the authoritative job receipt is required before package access", async () => {
  const { manifest } = createManifest();
  const request = requestFor(manifest);
  const missing = fixture({ manifest, detail: null });
  await assert.rejects(
    missing.reader.read(request),
    hasCode("CODE_JOB_EVIDENCE_NOT_FOUND"),
  );

  const pending = fixture({
    manifest,
    detail: {
      job: { jobId: JOB_ID },
      changePackage: { status: "pending", receipt: null },
    },
  });
  await assert.rejects(
    pending.reader.read(request),
    hasCode("CODE_JOB_EVIDENCE_STALE"),
  );

  const mismatched = fixture({
    manifest,
    detail: {
      job: { jobId: JOB_ID },
      changePackage: {
        status: "ready",
        receipt: {
          packageId: `change-package-${"4".repeat(64)}`,
          packageDigest: "4".repeat(64),
          deliveredAt: "2026-08-03T01:00:00.000Z",
        },
      },
    },
  });
  await assert.rejects(
    mismatched.reader.read(request),
    hasCode("CODE_JOB_EVIDENCE_STALE"),
  );
  assert.deepEqual(missing.calls.packages, []);
  assert.deepEqual(pending.calls.packages, []);
  assert.deepEqual(mismatched.calls.packages, []);
});

test("manifest job, profile, path, and expected digest stay bound to the request", async () => {
  const otherJob = createManifest({ jobId: OTHER_JOB_ID });
  const otherJobSetup = fixture({
    manifest: otherJob.manifest,
    detail: {
      job: { jobId: JOB_ID },
      changePackage: {
        status: "ready",
        receipt: {
          packageId: otherJob.manifest.packageId,
          packageDigest: otherJob.manifest.packageDigest,
          deliveredAt: "2026-08-03T01:00:00.000Z",
        },
      },
    },
  });
  await assert.rejects(
    otherJobSetup.reader.read({
      ...requestFor(otherJob.manifest),
      jobId: JOB_ID,
    }),
    hasCode("CODE_JOB_EVIDENCE_STALE"),
  );

  const wrongPath = createManifest({
    pathOverride: { stdout: `${JOB_ID}/other-action/stdout.json` },
  });
  await assert.rejects(
    fixture({ manifest: wrongPath.manifest }).reader.read(
      requestFor(wrongPath.manifest),
    ),
    hasCode("CODE_JOB_EVIDENCE_STALE"),
  );

  const { manifest } = createManifest();
  await assert.rejects(
    fixture({ manifest }).reader.read({
      ...requestFor(manifest),
      profileId: "missing-profile",
    }),
    hasCode("CODE_JOB_EVIDENCE_NOT_FOUND"),
  );
  await assert.rejects(
    fixture({ manifest }).reader.read({
      ...requestFor(manifest),
      expectedSha256: "5".repeat(64),
    }),
    hasCode("CODE_JOB_EVIDENCE_STALE"),
  );
});

test("artifact bytes are independently rechecked and errors do not expose paths", async () => {
  const { manifest } = createManifest();
  const request = requestFor(manifest);
  for (const supplied of [
    "not-a-buffer",
    Buffer.from("short\n"),
    Buffer.alloc(manifest.passedProfiles[0].artifacts.stdout.bytes, 0),
  ]) {
    await assert.rejects(
      fixture({ manifest, read: () => supplied }).reader.read(request),
      hasCode("CODE_JOB_EVIDENCE_CORRUPTED"),
    );
  }

  const privatePath = "C:\\Users\\private\\artifacts\\stdout.json";
  await assert.rejects(
    fixture({
      manifest,
      read() {
        throw new Error(`failed at ${privatePath}`);
      },
    }).reader.read(request),
    (error) =>
      hasCode("CODE_JOB_EVIDENCE_UNAVAILABLE")(error) &&
      !error.message.includes(privatePath) &&
      error.cause === undefined,
  );
});

test("dependency getters are rejected without invocation", () => {
  let getterCalls = 0;
  const codeJobReader = {};
  Object.defineProperty(codeJobReader, "getDetail", {
    get() {
      getterCalls += 1;
      return async () => null;
    },
  });
  assert.throws(
    () => new CodeJobEvidenceReader({
      codeJobReader,
      changePackageReader: { async get() {} },
      auditArtifactReader: { async read() {} },
    }),
    /code job reader is invalid/,
  );
  assert.equal(getterCalls, 0);
});
