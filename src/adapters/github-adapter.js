import { types as utilTypes } from "node:util";

import { runCommand, runJson } from "../lib/command-runner.js";
import {
  normalizePullRequestGitTarget,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";
import {
  createPullRequestReadIdentity,
} from "../domain/pull-request-read-facts.js";
import { normalizeEffectivePullRequestUpdatedWindow } from "../domain/pull-request-updated-window.js";
import {
  GITHUB_PULL_REQUEST_FACTS_QUERY,
  githubGraphPullRequestTarget,
  githubViewPullRequestTargetState,
  projectGitHubPullRequestFacts,
} from "./github-pull-request-facts.js";

const GITHUB_HOST = "github.com";
const SEARCH_LIMIT = 1_000;
const ISSUE_DETAIL_BATCH_SIZE = 100;
const MILESTONE_PAGE_SIZE = 100;
const MILESTONES_PER_REPOSITORY = 10;
const SECOND_MS = 1_000;
// GitHub search accepts years only through 2970. Keep rolling windows finite
// at the transport boundary while retaining their open-ended domain meaning.
const MAX_SEARCH_TIMESTAMP = Date.parse("2970-12-31T23:59:59.000Z");
const SEARCH_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const PR_SEARCH_FIELDS =
  "number,title,url,repository,updatedAt,createdAt,author,state";
const PR_DETAIL_FIELDS =
  "number,url,body,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,mergeStateStatus,isDraft,labels,assignees,milestone,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,reviews";
const PR_REVIEW_CONTEXT_FIELDS =
  "number,url,title,body,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,additions,deletions,changedFiles,files";
const PR_TARGET_FIELDS =
  "number,url,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner";
const PR_OWNER_CONTEXT_FIELDS = `${PR_REVIEW_CONTEXT_FIELDS},state`;
const PR_OPEN_TARGET_FIELDS = `${PR_TARGET_FIELDS},state`;
const ISSUE_FIELDS =
  "id,number,title,body,url,repository,updatedAt,createdAt,author,state,labels,assignees,commentsCount";
const ISSUE_DETAIL_QUERY =
  "query($ids:[ID!]!){nodes(ids:$ids){... on Issue{id number body milestone{title} comments(last:1){totalCount nodes{author{login} body createdAt updatedAt url}}}}}";
const GITHUB_DESCRIPTION_MAXIMUM_BYTES = 12 * 1024;
const ISSUE_COMMENT_MAXIMUM_BYTES = 4 * 1024;
const PULL_REQUEST_GIT_FACT_FIELDS = Object.freeze([
  "githubAccount",
  "baseRepository",
  "baseRefName",
  "baseRefOid",
  "headRepository",
  "headRefName",
  "headRefOid",
]);

function recentActiveMilestones(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("GitHub milestone response must be an array");
  }
  const milestones = value.every(Array.isArray) ? value.flat() : value;
  return [...milestones]
    .sort((left, right) => {
      const activityDifference =
        Number((right?.open_issues || 0) > 0) -
        Number((left?.open_issues || 0) > 0);
      if (activityDifference !== 0) return activityDifference;
      const updatedDifference =
        Date.parse(right?.updated_at || 0) -
        Date.parse(left?.updated_at || 0);
      if (Number.isFinite(updatedDifference) && updatedDifference !== 0) {
        return updatedDifference;
      }
      return Number(right?.number || 0) - Number(left?.number || 0);
    })
    .slice(0, MILESTONES_PER_REPOSITORY);
}

function repositoryName(item) {
  return item.repository?.nameWithOwner || item.repository?.name || "";
}

function boundedGitHubText(value, maximumBytes) {
  if (typeof value !== "string" || maximumBytes < 1) return "";
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maximumBytes) break;
    result += character;
    bytes += nextBytes;
  }
  return result;
}

function issueNodeId(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("GitHub issue node id is invalid");
  }
  return value;
}

function issueLatestComment(connection) {
  const count = Number.isSafeInteger(connection?.totalCount) &&
      connection.totalCount >= 0
    ? connection.totalCount
    : 0;
  const comment = Array.isArray(connection?.nodes)
    ? connection.nodes.at(-1)
    : null;
  return {
    commentsCount: count,
    latestComment: comment && typeof comment === "object"
      ? {
          author: boundedGitHubText(comment.author?.login, 256),
          body: boundedGitHubText(comment.body, ISSUE_COMMENT_MAXIMUM_BYTES),
          createdAt: typeof comment.createdAt === "string"
            ? comment.createdAt
            : "",
          updatedAt: typeof comment.updatedAt === "string"
            ? comment.updatedAt
            : "",
          url: typeof comment.url === "string" ? comment.url : "",
        }
      : null,
  };
}

function headRepositoryName(detail) {
  const repository = detail?.headRepository;
  const owner = detail?.headRepositoryOwner;
  if (
    typeof repository?.name !== "string" ||
    repository.name.length === 0 ||
    typeof owner?.login !== "string" ||
    owner.login.length === 0
  ) {
    return "";
  }
  return `${owner.login}/${repository.name}`;
}

function pullRequestIdentity(url) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== GITHUB_HOST ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const match = parsed.pathname.match(
      /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]*)\/?$/,
    );
    if (!match) return null;
    return {
      repository: `${match[1]}/${match[2]}`,
      number: Number(match[3]),
    };
  } catch {
    return null;
  }
}

function canonicalBaseRepository(item, detail, expectedTarget = null) {
  if (expectedTarget === null) {
    return item.repo || item.baseRepository || "";
  }
  const expectedIdentity = pullRequestIdentity(item.url);
  const observedIdentity = pullRequestIdentity(detail.url);
  const expectedNumber = Number.isSafeInteger(item.number)
    ? item.number
    : expectedIdentity?.number;
  if (
    expectedIdentity === null ||
    observedIdentity === null ||
    expectedIdentity.repository !== expectedTarget.baseRepository ||
    observedIdentity.repository !== expectedTarget.baseRepository ||
    observedIdentity.number !== expectedNumber ||
    detail.number !== expectedNumber
  ) {
    return "";
  }
  return observedIdentity.repository;
}

function pullRequestGitFacts(detail, { repository, account }) {
  return {
    githubAccount: account || "",
    baseRepository: repository || "",
    baseRefName: detail.baseRefName || "",
    baseRefOid: detail.baseRefOid || "",
    headRepository: headRepositoryName(detail),
    headRefName: detail.headRefName || "",
    headRefOid: detail.headRefOid || "",
  };
}

function completePullRequestGitFacts(facts) {
  if (
    !PULL_REQUEST_GIT_FACT_FIELDS.every(
      (field) => typeof facts[field] === "string" && facts[field].length > 0,
    )
  ) {
    return false;
  }
  try {
    gitTargetFromFacts(facts);
    return true;
  } catch {
    return false;
  }
}

function gitTargetFromFacts(facts) {
  return normalizePullRequestGitTarget({
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: facts.githubAccount,
    baseRepository: facts.baseRepository,
    baseRefName: facts.baseRefName,
    baseRefOid: facts.baseRefOid,
    headRepository: facts.headRepository,
    headRefName: facts.headRefName,
    headRefOid: facts.headRefOid,
  });
}

function sameExpectedGitFacts(item, facts) {
  if (item.gitTarget !== undefined && item.gitTarget !== null) {
    if (!completePullRequestGitFacts(facts)) return false;
    return samePullRequestGitTarget(
      item.gitTarget,
      gitTargetFromFacts(facts),
    );
  }
  return PULL_REQUEST_GIT_FACT_FIELDS.every(
    (field) => !item[field] || item[field] === facts[field],
  );
}

function staleReviewContext() {
  return Object.assign(new Error("PR Git target changed while reading context"), {
    name: "GitHubReadError",
    code: "PR_CONTEXT_STALE",
    statusCode: 409,
  });
}

function staleReadFacts() {
  return Object.assign(
    new Error("PR execution identity changed while reading facts"),
    {
      name: "GitHubReadError",
      code: "PR_FACTS_STALE",
      statusCode: 409,
    },
  );
}

function terminalReadFacts(state) {
  return Object.assign(
    new Error(`PR entered terminal state ${state} while reading facts`),
    {
      name: "GitHubReadError",
      code: "PR_FACTS_TERMINAL",
      statusCode: 409,
      terminalState: state,
    },
  );
}

function githubAccountLogin(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    utilTypes.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("GitHub account response is invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "login");
  if (
    !descriptor?.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(
      descriptor.value,
    )
  ) {
    throw new TypeError("GitHub account response is invalid");
  }
  return descriptor.value;
}

function sameGitHubAccount(value, expected) {
  return (
    typeof value === "string" && value.toLowerCase() === expected.toLowerCase()
  );
}

function boundedPositiveInteger(
  value,
  fallback,
  maximum,
  name,
  minimum = 1,
) {
  const selected = value === undefined ? fallback : value;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return selected;
}

function clockTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw new TypeError("GitHubAdapter clock failed");
  }
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw new TypeError("GitHubAdapter clock is invalid");
  }
  return timestamp;
}

function sameObservedReadTarget(observed, identity) {
  const binding = identity.executionBinding;
  const expectedIdentity = pullRequestIdentity(
    `https://${GITHUB_HOST}/${binding.repository}/pull/${binding.pullRequestNumber}`,
  );
  const observedIdentity = pullRequestIdentity(observed.url);
  return (
    expectedIdentity !== null &&
    observedIdentity !== null &&
    observed.number === binding.pullRequestNumber &&
    observedIdentity.number === binding.pullRequestNumber &&
    observedIdentity.repository === binding.repository &&
    samePullRequestGitTarget(observed.gitTarget, binding.gitTarget)
  );
}

export function classifyPullRequestRelation(source, author, currentUser) {
  if (source !== "assigned") return source;
  return author.toLowerCase() === currentUser.toLowerCase()
    ? "authored"
    : "review_requested";
}

function pullRequestKey(record) {
  return `${repositoryName(record)}#${record.number}`;
}

function canonicalSearchTimestamp(value, field) {
  if (typeof value !== "string" || !SEARCH_TIMESTAMP.test(value)) {
    throw new TypeError(`GitHub PR ${field} is invalid`);
  }
  const milliseconds = Date.parse(value);
  const expectedCanonical = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/u, (_match, fraction) =>
        `.${fraction.padEnd(3, "0")}Z`)
    : value.replace(/Z$/u, ".000Z");
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== expectedCanonical
  ) {
    throw new TypeError(`GitHub PR ${field} is invalid`);
  }
  return { milliseconds, canonical: new Date(milliseconds).toISOString() };
}

function safeSearchRecord(record) {
  if (
    record === null ||
    typeof record !== "object" ||
    utilTypes.isProxy(record) ||
    Array.isArray(record) ||
    Object.getPrototypeOf(record) !== Object.prototype
  ) {
    throw new TypeError("GitHub PR search record is invalid");
  }
  const repository = repositoryName(record);
  const identity = pullRequestIdentity(record.url);
  const author = record.author?.login;
  const updated = canonicalSearchTimestamp(record.updatedAt, "updatedAt");
  const created = canonicalSearchTimestamp(record.createdAt, "createdAt");
  if (
    !Number.isSafeInteger(record.number) ||
    record.number < 1 ||
    typeof record.title !== "string" ||
    record.title.length > 64 * 1_024 ||
    identity === null ||
    identity.number !== record.number ||
    identity.repository !== repository ||
    typeof author !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(author) ||
    typeof record.state !== "string"
  ) {
    throw new TypeError("GitHub PR search identity is invalid");
  }
  return {
    ...record,
    createdAt: created.canonical,
    updatedAt: updated.canonical,
    searchUpdatedAtMilliseconds: updated.milliseconds,
    searchIdentity: Object.freeze({
      repository,
      number: record.number,
      url: record.url,
      createdAt: created.canonical,
      author,
    }),
  };
}

function sameSearchIdentity(left, right) {
  return (
    left.repository === right.repository &&
    left.number === right.number &&
    left.url === right.url &&
    left.createdAt === right.createdAt &&
    left.author === right.author
  );
}

function mergeSearchRecords(groups) {
  const records = new Map();
  for (const group of groups) {
    for (const record of group) {
      const key = pullRequestKey(record);
      const existing = records.get(key);
      if (
        existing &&
        (!sameSearchIdentity(existing.searchIdentity, record.searchIdentity) ||
          existing.updatedAt !== record.updatedAt)
      ) {
        throw new Error(`GitHub PR search identity conflict for ${key}`);
      }
      if (!existing) records.set(key, record);
    }
  }
  return [...records.values()];
}

function githubSearchInstant(milliseconds) {
  return new Date(Math.floor(milliseconds / SECOND_MS) * SECOND_MS)
    .toISOString()
    .replace(".000Z", "+00:00");
}

function searchRangeArgument(startMilliseconds, endMilliseconds) {
  return `${githubSearchInstant(startMilliseconds)}..${githubSearchInstant(endMilliseconds)}`;
}

function effectiveSearchBounds(window) {
  return {
    startMilliseconds:
      Math.floor(Date.parse(window.fromInclusive) / SECOND_MS) * SECOND_MS,
    endMilliseconds:
      window.mode === "fixed"
        ? Math.floor(Date.parse(window.untilExclusive) / SECOND_MS) * SECOND_MS
        : MAX_SEARCH_TIMESTAMP,
  };
}

function withinEffectiveWindow(record, window) {
  const timestamp = record.searchUpdatedAtMilliseconds;
  if (timestamp < Date.parse(window.fromInclusive)) return false;
  return window.mode !== "fixed" || timestamp < Date.parse(window.untilExclusive);
}

function discoveryOptions(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    utilTypes.isProxy(options) ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("GitHub discovery options are invalid");
  }
  const commandOptions = { ...options };
  const suppliedWindow = commandOptions.effectiveUpdatedWindow;
  delete commandOptions.effectiveUpdatedWindow;
  return {
    commandOptions,
    effectiveUpdatedWindow:
      suppliedWindow === undefined
        ? null
        : normalizeEffectivePullRequestUpdatedWindow(suppliedWindow),
  };
}

export function combinePullRequestRecords(assigned, authored, currentUser) {
  const records = new Map();
  const addRecords = (items, source) => {
    for (const item of items) {
      const key = pullRequestKey(item);
      const existing = records.get(key) || {
        ...item,
        relationSources: [],
      };
      if (!existing.relationSources.includes(source)) {
        existing.relationSources.push(source);
      }
      records.set(key, existing);
    }
  };

  addRecords(assigned, "assignee");
  addRecords(authored, "author");

  return [...records.values()]
    .map((record) => {
      const author = record.author?.login || "";
      const relation =
        author.toLowerCase() === currentUser.toLowerCase()
          ? "authored"
          : "review_requested";
      return {
        ...record,
        relation,
        assignmentSource: relation === "authored" ? "author" : "assignee",
      };
    })
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0),
    );
}

function latestReview(reviews, predicate) {
  return reviews
    .filter(predicate)
    .sort(
      (left, right) =>
        Date.parse(right.submittedAt || 0) -
        Date.parse(left.submittedAt || 0),
    )[0];
}

function reviewFields(prefix, review) {
  return {
    [`${prefix}State`]: review?.state || "",
    [`${prefix}At`]: review?.submittedAt || null,
    [`${prefix}CommitOid`]: review?.commit?.oid || "",
  };
}

export function summarizeReviewFacts(reviews = [], currentUser) {
  const normalizedUser = currentUser.toLowerCase();
  const authoredByCurrentUser = (review) =>
    (review.author?.login || "").toLowerCase() === normalizedUser;
  const decisiveStates = new Set(["APPROVED", "CHANGES_REQUESTED"]);
  const myDecision = latestReview(
    reviews,
    (review) =>
      authoredByCurrentUser(review) && decisiveStates.has(review.state),
  );
  const myReview =
    myDecision || latestReview(reviews, authoredByCurrentUser);
  const latestOtherDecision = latestReview(
    reviews,
    (review) =>
      !authoredByCurrentUser(review) && decisiveStates.has(review.state),
  );
  const latestDecisionByReviewer = new Map();
  for (const review of reviews) {
    const reviewer = (review.author?.login || "").toLowerCase();
    if (
      !reviewer ||
      reviewer === normalizedUser ||
      !decisiveStates.has(review.state)
    ) {
      continue;
    }
    const existing = latestDecisionByReviewer.get(reviewer);
    if (
      !existing ||
      Date.parse(review.submittedAt || 0) >
        Date.parse(existing.submittedAt || 0)
    ) {
      latestDecisionByReviewer.set(reviewer, review);
    }
  }
  const outstandingChangeRequests = [...latestDecisionByReviewer.values()]
    .filter((review) => review.state === "CHANGES_REQUESTED")
    .sort(
      (left, right) =>
        Date.parse(right.submittedAt || 0) -
        Date.parse(left.submittedAt || 0),
    );
  const latestChangeRequest = outstandingChangeRequests[0];
  return {
    ...reviewFields("myReview", myReview),
    ...reviewFields("latestOtherDecision", latestOtherDecision),
    ...reviewFields("latestChangeRequest", latestChangeRequest),
    outstandingChangeRequestCommitOids: [
      ...new Set(
        outstandingChangeRequests
          .map((review) => review.commit?.oid)
          .filter(Boolean),
      ),
    ],
  };
}

export function summarizeCheckStatus(checks = []) {
  if (!checks.length) return "NONE";
  const failureStates = new Set([
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "CANCELLED",
    "STARTUP_FAILURE",
    "STALE",
  ]);
  const pendingStates = new Set([
    "PENDING",
    "QUEUED",
    "IN_PROGRESS",
    "EXPECTED",
    "WAITING",
    "REQUESTED",
  ]);
  const successStates = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  let sawPending = false;
  let sawSuccess = false;
  let sawUnknown = false;

  for (const check of checks) {
    const conclusion = check.conclusion || check.state || "";
    const lifecycle = check.status || check.state || "";
    if (failureStates.has(conclusion) || failureStates.has(lifecycle)) {
      return "FAILURE";
    }
    if (pendingStates.has(conclusion) || pendingStates.has(lifecycle)) {
      sawPending = true;
      continue;
    }
    if (successStates.has(conclusion)) {
      sawSuccess = true;
    } else {
      sawUnknown = true;
    }
  }
  if (sawPending) return "PENDING";
  if (sawUnknown) return "UNKNOWN";
  return sawSuccess ? "SUCCESS" : "UNKNOWN";
}

async function mapWithConcurrency(items, limit, transform) {
  const result = new Array(items.length);
  let cursor = 0;
  let firstError;
  async function worker() {
    while (!firstError && cursor < items.length) {
      const index = cursor++;
      try {
        result[index] = await transform(items[index]);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
  return result;
}

function bindGitHubHost(port, environment) {
  return (command, args, options = {}) =>
    port(command, args, { ...options, env: environment });
}

export class GitHubAdapter {
  constructor({
    run = runJson,
    runText = runCommand,
    env = process.env,
    maxPatchCharacters = 24_000,
    maxReadComments,
    maxReadReviews,
    maxReadThreads,
    maxReadThreadComments,
    maxReadChecks,
    maxReadBodyBytes,
    maxReadFactBytes,
    clock = () => new Date(),
  } = {}) {
    const commandEnvironment = Object.freeze({ ...env, GH_HOST: GITHUB_HOST });
    this.run = bindGitHubHost(run, commandEnvironment);
    this.runText = bindGitHubHost(runText, commandEnvironment);
    this.maxPatchCharacters =
      Number.isFinite(maxPatchCharacters) && maxPatchCharacters > 0
        ? maxPatchCharacters
        : 24_000;
    if (typeof clock !== "function") {
      throw new TypeError("GitHubAdapter clock is invalid");
    }
    this.clock = clock;
    this.pullRequestFactLimits = Object.freeze({
      comments: boundedPositiveInteger(
        maxReadComments,
        20,
        100,
        "maxReadComments",
      ),
      reviews: boundedPositiveInteger(
        maxReadReviews,
        20,
        100,
        "maxReadReviews",
      ),
      threads: boundedPositiveInteger(
        maxReadThreads,
        20,
        100,
        "maxReadThreads",
      ),
      threadComments: boundedPositiveInteger(
        maxReadThreadComments,
        5,
        20,
        "maxReadThreadComments",
      ),
      checks: boundedPositiveInteger(
        maxReadChecks,
        50,
        100,
        "maxReadChecks",
      ),
      bodyBytes: boundedPositiveInteger(
        maxReadBodyBytes,
        4_096,
        16 * 1024,
        "maxReadBodyBytes",
      ),
      factBytes: boundedPositiveInteger(
        maxReadFactBytes,
        256 * 1024,
        512 * 1024,
        "maxReadFactBytes",
        8 * 1024,
      ),
    });
  }

  async currentUser(options = {}) {
    const data = await this.run("gh", [
      "api",
      "--hostname",
      GITHUB_HOST,
      "user",
    ], options);
    return githubAccountLogin(data);
  }

  #pullRequestSearchArguments(relation, range = null) {
    const filter = {
      assigned: "--assignee=@me",
      authored: "--author=@me",
    }[relation];
    return [
      "search",
      "prs",
      filter,
      "--state=open",
      "--limit",
      `${SEARCH_LIMIT}`,
      "--json",
      PR_SEARCH_FIELDS,
      ...(range === null
        ? []
        : ["--updated", range, "--sort", "updated", "--order", "asc"]),
    ];
  }

  async #searchPullRequestSegment(
    relation,
    startMilliseconds,
    endMilliseconds,
    options,
  ) {
    const range = searchRangeArgument(startMilliseconds, endMilliseconds);
    const rawRecords = await this.run(
      "gh",
      this.#pullRequestSearchArguments(relation, range),
      options,
    );
    options.signal?.throwIfAborted();
    if (!Array.isArray(rawRecords) || rawRecords.length > SEARCH_LIMIT) {
      throw new TypeError("GitHub PR search result count is invalid");
    }
    const records = rawRecords.map(safeSearchRecord);
    if (
      records.some(
        (record) =>
          record.searchUpdatedAtMilliseconds < startMilliseconds ||
          record.searchUpdatedAtMilliseconds > endMilliseconds + 999,
      )
    ) {
      throw new Error("GitHub PR search returned a record outside its segment");
    }
    if (records.length < SEARCH_LIMIT) return records;
    if (endMilliseconds - startMilliseconds <= SECOND_MS) {
      throw new Error("GitHub PR search is saturated within one second");
    }
    const startSecond = Math.floor(startMilliseconds / SECOND_MS);
    const endSecond = Math.floor(endMilliseconds / SECOND_MS);
    const midpoint =
      Math.floor((startSecond + endSecond) / 2) * SECOND_MS;
    if (midpoint <= startMilliseconds || midpoint >= endMilliseconds) {
      throw new Error("GitHub PR search range cannot be split safely");
    }
    const left = await this.#searchPullRequestSegment(
      relation,
      startMilliseconds,
      midpoint,
      options,
    );
    const right = await this.#searchPullRequestSegment(
      relation,
      midpoint,
      endMilliseconds,
      options,
    );
    return mergeSearchRecords([left, right]);
  }

  async #searchPullRequestRecords(relation, effectiveWindow, options) {
    if (effectiveWindow === null || effectiveWindow.mode === "unlimited") {
      return this.run(
        "gh",
        this.#pullRequestSearchArguments(relation),
        options,
      );
    }
    const { startMilliseconds, endMilliseconds } =
      effectiveSearchBounds(effectiveWindow);
    const records = await this.#searchPullRequestSegment(
      relation,
      startMilliseconds,
      endMilliseconds,
      options,
    );
    return records.filter((record) =>
      withinEffectiveWindow(record, effectiveWindow),
    );
  }

  async #enrichPullRequest(record, currentUser, options) {
    const detail = await this.run("gh", [
      "pr",
      "view",
      record.url,
      "--json",
      PR_DETAIL_FIELDS,
    ], options);
    const recordIdentity = pullRequestIdentity(record.url);
    const detailIdentity = pullRequestIdentity(detail.url);
    const repo = repositoryName(record);
    if (
      recordIdentity === null ||
      detailIdentity === null ||
      recordIdentity.repository !== repo ||
      detailIdentity.repository !== repo ||
      recordIdentity.number !== record.number ||
      detailIdentity.number !== record.number ||
      detail.number !== record.number
    ) {
      throw new Error("GitHub PR identity changed during refresh");
    }
    const author = record.author?.login || "";
    const gitFacts = pullRequestGitFacts(detail, {
      repository: repo,
      account: currentUser,
    });
    return {
      id: `github:pr:${repo}#${record.number}`,
      kind: "pull_request",
      relation: record.relation,
      relationSources: record.relationSources,
      assignmentSource: record.assignmentSource,
      repo,
      number: record.number,
      title: record.title,
      url: record.url,
      author,
      currentUser,
      state: record.state?.toLowerCase() || "open",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      reviewDecision: detail.reviewDecision || "",
      ciStatus: summarizeCheckStatus(detail.statusCheckRollup),
      mergeStateStatus: detail.mergeStateStatus || "",
      isDraft: Boolean(detail.isDraft),
      description: boundedGitHubText(
        detail.body,
        GITHUB_DESCRIPTION_MAXIMUM_BYTES,
      ),
      additions: Number.isSafeInteger(detail.additions) ? detail.additions : 0,
      deletions: Number.isSafeInteger(detail.deletions) ? detail.deletions : 0,
      changedFiles: Number.isSafeInteger(detail.changedFiles)
        ? detail.changedFiles
        : 0,
      labels: (detail.labels || []).map((label) => label.name),
      assignees: (detail.assignees || []).map((user) => user.login),
      milestone: detail.milestone?.title || "",
      headRefOid: detail.headRefOid || "",
      gitTargetAvailable: completePullRequestGitFacts(gitFacts),
      ...(completePullRequestGitFacts(gitFacts)
        ? { ...gitFacts, gitTarget: gitTargetFromFacts(gitFacts) }
        : {}),
      reviewFactsAvailable: true,
      ...summarizeReviewFacts(detail.reviews, currentUser),
    };
  }

  async searchRelevantPullRequests(options = {}) {
    const { commandOptions, effectiveUpdatedWindow } = discoveryOptions(options);
    const currentUser = await this.currentUser(commandOptions);
    const [assigned, authored] = await Promise.all([
      this.#searchPullRequestRecords(
        "assigned",
        effectiveUpdatedWindow,
        commandOptions,
      ),
      this.#searchPullRequestRecords(
        "authored",
        effectiveUpdatedWindow,
        commandOptions,
      ),
    ]);
    if (effectiveUpdatedWindow && effectiveUpdatedWindow.mode !== "unlimited") {
      mergeSearchRecords([assigned, authored]);
    }
    const records = combinePullRequestRecords(
      assigned,
      authored,
      currentUser,
    );
    const items = await mapWithConcurrency(records, 4, (record) =>
      this.#enrichPullRequest(record, currentUser, commandOptions),
    );
    const finalUser = await this.currentUser(commandOptions);
    if (finalUser.toLowerCase() !== currentUser.toLowerCase()) {
      throw new Error("GitHub account changed during PR refresh");
    }
    return items;
  }

  async searchPullRequests(relation, currentUser, options = {}) {
    const { commandOptions, effectiveUpdatedWindow } = discoveryOptions(options);
    const records = await this.#searchPullRequestRecords(
      relation,
      effectiveUpdatedWindow,
      commandOptions,
    );
    const items = await mapWithConcurrency(records, 4, (record) =>
      this.#enrichPullRequest(
        {
          ...record,
          relation: classifyPullRequestRelation(
            relation,
            record.author?.login || "",
            currentUser,
          ),
          relationSources: [
            relation === "assigned" ? "assignee" : "author",
          ],
          assignmentSource:
            relation === "assigned" ? "assignee" : "author",
        },
        currentUser,
        commandOptions,
      ),
    );
    const finalUser = await this.currentUser(commandOptions);
    if (finalUser.toLowerCase() !== currentUser.toLowerCase()) {
      throw new Error("GitHub account changed during PR refresh");
    }
    return items;
  }

  async searchIssues(options = {}) {
    const records = await this.run("gh", [
      "search",
      "issues",
      "--assignee=@me",
      "--state=open",
      "--limit",
      `${SEARCH_LIMIT}`,
      "--sort",
      "updated",
      "--order",
      "desc",
      "--json",
      ISSUE_FIELDS,
    ], options);
    options.signal?.throwIfAborted();
    if (!Array.isArray(records) || records.length > SEARCH_LIMIT) {
      throw new TypeError("GitHub issue search result count is invalid");
    }
    const ids = records.map((record) => issueNodeId(record?.id));
    const requestedIds = new Set(ids);
    const idBatches = [];
    for (let index = 0; index < ids.length; index += ISSUE_DETAIL_BATCH_SIZE) {
      idBatches.push(ids.slice(index, index + ISSUE_DETAIL_BATCH_SIZE));
    }
    const detailResponses = await mapWithConcurrency(idBatches, 4, (batch) =>
      this.run("gh", [
          "api",
          "graphql",
          "-f",
          `query=${ISSUE_DETAIL_QUERY}`,
          ...batch.flatMap((id) => ["-F", `ids[]=${id}`]),
        ], options),
    );
    options.signal?.throwIfAborted();
    const detailNodes = detailResponses.flatMap(
      (response) => response?.data?.nodes || [],
    );
    if (!Array.isArray(detailNodes) || detailNodes.length !== ids.length) {
      throw new TypeError("GitHub issue detail result is invalid");
    }
    const detailsById = new Map();
    for (const detail of detailNodes) {
      const id = issueNodeId(detail?.id);
      if (
        detailsById.has(id) ||
        !requestedIds.has(id) ||
        !Number.isSafeInteger(detail?.number) ||
        detail.number < 1
      ) {
        throw new TypeError("GitHub issue detail identity is invalid");
      }
      detailsById.set(id, detail);
    }
    return records.map((record) => {
      const repo = repositoryName(record);
      const detail = detailsById.get(record.id);
      if (!detail || detail.number !== record.number) {
        throw new Error("GitHub issue identity changed during refresh");
      }
      const discussion = issueLatestComment(detail.comments);
      return {
        id: `github:issue:${repo}#${record.number}`,
        kind: "issue",
        relation: "assigned",
        repo,
        number: record.number,
        title: record.title,
        url: record.url,
        author: record.author?.login || "",
        state: record.state?.toLowerCase() || "open",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        description: boundedGitHubText(
          detail.body || record.body,
          GITHUB_DESCRIPTION_MAXIMUM_BYTES,
        ),
        labels: (record.labels || []).map((label) => label.name),
        assignees: (record.assignees || []).map((user) => user.login),
        milestone: detail.milestone?.title || "",
        commentsCount: discussion.commentsCount,
        latestComment: discussion.latestComment,
      };
    });
  }

  async loadReviewContext(item, { includePatch = true, signal = null } = {}) {
    const commandOptions = signal === null ? {} : { signal };
    const hasTargetAvailability = Object.hasOwn(
      item,
      "gitTargetAvailable",
    );
    if (
      hasTargetAvailability &&
      (item.gitTargetAvailable !== true || !item.gitTarget)
    ) {
      throw staleReviewContext();
    }
    const expectedTarget = item.gitTarget
      ? normalizePullRequestGitTarget(item.gitTarget)
      : null;
    if (expectedTarget && item.gitTargetAvailable === false) {
      throw staleReviewContext();
    }
    const observesAccount = Boolean(expectedTarget || item.githubAccount);
    const observedAccount = observesAccount
      ? await this.currentUser(commandOptions)
      : item.currentUser || "";
    if (
      expectedTarget &&
      observedAccount.toLowerCase() !== expectedTarget.sourceAccountId
    ) {
      throw staleReviewContext();
    }
    const metadata = await this.run("gh", [
      "pr",
      "view",
      item.url,
      "--json",
      PR_REVIEW_CONTEXT_FIELDS,
    ], commandOptions);
    const contextGitFacts = pullRequestGitFacts(metadata, {
      repository: canonicalBaseRepository(item, metadata, expectedTarget),
      account: observedAccount,
    });
    const base = {
      ...item,
      title: metadata.title || item.title || "",
      description: metadata.body || "",
      ...contextGitFacts,
      gitTarget: completePullRequestGitFacts(contextGitFacts)
        ? gitTargetFromFacts(contextGitFacts)
        : null,
      gitTargetAvailable: completePullRequestGitFacts(contextGitFacts),
      additions: metadata.additions || 0,
      deletions: metadata.deletions || 0,
      changedFiles: metadata.changedFiles || 0,
      files: (metadata.files || []).map((file) => ({
        path: file.path || "",
        additions: file.additions || 0,
        deletions: file.deletions || 0,
      })),
      patch: "",
      patchTruncated: false,
    };
    if (!sameExpectedGitFacts(item, base)) {
      if (expectedTarget) {
        throw staleReviewContext();
      }
      return base;
    }

    if (!includePatch) {
      if (expectedTarget) {
        const [latest, latestAccount] = await Promise.all([
          this.run("gh", [
            "pr",
            "view",
            item.url,
            "--json",
            "number,url,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner",
          ], commandOptions),
          this.currentUser(commandOptions),
        ]);
        const latestFacts = pullRequestGitFacts(latest, {
          repository: canonicalBaseRepository(item, latest, expectedTarget),
          account: latestAccount,
        });
        if (!sameExpectedGitFacts(item, latestFacts)) {
          throw staleReviewContext();
        }
      }
      return base;
    }

    if (!(expectedTarget?.headRefOid || item.headRefOid)) return base;

    const patch = await this.runText(
      "gh",
      expectedTarget
        ? [
            "api",
            "--hostname",
            GITHUB_HOST,
            `repos/${expectedTarget.baseRepository}/compare/${expectedTarget.baseRefOid}...${expectedTarget.headRefOid}`,
            "--header",
            "Accept: application/vnd.github.patch",
          ]
        : ["pr", "diff", item.url, "--patch"],
      { timeoutMs: 60_000, ...commandOptions },
    );
    const [latest, latestAccount] = await Promise.all([
      this.run("gh", [
        "pr",
        "view",
        item.url,
        "--json",
        "number,url,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner",
      ], commandOptions),
      observesAccount ? this.currentUser(commandOptions) : observedAccount,
    ]);
    const latestFacts = pullRequestGitFacts(latest, {
      repository: canonicalBaseRepository(item, latest, expectedTarget),
      account: latestAccount,
    });
    if (
      !sameExpectedGitFacts(item, latestFacts)
    ) {
      if (expectedTarget) {
        throw staleReviewContext();
      }
      return {
        ...base,
        ...latestFacts,
        gitTarget: completePullRequestGitFacts(latestFacts)
          ? gitTargetFromFacts(latestFacts)
          : null,
        gitTargetAvailable: completePullRequestGitFacts(latestFacts),
      };
    }

    const patchText = String(patch || "");
    return {
      ...base,
      patch: patchText.slice(0, this.maxPatchCharacters),
      patchTruncated: patchText.length > this.maxPatchCharacters,
    };
  }

  async resolvePullRequestTarget(value, { signal = null } = {}) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Reflect.ownKeys(value).length !== 2 ||
      typeof value.repository !== "string" ||
      !Number.isSafeInteger(value.number) ||
      value.number < 1
    ) {
      throw new TypeError("pull request target is invalid");
    }
    const url = `https://${GITHUB_HOST}/${value.repository}/pull/${value.number}`;
    const identity = pullRequestIdentity(url);
    if (
      identity === null ||
      identity.repository !== value.repository ||
      identity.number !== value.number
    ) {
      throw new TypeError("pull request target is invalid");
    }
    const commandOptions = signal === null ? {} : { signal };
    const [initialAccount, initial] = await Promise.all([
      this.currentUser(commandOptions),
      this.run(
        "gh",
        ["pr", "view", url, "--json", PR_OWNER_CONTEXT_FIELDS],
        commandOptions,
      ),
    ]);
    const initialIdentity = pullRequestIdentity(initial.url);
    const facts = pullRequestGitFacts(initial, {
      repository: value.repository,
      account: initialAccount,
    });
    if (
      initialIdentity === null ||
      initialIdentity.repository !== value.repository ||
      initialIdentity.number !== value.number ||
      initial.number !== value.number ||
      initial.state !== "OPEN" ||
      !completePullRequestGitFacts(facts)
    ) {
      throw staleReviewContext();
    }
    const gitTarget = gitTargetFromFacts(facts);
    const [finalAccount, final] = await Promise.all([
      this.currentUser(commandOptions),
      this.run(
        "gh",
        ["pr", "view", url, "--json", PR_OPEN_TARGET_FIELDS],
        commandOptions,
      ),
    ]);
    const finalIdentity = pullRequestIdentity(final.url);
    const finalFacts = pullRequestGitFacts(final, {
      repository: value.repository,
      account: finalAccount,
    });
    if (
      finalIdentity === null ||
      finalIdentity.repository !== value.repository ||
      finalIdentity.number !== value.number ||
      final.number !== value.number ||
      final.state !== "OPEN" ||
      !completePullRequestGitFacts(finalFacts) ||
      !samePullRequestGitTarget(gitTarget, gitTargetFromFacts(finalFacts))
    ) {
      throw staleReviewContext();
    }
    return Object.freeze({
      repository: value.repository,
      number: value.number,
      title: typeof initial.title === "string" && initial.title.trim()
        ? initial.title.trim()
        : `PR #${value.number}`,
      state: "open",
      gitTarget,
    });
  }

  async loadPullRequestFacts(request, { signal = null } = {}) {
    const commandOptions = signal === null ? {} : { signal };
    const identity = createPullRequestReadIdentity(request);
    const binding = identity.executionBinding;
    const target = binding.gitTarget;
    const [owner, name] = binding.repository.split("/");
    const url = `https://${GITHUB_HOST}/${binding.repository}/pull/${binding.pullRequestNumber}`;

    const [initialAccount, initialResponse] = await Promise.all([
      this.currentUser(commandOptions),
      this.run(
        "gh",
        ["pr", "view", url, "--json", PR_OPEN_TARGET_FIELDS],
        commandOptions,
      ),
    ]);
    const initial = githubViewPullRequestTargetState(initialResponse, identity);
    if (initial.state !== "OPEN") throw terminalReadFacts(initial.state);
    if (
      !sameGitHubAccount(initialAccount, target.sourceAccountId) ||
      !sameObservedReadTarget(initial.target, identity)
    ) {
      throw staleReadFacts();
    }

    const response = await this.run(
      "gh",
      [
        "api",
        "graphql",
        "--hostname",
        GITHUB_HOST,
        "-f",
        `query=${GITHUB_PULL_REQUEST_FACTS_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${binding.pullRequestNumber}`,
        "-F",
        `commentCount=${this.pullRequestFactLimits.comments}`,
        "-F",
        `reviewCount=${this.pullRequestFactLimits.reviews}`,
        "-F",
        `threadCount=${this.pullRequestFactLimits.threads}`,
        "-F",
        `threadCommentCount=${this.pullRequestFactLimits.threadComments}`,
        "-F",
        `checkCount=${this.pullRequestFactLimits.checks}`,
      ],
      { timeoutMs: 60_000, ...commandOptions },
    );
    const observedTarget = githubGraphPullRequestTarget(response, identity);
    if (!sameObservedReadTarget(observedTarget, identity)) {
      throw staleReadFacts();
    }
    const facts = projectGitHubPullRequestFacts({
      response,
      identity,
      observedAt: clockTimestamp(this.clock),
      limits: this.pullRequestFactLimits,
    });

    const [latestResponse, finalAccount] = await Promise.all([
      this.run(
        "gh",
        ["pr", "view", url, "--json", PR_OPEN_TARGET_FIELDS],
        commandOptions,
      ),
      this.currentUser(commandOptions),
    ]);
    const latest = githubViewPullRequestTargetState(latestResponse, identity);
    if (latest.state !== "OPEN") throw terminalReadFacts(latest.state);
    if (
      !sameGitHubAccount(finalAccount, target.sourceAccountId) ||
      !sameObservedReadTarget(latest.target, identity)
    ) {
      throw staleReadFacts();
    }
    return facts;
  }

  async versions(repositories, options = {}) {
    const versions = [];
    const errors = [];
    await mapWithConcurrency(repositories, 3, async (repo) => {
      const [milestonesResult, releaseResult] = await Promise.allSettled([
        this.run("gh", [
          "api",
          `repos/${repo}/milestones?state=open&per_page=${MILESTONE_PAGE_SIZE}`,
          "--paginate",
          "--slurp",
        ], options),
        this.run(
          "gh",
          ["api", `repos/${repo}/releases?per_page=1`],
          options,
        ),
      ]);
      if (milestonesResult.status === "fulfilled") {
        for (const milestone of recentActiveMilestones(milestonesResult.value)) {
          versions.push({
            id: `github:milestone:${repo}#${milestone.number}`,
            repo,
            title: milestone.title,
            createdAt: milestone.created_at,
            updatedAt: milestone.updated_at,
            dueAt: milestone.due_on,
            openIssues: milestone.open_issues,
            closedIssues: milestone.closed_issues,
            url: milestone.html_url,
            type: "milestone",
          });
        }
      } else {
        errors.push(
          new Error(
            `${repo} milestones: ${milestonesResult.reason.message || milestonesResult.reason}`,
          ),
        );
      }
      const release =
        releaseResult.status === "fulfilled" ? releaseResult.value[0] : null;
      if (releaseResult.status === "rejected") {
        errors.push(
          new Error(
            `${repo} releases: ${releaseResult.reason.message || releaseResult.reason}`,
          ),
        );
      }
      if (release) {
        versions.push({
          id: `github:release:${repo}:${release.id}`,
          repo,
          title: release.name || release.tag_name,
          tag: release.tag_name,
          createdAt: release.created_at,
          publishedAt: release.published_at,
          url: release.html_url,
          type: "release",
        });
      }
    });
    if (errors.length) {
      throw new AggregateError(errors, "GitHub version source was only partially refreshed");
    }
    return versions;
  }
}
