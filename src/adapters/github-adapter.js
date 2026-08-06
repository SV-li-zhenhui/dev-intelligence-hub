import { runCommand, runJson } from "../lib/command-runner.js";
import {
  normalizePullRequestGitTarget,
  samePullRequestGitTarget,
} from "../domain/git-tool-contract.js";

const GITHUB_HOST = "github.com";
const PR_SEARCH_FIELDS =
  "number,title,url,repository,updatedAt,createdAt,author,state";
const PR_DETAIL_FIELDS =
  "number,url,reviewDecision,statusCheckRollup,mergeStateStatus,isDraft,labels,assignees,milestone,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,reviews";
const PR_REVIEW_CONTEXT_FIELDS =
  "number,url,title,body,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,additions,deletions,changedFiles,files";
const ISSUE_FIELDS =
  "number,title,url,repository,updatedAt,createdAt,author,state,labels,assignees";
const PULL_REQUEST_GIT_FACT_FIELDS = Object.freeze([
  "githubAccount",
  "baseRepository",
  "baseRefName",
  "baseRefOid",
  "headRepository",
  "headRefName",
  "headRefOid",
]);

function repositoryName(item) {
  return item.repository?.nameWithOwner || item.repository?.name || "";
}

function headRepositoryName(detail) {
  return detail?.headRepository?.nameWithOwner || "";
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
  return PULL_REQUEST_GIT_FACT_FIELDS.every(
    (field) => typeof facts[field] === "string" && facts[field].length > 0,
  );
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

export function classifyPullRequestRelation(source, author, currentUser) {
  if (source !== "assigned") return source;
  return author.toLowerCase() === currentUser.toLowerCase()
    ? "authored"
    : "review_requested";
}

function pullRequestKey(record) {
  return `${repositoryName(record)}#${record.number}`;
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
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await transform(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
  } = {}) {
    const commandEnvironment = Object.freeze({ ...env, GH_HOST: GITHUB_HOST });
    this.run = bindGitHubHost(run, commandEnvironment);
    this.runText = bindGitHubHost(runText, commandEnvironment);
    this.maxPatchCharacters =
      Number.isFinite(maxPatchCharacters) && maxPatchCharacters > 0
        ? maxPatchCharacters
        : 24_000;
  }

  async currentUser() {
    const data = await this.run("gh", [
      "api",
      "--hostname",
      GITHUB_HOST,
      "user",
    ]);
    return data.login;
  }

  async #searchPullRequestRecords(relation) {
    const filter = {
      assigned: "--assignee=@me",
      authored: "--author=@me",
    }[relation];
    return this.run("gh", [
      "search",
      "prs",
      filter,
      "--state=open",
      "--limit",
      "1000",
      "--json",
      PR_SEARCH_FIELDS,
    ]);
  }

  async #enrichPullRequest(record, currentUser) {
    const detail = await this.run("gh", [
      "pr",
      "view",
      record.url,
      "--json",
      PR_DETAIL_FIELDS,
    ]);
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

  async searchRelevantPullRequests() {
    const currentUser = await this.currentUser();
    const [assigned, authored] = await Promise.all([
      this.#searchPullRequestRecords("assigned"),
      this.#searchPullRequestRecords("authored"),
    ]);
    const records = combinePullRequestRecords(
      assigned,
      authored,
      currentUser,
    );
    const items = await mapWithConcurrency(records, 4, (record) =>
      this.#enrichPullRequest(record, currentUser),
    );
    const finalUser = await this.currentUser();
    if (finalUser.toLowerCase() !== currentUser.toLowerCase()) {
      throw new Error("GitHub account changed during PR refresh");
    }
    return items;
  }

  async searchPullRequests(relation, currentUser) {
    const records = await this.#searchPullRequestRecords(relation);
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
      ),
    );
    const finalUser = await this.currentUser();
    if (finalUser.toLowerCase() !== currentUser.toLowerCase()) {
      throw new Error("GitHub account changed during PR refresh");
    }
    return items;
  }

  async searchIssues() {
    const records = await this.run("gh", [
      "search",
      "issues",
      "--assignee=@me",
      "--state=open",
      "--limit",
      "50",
      "--json",
      ISSUE_FIELDS,
    ]);
    return records.map((record) => {
      const repo = repositoryName(record);
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
        labels: (record.labels || []).map((label) => label.name),
        assignees: (record.assignees || []).map((user) => user.login),
      };
    });
  }

  async loadReviewContext(item, { includePatch = true } = {}) {
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
      ? await this.currentUser()
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
    ]);
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
            "number,url,baseRefName,baseRefOid,headRefName,headRefOid,headRepository",
          ]),
          this.currentUser(),
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
      { timeoutMs: 60_000 },
    );
    const [latest, latestAccount] = await Promise.all([
      this.run("gh", [
        "pr",
        "view",
        item.url,
        "--json",
        "number,url,baseRefName,baseRefOid,headRefName,headRefOid,headRepository",
      ]),
      observesAccount ? this.currentUser() : observedAccount,
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

  async versions(repositories) {
    const versions = [];
    const errors = [];
    await mapWithConcurrency(repositories, 3, async (repo) => {
      const [milestonesResult, releaseResult] = await Promise.allSettled([
        this.run("gh", [
          "api",
          `repos/${repo}/milestones?state=open&sort=due_on&direction=asc&per_page=10`,
        ]),
        this.run("gh", ["api", `repos/${repo}/releases?per_page=1`]),
      ]);
      if (milestonesResult.status === "fulfilled") {
        for (const milestone of milestonesResult.value) {
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
