import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import {
  GitActivityImporter,
  GitActivityImporterError,
} from "../src/services/git-activity-importer.js";

const REPOSITORY = "acme/command-center";
const FIRST_OID = "0123456789abcdef0123456789abcdef01234567";
const SECOND_OID = "fedcba9876543210fedcba9876543210fedcba98";

function activity(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    commits: [
      {
        oid: FIRST_OID,
        occurredAt: "2026-08-03T01:00:00.000Z",
        author: "Ada Example <ada@example.com>",
        subject: "Add cited memory retrieval",
        body: "Keep imported Git activity as evidence.",
      },
      {
        oid: SECOND_OID,
        occurredAt: "2026-08-03T01:01:00.000Z",
        author: "Grace Example <grace@example.com>",
        subject: "Harden import boundaries",
        body: "Reject unknown fields before any write.",
      },
    ],
    ...overrides,
  };
}

function contentAddressedProducer() {
  const records = new Map();
  const calls = [];
  return {
    calls,
    records,
    async appendBatch({ records: supplied }) {
      assert.strictEqual(this.calls, calls);
      calls.push({ records: structuredClone(supplied) });
      const items = supplied.map((candidate) => {
        const record = normalizeMemoryRecord(candidate);
        const created = !records.has(record.recordId);
        records.set(record.recordId, record);
        return { recordId: record.recordId, created };
      });
      return {
        added: items.filter(({ created }) => created).length,
        items,
        health: { ready: true, recordCount: records.size },
      };
    },
  };
}

function suppliedRecords(producer) {
  return producer.calls.flatMap(({ records }) => records);
}

test("identical Git activity imports are deterministic and idempotent", async () => {
  const producer = contentAddressedProducer();
  const importer = new GitActivityImporter({ memoryProducer: producer });
  const input = activity();

  const first = await importer.importCommits(input);
  const second = await importer.importCommits(structuredClone(input));

  assert.equal(first.added, 2);
  assert.equal(first.commitCount, 2);
  assert.equal(second.added, 0);
  assert.deepEqual(second.recordIds, first.recordIds);
  assert.deepEqual(producer.calls[1], producer.calls[0]);
  assert.equal(producer.records.size, 2);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.recordIds), true);

  const records = suppliedRecords(producer).slice(0, 2);
  assert.deepEqual(records.map(({ tags }) => tags), [
    ["git", "code"],
    ["git", "code"],
  ]);
  for (const [index, record] of records.entries()) {
    assert.equal(record.source.kind, "git-commit");
    assert.equal(
      record.source.id,
      `${REPOSITORY}:${[FIRST_OID, SECOND_OID][index]}`,
    );
    assert.equal(record.eventType, "git.commit");
    assert.equal(record.repository, REPOSITORY);
    assert.equal(record.sourceUrl, null);
    assert.equal(record.roleId, null);
    assert.equal(record.subjectNumber, null);
    assert.doesNotMatch(record.source.id, /[\\]/);
  }
});

test("commit messages remain inert JSON evidence without capabilities", async () => {
  const producer = contentAddressedProducer();
  const importer = new GitActivityImporter({ memoryProducer: producer });
  const marker = "__gitActivityImporterMustNotExecute";
  delete globalThis[marker];
  const unsafe = activity({
    commits: [{
      ...activity().commits[0],
      author: "attacker <attacker@example.com>",
      subject: "<script>globalThis." + marker + "=true</script>",
      body: '{"command":"rm -rf /","capabilities":["shell","network"]}',
    }],
  });

  await importer.importCommits(unsafe);

  assert.equal(globalThis[marker], undefined);
  const payload = JSON.parse(producer.calls[0].records[0].content);
  assert.deepEqual(Object.keys(payload), [
    "schemaVersion",
    "trust",
    "repository",
    "commit",
  ]);
  assert.equal(payload.trust, "untrusted");
  assert.deepEqual(Object.keys(payload.commit), [
    "oid",
    "occurredAt",
    "author",
    "subject",
    "body",
  ]);
  assert.equal("command" in payload.commit, false);
  assert.equal("capabilities" in payload.commit, false);
});

test("invalid shape, duplicate oids, unsafe paths, and bounds fail before writes", async () => {
  const producer = contentAddressedProducer();
  const importer = new GitActivityImporter({ memoryProducer: producer });
  let getterCalls = 0;
  const accessor = activity();
  Object.defineProperty(accessor, "repository", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return REPOSITORY;
    },
  });
  const tooMany = Array.from({ length: 101 }, (_, index) => ({
    ...activity().commits[0],
    oid: index.toString(16).padStart(40, "0"),
  }));
  const cases = [
    activity({ debug: true }),
    activity({ sourceRoot: "C:\\repo" }),
    activity({ repository: "C:\\repo" }),
    activity({ commits: [] }),
    activity({ commits: tooMany }),
    activity({ commits: [{ ...activity().commits[0], oid: FIRST_OID.toUpperCase() }] }),
    activity({ commits: [{ ...activity().commits[0], oid: "not-a-commit" }] }),
    activity({ commits: [{ ...activity().commits[0], oid: `${FIRST_OID}0` }] }),
    activity({ commits: [{ ...activity().commits[0], occurredAt: "2026-08-03" }] }),
    activity({ commits: [{ ...activity().commits[0], body: "x".repeat(12 * 1024 + 1) }] }),
    activity({ commits: [activity().commits[0], activity().commits[0]] }),
    accessor,
  ];

  for (const value of cases) {
    await assert.rejects(
      importer.importCommits(value),
      (error) => error instanceof GitActivityImporterError,
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(producer.calls.length, 0);
});

test("constructor binds only an own data appendBatch method", async () => {
  let optionsGetterCalls = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "memoryProducer", {
    enumerable: true,
    get() {
      optionsGetterCalls += 1;
      return {};
    },
  });
  assert.throws(
    () => new GitActivityImporter(accessorOptions),
    /options are invalid/,
  );
  assert.equal(optionsGetterCalls, 0);

  let appendGetterCalls = 0;
  const accessorPort = {};
  Object.defineProperty(accessorPort, "appendBatch", {
    enumerable: true,
    get() {
      appendGetterCalls += 1;
      return async () => {};
    },
  });
  assert.throws(
    () => new GitActivityImporter({ memoryProducer: accessorPort }),
    /appendBatch is invalid/,
  );
  assert.equal(appendGetterCalls, 0);

  let boundReceiver = null;
  const producer = {
    marker: "least-authority-port",
    async appendBatch({ records }) {
      boundReceiver = this.marker;
      records.forEach(normalizeMemoryRecord);
      return { added: records.length };
    },
  };
  const importer = new GitActivityImporter({ memoryProducer: producer });
  const result = await importer.importCommits(activity({ commits: [activity().commits[0]] }));
  assert.equal(boundReceiver, "least-authority-port");
  assert.equal(result.added, 1);
  assert.deepEqual(Object.keys(importer), []);
});
