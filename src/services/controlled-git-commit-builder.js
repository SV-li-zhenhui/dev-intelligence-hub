import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { normalizeChangePackageManifest } from "../domain/change-package-contract.js";
import {
  createControlledCommitEvidence,
  createControlledCommitMessage,
  normalizeControlledCommitEvidence,
  sameControlledCommitEvidence,
} from "../domain/controlled-commit-evidence.js";
import {
  canonicalJsonDigest,
  canonicalJsonStringify,
} from "../lib/canonical-json-digest.js";

export const CONTROLLED_COMMIT_ID =
  /^controlled-git-commit-[a-f0-9]{64}$/u;
export const CONTROLLED_COMMIT_SCRATCH_PREFIX =
  ".controlled-git-commit-scratch-";

function rawSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameCanonicalValue(left, right) {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function canonicalDocumentBytes(value) {
  return Buffer.from(`${canonicalJsonStringify(value)}\n`, "utf8");
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isDescendantPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mode === right.mode &&
    left.nlink === right.nlink && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs && left.uid === right.uid &&
    left.gid === right.gid;
}

function decodeUtf8(value, fail) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw fail(
      "CONTROLLED_GIT_COMMIT_TAMPERED",
      "Controlled commit sealed document 不是 UTF-8",
      cause,
    );
  }
}

function identityEvidence(identity, createdAt) {
  return {
    ...identity,
    timestamp: Math.floor(Date.parse(createdAt) / 1_000),
  };
}

export class ControlledGitCommitBuilder {
  #assertRoot;
  #createObjectEnvironment;
  #directoryEvidence;
  #fail;
  #git;
  #identity;
  #limits;
  #normalizeBlobs;
  #preparationRoot;
  #verifyPreparation;

  constructor({
    preparationRoot,
    identity,
    limits,
    fail,
    assertRoot,
    verifyPreparation,
    normalizeBlobs,
    directoryEvidence,
    createObjectEnvironment,
    git,
  }) {
    this.#preparationRoot = preparationRoot;
    this.#identity = identity;
    this.#limits = limits;
    this.#fail = fail;
    this.#assertRoot = assertRoot;
    this.#verifyPreparation = verifyPreparation;
    this.#normalizeBlobs = normalizeBlobs;
    this.#directoryEvidence = directoryEvidence;
    this.#createObjectEnvironment = createObjectEnvironment;
    this.#git = git;
    Object.freeze(this);
  }

  async recover() {
    await this.#assertRoot();
    const removedScratchDirectories = await this.#removeScratchDirectories();
    const commitsDirectory = await this.#commitsDirectory();
    const evidenceIds = [];
    const entries = await opendir(commitsDirectory);
    for await (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() ||
          !CONTROLLED_COMMIT_ID.test(entry.name)) {
        throw this.#fail(
          "CONTROLLED_GIT_COMMIT_TAMPERED",
          "Controlled commit store 包含未密封内容",
        );
      }
      evidenceIds.push(entry.name);
    }
    evidenceIds.sort((left, right) => left.localeCompare(right, "en"));
    for (const evidenceId of evidenceIds) await this.verify(evidenceId);
    return Object.freeze({
      commits: evidenceIds.length,
      removedScratchDirectories,
    });
  }

  async create(request) {
    await this.#assertRoot();
    const preparation = await this.#verifyPreparation(
      request.executionSource,
      request.manifest,
    );
    let scratchRoot;
    try {
      scratchRoot = await mkdtemp(
        path.join(this.#preparationRoot, CONTROLLED_COMMIT_SCRATCH_PREFIX),
      );
      const evidence = await this.#build({
        ...request,
        preparation,
        scratchRoot,
      });
      const finalPreparation = await this.#verifyPreparation(
        request.executionSource,
        request.manifest,
      );
      if (!sameCanonicalValue(finalPreparation, preparation)) {
        throw this.#fail(
          "CONTROLLED_GIT_BOUNDARY_CHANGED",
          "Controlled commit 构建期间 preparation 发生变化",
        );
      }
      const persisted = await this.#persist({
        scratchRoot,
        manifest: request.manifest,
        evidence,
      });
      scratchRoot = undefined;
      return persisted;
    } finally {
      if (scratchRoot !== undefined) {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    }
  }

  async find(request) {
    await this.#assertRoot();
    const matches = [];
    const entries = await opendir(await this.#commitsDirectory());
    for await (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !CONTROLLED_COMMIT_ID.test(entry.name)
      ) {
        throw this.#fail(
          "CONTROLLED_GIT_COMMIT_TAMPERED",
          "Controlled commit store 包含未密封内容",
        );
      }
      const stored = await this.#load(entry.name);
      if (this.#matchesLookup(stored, request)) matches.push(entry.name);
    }
    if (matches.length === 0) return null;
    if (matches.length !== 1) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit lookup 存在歧义",
      );
    }
    return this.verify(matches[0]);
  }

  async verify(evidenceId) {
    const stored = await this.#load(evidenceId);
    const preparation = await this.#verifyPreparation(
      stored.evidence.executionSource,
      stored.manifest,
    );
    let scratchRoot;
    try {
      scratchRoot = await mkdtemp(
        path.join(this.#preparationRoot, CONTROLLED_COMMIT_SCRATCH_PREFIX),
      );
      const rebuilt = await this.#build({
        executionSource: stored.evidence.executionSource,
        manifest: stored.manifest,
        blobs: stored.blobs,
        createdAt: stored.evidence.createdAt,
        message: createControlledCommitMessage({
          executionSource: stored.evidence.executionSource,
          manifest: stored.manifest,
        }),
        preparation,
        scratchRoot,
      });
      if (!sameControlledCommitEvidence(rebuilt, stored.evidence)) {
        throw this.#fail(
          "CONTROLLED_GIT_COMMIT_TAMPERED",
          "Controlled commit evidence 无法从 sealed manifest 重建",
        );
      }
      const finalPreparation = await this.#verifyPreparation(
        stored.evidence.executionSource,
        stored.manifest,
      );
      if (!sameCanonicalValue(finalPreparation, preparation)) {
        throw this.#fail(
          "CONTROLLED_GIT_BOUNDARY_CHANGED",
          "Controlled commit 校验期间 preparation 发生变化",
        );
      }
      return stored.evidence;
    } finally {
      if (scratchRoot !== undefined) {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    }
  }

  async preparePublication(evidenceId) {
    const verified = await this.verify(evidenceId);
    const stored = await this.#load(evidenceId);
    if (!sameControlledCommitEvidence(verified, stored.evidence)) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit 在 publication fence 期间发生变化",
      );
    }
    const commitDirectory = await this.#commitDirectory(evidenceId);
    return Object.freeze({
      evidence: stored.evidence,
      manifest: stored.manifest,
      objectDirectory: path.join(commitDirectory, "objects"),
    });
  }

  #matchesLookup(stored, request) {
    const timestamp = Math.floor(Date.parse(request.createdAt) / 1_000);
    const expectedIdentity = identityEvidence(this.#identity, request.createdAt);
    return sameCanonicalValue(stored.manifest, request.manifest) &&
      sameCanonicalValue(
        stored.evidence.executionSource,
        request.executionSource,
      ) &&
      stored.evidence.createdAt === request.createdAt &&
      stored.evidence.commit.author.timestamp === timestamp &&
      sameCanonicalValue(stored.evidence.commit.author, expectedIdentity) &&
      sameCanonicalValue(stored.evidence.commit.committer, expectedIdentity);
  }

  async #build({
    executionSource,
    manifest,
    blobs,
    createdAt,
    message,
    preparation,
    scratchRoot,
  }) {
    const gitDirectory = path.join(scratchRoot, "git");
    const objectDirectory = path.join(scratchRoot, "objects");
    const blobDirectory = path.join(scratchRoot, "blobs");
    const indexFile = path.join(scratchRoot, "index");
    await Promise.all([
      mkdir(gitDirectory),
      mkdir(objectDirectory),
      mkdir(blobDirectory),
    ]);
    await Promise.all([
      mkdir(path.join(objectDirectory, "info")),
      mkdir(path.join(objectDirectory, "pack")),
      mkdir(path.join(gitDirectory, "refs", "heads"), { recursive: true }),
      mkdir(path.join(gitDirectory, "refs", "tags"), { recursive: true }),
    ]);
    const gitConfig = preparation.baseBoundary.objectFormat === "sha1"
      ? "[core]\n\trepositoryformatversion = 0\n\tbare = true\n"
      : "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectFormat = sha256\n";
    await Promise.all([
      writeFile(path.join(gitDirectory, "config"), gitConfig, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(path.join(gitDirectory, "HEAD"),
        "ref: refs/heads/unused\n", {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        }),
      ...blobs.map((blob) => this.#sealBlob(blobDirectory, blob)),
    ]);

    const environment = this.#environment({
      objectDirectory,
      indexFile,
      preparation,
      createdAt,
    });
    const context = { gitDirectory, cwd: scratchRoot, environment };
    await this.#git.readTree({
      ...context,
      treeOid: preparation.resultTreeOid,
    });
    const contentByDigest = new Map(
      blobs.map(({ sha256, content }) => [sha256, content]),
    );
    const records = [];
    for (const change of manifest.changes.modified) {
      const oid = await this.#git.hashObject({
        ...context,
        content: contentByDigest.get(change.blob.sha256),
        oidLength: preparation.baseBoundary.oidLength,
      });
      records.push(`100644 blob ${oid}\t${change.path}\0`);
    }
    await this.#git.updateIndex({
      ...context,
      records: Buffer.from(records.join(""), "utf8"),
    });
    const finalTreeOid = await this.#git.writeTree({
      ...context,
      oidLength: preparation.baseBoundary.oidLength,
    });
    if (finalTreeOid === preparation.resultTreeOid) {
      throw this.#fail(
        "CONTROLLED_GIT_CHANGE_PACKAGE_MISMATCH",
        "Controlled commit resolution 未改变 result tree",
      );
    }
    const target = executionSource.inputBinding.gitTarget;
    const commitOid = await this.#git.commitTree({
      ...context,
      treeOid: finalTreeOid,
      parents: [target.headRefOid, target.baseRefOid],
      message: Buffer.from(message, "utf8"),
      oidLength: preparation.baseBoundary.oidLength,
    });
    const objectSet = await this.#directoryEvidence(objectDirectory, {
      maxFiles: this.#limits.maxObjectFiles,
      maxDirectories: this.#limits.maxDirectories,
      maxBytes: this.#limits.maxResultObjectBytes,
      allowedEmptyDirectories: ["info", "pack"],
      errorCode: "CONTROLLED_GIT_COMMIT_OBJECT_INVALID",
    });
    const identity = identityEvidence(this.#identity, createdAt);
    let evidence;
    try {
      evidence = createControlledCommitEvidence({
        executionSource,
        manifest,
        resolution: {
          resolvedPaths: [...executionSource.writeScope.paths],
          finalTreeOid,
        },
        commit: {
          objectFormat: preparation.baseBoundary.objectFormat,
          oid: commitOid,
          treeOid: finalTreeOid,
          parents: [target.headRefOid, target.baseRefOid],
          author: identity,
          committer: identity,
          messageDigest: rawSha256(Buffer.from(message, "utf8")),
          objectSetDigest: canonicalJsonDigest(objectSet),
        },
        createdAt,
      });
    } catch (cause) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_PROTOCOL_ERROR",
        "Controlled commit evidence 无法绑定 Git 输出",
        cause,
      );
    }
    await Promise.all([
      rm(gitDirectory, { recursive: true, force: true }),
      rm(indexFile, { force: true }),
    ]);
    return evidence;
  }

  #environment({ objectDirectory, indexFile, preparation, createdAt }) {
    const preparationObjects = path.join(
      this.#preparationRoot,
      "preparations",
      preparation.preparationId,
      "objects",
    );
    const timestamp = Math.floor(Date.parse(createdAt) / 1_000);
    const gitDate = `@${timestamp} ${this.#identity.timezone}`;
    return Object.freeze({
      ...this.#createObjectEnvironment(
        objectDirectory,
        preparationObjects,
        preparation.baseBoundary.objectDirectory,
        preparation.headBoundary.objectDirectory,
      ),
      GIT_ATTR_NOSYSTEM: "1",
      GIT_AUTHOR_DATE: gitDate,
      GIT_AUTHOR_EMAIL: this.#identity.email,
      GIT_AUTHOR_NAME: this.#identity.name,
      GIT_COMMITTER_DATE: gitDate,
      GIT_COMMITTER_EMAIL: this.#identity.email,
      GIT_COMMITTER_NAME: this.#identity.name,
      GIT_INDEX_FILE: indexFile,
    });
  }

  async #sealBlob(directory, blob) {
    const handle = await open(
      path.join(directory, `${blob.sha256}.blob`),
      "wx",
      0o600,
    );
    try {
      await handle.writeFile(blob.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #persist({ scratchRoot, manifest, evidence }) {
    const manifestBytes = canonicalDocumentBytes(manifest);
    const evidenceBytes = canonicalDocumentBytes(evidence);
    if (manifestBytes.length > this.#limits.maxManifestBytes ||
        evidenceBytes.length > this.#limits.maxManifestBytes) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_LIMIT",
        "Controlled commit sealed document 超过限制",
      );
    }
    await Promise.all([
      this.#writeDocument(path.join(scratchRoot, "manifest.json"), manifestBytes),
      this.#writeDocument(path.join(scratchRoot, "evidence.json"), evidenceBytes),
    ]);
    const target = path.join(
      await this.#commitsDirectory(),
      evidence.evidenceId,
    );
    try {
      await rename(scratchRoot, target);
    } catch (cause) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(cause?.code)) {
        throw cause;
      }
      const existing = await this.#load(evidence.evidenceId);
      if (!sameCanonicalValue(existing.manifest, manifest) ||
          !sameControlledCommitEvidence(existing.evidence, evidence)) {
        throw this.#fail(
          "CONTROLLED_GIT_COMMIT_TAMPERED",
          "Content-addressed controlled commit 已存在但内容不一致",
        );
      }
      await rm(scratchRoot, { recursive: true, force: true });
      return existing.evidence;
    }
    return (await this.#load(evidence.evidenceId)).evidence;
  }

  async #writeDocument(target, bytes) {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #load(evidenceId) {
    const directory = await this.#commitDirectory(evidenceId);
    const names = [];
    const entries = await opendir(directory);
    for await (const entry of entries) names.push(entry.name);
    names.sort((left, right) => left.localeCompare(right, "en"));
    if (!sameCanonicalValue(names, [
      "blobs",
      "evidence.json",
      "manifest.json",
      "objects",
    ])) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit directory 包含未密封内容",
      );
    }
    const manifest = await this.#readDocument(
      path.join(directory, "manifest.json"),
      normalizeChangePackageManifest,
    );
    const evidence = await this.#readDocument(
      path.join(directory, "evidence.json"),
      normalizeControlledCommitEvidence,
    );
    if (evidence.evidenceId !== evidenceId) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit evidenceId 与目录不一致",
      );
    }
    let expected;
    try {
      expected = createControlledCommitEvidence({
        executionSource: evidence.executionSource,
        manifest,
        resolution: {
          resolvedPaths: [...evidence.resolution.resolvedPaths],
          finalTreeOid: evidence.resolution.finalTreeOid,
        },
        commit: evidence.commit,
        createdAt: evidence.createdAt,
      });
    } catch (cause) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit 未绑定 exact change package/test manifest",
        cause,
      );
    }
    if (!sameControlledCommitEvidence(expected, evidence)) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit 未绑定 exact change package/test manifest",
      );
    }
    const blobs = await this.#readBlobs(path.join(directory, "blobs"), manifest);
    const objectSet = await this.#directoryEvidence(
      path.join(directory, "objects"),
      {
        maxFiles: this.#limits.maxObjectFiles,
        maxDirectories: this.#limits.maxDirectories,
        maxBytes: this.#limits.maxResultObjectBytes,
        allowedEmptyDirectories: ["info", "pack"],
        errorCode: "CONTROLLED_GIT_COMMIT_TAMPERED",
      },
    );
    if (canonicalJsonDigest(objectSet) !== evidence.commit.objectSetDigest) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit object set digest 无效",
      );
    }
    return { manifest, evidence, blobs };
  }

  async #readDocument(target, normalize) {
    let initial;
    let canonical;
    let bytes;
    let final;
    try {
      initial = await lstat(target);
      canonical = await realpath(target);
      bytes = await readFile(target);
      final = await lstat(target);
    } catch (cause) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit sealed document 不可读取",
        cause,
      );
    }
    if (initial.isSymbolicLink() || !initial.isFile() ||
        initial.nlink !== 1 || initial.size < 2 ||
        initial.size > this.#limits.maxManifestBytes ||
        !samePath(canonical, target) || !sameFileIdentity(initial, final) ||
        bytes.length !== initial.size) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit sealed document identity 无效",
      );
    }
    let value;
    try {
      value = normalize(JSON.parse(decodeUtf8(bytes, this.#fail)));
    } catch (cause) {
      if (cause?.code === "CONTROLLED_GIT_COMMIT_TAMPERED") throw cause;
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit sealed document 无效",
        cause,
      );
    }
    if (!bytes.equals(canonicalDocumentBytes(value))) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit sealed document 不是 canonical JSON",
      );
    }
    return value;
  }

  async #readBlobs(directory, manifest) {
    const references = new Map(
      [...manifest.changes.created, ...manifest.changes.modified]
        .map(({ blob }) => [blob.sha256, blob.bytes]),
    );
    const evidence = await this.#directoryEvidence(directory, {
      maxFiles: this.#limits.maxFiles,
      maxDirectories: 1,
      maxBytes: this.#limits.maxTotalBytes,
      errorCode: "CONTROLLED_GIT_COMMIT_TAMPERED",
    });
    if (evidence.length !== references.size || evidence.some(
      (entry) => entry.path !== `${entry.sha256}.blob` ||
        references.get(entry.sha256) !== entry.byteLength,
    )) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit blobs 未精确覆盖 change package",
      );
    }
    const blobs = [];
    for (const entry of evidence) {
      const target = path.join(directory, entry.path);
      const initial = await lstat(target);
      const canonical = await realpath(target);
      const content = await readFile(target);
      const final = await lstat(target);
      if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1 ||
          !samePath(canonical, target) || !sameFileIdentity(initial, final) ||
          content.length !== entry.byteLength) {
        throw this.#fail(
          "CONTROLLED_GIT_COMMIT_TAMPERED",
          "Controlled commit blob identity 无效",
        );
      }
      blobs.push({ sha256: entry.sha256, content });
    }
    return this.#normalizeBlobs(blobs, manifest);
  }

  async #commitsDirectory() {
    await this.#assertRoot();
    const directory = path.join(this.#preparationRoot, "commits");
    await mkdir(directory, { mode: 0o700 }).catch((cause) => {
      if (cause?.code !== "EEXIST") throw cause;
    });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory() ||
        !samePath(await realpath(directory), directory)) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_STORE_UNAVAILABLE",
        "Controlled commit store 身份不安全",
      );
    }
    return directory;
  }

  async #commitDirectory(evidenceId) {
    const directory = path.join(await this.#commitsDirectory(), evidenceId);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        throw this.#fail(
          "CONTROLLED_GIT_COMMIT_NOT_FOUND",
          "Controlled commit evidence 不存在",
        );
      }
      throw cause;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory() ||
        !samePath(await realpath(directory), directory)) {
      throw this.#fail(
        "CONTROLLED_GIT_COMMIT_TAMPERED",
        "Controlled commit directory 身份不安全",
      );
    }
    return directory;
  }

  async #removeScratchDirectories() {
    let removed = 0;
    const entries = await opendir(this.#preparationRoot);
    for await (const entry of entries) {
      if (!entry.name.startsWith(CONTROLLED_COMMIT_SCRATCH_PREFIX)) continue;
      const target = path.resolve(this.#preparationRoot, entry.name);
      if (!isDescendantPath(this.#preparationRoot, target)) {
        throw this.#fail(
          "CONTROLLED_GIT_COMMIT_RECOVERY_FAILED",
          "Controlled commit scratch path 逃逸 recovery root",
        );
      }
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        await unlink(target);
      } else {
        const canonical = await realpath(target);
        const final = await lstat(target);
        if (!samePath(canonical, target) || !sameFileIdentity(stats, final)) {
          throw this.#fail(
            "CONTROLLED_GIT_COMMIT_RECOVERY_FAILED",
            "Controlled commit scratch identity 不安全",
          );
        }
        await rm(target, { recursive: true, force: false });
      }
      removed += 1;
    }
    return removed;
  }
}
