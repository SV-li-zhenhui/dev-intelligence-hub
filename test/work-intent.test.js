import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkIntentError,
  normalizeWorkDecision,
  normalizeWorkIntent,
  workIntentDigest,
} from "../src/domain/work-intent.js";

function common(type) {
  return {
    schemaVersion: 1,
    type,
    summary: "已完成事实核对",
    reason: "需要选择下一步",
  };
}

function assertInvalid(value) {
  assert.throws(
    () => normalizeWorkIntent(value),
    (error) =>
      error instanceof WorkIntentError && error.code === "WORK_INTENT_INVALID",
  );
}

test("normalizes every bounded employee intent without trusted targets", () => {
  const cases = [
    {
      ...common("ask_user"),
      question: "需求冲突时，以哪个验收口径为准？",
      choices: [
        { id: "current-spec", label: "当前 SDS", description: "按当前文档继续" },
        { id: "issue-text", label: "Issue 原文", description: "退回原始描述" },
      ],
    },
    {
      ...common("wait_condition"),
      condition: {
        kind: "workflow_fact",
        fact: "ci-status",
        oneOf: ["success"],
      },
      checkAfterSeconds: 300,
    },
    {
      ...common("wait_condition"),
      condition: {
        kind: "time",
        notBefore: "2026-08-03T01:02:03.000Z",
      },
      checkAfterSeconds: 3600,
    },
    {
      ...common("propose_github_review"),
      verdict: "request_changes",
      body: "空值分支会错误地发布旧状态，请先修复。",
      evidence: ["src/service.js:42"],
    },
    {
      ...common("propose_code_action"),
      operation: "modify",
      objective: "修复空值分支并保持接口兼容",
      acceptanceCriteria: ["现有测试通过", "新增回归测试"],
      evidence: ["失败发生在状态转换之后"],
    },
    {
      ...common("handoff"),
      capability: "testing",
      brief: "验证修复在 Windows 和 Docker 中一致",
      evidence: ["单元测试已通过"],
    },
    {
      ...common("complete"),
      outcome: "done",
      evidence: ["验收条件全部满足"],
    },
  ];

  for (const candidate of cases) {
    const normalized = normalizeWorkIntent(candidate);
    assert.deepEqual(normalized, candidate);
    const serialized = JSON.stringify(normalized);
    for (const forbidden of [
      "accountId",
      "repository",
      "pullRequestNumber",
      "headRefOid",
      "workspaceId",
      "command",
      "env",
      "token",
    ]) {
      assert.equal(serialized.includes(`\"${forbidden}\"`), false);
    }
  }
});

test("a brain decision binds confidence and one exact structured intent", () => {
  const decision = normalizeWorkDecision({
    schemaVersion: 1,
    confidence: 82,
    summary: "CI 尚未成功，应继续观察",
    intent: {
      ...common("wait_condition"),
      condition: {
        kind: "workflow_fact",
        fact: "ci-status",
        oneOf: ["success", "failure"],
      },
      checkAfterSeconds: 180,
    },
  });

  assert.equal(decision.confidence, 82);
  assert.equal(decision.intent.type, "wait_condition");
  assert.match(workIntentDigest(decision.intent), /^[a-f0-9]{64}$/);
  assert.equal(
    workIntentDigest(decision.intent),
    workIntentDigest({
      reason: decision.intent.reason,
      type: decision.intent.type,
      schemaVersion: 1,
      condition: { oneOf: ["success", "failure"], fact: "ci-status", kind: "workflow_fact" },
      checkAfterSeconds: 180,
      summary: decision.intent.summary,
    }),
  );
});

test("rejects targets, capabilities, and executable details outside the contract", () => {
  const github = {
    ...common("propose_github_review"),
    verdict: "comment",
    body: "建议补充测试。",
    evidence: [],
  };
  const code = {
    ...common("propose_code_action"),
    operation: "inspect",
    objective: "定位失败原因",
    acceptanceCriteria: ["找到可复现原因"],
    evidence: [],
  };

  for (const candidate of [
    { ...github, accountId: "someone" },
    { ...github, repository: "owner/repo" },
    { ...github, pullRequestNumber: 42 },
    { ...github, headRefOid: "a".repeat(40) },
    { ...code, workspaceId: "repo" },
    { ...code, command: "npm test" },
    { ...code, args: ["test"] },
    { ...code, env: { TOKEN: "secret" } },
    { ...code, shell: true },
    { ...common("handoff"), capability: "root", brief: "升级权限", evidence: [] },
  ]) {
    assertInvalid(candidate);
  }
});

test("rejects unknown schemas, malformed variants, and oversized text", () => {
  const ask = {
    ...common("ask_user"),
    question: "是否继续？",
    choices: [],
  };
  for (const candidate of [
    { ...ask, schemaVersion: 2 },
    { ...ask, type: "execute_shell" },
    { ...ask, question: "bad\u0000question" },
    { ...ask, choices: Array.from({ length: 9 }, (_, index) => ({ id: `c-${index}`, label: "选项", description: "说明" })) },
    { ...ask, summary: "x".repeat(2_049) },
    { ...common("wait_condition"), condition: { kind: "workflow_fact", fact: "ci-status", oneOf: [] }, checkAfterSeconds: 300 },
    { ...common("wait_condition"), condition: { kind: "time", notBefore: "tomorrow" }, checkAfterSeconds: 300 },
    { ...common("wait_condition"), condition: { kind: "time", notBefore: "2026-08-03T01:02:03.000Z" }, checkAfterSeconds: 1 },
    { ...common("propose_github_review"), verdict: "merge", body: "merge", evidence: [] },
    { ...common("propose_github_review"), verdict: "comment", body: "x".repeat(16 * 1024 + 1), evidence: [] },
    { ...common("propose_code_action"), operation: "shell", objective: "run", acceptanceCriteria: [], evidence: [] },
    { ...common("complete"), outcome: "blocked", evidence: [] },
  ]) {
    assertInvalid(candidate);
  }
});

test("rejects inherited, accessor, symbol, sparse, cyclic, and mutable decision envelopes", () => {
  const ask = {
    ...common("ask_user"),
    question: "是否继续？",
    choices: [],
  };
  assertInvalid(Object.assign(Object.create({ command: "whoami" }), ask));

  const accessor = { ...ask };
  Object.defineProperty(accessor, "question", {
    enumerable: true,
    get: () => "不要调用 getter",
  });
  assertInvalid(accessor);

  const symbol = { ...ask, [Symbol("secret")]: true };
  assertInvalid(symbol);

  const sparseChoices = new Array(1);
  assertInvalid({ ...ask, choices: sparseChoices });

  const cyclicEvidence = [];
  cyclicEvidence.push(cyclicEvidence);
  assertInvalid({
    ...common("complete"),
    outcome: "done",
    evidence: cyclicEvidence,
  });

  assert.throws(
    () => normalizeWorkDecision({
      schemaVersion: 1,
      confidence: 101,
      summary: "invalid",
      intent: ask,
    }),
    (error) => error instanceof WorkIntentError,
  );
  assert.throws(
    () => normalizeWorkDecision({
      schemaVersion: 1,
      confidence: 50,
      summary: "invalid",
      intent: ask,
      prompt: "hidden",
    }),
    (error) => error instanceof WorkIntentError,
  );
});
