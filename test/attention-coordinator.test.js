import assert from "node:assert/strict";
import test from "node:test";
import { AttentionCoordinator } from "../src/services/attention-coordinator.js";

function externalItem() {
  return {
    id: "github-review-1",
    kind: "github.pull_request.review",
    status: "pending",
    queueRevision: 4,
    itemRevision: 1,
    display: { title: "发布 PR Review" },
  };
}

function internalItem() {
  return {
    requestId: `attention-${"a".repeat(64)}`,
    type: "ask_user",
    question: "以哪个验收口径为准？",
    context: [],
    choices: [],
    revision: 2,
    contentDigest: "b".repeat(64),
    createdAt: "2026-08-02T01:00:00.000Z",
  };
}

test("external authorization stays first and storage/action ports remain separate", async () => {
  let internalReads = 0;
  const coordinator = new AttentionCoordinator({
    externalQueue: {
      async next() {
        return { queueRevision: 4, pendingCount: 3, item: externalItem() };
      },
      approve() {
        throw new Error("must not be exposed");
      },
    },
    internalInbox: {
      async next() {
        internalReads += 1;
        return internalItem();
      },
      answer() {
        throw new Error("must not be exposed");
      },
    },
  });

  assert.deepEqual(await coordinator.next(), {
    available: true,
    source: "external_confirmation",
    pendingCount: 3,
    externalQueueRevision: 4,
    item: externalItem(),
  });
  assert.equal(internalReads, 0);
  assert.deepEqual(Object.keys(coordinator), []);
  assert.equal(coordinator.externalQueue, undefined);
  assert.equal(coordinator.internalInbox, undefined);
  assert.equal(typeof coordinator.approve, "undefined");
  assert.equal(typeof coordinator.answer, "undefined");
});

test("falls through to exactly one internal request when no external action waits", async () => {
  const coordinator = new AttentionCoordinator({
    externalQueue: {
      async next() {
        return { queueRevision: 9, pendingCount: 0, item: null };
      },
    },
    internalInbox: { async next() { return internalItem(); } },
  });

  assert.deepEqual(await coordinator.next(), {
    available: true,
    source: "internal_request",
    pendingCount: 1,
    externalQueueRevision: 9,
    item: internalItem(),
  });
});

test("works with either queue disabled and returns one stable empty projection", async () => {
  const internalOnly = new AttentionCoordinator({
    internalInbox: { async next() { return internalItem(); } },
  });
  assert.equal((await internalOnly.next()).source, "internal_request");

  const externalOnly = new AttentionCoordinator({
    externalQueue: {
      async next() {
        return { queueRevision: 2, pendingCount: 0, item: null };
      },
    },
  });
  assert.deepEqual(await externalOnly.next(), {
    available: false,
    source: null,
    pendingCount: 0,
    externalQueueRevision: 2,
    item: null,
  });

  assert.deepEqual(await new AttentionCoordinator().next(), {
    available: false,
    source: null,
    pendingCount: 0,
    externalQueueRevision: 0,
    item: null,
  });
});

test("queue failures propagate instead of silently changing authorization priority", async () => {
  let internalRead = false;
  const coordinator = new AttentionCoordinator({
    externalQueue: {
      async next() {
        throw Object.assign(new Error("facts not ready"), { code: "FACTS_NOT_READY" });
      },
    },
    internalInbox: {
      async next() {
        internalRead = true;
        return internalItem();
      },
    },
  });

  await assert.rejects(coordinator.next(), (error) => error.code === "FACTS_NOT_READY");
  assert.equal(internalRead, false);
});

test("constructor rejects objects that are not read-only queue ports", () => {
  assert.throws(
    () => new AttentionCoordinator({ externalQueue: {} }),
    /externalQueue\.next/,
  );
  assert.throws(
    () => new AttentionCoordinator({ internalInbox: {} }),
    /internalInbox\.next/,
  );
});
