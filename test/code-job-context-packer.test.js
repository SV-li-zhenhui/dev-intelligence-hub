import assert from "node:assert/strict";
import test from "node:test";
import {
  codeJobContextBytes,
  packCodeJobBrainContext,
} from "../src/services/code-job-context-packer.js";

function context(overrides = {}) {
  return {
    task: {
      operation: "modify",
      repository: "acme/widgets",
      objective: "Fix the state race.",
      acceptanceCriteria: ["Regression tests pass."],
      evidence: ["A stale revision can overwrite current work."],
    },
    capabilities: {
      allowedActions: ["read_text", "run_profile", "complete"],
      writablePaths: ["src"],
      requiredProfilesRemaining: 1,
    },
    turn: 8,
    observations: Array.from({ length: 8 }, (_, index) => ({
      actionType: index === 7 ? "run_profile" : "read_text",
      status: index === 6 ? "failed" : "succeeded",
      detail: JSON.stringify({
        path: `src/file-${index}.js`,
        exitCode: index === 7 ? 0 : null,
        content: `${index}-${"x".repeat(30_000)}`,
      }),
    })),
    ...overrides,
  };
}

test("context packing is deterministic, bounded, and preserves newest evidence", () => {
  const original = context();
  const first = packCodeJobBrainContext(original, { maximumBytes: 40 * 1024 });
  const second = packCodeJobBrainContext(original, { maximumBytes: 40 * 1024 });

  assert.deepEqual(first, second);
  assert.ok(codeJobContextBytes(first) <= 40 * 1024);
  assert.equal(first.observations.at(-1).detail, original.observations.at(-1).detail);
  assert.equal(
    first.observations.slice(0, -1).every((entry) =>
      JSON.parse(entry.detail).compacted === true),
    true,
  );
  assert.equal(original.observations[0].detail.includes("x".repeat(100)), true);
});

test("a fixed context that cannot fit fails deterministically", () => {
  assert.throws(
    () => packCodeJobBrainContext(context({
      task: {
        ...context().task,
        objective: "x".repeat(50_000),
      },
      observations: [],
    }), { maximumBytes: 1_024 }),
    (error) => error.code === "CODE_BRAIN_CONTEXT_UNFIT",
  );
});
