import { existsSync } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";

const [kind, ...cliArguments] = process.argv.slice(2);
if (!new Set(["codex-cli", "claude-cli"]).has(kind)) {
  process.exitCode = 2;
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;

  const request = JSON.parse(input);
  const cwd = process.cwd();
  const messageText = request.messages
    .map(({ content }) => content)
    .join("\n");
  const profileNames = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "TEMP",
    "TMP",
    "TMPDIR",
  ];
  const inside = (candidate) => {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
    const relative = path.relative(cwd, candidate);
    return relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
  };
  const codexHomeInsideCwd = inside(process.env.CODEX_HOME);
  let authVisible = false;
  if (messageText.includes("FIXTURE_REQUIRE_CODEX_LOGIN")) {
    try {
      const details = await lstat(
        path.join(process.env.CODEX_HOME, "auth.json"),
      );
      authVisible = details.isFile() && !details.isSymbolicLink();
    } catch {
      authVisible = false;
    }
    if (!authVisible || !codexHomeInsideCwd) process.exitCode = 4;
  }
  if (
    authVisible &&
    messageText.includes("FIXTURE_REFRESH_CODEX_LOGIN")
  ) {
    await writeFile(
      path.join(process.env.CODEX_HOME, "auth.json"),
      Buffer.from("fictional-refreshed-login-v1"),
      { flag: "w" },
    );
  }
  const observation = {
    kind,
    cwd,
    authVisible,
    codexHomeInsideCwd,
    profileRootsInsideCwd: profileNames.every((name) => inside(process.env[name])),
    forbiddenEnvironmentPresent: [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GIT_CONFIG_COUNT",
      "SSH_AUTH_SOCK",
      "NODE_OPTIONS",
      "PATH",
    ].filter((name) => Object.hasOwn(process.env, name)),
    hostRepositoryVisible: existsSync(path.join(cwd, ".git")),
    persistentSessionRequested: cliArguments.some((argument) =>
      new Set(["resume", "--continue", "--session-id", "--json"])
        .has(argument)
    ),
  };
  await writeFile(
    path.join(cwd, "fake-cli-observation.json"),
    JSON.stringify(observation),
    "utf8",
  );

  let result;
  if (messageText.includes("FIXTURE_MALFORMED_RESULT")) {
    result = "not-json";
  } else if (request.schema?.properties?.fixture) {
    result = JSON.stringify({ ok: true, fixture: observation });
  } else if (request.schema?.properties?.intent) {
    result = JSON.stringify({
      schemaVersion: 1,
      confidence: 98,
      summary: "The bounded fixture task is complete.",
      intent: {
        schemaVersion: 1,
        type: "complete",
        summary: "Complete the bounded fixture task.",
        reason: "The isolated fixture has enough evidence to finish locally.",
        outcome: "done",
        evidence: [],
      },
    });
  } else if (request.schema?.properties?.action) {
    const disallowed = messageText.includes("FIXTURE_DISALLOWED_ACTION");
    result = JSON.stringify({
      schemaVersion: 1,
      confidence: 96,
      summary: disallowed
        ? "Attempt a locally rejected write."
        : "Inspect one bounded source file.",
      reason: "The fixture exercises local Code Job decision validation.",
      action: disallowed
        ? { type: "write_text", path: "src/app.js", content: "rejected\n" }
        : { type: "read_text", path: "src/app.js" },
    });
  } else {
    result = JSON.stringify({ ok: true });
  }

  if (kind === "codex-cli") {
    const resultFlag = cliArguments.indexOf("--output-last-message");
    const resultFile = cliArguments[resultFlag + 1];
    if (resultFlag < 0 || !inside(resultFile)) {
      process.exitCode = 3;
    } else {
      await writeFile(
        resultFile,
        JSON.stringify({ result }),
        "utf8",
      );
      process.stdout.write(`${JSON.stringify({
        type: "thread.started",
        thread_id: "fixture-session",
      })}\n`);
    }
  } else {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result,
      session_id: "fixture-session",
      total_cost_usd: 0,
    }));
  }
}
