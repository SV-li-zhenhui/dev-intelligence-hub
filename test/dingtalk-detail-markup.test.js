import assert from "node:assert/strict";
import test from "node:test";

import { dingtalkDetailMarkup } from "../public/dingtalk-detail-markup.js";

test("DingTalk detail shows summary, action and traceable source evidence", () => {
  const markup = dingtalkDetailMarkup({
    title: "发布风险待确认",
    summary: "030A 已发布，团队需要统一后续架构。",
    highlights: ["版本已发布", "架构尚未统一"],
    actionRequired: "确认统一方案负责人",
    summaryStatus: "ai",
    messageCount: 2,
    sourceMessages: [
      {
        author: "张三",
        content: "原始消息 <不可执行>",
        updatedAt: "2026-08-26T09:00:00.000Z",
      },
    ],
  });

  assert.match(markup, /总结/);
  assert.match(markup, /需要你处理/);
  assert.match(markup, /确认统一方案负责人/);
  assert.match(markup, /查看依据消息（2 条）/);
  assert.ok(!markup.includes("<不可执行>"));
  assert.ok(markup.includes("&lt;不可执行&gt;"));
});
