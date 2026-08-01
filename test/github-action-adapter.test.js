import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubActionExecutor,
  markerForGitHubAction,
} from "../src/adapters/github-action-adapter.js";
import { ManagedProcessError } from "../src/lib/managed-process.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const GH_COMMAND =
  process.platform === "win32"
    ? "C:\\Program Files\\GitHub CLI\\gh.exe"
    : "/usr/bin/gh";
const GH_TOKEN = "github_test_token";

function createAdapter(runner, overrides = {}) {
  return createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    token: GH_TOKEN,
    ...overrides,
  });
}

function reviewEnvelope(overrides = {}) {
  const action = overrides.action || {
    type: "pull_request_review",
    reviewEvent: "APPROVE",
    body: "Reviewed the error path.",
  };
  return {
    schemaVersion: 1,
    id: "confirmation-review-42",
    idempotencyKey: `confirmation-${"a".repeat(64)}`,
    kind: "github.pull-request-review",
    requestedBy: { roleId: "pr-reviewer", workItemId: "pr-work-42" },
    actor: { provider: "github", accountId: "SV-li-zhenhui" },
    target: {
      provider: "github",
      resourceId: "SVisions/OCT-Software#42",
      version: HEAD,
    },
    action,
    displayedPayloadDigest: "b".repeat(64),
    approvalBindingDigest: "a".repeat(64),
    execution: {
      requestId: "request-approve-0001",
      attempt: 1,
      startedAt: "2026-08-02T01:00:00.000Z",
    },
    ...overrides,
    action,
  };
}

function commentEnvelope(overrides = {}) {
  return reviewEnvelope({
    kind: "github.pull-request-review",
    action: {
      type: "pull_request_review",
      reviewEvent: "COMMENT",
      body: "Please check `$PATH`, @notes.txt & the JSON {\"ok\":true}.\nSecond line.",
    },
    ...overrides,
  });
}

class FakeRunner {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async run(input) {
    this.calls.push(structuredClone(input));
    if (!this.responses.length) throw new Error("unexpected runner call");
    let response = this.responses.shift();
    if (typeof response === "function") response = await response(input);
    if (response instanceof Error) throw response;
    const stdout = response?.__jsonLines
      ? response.__jsonLines.map((value) => JSON.stringify(value)).join("\n")
      : JSON.stringify(response);
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  }
}

function actor(login = "SV-li-zhenhui") {
  return { login };
}

function head(value = HEAD) {
  return { headRefOid: value };
}

function pages(records = []) {
  return { __jsonLines: records };
}

function markerFromPost(call) {
  const body = JSON.parse(call.input).body;
  return body.match(/<!-- mydashboard-action:v1:([a-f0-9]{64}) -->$/)?.[0];
}

function commentReviewRecord(marker, overrides = {}) {
  return {
    id: 9001,
    html_url: "https://github.com/SVisions/OCT-Software/pull/42#pullrequestreview-9001",
    submitted_at: "2026-08-02T01:00:01Z",
    user: { login: "SV-li-zhenhui" },
    body: `Please check.\n\n${marker}`,
    state: "COMMENTED",
    commit_id: HEAD,
    ...overrides,
  };
}

function reviewRecord(marker, overrides = {}) {
  return {
    id: 8001,
    html_url: "https://github.com/SVisions/OCT-Software/pull/42#pullrequestreview-8001",
    submitted_at: "2026-08-02T01:00:01Z",
    user: { login: "SV-li-zhenhui" },
    body: `Reviewed the error path.\n\n${marker}`,
    state: "APPROVED",
    commit_id: HEAD,
    ...overrides,
  };
}

test("invalid action envelopes fail before the GitHub CLI can run", async () => {
  const invalid = [
    { ...reviewEnvelope(), extra: true },
    reviewEnvelope({ target: { provider: "github", resourceId: "not-a-pr", version: HEAD } }),
    reviewEnvelope({ target: { provider: "github", resourceId: "owner/repo#42", version: "head" } }),
    reviewEnvelope({ actor: { provider: "github", accountId: "bad login" } }),
    reviewEnvelope({ action: { type: "pull_request_review", reviewEvent: "DISMISS", body: "no" } }),
    reviewEnvelope({
      kind: "github.pull-request-comment",
      action: { type: "issue_comment", body: "legacy comment" },
    }),
    commentEnvelope({
      action: { type: "pull_request_review", reviewEvent: "COMMENT", body: "" },
    }),
    reviewEnvelope({ idempotencyKey: `confirmation-${"c".repeat(64)}` }),
  ];

  for (const envelope of invalid) {
    const runner = new FakeRunner();
    const result = await createAdapter(runner).execute(envelope);
    assert.deepEqual(result, {
      status: "error",
      error: { trust: "trusted", code: "INVALID_GITHUB_ACTION" },
    });
    assert.equal(runner.calls.length, 0);
  }
});

test("the configured actor is checked before target or marker queries", async () => {
  const runner = new FakeRunner([actor("different-user")]);
  const result = await createAdapter(runner).reconcile(reviewEnvelope());

  assert.deepEqual(result, {
    status: "error",
    error: { trust: "trusted", code: "GITHUB_ACTOR_MISMATCH" },
  });
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["api", "--hostname", "github.com", "--method", "GET", "user"],
  ]);
});

test("every GitHub call uses one fixed token, absolute executable, and minimal environment", async () => {
  const sourceEnv = {
    GH_TOKEN: "token_from_parent",
    PATH: "C:\\untrusted-bin",
    DATABASE_URL: "postgres://must-not-reach-child",
    SystemRoot: "C:\\Windows",
    HTTPS_PROXY: "http://127.0.0.1:8080",
  };
  const runner = new FakeRunner([actor(), pages([]), head()]);
  const adapter = createAdapter(runner, {
    env: sourceEnv,
    networkEnv: { HTTPS_PROXY: sourceEnv.HTTPS_PROXY },
    token: "fixed_token_for_confirmed_account",
  });
  sourceEnv.GH_TOKEN = "changed_after_construction";

  assert.deepEqual(await adapter.reconcile(reviewEnvelope()), {
    status: "absent",
    code: "GITHUB_MARKER_ABSENT",
  });
  for (const call of runner.calls) {
    assert.equal(call.command, GH_COMMAND);
    assert.deepEqual(call.env, {
      GH_TOKEN: "fixed_token_for_confirmed_account",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://127.0.0.1:8080",
    });
    assert.equal("PATH" in call.env, false);
    assert.equal("DATABASE_URL" in call.env, false);
  }
});

test("reconciliation finds one exact COMMENT review marker across paginated results", async () => {
  const marker = markerForGitHubAction(commentEnvelope());
  const runner = new FakeRunner([
    actor(),
    pages([
      commentReviewRecord("<!-- mydashboard-action:v1:" + "0".repeat(64) + " -->"),
      commentReviewRecord(marker, {
        body: `${commentEnvelope().action.body}\n\n${marker}`,
      }),
    ]),
  ]);

  const result = await createAdapter(runner).reconcile(commentEnvelope());

  assert.equal(result.status, "already");
  assert.deepEqual(result.receipt, {
    id: "9001",
    url: "https://github.com/SVisions/OCT-Software/pull/42",
    createdAt: "2026-08-02T01:00:01.000Z",
  });
  assert.deepEqual(runner.calls[1].args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "repos/SVisions/OCT-Software/pulls/42/reviews?per_page=100",
    "--paginate",
    "--jq",
    `.[] | select((.body // "") | contains("${marker}")) | {id, html_url, submitted_at, user: {login: .user.login}, body, state, commit_id}`,
  ]);
});

test("copied, conflicting, or duplicate markers fail closed", async () => {
  const marker = markerForGitHubAction(reviewEnvelope());
  for (const records of [
    [reviewRecord(marker, { user: { login: "other-user" } })],
    [reviewRecord(marker, { state: "COMMENTED" })],
    [reviewRecord(marker), reviewRecord(marker, { id: 8002 })],
  ]) {
    const runner = new FakeRunner([actor(), pages(records)]);
    const result = await createAdapter(runner).reconcile(reviewEnvelope());
    assert.deepEqual(result, {
      status: "error",
      error: { trust: "unknown", code: "GITHUB_MARKER_CONFLICT" },
    });
  }
});

test("a GitHub receipt must identify the exact PR and review record", async () => {
  const marker = markerForGitHubAction(reviewEnvelope());
  for (const html_url of [
    "https://github.com/SVisions/OCT-Software/pull/43#pullrequestreview-8001",
    "https://github.com/SVisions/OCT-Software/pull/42#pullrequestreview-9999",
    "https://github.com/other/repo/pull/42#pullrequestreview-8001",
    "https://github.com:444/SVisions/OCT-Software/pull/42#pullrequestreview-8001",
  ]) {
    const runner = new FakeRunner([
      actor(),
      pages([reviewRecord(marker, { html_url })]),
    ]);
    assert.deepEqual(
      await createAdapter(runner).reconcile(reviewEnvelope()),
      {
        status: "error",
        error: { trust: "unknown", code: "GITHUB_PROTOCOL" },
      },
    );
  }
});

test("marker reconciliation asks gh to project only matching records", async () => {
  const marker = markerForGitHubAction(reviewEnvelope());
  const runner = new FakeRunner([
    actor(),
    pages([reviewRecord(marker)]),
  ]);

  assert.equal(
    (await createAdapter(runner).reconcile(reviewEnvelope())).status,
    "already",
  );
  assert.equal(runner.calls[1].args.includes("--jq"), true);
  assert.equal(runner.calls[1].args.at(-1).includes(marker), true);
});

test("reconciliation reports absence only after marker and current head checks", async () => {
  const runner = new FakeRunner([actor(), pages([]), head()]);
  const result = await createAdapter(runner).reconcile(reviewEnvelope());

  assert.deepEqual(result, { status: "absent", code: "GITHUB_MARKER_ABSENT" });
  assert.deepEqual(runner.calls[2].args, [
    "pr",
    "view",
    "https://github.com/SVisions/OCT-Software/pull/42",
    "--json",
    "headRefOid",
  ]);
});

test("a changed PR head is stale and never reaches a POST", async () => {
  const runner = new FakeRunner([actor(), pages([]), head(OTHER_HEAD)]);
  const result = await createAdapter(runner).execute(reviewEnvelope());

  assert.deepEqual(result, {
    status: "stale",
    expectedVersion: HEAD,
    actualVersion: OTHER_HEAD,
  });
  assert.equal(runner.calls.some((call) => call.args.includes("POST")), false);
});

test("COMMENT review execution keeps arbitrary body text off process argv", async () => {
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return commentReviewRecord(marker, {
        body: `${commentEnvelope().action.body}\n\n${marker}`,
      });
    },
  ]);
  const adapter = createAdapter(runner);
  const envelope = commentEnvelope();
  const result = await adapter.execute(envelope);
  const post = runner.calls.at(-1);
  const marker = markerFromPost(post);

  assert.equal(result.status, "applied");
  assert.deepEqual(post.args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/SVisions/OCT-Software/pulls/42/reviews",
    "--input",
    "-",
  ]);
  assert.equal(post.args.join(" ").includes("@notes.txt"), false);
  const payload = JSON.parse(post.input);
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.body.includes("@notes.txt &"), true);
  assert.equal(payload.commit_id, HEAD);
  assert.equal(post.command, GH_COMMAND);
  assert.equal(post.timeoutMs, 60_000);
});

test("review execution pins the exact commit and allowed event", async () => {
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return reviewRecord(marker, {
        body: `${reviewEnvelope().action.body}\n\n${marker}`,
      });
    },
  ]);
  const adapter = createAdapter(runner);
  const result = await adapter.execute(reviewEnvelope());
  const post = runner.calls.at(-1);
  const marker = markerFromPost(post);

  assert.equal(result.status, "applied");
  assert.deepEqual(post.args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/SVisions/OCT-Software/pulls/42/reviews",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(post.input), {
    event: "APPROVE",
    body: `${reviewEnvelope().action.body}\n\n${marker}`,
    commit_id: HEAD,
  });
});

test("a second actor or head check can stop a write immediately before POST", async () => {
  for (const responses of [
    [actor(), pages([]), head(), actor("different-user")],
    [actor(), pages([]), head(), actor(), head(OTHER_HEAD)],
  ]) {
    const runner = new FakeRunner(responses);
    const result = await createAdapter(runner).execute(reviewEnvelope());
    assert.notEqual(result.status, "applied");
    assert.equal(runner.calls.some((call) => call.args.includes("POST")), false);
  }
});

test("process and protocol failures expose only stable codes", async () => {
  const secret = "ghp_must_not_escape";
  const scenarios = [
    {
      response: new ManagedProcessError("PROCESS_TIMEOUT", "timed out", {
        details: { stdout: "", stderr: secret },
      }),
      code: "GITHUB_TIMEOUT",
      trust: "absent",
    },
    {
      response: { malformed: true },
      code: "GITHUB_PROTOCOL",
      trust: "absent",
    },
  ];
  for (const scenario of scenarios) {
    const runner = new FakeRunner([scenario.response]);
    if (!(scenario.response instanceof Error)) {
      runner.run = async function run(input) {
        this.calls.push(structuredClone(input));
        return {
          exitCode: 0,
          stdout: "not-json",
          stderr: secret,
          signal: null,
          durationMs: 1,
          truncated: false,
        };
      };
    }
    const result = await createAdapter(runner).execute(reviewEnvelope());
    assert.deepEqual(result, {
      status: "error",
      error: { trust: scenario.trust, code: scenario.code },
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("a transport failure becomes unknown only after the GitHub POST starts", async () => {
  const timeout = () =>
    new ManagedProcessError("PROCESS_TIMEOUT", "timed out", {
      details: { stdout: "", stderr: "private transport detail" },
    });
  const beforePost = new FakeRunner([actor(), timeout()]);
  assert.deepEqual(await createAdapter(beforePost).execute(reviewEnvelope()), {
    status: "error",
    error: { trust: "absent", code: "GITHUB_TIMEOUT" },
  });

  const duringPost = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    timeout(),
  ]);
  assert.deepEqual(await createAdapter(duringPost).execute(reviewEnvelope()), {
    status: "error",
    error: { trust: "unknown", code: "GITHUB_TIMEOUT" },
  });
  assert.equal(duringPost.calls.at(-1).args.includes("POST"), true);
});

test("approval is required before a write and repeated approval does not write twice", async () => {
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return reviewRecord(marker, {
        body: `Reviewed the error path.\n\n${marker}`,
      });
    },
  ]);
  const adapter = createAdapter(runner);
  let persisted = null;
  const store = {
    async read(_name, fallback) {
      return persisted === null ? structuredClone(fallback) : structuredClone(persisted);
    },
    async write(_name, value) {
      persisted = structuredClone(value);
    },
  };
  const leaseQueue = new OperationQueue();
  const queue = new ConfirmationQueue({
    store,
    executor: adapter,
    operationQueue: new OperationQueue(),
    exclusiveLease: { run: (operation) => leaseQueue.enqueue(operation) },
    clock: (() => {
      let second = 0;
      return () => new Date(`2026-08-02T01:00:0${second++}.000Z`);
    })(),
  });
  await queue.recover();
  const envelope = reviewEnvelope();
  await queue.enqueue({
    id: envelope.id,
    kind: envelope.kind,
    requestedBy: envelope.requestedBy,
    actor: envelope.actor,
    target: {
      provider: envelope.target.provider,
      resourceId: envelope.target.resourceId,
      version: envelope.target.version,
    },
    action: envelope.action,
    display: {
      title: "发布 PR Review",
      summary: "确认后才会写入 GitHub",
      actionLabel: "确认并发布到 GitHub",
      evidence: ["当前 Head 已复核"],
      payload: {
        actor: envelope.actor,
        target: {
          provider: envelope.target.provider,
          resourceId: envelope.target.resourceId,
          version: envelope.target.version,
        },
        action: envelope.action,
      },
    },
  });
  assert.equal(runner.calls.length, 0);

  const next = await queue.next();
  const request = {
    requestId: "request-approve-0001",
    expectedQueueRevision: next.queueRevision,
    expectedItemRevision: next.item.itemRevision,
    displayedPayloadDigest: next.item.displayedPayloadDigest,
    approvalBindingDigest: next.item.approvalBindingDigest,
  };
  const completed = await queue.approve(next.item.id, request);
  assert.equal(completed.status, "completed");
  assert.equal(runner.calls.filter((call) => call.args.includes("POST")).length, 1);

  await queue.approve(next.item.id, request);
  assert.equal(runner.calls.filter((call) => call.args.includes("POST")).length, 1);
});
