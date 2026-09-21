import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { OperationQueue } from "./operation-queue.js";

const RENAME_RETRY_DELAYS_MS = Object.freeze([5, 10, 20, 40, 80]);
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const DEFAULT_FILE_SYSTEM = Object.freeze({ mkdir, readFile, rename, rm, writeFile });

function assertDependencies(fileSystem, delay) {
  if (
    !fileSystem ||
    !["mkdir", "readFile", "rename", "rm", "writeFile"].every(
      (name) => typeof fileSystem[name] === "function",
    ) ||
    typeof delay !== "function"
  ) {
    throw new TypeError("StateStore dependencies are invalid");
  }
}

async function replaceFile(fileSystem, delay, temporary, target) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fileSystem.rename(temporary, target);
      return;
    } catch (error) {
      const retryDelay = RENAME_RETRY_DELAYS_MS[attempt];
      if (
        retryDelay === undefined ||
        !RETRYABLE_RENAME_CODES.has(error?.code)
      ) {
        throw error;
      }
      // Windows may briefly deny replacing a target held by a reader or scanner.
      await delay(retryDelay);
    }
  }
}

async function discardTemporary(fileSystem, temporary) {
  try {
    await fileSystem.rm(temporary, { force: true });
  } catch {
    // Preserve the write failure; an abandoned unique temp file is non-authoritative.
  }
}

export class StateStore {
  constructor(
    dataDirectory,
    { fileSystem = DEFAULT_FILE_SYSTEM, wait: delay = wait } = {},
  ) {
    assertDependencies(fileSystem, delay);
    this.dataDirectory = dataDirectory;
    this.fileSystem = fileSystem;
    this.wait = delay;
    this.operationQueues = new Map();
    this.contentVersions = new Map();
  }

  async read(name, fallback = null, { signal } = {}) {
    return this.#queueFor(name).enqueue(async () => {
      const content = await this.#readContent(name, signal);
      return content.exists ? JSON.parse(content.serialized) : fallback;
    });
  }

  async readVersioned(name, fallback = null, { signal, ifVersion } = {}) {
    return this.#queueFor(name).enqueue(async () => {
      const content = await this.#readContent(name, signal);
      const version = this.#contentVersion(
        name,
        content.exists,
        content.serialized,
      );
      if (ifVersion === version) return { changed: false, version };
      return {
        changed: true,
        version,
        value: content.exists ? JSON.parse(content.serialized) : fallback,
      };
    });
  }

  async write(name, value) {
    return this.#queueFor(name).enqueue(async () => {
      await this.fileSystem.mkdir(this.dataDirectory, { recursive: true });
      const target = path.join(this.dataDirectory, `${name}.json`);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      const serialized = `${JSON.stringify(value, null, 2)}\n`;
      let committed = false;
      try {
        await this.fileSystem.writeFile(
          temporary,
          serialized,
          "utf8",
        );
        await replaceFile(this.fileSystem, this.wait, temporary, target);
        committed = true;
        return this.contentVersions.has(name)
          ? this.#contentVersion(name, true, serialized)
          : undefined;
      } finally {
        if (!committed) await discardTemporary(this.fileSystem, temporary);
      }
    });
  }

  async #readContent(name, signal) {
    try {
      return {
        exists: true,
        serialized: await this.fileSystem.readFile(
          path.join(this.dataDirectory, `${name}.json`),
          {
            encoding: "utf8",
            ...(signal === undefined ? {} : { signal }),
          },
        ),
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { exists: false, serialized: null };
      }
      throw error;
    }
  }

  #contentVersion(name, exists, serialized) {
    const current = this.contentVersions.get(name);
    if (
      current?.exists === exists &&
      current.serialized === serialized
    ) {
      return current.version;
    }
    const version = Object.freeze({});
    this.contentVersions.set(name, { exists, serialized, version });
    return version;
  }

  #queueFor(name) {
    let queue = this.operationQueues.get(name);
    if (!queue) {
      queue = new OperationQueue();
      this.operationQueues.set(name, queue);
    }
    return queue;
  }
}
