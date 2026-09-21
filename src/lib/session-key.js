const INVALID_CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_SESSION_KEY_BYTES = 512;
const GITHUB_ENTITY_KINDS = new Set(["issue", "pull_request"]);

export function normalizeSessionKey(value, name = "sessionKey") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_SESSION_KEY_BYTES
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

export function githubEntitySessionKey({ kind, repository, number } = {}) {
  if (
    !GITHUB_ENTITY_KINDS.has(kind) ||
    typeof repository !== "string" ||
    !repository.trim() ||
    INVALID_CONTROL.test(repository) ||
    Buffer.byteLength(repository, "utf8") > 256 ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new TypeError("GitHub entity session identity is invalid");
  }
  return normalizeSessionKey(
    `github:${kind}:${repository.toLowerCase()}#${number}`,
  );
}
