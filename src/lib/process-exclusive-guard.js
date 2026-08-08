import { createHash } from "node:crypto";
import net from "node:net";
import { OperationQueue } from "./operation-queue.js";

const GUARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const PROJECT_DIGEST = /^[a-f0-9]{64}$/u;
const FIRST_PRIVATE_PORT = 49_152;
const PRIVATE_PORT_COUNT = 16_384;

export class ProcessExclusiveGuardError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProcessExclusiveGuardError";
    this.code = code;
  }
}

export function applicationWriterGuardName(projectDigest) {
  if (typeof projectDigest !== "string" || !PROJECT_DIGEST.test(projectDigest)) {
    throw new TypeError("projectDigest must be one lowercase SHA-256 digest");
  }
  return `mydashboard-data-writer-${projectDigest}`;
}

function guardEndpoint(name) {
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;

  const digest = createHash("sha256").update(name).digest();
  return {
    host: "127.0.0.1",
    port: FIRST_PRIVATE_PORT + (digest.readUInt16BE(0) % PRIVATE_PORT_COUNT),
    exclusive: true,
  };
}

function acquisitionError(name, cause) {
  if (cause?.code === "EADDRINUSE") {
    return new ProcessExclusiveGuardError(
      "PROCESS_GUARD_HELD",
      `Another process already owns guard ${name}`,
      { cause },
    );
  }
  return new ProcessExclusiveGuardError(
    "PROCESS_GUARD_ACQUIRE_FAILED",
    `Could not acquire process guard ${name}`,
    { cause },
  );
}

function closedError(name) {
  return new ProcessExclusiveGuardError(
    "PROCESS_GUARD_CLOSED",
    `Process guard ${name} is closed`,
  );
}

function notHeldError(name) {
  return new ProcessExclusiveGuardError(
    "PROCESS_GUARD_NOT_HELD",
    `Process guard ${name} is not held by this process`,
  );
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(endpoint);
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export class ProcessExclusiveGuard {
  constructor({ name }) {
    if (typeof name !== "string" || !GUARD_NAME.test(name)) {
      throw new TypeError("name must be a safe process guard name");
    }

    this.name = name;
    this.operationQueue = new OperationQueue();
    this.state = "idle";
    this.server = null;
    this.acquirePromise = null;
    this.acquireFailure = null;
    this.closePromise = null;
  }

  acquire() {
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(closedError(this.name));
    }
    if (this.acquireFailure) return Promise.reject(this.acquireFailure);
    if (this.acquirePromise) return this.acquirePromise;

    this.state = "acquiring";
    this.server = net.createServer((socket) => socket.destroy());
    this.acquirePromise = listen(this.server, guardEndpoint(this.name))
      .then(() => {
        if (this.state === "acquiring") this.state = "active";
      })
      .catch((error) => {
        this.acquireFailure = acquisitionError(this.name, error);
        this.state = "failed";
        throw this.acquireFailure;
      });
    return this.acquirePromise;
  }

  run(operation) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("operation must be a function"));
    }
    if (this.state === "closing" || this.state === "closed") {
      return Promise.reject(closedError(this.name));
    }

    const acquired = this.acquire();
    return this.operationQueue.enqueue(async () => {
      await acquired;
      return operation();
    });
  }

  assertHeld() {
    if (this.state !== "active" || this.server?.listening !== true) {
      throw notHeldError(this.name);
    }
    return true;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return Promise.resolve();

    const pendingAcquisition = this.acquirePromise;
    this.state = "closing";
    this.closePromise = this.operationQueue.enqueue(async () => {
      try {
        await pendingAcquisition;
      } catch {
        // A failed acquisition owns no operating-system handle.
      }
      await closeServer(this.server);
      this.server = null;
      this.state = "closed";
    });
    return this.closePromise;
  }
}
