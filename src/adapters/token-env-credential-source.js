import { types as utilTypes } from "node:util";

import {
  createCredentialLease,
  githubCredentialSourceError,
  normalizeCredentialAcquireRequest,
  validGitHubLogin,
  validGitHubToken,
} from "../lib/github-credential-source.js";

const TOKEN_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

export class TokenEnvCredentialSource {
  #actorAccountId;
  #clock;
  #environment;
  #tokenEnv;

  constructor({
    actorAccountId,
    tokenEnv,
    environment = process.env,
    clock = () => Date.now(),
  } = {}) {
    if (!validGitHubLogin(actorAccountId)) {
      throw new TypeError("GitHub actor account is invalid");
    }
    if (
      typeof tokenEnv !== "string" ||
      !TOKEN_ENV_NAME.test(tokenEnv) ||
      tokenEnv === "__PROTO__"
    ) {
      throw new TypeError("GitHub token environment name is invalid");
    }
    if (
      environment === null ||
      typeof environment !== "object" ||
      utilTypes.isProxy(environment) ||
      typeof clock !== "function"
    ) {
      throw new TypeError("GitHub token environment is invalid");
    }
    this.#actorAccountId = actorAccountId;
    this.#tokenEnv = tokenEnv;
    this.#environment = environment;
    this.#clock = clock;
    Object.freeze(this);
  }

  async acquire(rawRequest) {
    const request = normalizeCredentialAcquireRequest(
      rawRequest,
      this.#actorAccountId,
    );
    if (request.signal?.aborted) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
    }
    if (this.#clock() >= request.deadline) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(
        this.#environment,
        this.#tokenEnv,
      );
    } catch {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_MISSING");
    }
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      !validGitHubToken(descriptor.value)
    ) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_MISSING");
    }
    if (request.signal?.aborted) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_CANCELLED");
    }
    if (this.#clock() >= request.deadline) {
      throw githubCredentialSourceError("GITHUB_CREDENTIAL_TIMEOUT");
    }
    return createCredentialLease(descriptor.value);
  }
}
