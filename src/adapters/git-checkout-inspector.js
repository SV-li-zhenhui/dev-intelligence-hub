import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { ManagedProcessRunner } from "../lib/managed-process.js";

const HEAD_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
});
const SAFE_GIT_PREFIX = Object.freeze([
  "--no-pager",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
]);

export class GitCheckoutInspectorError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GitCheckoutInspectorError";
    this.code = code;
  }
}

function inspectorError(code, message, cause) {
  return new GitCheckoutInspectorError(code, message, { cause });
}

function exactObject(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw inspectorError(
      "INVALID_GIT_CHECKOUT_INSPECTION",
      "Git checkout inspection 请求无效",
    );
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key !== "string" ||
        !keys.includes(key) ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      );
    })
  ) {
    throw inspectorError(
      "INVALID_GIT_CHECKOUT_INSPECTION",
      "Git checkout inspection 请求无效",
    );
  }
  return value;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function requireRunner(value) {
  if (!value || typeof value.run !== "function") {
    throw new TypeError("processRunner must provide run");
  }
  return value.run.bind(value);
}

function successfulOutput(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.exitCode !== 0 ||
    value.signal !== null ||
    value.truncated !== false ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string"
  ) {
    throw inspectorError(
      "GIT_CHECKOUT_INSPECTION_FAILED",
      "无法读取 Git checkout 状态",
    );
  }
  return value.stdout;
}

export class GitCheckoutInspector {
  #gitCommand;
  #run;
  #timeoutMs;

  constructor({
    gitCommand,
    processRunner = new ManagedProcessRunner(),
    timeoutMs = 15_000,
  } = {}) {
    if (
      typeof gitCommand !== "string" ||
      !path.isAbsolute(gitCommand) ||
      gitCommand.includes("\0")
    ) {
      throw inspectorError(
        "INVALID_GIT_CHECKOUT_INSPECTOR_CONFIG",
        "gitCommand 必须是可信的绝对路径",
      );
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      throw inspectorError(
        "INVALID_GIT_CHECKOUT_INSPECTOR_CONFIG",
        "Git inspection timeout 无效",
      );
    }
    this.#gitCommand = path.resolve(gitCommand);
    this.#run = requireRunner(processRunner);
    this.#timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  async inspect(value) {
    exactObject(value, ["sourceRoot"]);
    if (
      typeof value.sourceRoot !== "string" ||
      !path.isAbsolute(value.sourceRoot) ||
      value.sourceRoot.includes("\0")
    ) {
      throw inspectorError(
        "INVALID_GIT_CHECKOUT_INSPECTION",
        "sourceRoot 无效",
      );
    }
    const sourceRoot = path.resolve(value.sourceRoot);
    try {
      const stats = await lstat(sourceRoot);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw inspectorError(
          "GIT_CHECKOUT_ROOT_MISMATCH",
          "Git checkout 根目录不安全",
        );
      }
      const trustedRoot = await realpath(sourceRoot);
      if (!samePath(trustedRoot, sourceRoot)) {
        throw inspectorError(
          "GIT_CHECKOUT_ROOT_MISMATCH",
          "Git checkout 根目录身份不一致",
        );
      }
      const [headOutput, rootOutput, statusOutput] = await Promise.all([
        this.#git(["rev-parse", "--verify", "HEAD"], sourceRoot),
        this.#git(["rev-parse", "--show-toplevel"], sourceRoot),
        this.#git(
          [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignore-submodules=none",
          ],
          sourceRoot,
        ),
      ]);
      if (!HEAD_OID.test(headOutput) || /[\r\n]/.test(headOutput)) {
        throw inspectorError(
          "GIT_CHECKOUT_INSPECTION_FAILED",
          "Git Head 无法验证",
        );
      }
      if (/\r|\n/.test(rootOutput) || !path.isAbsolute(rootOutput)) {
        throw inspectorError(
          "GIT_CHECKOUT_ROOT_MISMATCH",
          "Git checkout 根目录无法验证",
        );
      }
      const repositoryRoot = await realpath(path.resolve(rootOutput));
      if (!samePath(repositoryRoot, trustedRoot)) {
        throw inspectorError(
          "GIT_CHECKOUT_ROOT_MISMATCH",
          "Git checkout 必须绑定仓库根目录",
        );
      }
      return Object.freeze({
        headOid: headOutput,
        clean: statusOutput.length === 0,
      });
    } catch (cause) {
      if (cause instanceof GitCheckoutInspectorError) throw cause;
      throw inspectorError(
        "GIT_CHECKOUT_INSPECTION_FAILED",
        "无法读取 Git checkout 状态",
        cause,
      );
    }
  }

  async #git(args, cwd) {
    return successfulOutput(
      await this.#run({
        command: this.#gitCommand,
        args: [...SAFE_GIT_PREFIX, ...args],
        cwd,
        env: SAFE_ENV,
        timeoutMs: this.#timeoutMs,
      }),
    );
  }
}
