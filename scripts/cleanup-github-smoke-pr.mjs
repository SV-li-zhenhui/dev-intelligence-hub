import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  cleanupSmokePullRequest,
  runGitHubCli,
} from "./github-smoke-pr-lifecycle.mjs";

const execute = promisify(execFile);

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!new Set(["--repo", "--pr"]).has(key) || !value) {
      throw new Error("Usage: node scripts/cleanup-github-smoke-pr.mjs --repo owner/repo --pr number");
    }
    parsed[key.slice(2)] = value;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(parsed.repo || "")) {
    throw new Error("--repo is invalid");
  }
  const number = Number(parsed.pr);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("--pr is invalid");
  return { repository: parsed.repo, number };
}

async function gh(arguments_) {
  return runGitHubCli({ execute, arguments_ });
}

const target = parseArguments(process.argv.slice(2));
const [authenticatedLogin, factsJson] = await Promise.all([
  gh(["api", "user", "--jq", ".login"]),
  gh([
    "pr",
    "view",
    String(target.number),
    "--repo",
    target.repository,
    "--json",
    "number,title,state,author,headRefName,headRepository,headRepositoryOwner",
  ]),
]);
const facts = JSON.parse(factsJson);
const pullRequest = {
  repository: target.repository,
  number: facts.number,
  title: facts.title,
  state: facts.state,
  author: facts.author?.login || "",
  headRepository: `${facts.headRepositoryOwner?.login || ""}/${facts.headRepository?.name || ""}`,
  headRefName: facts.headRefName,
};
const result = await cleanupSmokePullRequest({
  pullRequest,
  authenticatedLogin,
  closePullRequest: ({ repository, number }) => gh([
    "pr",
    "close",
    String(number),
    "--repo",
    repository,
    "--comment",
    "MyDashboard E2E verification finished; closing the temporary smoke-test PR.",
  ]),
  deleteHeadBranch: ({ repository, headRefName }) => gh([
    "api",
    "--method",
    "DELETE",
    `repos/${repository}/git/refs/heads/${headRefName}`,
  ]),
});

console.log(JSON.stringify({ repository: target.repository, number: target.number, ...result }));
