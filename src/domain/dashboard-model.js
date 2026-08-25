import { prioritize } from "./prioritizer.js";

function group(items, predicate) {
  return items.filter(predicate);
}

function newestVersionsFirst(versions) {
  const timestamp = (version) => {
    const value =
      version.publishedAt ||
      version.updatedAt ||
      version.createdAt ||
      version.dueAt;
    const parsed = Date.parse(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...versions].sort(
    (left, right) => timestamp(right) - timestamp(left),
  );
}

export function buildDashboard(snapshot, previousSnapshot = null) {
  const prioritized = prioritize(snapshot.items, snapshot.refreshedAt);
  const completedIds = new Set(snapshot.items.map((item) => item.id));
  const recentlyCompleted = (previousSnapshot?.items || [])
    .filter((item) => !completedIds.has(item.id))
    .slice(0, 8);

  return {
    meta: {
      refreshedAt: snapshot.refreshedAt,
      durationMs: snapshot.durationMs,
      sources: snapshot.sources,
      errors: snapshot.errors,
      brain: snapshot.brain || {
        enabled: false,
        provider: "",
        model: "",
        assessed: 0,
        errors: [],
      },
    },
    focus: prioritized.filter((item) => item.score >= 80).slice(0, 7),
    groups: {
      actionNow: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.actionState === "action_now",
      ),
      waitingOther: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" &&
          item.actionState === "waiting_other",
      ),
      uncertainPullRequests: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.actionState === "uncertain",
      ),
      historicalPullRequests: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.actionState === "historical",
      ),
      reviewRequested: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" &&
          item.relation === "review_requested",
      ),
      myIssues: group(
        prioritized,
        (item) => item.kind === "issue" && item.relation === "assigned",
      ),
      myPullRequests: group(
        prioritized,
        (item) =>
          item.kind === "pull_request" && item.relation === "authored",
      ),
      dingtalk: group(prioritized, (item) =>
        ["mention", "todo", "conversation"].includes(item.kind),
      ),
      versions: newestVersionsFirst(snapshot.versions || []),
      recentlyCompleted,
    },
    counts: {
      total: prioritized.length,
      urgent: prioritized.filter((item) => item.score >= 90).length,
      actionNow: prioritized.filter(
        (item) =>
          item.kind === "pull_request" && item.actionState === "action_now",
      ).length,
      waitingOther: prioritized.filter(
        (item) =>
          item.kind === "pull_request" &&
          item.actionState === "waiting_other",
      ).length,
      uncertainPullRequests: prioritized.filter(
        (item) =>
          item.kind === "pull_request" && item.actionState === "uncertain",
      ).length,
      historicalPullRequests: prioritized.filter(
        (item) =>
          item.kind === "pull_request" && item.actionState === "historical",
      ).length,
      reviewRequested: prioritized.filter(
        (item) => item.relation === "review_requested",
      ).length,
      issues: prioritized.filter((item) => item.kind === "issue").length,
    },
  };
}
