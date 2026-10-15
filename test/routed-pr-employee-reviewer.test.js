import assert from "node:assert/strict";
import test from "node:test";
import { BrainRouter } from "../src/services/brain-router.js";
import { OllamaPrEmployeeReviewer } from "../src/adapters/ollama-pr-employee-reviewer.js";
import { RoutedPrEmployeeReviewer } from "../src/adapters/routed-pr-employee-reviewer.js";

const primaryBrain = { provider: "codex-login-cli", model: "gpt-5.6-luna", reasoningEffort: "medium",
  remoteData: { requirements: true, code: true, memory: false } };
const input = { repo: "acme/repo", number: 42, title: "Triage current PR", workMode: "triage", description: "Requested behavior", patch: "untrusted diff" };
const result = { workType: "triage_plan", summary: "Transfer to PR engineer", confidence: 0.8, evidence: ["Current PR facts"],
  steps: ["Inspect complete Head"], questions: [], reviewVerdict: "none", reviewBody: "", requiresApproval: false };
const fail = (code) => Object.assign(new Error(code), { code });
function setup(generate, overrides = {}) {
  let fallbackCalls = 0;
  const fallback = new OllamaPrEmployeeReviewer({ model: "qwen3.5:9b", fetch: async () => {
    fallbackCalls += 1;
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(result) } }) };
  } });
  const router = new BrainRouter({ providers: [{ id: primaryBrain.provider, remote: true, generate }] });
  const reviewer = new RoutedPrEmployeeReviewer({ router, primaryBrain, fallback, ...overrides });
  return { reviewer, fallbackCalls: () => fallbackCalls };
}

test("Codex primary uses the requested model and original result contract without local generation", async () => {
  let request;
  const run = setup(async (value) => { request = value; return JSON.stringify(result); });
  const received = await run.reviewer.analyzeWithReceipt(input);
  assert.deepEqual(received.analysis, result);
  assert.deepEqual(received.brain, { provider: primaryBrain.provider, model: "gpt-5.6-luna" });
  assert.equal(request.model, "gpt-5.6-luna");
  assert.equal(request.reasoningEffort, "medium");
  assert.match(request.messages[1].content, /untrusted diff/u);
  assert.equal(run.fallbackCalls(), 0);
});

for (const code of ["STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE", "STRUCTURED_PROVIDER_PROCESS_FAILED", "STRUCTURED_PROVIDER_TIMEOUT", "STRUCTURED_PROVIDER_QUEUE_TIMEOUT", "STRUCTURED_PROVIDER_RESPONSE_INVALID"]) {
  test(`ended primary ${code} falls back once and records the actual model`, async () => {
    const run = setup(async () => { throw fail(code); });
    const received = await run.reviewer.analyzeWithReceipt(input);
    assert.deepEqual(received.analysis, result);
    assert.deepEqual(received.brain, { provider: "ollama", model: "qwen3.5:9b", fallbackFrom: {
      provider: primaryBrain.provider, model: primaryBrain.model, reason: code } });
    assert.equal(run.fallbackCalls(), 1);
  });
}

for (const code of ["STRUCTURED_PROVIDER_REAP_FAILED", "STRUCTURED_PROVIDER_CLEANUP_FAILED", "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", "RUNTIME_RESTART_REQUIRED", "REMOTE_DATA_NOT_AUTHORIZED", "PR_REVIEW_READ_HEAD_CHANGED", "STRUCTURED_PROVIDER_CANCELLED", "UNKNOWN_ERROR"]) {
  test(`${code} never opens a fallback model request`, async () => {
    const error = fail(code);
    const run = setup(async () => { throw error; });
    await assert.rejects(run.reviewer.analyze(input), (caught) => caught === error);
    assert.equal(run.fallbackCalls(), 0);
  });
}

test("remote code authorization is enforced before provider dispatch and cannot be bypassed by fallback", async () => {
  let primaryCalls = 0;
  const run = setup(async () => { primaryCalls += 1; return JSON.stringify(result); },
    { primaryBrain: { ...primaryBrain, remoteData: { ...primaryBrain.remoteData, code: false } } });
  await assert.rejects(run.reviewer.analyze(input), { code: "REMOTE_DATA_NOT_AUTHORIZED" });
  assert.equal(primaryCalls, 0);
  assert.equal(run.fallbackCalls(), 0);
});

test("invalid primary business output is never accepted and local output is validated", async () => {
  const run = setup(async () => JSON.stringify({ ...result, workType: "owner_plan" }));
  const received = await run.reviewer.analyzeWithReceipt(input);
  assert.deepEqual(received.analysis, result);
  assert.equal(received.brain.fallbackFrom.reason, "PR_EMPLOYEE_RESULT_INVALID");
});

test("primary timeout waits for confirmed completion before starting fallback", async () => {
  let aborted;
  const onAbort = new Promise((resolve) => { aborted = resolve; });
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  const run = setup(async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    aborted();
    await stopped;
    throw fail("STRUCTURED_PROVIDER_CANCELLED");
  }, { timeoutMs: 10 });
  const pending = run.reviewer.analyzeWithReceipt(input);
  await onAbort;
  assert.equal(run.fallbackCalls(), 0);
  finish();
  assert.equal((await pending).brain.fallbackFrom.reason, "PR_EMPLOYEE_PRIMARY_TIMEOUT");
  assert.equal(run.fallbackCalls(), 1);
});

test("unconfirmed reap after the primary deadline still blocks fallback", async () => {
  const run = setup(async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw fail("STRUCTURED_PROVIDER_REAP_FAILED");
  }, { timeoutMs: 10 });
  await assert.rejects(run.reviewer.analyze(input), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  assert.equal(run.fallbackCalls(), 0);
});

test("user cancellation wins over a transport fallback classification", async () => {
  const controller = new AbortController();
  const reason = new Error("Owner stopped this work");
  const run = setup(async () => { controller.abort(reason); throw fail("STRUCTURED_PROVIDER_PROCESS_FAILED"); });
  await assert.rejects(run.reviewer.analyze(input, { signal: controller.signal }), (caught) => caught === reason);
  assert.equal(run.fallbackCalls(), 0);
});

test("backup failure remains a real failed analysis", async () => {
  const error = new Error("Ollama transport failed too");
  const run = setup(async () => { throw fail("STRUCTURED_PROVIDER_UNAVAILABLE"); },
    { fallback: { provider: "ollama", model: "qwen3.5:9b", async analyze() { throw error; } } });
  await assert.rejects(run.reviewer.analyze(input), (caught) => caught === error);
  assert.deepEqual(run.reviewer.getFailureReceipt(error), {
    brain: { provider: "ollama", model: "qwen3.5:9b", fallbackFrom: {
      provider: primaryBrain.provider, model: primaryBrain.model, reason: "STRUCTURED_PROVIDER_UNAVAILABLE" } },
    modelFailure: false,
  });
  assert.equal(run.reviewer.getFailureReceipt(new Error("unrelated failure")), null);
});

test("failed fallback receipt cannot be forged by error properties or modified after retrieval", async () => {
  const error = Object.assign(new Error("Ollama employee transport request failed"), {
    brain: { provider: "fake", model: "fake" }, modelFailure: false,
  });
  const run = setup(async () => { throw fail("STRUCTURED_PROVIDER_PROCESS_FAILED"); },
    { fallback: { provider: "ollama", model: "qwen3.5:9b", async analyze() { throw error; } } });
  await assert.rejects(run.reviewer.analyze(input), (caught) => caught === error);
  const receipt = run.reviewer.getFailureReceipt(error);
  assert.equal(receipt.modelFailure, true);
  receipt.brain.provider = "mutated";
  assert.equal(run.reviewer.getFailureReceipt(error).brain.provider, "ollama");
  const other = setup(async () => JSON.stringify(result));
  assert.equal(other.reviewer.getFailureReceipt(error), null);
});

test("cancellation during fallback preserves the owner reason without a failure receipt", async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error("Owner stopped fallback"), { code: "LIFECYCLE_SHUTDOWN_ABORTED" });
  const transport = new Error("Ollama employee transport request failed");
  const run = setup(async () => { throw fail("STRUCTURED_PROVIDER_UNAVAILABLE"); },
    { fallback: { provider: "ollama", model: "qwen3.5:9b", async analyze() {
      controller.abort(reason);
      throw transport;
    } } });
  await assert.rejects(run.reviewer.analyze(input, { signal: controller.signal }), (caught) => caught === reason);
  assert.equal(run.reviewer.getFailureReceipt(transport), null);
  assert.equal(run.reviewer.getFailureReceipt(reason), null);
});

for (const code of ["REMOTE_DATA_NOT_AUTHORIZED", "RUNTIME_RESTART_REQUIRED", "STRUCTURED_PROVIDER_REAP_FAILED", "STRUCTURED_PROVIDER_CANCELLED", "UNKNOWN_ERROR"]) {
  test(`fallback ${code} cannot become a recoverable model failure through its message`, async () => {
    const error = Object.assign(new Error("Ollama employee transport request failed"), { code });
    const run = setup(async () => { throw fail("STRUCTURED_PROVIDER_UNAVAILABLE"); },
      { fallback: { provider: "ollama", model: "qwen3.5:9b", async analyze() { throw error; } } });
    await assert.rejects(run.reviewer.analyze(input), (caught) => caught === error);
    assert.equal(run.reviewer.getFailureReceipt(error).modelFailure, false);
  });
}

test("a reused error object cannot carry a previous fallback receipt into a later primary failure", async () => {
  const error = new Error("Ollama employee transport request failed");
  let primaryCalls = 0;
  const run = setup(async () => {
    primaryCalls += 1;
    if (primaryCalls === 1) throw fail("STRUCTURED_PROVIDER_UNAVAILABLE");
    throw error;
  }, { fallback: { provider: "ollama", model: "qwen3.5:9b", async analyze() { throw error; } } });
  await assert.rejects(run.reviewer.analyze(input), (caught) => caught === error);
  assert.equal(run.reviewer.getFailureReceipt(error).brain.provider, "ollama");
  await assert.rejects(run.reviewer.analyze(input), (caught) => caught === error);
  assert.equal(run.reviewer.getFailureReceipt(error), null);
});
