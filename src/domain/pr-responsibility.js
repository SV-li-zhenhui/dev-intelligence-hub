const DAY = 86_400_000;

export const ACTION_STATES = Object.freeze({
  ACTION_NOW: "action_now",
  WAITING_OTHER: "waiting_other",
  HISTORICAL: "historical",
  UNCERTAIN: "uncertain",
});

function assessment(actionState, nextActor, nextAction, reason) {
  return {
    actionState,
    nextActor,
    nextAction,
    actionReasons: [reason],
    requiresConfirmation: actionState === ACTION_STATES.UNCERTAIN,
  };
}

function ageInDays(updatedAt, now) {
  const updated = Date.parse(updatedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(updated) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.floor((current - updated) / DAY));
}

function hasUnreviewedHead(item, reviewCommitOid) {
  return Boolean(
    item.headRefOid &&
      reviewCommitOid &&
      item.headRefOid !== reviewCommitOid,
  );
}

function assessAssignedReview(item) {
  if (item.isDraft) {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "author",
      "wait_ready_for_review",
      "等待作者将草稿标记为可审核",
    );
  }

  if (item.mergeStateStatus === "DIRTY") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "author",
      "wait_author_conflict",
      "等待作者解决合并冲突",
    );
  }

  if (["FAILURE", "ERROR"].includes(item.ciStatus)) {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "author",
      "wait_author_ci",
      "等待作者处理检查失败",
    );
  }

  if (item.ciStatus === "PENDING") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "ci",
      "wait_ci",
      "等待检查完成后再审核",
    );
  }

  if (!item.myReviewState) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "review",
      "等待你首次审核",
    );
  }

  if (hasUnreviewedHead(item, item.myReviewCommitOid)) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "rereview",
      "你审核后出现了新提交",
    );
  }

  if (!item.myReviewCommitOid || !item.headRefOid) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "缺少审核对应的提交信息",
    );
  }

  if (item.myReviewState === "CHANGES_REQUESTED") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "author",
      "wait_author_changes",
      "等待作者按你的意见修改",
    );
  }

  if (item.myReviewState === "APPROVED") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "merge_owner",
      "wait_merge",
      "你已审核通过，等待后续合并",
    );
  }

  if (item.myReviewState === "COMMENTED") {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "complete_review",
      "你已评论但尚未给出审核结论",
    );
  }

  return assessment(
    ACTION_STATES.UNCERTAIN,
    "unknown",
    "confirm",
    `无法解释你的审核状态 ${item.myReviewState}`,
  );
}

function assessAuthoredPullRequest(item) {
  if (item.mergeStateStatus === "DIRTY") {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "resolve_conflict",
      "需要你解决合并冲突",
    );
  }

  if (["FAILURE", "ERROR"].includes(item.ciStatus)) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "fix_ci",
      "需要你处理检查失败",
    );
  }

  if (item.isDraft) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "continue_draft",
      "草稿仍需继续推进或关闭",
    );
  }

  if (item.reviewDecision === "CHANGES_REQUESTED") {
    const outstandingChangeRequests =
      item.outstandingChangeRequestCommitOids || [];
    if (
      outstandingChangeRequests.length &&
      outstandingChangeRequests.every(
        (commitOid) => commitOid !== item.headRefOid,
      )
    ) {
      return assessment(
        ACTION_STATES.WAITING_OTHER,
        "reviewer",
        "wait_rereview",
        "你已在修改意见后提交更新，等待复审",
      );
    }
    if (
      outstandingChangeRequests.some(
        (commitOid) => commitOid === item.headRefOid,
      )
    ) {
      return assessment(
        ACTION_STATES.ACTION_NOW,
        "me",
        "address_review",
        "审核意见尚未处理",
      );
    }
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "缺少修改意见对应的提交信息",
    );
  }

  if (item.reviewDecision === "APPROVED") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "merge_owner",
      "wait_merge",
      "审核已通过，等待合并",
    );
  }

  if (item.ciStatus === "PENDING") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "ci",
      "wait_ci",
      "等待检查完成",
    );
  }

  return assessment(
    ACTION_STATES.WAITING_OTHER,
    "reviewer",
    "wait_review",
    "等待他人审核或反馈",
  );
}

export function assessPullRequestResponsibility(
  item,
  {
    now = new Date().toISOString(),
    historicalAfterDays = 30,
  } = {},
) {
  if (item.state && item.state !== "open") {
    return assessment(
      ACTION_STATES.HISTORICAL,
      "none",
      "closed",
      `PR 已${item.state}`,
    );
  }

  const inactiveDays = ageInDays(item.updatedAt, now);
  if (inactiveDays === null) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 未返回有效更新时间",
    );
  }
  if (inactiveDays >= historicalAfterDays) {
    return {
      ...assessment(
        ACTION_STATES.HISTORICAL,
        "unknown",
        "cleanup",
        `${inactiveDays} 天未活动，进入历史清理`,
      ),
      inactiveDays,
    };
  }

  if (item.reviewFactsAvailable !== true) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 审核事实未能完整读取",
    );
  }

  if (!item.headRefOid) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 未返回当前提交标识",
    );
  }

  if (item.ciStatus === "UNKNOWN") {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 返回了无法识别的检查状态",
    );
  }

  if (item.relation === "review_requested") {
    return assessAssignedReview(item);
  }

  if (item.relation === "authored") {
    return assessAuthoredPullRequest(item);
  }

  return assessment(
    ACTION_STATES.UNCERTAIN,
    "unknown",
    "confirm",
    "无法确定你在这个 PR 中的责任角色",
  );
}
