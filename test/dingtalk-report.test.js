import assert from "node:assert/strict";
import test from "node:test";

import {
  createDingTalkReport,
  dueDingTalkReportSlot,
  projectDingTalkReportState,
} from "../src/domain/dingtalk-report.js";

test("DingTalk reports follow the 09:00 to 20:00 Asia/Shanghai schedule", () => {
  assert.equal(dueDingTalkReportSlot("2026-09-23T00:59:00.000Z"), null);

  const morning = dueDingTalkReportSlot("2026-09-23T01:00:00.000Z");
  assert.deepEqual(morning, {
    slotKey: "2026-09-23@09:00",
    localDate: "2026-09-23",
    time: "09:00",
    kind: "daily_overview",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(
    dueDingTalkReportSlot("2026-09-23T03:59:00.000Z", morning.slotKey),
    null,
  );
  assert.equal(
    dueDingTalkReportSlot("2026-09-23T01:30:00.000Z", "2026-09-23@12:00"),
    null,
  );
  assert.equal(
    dueDingTalkReportSlot("2026-09-23T04:05:00.000Z", morning.slotKey).time,
    "12:00",
  );
  assert.equal(
    dueDingTalkReportSlot("2026-09-23T12:01:00.000Z").kind,
    "daily_close",
  );
});

test("a morning report summarizes open DingTalk work and later reports show changes", () => {
  const dashboard = {
    groups: {
      dingtalk: [
        {
          id: "dingtalk:todo:1",
          kind: "todo",
          title: "确认发布计划",
          dueAt: "2026-09-22T08:00:00.000Z",
          updatedAt: "2026-09-23T00:30:00.000Z",
          state: "open",
        },
        {
          id: "dingtalk:digest:group-1",
          kind: "mention",
          title: "研发群等待确认风险",
          actionRequired: "确认发布风险",
          updatedAt: "2026-09-23T00:40:00.000Z",
          state: "open",
        },
      ],
    },
  };
  const morningSlot = dueDingTalkReportSlot("2026-09-23T01:00:00.000Z");
  const morning = createDingTalkReport(
    dashboard,
    morningSlot,
    null,
    "2026-09-23T01:00:00.000Z",
  );

  assert.equal(morning.counts.todos, 1);
  assert.equal(morning.counts.overdue, 1);
  assert.equal(morning.counts.conversations, 1);
  assert.match(morning.summary, /1 项待办、1 项逾期、1 项重要消息/);
  assert.match(morning.message, /确认发布风险/);

  const noonSlot = dueDingTalkReportSlot(
    "2026-09-23T04:00:00.000Z",
    morning.slotKey,
  );
  const noon = createDingTalkReport(
    dashboard,
    noonSlot,
    { lastSlotKey: morning.slotKey, baseline: morning.baseline },
    "2026-09-23T04:00:00.000Z",
  );
  assert.equal(noon.counts.changed, 0);
  assert.match(noon.message, /没有新增或变化/);
});

test("the browser projection omits delivery text and comparison baseline", () => {
  const slot = dueDingTalkReportSlot("2026-09-23T01:00:00.000Z");
  const report = createDingTalkReport(
    { groups: { dingtalk: [] } },
    slot,
    null,
    "2026-09-23T01:00:00.000Z",
  );
  const projected = projectDingTalkReportState({
    latest: { status: "sent", report },
  });

  assert.equal(projected.status, "sent");
  assert.equal(projected.message, undefined);
  assert.equal(projected.baseline, undefined);
  assert.equal(projected.slotKey, "2026-09-23@09:00");
});
