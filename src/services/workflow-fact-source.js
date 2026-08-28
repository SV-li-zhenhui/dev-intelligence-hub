import { types as utilTypes } from "node:util";
import {
  normalizePullRequestGitTarget,
  pullRequestGitTargetFromEvent,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";
import { createPullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { createPullRequestReadIdentity } from "../domain/pull-request-read-facts.js";
import { normalizeStoredWorkflowEvent } from "../domain/workflow-events.js";
import { normalizePullRequestInputBinding } from "./work-ledger-pr-source.js";

const FACT_FIELDS = new Map([
  ["action-state", "actionState"],
  ["base-oid", "baseRefOid"],
  ["ci-status", "ciStatus"],
  ["head-oid", "headRefOid"],
  ["merge-state", "mergeStateStatus"],
  ["next-action", "nextAction"],
  ["review-decision", "reviewDecision"],
  ["state", "state"],
  ["issue-description", "description"],
  ["issue-comments-count", "commentsCount"],
  ["issue-latest-comment", "latestComment"],
]);
const SAFE_FACT = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const DEFAULT_MAXIMUM_AGE_MS = 15 * 60 * 1_000;
const FLAT_GIT_TARGET_FIELDS = Object.freeze([
  ["sourceAccountId", "githubAccount"],
  ["baseRepository", "baseRepository"],
  ["baseRefName", "baseRefName"],
  ["baseRefOid", "baseRefOid"],
  ["headRepository", "headRepository"],
  ["headRefName", "headRefName"],
  ["headRefOid", "headRefOid"],
]);
const OPTIONAL_REPEATED_GIT_TARGET_FIELDS = Object.freeze(
  FLAT_GIT_TARGET_FIELDS.filter(([, field]) => field !== "headRefOid"),
);

function invalid(message, options) {
  return new TypeError(message, options);
}

function ownData(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function exactInput(value) {
  const entries = ownData(value);
  if (
    !entries ||
    entries.size !== 2 ||
    !entries.has("item") ||
    !entries.has("fact")
  ) {
    throw invalid("workflow fact request is invalid");
  }
  const fact = entries.get("fact");
  if (typeof fact !== "string" || !SAFE_FACT.test(fact)) {
    throw invalid("workflow fact is invalid");
  }
  return { item: entries.get("item"), fact };
}

function exactPullRequestContextInput(value) {
  const entries = ownData(value);
  if (
    !entries ||
    entries.size !== 2 ||
    !entries.has("sourceBinding") ||
    !entries.has("event")
  ) {
    throw invalid("PR task context request is invalid");
  }
  let sourceBinding;
  let event;
  try {
    sourceBinding = normalizePullRequestInputBinding(
      entries.get("sourceBinding"),
    );
    event = normalizeStoredWorkflowEvent(entries.get("event"));
  } catch (cause) {
    throw invalid("PR task context binding is invalid", { cause });
  }
  return { sourceBinding, event };
}

function bindPortMethod(value, method, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    utilTypes.isProxy(value)
  ) {
    throw invalid(`${name} is invalid`);
  }
  let current = value;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, method);
      if (descriptor) {
        if (
          !Object.hasOwn(descriptor, "value") ||
          typeof descriptor.value !== "function"
        ) {
          throw invalid(`${name} is invalid`);
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === `${name} is invalid`) {
      throw error;
    }
    throw invalid(`${name} is invalid`, { cause: error });
  }
  throw invalid(`${name} is invalid`);
}

function optionalPullRequestContext(value) {
  return value === undefined || value === null
    ? null
    : bindPortMethod(value, "context", "pullRequestFacts");
}

function requestSignal(options) {
  if (options === undefined) return null;
  const entries = ownData(options);
  const signal = entries?.size === 1 ? entries.get("signal") : null;
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.throwIfAborted !== "function"
  ) {
    throw invalid("PR task context options are invalid");
  }
  return signal;
}

function isoTimestamp(value) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return null;
  }
  return value;
}

function nowTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch (error) {
    throw invalid("workflow fact clock failed", { cause: error });
  }
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!isoTimestamp(timestamp)) throw invalid("workflow fact clock is invalid");
  return timestamp;
}

function subjectId(item) {
  const itemEntries = ownData(item);
  const eventEntries = ownData(itemEntries?.get("event"));
  const subjectEntries = ownData(eventEntries?.get("subject"));
  const id = subjectEntries?.get("id");
  return typeof id === "string" && id.length <= 512 ? id : null;
}

function sourceKey(item) {
  const itemEntries = ownData(item);
  const eventEntries = ownData(itemEntries?.get("event"));
  const eventType = eventEntries?.get("eventType");
  if (typeof eventType !== "string") return null;
  if (eventType.startsWith("pull_request.")) return "githubPullRequests";
  if (eventType.startsWith("issue.")) return "githubIssues";
  return null;
}

function pullRequestHead(item) {
  const itemEntries = ownData(item);
  const eventEntries = ownData(itemEntries?.get("event"));
  const eventType = eventEntries?.get("eventType");
  if (
    typeof eventType !== "string" ||
    !eventType.startsWith("pull_request.")
  ) {
    return null;
  }
  const payloadEntries = ownData(eventEntries.get("payload"));
  const headRefOid = payloadEntries?.get("headRefOid");
  return typeof headRefOid === "string" && headRefOid.length <= 256
    ? headRefOid
    : "";
}

function expectedGitTarget(item) {
  const itemEntries = ownData(item);
  const eventEntries = ownData(itemEntries?.get("event"));
  if (!eventEntries) return { valid: false, target: null };
  const event = Object.fromEntries(eventEntries);
  try {
    return { valid: true, target: pullRequestGitTargetFromEvent(event) };
  } catch {
    return { valid: false, target: null };
  }
}

function flatGitTarget(matched) {
  return normalizePullRequestGitTarget({
    schemaVersion: 1,
    provider: "github",
    ...Object.fromEntries(
      FLAT_GIT_TARGET_FIELDS.map(([targetField, snapshotField]) => [
        targetField,
        matched.get(snapshotField),
      ]),
    ),
  });
}

function observedGitTarget(matched) {
  try {
    const hasAvailability = matched.has("gitTargetAvailable");
    const hasTarget = matched.has("gitTarget");
    if (hasAvailability) {
      if (matched.get("gitTargetAvailable") !== true || !hasTarget) {
        return null;
      }
      const target = normalizePullRequestGitTarget(matched.get("gitTarget"));
      if (target.headRefOid !== matched.get("headRefOid")) return null;
      const repeatedFields = OPTIONAL_REPEATED_GIT_TARGET_FIELDS.filter(
        ([, field]) => matched.has(field),
      );
      if (
        repeatedFields.length !== 0 &&
        (repeatedFields.length !== OPTIONAL_REPEATED_GIT_TARGET_FIELDS.length ||
          !samePullRequestGitTarget(target, flatGitTarget(matched)))
      ) {
        return null;
      }
      return target;
    }
    if (hasTarget) return null;
    return flatGitTarget(matched);
  } catch {
    return null;
  }
}

function selectedFactValue(matched, field) {
  if (field === "baseRefOid" && matched?.has("gitTarget")) {
    try {
      return normalizePullRequestGitTarget(matched.get("gitTarget")).baseRefOid;
    } catch {
      return null;
    }
  }
  if (field === "latestComment") {
    const comment = ownData(matched?.get(field));
    const names = ["author", "body", "createdAt", "updatedAt", "url"];
    if (
      !comment ||
      comment.size !== names.length ||
      names.some((name) => typeof comment.get(name) !== "string")
    ) {
      return null;
    }
    return JSON.stringify(Object.fromEntries(
      names.map((name) => [name, comment.get(name)]),
    ));
  }
  return field && matched ? normalizedFactValue(matched.get(field)) : null;
}

function normalizedFactValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  return null;
}

function result({ healthy, fresh, value = null, observedAt = null }) {
  return Object.freeze({ healthy, fresh, value, observedAt });
}

export class WorkflowFactSource {
  #readSnapshot;
  #readPullRequestContext;
  #pullRequestTaskContextReader;
  #clock;
  #maximumAgeMs;

  constructor({
    store,
    pullRequestFacts,
    clock = () => new Date(),
    maximumAgeMs = DEFAULT_MAXIMUM_AGE_MS,
  } = {}) {
    this.#readSnapshot = bindPortMethod(store, "read", "store");
    this.#readPullRequestContext = optionalPullRequestContext(pullRequestFacts);
    if (typeof clock !== "function") throw invalid("clock is invalid");
    if (
      !Number.isSafeInteger(maximumAgeMs) ||
      maximumAgeMs < 1_000 ||
      maximumAgeMs > 24 * 60 * 60 * 1_000
    ) {
      throw invalid("maximumAgeMs is invalid");
    }
    this.#pullRequestTaskContextReader = this.#readPullRequestContext === null
      ? null
      : Object.freeze({
          read: this.#readBoundPullRequestContext.bind(this),
        });
    this.#clock = clock;
    this.#maximumAgeMs = maximumAgeMs;
    Object.freeze(this);
  }

  async read(value) {
    const { item, fact } = exactInput(value);
    const expectedSubjectId = subjectId(item);
    const expectedSource = sourceKey(item);
    if (!expectedSubjectId || !expectedSource) {
      return result({ healthy: false, fresh: false });
    }

    const snapshot = await this.#readSnapshot("snapshot", null);
    const snapshotEntries = ownData(snapshot);
    const observedAt = isoTimestamp(snapshotEntries?.get("refreshedAt"));
    const sourceStatus = ownData(snapshotEntries?.get("sourceStatus"));
    const health = ownData(sourceStatus?.get(expectedSource));
    const healthy = health?.get("ok") === true && health?.get("stale") !== true;
    const now = Date.parse(nowTimestamp(this.#clock));
    const observed = observedAt ? Date.parse(observedAt) : Number.NaN;
    const age = now - observed;
    const fresh =
      healthy &&
      Number.isFinite(age) &&
      age >= -60_000 &&
      age <= this.#maximumAgeMs;
    if (!healthy || !fresh) {
      return result({ healthy, fresh, observedAt });
    }

    const items = snapshotEntries.get("items");
    if (
      !Array.isArray(items) ||
      utilTypes.isProxy(items) ||
      Object.getPrototypeOf(items) !== Array.prototype
    ) {
      return result({ healthy: false, fresh: false, observedAt });
    }
    let matched = null;
    for (let index = 0; index < items.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(items, `${index}`);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return result({ healthy: false, fresh: false, observedAt });
      }
      const entry = ownData(descriptor.value);
      if (!entry) return result({ healthy: false, fresh: false, observedAt });
      if (entry.get("id") === expectedSubjectId) {
        matched = entry;
        break;
      }
    }
    const expectedHead = pullRequestHead(item);
    if (
      expectedSource === "githubPullRequests" &&
      (!expectedHead || matched?.get("headRefOid") !== expectedHead)
    ) {
      return result({ healthy, fresh: false, observedAt });
    }
    if (expectedSource === "githubPullRequests") {
      const expected = expectedGitTarget(item);
      if (!expected.valid) {
        return result({ healthy, fresh: false, observedAt });
      }
      if (
        expected.target === null &&
        (matched?.has("gitTarget") || matched?.has("gitTargetAvailable"))
      ) {
        return result({ healthy, fresh: false, observedAt });
      }
      if (expected.target !== null) {
        const observed = matched === null ? null : observedGitTarget(matched);
        if (
          observed === null ||
          !samePullRequestGitTarget(expected.target, observed)
        ) {
          return result({ healthy, fresh: false, observedAt });
        }
      }
    }
    const field = FACT_FIELDS.get(fact);
    if (fact.startsWith("issue-") && expectedSource !== "githubIssues") {
      return result({ healthy, fresh, observedAt });
    }
    return result({
      healthy,
      fresh,
      value: selectedFactValue(matched, field),
      observedAt,
    });
  }

  pullRequestTaskContextReader() {
    return this.#pullRequestTaskContextReader;
  }

  async #readBoundPullRequestContext(value, options) {
    const signal = requestSignal(options);
    signal?.throwIfAborted();
    const { sourceBinding, event } = exactPullRequestContextInput(value);
    let executionBinding;
    try {
      executionBinding = createPullRequestExecutionBinding({
        sourceBinding,
        event,
      });
    } catch (cause) {
      throw invalid("PR task context execution binding is invalid", { cause });
    }
    if (executionBinding.schemaVersion !== 2) {
      throw invalid("PR task context requires an atomic Git target");
    }
    const identity = createPullRequestReadIdentity({ executionBinding, event });
    const context = await this.#readPullRequestContext(
      { executionBinding, event },
      signal === null ? undefined : { signal },
    );
    signal?.throwIfAborted();
    const fields = ownData(context);
    if (fields?.get("identityDigest") !== identity.identityDigest) {
      throw invalid("PR task context identity is stale");
    }
    return context;
  }
}
