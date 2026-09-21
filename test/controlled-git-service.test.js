import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createConflictPreparationBinding,
} from "../src/domain/conflict-preparation-binding.js";
import {
  ControlledGitService,
  ControlledGitServiceError,
} from "../src/services/controlled-git-service.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
const TREE = "d".repeat(40);
const ANCESTOR_CONTENT = Buffer.from("const value = 'old';\n");
const OURS_CONTENT = Buffer.from("const value = 'head';\n");
const THEIRS_CONTENT = Buffer.from("const value = 'base';\n");
const README_CONTENT = Buffer.from("# Example\n");
const RESULT_CONFLICT_CONTENT = Buffer.from(
  "<<<<<<< HEAD\nconst value = 'head';\n=======\n" +
    "const value = 'base';\n>>>>>>> BASE\n",
);
const blobOid = (bytes) =>
  createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
const ANCESTOR = blobOid(ANCESTOR_CONTENT);
const OURS = blobOid(OURS_CONTENT);
const THEIRS = blobOid(THEIRS_CONTENT);
const RESULT_CONFLICT = blobOid(RESULT_CONFLICT_CONTENT);
const README = blobOid(README_CONTENT);

function gitTarget() {
  return {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: BASE,
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: HEAD,
  };
}

function processResult(stdout, overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    truncated: false,
    ...overrides,
  };
}

function conflictProtocol({ pathName = "src/value.js", mode = "100644" } = {}) {
  return Buffer.from(
    `${TREE}\0${mode} ${ANCESTOR} 1\t${pathName}\0` +
      `${mode} ${OURS} 2\t${pathName}\0` +
      `${mode} ${THEIRS} 3\t${pathName}\0`,
  );
}

function rawModification(fromOid, toOid, pathName = "src/value.js") {
  return Buffer.from(
    `:100644 100644 ${fromOid} ${toOid} M\0${pathName}\0`,
  );
}

function resultTreeProtocol({ mode = "100644", type = "blob" } = {}) {
  return Buffer.from(
    `${mode} ${type} ${README}\tREADME.md\0` +
      `100644 blob ${RESULT_CONFLICT}\tsrc/value.js\0`,
  );
}

async function fixture(t, {
  mergeOutput = conflictProtocol(),
  mergeExitCode = 1,
  headRaw = rawModification(ANCESTOR, OURS),
  baseRaw = rawModification(ANCESTOR, THEIRS),
  headNumstat = Buffer.from("1\t1\tsrc/value.js\0"),
  baseNumstat = Buffer.from("1\t1\tsrc/value.js\0"),
  treeOutput = resultTreeProtocol(),
  mutateGitDuringRun = false,
  mergeBaseOutput = Buffer.from(`${MERGE_BASE}\n`),
  mergeBaseExitCode = 0,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "controlled-git-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preparationRoot = path.resolve(root, "preparations");
  const baseMirrorRoot = path.resolve(root, "base.git");
  const headMirrorRoot = path.resolve(root, "head.git");
  const gitCommand = path.resolve(
    root,
    process.platform === "win32" ? "mingw64/bin/git.exe" : "bin/git",
  );
  for (const directory of [
    preparationRoot,
    path.join(baseMirrorRoot, "objects"),
    path.join(headMirrorRoot, "objects"),
    path.dirname(gitCommand),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(gitCommand, "fake git");
  if (process.platform !== "win32") await chmod(gitCommand, 0o755);

  const boundaries = new Map([
    [
      baseMirrorRoot,
      {
        schemaVersion: 1,
        repository: "acme/repo",
        canonicalRoot: baseMirrorRoot,
        objectDirectory: path.join(baseMirrorRoot, "objects"),
        objectFormat: "sha1",
        oidLength: 40,
        commitOid: BASE,
        boundaryDigest: "4".repeat(64),
      },
    ],
    [
      headMirrorRoot,
      {
        schemaVersion: 1,
        repository: "contributor/repo",
        canonicalRoot: headMirrorRoot,
        objectDirectory: path.join(headMirrorRoot, "objects"),
        objectFormat: "sha1",
        oidLength: 40,
        commitOid: HEAD,
        boundaryDigest: "5".repeat(64),
      },
    ],
  ]);
  const mirrorInspector = {
    calls: [],
    async preflight(request) {
      this.calls.push(structuredClone(request));
      return structuredClone(boundaries.get(path.resolve(request.mirrorRoot)));
    },
  };
  const blobs = new Map([
    [ANCESTOR, ANCESTOR_CONTENT],
    [OURS, OURS_CONTENT],
    [THEIRS, THEIRS_CONTENT],
    [README, README_CONTENT],
    [RESULT_CONFLICT, RESULT_CONFLICT_CONTENT],
  ]);
  const processRunner = {
    calls: [],
    async run(request) {
      this.calls.push(structuredClone(request));
      if (request.args.includes("merge-base")) {
        return processResult(mergeBaseOutput, { exitCode: mergeBaseExitCode });
      }
      if (request.args.includes("diff-tree")) {
        return processResult(request.args.includes(HEAD) ? headRaw : baseRaw);
      }
      if (request.args.includes("--numstat")) {
        return processResult(
          request.args.includes(HEAD) ? headNumstat : baseNumstat,
        );
      }
      if (request.args.includes("merge-tree")) {
        if (mutateGitDuringRun) await writeFile(gitCommand, "changed fake git");
        return processResult(mergeOutput, { exitCode: mergeExitCode });
      }
      if (request.args.includes("ls-tree")) {
        return processResult(treeOutput);
      }
      const catFile = request.args.indexOf("cat-file");
      if (catFile !== -1) {
        return processResult(blobs.get(request.args[catFile + 2]));
      }
      throw new Error(`unexpected Git invocation: ${request.args.join(" ")}`);
    },
  };
  const createService = (overrides = {}) =>
    new ControlledGitService({
      gitCommand,
      mirrorInspector,
      preparationRoot,
      processRunner,
      ...overrides,
    });
  return {
    root,
    preparationRoot,
    baseMirrorRoot,
    headMirrorRoot,
    gitCommand,
    boundaries,
    mirrorInspector,
    processRunner,
    createService,
  };
}

function inspectionRequest(setup) {
  return {
    gitTarget: gitTarget(),
    baseMirrorRoot: setup.baseMirrorRoot,
    headMirrorRoot: setup.headMirrorRoot,
  };
}

test("seals a both-modified conflict behind fixed Git commands and a content manifest", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();

  const first = await service.inspectConflict(inspectionRequest(setup));
  const replay = await service.inspectConflict(inspectionRequest(setup));

  assert.equal(first.status, "conflicted");
  assert.equal(first.mergeBaseOid, MERGE_BASE);
  assert.equal(first.resultTreeOid, TREE);
  assert.deepEqual(first.conflicts, [{ path: "src/value.js", mode: "100644" }]);
  assert.match(first.preparationId, /^[a-f0-9]{64}$/u);
  assert.equal(replay.preparationId, first.preparationId);

  const allArguments = setup.processRunner.calls.flatMap(({ args }) => args);
  for (const command of [
    "merge-base",
    "diff-tree",
    "--numstat",
    "merge-tree",
    "ls-tree",
    "cat-file",
  ]) {
    assert.ok(allArguments.includes(command), `missing ${command}`);
  }
  assert.equal(allArguments.includes("fetch"), false);
  assert.equal(allArguments.includes("update-ref"), false);
  for (const call of setup.processRunner.calls) {
    assert.equal(call.command, path.resolve(setup.root, process.platform === "win32" ? "mingw64/bin/git.exe" : "bin/git"));
    const longPathsConfig = call.args.indexOf("core.longpaths=true");
    assert.notEqual(longPathsConfig, -1);
    assert.equal(call.args[longPathsConfig - 1], "-c");
    assert.equal(call.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(call.env.GIT_NO_LAZY_FETCH, "1");
    assert.ok(call.env.GIT_OBJECT_DIRECTORY.startsWith(setup.preparationRoot));
    assert.ok(call.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.includes(path.join(setup.baseMirrorRoot, "objects")));
    assert.ok(call.env.GIT_ALTERNATE_OBJECT_DIRECTORIES.includes(path.join(setup.headMirrorRoot, "objects")));
    assert.equal(call.cwd.startsWith(setup.preparationRoot), true);
  }
  assert.equal(setup.mirrorInspector.calls.length, 8);
  assert.deepEqual(setup.mirrorInspector.calls[0], {
    repository: "acme/repo",
    mirrorRoot: setup.baseMirrorRoot,
    expectedCommitOid: BASE,
  });
  assert.deepEqual(setup.mirrorInspector.calls[1], {
    repository: "contributor/repo",
    mirrorRoot: setup.headMirrorRoot,
    expectedCommitOid: HEAD,
  });
});

test("rejects widened/accessor/proxy requests and unsafe merge protocols", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  await assert.rejects(
    service.inspectConflict({ ...inspectionRequest(setup), fetch: true }),
    (error) => error?.code === "INVALID_CONTROLLED_GIT_REQUEST",
  );

  let reads = 0;
  const accessor = {
    gitTarget: gitTarget(),
    baseMirrorRoot: setup.baseMirrorRoot,
  };
  Object.defineProperty(accessor, "headMirrorRoot", {
    enumerable: true,
    get() {
      reads += 1;
      return setup.headMirrorRoot;
    },
  });
  await assert.rejects(service.inspectConflict(accessor));
  assert.equal(reads, 0);

  const proxy = new Proxy(inspectionRequest(setup), {
    ownKeys() {
      throw new Error("proxy trap must not run");
    },
  });
  await assert.rejects(service.inspectConflict(proxy));
  assert.equal(setup.processRunner.calls.length, 0);

  const unsafe = await fixture(t, {
    mergeOutput: conflictProtocol({ mode: "120000" }),
  });
  await assert.rejects(
    unsafe.createService().inspectConflict(inspectionRequest(unsafe)),
    (error) =>
      error instanceof ControlledGitServiceError &&
      error.code === "CONTROLLED_GIT_UNSUPPORTED_CONFLICT",
  );
});

test("verification survives restart and detects manifest or mirror-boundary tampering", async (t) => {
  const setup = await fixture(t);
  const prepared = await setup.createService().inspectConflict(inspectionRequest(setup));
  const restarted = setup.createService();

  const verified = await restarted.verifyPreparation({
    preparationId: prepared.preparationId,
  });
  assert.equal(verified.preparationId, prepared.preparationId);

  setup.boundaries.get(setup.baseMirrorRoot).boundaryDigest = "6".repeat(64);
  await assert.rejects(
    restarted.verifyPreparation({ preparationId: prepared.preparationId }),
    (error) => error?.code === "CONTROLLED_GIT_BOUNDARY_CHANGED",
  );
  setup.boundaries.get(setup.baseMirrorRoot).boundaryDigest = "4".repeat(64);

  const manifestPath = path.join(
    setup.preparationRoot,
    "preparations",
    prepared.preparationId,
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.conflicts[0].stages[1].sha256 = "9".repeat(64);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(
    restarted.verifyPreparation({ preparationId: prepared.preparationId }),
    (error) => error?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED",
  );
});

test("verifies and materializes only the complete sealed conflict binding", async (t) => {
  const setup = await fixture(t);
  const prepared = await setup.createService().inspectConflict(
    inspectionRequest(setup),
  );
  const binding = createConflictPreparationBinding({
    preparation: prepared,
    gitTarget: gitTarget(),
  });
  const restarted = setup.createService();

  assert.deepEqual(
    await restarted.verifyConflictPreparation({ binding }),
    binding,
  );

  const mismatchedBindings = [
    {
      ...binding,
      gitTarget: {
        ...binding.gitTarget,
        sourceAccountId: "other-user",
      },
    },
    { ...binding, resultTreeOid: "9".repeat(40) },
    { ...binding, boundaryDigest: "8".repeat(64) },
    { ...binding, evidenceDigest: "7".repeat(64) },
    { ...binding, resultObjectDigest: "6".repeat(64) },
    {
      ...binding,
      conflicts: [{ path: "src/other.js", mode: "100644" }],
    },
  ];
  for (const [index, changed] of mismatchedBindings.entries()) {
    const rejectedTargetRoot = path.resolve(
      setup.root,
      `rejected-bound-code-job-${index}`,
    );
    await mkdir(rejectedTargetRoot);
    await assert.rejects(
      restarted.materializeConflictPreparationForCodeJob({
        binding: changed,
        targetRoot: rejectedTargetRoot,
        excludePaths: [],
      }),
      (error) =>
        error?.code === "CONTROLLED_GIT_PREPARATION_BINDING_MISMATCH",
    );
    assert.deepEqual(await readdir(rejectedTargetRoot), []);
  }

  const targetRoot = path.resolve(setup.root, "bound-code-job");
  await mkdir(targetRoot);
  const receipt = await restarted.materializeConflictPreparationForCodeJob({
    binding,
    targetRoot,
    excludePaths: [],
  });
  assert.deepEqual(receipt.binding, binding);
  assert.equal(receipt.preparationId, binding.preparationId);
  assert.equal(receipt.resultTreeOid, binding.resultTreeOid);
  assert.equal(receipt.evidenceDigest, binding.evidenceDigest);
  assert.equal(receipt.resultObjectDigest, binding.resultObjectDigest);
  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(receipt.excludePaths, []);
  assert.deepEqual(
    receipt.files.map(({ path: relativePath, mode }) => ({
      path: relativePath,
      mode,
    })),
    [
      { path: "README.md", mode: "100644" },
      { path: "src/value.js", mode: "100644" },
    ],
  );
  assert.equal(
    await readFile(path.join(targetRoot, "src", "value.js"), "utf8"),
    RESULT_CONFLICT_CONTENT.toString("utf8"),
  );

  const cleanSetup = await fixture(t, {
    mergeOutput: Buffer.from(`${TREE}\0`),
    mergeExitCode: 0,
  });
  const cleanService = cleanSetup.createService();
  const cleanPrepared = await cleanService.inspectConflict(
    inspectionRequest(cleanSetup),
  );
  assert.equal(cleanPrepared.status, "clean");
  const cleanTargetRoot = path.resolve(
    cleanSetup.root,
    "rejected-clean-code-job",
  );
  await mkdir(cleanTargetRoot);
  await assert.rejects(
    cleanService.materializeConflictPreparationForCodeJob({
      binding: { ...binding, preparationId: cleanPrepared.preparationId },
      targetRoot: cleanTargetRoot,
      excludePaths: [],
    }),
    (error) => error?.code === "CONTROLLED_GIT_PREPARATION_BINDING_MISMATCH",
  );
  assert.deepEqual(await readdir(cleanTargetRoot), []);
});

test("materializes fixed-label conflict evidence into a new empty code-job target", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  const prepared = await service.inspectConflict(inspectionRequest(setup));
  const targetRoot = path.resolve(setup.root, "code-job");
  await mkdir(targetRoot);

  const receipt = await service.materializeForCodeJob({
    preparationId: prepared.preparationId,
    targetRoot,
  });

  assert.equal(receipt.materialization, "full-tree");
  assert.equal(receipt.residual, null);
  assert.match(receipt.resultObjectDigest, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.fileCount, 2);
  assert.deepEqual(receipt.excludePaths, []);
  assert.deepEqual(
    receipt.files.map(({ path: relativePath, sha256, mode, bytes }) => ({
      path: relativePath,
      sha256,
      mode,
      bytes,
    })),
    [
      {
        path: "README.md",
        sha256: createHash("sha256").update("# Example\n").digest("hex"),
        mode: "100644",
        bytes: Buffer.byteLength("# Example\n"),
      },
      {
        path: "src/value.js",
        sha256: createHash("sha256")
          .update(RESULT_CONFLICT_CONTENT)
          .digest("hex"),
        mode: "100644",
        bytes: RESULT_CONFLICT_CONTENT.length,
      },
    ],
  );
  assert.deepEqual((await readdir(targetRoot)).sort(), ["README.md", "src"]);
  assert.equal(await readFile(path.join(targetRoot, "README.md"), "utf8"), "# Example\n");
  assert.equal(
    await readFile(path.join(targetRoot, "src", "value.js"), "utf8"),
    "<<<<<<< HEAD\n" +
      "const value = 'head';\n" +
      "=======\n" +
      "const value = 'base';\n" +
      ">>>>>>> BASE\n",
  );

  const filteredRoot = path.resolve(setup.root, "filtered-code-job");
  await mkdir(filteredRoot);
  const filtered = await service.materializeForCodeJob({
    preparationId: prepared.preparationId,
    targetRoot: filteredRoot,
    excludePaths: ["README.md"],
  });
  assert.deepEqual(filtered.excludePaths, ["README.md"]);
  assert.deepEqual(filtered.files.map((entry) => entry.path), ["src/value.js"]);
  await assert.rejects(
    access(path.join(filteredRoot, "README.md")),
    (error) => error?.code === "ENOENT",
  );
  await assert.rejects(access(path.join(targetRoot, ".git")), { code: "ENOENT" });
  await assert.rejects(
    service.materializeForCodeJob({
      preparationId: prepared.preparationId,
      targetRoot,
    }),
    (error) => error?.code === "CONTROLLED_GIT_TARGET_UNAVAILABLE",
  );
});

test("never reports materialization success after a target-root swap or junction replacement", async (t) => {
  const treeRecords = [];
  for (let index = 0; index < 256; index += 1) {
    treeRecords.push(
      `100644 blob ${README}\tfiles/${String(index).padStart(4, "0")}.txt\0`,
    );
  }
  treeRecords.push(`100644 blob ${RESULT_CONFLICT}\tsrc/value.js\0`);
  const setup = await fixture(t, {
    treeOutput: Buffer.from(treeRecords.join("")),
  });
  const service = setup.createService();
  const prepared = await service.inspectConflict(inspectionRequest(setup));
  const targetRoot = path.join(setup.root, "swap-target");
  const displacedRoot = path.join(setup.root, "swap-target-displaced");
  const replacementRoot = path.join(setup.root, "swap-target-replacement");
  await mkdir(targetRoot);
  await mkdir(replacementRoot);

  const materialization = service
    .materializeForCodeJob({
      preparationId: prepared.preparationId,
      targetRoot,
    })
    .then(
      (receipt) => ({ receipt }),
      (error) => ({ error }),
    );
  const swapAttempt = (async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const entries = await readdir(targetRoot).catch(() => []);
      if (entries.some((entry) => entry.startsWith(".code-broker-tmp-"))) {
        try {
          await rename(targetRoot, displacedRoot);
          await symlink(
            replacementRoot,
            targetRoot,
            process.platform === "win32" ? "junction" : "dir",
          );
          return { sawLease: true, swapped: true };
        } catch (error) {
          return { sawLease: true, swapped: false, error };
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { sawLease: false, swapped: false };
  })();

  const [outcome, attempted] = await Promise.all([materialization, swapAttempt]);
  assert.equal(attempted.sawLease, true);
  if (attempted.swapped) {
    assert.equal(outcome.receipt, undefined);
    assert.ok(
      [
        "CONTROLLED_GIT_TARGET_CHANGED",
        "CONTROLLED_GIT_CLEANUP_FAILED",
      ].includes(outcome.error?.code),
    );
  } else {
    assert.ok(attempted.error, "the operating system must explain a blocked swap");
    assert.equal(outcome.receipt?.preparationId, prepared.preparationId);
  }
});

test("persists sealed result objects and full-tree blobs and rejects blob tampering after restart", async (t) => {
  const setup = await fixture(t);
  const prepared = await setup.createService().inspectConflict(inspectionRequest(setup));
  const directory = path.join(
    setup.preparationRoot,
    "preparations",
    prepared.preparationId,
  );
  assert.deepEqual((await readdir(directory)).sort(), [
    "blobs",
    "manifest.json",
    "objects",
  ]);
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.treeEntries.map(({ path: relativePath }) => relativePath),
    ["README.md", "src/value.js"],
  );
  const readmeBlob = path.join(directory, "blobs", `${manifest.treeEntries[0].sha256}.blob`);
  await writeFile(readmeBlob, "tampered\n");
  await assert.rejects(
    setup.createService().verifyPreparation({
      preparationId: prepared.preparationId,
    }),
    (error) => error?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED",
  );
});

test("does not treat an existing preparation with damaged sealed evidence as an idempotent success", async (t) => {
  const setup = await fixture(t);
  const service = setup.createService();
  const prepared = await service.inspectConflict(inspectionRequest(setup));
  const directory = path.join(
    setup.preparationRoot,
    "preparations",
    prepared.preparationId,
  );
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  await rm(
    path.join(directory, "blobs", `${manifest.treeEntries[0].sha256}.blob`),
  );

  await assert.rejects(
    service.inspectConflict(inspectionRequest(setup)),
    (error) => error?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED",
  );
});

test("rejects replaced evidence roots and unsealed empty-directory topology", async (t) => {
  const replaced = await fixture(t);
  const replacedPreparation = await replaced
    .createService()
    .inspectConflict(inspectionRequest(replaced));
  const replacedDirectory = path.join(
    replaced.preparationRoot,
    "preparations",
    replacedPreparation.preparationId,
  );
  const objects = path.join(replacedDirectory, "objects");
  const displacedObjects = path.join(replaced.root, "displaced-objects");
  await rename(objects, displacedObjects);
  await symlink(
    displacedObjects,
    objects,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    replaced.createService().verifyPreparation({
      preparationId: replacedPreparation.preparationId,
    }),
    (error) => error?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED",
  );

  const topology = await fixture(t);
  const topologyPreparation = await topology
    .createService()
    .inspectConflict(inspectionRequest(topology));
  await mkdir(path.join(
    topology.preparationRoot,
    "preparations",
    topologyPreparation.preparationId,
    "objects",
    "unsealed-empty-directory",
  ));
  await assert.rejects(
    topology.createService().verifyPreparation({
      preparationId: topologyPreparation.preparationId,
    }),
    (error) => error?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED",
  );
});

test("enforces the evidence-directory limit before descending into overflow topology", async (t) => {
  const setup = await fixture(t);
  const prepared = await setup
    .createService()
    .inspectConflict(inspectionRequest(setup));
  const overflow = path.join(
    setup.preparationRoot,
    "preparations",
    prepared.preparationId,
    "objects",
    "overflow",
  );
  await mkdir(overflow);
  await writeFile(path.join(overflow, "must-not-be-read"), "content");

  await assert.rejects(
    setup.createService({ limits: { maxDirectories: 3 } }).verifyPreparation({
      preparationId: prepared.preparationId,
    }),
    (error) =>
      error?.code === "CONTROLLED_GIT_PREPARATION_TAMPERED" &&
      /directories.*限制/u.test(error.message),
  );
});

test("rejects result-tree paths excluded by the Code Job execution policy", async (t) => {
  for (const excludedPath of [
    ".env.production",
    "config.local.json",
    "node_modules/package/index.js",
    "data/state.json",
    "logs/job.log",
    ".ssh/config",
    ".code-broker-tmp-forged",
    "certificates/server.pem",
    "certificates/server.key",
  ]) {
    await t.test(excludedPath, async (t) => {
      const setup = await fixture(t, {
        treeOutput: Buffer.from(
          `100644 blob ${README}\t${excludedPath}\0` +
            `100644 blob ${RESULT_CONFLICT}\tsrc/value.js\0`,
        ),
      });
      await assert.rejects(
        setup.createService().inspectConflict(inspectionRequest(setup)),
        (error) => error?.code === "CONTROLLED_GIT_UNSUPPORTED_TREE",
      );
    });
  }
});

test("rejects non-modification, mode, binary, and unsafe result-tree entries", async (t) => {
  const rename = await fixture(t, {
    headRaw: Buffer.from(
      `:100644 100644 ${ANCESTOR} ${OURS} R100\0old.js\0new.js\0`,
    ),
  });
  await assert.rejects(
    rename.createService().inspectConflict(inspectionRequest(rename)),
    (error) => error?.code === "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
  );

  const mode = await fixture(t, {
    headRaw: Buffer.from(
      `:100644 100755 ${ANCESTOR} ${OURS} M\0src/value.js\0`,
    ),
  });
  await assert.rejects(
    mode.createService().inspectConflict(inspectionRequest(mode)),
    (error) => error?.code === "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
  );

  const deletion = await fixture(t, {
    headRaw: Buffer.from(
      `:100644 000000 ${ANCESTOR} ${"0".repeat(40)} D\0src/value.js\0`,
    ),
  });
  await assert.rejects(
    deletion.createService().inspectConflict(inspectionRequest(deletion)),
    (error) => error?.code === "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
  );

  const binary = await fixture(t, {
    headNumstat: Buffer.from("-\t-\tsrc/value.js\0"),
  });
  await assert.rejects(
    binary.createService().inspectConflict(inspectionRequest(binary)),
    (error) => error?.code === "CONTROLLED_GIT_UNSUPPORTED_CHANGE",
  );

  const submodule = await fixture(t, {
    treeOutput: resultTreeProtocol({ mode: "160000", type: "commit" }),
  });
  await assert.rejects(
    submodule.createService().inspectConflict(inspectionRequest(submodule)),
    (error) => error?.code === "CONTROLLED_GIT_UNSUPPORTED_TREE",
  );

  const symlink = await fixture(t, {
    treeOutput: resultTreeProtocol({ mode: "120000", type: "blob" }),
  });
  await assert.rejects(
    symlink.createService().inspectConflict(inspectionRequest(symlink)),
    (error) => error?.code === "CONTROLLED_GIT_UNSUPPORTED_TREE",
  );
});

test("rejects unrelated histories and multiple merge bases deterministically", async (t) => {
  const unrelated = await fixture(t, {
    mergeBaseOutput: Buffer.alloc(0),
    mergeBaseExitCode: 1,
  });
  await assert.rejects(
    unrelated.createService().inspectConflict(inspectionRequest(unrelated)),
    (error) => error?.code === "CONTROLLED_GIT_UNRELATED_HISTORY",
  );

  const multiple = await fixture(t, {
    mergeBaseOutput: Buffer.from(`${MERGE_BASE}\n${"e".repeat(40)}\n`),
  });
  await assert.rejects(
    multiple.createService().inspectConflict(inspectionRequest(multiple)),
    (error) => error?.code === "CONTROLLED_GIT_MULTIPLE_MERGE_BASES",
  );
});

test("pins the Git executable and rejects constructor or runner accessors without invoking them", async (t) => {
  const changed = await fixture(t, { mutateGitDuringRun: true });
  await assert.rejects(
    changed.createService().inspectConflict(inspectionRequest(changed)),
    (error) => error?.code === "CONTROLLED_GIT_EXECUTABLE_CHANGED",
  );

  const setup = await fixture(t);
  let reads = 0;
  const config = {
    mirrorInspector: setup.mirrorInspector,
    preparationRoot: setup.preparationRoot,
    processRunner: setup.processRunner,
  };
  Object.defineProperty(config, "gitCommand", {
    enumerable: true,
    get() {
      reads += 1;
      return path.join(setup.root, "never");
    },
  });
  assert.throws(() => new ControlledGitService(config));
  assert.equal(reads, 0);

  const resultAccessor = await fixture(t);
  resultAccessor.processRunner.run = async () => {
    const result = {
      exitCode: 0,
      signal: null,
      stderr: Buffer.alloc(0),
      truncated: false,
    };
    Object.defineProperty(result, "stdout", {
      enumerable: true,
      get() {
        reads += 1;
        return Buffer.from(`${MERGE_BASE}\n`);
      },
    });
    return result;
  };
  await assert.rejects(
    resultAccessor.createService().inspectConflict(inspectionRequest(resultAccessor)),
    (error) => error?.code === "CONTROLLED_GIT_PROCESS_FAILED",
  );
  assert.equal(reads, 0);
});

test("keeps the Git executable outside preparation and mirror trust boundaries", async (t) => {
  const preparationOverlap = await fixture(t);
  const preparationGit = path.join(
    preparationOverlap.preparationRoot,
    process.platform === "win32" ? "mingw64/bin/git.exe" : "bin/git",
  );
  await mkdir(path.dirname(preparationGit), { recursive: true });
  await writeFile(preparationGit, "fake git");
  if (process.platform !== "win32") await chmod(preparationGit, 0o755);
  assert.throws(
    () => preparationOverlap.createService({ gitCommand: preparationGit }),
    (error) => error?.code === "CONTROLLED_GIT_BOUNDARY_OVERLAP",
  );

  const mirrorOverlap = await fixture(t);
  const mirrorGit = path.join(
    mirrorOverlap.baseMirrorRoot,
    process.platform === "win32" ? "mingw64/bin/git.exe" : "bin/git",
  );
  await mkdir(path.dirname(mirrorGit), { recursive: true });
  await writeFile(mirrorGit, "fake git");
  if (process.platform !== "win32") await chmod(mirrorGit, 0o755);
  await assert.rejects(
    mirrorOverlap
      .createService({ gitCommand: mirrorGit })
      .inspectConflict(inspectionRequest(mirrorOverlap)),
    (error) => error?.code === "CONTROLLED_GIT_BOUNDARY_OVERLAP",
  );

});

test(
  "requires a non-dangerous executable mode for Git on Unix",
  {
    skip: process.platform === "win32"
      ? "POSIX executable mode is unavailable on Windows"
      : false,
  },
  async (t) => {
    const nonExecutable = await fixture(t);
    await chmod(nonExecutable.gitCommand, 0o644);
    await assert.rejects(
      nonExecutable
        .createService()
        .inspectConflict(inspectionRequest(nonExecutable)),
      (error) => error?.code === "CONTROLLED_GIT_EXECUTABLE_UNTRUSTED",
    );

    const dangerouslyWritable = await fixture(t);
    await chmod(dangerouslyWritable.gitCommand, 0o777);
    await assert.rejects(
      dangerouslyWritable
        .createService()
        .inspectConflict(inspectionRequest(dangerouslyWritable)),
      (error) => error?.code === "CONTROLLED_GIT_EXECUTABLE_UNTRUSTED",
    );
  },
);
