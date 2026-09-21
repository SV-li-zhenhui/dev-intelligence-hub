import assert from "node:assert/strict";
import test from "node:test";
import { attentionDigest } from "../src/domain/attention-contract.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { AttentionInbox } from "../src/services/attention-inbox.js";
import {
  createAttentionOutboxEntry,
  createAttentionResult,
} from "../src/services/attention-inbox-state.js";

class MemoryStore {
  constructor(value = null) {
    this.value = value === null ? null : structuredClone(value);
    this.readCount = 0;
    this.writeCount = 0;
    this.failWriteAt = null;
    this.writeThenFailAt = null;
    this.lastReadName = null;
    this.lastWriteName = null;
  }

  async read(name, fallback) {
    this.readCount += 1;
    this.lastReadName = name;
    return structuredClone(this.value ?? fallback);
  }

  async write(name, value) {
    this.writeCount += 1;
    this.lastWriteName = name;
    if (this.writeCount === this.failWriteAt) {
      throw new Error("disk unavailable");
    }
    this.value = structuredClone(value);
    if (this.writeCount === this.writeThenFailAt) {
      throw new Error("disk acknowledgement unavailable");
    }
  }
}

class ExclusiveLease {
  constructor() {
    this.runCount = 0;
  }

  run(operation) {
    this.runCount += 1;
    return operation();
  }
}

function tickingClock(start = Date.parse("2026-08-02T01:00:00.000Z")) {
  let tick = 0;
  return () => new Date(start + tick++ * 1_000);
}

function attentionRequest(overrides = {}) {
  return {
    requestKey: "work-42-question-1",
    type: "ask_user",
    producer: { roleId: "requirements-analyst", workItemId: "work-42" },
    question: "这个需求是否包含旧数据迁移？",
    context: [{ label: "需求", value: "升级本地记忆索引" }],
    choices: [
      { id: "yes", label: "包含", description: "迁移已有记录" },
      { id: "no", label: "不包含", description: "只处理新记录" },
    ],
    ...overrides,
  };
}

async function readyInbox({
  store = new MemoryStore(),
  clock = tickingClock(),
  authority,
} = {}) {
  const lease = new ExclusiveLease();
  const inbox = new AttentionInbox({
    store,
    clock,
    operationQueue: new OperationQueue(),
    exclusiveLease: lease,
    ...(authority === undefined ? {} : { authority }),
  });
  await inbox.recover();
  return { inbox, store, lease };
}

test("stale producer authority hides a pending request and rejects late answers", async () => {
  const checks = [];
  const authority = {
    async isCurrent(value) {
      checks.push(structuredClone(value));
      return false;
    },
  };
  const { inbox, store } = await readyInbox({ authority });
  const created = await inbox.create(attentionRequest());
  const writesAfterCreate = store.writeCount;

  assert.equal(await inbox.next(), null);
  await assert.rejects(
    inbox.answer(response(created, { type: "text", text: "too late" })),
    (error) =>
      error.code === "ATTENTION_REQUEST_STALE" && error.statusCode === 409,
  );
  assert.equal(store.writeCount, writesAfterCreate);
  assert.deepEqual(checks, [
    {
      requestKey: attentionRequest().requestKey,
      producer: attentionRequest().producer,
    },
    {
      requestKey: attentionRequest().requestKey,
      producer: attentionRequest().producer,
    },
  ]);
});

test("work ledger authority exposes its canonical current-request method", async () => {
  const checks = [];
  const authority = {
    async isAttentionRequestCurrent(value) {
      checks.push(structuredClone(value));
      return true;
    },
  };
  const { inbox } = await readyInbox({ authority });
  const created = await inbox.create(attentionRequest());

  assert.equal((await inbox.next()).requestId, created.requestId);
  assert.deepEqual(checks, [{
    requestKey: attentionRequest().requestKey,
    producer: attentionRequest().producer,
  }]);
});

test("next skips a stale oldest request and later cannot defer it", async () => {
  let currentRequestKey = null;
  const authority = {
    async isCurrent({ requestKey }) {
      return requestKey === currentRequestKey;
    },
  };
  const { inbox, store } = await readyInbox({ authority });
  const stale = await inbox.create(attentionRequest({
    requestKey: "work-intent-stale",
    question: "旧问题？",
  }));
  const current = await inbox.create(attentionRequest({
    requestKey: "work-intent-current",
    question: "当前问题？",
  }));
  currentRequestKey = "work-intent-current";
  const writesBeforeLater = store.writeCount;

  assert.equal((await inbox.next()).requestId, current.requestId);
  await assert.rejects(
    inbox.later(response(stale, { type: "later" })),
    (error) =>
      error.code === "ATTENTION_REQUEST_STALE" && error.statusCode === 409,
  );
  assert.equal(store.writeCount, writesBeforeLater);
});

function response(item, answer) {
  return {
    requestId: item.requestId,
    expectedRevision: item.revision,
    contentDigest: item.contentDigest,
    answer,
  };
}

function timelineEvent({ type, requestId, revision, at, contentDigest }) {
  const core = { type, requestId, revision, at, contentDigest };
  const eventDigest = attentionDigest(core);
  return {
    eventId: `attention-event-${eventDigest}`,
    eventDigest,
    ...core,
  };
}

test("a trusted producer persists a content-addressed request before it is visible", async () => {
  const { inbox, store, lease } = await readyInbox();
  const created = await inbox.create(attentionRequest());
  const next = await inbox.next();

  assert.match(created.requestId, /^attention-[a-f0-9]{64}$/);
  assert.match(created.contentDigest, /^[a-f0-9]{64}$/);
  assert.match(created.producerBindingDigest, /^[a-f0-9]{64}$/);
  assert.equal(created.status, "pending");
  assert.equal(created.revision, 1);
  assert.equal(store.lastWriteName, "attention-inbox");
  assert.equal(lease.runCount, 2);
  assert.deepEqual(next, {
    requestId: created.requestId,
    type: "ask_user",
    producer: attentionRequest().producer,
    question: attentionRequest().question,
    context: attentionRequest().context,
    choices: attentionRequest().choices,
    revision: 1,
    contentDigest: created.contentDigest,
    createdAt: "2026-08-02T01:00:00.000Z",
  });
  assert.equal(Object.hasOwn(next, "requestKey"), false);
  assert.equal(Object.hasOwn(next, "timeline"), false);
});

test("next returns the oldest actionable request and only advances after a terminal response", async () => {
  const { inbox, store } = await readyInbox();
  const first = await inbox.create(attentionRequest());
  const second = await inbox.create(
    attentionRequest({
      requestKey: "work-43-question-1",
      producer: { roleId: "requirements-analyst", workItemId: "work-43" },
      question: "第二个问题？",
    }),
  );

  assert.equal((await inbox.next()).requestId, first.requestId);
  const writesBeforeLater = store.writeCount;
  const revisionBeforeLater = store.value.revision;
  const later = await inbox.later(response(first, { type: "later" }));
  assert.equal(later.status, "pending");
  assert.equal(store.writeCount, writesBeforeLater);
  assert.equal(store.value.revision, revisionBeforeLater);
  assert.equal((await inbox.next()).requestId, first.requestId);
  assert.equal(
    (
      await inbox.next({
        deferred: [
          {
            requestId: first.requestId,
            contentDigest: first.contentDigest,
          },
        ],
      })
    ).requestId,
    second.requestId,
  );
  assert.equal(store.writeCount, writesBeforeLater);
  assert.equal(
    (
      await inbox.next({
        deferred: [
          {
            requestId: first.requestId,
            contentDigest: "0".repeat(64),
          },
        ],
      })
    ).requestId,
    first.requestId,
  );

  await inbox.answer(response(first, { type: "choice", choiceId: "yes" }));
  assert.notEqual((await inbox.next()).requestId, first.requestId);
});

test("next strictly bounds deferred request bindings without invoking accessors", async () => {
  const { inbox } = await readyInbox();
  let invoked = false;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "deferred", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });

  await assert.rejects(
    inbox.next(accessorOptions),
    (error) => error.code === "INVALID_ATTENTION_DEFERRED" && error.statusCode === 400,
  );
  assert.equal(invoked, false);
  await assert.rejects(
    inbox.next({
      deferred: Array.from({ length: 33 }, (_, index) => ({
        requestId: `attention-${index.toString(16).padStart(64, "0")}`,
        contentDigest: index.toString(16).padStart(64, "0"),
      })),
    }),
    (error) => error.code === "INVALID_ATTENTION_DEFERRED" && error.statusCode === 400,
  );
});

test("answer and reject only persist internal results and an immutable outbox", async () => {
  const { inbox, store } = await readyInbox();
  const answeredRequest = await inbox.create(attentionRequest());
  const answered = await inbox.answer(
    response(answeredRequest, { type: "text", text: "需要迁移最近一年的记录" }),
  );
  const rejectedRequest = await inbox.create(
    attentionRequest({
      requestKey: "work-44-question-1",
      producer: { roleId: "workflow-router", workItemId: "work-44" },
      type: "clarify_requirement",
      question: "是否拆分这个工作？",
      choices: [],
    }),
  );
  const rejected = await inbox.reject(
    response(rejectedRequest, { type: "reject", reason: "先补充上下文" }),
  );
  const batch = await inbox.readOutbox({ afterSequence: 0, limit: 10 });

  assert.equal(answered.status, "answered");
  assert.equal(rejected.status, "rejected");
  assert.equal(batch.items.length, 2);
  assert.deepEqual(
    batch.items.map((entry) => entry.result.answer),
    [
      { type: "text", text: "需要迁移最近一年的记录" },
      { type: "reject", reason: "先补充上下文" },
    ],
  );
  assert.deepEqual(
    batch.items.map((entry) => entry.sequence),
    [1, 2],
  );
  assert.equal(batch.nextSequence, 2);
  assert.equal(batch.highWatermark, 2);
  assert.equal(batch.oldestAvailableSequence, 1);
  assert.equal(JSON.stringify(store.value).includes("github"), false);
  assert.equal(JSON.stringify(store.value).includes("command"), false);
  assert.deepEqual(
    store.value.items.map((item) => item.timeline.map((event) => event.type)),
    [
      ["created", "answered"],
      ["created", "rejected"],
    ],
  );
});

test("same create and terminal response are idempotent while changed content conflicts", async () => {
  const { inbox, store } = await readyInbox();
  const created = await inbox.create(attentionRequest());
  const writesAfterCreate = store.writeCount;
  const duplicate = await inbox.create(attentionRequest());
  assert.deepEqual(duplicate, created);
  assert.equal(store.writeCount, writesAfterCreate);

  await assert.rejects(
    inbox.create(attentionRequest({ question: "同一个 requestKey 的不同问题" })),
    (error) => error.code === "ATTENTION_REQUEST_CONFLICT" && error.statusCode === 409,
  );

  const payload = response(created, { type: "choice", choiceId: "yes" });
  const resolved = await inbox.answer(payload);
  const writesAfterAnswer = store.writeCount;
  assert.deepEqual(await inbox.answer(payload), resolved);
  assert.equal(store.writeCount, writesAfterAnswer);

  await assert.rejects(
    inbox.answer(response(created, { type: "choice", choiceId: "no" })),
    (error) => error.code === "ATTENTION_RESPONSE_CONFLICT" && error.statusCode === 409,
  );
});

test("concurrent answers serialize to one durable result", async () => {
  const { inbox, store } = await readyInbox();
  const created = await inbox.create(attentionRequest());
  const yes = response(created, { type: "choice", choiceId: "yes" });
  const no = response(created, { type: "choice", choiceId: "no" });

  const outcomes = await Promise.allSettled([
    inbox.answer(yes),
    inbox.answer(no),
    inbox.answer(yes),
  ]);

  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 2);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(outcomes.find((entry) => entry.status === "rejected").reason.code, "ATTENTION_RESPONSE_CONFLICT");
  assert.equal(store.value.outbox.length, 1);
  assert.deepEqual(store.value.outbox[0].result.answer, yes.answer);
});

test("responses are bound to the exact request revision, digest, and declared choice", async () => {
  const { inbox } = await readyInbox();
  const created = await inbox.create(attentionRequest());

  await assert.rejects(
    inbox.answer({
      ...response(created, { type: "choice", choiceId: "yes" }),
      expectedRevision: created.revision + 1,
    }),
    (error) => error.code === "ATTENTION_REVISION_CONFLICT",
  );
  await assert.rejects(
    inbox.answer({
      ...response(created, { type: "choice", choiceId: "yes" }),
      contentDigest: "0".repeat(64),
    }),
    (error) => error.code === "ATTENTION_CONTENT_CONFLICT",
  );
  await assert.rejects(
    inbox.answer(response(created, { type: "choice", choiceId: "unknown" })),
    (error) => error.code === "ATTENTION_CHOICE_INVALID",
  );
  await assert.rejects(
    inbox.reject(response(created, { type: "text", text: "not a rejection" })),
    (error) => error.code === "INVALID_ATTENTION_RESPONSE",
  );
  await assert.rejects(
    inbox.answer(response(created, { type: "reject", reason: "wrong port" })),
    (error) => error.code === "INVALID_ATTENTION_RESPONSE",
  );
});

test("a failed durable write never advances memory, timeline, or outbox", async () => {
  const { inbox, store } = await readyInbox();
  const created = await inbox.create(attentionRequest());
  store.failWriteAt = store.writeCount + 1;

  await assert.rejects(
    inbox.answer(response(created, { type: "choice", choiceId: "yes" })),
    /disk unavailable/,
  );
  assert.equal((await inbox.next()).requestId, created.requestId);
  assert.equal(store.value.items[0].status, "pending");
  assert.equal(store.value.items[0].timeline.length, 1);
  assert.equal(store.value.outbox.length, 0);

  store.failWriteAt = null;
  const answered = await inbox.answer(
    response(created, { type: "choice", choiceId: "yes" }),
  );
  assert.equal(answered.status, "answered");
  assert.equal(store.value.outbox.length, 1);
});

test("retry reconciles a write that reached disk before its acknowledgement failed", async () => {
  const { inbox, store } = await readyInbox();
  const created = await inbox.create(attentionRequest());
  const payload = response(created, { type: "choice", choiceId: "yes" });
  store.writeThenFailAt = store.writeCount + 1;

  await assert.rejects(inbox.answer(payload), /disk acknowledgement unavailable/);
  assert.equal(store.value.items[0].status, "answered");
  assert.equal(store.value.outbox.length, 1);

  store.writeThenFailAt = null;
  const recovered = await inbox.answer(payload);
  assert.equal(recovered.status, "answered");
  assert.equal(store.value.outbox.length, 1);
});

test("recovery validates timeline and cross-record integrity and fails closed", async () => {
  const { inbox, store } = await readyInbox();
  const created = await inbox.create(attentionRequest());
  await inbox.answer(response(created, { type: "choice", choiceId: "yes" }));

  const recovered = await readyInbox({ store });
  assert.equal((await recovered.inbox.readOutbox()).items.length, 1);

  const corrupted = structuredClone(store.value);
  corrupted.items[0].timeline[1].type = "rejected";
  const broken = new AttentionInbox({
    store: new MemoryStore(corrupted),
    clock: tickingClock(),
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    broken.recover(),
    (error) => error.code === "ATTENTION_STATE_CORRUPTED" && error.statusCode === 500,
  );
  await assert.rejects(
    broken.next(),
    (error) => error.code === "ATTENTION_INBOX_NOT_READY",
  );
});

test("recovery rejects a content-addressed terminal event before its creation", async () => {
  const fixedClock = () => new Date("2026-08-02T01:00:00.000Z");
  const { inbox, store } = await readyInbox({ clock: fixedClock });
  const created = await inbox.create(attentionRequest());
  const answer = { type: "choice", choiceId: "yes" };
  await inbox.answer(response(created, answer));

  const item = store.value.items[0];
  const at = item.createdAt;
  item.timeline[0] = timelineEvent({
    type: "created",
    requestId: item.requestId,
    revision: 2,
    at,
    contentDigest: item.contentDigest,
  });
  item.result = createAttentionResult(item, answer, 1, at);
  item.revision = 1;
  item.updatedAt = at;
  item.timeline[1] = timelineEvent({
    type: "answered",
    requestId: item.requestId,
    revision: 1,
    at,
    contentDigest: item.result.contentDigest,
  });
  store.value.outbox = [createAttentionOutboxEntry(item, 1)];

  const broken = new AttentionInbox({
    store,
    clock: fixedClock,
    operationQueue: new OperationQueue(),
    exclusiveLease: new ExclusiveLease(),
  });
  await assert.rejects(
    broken.recover(),
    (error) => error.code === "ATTENTION_STATE_CORRUPTED",
  );
});

test("outbox cursors are bounded and provide a reliable monotonic feed", async () => {
  const { inbox } = await readyInbox();
  for (let index = 0; index < 3; index += 1) {
    const created = await inbox.create(
      attentionRequest({
        requestKey: `work-${index}-question`,
        producer: { roleId: "requirements-analyst", workItemId: `work-${index}` },
        question: `问题 ${index}`,
      }),
    );
    await inbox.answer(response(created, { type: "text", text: `答案 ${index}` }));
  }

  const first = await inbox.readOutbox({ afterSequence: 0, limit: 2 });
  const second = await inbox.readOutbox({ afterSequence: first.nextSequence, limit: 2 });
  assert.deepEqual(first.items.map((entry) => entry.sequence), [1, 2]);
  assert.deepEqual(second.items.map((entry) => entry.sequence), [3]);
  assert.equal(second.nextSequence, 3);
  assert.equal(second.highWatermark, 3);

  await assert.rejects(
    inbox.readOutbox({ afterSequence: -1, limit: 2 }),
    (error) => error.code === "INVALID_ATTENTION_CURSOR",
  );
  await assert.rejects(
    inbox.readOutbox({ afterSequence: null, limit: 2 }),
    (error) => error.code === "INVALID_ATTENTION_CURSOR",
  );
});

test("oldest selection is based on immutable creation revision, not array order", async () => {
  const { inbox, store } = await readyInbox();
  const first = await inbox.create(attentionRequest());
  await inbox.create(
    attentionRequest({
      requestKey: "work-43-question",
      producer: { roleId: "requirements-analyst", workItemId: "work-43" },
      question: "第二个问题？",
    }),
  );
  store.value.items.reverse();

  const recovered = await readyInbox({ store });
  assert.equal((await recovered.inbox.next()).requestId, first.requestId);
});
