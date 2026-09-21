import assert from "node:assert/strict";
import test from "node:test";

import {
  applyDingTalkSummaries,
  cleanDingTalkMessage,
  prepareDingTalkDigest,
} from "../src/domain/dingtalk-digest.js";

function message(id, title, overrides = {}) {
  return {
    id,
    kind: "message",
    relation: "daily",
    title,
    author: "张三",
    context: "研发群",
    conversationId: "group-1",
    updatedAt: "2026-08-26T08:00:00.000Z",
    ...overrides,
  };
}

test("groups a conversation, removes media placeholders and drops reaction-only replies", () => {
  const prepared = prepareDingTalkDigest([
    message("m1", "[图片消息](mediaId=@secret) 今天刚重置的"),
    message("m2", "[赞][赞]", { author: "李四" }),
    message("m3", "030A 版本已经发布，需要统一 BS 架构", {
      author: "王五",
      updatedAt: "2026-08-26T09:00:00.000Z",
    }),
    {
      id: "old-unread",
      kind: "conversation",
      title: "2023 年的未读会话",
      updatedAt: "2023-01-01T00:00:00.000Z",
    },
  ]);

  assert.equal(prepared.groups.length, 1);
  assert.equal(prepared.groups[0].messages.length, 2);
  assert.ok(prepared.groups[0].messages.every((entry) => !entry.content.includes("mediaId")));
  assert.ok(prepared.groups[0].messages.every((entry) => !entry.content.includes("[赞]")));
  assert.equal(prepared.passthrough.length, 0);
});

test("uses one structured summary per conversation and keeps source messages as evidence", () => {
  const prepared = prepareDingTalkDigest([
    message("m1", "初步方案已完成"),
    message("m2", "请在今天确认发布风险", {
      author: "李四",
      updatedAt: "2026-08-26T09:00:00.000Z",
    }),
  ]);
  const [group] = prepared.groups;
  const items = applyDingTalkSummaries(prepared, [{
    groupId: group.groupId,
    important: true,
    summary: "研发群已完成初步方案，等待今天确认发布风险",
    highlights: ["初步方案已完成", "发布风险待确认"],
    actionRequired: "今天确认发布风险",
  }]);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "研发群已完成初步方案，等待今天确认发布风险");
  assert.equal(items[0].summaryStatus, "ai");
  assert.equal(items[0].messageCount, 2);
  assert.equal(items[0].sourceMessages.length, 2);
  assert.equal(items[0].actionRequired, "今天确认发布风险");
});

test("fallback output is an aggregate instead of the latest raw reply", () => {
  const latest = "版本发布需要确认";
  const prepared = prepareDingTalkDigest([
    message("m1", "已经完成测试"),
    message("m2", latest, { updatedAt: "2026-08-26T09:00:00.000Z" }),
  ]);
  const [item] = applyDingTalkSummaries(prepared);

  assert.notEqual(item.title, latest);
  assert.match(item.title, /2 条相关消息/);
  assert.equal(item.summaryStatus, "fallback");
});

test("message cleaner removes an image-only payload entirely", () => {
  assert.equal(cleanDingTalkMessage("[图片消息](mediaId=@private-token)"), "");
});
