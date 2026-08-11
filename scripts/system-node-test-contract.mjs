export const distributionTestPath = "test/open-source-distribution.mjs";
export const u9PriorityTestPath = "test/00-u9-priority.mjs";
const u9ImplementationTestPath = "test/u9-mirrored-pr-end-to-end.mjs";
const legacyU9TestPath = "test/u9-mirrored-pr-end-to-end.test.js";
const canonicalU9PriorityTestSource = Buffer.from(
  'import "./u9-mirrored-pr-end-to-end.mjs";\n',
  "utf8",
);
const maximumNodeTestArgumentBytes = 24 * 1024;

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function selectCommittedNodeTestFiles({
  directFiles,
  u9PrioritySource,
}) {
  const files = new Set(directFiles);
  if (!files.has(u9PriorityTestPath)) {
    throw new Error("committed U9 priority test is unavailable");
  }
  if (!files.has(u9ImplementationTestPath)) {
    throw new Error("committed U9 implementation test is unavailable");
  }
  if (!files.has(distributionTestPath)) {
    throw new Error("committed distribution test is unavailable");
  }
  if (files.has(legacyU9TestPath)) {
    throw new Error("legacy direct U9 test path is ambiguous");
  }
  if (
    !Buffer.from(u9PrioritySource ?? []).equals(canonicalU9PriorityTestSource)
  ) {
    throw new Error("committed U9 priority test contents are invalid");
  }
  const regularTestFiles = [...files]
    .filter((relativePath) =>
      relativePath.endsWith(".test.js") ||
      relativePath.endsWith(".test.mjs")
    )
    .sort(compareUtf8Paths);
  const immutableFiles = [u9PriorityTestPath, ...regularTestFiles];
  const argumentBytes = immutableFiles.reduce(
    (total, relativePath) => total + Buffer.byteLength(relativePath) + 1,
    0,
  );
  if (argumentBytes > maximumNodeTestArgumentBytes) {
    throw new Error("immutable Node test file set is invalid or too large");
  }
  return immutableFiles;
}
