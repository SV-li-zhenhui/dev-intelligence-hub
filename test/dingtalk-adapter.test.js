import assert from "node:assert/strict";
import test from "node:test";

import { DingTalkAdapter } from "../src/adapters/dingtalk-adapter.js";

test("DingTalk collection forwards one shutdown signal to every CLI read", async () => {
  const controller = new AbortController();
  const calls = [];
  const adapter = new DingTalkAdapter({
    async run(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes("list-all")) {
        return {
          result: {
            conversationMessagesList: [
              {
                title: "研发群",
                singleChat: false,
                openConversationId: "group-1",
                messages: [
                  {
                    openMessageId: "message-1",
                    sender: "PR Notice",
                    content: "发布提醒：v4.0.701 需要确认",
                    createTime: "2026-08-25 09:00:00",
                  },
                ],
              },
            ],
          },
        };
      }
      if (args.includes("list-unread-conversations")) {
        return { result: { conversations: [] } };
      }
      if (args.includes("search-advanced")) {
        return { result: { messages: [] } };
      }
      if (args.includes("task")) {
        return { result: { todoCards: [] } };
      }
      throw new Error(`Unexpected DingTalk command: ${args.join(" ")}`);
    },
  });

  const result = await adapter.collect(null, { signal: controller.signal });

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.items.map(({ kind, title, context }) => ({
    kind,
    title,
    context,
  })), [
    {
      kind: "announcement",
      title: "发布提醒：v4.0.701 需要确认",
      context: "研发群",
    },
  ]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.command === "dws"));
  assert.ok(calls.every((call) => call.options.signal === controller.signal));
  const daily = calls.find((call) => call.args.includes("list-all"));
  assert.ok(daily.args.includes("--cursor"));
  assert.ok(daily.args.includes("0"));
});

test("DingTalk notification forwards shutdown to the CLI writer", async () => {
  const controller = new AbortController();
  let call = null;
  const adapter = new DingTalkAdapter({
    async runText(command, args, options) {
      call = { command, args, options };
      return "";
    },
  });

  await adapter.notifySelf(
    "local-owner",
    "title",
    "message",
    { signal: controller.signal },
  );

  assert.equal(call.command, "dws");
  assert.equal(call.options.timeoutMs, 60_000);
  assert.strictEqual(call.options.signal, controller.signal);
});
