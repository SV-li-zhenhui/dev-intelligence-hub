import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { workspaceRevisionFromFileHashes } from "../src/domain/workspace-revision.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function expected(entries) {
  const digest = createHash("sha256");
  for (const [relativePath, fileHash] of entries) {
    digest.update(relativePath, "utf8");
    digest.update("\0");
    digest.update(fileHash, "utf8");
    digest.update("\0");
  }
  return digest.digest("hex");
}

test("workspace revisions are order independent and preserve the broker algorithm", () => {
  const ordered = [
    ["src/a.js", SHA_A],
    ["src/b.js", SHA_B],
  ];

  assert.equal(workspaceRevisionFromFileHashes(ordered), expected(ordered));
  assert.equal(
    workspaceRevisionFromFileHashes([...ordered].reverse()),
    expected(ordered),
  );
  assert.equal(workspaceRevisionFromFileHashes([]), expected([]));
});

test("workspace revisions reject malformed and duplicate entries", () => {
  const cases = [
    null,
    [["", SHA_A]],
    [["src/a.js", "not-a-digest"]],
    [["src/a.js", SHA_A, "extra"]],
    [
      ["src/a.js", SHA_A],
      ["src/a.js", SHA_B],
    ],
  ];

  for (const value of cases) {
    assert.throws(() => workspaceRevisionFromFileHashes(value), TypeError);
  }
});
