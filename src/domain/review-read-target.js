import { types } from "node:util";
import { normalizePullRequestGitTarget } from "./git-tool-contract.js";

export function normalizeReviewReadTarget(value) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("reviewTarget is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("gitTarget") || !keys.includes("pullRequestNumber")) {
    throw new TypeError("reviewTarget is invalid");
  }
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !("value" in field)) throw new TypeError("reviewTarget is invalid");
  }
  if (!Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1) {
    throw new TypeError("reviewTarget is invalid");
  }
  return Object.freeze({
    pullRequestNumber: value.pullRequestNumber,
    gitTarget: Object.freeze(normalizePullRequestGitTarget(value.gitTarget)),
  });
}
