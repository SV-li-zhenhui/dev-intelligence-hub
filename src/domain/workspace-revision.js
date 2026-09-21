import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function workspaceRevisionFromFileHashes(fileHashes) {
  if (fileHashes === null || fileHashes === undefined) {
    throw new TypeError("fileHashes must be iterable");
  }

  const entries = [];
  const paths = new Set();
  for (const entry of fileHashes) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      entry[0].length === 0 ||
      !SHA256.test(entry[1]) ||
      paths.has(entry[0])
    ) {
      throw new TypeError("fileHashes contains an invalid entry");
    }
    paths.add(entry[0]);
    entries.push([entry[0], entry[1]]);
  }

  entries.sort(([left], [right]) => compareText(left, right));
  const digest = createHash("sha256");
  for (const [relativePath, fileHash] of entries) {
    digest.update(relativePath, "utf8");
    digest.update("\0");
    digest.update(fileHash, "utf8");
    digest.update("\0");
  }
  return digest.digest("hex");
}
