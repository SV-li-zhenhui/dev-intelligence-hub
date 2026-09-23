import assert from "node:assert/strict";
import test from "node:test";

import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { NotificationService } from "../src/services/notification-service.js";

const CONFIGURATION_A = Object.freeze({
  version: 1,
  configurationDigest: "a".repeat(64),
});
const CONFIGURATION_B = Object.freeze({
  version: 2,
  configurationDigest: "b".repeat(64),
});

function notificationInput() {
  const item = {
    id: "github:pr:acme/repo#42",
    repo: "acme/repo",
    number: 42,
    title: "Important pull request",
    score: 95,
    reasons: ["CI failed"],
  };
  return {
    diff: { baseline: false, added: [item], changed: [] },
    prioritizedItems: [item],
  };
}

function service(gate, calls) {
  return new NotificationService(
    {
      async notifySelf(...input) {
        calls.push(input);
      },
    },
    {
      selfUserId: "local-owner",
      notifyMinimumScore: 80,
      maxNotificationsPerRun: 5,
    },
    { actionAdmissionGate: gate },
  );
}

test("configuration cutover fences a new notification before DingTalk", async () => {
  const gate = new ActionAdmissionGate();
  gate.bindEffective(CONFIGURATION_A);
  await gate.cutover(({ commit }) => commit(CONFIGURATION_B));
  const calls = [];
  const notifier = service(gate, calls);
  const { diff, prioritizedItems } = notificationInput();

  await assert.rejects(
    notifier.send(diff, prioritizedItems),
    (error) => error?.code === "RUNTIME_RESTART_REQUIRED",
  );
  assert.deepEqual(calls, []);
});

test("an admitted notification settles before configuration cutover", async () => {
  const gate = new ActionAdmissionGate();
  gate.bindEffective(CONFIGURATION_A);
  let release;
  const entered = new Promise((resolve) => {
    release = resolve;
  });
  let notificationStarted;
  const started = new Promise((resolve) => {
    notificationStarted = resolve;
  });
  const notifier = new NotificationService(
    {
      async notifySelf() {
        notificationStarted();
        await entered;
      },
    },
    {
      selfUserId: "local-owner",
      notifyMinimumScore: 80,
      maxNotificationsPerRun: 5,
    },
    { actionAdmissionGate: gate },
  );
  const { diff, prioritizedItems } = notificationInput();

  const sending = notifier.send(diff, prioritizedItems);
  await started;
  let cutoverSettled = false;
  const cutover = gate.cutover(({ commit }) => commit(CONFIGURATION_B))
    .then(() => { cutoverSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cutoverSettled, false);
  release();
  await sending;
  await cutover;
  assert.equal(gate.readStatus().mode, "restart_required");
});

test("notification delivery forwards the refresh shutdown signal", async () => {
  const gate = new ActionAdmissionGate();
  gate.bindEffective(CONFIGURATION_A);
  const controller = new AbortController();
  let receivedSignal = null;
  const notifier = new NotificationService(
    {
      async notifySelf(_userId, _title, _message, options) {
        receivedSignal = options.signal;
      },
    },
    {
      selfUserId: "local-owner",
      notifyMinimumScore: 80,
      maxNotificationsPerRun: 5,
    },
    { actionAdmissionGate: gate },
  );
  const { diff, prioritizedItems } = notificationInput();

  await notifier.send(diff, prioritizedItems, { signal: controller.signal });
  assert.strictEqual(receivedSignal, controller.signal);
});

test("collected DingTalk messages never notify back into DingTalk", async () => {
  const calls = [];
  const notifier = service(new ActionAdmissionGate(), calls);
  const item = {
    id: "dingtalk:message:1",
    kind: "announcement",
    title: "群公告",
    score: 88,
    reasons: ["今日公告/重要通知"],
  };

  const result = await notifier.send(
    { baseline: false, added: [item], changed: [] },
    [item],
  );

  assert.deepEqual(result, { sent: false, reason: "no-important-change" });
  assert.deepEqual(calls, []);
});

test("scheduled report delivery uses the same admitted DingTalk writer", async () => {
  const calls = [];
  const controller = new AbortController();
  const gate = new ActionAdmissionGate();
  gate.bindEffective(CONFIGURATION_A);
  const notifier = service(gate, calls);

  const result = await notifier.sendReport({
    reportId: "dingtalk-report-1",
    slotKey: "2026-09-23@09:00",
    title: "钉钉每日总览 · 2026-09-23",
    message: "今日共有 3 项待办。",
  }, { signal: controller.signal });

  assert.deepEqual(result, {
    sent: true,
    reportId: "dingtalk-report-1",
    slotKey: "2026-09-23@09:00",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "local-owner");
  assert.equal(calls[0][1], "钉钉每日总览 · 2026-09-23");
  assert.strictEqual(calls[0][3].signal, controller.signal);
});
