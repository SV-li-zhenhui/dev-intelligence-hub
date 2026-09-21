import assert from "node:assert/strict";
import test from "node:test";

const support = await import(
  new URL("../public/pr-employee-job-support.js", import.meta.url)
).catch(() => ({}));

test("only ordinary blocked analyses expose owner recovery actions", () => {
  assert.equal(typeof support.prEmployeeBlockedActions, "function");

  assert.deepEqual(
    support.prEmployeeBlockedActions({ status: "blocked" }),
    [
      { id: "retry", label: "重新分析" },
      { id: "dismiss", label: "关闭此失败" },
    ],
  );
  assert.deepEqual(
    support.prEmployeeBlockedActions({
      status: "blocked",
      confirmationId: "confirmation-1",
    }),
    [],
  );
  assert.deepEqual(
    support.prEmployeeBlockedActions({
      status: "blocked",
      confirmationFailure: { outcome: "unknown" },
    }),
    [],
  );
  assert.deepEqual(
    support.prEmployeeBlockedActions({ status: "retry_wait" }),
    [],
  );
});

test("recovery intent stays bound to the job, Head, and role revision shown", () => {
  assert.equal(typeof support.createPrEmployeeRecoveryIntent, "function");
  assert.equal(typeof support.isPrEmployeeRecoveryIntentCurrent, "function");

  const job = {
    id: "pr-work-1",
    status: "blocked",
    headRefOid: "head-1",
  };
  const intent = support.createPrEmployeeRecoveryIntent(job, 7);

  assert.deepEqual(intent, {
    id: "pr-work-1",
    headRefOid: "head-1",
    expectedRevision: 7,
  });
  assert.equal(
    support.isPrEmployeeRecoveryIntentCurrent(intent, job, 7),
    true,
  );
  assert.equal(
    support.isPrEmployeeRecoveryIntentCurrent(intent, job, 8),
    false,
  );
  assert.equal(
    support.isPrEmployeeRecoveryIntentCurrent(
      intent,
      { ...job, headRefOid: "head-2" },
      7,
    ),
    false,
  );
  assert.equal(
    support.isPrEmployeeRecoveryIntentCurrent(
      intent,
      { ...job, status: "ready_for_human" },
      7,
    ),
    false,
  );
});
