import { createHash } from "node:crypto";

const PR_IDENTITY = "number url author { login } state isDraft headRefOid reviewDecision updatedAt";
const REVIEW_FIELDS = "id author { login } state submittedAt commit { oid } body url";
const COMMENT_FIELDS = "id author { login } body createdAt updatedAt url pullRequestReview { id state submittedAt commit { oid } }";
const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const THREAD_FIELDS = `id path line originalLine isResolved isOutdated comments(first: 100) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} }`;
const INITIAL_QUERY = `query OwnReviewFeedback($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    ${PR_IDENTITY}
    reviews(first: 100) { nodes { ${REVIEW_FIELDS} } ${PAGE_INFO} }
    reviewThreads(first: 100) { nodes { ${THREAD_FIELDS} } ${PAGE_INFO} }
  } }
}`;
const REVIEWS_QUERY = `query OwnReviewFeedbackReviews($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    ${PR_IDENTITY} reviews(first: 100, after: $cursor) { nodes { ${REVIEW_FIELDS} } ${PAGE_INFO} }
  } }
}`;
const THREADS_QUERY = `query OwnReviewFeedbackThreads($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    ${PR_IDENTITY} reviewThreads(first: 100, after: $cursor) { nodes { ${THREAD_FIELDS} } ${PAGE_INFO} }
  } }
}`;
const COMMENTS_QUERY = `query OwnReviewFeedbackThreadComments($id: ID!, $cursor: String!) {
  node(id: $id) { ... on PullRequestReviewThread {
    id pullRequest { ${PR_IDENTITY} }
    comments(first: 100, after: $cursor) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} }
  } }
}`;
const IDENTITY_QUERY = `query OwnReviewFeedbackIdentity($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_IDENTITY} } }
}`;

function invalid(message) {
  return new Error(`GitHub own PR feedback ${message}`);
}

function login(value) {
  return (value?.author?.login || "").toLowerCase();
}

function sortById(entries) {
  return entries.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function latestTime(entries) {
  return entries.map((entry) => entry.updatedAt || entry.createdAt || entry.submittedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || "";
}

function commentFact(comment) {
  return {
    id: comment.id,
    author: comment.author.login,
    body: comment.body || "",
    createdAt: comment.createdAt || "",
    updatedAt: comment.updatedAt || comment.createdAt || "",
    reviewId: comment.pullRequestReview?.id || "",
    reviewedHeadRefOid: comment.pullRequestReview?.commit?.oid || "",
  };
}

export function ownReviewFeedbackDigest(feedback) {
  const identity = {
    changeRequests: feedback.changeRequests,
    threads: feedback.threads.map(({ id, comments }) => ({ id, comments })),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function summarizeOwnReviewFeedback({ reviews, threads }, account) {
  const normalizedAccount = account.toLowerCase();
  const latestDecisions = new Map();
  for (const review of reviews) {
    const reviewer = login(review);
    if (!reviewer || reviewer === normalizedAccount || !["APPROVED", "CHANGES_REQUESTED"].includes(review.state)) continue;
    const previous = latestDecisions.get(reviewer);
    if (!previous || Date.parse(review.submittedAt) >= Date.parse(previous.submittedAt)) latestDecisions.set(reviewer, review);
  }
  const changeRequests = sortById([...latestDecisions.values()]
    .filter(({ state }) => state === "CHANGES_REQUESTED")
    .map((review) => ({
      id: review.id,
      author: review.author.login,
      body: review.body || "",
      submittedAt: review.submittedAt,
      reviewedHeadRefOid: review.commit?.oid || "",
    })));
  const pendingThreads = sortById(threads
    .filter((thread) => thread.isResolved === false && thread.isOutdated === false)
    .map((thread) => ({
      id: thread.id,
      path: thread.path,
      line: thread.line ?? thread.originalLine ?? null,
      comments: sortById(thread.comments.filter((comment) =>
        login(comment) && login(comment) !== normalizedAccount &&
        !["PENDING", "DISMISSED"].includes(comment.pullRequestReview?.state)
      ).map(commentFact)),
      discussion: thread.comments.filter((comment) =>
        login(comment) && !["PENDING", "DISMISSED"].includes(comment.pullRequestReview?.state)
      ).map(commentFact),
    }))
    .filter(({ comments }) => comments.length > 0));
  const feedback = { changeRequests, threads: pendingThreads };
  // Diff line positions can move after our own push without new reviewer input.
  const reviewFeedbackIds = [
    ...changeRequests.map(({ id }) => `review:${id}`),
    ...pendingThreads.map(({ id }) => `thread:${id}`),
  ].sort();
  const reviewFeedbackFingerprints = [
    ...changeRequests.map((review) => ({ review })),
    ...pendingThreads.map(({ id, comments }) => ({ thread: { id, comments } })),
  ].map((value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")).sort();
  return {
    reviewFeedbackAvailable: true,
    reviewFeedbackDigest: ownReviewFeedbackDigest(feedback),
    reviewFeedbackCount: reviewFeedbackIds.length,
    reviewPendingThreadCount: pendingThreads.length,
    reviewChangeRequestCount: changeRequests.length,
    reviewFeedbackAt: latestTime([...changeRequests, ...pendingThreads.flatMap(({ comments }) => comments)]),
    reviewFeedbackIds,
    reviewFeedbackFingerprints,
    feedback,
  };
}

function assertPullRequest(pr, identity, expectedHead = null) {
  if (!pr || pr.number !== identity.number ||
      pr.url?.toLowerCase() !== `https://github.com/${identity.repository}/pull/${identity.number}`.toLowerCase() ||
      !["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
      typeof pr.headRefOid !== "string" || !pr.headRefOid) throw invalid("identity is unavailable");
  if (pr.isDraft !== undefined && typeof pr.isDraft !== "boolean") throw invalid("Draft identity is unavailable");
  if (login(pr) !== identity.account.toLowerCase()) throw invalid("author changed");
  if (expectedHead !== null && pr.headRefOid !== expectedHead) throw invalid("head changed during read");
  return pr;
}

function assertSameLifecycle(current, initial) {
  if (current.state !== initial.state) throw invalid("state changed during read");
  if (current.isDraft !== initial.isDraft) throw invalid("Draft changed during read");
}

function connection(value) {
  if (!value || !Array.isArray(value.nodes) || value.nodes.length > 100 ||
      typeof value.pageInfo?.hasNextPage !== "boolean") throw invalid("pagination is incomplete");
  if (value.pageInfo.hasNextPage && (typeof value.pageInfo.endCursor !== "string" || !value.pageInfo.endCursor)) throw invalid("pagination cursor is missing");
  return value;
}

function assertNodes(nodes, kind) {
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !node.id) throw invalid(`${kind} identity is unavailable`);
    if (kind === "thread" && (typeof node.isResolved !== "boolean" || typeof node.isOutdated !== "boolean" || typeof node.path !== "string")) throw invalid("thread state is unavailable");
    if (kind === "review" && (typeof node.state !== "string" || (node.state !== "PENDING" && !Number.isFinite(Date.parse(node.submittedAt))))) throw invalid("review state is unavailable");
  }
}

async function graphql(run, query, parameters, options) {
  const result = await run("gh", ["api", "graphql", "-f", `query=${query}`, ...Object.entries(parameters).flatMap(([name, value]) => [name === "number" ? "-F" : "-f", `${name}=${value}`])], options);
  options.signal?.throwIfAborted();
  if (!result?.data || result.errors?.length) throw invalid("query failed");
  return result.data;
}

async function readPages(initial, readNext) {
  let current = connection(initial);
  const nodes = [...current.nodes];
  const cursors = new Set();
  while (current.pageInfo.hasNextPage) {
    const cursor = current.pageInfo.endCursor;
    if (cursors.has(cursor)) throw invalid("pagination cursor did not advance");
    cursors.add(cursor);
    current = connection(await readNext(cursor));
    nodes.push(...current.nodes);
  }
  const ids = nodes.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw invalid("pagination repeated a feedback item");
  return nodes;
}

export async function readOwnReviewFeedback(run, identity, options = {}) {
  const [owner, name] = identity.repository.split("/");
  const parameters = { owner, name, number: identity.number };
  const initial = await graphql(run, INITIAL_QUERY, parameters, options);
  const pr = assertPullRequest(initial.repository?.pullRequest, identity);
  const readPrPage = async (query, cursor, field) => {
    const result = await graphql(run, query, { ...parameters, cursor }, options);
    const page = assertPullRequest(result.repository?.pullRequest, identity, pr.headRefOid);
    assertSameLifecycle(page, pr);
    return page[field];
  };
  const [reviews, threads] = await Promise.all([
    readPages(pr.reviews, (cursor) => readPrPage(REVIEWS_QUERY, cursor, "reviews")),
    readPages(pr.reviewThreads, (cursor) => readPrPage(THREADS_QUERY, cursor, "reviewThreads")),
  ]);
  assertNodes(reviews, "review");
  assertNodes(threads, "thread");
  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) {
      thread.comments = [];
      continue;
    }
    thread.comments = await readPages(thread.comments, async (cursor) => {
      const result = await graphql(run, COMMENTS_QUERY, { id: thread.id, cursor }, options);
      if (result.node?.id !== thread.id) throw invalid("thread identity changed");
      const parent = assertPullRequest(result.node.pullRequest, identity, pr.headRefOid);
      assertSameLifecycle(parent, pr);
      return result.node.comments;
    });
    assertNodes(thread.comments, "comment");
  }
  const final = await graphql(run, IDENTITY_QUERY, parameters, options);
  const current = assertPullRequest(final.repository?.pullRequest, identity, pr.headRefOid);
  assertSameLifecycle(current, pr);
  if (current.reviewDecision !== pr.reviewDecision || current.updatedAt !== pr.updatedAt) throw invalid("changed during read");
  return {
    state: pr.state.toLowerCase(),
    ...(pr.isDraft === undefined ? {} : { isDraft: pr.isDraft }),
    author: pr.author.login,
    currentUser: identity.account,
    repo: identity.repository,
    number: identity.number,
    headRefOid: pr.headRefOid,
    reviewDecision: pr.reviewDecision || "",
    ...summarizeOwnReviewFeedback({ reviews, threads }, identity.account),
  };
}
