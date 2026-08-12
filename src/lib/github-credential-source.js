import { types as utilTypes } from "node:util";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_TOKEN = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;
const ERROR_DEFINITIONS = Object.freeze({
  GITHUB_CLI_UNAVAILABLE: Object.freeze({
    message: "GitHub CLI is unavailable",
    statusCode: 503,
  }),
  GITHUB_LOGIN_UNAVAILABLE: Object.freeze({
    message: "GitHub CLI login is unavailable",
    statusCode: 503,
  }),
  GITHUB_CREDENTIAL_MISSING: Object.freeze({
    message: "GitHub credential is unavailable",
    statusCode: 503,
  }),
  GITHUB_CREDENTIAL_TIMEOUT: Object.freeze({
    message: "GitHub credential acquisition timed out",
    statusCode: 504,
  }),
  GITHUB_CREDENTIAL_CANCELLED: Object.freeze({
    message: "GitHub credential acquisition was cancelled",
    statusCode: 499,
  }),
  GITHUB_CREDENTIAL_OUTPUT_INVALID: Object.freeze({
    message: "GitHub credential output is invalid",
    statusCode: 502,
  }),
  GITHUB_CREDENTIAL_CLEANUP_FAILED: Object.freeze({
    message: "GitHub credential cleanup failed",
    statusCode: 500,
  }),
  GITHUB_ACTOR_MISMATCH: Object.freeze({
    message: "GitHub actor does not match the configured account",
    statusCode: 403,
  }),
});

export class GitHubCredentialSourceError extends Error {
  constructor(code) {
    const definition = ERROR_DEFINITIONS[code] ??
      ERROR_DEFINITIONS.GITHUB_CLI_UNAVAILABLE;
    super(definition.message);
    this.name = "GitHubCredentialSourceError";
    this.code = Object.hasOwn(ERROR_DEFINITIONS, code)
      ? code
      : "GITHUB_CLI_UNAVAILABLE";
    this.statusCode = definition.statusCode;
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

export function githubCredentialSourceError(code) {
  return new GitHubCredentialSourceError(code);
}

export function validGitHubLogin(value) {
  return typeof value === "string" && GITHUB_LOGIN.test(value);
}

export function validGitHubToken(value) {
  return typeof value === "string" && GITHUB_TOKEN.test(value);
}

function plainRecord(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !utilTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

export function normalizeCredentialAcquireRequest(
  value,
  expectedActorAccountId,
) {
  if (!plainRecord(value)) throw new TypeError("Credential request is invalid");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("actorAccountId") ||
    !keys.includes("signal") ||
    !keys.includes("deadline")
  ) {
    throw new TypeError("Credential request is invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError("Credential request is invalid");
    }
  }
  if (
    typeof value.actorAccountId !== "string" ||
    value.actorAccountId.toLowerCase() !== expectedActorAccountId.toLowerCase()
  ) {
    throw githubCredentialSourceError("GITHUB_ACTOR_MISMATCH");
  }
  if (
    value.signal !== null &&
    (!(value.signal instanceof AbortSignal) || utilTypes.isProxy(value.signal))
  ) {
    throw new TypeError("Credential signal is invalid");
  }
  if (!Number.isSafeInteger(value.deadline) || value.deadline < 1) {
    throw new TypeError("Credential deadline is invalid");
  }
  return Object.freeze({
    actorAccountId: expectedActorAccountId,
    signal: value.signal,
    deadline: value.deadline,
  });
}

export function createCredentialLease(initialToken) {
  if (!validGitHubToken(initialToken)) {
    throw new TypeError("Credential token is invalid");
  }
  let token = initialToken;
  let available = true;

  function release() {
    available = false;
    token = null;
  }

  async function use(callback) {
    if (!available) throw new TypeError("Credential lease is unavailable");
    if (typeof callback !== "function" || utilTypes.isProxy(callback)) {
      throw new TypeError("Credential lease callback is invalid");
    }
    available = false;
    const currentToken = token;
    try {
      return await callback(currentToken);
    } finally {
      token = null;
    }
  }

  return Object.freeze({ use, release });
}
