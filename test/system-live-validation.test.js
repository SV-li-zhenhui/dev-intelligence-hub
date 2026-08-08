import assert from "node:assert/strict";
import test from "node:test";

async function loadLiveValidation() {
  try {
    return await import("../scripts/system-live-validation.mjs");
  } catch (error) {
    assert.fail(`system live validation module is unavailable: ${error.message}`);
  }
}

function runtimeSource(overrides = {}) {
  return {
    schemaVersion: 1,
    headOid: "a".repeat(40),
    treeOid: "b".repeat(40),
    clean: true,
    runtimeDigest: "c".repeat(64),
    runtimeFileCount: 440,
    runtimeByteCount: 1_234_567,
    ...overrides,
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(body);
    },
  };
}

function liveFetch(source, { managed = true } = {}) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.endsWith("/api/live")) {
      return response({
        schemaVersion: 1,
        live: true,
        service: "mydashboard",
        processId: 1234,
        managed,
        lifecycleState: "running",
        ...(managed
          ? {
              instanceId: "12345678-1234-4123-8123-123456789abc",
              startIdentity: "d".repeat(64),
            }
          : {}),
        ...(source ? { runtimeSource: source } : {}),
      });
    }
    return response({
      ok: true,
      service: "mydashboard",
      processId: 1234,
      ...(source ? { runtimeSource: source } : {}),
    });
  };
  return { calls, fetch };
}

test("live validation accepts only the managed service with the exact frozen source", async () => {
  const expected = runtimeSource();
  const fake = liveFetch(expected);
  const { verifyLiveDashboard } = await loadLiveValidation();

  const identity = await verifyLiveDashboard({
    baseUrl: "http://127.0.0.1:4173",
    expectedRuntimeSource: expected,
    fetchFn: fake.fetch,
  });

  assert.deepEqual(identity, {
    processId: 1234,
    instanceId: "12345678-1234-4123-8123-123456789abc",
    startIdentity: "d".repeat(64),
    runtimeSource: expected,
  });
  assert.deepEqual(fake.calls, [
    "http://127.0.0.1:4173/api/live",
    "http://127.0.0.1:4173/api/health",
  ]);
});

test("live validation rejects missing, stale, mismatched, or unmanaged identities", async () => {
  const expected = runtimeSource();
  const { verifyLiveDashboard } = await loadLiveValidation();
  const fixtures = [
    { name: "missing", source: null, options: {}, error: /runtime source identity is missing/u },
    {
      name: "prior Head",
      source: runtimeSource({ headOid: "e".repeat(40) }),
      options: {},
      error: /runtime source identity does not match/u,
    },
    {
      name: "mismatched digest",
      source: runtimeSource({ runtimeDigest: "f".repeat(64) }),
      options: {},
      error: /runtime source identity does not match/u,
    },
    {
      name: "unmanaged",
      source: expected,
      options: { managed: false },
      error: /dashboard is not a running managed service/u,
    },
  ];
  for (const fixture of fixtures) {
    const fake = liveFetch(fixture.source, fixture.options);
    await assert.rejects(
      verifyLiveDashboard({
        baseUrl: "http://127.0.0.1:4173",
        expectedRuntimeSource: expected,
        fetchFn: fake.fetch,
      }),
      fixture.error,
      fixture.name,
    );
  }
});

test("live validation rejects a replacement process with the same runtime source", async () => {
  const expected = runtimeSource();
  const fake = liveFetch(expected);
  const { verifyLiveDashboard } = await loadLiveValidation();

  await assert.rejects(
    verifyLiveDashboard({
      baseUrl: "http://127.0.0.1:4173",
      expectedRuntimeSource: expected,
      expectedLiveService: {
        processId: 9999,
        instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        startIdentity: "e".repeat(64),
        runtimeSource: expected,
      },
      fetchFn: fake.fetch,
    }),
    /dashboard live process identity does not match/u,
  );
});
