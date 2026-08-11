import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { validationBrowserLaunchOptions } from
  "../../scripts/playwright-validation-options.mjs";

const publicDirectory = path.resolve("public");
const historyDelayMs = 120;
let appendFailuresRemaining = 1;
let confirmationEnabled = false;
let confirmationFixtureName = "active";
let historyMutation = 0;
let queueRevision = 1;
let historyRequestCount = 0;

function json(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
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

function historyItem(status, suffix) {
  return {
    id: `confirmation-history-${suffix}`,
    kind: "github.pull-request-review",
    status,
    requestedBy: {
      roleId: "pr-reviewer",
      workItemId: `work-history-${suffix}`,
    },
    title:
      historyMutation
        ? `History mutation ${historyMutation}`
        : suffix === "completed"
        ? "History completed <img data-history-xss src=x onerror=alert(1)>"
        : `History ${suffix}`,
    summary: "Read-only history fixture <script>alert(1)</script>",
    createdAt: "2026-08-06T01:00:00.000Z",
    updatedAt: "2026-08-06T01:01:00.000Z",
    retryable: status === "failed",
  };
}

function historyPageItems(status, cursor) {
  if (cursor) return [historyItem(status, "older")];
  return Array.from({ length: 20 }, (_, index) =>
    historyItem(status, index === 0 ? status : `${status}-${index}`),
  );
}

async function historyResponse(url, response) {
  historyRequestCount += 1;
  const status = url.searchParams.get("status") || "completed";
  const cursor = url.searchParams.get("cursor");
  const roleId = url.searchParams.get("roleId");
  await new Promise((resolve) =>
    setTimeout(resolve, status === "rejected" ? historyDelayMs * 2 : historyDelayMs),
  );
  if (cursor && appendFailuresRemaining > 0) {
    if (cursor) appendFailuresRemaining -= 1;
    json(response, 503, { error: "fixture failure" });
    return;
  }
  json(response, 200, {
    available: roleId !== "unavailable-reader",
    queueRevision,
    filters: {
      ...(status ? { status } : {}),
      ...(url.searchParams.get("kind")
        ? { kind: url.searchParams.get("kind") }
        : {}),
      ...(url.searchParams.get("roleId")
        ? { roleId: url.searchParams.get("roleId") }
        : {}),
    },
    limit: 20,
    roleIdFacets: ["former-reviewer", "pr-reviewer", "unavailable-reader"],
    items: roleId === "unavailable-reader" ? [] : historyPageItems(status, cursor),
    nextCursor: cursor ? null : "abcdefghijklmnop",
  });
}

const confirmationFixtures = Object.freeze({
  active: Object.freeze({
    kind: "github.pull-request-review",
    title: "Fixture confirmation",
    actionLabel: "Approve fixture",
    action: Object.freeze({
      type: "pull_request_review",
      reviewEvent: "APPROVE",
      body: "Fixture review",
    }),
  }),
  comment: Object.freeze({
    kind: "github.pull-request-comment",
    title: "Fixture PR 评论",
    actionLabel: "确认并发布评论",
    action: Object.freeze({
      type: "pull_request_comment",
      body: "Fixture PR comment",
    }),
  }),
  review: Object.freeze({
    kind: "github.work-proposal-review",
    title: "Fixture PR Review",
    actionLabel: "确认并发布 Review",
    action: Object.freeze({
      type: "pull_request_review",
      reviewEvent: "REQUEST_CHANGES",
      body: "Fixture review request",
    }),
  }),
  update: Object.freeze({
    kind: "github.pull-request-update-branch",
    title: "Fixture 更新 PR 分支",
    actionLabel: "确认并更新分支",
    action: Object.freeze({
      type: "pull_request_update_branch",
      expectedHeadOid: "c".repeat(40),
      expectedBaseOid: "d".repeat(40),
    }),
  }),
  push: Object.freeze({
    kind: "github.pull-request-push",
    title: "Fixture 推送受控 commit",
    actionLabel: "确认并推送 commit",
    action: Object.freeze({
      type: "pull_request_push",
      expectedOldOid: "e".repeat(40),
      remote: Object.freeze({ repository: "fixture/head", refName: "feature" }),
      controlledCommitEvidence: Object.freeze({
        commit: Object.freeze({ oid: "f".repeat(40) }),
      }),
    }),
  }),
  merge: Object.freeze({
    kind: "github.pull-request-merge",
    title: "Fixture 合并 PR",
    actionLabel: "确认并合并 PR",
    action: Object.freeze({
      type: "pull_request_merge",
      method: "squash",
      expectedHeadOid: "1".repeat(40),
    }),
  }),
});

function confirmationItem() {
  const fixture = confirmationFixtures[confirmationFixtureName];
  return {
    id: `confirmation-${confirmationFixtureName}`,
    kind: fixture.kind,
    queueRevision: 7,
    itemRevision: 3,
    displayedPayloadDigest: "a".repeat(64),
    approvalBindingDigest: "b".repeat(64),
    retryable: false,
    requestedBy: { roleId: "pr-reviewer", workItemId: "work-active" },
    display: {
      title: fixture.title,
      summary: "Approve this fixture action",
      actionLabel: fixture.actionLabel,
      payload: {
        actor: { accountId: "fixture" },
        target: { resourceId: "fixture/pr", version: "abcdef" },
        action: structuredClone(fixture.action),
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
      if (url.pathname === "/api/dashboard") {
        json(response, 200, dashboardFixture());
        return;
      }
      if (url.pathname === "/api/refresh") {
        json(response, 200, dashboardFixture());
        return;
      }
      if (url.pathname === "/fixture/enable-confirmation") {
        const requestedFixture = url.searchParams.get("fixture") || "active";
        if (!Object.hasOwn(confirmationFixtures, requestedFixture)) {
          json(response, 400, { error: "unknown fixture" });
          return;
        }
        confirmationFixtureName = requestedFixture;
        if (!confirmationEnabled) {
          confirmationEnabled = true;
        }
        queueRevision += 1;
        json(response, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/attention/next") {
        if (confirmationEnabled) {
          json(response, 200, {
            available: true,
            source: "external_confirmation",
            pendingCount: 1,
            externalEnabled: true,
            externalQueueRevision: queueRevision,
            item: confirmationItem(),
          });
          return;
        }
        json(response, 200, {
          available: false,
          source: null,
          pendingCount: 0,
          externalEnabled: true,
          externalQueueRevision: queueRevision,
          item: null,
        });
        return;
      }
      if (
        request.method === "POST" &&
        /^\/api\/confirmations\/confirmation-[a-z]+\/(approve|retry|reject)$/.test(
          url.pathname,
        )
      ) {
        confirmationEnabled = false;
        historyMutation += 1;
        queueRevision += 1;
        json(response, 200, { item: { status: "completed" } });
        return;
      }
      if (url.pathname === "/api/employees") {
        json(response, 200, { items: [] });
        return;
      }
      if (url.pathname === "/api/confirmations/history") {
        await historyResponse(url, response);
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
  if (existsSync(chromium.executablePath())) {
    return chromium.launch(validationBrowserLaunchOptions({ headless: true }));
  }
  if (process.platform === "win32") {
    return chromium.launch(validationBrowserLaunchOptions({
      channel: "msedge",
      headless: true,
    }));
  }
  throw new Error("Install a Playwright Chromium browser before running this fixture");
}

async function submitHistoryFilter(page, filters) {
  for (const [name, value] of Object.entries(filters)) {
    await page.selectOption(`#confirmation-history-${name}`, value);
  }
  await page.locator("#confirmation-history-apply").focus();
  await page.locator("#confirmation-history-filter").evaluate((form) => {
    form.requestSubmit(document.querySelector("#confirmation-history-apply"));
  });
}

async function stableIdentity(page, handle, selector) {
  return page.evaluate(
    ([node, expectedSelector]) => node === document.querySelector(expectedSelector),
    [handle, selector],
  );
}

const server = createFixtureServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`, {
    waitUntil: "networkidle",
  });
  await page.locator('[data-view="employees"]').click();
  await page.locator(".confirmation-history-item").first().waitFor();

  const initialHistoryRequestCount = historyRequestCount;
  const unchangedQueueRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/attention/next",
  );
  await page.locator("#refresh-button").dispatchEvent("click");
  await unchangedQueueRead;
  await page.waitForTimeout(historyDelayMs + 50);
  assert.equal(historyRequestCount, initialHistoryRequestCount);

  assert.equal(
    await page.locator('#confirmation-history-role option[value="former-reviewer"]').count(),
    1,
  );
  const form = await page.locator("#confirmation-history-filter").elementHandle();
  const liveRegion = await page.locator("#confirmation-history-results").elementHandle();
  const loadMore = await page.locator("#confirmation-history-load-more").elementHandle();

  assert.match(
    await page.locator(".confirmation-history-item").first().textContent(),
    /History completed <img data-history-xss src=x onerror=alert\(1\)>/,
  );
  assert.equal(await page.locator(".confirmation-history-item img").count(), 0);

  await submitHistoryFilter(page, { status: "rejected" });
  await page.locator('#confirmation-history-panel[aria-busy="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");
  await page.locator("#refresh-button").dispatchEvent("click");
  await page.getByText("History rejected", { exact: true }).waitFor();
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");

  await submitHistoryFilter(page, { status: "rejected" });
  await submitHistoryFilter(page, { status: "stale" });
  await page.locator('#confirmation-history-panel[aria-busy="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");
  await page.getByText("History stale", { exact: true }).waitFor();
  assert.equal(await page.getByText("History rejected", { exact: true }).count(), 0);
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-apply");

  await submitHistoryFilter(page, { status: "failed" });
  await page.getByText("History failed", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".confirmation-history-item .status-pill").first().textContent(),
    "执行失败",
  );
  assert.match(
    await page.locator(".confirmation-history-item").first().textContent(),
    /可再次逐项确认/,
  );

  await submitHistoryFilter(page, { role: "unavailable-reader" });
  await page.getByText("确认历史读取能力未启用。", { exact: true }).waitFor();

  await submitHistoryFilter(page, { status: "", role: "" });
  await page.locator(".confirmation-history-item strong").first().waitFor();
  await page.locator("#confirmation-history-load-more").focus();
  await page.locator("#confirmation-history-load-more").click();
  await page.locator('#confirmation-history-panel[aria-busy="true"]').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-load-more");
  await page.locator("#confirmation-history-error:not([hidden])").waitFor();
  assert.equal(await stableIdentity(page, loadMore, "#confirmation-history-load-more"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-load-more");

  await page.locator("#confirmation-history-load-more").click();
  await page.getByText("History older", { exact: true }).waitFor();
  assert.equal(await stableIdentity(page, loadMore, "#confirmation-history-load-more"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "confirmation-history-load-more");
  assert.equal(await page.locator("#confirmation-history-load-more").getAttribute("aria-disabled"), "true");

  for (const fixture of [
    ["comment", /PR 评论.*将发布的完整正文/s, "确认并发布评论"],
    ["review", /PR Review.*Review 类型.*将发布的完整正文/s, "确认并发布 Review"],
    ["update", /更新 PR 分支.*预期 Head.*预期 Base/s, "确认并更新分支"],
    ["push", /推送受控 commit.*目标分支.*受控 commit/s, "确认并推送 commit"],
    ["merge", /合并 PR.*合并方式.*预期 Head/s, "确认并合并 PR"],
  ]) {
    await page.evaluate(
      (name) => fetch(`/fixture/enable-confirmation?fixture=${name}`, { method: "POST" }),
      fixture[0],
    );
    await page.locator("#refresh-button").click();
    await page.locator("#confirmation-dialog[open]").waitFor();
    assert.match(await page.locator("#confirmation-dialog").textContent(), fixture[1]);
    await page.getByRole("button", { name: fixture[2] }).waitFor();
    await page.getByRole("button", { name: "稍后再看" }).click();
    await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
    if (fixture[0] === "comment") {
      const restore = page.locator("#confirmation-deferred-restore");
      await restore.waitFor();
      assert.match(await restore.textContent(), /重新查看稍后项（1）/);
      await restore.click();
      await page.locator("#confirmation-dialog[open]").waitFor();
      assert.match(
        await page.locator("#confirmation-dialog").textContent(),
        /Fixture PR 评论.*Fixture PR comment/s,
      );
      await page.getByRole("button", { name: "稍后再看" }).click();
      await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
    }
  }

  await page.selectOption("#confirmation-history-status", "stale");
  await page.evaluate(() =>
    fetch("/fixture/enable-confirmation?fixture=active", { method: "POST" })
  );
  await page.locator("#refresh-button").click();
  await page.locator("#confirmation-dialog[open]").waitFor();
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.locator("#confirmation-history-status").inputValue(), "stale");

  await page.getByRole("button", { name: "Approve fixture" }).click();
  await page
    .locator(".confirmation-history-item strong")
    .filter({ hasText: "History mutation 1" })
    .first()
    .waitFor();
  assert.equal(await stableIdentity(page, form, "#confirmation-history-filter"), true);
  assert.equal(await stableIdentity(page, liveRegion, "#confirmation-history-results"), true);
  assert.equal(await page.locator("#confirmation-history-status").inputValue(), "stale");
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("confirmation history Playwright fixture passed");
