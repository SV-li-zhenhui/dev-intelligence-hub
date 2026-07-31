import assert from "node:assert/strict";
import test from "node:test";
import { diffSnapshots } from "../src/domain/snapshot-diff.js";

test("first snapshot is a silent baseline", () => {
  const result = diffSnapshots(null, { items: [{ id: "one" }] });
  assert.equal(result.baseline, true);
  assert.deepEqual(result.added, []);
});

test("detects important state changes without title noise", () => {
  const previous = {
    items: [{ id: "one", title: "old", ciStatus: "SUCCESS", state: "open" }],
  };
  const renamed = {
    items: [{ id: "one", title: "new", ciStatus: "SUCCESS", state: "open" }],
  };
  const failed = {
    items: [{ id: "one", title: "new", ciStatus: "FAILURE", state: "open" }],
  };
  assert.equal(diffSnapshots(previous, renamed).changed.length, 0);
  assert.equal(diffSnapshots(previous, failed).changed.length, 1);
});

test("detects items leaving the active set", () => {
  const result = diffSnapshots(
    { items: [{ id: "one", state: "open" }] },
    { items: [] },
  );
  assert.equal(result.removed[0].id, "one");
});

test("detects responsibility and head transitions", () => {
  const previous = {
    items: [
      {
        id: "pr",
        actionState: "waiting_other",
        nextAction: "wait_author_changes",
        headRefOid: "head-1",
      },
    ],
  };
  const current = {
    items: [
      {
        id: "pr",
        actionState: "action_now",
        nextAction: "rereview",
        headRefOid: "head-2",
      },
    ],
  };

  assert.equal(diffSnapshots(previous, current).changed.length, 1);
});
