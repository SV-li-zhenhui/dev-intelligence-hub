import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = "http://127.0.0.1:4173";
const outputDirectory = path.resolve("validation-artifacts");
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];

function sectionByTitle(page, title) {
  return page.locator(".section").filter({
    has: page.locator("h2", { hasText: title }),
  });
}

async function validate(name, viewport) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#content .section").first().waitFor();
  await page.screenshot({
    path: path.join(outputDirectory, `${name}.png`),
    fullPage: true,
  });

  const actionNowCount = await sectionByTitle(
    page,
    "现在轮到我",
  ).locator(".work-item").count();
  const sourceHealth = await page.locator("#source-health").innerText();
  const employeeState = await page
    .locator(".employee-panel .status-pill")
    .first()
    .innerText();
  let detailHasResponsibility = false;
  if (actionNowCount) {
    await sectionByTitle(page, "现在轮到我").locator(".work-item").first().click();
    await page.locator("#detail-dialog[open]").waitFor();
    detailHasResponsibility = await page
      .locator("#detail-dialog")
      .getByText("责任状态", { exact: true })
      .isVisible();
    await page.getByRole("button", { name: "关闭详情" }).click();
  }
  await page.locator('[data-view="prs"]').click();
  const prSectionTitles = await page.locator(".section-heading h2").allTextContents();
  await page.locator('[data-view="versions"]').click();
  const versionRows = await page.locator(".version-row").count();
  const newestVersionFirstNote = (
    await sectionByTitle(page, "跟踪版本")
      .locator(".section-heading span")
      .innerText()
  ).includes("最新创建/发布在前");
  await page.locator('[data-view="signals"]').click();
  const signalCount = await page.locator(".work-item").count();
  if (signalCount) {
    await page.locator(".work-item").first().click();
    await page.locator("dialog[open]").waitFor();
    await page.getByRole("button", { name: "关闭详情" }).click();
  }
  await page.locator('[data-view="employees"]').click();
  const employeeJobCount = await page.locator(".employee-job").count();
  await page.locator('[data-view="memory"]').click();
  await page.locator("#memory-search-form").waitFor();
  const memorySearchVisible = await page
    .getByLabel("搜索 PR、仓库、问题或处理结论")
    .isVisible();
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  results.push({
    name,
    status: response?.status(),
    actionNowCount,
    sourceHealth,
    employeeState,
    employeeJobCount,
    memorySearchVisible,
    detailHasResponsibility,
    prSectionTitles,
    versionRows,
    newestVersionFirstNote,
    signalCount,
    horizontalOverflow,
    consoleErrors,
    pageErrors,
  });
  await page.close();
}

await validate("desktop-1440", { width: 1440, height: 1000 });
await validate("mobile-390", { width: 390, height: 844 });

async function validateConfirmationQueue() {
  const liveDashboard = await fetch(`${baseUrl}/api/dashboard`).then((response) =>
    response.json(),
  );
  const fixture = structuredClone(liveDashboard);
  fixture.employee = {
    role: {
      id: "pr-reviewer",
      name: "PR 推进员工",
      state: "observing",
      revision: 1,
      brain: { provider: "ollama", model: "qwen3.5:9b" },
      paused: false,
      lastRun: null,
      lastError: "",
    },
    jobs: [],
    confirmationQueue: [],
  };
  const seed =
    fixture.groups.actionNow[0] ||
    fixture.groups.waitingOther[0] ||
    fixture.groups.myPullRequests[0];
  const uncertain = {
    ...seed,
    id: "fixture:uncertain-pr",
    repo: "local/fixture",
    number: 1,
    title: "需要确认责任归属的测试 PR",
    headRefOid: "fixture-head-1",
    actionState: "uncertain",
    nextActor: "unknown",
    nextAction: "confirm",
    actionReasons: ["审核事实不完整"],
    reasons: ["需要你确认责任归属"],
    score: 80,
    brainAssessment: {
      classification: "waiting_other",
      nextActor: "author",
      confidence: 0.74,
      evidence: ["缺少完整审核事实"],
      recommendedAction: "建议确认是否正在等待作者",
      requiresConfirmation: true,
    },
  };
  fixture.groups.uncertainPullRequests = [uncertain];
  fixture.counts.uncertainPullRequests = 1;

  const confirmed = structuredClone(fixture);
  confirmed.groups.uncertainPullRequests = [];
  confirmed.groups.waitingOther = [
    {
      ...uncertain,
      actionState: "waiting_other",
      nextActor: "other",
      nextAction: "wait_other",
      actionReasons: ["你已确认：当前等待他人处理"],
      reasons: ["你已确认：当前等待他人处理"],
      score: 35,
    },
    ...confirmed.groups.waitingOther,
  ];
  confirmed.counts.uncertainPullRequests = 0;
  confirmed.counts.waitingOther += 1;

  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const requests = [];
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }),
  );
  await page.route("**/api/pr-responsibility/confirm", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(confirmed),
    });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#confirmation-dialog[open]").waitFor();
  const recommendationVisible = await page
    .getByText("建议确认是否正在等待作者", { exact: true })
    .isVisible();
  await page.getByRole("button", { name: "等待别人", exact: true }).click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  const confirmedVisible = await sectionByTitle(page, "等待别人")
    .getByText("需要确认责任归属的测试 PR", { exact: true })
    .isVisible();
  results.push({
    name: "confirmation-queue",
    recommendationVisible,
    confirmedVisible,
    request: requests[0],
  });
  await page.close();
}

await validateConfirmationQueue();

async function validateEmployeeReviewQueue() {
  const liveDashboard = await fetch(`${baseUrl}/api/dashboard`).then((response) =>
    response.json(),
  );
  const fixture = structuredClone(liveDashboard);
  fixture.groups.uncertainPullRequests = [];
  fixture.counts.uncertainPullRequests = 0;
  const reviewJob = {
    id: "pr-work-fixture",
    subjectId: "github:pr:local/fixture#9",
    repo: "local/fixture",
    number: 9,
    title: "员工主动生成的评审草稿",
    url: "https://example.invalid/local/fixture/pull/9",
    headRefOid: "fixture-head-9",
    nextAction: "review",
    triggerReason: "等待你首次审核",
    status: "ready_for_human",
    summary: "发现错误路径缺少覆盖。",
    evidence: ["src/pay.js 修改了失败分支"],
    steps: ["补充失败路径测试"],
    reviewVerdict: "request_changes",
    reviewBody: "建议补充失败路径测试后再合并。",
    requiresApproval: true,
    brain: { provider: "ollama", model: "qwen3.5:9b" },
    createdAt: "2026-07-31T10:00:00.000Z",
  };
  fixture.employee = {
    role: {
      id: "pr-reviewer",
      name: "PR 推进员工",
      mission: "主动巡查与你相关的 PR，生成评审草稿或推进方案",
      state: "waiting_user",
      revision: 8,
      brain: { provider: "ollama", model: "qwen3.5:9b" },
      paused: false,
      lastRun: {
        trigger: "refresh_completed",
        at: "2026-07-31T10:00:00.000Z",
        summary: "新建 1 个评审作业",
      },
      lastError: "",
    },
    jobs: [reviewJob],
    confirmationQueue: [reviewJob],
  };
  const accepted = structuredClone(fixture);
  accepted.employee.jobs[0].status = "accepted";
  accepted.employee.confirmationQueue = [];
  accepted.employee.role.state = "observing";
  accepted.employee.role.revision = 9;

  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const requests = [];
  await page.route("**/api/dashboard", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture),
    }),
  );
  await page.route("**/api/pr-review-jobs/decide", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(accepted),
    });
  });
  await page.route("**/api/memory/search**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "memory-fixture",
            title: reviewJob.title,
            summary: reviewJob.summary,
            repository: reviewJob.repo,
            number: reviewJob.number,
            event: "analysis_ready",
            createdAt: reviewJob.createdAt,
          },
        ],
      }),
    }),
  );

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#confirmation-dialog[open]").waitFor();
  const localOnlyNote = await page
    .getByText(/不会提交 GitHub Review/)
    .isVisible();
  const reviewBodyVisible = await page
    .getByText(reviewJob.reviewBody, { exact: true })
    .isVisible();
  await page.getByRole("button", { name: "接受草稿", exact: true }).click();
  await page.locator("#confirmation-dialog").waitFor({ state: "hidden" });
  await page.locator('[data-view="employees"]').click();
  const acceptedVisible = await page
    .getByText("你已接受", { exact: true })
    .isVisible();
  await page.locator('[data-view="memory"]').click();
  await page.getByText(reviewJob.title, { exact: true }).waitFor();

  results.push({
    name: "employee-review-queue",
    localOnlyNote,
    reviewBodyVisible,
    acceptedVisible,
    request: requests[0],
  });
  await page.close();
}

await validateEmployeeReviewQueue();
await browser.close();

await writeFile(
  path.join(outputDirectory, "results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
  "utf8",
);

for (const result of results.filter((entry) => entry.name.includes("-"))) {
  if (["desktop-1440", "mobile-390"].includes(result.name)) {
    assert.equal(result.status, 200, `${result.name}: page must load`);
    assert.deepEqual(result.consoleErrors, [], `${result.name}: console errors`);
    assert.deepEqual(result.pageErrors, [], `${result.name}: page errors`);
    assert.equal(result.horizontalOverflow, false, `${result.name}: overflow`);
    assert.equal(result.memorySearchVisible, true, `${result.name}: memory search`);
    assert.equal(
      result.newestVersionFirstNote,
      true,
      `${result.name}: version ordering note`,
    );
    if (result.actionNowCount) {
      assert.equal(
        result.detailHasResponsibility,
        true,
        `${result.name}: PR detail evidence`,
      );
    }
  }
}

const responsibilityResult = results.find(
  (entry) => entry.name === "confirmation-queue",
);
assert.equal(responsibilityResult.recommendationVisible, true);
assert.equal(responsibilityResult.confirmedVisible, true);
assert.equal(responsibilityResult.request.headRefOid, "fixture-head-1");

const reviewResult = results.find(
  (entry) => entry.name === "employee-review-queue",
);
assert.equal(reviewResult.localOnlyNote, true);
assert.equal(reviewResult.reviewBodyVisible, true);
assert.equal(reviewResult.acceptedVisible, true);
assert.equal(reviewResult.request.headRefOid, "fixture-head-9");

console.log(JSON.stringify(results, null, 2));
