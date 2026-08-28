const TITLE_PREFIX = "[MyDashboard E2E]";
const TITLE_SUFFIX = "DO NOT MERGE";
const BRANCH_PREFIX = "test/mydashboard-e2e-";
const GITHUB_CLI_TIMEOUT_MS = 60_000;

function cleanupError(message) {
  const error = new Error(`Refusing to clean up live PR smoke artifact: ${message}`);
  error.code = "LIVE_PR_SMOKE_CLEANUP_REFUSED";
  return error;
}

function validateCleanupAuthority(pullRequest, authenticatedLogin) {
  if (!pullRequest || typeof pullRequest !== "object") {
    throw cleanupError("pull request facts are missing");
  }
  if (
    typeof pullRequest.title !== "string" ||
    !pullRequest.title.startsWith(TITLE_PREFIX) ||
    !pullRequest.title.includes(TITLE_SUFFIX)
  ) {
    throw cleanupError("title is not an explicit MyDashboard smoke marker");
  }
  if (
    typeof pullRequest.headRefName !== "string" ||
    !pullRequest.headRefName.startsWith(BRANCH_PREFIX)
  ) {
    throw cleanupError("head branch is outside the smoke-test namespace");
  }
  if (pullRequest.headRepository !== pullRequest.repository) {
    throw cleanupError("head branch belongs to another repository");
  }
  if (
    typeof authenticatedLogin !== "string" ||
    typeof pullRequest.author !== "string" ||
    pullRequest.author.toLocaleLowerCase("en-US") !==
      authenticatedLogin.toLocaleLowerCase("en-US")
  ) {
    throw cleanupError("authenticated account does not own the smoke PR");
  }
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1) {
    throw cleanupError("pull request number is invalid");
  }
  if (!new Set(["OPEN", "CLOSED"]).has(pullRequest.state)) {
    throw cleanupError("pull request is neither open nor safely closed");
  }
}

export async function runGitHubCli({
  execute,
  arguments_,
  timeoutMs = GITHUB_CLI_TIMEOUT_MS,
}) {
  if (
    typeof execute !== "function" ||
    !Array.isArray(arguments_) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new TypeError("GitHub CLI execution request is invalid");
  }
  const { stdout } = await execute("gh", arguments_, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout.trim();
}

export async function cleanupSmokePullRequest({
  pullRequest,
  authenticatedLogin,
  closePullRequest,
  deleteHeadBranch,
}) {
  validateCleanupAuthority(pullRequest, authenticatedLogin);
  if (typeof closePullRequest !== "function" || typeof deleteHeadBranch !== "function") {
    throw new TypeError("smoke PR cleanup operations are invalid");
  }
  const closed = pullRequest.state === "OPEN";
  if (closed) await closePullRequest(pullRequest);
  await deleteHeadBranch(pullRequest);
  return Object.freeze({ closed, branchDeleted: true });
}

export async function withSmokePullRequestCleanup({ run, cleanup }) {
  if (typeof run !== "function" || typeof cleanup !== "function") {
    throw new TypeError("live PR smoke lifecycle operations are invalid");
  }
  let runError = null;
  try {
    return await run();
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupFailure) {
      if (runError !== null) {
        throw new AggregateError(
          [runError, cleanupFailure],
          "Live PR smoke verification and cleanup both failed",
        );
      }
      throw cleanupFailure;
    }
  }
}

export const SMOKE_PULL_REQUEST_MARKERS = Object.freeze({
  titlePrefix: TITLE_PREFIX,
  titleSuffix: TITLE_SUFFIX,
  branchPrefix: BRANCH_PREFIX,
});
