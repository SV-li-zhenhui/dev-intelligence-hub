import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "../src/lib/config.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test("local provider settings merge without erasing base defaults", () => {
  const result = mergeConfig(
    {
      dingtalk: { enabled: true, maxNotificationsPerRun: 5 },
      brain: {
        enabled: true,
        provider: "ollama",
        model: "qwen3.5:9b",
        contextTokens: 8192,
      },
      prResponsibility: { historicalAfterDays: 60 },
      employees: {
        prReviewer: {
          enabled: true,
          maxJobsPerTick: 2,
          brain: { timeoutMs: 45_000 },
        },
      },
    },
    {
      dingtalk: { enabled: false },
      brain: { model: "another-model" },
      prResponsibility: { historicalAfterDays: 30 },
      employees: {
        prReviewer: {
          maxJobsPerTick: 1,
          brain: { model: "employee-model" },
        },
      },
    },
  );

  assert.deepEqual(result.dingtalk, {
    enabled: false,
    maxNotificationsPerRun: 5,
  });
  assert.equal(result.brain.enabled, true);
  assert.equal(result.brain.model, "another-model");
  assert.equal(result.brain.contextTokens, 8192);
  assert.equal(result.prResponsibility.historicalAfterDays, 30);
  assert.deepEqual(result.employees.prReviewer, {
    enabled: true,
    maxJobsPerTick: 1,
    brain: { timeoutMs: 45_000, model: "employee-model" },
  });
});

test("configured brains and role permissions merge independently by id", () => {
  const result = mergeConfig(
    {
      brainProviders: {
        ollama: {
          kind: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          timeoutMs: 45_000,
        },
      },
      employees: {
        roles: {
          developer: {
            name: "开发工程师",
            enabled: true,
            permissions: { allowedIntents: ["ask_user", "complete"] },
            brain: {
              provider: "ollama",
              model: "qwen3.5:9b",
              remoteData: {
                requirements: false,
                code: false,
                memory: false,
              },
            },
          },
        },
      },
    },
    {
      brainProviders: { ollama: { timeoutMs: 60_000 } },
      employees: {
        roles: {
          developer: {
            brain: { remoteData: { memory: true } },
          },
          tester: { name: "测试工程师" },
        },
      },
    },
  );

  assert.deepEqual(result.brainProviders.ollama, {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    timeoutMs: 60_000,
  });
  assert.deepEqual(result.employees.roles.developer, {
    name: "开发工程师",
    enabled: true,
    permissions: { allowedIntents: ["ask_user", "complete"] },
    brain: {
      provider: "ollama",
      model: "qwen3.5:9b",
      remoteData: {
        requirements: false,
        code: false,
        memory: true,
      },
    },
  });
  assert.deepEqual(result.employees.roles.tester, { name: "测试工程师" });
});

test("GitHub action settings merge without storing a credential value", () => {
  const result = mergeConfig(
    {
      githubActions: {
        enabled: false,
        actorAccountId: "",
        tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
        networkEnv: { NO_PROXY: "github.com" },
      },
    },
    {
      githubActions: {
        enabled: true,
        actorAccountId: "review-account",
        ghCommand: "C:\\Program Files\\GitHub CLI\\gh.exe",
        networkEnv: { HTTPS_PROXY: "http://127.0.0.1:8080" },
      },
    },
  );

  assert.deepEqual(result.githubActions, {
    enabled: true,
    actorAccountId: "review-account",
    tokenEnv: "MYDASHBOARD_GITHUB_TOKEN",
    ghCommand: "C:\\Program Files\\GitHub CLI\\gh.exe",
    networkEnv: {
      NO_PROXY: "github.com",
      HTTPS_PROXY: "http://127.0.0.1:8080",
    },
  });
  assert.equal("token" in result.githubActions, false);
});

test("workflow routing is replaced as one versioned definition", () => {
  const base = {
    workflowRouting: {
      schemaVersion: 1,
      enabled: true,
      maxHops: 8,
      rules: [{ id: "base-rule" }],
    },
  };
  const localDefinition = {
    schemaVersion: 1,
    enabled: false,
    maxHops: 4,
    rules: [],
  };

  const result = mergeConfig(base, { workflowRouting: localDefinition });

  assert.deepEqual(result.workflowRouting, localDefinition);
  assert.equal(result.workflowRouting.rules.some((rule) => rule.id === "base-rule"), false);
});

test("code executor settings merge nested sections independently", () => {
  const baseWorkspaces = [
    { id: "dashboard", sourceRoot: "dashboard" },
  ];
  const localWorkspaces = [
    { id: "product", sourceRoot: "product" },
  ];
  const result = mergeConfig(
    {
      codeExecutor: {
        enabled: false,
        docker: {
          executable: "base-docker",
          host: "npipe:////./pipe/dockerDesktopLinuxEngine",
        },
        workspaces: baseWorkspaces,
        profiles: {
          "node-tests": { kind: "node-test", timeoutMs: 30_000 },
          "fast-tests": { kind: "node-test", timeoutMs: 10_000 },
        },
        requiredProfilesByWorkspace: {
          dashboard: ["node-tests"],
          product: ["fast-tests"],
        },
        brokerLimits: { maxFiles: 5_000, maxFileBytes: 2_000_000 },
        executorLimits: { maxSessions: 10, maxActionsPerSession: 100 },
        maxArtifactBytes: 1_000_000,
      },
    },
    {
      codeExecutor: {
        enabled: true,
        docker: { executable: "podman" },
        workspaces: localWorkspaces,
        profiles: {
          "fast-tests": { kind: "node-test", timeoutMs: 15_000 },
        },
        requiredProfilesByWorkspace: { product: ["fast-tests"] },
        brokerLimits: { maxFiles: 4_000 },
        executorLimits: { maxSessions: 20 },
        maxArtifactBytes: 2_000_000,
      },
    },
  );

  assert.deepEqual(result.codeExecutor, {
    enabled: true,
    docker: {
      executable: "podman",
      host: "npipe:////./pipe/dockerDesktopLinuxEngine",
    },
    workspaces: localWorkspaces,
    profiles: {
      "node-tests": { kind: "node-test", timeoutMs: 30_000 },
      "fast-tests": { kind: "node-test", timeoutMs: 15_000 },
    },
    requiredProfilesByWorkspace: {
      product: ["fast-tests"],
    },
    brokerLimits: { maxFiles: 4_000, maxFileBytes: 2_000_000 },
    executorLimits: { maxSessions: 20, maxActionsPerSession: 100 },
    maxArtifactBytes: 2_000_000,
  });
  assert.strictEqual(result.codeExecutor.workspaces, localWorkspaces);
});

test("replacing workspaces also replaces their profile bindings", () => {
  const result = mergeConfig(
    {
      codeExecutor: {
        workspaces: [{ id: "dashboard", sourceRoot: "dashboard" }],
        requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
      },
    },
    {
      codeExecutor: {
        workspaces: [{ id: "product", sourceRoot: "product" }],
      },
    },
  );

  assert.deepEqual(result.codeExecutor.requiredProfilesByWorkspace, {});
});

test("code executor overrides preserve unspecified base defaults", () => {
  const base = {
    codeExecutor: {
      enabled: false,
      docker: {
        executable: "docker",
        host: "npipe:////./pipe/dockerDesktopLinuxEngine",
      },
      workspaces: [{ id: "dashboard", sourceRoot: "base-path" }],
      profiles: { "node-tests": { timeoutMs: 30_000 } },
      requiredProfilesByWorkspace: { dashboard: ["node-tests"] },
      brokerLimits: { maxFiles: 2_000 },
      executorLimits: { maxSessions: 10 },
      maxArtifactBytes: 1_000_000,
    },
  };

  assert.deepEqual(
    mergeConfig(base, { codeExecutor: { enabled: true } }).codeExecutor,
    {
      ...base.codeExecutor,
      enabled: true,
    },
  );
});

test("work coordination overrides merge trusted policy maps without losing defaults", () => {
  const result = mergeConfig(
    {
      workCoordination: {
        enabled: true,
        workLimit: 20,
        policy: {
          version: 1,
          capabilityRoles: {
            requirements: "requirements-analyst",
            testing: "tester",
          },
          githubReviewRoles: ["pr-reviewer"],
          workspaceByRepository: {
            "acme/base": "base-workspace",
          },
          codeOperationsByRole: {
            developer: ["inspect", "modify", "verify"],
          },
        },
      },
    },
    {
      workCoordination: {
        workLimit: 5,
        policy: {
          capabilityRoles: { testing: "qa-specialist" },
          workspaceByRepository: {
            "acme/local": "local-workspace",
          },
          codeOperationsByRole: {
            tester: ["inspect", "verify"],
          },
        },
      },
    },
  );

  assert.deepEqual(result.workCoordination, {
    enabled: true,
    workLimit: 5,
    policy: {
      version: 1,
      capabilityRoles: {
        requirements: "requirements-analyst",
        testing: "qa-specialist",
      },
      githubReviewRoles: ["pr-reviewer"],
      workspaceByRepository: {
        "acme/base": "base-workspace",
        "acme/local": "local-workspace",
      },
      codeOperationsByRole: {
        developer: ["inspect", "modify", "verify"],
        tester: ["inspect", "verify"],
      },
    },
  });
});

test("memory overrides preserve local capacity defaults", () => {
  const result = mergeConfig(
    {
      memory: {
        enabled: true,
        maximumRecords: 20_000,
        maximumStateBytes: 64 * 1024 * 1024,
      },
    },
    { memory: { maximumRecords: 5_000 } },
  );

  assert.deepEqual(result.memory, {
    enabled: true,
    maximumRecords: 5_000,
    maximumStateBytes: 64 * 1024 * 1024,
  });
});

test("committed privileged capabilities are disabled and secret-free", async () => {
  const configPath = path.resolve(testDirectory, "../config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.deepEqual(config.codeExecutor, { enabled: false });
  assert.deepEqual(config.githubActions, { enabled: false });
  assert.equal(config.memory.enabled, true);
  const absolutePaths = Object.values(config.codeExecutor).filter(
    (value) =>
      typeof value === "string" &&
      (path.isAbsolute(value) ||
        path.posix.isAbsolute(value) ||
        path.win32.isAbsolute(value)),
  );
  assert.deepEqual(absolutePaths, []);
  assert.equal(JSON.stringify(config.githubActions).toLowerCase().includes("token"), false);
});

test("committed command-center roles route PR work to the durable PR engineer", async () => {
  const configPath = path.resolve(testDirectory, "../config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.deepEqual(Object.keys(config.employees.roles), [
    "pr-engineer",
    "orchestrator",
    "requirements-analyst",
    "developer",
    "tester",
  ]);
  assert.equal(
    config.workflowRouting.rules.find(({ id }) =>
      id === "pr-events-to-pr-engineer"
    ).targets[0].id,
    "pr-engineer",
  );
  assert.deepEqual(config.workCoordination.policy.githubReviewRoles, [
    "pr-engineer",
  ]);
  assert.deepEqual(config.workCoordination.policy.codeOperationsByRole, {
    developer: ["inspect", "modify", "verify"],
    tester: ["inspect", "verify"],
  });
  assert.equal(config.workCoordination.codeJobLimit, 10);
  assert.equal(config.workCoordination.codeJobMemoryLimit, 50);
  assert.equal(
    config.employees.roles["pr-engineer"].permissions.allowedIntents.includes(
      "propose_github_review",
    ),
    true,
  );
  assert.equal(
    Object.values(config.employees.roles).every(({ initialPaused }) =>
      initialPaused === true
    ),
    true,
  );
});
