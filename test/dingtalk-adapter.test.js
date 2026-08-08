import assert from "node:assert/strict";
import test from "node:test";

import { DingTalkAdapter } from "../src/adapters/dingtalk-adapter.js";

test("DingTalk collection forwards one shutdown signal to every CLI read", async () => {
  const controller = new AbortController();
  const calls = [];
  const adapter = new DingTalkAdapter({
    async run(command, args, options) {
      calls.push({ command, args, options });
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

  assert.deepEqual(result, { items: [], errors: [] });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.command === "dws"));
  assert.ok(calls.every((call) => call.options.signal === controller.signal));
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
