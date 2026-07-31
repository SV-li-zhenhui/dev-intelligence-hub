import { buildDashboard } from "../domain/dashboard-model.js";
import {
  ACTION_STATES,
  assessPullRequestResponsibility,
} from "../domain/pr-responsibility.js";
import { prioritize } from "../domain/prioritizer.js";
import { diffSnapshots } from "../domain/snapshot-diff.js";

const CONFIRMABLE_ACTION_STATES = new Set([
  ACTION_STATES.ACTION_NOW,
  ACTION_STATES.WAITING_OTHER,
  ACTION_STATES.HISTORICAL,
]);

function serviceError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function confirmedAssessment(actionState) {
  if (actionState === ACTION_STATES.ACTION_NOW) {
    return {
      actionState,
      nextActor: "me",
      nextAction: "user_confirmed_action",
      actionReasons: ["你已确认：现在轮到你处理"],
      requiresConfirmation: false,
    };
  }
  if (actionState === ACTION_STATES.WAITING_OTHER) {
    return {
      actionState,
      nextActor: "other",
      nextAction: "wait_other",
      actionReasons: ["你已确认：当前等待他人处理"],
      requiresConfirmation: false,
    };
  }
  return {
    actionState,
    nextActor: "none",
    nextAction: "archive",
    actionReasons: ["你已确认：这是历史事项，无需当前处理"],
    requiresConfirmation: false,
  };
}

function deduplicate(items) {
  const result = new Map();
  for (const item of items) {
    const existing = result.get(item.id);
    if (!existing) {
      result.set(item.id, item);
      continue;
    }
    if (item.relation === "authored") {
      result.set(item.id, item);
    } else if (
      existing.relation !== "authored" &&
      existing.assignmentSource !== "assignee" &&
      item.assignmentSource === "assignee"
    ) {
      result.set(item.id, item);
    }
  }
  return [...result.values()];
}

function brainAssessmentFingerprint(item, brainConfig) {
  return JSON.stringify({
    provider: brainConfig.provider || "",
    model: brainConfig.model || "",
    policyVersion: brainConfig.policyVersion || 1,
    relation: item.relation || "",
    assignmentSource: item.assignmentSource || "",
    author: item.author || "",
    currentUser: item.currentUser || "",
    state: item.state || "",
    isDraft: Boolean(item.isDraft),
    reviewFactsAvailable: item.reviewFactsAvailable === true,
    headRefOid: item.headRefOid || "",
    myReviewState: item.myReviewState || "",
    myReviewCommitOid: item.myReviewCommitOid || "",
    latestOtherDecisionState: item.latestOtherDecisionState || "",
    latestOtherDecisionCommitOid: item.latestOtherDecisionCommitOid || "",
    outstandingChangeRequestCommitOids:
      item.outstandingChangeRequestCommitOids || [],
    reviewDecision: item.reviewDecision || "",
    ciStatus: item.ciStatus || "",
    mergeStateStatus: item.mergeStateStatus || "",
    actionState: item.actionState || "uncertain",
  });
}

export class RefreshService {
  constructor({
    github,
    dingtalk,
    store,
    notifier,
    config,
    brain = null,
    operationQueue = null,
  }) {
    this.github = github;
    this.brain = brain;
    this.dingtalk = dingtalk;
    this.store = store;
    this.notifier = notifier;
    this.config = config;
    this.running = null;
    this.operationQueue = operationQueue;
    this.operations = Promise.resolve();
  }

  refresh(options = {}) {
    if (this.running) return this.running;
    const operation = this.#enqueue(() => this.#performRefresh(options));
    const tracked = operation.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
    return tracked;
  }

  confirmPullRequestResponsibility(id, actionState, headRefOid) {
    return this.#enqueue(() =>
      this.#confirmPullRequestResponsibility(id, actionState, headRefOid),
    );
  }

  #enqueue(operation) {
    if (this.operationQueue) return this.operationQueue.enqueue(operation);
    const result = this.operations.then(operation, operation);
    this.operations = result.catch(() => {});
    return result;
  }

  async #confirmPullRequestResponsibility(id, actionState, headRefOid) {
    if (typeof id !== "string" || !id.trim()) {
      throw serviceError(400, "PR id 不能为空");
    }
    if (!CONFIRMABLE_ACTION_STATES.has(actionState)) {
      throw serviceError(
        400,
        "actionState 只能是 action_now、waiting_other 或 historical",
      );
    }
    if (typeof headRefOid !== "string" || !headRefOid.trim()) {
      throw serviceError(400, "headRefOid 不能为空");
    }

    const snapshot = await this.store.read("snapshot");
    if (!snapshot || !Array.isArray(snapshot.items)) {
      throw serviceError(409, "尚无可确认的当前快照，请先刷新");
    }

    const itemId = id.trim();
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw serviceError(404, `当前快照中找不到 ${itemId}`);
    }
    if (item.kind !== "pull_request") {
      throw serviceError(409, "只有 PR 可以确认责任状态");
    }
    if (item.actionState !== ACTION_STATES.UNCERTAIN) {
      throw serviceError(409, "该 PR 已不是待确认状态");
    }
    if (!item.headRefOid) {
      throw serviceError(409, "PR 缺少当前提交标识，无法安全保存确认结果");
    }
    if (item.headRefOid !== headRefOid.trim()) {
      throw serviceError(409, "PR 已出现新提交，请根据最新事实重新确认");
    }

    const overrides = await this.store.read(
      "pr-responsibility-overrides",
      {},
    );
    const confirmedAt = new Date().toISOString();
    const nextOverrides = {
      ...(overrides && typeof overrides === "object" ? overrides : {}),
      [item.id]: {
        id: item.id,
        headRefOid: item.headRefOid,
        actionState,
        confirmedAt,
      },
    };
    const confirmedItem = {
      ...item,
      ...confirmedAssessment(actionState),
      responsibilityConfirmedAt: confirmedAt,
    };
    const nextSnapshot = {
      ...snapshot,
      items: snapshot.items.map((candidate) =>
        candidate.id === item.id ? confirmedItem : candidate,
      ),
    };
    const previousSnapshot = await this.store.read("previous-snapshot");
    const dashboard = buildDashboard(nextSnapshot, previousSnapshot);

    await this.store.write("pr-responsibility-overrides", nextOverrides);
    await this.store.write("snapshot", nextSnapshot);
    await this.store.write("dashboard", dashboard);
    return dashboard;
  }

  async #assessUncertainPullRequests(items) {
    const brainConfig = this.config.brain || {};
    const meta = {
      enabled: Boolean(brainConfig.enabled),
      provider: brainConfig.provider || "",
      model: brainConfig.model || "",
      assessed: 0,
      errors: [],
    };
    if (!meta.enabled) return { items, meta };
    if (!this.brain) {
      meta.errors.push("大脑适配器未配置");
      return { items, meta };
    }

    const limit = brainConfig.maxAssessmentsPerRefresh ?? 3;
    const candidates = items
      .filter(
        (item) =>
          item.actionState === ACTION_STATES.UNCERTAIN &&
          !item.brainAssessment,
      )
      .slice(0, limit);
    for (const item of candidates) {
      try {
        item.brainAssessment = await this.brain.assessPullRequest(item);
        meta.assessed += 1;
      } catch (error) {
        meta.errors.push(`${item.repo || item.id} #${item.number || "?"}: ${error.message}`);
      }
    }
    return { items, meta };
  }

  async #performRefresh({ notify = false } = {}) {
    const startedAt = Date.now();
    const [previous, notificationBaseline, responsibilityOverrides] =
      await Promise.all([
        this.store.read("snapshot"),
        this.store.read("notification-snapshot"),
        this.store.read("pr-responsibility-overrides", {}),
      ]);
    const previousItems = previous?.items || [];
    const errors = [];
    const since = previous?.refreshedAt;

    const githubCalls = await Promise.allSettled([
      this.github.searchRelevantPullRequests(),
      this.github.searchIssues(),
      this.github.versions(this.config.trackedRepositories),
    ]);
    const names = [
      "GitHub 与我相关的 PR",
      "GitHub Issue",
      "GitHub 版本",
    ];
    const githubFallbacks = [
      previousItems.filter((item) => item.kind === "pull_request"),
      previousItems.filter((item) => item.kind === "issue"),
      previous?.versions || [],
    ];
    const githubValues = githubCalls.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      errors.push(`${names[index]}: ${result.reason.message}`);
      return githubFallbacks[index];
    });
    const previousPullRequests = new Map(
      (previous?.items || [])
        .filter((item) => item.kind === "pull_request")
        .map((item) => [item.id, item]),
    );
    const classifiedPullRequests = githubValues[0].map((item) => {
      const classified = {
        ...item,
        ...assessPullRequestResponsibility(item, {
          historicalAfterDays:
            this.config.prResponsibility?.historicalAfterDays ?? 60,
        }),
      };
      const previousItem = previousPullRequests.get(item.id);
      const override = responsibilityOverrides?.[item.id];
      const matchingOverride =
        classified.headRefOid &&
        override?.headRefOid === classified.headRefOid &&
        CONFIRMABLE_ACTION_STATES.has(override?.actionState);
      const assessmentFingerprint = brainAssessmentFingerprint(
        classified,
        this.config.brain || {},
      );
      if (
        classified.actionState === ACTION_STATES.UNCERTAIN &&
        previousItem?.brainAssessment &&
        (previousItem.brainAssessmentFingerprint === assessmentFingerprint ||
          matchingOverride)
      ) {
        classified.brainAssessment = previousItem.brainAssessment;
      }
      if (classified.actionState === ACTION_STATES.UNCERTAIN) {
        classified.brainAssessmentFingerprint = assessmentFingerprint;
      } else {
        delete classified.brainAssessment;
        delete classified.brainAssessmentFingerprint;
      }
      if (
        classified.actionState !== ACTION_STATES.UNCERTAIN ||
        !matchingOverride
      ) {
        return classified;
      }
      return {
        ...classified,
        ...confirmedAssessment(override.actionState),
        responsibilityConfirmedAt: override.confirmedAt || "",
      };
    });
    const brainAssessment = this.#assessUncertainPullRequests(
      classifiedPullRequests,
    );
    const dingtalkCollection = this.config.dingtalk.enabled
      ? this.dingtalk.collect(since).catch((error) => ({
          items: previousItems.filter((item) =>
            ["mention", "todo", "conversation"].includes(item.kind),
          ),
          errors: [`钉钉: ${error.message}`],
        }))
      : Promise.resolve({ items: [], errors: [] });
    const [assessedPullRequests, dingtalkResult] = await Promise.all([
      brainAssessment,
      dingtalkCollection,
    ]);
    errors.push(...dingtalkResult.errors);

    const snapshot = {
      refreshedAt: new Date().toISOString(),
      sources: {
        github:
          assessedPullRequests.items.length + githubValues[1].length,
        dingtalk: dingtalkResult.items.length,
      },
      sourceStatus: {
        githubPullRequests: {
          ok: githubCalls[0].status === "fulfilled",
          stale: githubCalls[0].status !== "fulfilled",
        },
        githubIssues: {
          ok: githubCalls[1].status === "fulfilled",
          stale: githubCalls[1].status !== "fulfilled",
        },
        githubVersions: {
          ok: githubCalls[2].status === "fulfilled",
          stale: githubCalls[2].status !== "fulfilled",
        },
        dingtalk: {
          ok: dingtalkResult.errors.length === 0,
          stale: dingtalkResult.errors.length > 0,
        },
      },
      errors,
      brain: assessedPullRequests.meta,
      items: deduplicate([
        ...assessedPullRequests.items,
        ...githubValues[1],
        ...dingtalkResult.items,
      ]),
      versions: githubValues[2],
    };
    snapshot.durationMs = Date.now() - startedAt;
    const diff = diffSnapshots(previous, snapshot);
    const dashboard = buildDashboard(snapshot, previous);

    let notification = { sent: false, reason: "disabled" };
    let notificationDiff = null;
    if (notify && this.config.dingtalk.enabled && !errors.length) {
      notificationDiff = diffSnapshots(notificationBaseline, snapshot);
      notification = await this.notifier.send(
        notificationDiff,
        prioritize(snapshot.items, snapshot.refreshedAt),
      );
      await this.store.write("notification-snapshot", snapshot);
    }

    await this.store.write("previous-snapshot", previous);
    await this.store.write("snapshot", snapshot);
    await this.store.write("dashboard", dashboard);
    await this.store.write("last-run", {
      diff,
      notificationDiff,
      notification,
    });
    return { dashboard, diff, notification };
  }
}
