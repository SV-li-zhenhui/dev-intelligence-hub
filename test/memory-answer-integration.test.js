import assert from "node:assert/strict";
import test from "node:test";

import { OllamaStructuredProvider } from "../src/adapters/ollama-structured-provider.js";
import { normalizeMemoryRecord } from "../src/domain/memory-record.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { MemoryAnswerService } from "../src/services/memory-answer-service.js";
import { MemoryContextRetriever } from "../src/services/memory-context-retriever.js";

function largeRecord(index) {
  return normalizeMemoryRecord({
    schemaVersion: 1,
    source: { kind: "integration", id: `provider-boundary-${index}` },
    occurredAt: `2026-08-05T01:02:${String(index).padStart(2, "0")}.000Z`,
    roleId: "developer",
    repository: "acme/repo",
    eventType: "memory.boundary",
    title: `上下文边界记录 ${index}`,
    summary: "验证检索包能够安全进入结构化模型适配器。",
    content: `${index}:`.padEnd(30 * 1024, "x"),
    evidence: [],
    tags: ["memory", "boundary"],
    sourceUrl: null,
    subjectNumber: null,
  });
}

test("maximum retrieval context remains below the provider single-message boundary", async () => {
  const records = Array.from({ length: 4 }, (_, index) => largeRecord(index + 1));
  let providerRequest = null;
  const provider = new OllamaStructuredProvider({
    fetch: async (_url, options) => {
      providerRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            schemaVersion: 1,
            status: "answered",
            claims: [{
              statement: "上下文边界已由本地记录验证。",
              citationIds: [records[0].recordId],
            }],
          }),
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const retriever = new MemoryContextRetriever({
    memorySearch: {
      async search() {
        return {
          items: records.map(({ recordId }) => ({ id: recordId })),
          nextCursor: null,
          totalMatched: records.length,
          indexHealthy: true,
        };
      },
    },
    contextReader: {
      async readRecords({ recordIds }) {
        return {
          journalRevision: 7,
          items: recordIds.map((recordId) => ({
            record: structuredClone(
              records.find((record) => record.recordId === recordId),
            ),
            labels: { authority: "raw", lifecycle: "current" },
          })),
        };
      },
    },
    maximumRecords: 12,
    maximumContextBytes: 112 * 1024,
  });
  const brain = {
    provider: "ollama",
    model: "qwen3.5:9b",
    remoteData: { requirements: false, code: false, memory: false },
  };
  const service = new MemoryAnswerService({
    contextRetriever: retriever,
    brainRouter: new BrainRouter({ providers: [provider] }),
    configuredBrain: brain,
    localBrain: brain,
  });

  const answer = await service.answer({
    schemaVersion: 1,
    question: "这些边界记录说明了什么？",
    mode: "configured",
    retrieval: { kind: "query", filters: { query: "边界记录" } },
  });

  assert.equal(answer.status, "answered");
  assert.equal(answer.context.truncated, true);
  assert.ok(answer.context.records.length > 0);
  assert.ok(answer.context.records.length < records.length);
  assert.ok(
    Buffer.byteLength(providerRequest.messages[1].content, "utf8") <=
      128 * 1024,
  );
});
