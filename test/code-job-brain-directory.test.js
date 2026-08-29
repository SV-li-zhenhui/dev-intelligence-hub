import assert from "node:assert/strict";
import test from "node:test";
import {
  CodeJobBrainDirectory,
  CodeJobBrainDirectoryError,
  createConfiguredCodeJobBrainDirectory,
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
      brain: {
        provider: "routine-brain",
        model: "qwen3.5:9b",
        remoteData: {
          requirements: false,
          code: false,
          memory: false,
        },
      },
      taskBrain: { provider: "brain-one", model: "code-model", remoteData },
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

function authorized(callback = async () => {}) {
  return { beforeGenerate: callback };
}

test("a role brain receives only bounded semantic code context", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });

  assert.deepEqual(
    await directory.decide(input(), authorized()),
    JSON.parse(decision()),
  );
  assert.equal(router.calls.length, 1);
  assert.deepEqual(router.calls[0].dataClasses, ["requirements", "code"]);
  assert.equal(router.calls[0].brain.model, "code-model");
  assert.equal(router.calls[0].brain.provider, "brain-one");
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

test("a code task forwards its stable GitHub entity session key", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });
  const sessionKey = "github:issue:acme/widgets#17";

  await directory.decide(input({ sessionKey }), authorized());

  assert.equal(router.calls.length, 1);
  assert.equal(router.calls[0].sessionKey, sessionKey);
});

test("one invalid model response gets exactly one local correction attempt", async () => {
  const router = fakeRouter(["not json", decision({ type: "run_profile" })]);
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });

  assert.equal(
    (await directory.decide(input(), authorized())).action.type,
    "run_profile",
  );
  assert.equal(router.calls.length, 2);
  assert.equal(router.calls[1].messages.length, 3);
});

test("a supervised CLI task brain fails locally without a correction process", async () => {
  const calls = [];
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      async generate(value) {
        calls.push(structuredClone(value));
        return "invalid CLI output";
      },
      describe(config) {
        return {
          provider: config.provider,
          model: config.model,
          remote: true,
          remoteData: structuredClone(config.remoteData),
          singleAttempt: true,
        };
      },
    },
    roles: roleBrain({ requirements: true, code: true, memory: false }),
  });

  await assert.rejects(
    directory.decide(input(), authorized()),
    (error) => error?.code === "CODE_BRAIN_RESPONSE_INVALID",
  );
  assert.equal(calls.length, 1);
});

test("authority is rechecked before a local correction reaches the provider", async () => {
  const router = fakeRouter(["not json", decision({ type: "run_profile" })]);
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });
  const revoked = Object.assign(new Error("revoked before correction"), {
    code: "INVALID_CODE_JOB_AUTHORITY",
  });
  let checks = 0;

  await assert.rejects(
    directory.decide(
      input(),
      authorized(async () => {
        checks += 1;
        if (checks === 2) throw revoked;
      }),
    ),
    (error) => error === revoked,
  );

  assert.equal(checks, 2);
  assert.equal(router.calls.length, 1);
});

test("generation fails closed without a trusted authorization callback", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });

  await assert.rejects(directory.decide(input()), TypeError);
  assert.equal(router.calls.length, 0);
});

test("authorization accessors are rejected without executing getters", async () => {
  for (const accessorName of [
    "beforeGenerate",
    "brainDigest",
    "admitGenerate",
  ]) {
    const router = fakeRouter();
    const directory = new CodeJobBrainDirectory({
      brainRouter: router.port,
      roles: roleBrain(),
    });
    const authorization = {
      beforeGenerate: async () => {},
      brainDigest: "a".repeat(64),
      admitGenerate: async (operation) => operation(),
    };
    let getterReads = 0;
    Object.defineProperty(authorization, accessorName, {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(`${accessorName} getter must not run`);
      },
    });

    await assert.rejects(
      directory.decide(input(), authorization),
      TypeError,
    );
    assert.equal(getterReads, 0, accessorName);
    assert.equal(router.calls.length, 0, accessorName);
  }
});

test("admission wraps every provider request without awaiting its response", async () => {
  const requests = [];
  let insideAdmission = false;
  let admissions = 0;
  let admissionExits = 0;
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      generate(value) {
        assert.equal(insideAdmission, true);
        let resolve;
        const response = new Promise((resolveResponse) => {
          resolve = resolveResponse;
        });
        requests.push({ value: structuredClone(value), resolve });
        return response;
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
    roles: roleBrain(),
  });
  const result = directory.decide(input(), {
    beforeGenerate: async () => {},
    admitGenerate: async (operation) => {
      admissions += 1;
      insideAdmission = true;
      try {
        return await operation();
      } finally {
        insideAdmission = false;
        admissionExits += 1;
      }
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(admissions, 1);
  assert.equal(admissionExits, 1);
  assert.equal(insideAdmission, false);

  requests[0].resolve("not json");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(admissions, 2);
  assert.equal(admissionExits, 2);
  assert.equal(insideAdmission, false);

  requests[1].resolve(decision({ type: "run_profile" }));
  assert.equal((await result).action.type, "run_profile");
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
      directory.decide(
        input({
          capabilities: {
            ...input().capabilities,
            allowedActions: ["read_text", "complete"],
          },
        }),
        authorized(),
      ),
      (error) =>
        error instanceof CodeJobBrainDirectoryError &&
        error.code === "CODE_BRAIN_RESPONSE_INVALID" &&
        error.cause?.code === expectedCode,
    );
    assert.equal(router.calls.length, 2);
  }
});

test("the host rejects repeated profile runs after all checks pass", async () => {
  const router = fakeRouter([decision({ type: "run_profile" })]);
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });

  await assert.rejects(
    directory.decide(
      input({
        capabilities: {
          ...input().capabilities,
          requiredProfilesRemaining: 0,
        },
      }),
      authorized(),
    ),
    (error) =>
      error instanceof CodeJobBrainDirectoryError &&
      error.code === "CODE_BRAIN_RESPONSE_INVALID" &&
      error.cause?.code === "CODE_BRAIN_CHECKS_ALREADY_PASSED",
  );
  assert.equal(router.calls.length, 2);
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
    denied.decide(input(), authorized()),
    (error) => error?.code === "REMOTE_DATA_NOT_AUTHORIZED",
  );
  assert.equal(providerCalls.length, 0);

  const allowed = new CodeJobBrainDirectory({
    brainRouter: router,
    roles: roleBrain({ requirements: true, code: true, memory: false }),
  });
  assert.equal(
    (await allowed.decide(input(), authorized())).action.type,
    "read_text",
  );
  assert.equal(providerCalls.length, 1);
});

test("unknown roles and malformed untrusted context fail before generation", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });
  await assert.rejects(
    directory.decide(input({ roleId: "tester" }), authorized()),
    (error) => error?.code === "CODE_BRAIN_ROLE_NOT_CONFIGURED",
  );
  await assert.rejects(
    directory.decide(
      input({
        observations: [
          { actionType: "read_text", status: "succeeded", detail: "bad\u0000" },
        ],
      }),
      authorized(),
    ),
    TypeError,
  );
  assert.equal(router.calls.length, 0);
});

test("a configured routine brain never substitutes for a missing task brain", async () => {
  for (const taskBrain of [undefined, null]) {
    const router = fakeRouter();
    const directory = new CodeJobBrainDirectory({
      brainRouter: router.port,
      roles: {
        developer: {
          name: "Developer",
          brain: {
            provider: "routine-brain",
            model: "qwen3.5:9b",
            remoteData: {
              requirements: false,
              code: false,
              memory: false,
            },
          },
          ...(taskBrain === undefined ? {} : { taskBrain }),
        },
      },
    });

    await assert.rejects(
      directory.decide(input(), authorized()),
      (error) =>
        error instanceof CodeJobBrainDirectoryError &&
        error.code === "CODE_TASK_BRAIN_NOT_CONFIGURED",
    );
    assert.equal(router.calls.length, 0);
    assert.throws(
      () => directory.describe("developer"),
      (error) => error?.code === "CODE_TASK_BRAIN_NOT_CONFIGURED",
    );
  }
});

test("oversize observation history is packed once before generation", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });
  const observations = Array.from({ length: 8 }, (_, index) => ({
    actionType: "read_text",
    status: "succeeded",
    detail: JSON.stringify({
      path: `src/file-${index}.js`,
      content: `${index}-${"x".repeat(30_000)}`,
    }),
  }));

  await directory.decide(input({ observations, turn: 9 }), authorized());

  assert.equal(router.calls.length, 1);
  const packed = JSON.parse(router.calls[0].messages[1].content);
  assert.ok(Buffer.byteLength(JSON.stringify(packed), "utf8") <= 128 * 1024);
  assert.equal(packed.observations.at(-1).detail, observations.at(-1).detail);
  assert.equal(
    packed.observations.slice(0, -1).every((entry) =>
      JSON.parse(entry.detail).compacted === true),
    true,
  );
});

test("unfit fixed context never reaches the provider", async () => {
  const router = fakeRouter();
  const directory = new CodeJobBrainDirectory({
    brainRouter: router.port,
    roles: roleBrain(),
  });
  const largeEntries = Array.from(
    { length: 40 },
    (_, index) => `${index}-${"x".repeat(1_800)}`,
  );

  await assert.rejects(
    directory.decide(
      input({
        task: {
          ...input().task,
          acceptanceCriteria: largeEntries,
          evidence: largeEntries.map((entry) => `evidence-${entry}`),
        },
      }),
      authorized(),
    ),
    (error) => error.code === "CODE_BRAIN_CONTEXT_UNFIT",
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
  assert.equal(directory.describe("developer").model, "code-model");
});

test("directory close fences decisions, coalesces, and retries only an unresolved router", async () => {
  const closeFailure = new Error("router close failed once");
  let rejectFirstClose;
  const firstRouterClose = new Promise((_, reject) => {
    rejectFirstClose = reject;
  });
  let closeAttempts = 0;
  let generateCalls = 0;
  const directory = new CodeJobBrainDirectory({
    brainRouter: {
      async generate() {
        generateCalls += 1;
        return decision();
      },
      describe(brain) {
        return {
          provider: brain.provider,
          model: brain.model,
          remote: false,
          remoteData: brain.remoteData,
        };
      },
      close() {
        closeAttempts += 1;
        return closeAttempts === 1 ? firstRouterClose : Promise.resolve();
      },
    },
    roles: roleBrain(),
  });

  const firstClose = directory.close();
  assert.strictEqual(directory.close(), firstClose);
  await assert.rejects(
    directory.decide(input(), authorized()),
    (error) => error?.code === "CODE_BRAIN_DIRECTORY_CLOSED",
  );
  assert.equal(generateCalls, 0);

  const observedFailure = assert.rejects(
    firstClose,
    (error) => error === closeFailure,
  );
  rejectFirstClose(closeFailure);
  await observedFailure;

  const retry = directory.close();
  assert.strictEqual(directory.close(), retry);
  await retry;
  await directory.close();
  assert.equal(closeAttempts, 2);
});

test("configured directory rejects forged cleanup ownership before router construction", () => {
  assert.throws(
    () => createConfiguredCodeJobBrainDirectory({
      constructionCleanupOwner: Object.freeze({}),
    }),
    /construction cleanup owner.*invalid/i,
  );
});

test("configured directory snapshots one-shot role input only once", async () => {
  const repeatedRead = new Error("configured roles were read more than once");
  const configuredRoles = roleBrain();
  let roleReads = 0;
  let rolesReads = 0;
  configuredRoles.developer = new Proxy(configuredRoles.developer, {
    ownKeys(target) {
      roleReads += 1;
      if (roleReads > 1) throw repeatedRead;
      return Reflect.ownKeys(target);
    },
  });
  const roles = new Proxy(configuredRoles, {
    ownKeys(target) {
      rolesReads += 1;
      if (rolesReads > 1) throw repeatedRead;
      return Reflect.ownKeys(target);
    },
  });

  const directory = createConfiguredCodeJobBrainDirectory({ roles });

  assert.equal(rolesReads, 1);
  assert.equal(roleReads, 1);
  await directory.close();
});
