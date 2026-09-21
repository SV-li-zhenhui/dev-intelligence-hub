const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const RESOURCE_TYPES = Object.freeze({
  issue: "issues",
  pull_request: "pull",
});

export function githubTargetUrl(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const route = RESOURCE_TYPES[input.resourceType];
  if (route === undefined || typeof input.resourceId !== "string") return null;

  const match = /^([^/#]+)\/([^/#]+)#([1-9][0-9]*)$/.exec(input.resourceId);
  if (match === null) return null;
  const [, owner, repository, numberText] = match;
  const number = Number(numberText);
  if (
    !GITHUB_OWNER.test(owner) ||
    !GITHUB_REPOSITORY.test(repository) ||
    repository === "." ||
    repository === ".." ||
    !Number.isSafeInteger(number)
  ) {
    return null;
  }

  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${route}/${number}`;
}

export function githubSourceEventUrl(value) {
  if (typeof value !== "string") return null;
  const match = /^(issue|pull_request)\.[A-Za-z0-9._-]+ · (.+)$/.exec(value);
  if (match === null) return null;
  return githubTargetUrl({
    resourceType: match[1],
    resourceId: match[2],
  });
}
