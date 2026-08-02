import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CodeExecutionError,
  CodeExecutionPolicy,
  validateExecutionId,
  validateWorkspaceId,
} from "../domain/code-execution-policy.js";
import { workspaceRevisionFromFileHashes } from "../domain/workspace-revision.js";

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 5_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 50_000_000,
  maxSearchMatches: 200,
  maxWriteBytes: 1_000_000,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error, fallbackCode, fallbackMessage) {
  if (error instanceof CodeExecutionError) return error;
  return new CodeExecutionError(fallbackCode, fallbackMessage);
}

async function guarded(operation, fallbackCode, fallbackMessage) {
  try {
    return await operation();
  } catch (error) {
    throw safeError(error, fallbackCode, fallbackMessage);
  }
}

function validateLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CodeExecutionError("INVALID_LIMIT", `${name} 限制无效`);
    }
  }
  return Object.freeze(limits);
}

function decodeText(value) {
  if (value.includes(0)) {
    throw new CodeExecutionError("TEXT_REQUIRED", "只能读取或写入纯文本文件");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new CodeExecutionError("TEXT_REQUIRED", "只能读取或写入纯文本文件");
  }
}

function assertExpectedSha256(value) {
  if (value === undefined) {
    throw new CodeExecutionError(
      "EXPECTED_SHA256_REQUIRED",
      "写操作必须提供 expectedSha256",
    );
  }
  if (value !== null && !/^[a-f0-9]{64}$/.test(value)) {
    throw new CodeExecutionError("INVALID_SHA256", "expectedSha256 格式无效");
  }
}

export class CodeWorkspaceBroker {
  constructor({
    workspaces = [],
    scratchRoot = path.join(tmpdir(), "my-dashboard-code-executions"),
    limits = {},
  } = {}) {
    if (typeof scratchRoot !== "string" || !path.isAbsolute(scratchRoot)) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_CONFIG",
        "临时工作区配置无效",
      );
    }
    this.scratchRoot = path.resolve(scratchRoot);
    this.limits = validateLimits(limits);
    this.workspaces = new Map();
    this.executions = new Map();
    for (const workspace of workspaces) this.#registerWorkspace(workspace);
  }

  #registerWorkspace({ id, sourceRoot, writablePaths = [], excludePaths = [] }) {
    validateWorkspaceId(id);
    if (this.workspaces.has(id)) {
      throw new CodeExecutionError(
        "WORKSPACE_ALREADY_REGISTERED",
        "workspaceId 已注册",
      );
    }
    if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_CONFIG",
        "可信工作区配置无效",
      );
    }
    this.workspaces.set(id, {
      id,
      sourceRoot: path.resolve(sourceRoot),
      policy: new CodeExecutionPolicy({ writablePaths, excludePaths }),
    });
  }

  async createExecution({
    workspaceId,
    executionId = `run-${randomUUID()}`,
  }) {
    return guarded(
      async () => {
        const workspace = this.#workspace(workspaceId);
        validateExecutionId(executionId);
        const key = this.#executionKey(workspaceId, executionId);
        if (this.executions.has(key)) {
          throw new CodeExecutionError(
            "EXECUTION_ALREADY_EXISTS",
            "executionId 已存在",
          );
        }

        await mkdir(this.scratchRoot, { recursive: true });
        await this.#assertDirectory(this.scratchRoot, "EXECUTION_STORAGE_UNAVAILABLE");
        const workspaceRoot = path.join(this.scratchRoot, workspaceId);
        await mkdir(workspaceRoot, { recursive: true });
        await this.#assertDirectory(workspaceRoot, "EXECUTION_STORAGE_UNAVAILABLE");
        const executionRoot = path.join(workspaceRoot, executionId);
        try {
          await mkdir(executionRoot);
        } catch (error) {
          if (error?.code === "EEXIST") {
            throw new CodeExecutionError(
              "EXECUTION_ALREADY_EXISTS",
              "executionId 已存在",
            );
          }
          throw error;
        }

        const baseline = new Map();
        const copyState = { fileCount: 0, totalBytes: 0 };
        try {
          await this.#copySanitizedDirectory({
            workspace,
            sourceDirectory: workspace.sourceRoot,
            targetDirectory: executionRoot,
            relativeDirectory: "",
            baseline,
            copyState,
          });
        } catch (error) {
          await rm(executionRoot, { recursive: true, force: true }).catch(() => {});
          throw error;
        }

        const sourceRevision = workspaceRevisionFromFileHashes(baseline);
        this.executions.set(key, {
          workspace,
          root: executionRoot,
          baseline,
          sourceRevision,
          workspaceState: {
            fileHashes: new Map(baseline),
            revision: sourceRevision,
          },
          seal: null,
          tail: Promise.resolve(),
        });
        return {
          workspaceId,
          executionId,
          sourceRevision,
          workspaceRevision: sourceRevision,
        };
      },
      "EXECUTION_CREATE_FAILED",
      "无法创建代码执行副本",
    );
  }

  async listFiles(request) {
    return guarded(
      async () => {
        const {
          workspaceId,
          executionId,
          path: requestedPath = "",
        } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueueAtExpectedRevision(
          execution,
          request,
          async () => {
            const relativePath = execution.workspace.policy.assertAccessible(
              requestedPath,
              { allowRoot: true },
            );
            return this.#collectFiles(execution, relativePath);
          },
        );
      },
      "LIST_FAILED",
      "无法列出工作区文件",
    );
  }

  async readFile(request) {
    return guarded(
      async () => {
        const { workspaceId, executionId, path: requestedPath } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueueAtExpectedRevision(
          execution,
          request,
          async () => {
            const relativePath =
              execution.workspace.policy.assertAccessible(requestedPath);
            const file = await this.#readTextFile(execution, relativePath);
            return {
              path: relativePath,
              content: file.content,
              sha256: file.sha256,
              bytes: file.bytes,
            };
          },
        );
      },
      "READ_FAILED",
      "无法读取工作区文件",
    );
  }

  async searchText(request) {
    return guarded(
      async () => {
        const {
          workspaceId,
          executionId,
          query,
          path: requestedPath = "",
        } = request;
        if (
          typeof query !== "string" ||
          query.length === 0 ||
          query.includes("\0") ||
          Buffer.byteLength(query, "utf8") > 4_096
        ) {
          throw new CodeExecutionError("INVALID_QUERY", "搜索文本无效");
        }
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueueAtExpectedRevision(
          execution,
          request,
          async () => {
            const relativePath = execution.workspace.policy.assertAccessible(
              requestedPath,
              { allowRoot: true },
            );
            const files = await this.#collectFiles(execution, relativePath);
            const matches = [];
            for (const filePath of files) {
              let file;
              try {
                file = await this.#readTextFile(execution, filePath);
              } catch (error) {
                if (error.code === "TEXT_REQUIRED") continue;
                throw error;
              }
              const lines = file.content.split(/\r?\n/);
              for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                let column = lines[lineIndex].indexOf(query);
                while (column !== -1) {
                  if (matches.length === this.limits.maxSearchMatches) {
                    return { matches, truncated: true };
                  }
                  matches.push({
                    path: filePath,
                    line: lineIndex + 1,
                    column: column + 1,
                    text: lines[lineIndex].slice(0, 500),
                  });
                  column = lines[lineIndex].indexOf(query, column + query.length);
                }
              }
            }
            return { matches, truncated: false };
          },
        );
      },
      "SEARCH_FAILED",
      "无法搜索工作区文本",
    );
  }

  async writeFile(action) {
    return guarded(
      async () => {
        const execution = this.#execution(
          action.workspaceId,
          action.executionId,
        );
        return this.#enqueue(execution, async () => {
          this.#assertExecutionOpen(execution);
          const beforeWorkspaceRevision = execution.workspaceState.revision;
          this.#assertWorkspaceRevision(action, beforeWorkspaceRevision);
          const result = await this.#writeFile(execution, action);
          return {
            ...result,
            beforeWorkspaceRevision,
            workspaceRevision: this.#commitCachedFileHash(
              execution,
              result.path,
              result.sha256,
            ),
          };
        });
      },
      "WRITE_FAILED",
      "无法写入工作区文件",
    );
  }

  async deleteFile(action) {
    return guarded(
      async () => {
        const execution = this.#execution(
          action.workspaceId,
          action.executionId,
        );
        return this.#enqueue(execution, async () => {
          this.#assertExecutionOpen(execution);
          const beforeWorkspaceRevision = execution.workspaceState.revision;
          this.#assertWorkspaceRevision(action, beforeWorkspaceRevision);
          const result = await this.#deleteFile(execution, action);
          return {
            ...result,
            beforeWorkspaceRevision,
            workspaceRevision: this.#commitCachedFileHash(
              execution,
              result.path,
              null,
            ),
          };
        });
      },
      "DELETE_FAILED",
      "无法删除工作区文件",
    );
  }

  async getChangeManifest(request) {
    return guarded(
      async () => {
        const { workspaceId, executionId } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueue(execution, async () => {
          const snapshot = await this.#createWorkspaceSnapshot(execution);
          this.#assertWorkspaceRevision(request, snapshot.workspaceRevision);
          return snapshot.manifest;
        });
      },
      "MANIFEST_FAILED",
      "无法生成工作区变更清单",
    );
  }

  async sealExecution(request) {
    return guarded(
      async () => {
        const { workspaceId, executionId } = request;
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueue(execution, async () => {
          this.#assertRequiredWorkspaceRevision(request);
          if (execution.seal) {
            this.#assertWorkspaceRevision(
              request,
              execution.seal.workspaceRevision,
            );
            return this.#copyWorkspaceSnapshot(execution.seal);
          }

          const snapshot = await this.#createWorkspaceSnapshot(execution);
          this.#assertWorkspaceRevision(request, snapshot.workspaceRevision);
          execution.seal = snapshot;
          return this.#copyWorkspaceSnapshot(snapshot);
        });
      },
      "SEAL_FAILED",
      "无法封存代码执行副本",
    );
  }

  async getSandboxWorkspacePath({ workspaceId, executionId }) {
    return guarded(
      async () => {
        const execution = this.#execution(workspaceId, executionId);
        await this.#assertDirectory(
          execution.root,
          "EXECUTION_STORAGE_UNAVAILABLE",
        );
        return realpath(execution.root);
      },
      "EXECUTION_STORAGE_UNAVAILABLE",
      "代码执行副本不可用",
    );
  }

  async getWorkspaceRevision({ workspaceId, executionId }) {
    return guarded(
      async () => {
        const execution = this.#execution(workspaceId, executionId);
        return this.#enqueue(execution, () =>
          this.#currentWorkspaceRevision(execution),
        );
      },
      "REVISION_FAILED",
      "无法计算代码执行副本版本",
    );
  }

  async withLockedExecution({ workspaceId, executionId }, operation) {
    if (typeof operation !== "function") {
      throw new CodeExecutionError("INVALID_OPERATION", "受控操作无效");
    }
    const execution = this.#execution(workspaceId, executionId);
    return this.#enqueue(execution, async () => {
      const beforeWorkspaceRevision =
        await this.#currentWorkspaceRevision(execution);
      const result = await operation({
        workspacePath: await realpath(execution.root),
        workspaceRevision: beforeWorkspaceRevision,
      });
      return {
        result,
        beforeWorkspaceRevision,
        afterWorkspaceRevision:
          await this.#currentWorkspaceRevision(execution),
      };
    });
  }

  #workspace(workspaceId) {
    validateWorkspaceId(workspaceId);
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new CodeExecutionError("WORKSPACE_NOT_FOUND", "workspaceId 未注册");
    }
    return workspace;
  }

  #execution(workspaceId, executionId) {
    this.#workspace(workspaceId);
    validateExecutionId(executionId);
    const execution = this.executions.get(
      this.#executionKey(workspaceId, executionId),
    );
    if (!execution) {
      throw new CodeExecutionError("EXECUTION_NOT_FOUND", "executionId 不存在");
    }
    return execution;
  }

  #executionKey(workspaceId, executionId) {
    return `${workspaceId}:${executionId}`;
  }

  #enqueue(execution, operation) {
    const result = execution.tail.then(operation, operation);
    execution.tail = result.catch(() => {});
    return result;
  }

  #enqueueAtExpectedRevision(execution, request, operation) {
    if (request.expectedWorkspaceRevision === undefined) return operation();
    return this.#enqueue(execution, async () => {
      this.#assertWorkspaceRevision(request, execution.workspaceState.revision);
      return operation();
    });
  }

  #assertWorkspaceRevision(action, actualRevision) {
    if (action.expectedWorkspaceRevision === undefined) return;
    if (!/^[a-f0-9]{64}$/.test(action.expectedWorkspaceRevision)) {
      throw new CodeExecutionError(
        "INVALID_WORKSPACE_REVISION",
        "工作区版本格式无效",
      );
    }
    if (action.expectedWorkspaceRevision !== actualRevision) {
      throw new CodeExecutionError(
        "WORKSPACE_REVISION_MISMATCH",
        "工作区已发生变化",
      );
    }
  }

  #assertRequiredWorkspaceRevision(action) {
    if (action.expectedWorkspaceRevision === undefined) {
      throw new CodeExecutionError(
        "EXPECTED_WORKSPACE_REVISION_REQUIRED",
        "封存操作必须提供 expectedWorkspaceRevision",
      );
    }
  }

  #assertExecutionOpen(execution) {
    if (execution.seal) {
      throw new CodeExecutionError(
        "EXECUTION_SEALED",
        "代码执行副本已封存",
      );
    }
  }

  async #currentWorkspaceRevision(execution) {
    return workspaceRevisionFromFileHashes(
      await this.#currentFileHashes(execution),
    );
  }

  #commitCachedFileHash(execution, relativePath, fileHash) {
    const fileHashes = new Map(execution.workspaceState.fileHashes);
    if (fileHash === null) {
      fileHashes.delete(relativePath);
    } else {
      fileHashes.set(relativePath, fileHash);
    }
    const revision = workspaceRevisionFromFileHashes(fileHashes);
    execution.workspaceState = { fileHashes, revision };
    return revision;
  }

  async #createWorkspaceSnapshot(execution) {
    const current = await this.#currentFileHashes(execution);
    return {
      workspaceRevision: workspaceRevisionFromFileHashes(current),
      manifest: this.#createChangeManifest(execution, current),
    };
  }

  async #currentFileHashes(execution) {
    const fileHashes = new Map();
    for (const relativePath of await this.#collectFiles(execution, "")) {
      const file = await this.#readFileBuffer(execution, relativePath);
      fileHashes.set(relativePath, sha256(file.value));
    }
    return fileHashes;
  }

  #createChangeManifest(execution, current) {
    const created = [];
    const modified = [];
    const deleted = [];
    for (const [relativePath, currentSha256] of current) {
      const baselineSha256 = execution.baseline.get(relativePath);
      if (baselineSha256 === undefined) {
        created.push({ path: relativePath, sha256: currentSha256 });
      } else if (baselineSha256 !== currentSha256) {
        modified.push({
          path: relativePath,
          beforeSha256: baselineSha256,
          afterSha256: currentSha256,
        });
      }
    }
    for (const [relativePath, baselineSha256] of execution.baseline) {
      if (!current.has(relativePath)) {
        deleted.push({ path: relativePath, sha256: baselineSha256 });
      }
    }
    const byPath = (left, right) => left.path.localeCompare(right.path);
    return {
      created: created.sort(byPath),
      modified: modified.sort(byPath),
      deleted: deleted.sort(byPath),
    };
  }

  #copyWorkspaceSnapshot(snapshot) {
    return structuredClone(snapshot);
  }

  async #assertDirectory(directory, errorCode) {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) {
      throw new CodeExecutionError("SYMLINK_REJECTED", "符号链接不可访问");
    }
    if (!stats.isDirectory()) {
      throw new CodeExecutionError(errorCode, "工作区目录不可用");
    }
  }

  async #copySanitizedDirectory({
    workspace,
    sourceDirectory,
    targetDirectory,
    relativeDirectory,
    baseline,
    copyState,
  }) {
    const sourceStats = await lstat(sourceDirectory);
    if (sourceStats.isSymbolicLink()) {
      throw new CodeExecutionError("SYMLINK_REJECTED", "源工作区包含符号链接");
    }
    if (!sourceStats.isDirectory()) {
      throw new CodeExecutionError("SOURCE_UNAVAILABLE", "源工作区不可用");
    }

    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (workspace.policy.isExcluded(relativePath)) continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const targetPath = path.join(targetDirectory, entry.name);
      const stats = await lstat(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new CodeExecutionError(
          "SYMLINK_REJECTED",
          "源工作区包含符号链接",
        );
      }
      if (stats.isDirectory()) {
        await mkdir(targetPath);
        await this.#copySanitizedDirectory({
          workspace,
          sourceDirectory: sourcePath,
          targetDirectory: targetPath,
          relativeDirectory: relativePath,
          baseline,
          copyState,
        });
        continue;
      }
      if (!stats.isFile()) {
        throw new CodeExecutionError(
          "UNSUPPORTED_FILE_TYPE",
          "源工作区包含不支持的文件类型",
        );
      }
      this.#countCopiedFile(stats.size, copyState);
      const value = await readFile(sourcePath);
      if (value.length > this.limits.maxFileBytes) {
        throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
      }
      const handle = await open(targetPath, "wx", stats.mode & 0o777);
      try {
        await handle.writeFile(value);
      } finally {
        await handle.close();
      }
      baseline.set(relativePath, sha256(value));
    }
  }

  #countCopiedFile(size, state) {
    state.fileCount += 1;
    state.totalBytes += size;
    if (state.fileCount > this.limits.maxFiles) {
      throw new CodeExecutionError("FILE_COUNT_LIMIT", "文件数量超过限制");
    }
    if (size > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }
    if (state.totalBytes > this.limits.maxTotalBytes) {
      throw new CodeExecutionError("TOTAL_SIZE_LIMIT", "工作区总大小超过限制");
    }
  }

  async #inspect(execution, relativePath, { allowMissing = false } = {}) {
    await this.#assertDirectory(execution.root, "EXECUTION_STORAGE_UNAVAILABLE");
    let current = execution.root;
    const segments = relativePath === "" ? [] : relativePath.split("/");
    let stats = await lstat(current);
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      try {
        stats = await lstat(current);
      } catch (error) {
        if (allowMissing && error?.code === "ENOENT") {
          return { exists: false, absolutePath: current, missingAt: index };
        }
        if (error?.code === "ENOENT") {
          throw new CodeExecutionError("FILE_NOT_FOUND", "工作区文件不存在");
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new CodeExecutionError("SYMLINK_REJECTED", "符号链接不可访问");
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new CodeExecutionError("FILE_NOT_FOUND", "工作区文件不存在");
      }
    }
    return { exists: true, absolutePath: current, stats };
  }

  async #collectFiles(execution, relativePath) {
    const scope = await this.#inspect(execution, relativePath);
    if (scope.stats.isFile()) return [relativePath];
    if (!scope.stats.isDirectory()) {
      throw new CodeExecutionError("FILE_NOT_FOUND", "工作区路径不是文件或目录");
    }
    const files = [];
    const visit = async (directoryPath, relativeDirectory) => {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childRelative = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        if (execution.workspace.policy.isExcluded(childRelative)) continue;
        const child = await this.#inspect(execution, childRelative);
        if (child.stats.isDirectory()) {
          await visit(child.absolutePath, childRelative);
        } else if (child.stats.isFile()) {
          files.push(childRelative);
          if (files.length > this.limits.maxFiles) {
            throw new CodeExecutionError(
              "FILE_COUNT_LIMIT",
              "文件数量超过限制",
            );
          }
        } else {
          throw new CodeExecutionError(
            "UNSUPPORTED_FILE_TYPE",
            "工作区包含不支持的文件类型",
          );
        }
      }
    };
    await visit(scope.absolutePath, relativePath);
    return files;
  }

  async #readFileBuffer(execution, relativePath) {
    const inspected = await this.#inspect(execution, relativePath);
    if (!inspected.stats.isFile()) {
      throw new CodeExecutionError("FILE_NOT_FOUND", "工作区文件不存在");
    }
    if (inspected.stats.size > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }
    const value = await readFile(inspected.absolutePath);
    if (value.length > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }
    return { value, stats: inspected.stats, absolutePath: inspected.absolutePath };
  }

  async #readTextFile(execution, relativePath) {
    const file = await this.#readFileBuffer(execution, relativePath);
    return {
      ...file,
      content: decodeText(file.value),
      sha256: sha256(file.value),
      bytes: file.value.length,
    };
  }

  async #writeFile(execution, action) {
    const relativePath = execution.workspace.policy.assertWritable(action.path);
    assertExpectedSha256(action.expectedSha256);
    if (typeof action.content !== "string" || action.content.includes("\0")) {
      throw new CodeExecutionError("TEXT_REQUIRED", "只能写入纯文本内容");
    }
    const value = Buffer.from(action.content, "utf8");
    if (value.length > this.limits.maxWriteBytes) {
      throw new CodeExecutionError("WRITE_SIZE_LIMIT", "写入内容超过大小限制");
    }
    if (value.length > this.limits.maxFileBytes) {
      throw new CodeExecutionError("FILE_SIZE_LIMIT", "文件超过大小限制");
    }

    const existing = await this.#inspect(execution, relativePath, {
      allowMissing: true,
    });
    if (existing.exists) {
      if (!existing.stats.isFile()) {
        throw new CodeExecutionError("WRITE_NOT_ALLOWED", "目标不是普通文件");
      }
      if (existing.stats.nlink > 1) {
        throw new CodeExecutionError("HARDLINK_REJECTED", "硬链接文件不可覆盖");
      }
      const current = await readFile(existing.absolutePath);
      if (sha256(current) !== action.expectedSha256) {
        throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
      }
    } else {
      if (action.expectedSha256 !== null) {
        throw new CodeExecutionError("SHA256_MISMATCH", "新文件必须使用空版本");
      }
      const files = await this.#collectFiles(execution, "");
      if (files.length >= this.limits.maxFiles) {
        throw new CodeExecutionError("FILE_COUNT_LIMIT", "文件数量超过限制");
      }
      await this.#ensureParentDirectories(execution, relativePath);
    }

    await this.#verifyWriteVersion(execution, relativePath, action.expectedSha256);
    const target = path.join(execution.root, ...relativePath.split("/"));
    const temporary = path.join(
      path.dirname(target),
      `.code-broker-tmp-${randomUUID()}.key`,
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(value);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return {
      path: relativePath,
      sha256: sha256(value),
      bytes: value.length,
    };
  }

  async #verifyWriteVersion(execution, relativePath, expectedSha256) {
    const current = await this.#inspect(execution, relativePath, {
      allowMissing: true,
    });
    if (!current.exists) {
      if (expectedSha256 !== null) {
        throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
      }
      return;
    }
    if (!current.stats.isFile() || current.stats.nlink > 1) {
      throw new CodeExecutionError("HARDLINK_REJECTED", "目标文件不可覆盖");
    }
    const value = await readFile(current.absolutePath);
    if (sha256(value) !== expectedSha256) {
      throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
    }
  }

  async #ensureParentDirectories(execution, relativePath) {
    const segments = relativePath.split("/").slice(0, -1);
    let current = execution.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
          throw new CodeExecutionError("SYMLINK_REJECTED", "符号链接不可访问");
        }
        if (!stats.isDirectory()) {
          throw new CodeExecutionError("WRITE_NOT_ALLOWED", "父路径不是目录");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(current);
      }
    }
  }

  async #deleteFile(execution, action) {
    const relativePath = execution.workspace.policy.assertWritable(action.path);
    assertExpectedSha256(action.expectedSha256);
    if (action.expectedSha256 === null) {
      throw new CodeExecutionError("INVALID_SHA256", "删除操作需要文件版本");
    }
    const file = await this.#readFileBuffer(execution, relativePath);
    if (file.stats.nlink > 1) {
      throw new CodeExecutionError("HARDLINK_REJECTED", "硬链接文件不可删除");
    }
    if (sha256(file.value) !== action.expectedSha256) {
      throw new CodeExecutionError("SHA256_MISMATCH", "文件已发生变化");
    }
    await unlink(file.absolutePath);
    return { path: relativePath, deleted: true };
  }
}
