import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeJobBrainDirectory,
  CodeJobBrainDirectoryError,
} from "../src/services/code-job-brain-directory.js";
import { BrainRouter } from "../src/services/brain-router.js";

function roleBrain(remoteData = {
  requirements: false,
  code: false,
  memory: false,
}) {
  return {
    developer: {
      name: "Developer",
      brain: { provider: "brain-one", model: "qwen3.5:9b", remoteData },
    },
  };
}

function decision(action = { type: "read_text", path: "src/app.js" }) {
  return JSON.stringify({
    schemaVersion: 1,
    confidence: 88,
    summary: "Inspect the implementation.",
    reason: "More evidence is needed.",
    action,
  });
}

function input(overrides = {}) {
  return {
    roleId: "developer",
    task: {
      operation: "modify",
      repository: "acme/widgets",
      objective: "Fix the state race.",
      acceptanceCriteria: ["Regression test passes."],
      evidence: ["A stale revision can overwrite newer state."],
    },
    capabilities: {
      allowedActions: [
        "list_files",
        "read_text",
        "search_text",
        "write_text",
        "run_profile",
        "complete",
      ],
      writablePaths: ["src", "test"],
      requiredProfilesRemaining: 1,
    },
    turn: 1,
    observations: [],
    ...overrides,
  };
}

function fakeRouter(responses = [decision()]) {
  const calls = [];
  return {
    calls,
    port: {
      async generate(value) {
        calls.push(structuredClone(value));
        return responses[Math.min(calls.length - 1, responses.length - 1)];
      },
      describe(brain) {
        return {
          provider: brain.provider,
          model: brain.model,
          remote: false,
          remoteData: brain.remoteData,
        };
      },
    },
  };
}

test("a role brain receives only bounded semantic code context", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });

  assert.deepEqual(await directory.decide(input()), JSON.parse(decision()));
  assert.equal(router.calls.length, 1);
  assert.deepEqual(router.calls[0].dataClasses, ["requirements", "code"]);
  assert.equal(router.calls[0].brain.model, "qwen3.5:9b");
  const userContext = JSON.parse(router.calls[0].messages[1].content);
  assert.deepEqual(Object.keys(userContext), [
    "task",
    "capabilities",
    "turn",
    "observations",
  ]);
  for (const forbidden of [
    "sessionId",
    "actionId",
    "workspaceRevision",
    "expectedSha256",
    "profileId",
    "command",
    "env",
  ]) {
    assert.equal(Object.hasOwn(userContext, forbidden), false);
    assert.equal(router.calls[0].messages[1].content.includes(`\"${forbidden}\"`), false);
  }
});

test("one invalid model response gets exactly one local correction attempt", async () => {
  const router = fakeRouter(["not json", decision({ type: "run_profile" })]);
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });

  assert.equal((await directory.decide(input())).action.type, "run_profile");
  assert.equal(router.calls.length, 2);
  assert.equal(router.calls[1].messages.length, 3);
});

test("sealed capabilities reject model escalation and premature completion", async () => {
  for (const [response, expectedCode] of [
    [decision({ type: "write_text", path: "src/app.js", content: "x" }), "CODE_BRAIN_ACTION_NOT_PERMITTED"],
    [decision({ type: "complete", outcome: "done", evidence: [] }), "CODE_BRAIN_COMPLETION_NOT_READY"],
  ]) {
    const router = fakeRouter([response]);
    const directory = new CodeJobBrainDirectory({
      brainRouter: router.port,
      roles: roleBrain(),
    });
    await assert.rejects(
      directory.decide(input({
        capabilities: {
          ...input().capabilities,
          allowedActions: ["read_text", "complete"],
        },
      })),
      (error) =>
        error instanceof CodeJobBrainDirectoryError && error.code === expectedCode,
    );
    assert.equal(router.calls.length, 2);
  }
});

test("remote brains require explicit requirements and code authorization", async () => {
  const providerCalls = [];
  const router = new BrainRouter({
    providers: [
      {
        id: "brain-one",
        remote: true,
        async generate(value) {
          providerCalls.push(structuredClone(value));
          return decision();
        },
      },
    ],
  });
  const denied = new CodeJobBrainDirectory({
    brainRouter: router,
    roles: roleBrain(),
  });
  await assert.rejects(
    denied.decide(input()),
    (error) => error?.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(providerCalls.length, 0);

  const allowed = new CodeJobBrainDirectory({
    brainRouter: router,
    roles: roleBrain({ requirements: true, code: true, memory: false }),
  });
  assert.equal((await allowed.decide(input())).action.type, "read_text");
  assert.equal(providerCalls.length, 1);
});

test("unknown roles and malformed untrusted context fail before generation", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });
  await assert.rejects(
    directory.decide(input({ roleId: "tester" })),
    (error) => error?.code === "CODE_BRAIN_ROLE_NOT_CONFIGURED",
  );
  await assert.rejects(
    directory.decide(input({
      observations: [
        { actionType: "read_text", status: "succeeded", detail: "bad\u0000" },
      ],
    })),
    TypeError,
  );
  assert.equal(router.calls.length, 0);
});

test("describe returns a detached provider view for the configured role", () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });
  const first = directory.describe("developer");
  first.model = "changed";
  assert.equal(directory.describe("developer").model, "qwen3.5:9b");
});
