import { runCommand, runJson } from "../lib/command-runner.js";

const PR_SEARCH_FIELDS =
  "number,title,url,repository,updatedAt,createdAt,author,state";
const PR_DETAIL_FIELDS =
  "reviewDecision,statusCheckRollup,mergeStateStatus,isDraft,labels,assignees,milestone,headRefOid,reviews";
const PR_REVIEW_CONTEXT_FIELDS =
  "title,body,headRefOid,additions,deletions,changedFiles,files";
const ISSUE_FIELDS =
  "number,title,url,repository,updatedAt,createdAt,author,state,labels,assignees";

function repositoryName(item) {
  return item.repository?.nameWithOwner || item.repository?.name || "";
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

export class GitHubAdapter {
  constructor({
    run = runJson,
    runText = runCommand,
    maxPatchCharacters = 24_000,
  } = {}) {
    this.run = run;
    this.runText = runText;
    this.maxPatchCharacters =
      Number.isFinite(maxPatchCharacters) && maxPatchCharacters > 0
        ? maxPatchCharacters
        : 24_000;
  }

  async currentUser() {
    const data = await this.run("gh", ["api", "user"]);
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
    const repo = repositoryName(record);
    const author = record.author?.login || "";
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
    return mapWithConcurrency(records, 4, (record) =>
      this.#enrichPullRequest(record, currentUser),
    );
  }

  async searchPullRequests(relation, currentUser) {
    const records = await this.#searchPullRequestRecords(relation);
    return mapWithConcurrency(records, 4, (record) =>
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
    const metadata = await this.run("gh", [
      "pr",
      "view",
      item.url,
      "--json",
      PR_REVIEW_CONTEXT_FIELDS,
    ]);
    const base = {
      ...item,
      title: metadata.title || item.title || "",
      description: metadata.body || "",
      headRefOid: metadata.headRefOid || "",
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
    if (
      !includePatch ||
      !item.headRefOid ||
      metadata.headRefOid !== item.headRefOid
    ) {
      return base;
    }

    const patch = await this.runText(
      "gh",
      ["pr", "diff", item.url, "--patch"],
      { timeoutMs: 60_000 },
    );
    const latest = await this.run("gh", [
      "pr",
      "view",
      item.url,
      "--json",
      "headRefOid",
    ]);
    if (latest.headRefOid !== item.headRefOid) {
      return { ...base, headRefOid: latest.headRefOid || "" };
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
