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

test("committed privileged capabilities are disabled and secret-free", async () => {
  const configPath = path.resolve(testDirectory, "../config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));

  assert.deepEqual(config.codeExecutor, { enabled: false });
  assert.deepEqual(config.githubActions, { enabled: false });
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
