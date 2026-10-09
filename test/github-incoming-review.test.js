import assert from "node:assert/strict";
import test from "node:test";
import { projectIncomingReview } from "../src/adapters/github-incoming-review.js";
import { GitHubAdapter } from "../src/adapters/github-adapter.js";
const event = (type, at, extra = {}) => ({ __typename: type, id: `event-${type}`, createdAt: at, actor: { login: "dev" }, ...extra });
test("receipt time follows latest active user assignment or review request, including removals", () => {
  const pr = { assignees: { nodes: [{ login: "me" }] }, reviewRequests: { nodes: [{ requestedReviewer: { login: "me" } }] },
    timelineItems: { nodes: [event("AssignedEvent", "2026-10-01T00:00:00Z", { assignee: { login: "me" } }), event("ReviewRequestedEvent", "2026-10-09T00:00:00Z", { requestedReviewer: { login: "ME" } })] } };
  assert.equal(projectIncomingReview(pr, "me").reviewReceivedAt, "2026-10-09T00:00:00Z");
  pr.timelineItems.nodes.push(event("ReviewRequestRemovedEvent", "2026-10-09T01:00:00Z", { requestedReviewer: { login: "me" } }));
  assert.equal(projectIncomingReview(pr, "me").reviewReceivedAt, "2026-10-01T00:00:00Z");
  pr.assignees.nodes = [];
  assert.equal(projectIncomingReview(pr, "me").reviewRecipient, null);
});
test("bounded timeline without a matching event cannot invent a receipt time", () => {
  const pr = { assignees: { nodes: [{ login: "me" }] }, reviewRequests: { nodes: [] }, timelineItems: { nodes: [], pageInfo: { hasPreviousPage: true } } };
  assert.equal(projectIncomingReview(pr, "me").reviewReceivedAt, null);
});
test("reviewer-only PRs are discovered and enriched once even if also assigned", async () => {
  let details = 0;
  const record = { number: 1, title: "fix", url: "https://github.com/acme/repo/pull/1", repository: { nameWithOwner: "acme/repo" }, author: { login: "dev" }, state: "open" };
  const adapter = new GitHubAdapter({ run: async (_command, args) => {
    if (args[0] === "api") return { login: "me" };
    if (args[0] === "search") return args.includes("--review-requested=@me") ? [record] : [];
    details++;
    return { number: 1, url: record.url, reviews: [], labels: [], assignees: [], statusCheckRollup: [] };
  } });
  const [pr] = await adapter.searchRelevantPullRequests();
  assert.equal(pr.relation, "review_requested");
  assert.equal(pr.assignmentSource, "reviewer");
  assert.equal(details, 1);
});
