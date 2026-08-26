import assert from "node:assert/strict";
import test from "node:test";
import { prioritize, scoreItem } from "../src/domain/prioritizer.js";

const now = "2026-07-30T09:00:00.000Z";

test("review requests appear ahead of authored pull requests", () => {
  const result = prioritize(
    [
      {
        id: "own",
        kind: "pull_request",
        relation: "authored",
        updatedAt: now,
      },
      {
        id: "review",
        kind: "pull_request",
        relation: "review_requested",
        updatedAt: now,
      },
    ],
    now,
  );
  assert.equal(result[0].id, "review");
  assert.equal(result[0].score, 100);
});

test("failing CI promotes an authored pull request", () => {
  const result = scoreItem(
    {
      kind: "pull_request",
      relation: "authored",
      ciStatus: "FAILURE",
      updatedAt: now,
    },
    now,
  );
  assert.equal(result.score, 92);
  assert.equal(result.reasons[0], "检查失败");
});

test("overdue items are urgent", () => {
  const result = scoreItem(
    {
      kind: "todo",
      relation: "assigned",
      dueAt: "2026-07-28T09:00:00.000Z",
      updatedAt: now,
    },
    now,
  );
  assert.equal(result.score, 96);
  assert.equal(result.reasons[0], "已经逾期");
});

test("ordinary assigned issues do not flood the focus queue", () => {
  const result = scoreItem(
    {
      kind: "issue",
      relation: "assigned",
      labels: [],
      updatedAt: now,
    },
    now,
  );
  assert.equal(result.score, 55);
});

test("issues outside the active window are deferred instead of promoted as stale", () => {
  const recent = scoreItem(
    {
      kind: "issue",
      relation: "assigned",
      labels: [],
      updatedAt: "2026-07-25T09:00:00.000Z",
    },
    now,
    { issueActiveWindowDays: 14 },
  );
  const old = scoreItem(
    {
      kind: "issue",
      relation: "assigned",
      labels: ["p0"],
      updatedAt: "2026-07-01T09:00:00.000Z",
    },
    now,
    { issueActiveWindowDays: 14 },
  );

  assert.equal(recent.score, 55);
  assert.equal(old.score, 15);
  assert.deepEqual(old.reasons, ["超过 14 天，稍后处理"]);
});

test("PR action state wins over legacy relation and stale urgency signals", () => {
  const waiting = scoreItem(
    {
      kind: "pull_request",
      relation: "review_requested",
      actionState: "waiting_other",
      actionReasons: ["等待作者处理检查失败"],
      ciStatus: "FAILURE",
      updatedAt: "2026-07-01T09:00:00.000Z",
    },
    now,
  );
  const historical = scoreItem(
    {
      kind: "pull_request",
      relation: "review_requested",
      actionState: "historical",
      actionReasons: ["90 天未活动，进入历史清理"],
      ciStatus: "FAILURE",
      updatedAt: "2026-04-01T09:00:00.000Z",
    },
    now,
  );

  assert.equal(waiting.score, 35);
  assert.deepEqual(waiting.reasons, ["等待作者处理检查失败"]);
  assert.equal(historical.score, 5);
  assert.deepEqual(historical.reasons, ["90 天未活动，进入历史清理"]);
});

test("PR action type determines focus priority", () => {
  const review = scoreItem(
    {
      kind: "pull_request",
      actionState: "action_now",
      nextAction: "review",
      actionReasons: ["等待你首次审核"],
      updatedAt: now,
    },
    now,
  );
  const fixCi = scoreItem(
    {
      kind: "pull_request",
      actionState: "action_now",
      nextAction: "fix_ci",
      actionReasons: ["需要你处理检查失败"],
      updatedAt: now,
    },
    now,
  );
  const uncertain = scoreItem(
    {
      kind: "pull_request",
      actionState: "uncertain",
      actionReasons: ["GitHub 审核事实未能完整读取"],
      updatedAt: now,
    },
    now,
  );

  assert.equal(review.score, 100);
  assert.equal(fixCi.score, 92);
  assert.equal(uncertain.score, 80);
  assert.equal(uncertain.reasons[0], "需要你确认责任归属");
});
