import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { validationBrowserLaunchOptions } from
  "../../scripts/playwright-validation-options.mjs";

const publicDirectory = path.resolve("public");
const baseConfiguration = JSON.parse(
  await readFile("config.example.json", "utf8"),
);
baseConfiguration.trackedRepositories = [
  "fixture/existing-application",
  "fixture/existing-service",
];
baseConfiguration.memory.answering.brain = structuredClone(
  baseConfiguration.employees.roles.developer.brain,
);
baseConfiguration.memory.answering.localBrain = structuredClone(
  baseConfiguration.employees.roles.developer.brain,
);
const ACTIVE_DIGEST = "a".repeat(64);
const DOCUMENT_DIGEST = "b".repeat(64);
const VALIDATION_DIGEST = "c".repeat(64);
const IMPACT_DIGEST = "d".repeat(64);

let serverConfiguration = structuredClone(baseConfiguration);
let stateRevision = 1;
let draftRevision = 0;
let draftExists = false;
let staleNextWrite = false;
let attentionAvailable = false;
let failNextConfigurationRead = false;
const draftWrites = [];
const staleWrites = [];
const previewRequests = [];
const confirmationRequests = [];
const apiRequests = [];

function json(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

async function requestJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new Error("fixture request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function dashboardFixture() {
  return {
    meta: {
      refreshedAt: "2026-08-06T01:00:00.000Z",
      durationMs: 1,
      sources: { github: 0, dingtalk: 0 },
      errors: [],
      brain: { enabled: false, errors: [] },
    },
    counts: {
      actionNow: 0,
      waitingOther: 0,
      uncertainPullRequests: 0,
      issues: 0,
    },
    groups: {
      actionNow: [],
      waitingOther: [],
      uncertainPullRequests: [],
      historicalPullRequests: [],
      reviewRequested: [],
      myPullRequests: [],
      myIssues: [],
      versions: [],
      dingtalk: [],
    },
    employee: null,
  };
}

function draftFixture() {
  return {
    draftId: "draft-1",
    revision: draftRevision,
    baseVersion: 1,
    configurationDigest: DOCUMENT_DIGEST,
    createdAt: "2026-08-06T01:01:00.000Z",
    configuration: structuredClone(serverConfiguration),
  };
}

function configurationFixture() {
  return {
    status: {
      safeMode: false,
      runtimeMode: "ready",
      stateRevision,
      activeVersion: 1,
      migrationError: null,
    },
    storedActive: { version: 1, configurationDigest: ACTIVE_DIGEST },
    runtimeEffective: {
      activeVersion: 1,
      configurationDigest: ACTIVE_DIGEST,
    },
    pendingRestart: false,
    editableConfiguration: structuredClone(serverConfiguration),
    drafts: draftExists ? [draftFixture()] : [],
    versions: [
      {
        version: 1,
        source: "bootstrap",
        configurationDigest: ACTIVE_DIGEST,
        activatedAt: "2026-08-06T01:00:00.000Z",
      },
    ],
    audit: [],
    history: {
      totalVersions: 1,
      totalAuditEntries: 0,
      versionsTruncated: false,
      auditTruncated: false,
    },
  };
}

function previewFixture() {
  return {
    kind: "configuration.activate",
    expectedStateRevision: stateRevision,
    expectedActiveVersion: 1,
    draftId: "draft-1",
    draftRevision,
    documentDigest: DOCUMENT_DIGEST,
    validationDigest: VALIDATION_DIGEST,
    impactDigest: IMPACT_DIGEST,
    impact: { benign_claim_change: ["refreshMinutes"] },
  };
}

function confirmationFixture() {
  return {
    id: "configuration-confirmation-1",
    kind: "local.configuration-activate",
    queueRevision: 4,
    itemRevision: 1,
    displayedPayloadDigest: "e".repeat(64),
    approvalBindingDigest: "f".repeat(64),
    retryable: false,
    requestedBy: {
      roleId: "configuration-owner",
      workItemId: "configuration-draft-1",
    },
    display: {
      title: "确认配置草稿",
      summary: "确认后保存当前摘要绑定的配置版本",
      actionLabel: "确认并激活配置",
      evidence: ["结构化配置浏览器测试"],
      payload: {
        actor: { accountId: "owner:local" },
        target: { resourceId: "configuration", version: `${stateRevision}` },
        action: {
          type: "activate_draft",
          expectedStateRevision: stateRevision,
          expectedActiveVersion: 1,
          draftId: "draft-1",
          draftRevision,
          documentDigest: DOCUMENT_DIGEST,
          validationDigest: VALIDATION_DIGEST,
          impactDigest: IMPACT_DIGEST,
        },
        impact: { benign_claim_change: ["refreshMinutes"] },
      },
    },
  };
}

function safeStaticPath(pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const resolved = path.resolve(publicDirectory, relative);
  if (
    resolved !== path.join(publicDirectory, "index.html") &&
    !resolved.startsWith(`${publicDirectory}${path.sep}`)
  ) {
    return null;
  }
  return resolved;
}

function contentType(file) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  }[path.extname(file)] || "application/octet-stream";
}

function createFixtureServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        apiRequests.push({ method: request.method, path: url.pathname });
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        json(response, 200, dashboardFixture());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/employees") {
        json(response, 200, { items: [] });
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/brain-providers/status"
      ) {
        json(response, 200, {
          schemaVersion: 1,
          state: "available",
          cliAvailable: true,
          fileLoginAvailable: true,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/system/status") {
        json(response, 200, {
          liveness: { schemaVersion: 1, live: true },
          readiness: {
            schemaVersion: 1,
            checkedAt: "2026-08-12T00:00:00.000Z",
            ready: true,
            recoveryBlockers: [],
            unknownExternalActions: [],
            capacityWarnings: [],
            probeFailures: [],
            probeSummary: { total: 3, succeeded: 3, failed: 0, timedOut: 0 },
          },
          maintenance: { mode: "open", activeOperations: 0 },
          backups: { available: true, items: [] },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/attention/next") {
        if (attentionAvailable) {
          attentionAvailable = false;
          json(response, 200, {
            available: true,
            source: "external_confirmation",
            pendingCount: 1,
            externalEnabled: true,
            externalQueueRevision: 4,
            item: confirmationFixture(),
          });
        } else {
          json(response, 200, {
            available: false,
            source: null,
            pendingCount: 0,
            externalEnabled: true,
            externalQueueRevision: 4,
            item: null,
          });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/configuration") {
        if (failNextConfigurationRead) {
          failNextConfigurationRead = false;
          response.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "x-fixture-invalid-json": "1",
          });
          response.end("{");
          return;
        }
        json(response, 200, configurationFixture());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/configuration/drafts") {
        const body = await requestJson(request);
        draftWrites.push({ body, actionHeader: request.headers["x-mydashboard-action"] });
        serverConfiguration = structuredClone(body.configuration);
        stateRevision += 1;
        draftRevision = 1;
        draftExists = true;
        json(response, 201, { draft: draftFixture() });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/configuration/drafts/draft-1") {
        const body = await requestJson(request);
        if (staleNextWrite) {
          staleNextWrite = false;
          staleWrites.push({ body, actionHeader: request.headers["x-mydashboard-action"] });
          serverConfiguration = {
            ...serverConfiguration,
            refreshMinutes: 99,
          };
          stateRevision += 1;
          draftRevision += 1;
          json(response, 409, { error: "fixture configuration changed" });
          return;
        }
        draftWrites.push({ body, actionHeader: request.headers["x-mydashboard-action"] });
        serverConfiguration = structuredClone(body.configuration);
        stateRevision += 1;
        draftRevision += 1;
        json(response, 200, { draft: draftFixture() });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/configuration/drafts/draft-1/preview"
      ) {
        previewRequests.push({
          body: await requestJson(request),
          actionHeader: request.headers["x-mydashboard-action"],
        });
        json(response, 200, previewFixture());
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/configuration/drafts/draft-1/request-confirmation"
      ) {
        confirmationRequests.push({
          body: await requestJson(request),
          actionHeader: request.headers["x-mydashboard-action"],
        });
        attentionAvailable = true;
        json(response, 201, { request: { id: "configuration-request-1" } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/fixture/stale-next-write") {
        staleNextWrite = true;
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "fixture route unavailable" });
        return;
      }
      const file = safeStaticPath(url.pathname);
      if (!file) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": contentType(file) });
      response.end(await readFile(file));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
}

async function launchBrowser() {
  return chromium.launch(validationBrowserLaunchOptions({ headless: true }));
}

function attributeLocator(page, attribute, pathValue) {
  return page.locator(`[${attribute}='${JSON.stringify(pathValue)}']`);
}

function field(page, pathValue) {
  return attributeLocator(page, "data-configuration-field", pathValue);
}

function templateField(container, pathValue) {
  return container.locator(
    `[data-configuration-template-field='${JSON.stringify(pathValue)}']`,
  );
}

async function openDetailsBySummary(page, name) {
  const summary = page.locator("summary").filter({ hasText: name });
  await summary.click();
  return summary.locator("xpath=..");
}

function captureBrowserErrors(page) {
  const messages = [];
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") messages.push(`console: ${message.text()}`);
  });
  return messages;
}

const server = createFixtureServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const browserErrors = captureBrowserErrors(page);
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator('[data-view="configuration"]').click();
  await page.locator("[data-configuration-structured-form]").waitFor();

  assert.equal(
    await page.locator(
      ".configuration-editor textarea:not([data-configuration-field]):not([data-configuration-template-field])",
    ).count(),
    0,
  );
  assert.ok(
    await page.locator(
      ".configuration-editor textarea[data-configuration-template-field]",
    ).count() >= 1,
  );

  let gitCommandTemplate = await openDetailsBySummary(
    page,
    "新增固定 Git 命令",
  );
  await templateField(
    gitCommandTemplate,
    ["codeExecutor", "gitCommand"],
  ).fill("C:/Program Files/Git/mingw64/bin/git.exe");
  await gitCommandTemplate
    .getByRole("button", { name: "新增固定 Git 命令" })
    .click();
  assert.equal(
    await field(page, ["codeExecutor", "gitCommand"]).inputValue(),
    "C:/Program Files/Git/mingw64/bin/git.exe",
  );
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.dataset?.configurationField,
    ),
    JSON.stringify(["codeExecutor", "gitCommand"]),
  );
  await page.getByRole("button", { name: "删除固定 Git 命令" }).click();
  assert.equal(await field(page, ["codeExecutor", "gitCommand"]).count(), 0);
  gitCommandTemplate = page
    .locator("summary")
    .filter({ hasText: "新增固定 Git 命令" });
  assert.equal(await gitCommandTemplate.count(), 1);
  assert.equal(
    await page.evaluate(
      () =>
        document.activeElement
          ?.closest("[data-configuration-template-value-root]")
          ?.dataset?.configurationTemplateValueRoot,
    ),
    JSON.stringify(["codeExecutor", "gitCommand"]),
  );

  const providerCollection = attributeLocator(
    page,
    "data-configuration-collection",
    ["brainProviders"],
  );
  const ollamaCard = attributeLocator(
    providerCollection,
    "data-configuration-entry",
    ["brainProviders", "ollama"],
  );
  await ollamaCard.getByRole("button", { name: "删除ollama" }).click();
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /无法删除.*brain\.provider/s,
  );
  assert.equal(await ollamaCard.count(), 1);

  const refreshField = field(page, ["refreshMinutes"]);
  await refreshField.fill("");
  await page.locator("[data-configuration-submit]").click();
  assert.equal(await refreshField.inputValue(), "");
  assert.equal(await refreshField.getAttribute("aria-invalid"), "true");
  assert.match(await refreshField.getAttribute("aria-describedby"), /^configuration-error-/);
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset?.configurationField),
    JSON.stringify(["refreshMinutes"]),
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /1 个配置问题/,
  );
  await refreshField.fill("17");
  assert.equal(await refreshField.getAttribute("aria-invalid"), null);
  assert.equal(await refreshField.getAttribute("aria-describedby"), null);
  assert.equal(await page.locator("#configuration-form-status").textContent(), "");

  const providerTemplate = await openDetailsBySummary(page, "新增大脑 Provider");
  const providerTemplateKey = providerTemplate.locator(
    "[data-configuration-template-key]",
  );
  const providerBaseUrl = templateField(
    providerTemplate,
    ["brainProviders", "new-provider", "baseUrl"],
  );
  await providerTemplateKey.fill("remote.in-progress");
  await providerBaseUrl.fill("https://draft.example.invalid/v1");
  await providerBaseUrl.focus();
  await providerBaseUrl.evaluate((control) => control.setSelectionRange(8, 13));
  failNextConfigurationRead = true;
  const failedBackgroundConfigurationRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/configuration" &&
      response.headers()["x-fixture-invalid-json"] === "1",
  );
  await page.evaluate(() => document.querySelector("#refresh-button").click());
  await failedBackgroundConfigurationRead;
  await page.waitForFunction(
    () => document.querySelector("#refresh-button")?.disabled === false,
  );
  assert.equal(await providerTemplate.evaluate((details) => details.open), true);
  assert.equal(await providerTemplateKey.inputValue(), "remote.in-progress");
  assert.equal(
    await providerBaseUrl.inputValue(),
    "https://draft.example.invalid/v1",
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      path: document.activeElement?.dataset?.configurationTemplateField,
      start: document.activeElement?.selectionStart,
      end: document.activeElement?.selectionEnd,
    })),
    {
      path: JSON.stringify(["brainProviders", "new-provider", "baseUrl"]),
      start: 8,
      end: 13,
    },
  );
  const recoveredBackgroundConfigurationRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/configuration" &&
      response.status() === 200,
  );
  await page.evaluate(() => document.querySelector("#refresh-button").click());
  await recoveredBackgroundConfigurationRead;
  await page.waitForFunction(
    () => document.querySelector("#refresh-button")?.disabled === false,
  );
  assert.equal(await providerTemplate.evaluate((details) => details.open), true);
  assert.equal(await providerTemplateKey.inputValue(), "remote.in-progress");
  assert.equal(
    await providerBaseUrl.inputValue(),
    "https://draft.example.invalid/v1",
  );
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.dataset?.configurationTemplateField,
    ),
    JSON.stringify(["brainProviders", "new-provider", "baseUrl"]),
  );
  await providerTemplateKey.fill("remote.fixture");
  await providerBaseUrl.fill("https://models.example.invalid/v1");
  assert.equal(
    await templateField(
      providerTemplate,
      ["brainProviders", "new-provider", "protocol"],
    ).inputValue(),
    "chat-completions",
  );
  assert.equal(
    await templateField(
      providerTemplate,
      ["brainProviders", "new-provider", "apiKeyEnv"],
    ).count(),
    1,
  );
  assert.equal(
    await templateField(
      providerTemplate,
      ["brainProviders", "new-provider", "contextTokens"],
    ).count(),
    0,
  );
  await providerTemplate.getByRole("button", { name: "新增大脑 Provider" }).click();
  assert.equal(
    await page.evaluate(() =>
      document.activeElement
        ?.closest("[data-configuration-entry]")
        ?.dataset?.configurationEntry),
    JSON.stringify(["brainProviders", "remote.fixture"]),
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /已新增/,
  );
  assert.equal(
    await page.locator("#configuration-form-status").evaluate(
      (status) => status.classList.contains("configuration-success"),
    ),
    true,
  );
  const remoteProviderCard = attributeLocator(
    page,
    "data-configuration-entry",
    ["brainProviders", "remote.fixture"],
  );
  const remoteProviderReplacement = await openDetailsBySummary(
    remoteProviderCard,
    "替换remote.fixture",
  );
  await remoteProviderReplacement
    .getByRole("button", { name: "替换remote.fixture" })
    .click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset?.configurationField),
    JSON.stringify(["brainProviders", "remote.fixture", "kind"]),
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /已替换/,
  );

  const responsesTemplate = await openDetailsBySummary(
    page,
    "新增Responses / Codex API 大脑",
  );
  const responsesTemplateKey = responsesTemplate.locator(
    "[data-configuration-template-key]",
  );
  await responsesTemplateKey.fill("codex.fixture");
  assert.equal(
    await templateField(
      responsesTemplate,
      ["brainProviders", "codex-api", "baseUrl"],
    ).inputValue(),
    "https://api.openai.com/v1",
  );
  assert.equal(
    await templateField(
      responsesTemplate,
      ["brainProviders", "codex-api", "protocol"],
    ).inputValue(),
    "responses",
  );
  await responsesTemplate
    .getByRole("button", { name: "新增Responses / Codex API 大脑" })
    .click();
  const responsesProviderCard = attributeLocator(
    page,
    "data-configuration-entry",
    ["brainProviders", "codex.fixture"],
  );
  assert.equal(
    await field(page, ["brainProviders", "codex.fixture", "kind"]).inputValue(),
    "openai-compatible",
  );
  assert.equal(
    await field(page, ["brainProviders", "codex.fixture", "kind"]).getAttribute(
      "readonly",
    ),
    "",
  );
  assert.equal(
    await field(page, ["brainProviders", "codex.fixture", "protocol"])
      .inputValue(),
    "responses",
  );
  assert.equal(
    await responsesProviderCard.locator(
      `[data-configuration-field='${JSON.stringify([
        "brainProviders",
        "codex.fixture",
        "contextTokens",
      ])}']`,
    ).count(),
    0,
  );

  const forbiddenCliProviderFields = [
    "baseUrl",
    "apiKeyEnv",
    "protocol",
    "responseFormat",
    "contextTokens",
    "executable",
    "command",
    "args",
    "cwd",
    "directory",
    "plugins",
    "mcpServers",
  ];
  const addCliProvider = async ({
    templateSummary,
    templateKey,
    providerId,
    kind,
  }) => {
    const template = await openDetailsBySummary(page, templateSummary);
    await template.locator("[data-configuration-template-key]").fill(providerId);
    assert.equal(
      await templateField(template, ["brainProviders", templateKey, "kind"])
        .inputValue(),
      kind,
    );
    assert.equal(
      await templateField(template, ["brainProviders", templateKey, "kind"])
        .getAttribute("readonly"),
      "",
    );
    assert.equal(
      await templateField(template, ["brainProviders", templateKey, "remote"])
        .isChecked(),
      true,
    );
    for (const name of forbiddenCliProviderFields) {
      assert.equal(
        await templateField(template, ["brainProviders", templateKey, name]).count(),
        0,
        `${kind} template must not expose ${name}`,
      );
    }
    await template.getByRole("button", { name: templateSummary }).click();

    const card = attributeLocator(
      page,
      "data-configuration-entry",
      ["brainProviders", providerId],
    );
    assert.equal(
      await field(page, ["brainProviders", providerId, "kind"]).inputValue(),
      kind,
    );
    assert.equal(
      await field(page, ["brainProviders", providerId, "kind"])
        .getAttribute("readonly"),
      "",
    );
    assert.equal(
      await field(page, ["brainProviders", providerId, "remote"]).isChecked(),
      true,
    );
    for (const name of forbiddenCliProviderFields) {
      assert.equal(
        await field(page, ["brainProviders", providerId, name]).count(),
        0,
        `${kind} card must not expose ${name}`,
      );
    }
    return card;
  };

  await addCliProvider({
    templateSummary: "新增Codex CLI（单任务受监管）",
    templateKey: "codex-cli",
    providerId: "codex.local-cli",
    kind: "codex-cli",
  });
  await addCliProvider({
    templateSummary: "新增Claude CLI（单任务受监管）",
    templateKey: "claude-cli",
    providerId: "claude.local-cli",
    kind: "claude-cli",
  });

  await field(page, ["employees", "roles", "orchestrator", "brain", "provider"])
    .selectOption("codex.local-cli");
  await field(page, ["employees", "roles", "orchestrator", "brain", "model"])
    .fill("gpt-5.6-codex");
  await field(page, [
    "employees",
    "roles",
    "orchestrator",
    "brain",
    "remoteData",
    "requirements",
  ]).check();
  await field(page, [
    "employees",
    "roles",
    "orchestrator",
    "brain",
    "remoteData",
    "code",
  ]).check();

  const developerCard = attributeLocator(
    page,
    "data-configuration-entry",
    ["employees", "roles", "developer"],
  );
  const taskBrainTemplate = await openDetailsBySummary(
    developerCard,
    "新增任务大脑",
  );
  await templateField(taskBrainTemplate, [
    "employees",
    "roles",
    "developer",
    "taskBrain",
    "provider",
  ]).selectOption("claude.local-cli");
  await templateField(taskBrainTemplate, [
    "employees",
    "roles",
    "developer",
    "taskBrain",
    "model",
  ]).fill("claude-opus-4-6");
  await templateField(taskBrainTemplate, [
    "employees",
    "roles",
    "developer",
    "taskBrain",
    "remoteData",
    "requirements",
  ]).check();
  await templateField(taskBrainTemplate, [
    "employees",
    "roles",
    "developer",
    "taskBrain",
    "remoteData",
    "code",
  ]).check();
  await taskBrainTemplate.getByRole("button", { name: "新增任务大脑" }).click();
  assert.equal(
    await field(page, [
      "employees",
      "roles",
      "developer",
      "taskBrain",
      "provider",
    ]).inputValue(),
    "claude.local-cli",
  );
  assert.equal(
    await field(page, [
      "employees",
      "roles",
      "developer",
      "taskBrain",
      "model",
    ]).inputValue(),
    "claude-opus-4-6",
  );

  await field(page, ["employees", "roles", "developer", "brain", "provider"])
    .selectOption("remote.fixture");
  await field(page, ["memory", "answering", "brain", "provider"])
    .selectOption("remote.fixture");
  const legacyProvider = field(page, ["brain", "provider"]);
  assert.equal(await legacyProvider.locator('option[value="remote.fixture"]').count(), 0);
  assert.deepEqual(await legacyProvider.locator("option").allTextContents(), ["ollama"]);

  let repositoryTemplate = await openDetailsBySummary(page, "新增跟踪仓库");
  await templateField(repositoryTemplate, ["trackedRepositories", "0"])
    .fill("fixture/repository");
  await repositoryTemplate.getByRole("button", { name: "新增跟踪仓库" }).click();
  assert.equal(await field(page, ["trackedRepositories", "2"]).inputValue(), "fixture/repository");
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset?.configurationField),
    JSON.stringify(["trackedRepositories", "2"]),
  );
  const addedRepository = attributeLocator(
    page,
    "data-configuration-entry",
    ["trackedRepositories", "2"],
  );
  const repositoryReplacement = await openDetailsBySummary(
    addedRepository,
    "替换第 3 项",
  );
  await templateField(repositoryReplacement, ["trackedRepositories", "2"])
    .fill("fixture/repository-replaced");
  await repositoryReplacement
    .getByRole("button", { name: "替换第 3 项" })
    .click();
  assert.equal(
    await field(page, ["trackedRepositories", "2"]).inputValue(),
    "fixture/repository-replaced",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset?.configurationField),
    JSON.stringify(["trackedRepositories", "2"]),
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /已替换/,
  );
  await addedRepository.getByRole("button", { name: "删除第 3 项" }).click();
  assert.equal(await field(page, ["trackedRepositories", "2"]).count(), 0);
  assert.deepEqual(
    await page.evaluate(() => ({
      collection: document.activeElement
        ?.closest("[data-configuration-collection]")
        ?.dataset?.configurationCollection,
      tagName: document.activeElement?.tagName,
      text: document.activeElement?.textContent?.trim(),
    })),
    {
      collection: JSON.stringify(["trackedRepositories"]),
      tagName: "SUMMARY",
      text: "新增跟踪仓库",
    },
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /已删除/,
  );

  repositoryTemplate = await openDetailsBySummary(page, "新增跟踪仓库");
  await templateField(repositoryTemplate, ["trackedRepositories", "0"])
    .fill("fixture/repository");
  await repositoryTemplate.getByRole("button", { name: "新增跟踪仓库" }).click();

  const fallbackRule = attributeLocator(
    page,
    "data-configuration-entry",
    ["workflowRouting", "rules", "2"],
  );
  const conditionPath = ["workflowRouting", "rules", "2", "condition"];
  let conditionTemplate = await openDetailsBySummary(
    fallbackRule,
    "新增匹配条件",
  );
  await conditionTemplate
    .getByRole("button", { name: "新增匹配条件" })
    .click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset?.configurationField),
    JSON.stringify([...conditionPath, "op"]),
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /已新增/,
  );
  let conditionNode = attributeLocator(
    fallbackRule,
    "data-configuration-node",
    conditionPath,
  );
  conditionTemplate = await openDetailsBySummary(
    conditionNode,
    "替换匹配条件",
  );
  await conditionTemplate
    .getByRole("button", { name: "替换匹配条件" })
    .click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset?.configurationField),
    JSON.stringify([...conditionPath, "op"]),
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /已替换/,
  );
  conditionNode = attributeLocator(
    fallbackRule,
    "data-configuration-node",
    conditionPath,
  );
  await conditionNode.getByRole("button", { name: "删除匹配条件" }).click();
  assert.deepEqual(
    await page.evaluate((pathValue) => ({
      path: document.activeElement
        ?.closest("[data-configuration-template-value-root]")
        ?.dataset?.configurationTemplateValueRoot,
      tagName: document.activeElement?.tagName,
      text: document.activeElement?.textContent?.trim(),
    }), conditionPath),
    {
      path: JSON.stringify(conditionPath),
      tagName: "SUMMARY",
      text: "新增匹配条件",
    },
  );
  assert.match(
    await page.locator("#configuration-form-status").textContent(),
    /已删除/,
  );

  const saveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/configuration/drafts",
  );
  await page.locator("[data-configuration-submit]").click();
  assert.equal((await saveResponse).status(), 201);
  await page.getByRole("button", { name: "保存新修订" }).waitFor();

  const expectedConfiguration = structuredClone(baseConfiguration);
  expectedConfiguration.refreshMinutes = 17;
  expectedConfiguration.brainProviders["remote.fixture"] = {
    kind: "openai-compatible",
    baseUrl: "https://models.example.invalid/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_API_KEY",
    protocol: "chat-completions",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 120_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  expectedConfiguration.brainProviders["codex.fixture"] = {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "responses",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  expectedConfiguration.brainProviders["codex.local-cli"] = {
    kind: "codex-cli",
    credentialMode: "codex-login",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  expectedConfiguration.brainProviders["claude.local-cli"] = {
    kind: "claude-cli",
    credentialMode: "api-key",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  };
  expectedConfiguration.employees.roles.orchestrator.brain = {
    provider: "codex.local-cli",
    model: "gpt-5.6-codex",
    remoteData: { requirements: true, code: true, memory: false },
  };
  expectedConfiguration.employees.roles.developer.brain.provider = "remote.fixture";
  expectedConfiguration.employees.roles.developer.taskBrain = {
    provider: "claude.local-cli",
    model: "claude-opus-4-6",
    remoteData: { requirements: true, code: true, memory: false },
  };
  expectedConfiguration.memory.answering.brain.provider = "remote.fixture";
  expectedConfiguration.trackedRepositories.push("fixture/repository");
  assert.deepEqual(draftWrites, [
    {
      actionHeader: "1",
      body: {
        expectedStateRevision: 1,
        expectedActiveVersion: 1,
        configuration: expectedConfiguration,
      },
    },
  ]);
  assert.equal(
    await field(page, ["employees", "roles", "orchestrator", "brain", "provider"])
      .inputValue(),
    "codex.local-cli",
  );
  assert.equal(
    await field(page, [
      "employees",
      "roles",
      "developer",
      "taskBrain",
      "provider",
    ]).inputValue(),
    "claude.local-cli",
  );

  assert.equal(await page.locator("#confirmation-dialog[open]").count(), 0);
  assert.equal(confirmationRequests.length, 0);
  const previewResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith("/draft-1/preview"),
  );
  await page.locator("[data-configuration-preview]").click();
  assert.equal((await previewResponse).status(), 200);
  await page.locator(".configuration-preview").waitFor();
  assert.deepEqual(previewRequests, [
    {
      actionHeader: "1",
      body: {
        draftRevision: 1,
        expectedStateRevision: 2,
        expectedActiveVersion: 1,
      },
    },
  ]);
  assert.equal(await page.locator("#confirmation-dialog[open]").count(), 0);
  assert.equal(confirmationRequests.length, 0);

  const requestResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith("/request-confirmation"),
  );
  await page.locator("[data-configuration-request]").click();
  assert.equal((await requestResponse).status(), 201);
  await page.locator("#confirmation-dialog[open]").waitFor();
  assert.deepEqual(confirmationRequests, [
    {
      actionHeader: "1",
      body: {
        draftRevision: 1,
        expectedStateRevision: 2,
        expectedActiveVersion: 1,
      },
    },
  ]);
  assert.match(
    await page.locator("#confirmation-dialog").textContent(),
    /确认配置草稿.*确认并激活配置/s,
  );
  await page.locator(".confirmation-close").click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  assert.equal(browserErrors.length, 0, browserErrors.join("\n"));

  const refreshedField = field(page, ["refreshMinutes"]);
  await refreshedField.fill("23");
  await page.evaluate(() => fetch("/fixture/stale-next-write", { method: "POST" }));
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname === "/api/configuration/drafts/draft-1",
  );
  await page.locator("[data-configuration-submit]").click();
  assert.equal((await staleResponse).status(), 409);
  await page.locator("[data-configuration-reset]").waitFor();
  assert.equal(await field(page, ["refreshMinutes"]).inputValue(), "23");
  assert.equal(await page.locator("[data-configuration-submit]").isDisabled(), true);
  assert.equal(await page.locator("[data-configuration-preview]").isDisabled(), true);
  assert.match(await page.locator("#configuration-form-status").textContent(), /本地内容已保留/);
  assert.equal(staleWrites.length, 1);
  assert.equal(staleWrites[0].body.configuration.refreshMinutes, 23);
  assert.equal(staleWrites[0].actionHeader, "1");

  await page.locator("[data-configuration-reset]").click();
  await page.waitForFunction(() => {
    const control = document.querySelector('[data-configuration-field="[\\"refreshMinutes\\"]"]');
    return control?.value === "99";
  });
  assert.equal(await page.locator("[data-configuration-reset]").count(), 0);
  const unexpectedBrowserErrors = browserErrors.filter(
    (message) => !/status of 409 \(Conflict\)/.test(message),
  );
  assert.equal(unexpectedBrowserErrors.length, 0, unexpectedBrowserErrors.join("\n"));

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mobileErrors = captureBrowserErrors(mobile);
  await mobile.goto(origin, { waitUntil: "networkidle" });
  const mobileNavigation = await mobile.evaluate(() => {
    const nav = document.querySelector(".nav");
    const items = [...document.querySelectorAll(".nav-item")];
    const hint = document.querySelector(".nav-scroll-hint");
    return {
      hintVisible: hint !== null && getComputedStyle(hint).display !== "none",
      horizontallyScrollable: nav.scrollWidth > nav.clientWidth,
      itemHeights: items.map((item) => item.getBoundingClientRect().height),
      itemFontSizes: items.map((item) => parseFloat(getComputedStyle(item).fontSize)),
      shortcutDisplays: items.map((item) => getComputedStyle(item.querySelector("kbd")).display),
    };
  });
  assert.equal(mobileNavigation.hintVisible, true);
  assert.equal(mobileNavigation.horizontallyScrollable, true);
  assert.equal(mobileNavigation.itemHeights.every((height) => height >= 44), true);
  assert.equal(mobileNavigation.itemFontSizes.every((size) => size >= 14), true);
  assert.equal(mobileNavigation.shortcutDisplays.every((value) => value === "none"), true);

  await mobile.keyboard.press("s");
  await mobile.locator('.nav-item[data-view="system"][aria-current="page"]').waitFor();
  await mobile.waitForFunction(() => {
    const nav = document.querySelector(".nav").getBoundingClientRect();
    const active = document.querySelector('.nav-item[data-view="system"]')
      .getBoundingClientRect();
    return active.left >= nav.left && active.right <= nav.right;
  });
  assert.ok(
    await mobile.locator(".nav").evaluate((nav) => nav.scrollLeft > 0),
    "keyboard-selected mobile navigation item was not scrolled into view",
  );

  await mobile.keyboard.press("0");
  await mobile.locator("[data-configuration-structured-form]").waitFor();
  await openDetailsBySummary(mobile, "新增大脑 Provider");
  const overflow = await mobile.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    form: document.querySelector("[data-configuration-structured-form]").scrollWidth -
      document.querySelector("[data-configuration-structured-form]").clientWidth,
    inputFontSize: parseFloat(getComputedStyle(
      document.querySelector("[data-configuration-structured-form] input:not([type=checkbox])"),
    ).fontSize),
  }));
  assert.ok(overflow.document <= 0, `mobile document overflowed by ${overflow.document}px`);
  assert.ok(overflow.form <= 0, `mobile form overflowed by ${overflow.form}px`);
  assert.ok(overflow.inputFontSize >= 16, `mobile input font is ${overflow.inputFontSize}px`);
  assert.equal(
    await mobile.locator(
      ".configuration-editor textarea:not([data-configuration-field]):not([data-configuration-template-field])",
    ).count(),
    0,
  );
  assert.equal(mobileErrors.length, 0, mobileErrors.join("\n"));
  await mobile.close();

  assert.equal(
    apiRequests.some(
      ({ method, path: requestPath }) =>
        method !== "GET" &&
        (/^\/api\/configuration\/(?:activate|restart)(?:\/|$)/.test(requestPath) ||
          /^\/api\/configuration\/versions\/\d+\/rollback$/.test(requestPath)),
    ),
    false,
    "the UI must not call direct activate, restart or rollback execution routes",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("configuration form Playwright fixture passed");
