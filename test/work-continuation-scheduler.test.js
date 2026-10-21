import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkContinuationScheduler, WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState } from '../src/services/work-continuation-scheduler.js';

const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  let persisted;
  let now = Date.parse('2026-10-21T00:00:00.000Z');
  const items = [{ itemId: 'work-one', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'developer' } }];
  const role = { enabled: true, paused: false };
  const config = { githubActions: { enabled: true, automaticOwnPrRepair: true } };
  const operations = [];
  const dispatched = [];
  const store = {
    async read(key, fallback) { assert.equal(key, WORK_CONTINUATION_STATE_KEY); return clone(persisted ?? fallback); },
    async write(key, state) { assert.equal(key, WORK_CONTINUATION_STATE_KEY); persisted = normalizeWorkContinuationState(state); },
  };
  const ledger = {
    async listClaimCandidates() { return { items: clone(items), nextCursor: null, facts: items.map(item => ({ itemId: item.itemId, graphBlocked: false })) }; },
    async readItemForReconciliation({ itemId }) { return clone(items.find(item => item.itemId === itemId) ?? null); },
    async readItemProgress(ids) { return clone(items.filter(item => ids.includes(item.itemId))); },
  };
  const options = { store, ledger, configurationReader: { async readActive() { return { configuration: config }; } },
    roleStateReader: { async read() { return role; } }, clock: () => new Date(now) };
  const dispatch = async ({ roleId }) => {
    assert.ok(persisted.records.some(record => record.roleId === roleId && record.status === 'running'), 'intent must be durable before dispatch');
    dispatched.push(roleId);
    items.filter(item => item.currentTarget.id === roleId).forEach(item => { item.revision += 1; });
  };
  const runOperation = operation => { const running = operation(); operations.push(running); return running; };
  return { items, role, config, options, store, ledger, dispatched, dispatch, runOperation,
    state: () => clone(persisted), seed: value => { persisted = clone(value); },
    advance: ms => { now += ms; }, async drain() { await Promise.all(operations.splice(0)); } };
}

test('a durable wake survives restart and advances through the existing role dispatch', async () => {
  const f = fixture();
  const first = new WorkContinuationScheduler(f.options);
  await first.runCycle({ dispatch: f.dispatch, runOperation: async () => { throw new Error('admission closed'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().records[0].status, 'running');
  assert.equal(first.readStatus().lastError, 'wake_receipt_failed');
  assert.equal(f.dispatched.length, 0);
  const restarted = new WorkContinuationScheduler(f.options);
  await restarted.runCycle(f);
  await f.drain();
  assert.deepEqual(f.dispatched, ['developer']);
  assert.equal(f.state().records[0].status, 'delivered');
});

test('interrupted third attempts recover without exceeding the persisted schema', async () => {
  const f = fixture();
  await new WorkContinuationScheduler(f.options).runCycle({ dispatch: f.dispatch, runOperation: async () => {} });
  const state = f.state(); state.records[0].attempt = 3; f.seed(state);
  await new WorkContinuationScheduler(f.options).runCycle(f);
  await f.drain();
  assert.equal(f.state().records[0].attempt, 3);
  assert.equal(f.state().records[0].status, 'delivered');
});

test('no dispatch occurs when the durable intent cannot be saved', async () => {
  const f = fixture(); f.store.write = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(new WorkContinuationScheduler(f.options).runCycle(f), /disk unavailable/);
  assert.equal(f.dispatched.length, 0);
});

test('lost wake acknowledgement recovers in the same process without losing the intent', async () => {
  const f = fixture(); const write = f.store.write; let writes = 0;
  f.store.write = async (...args) => { if (++writes === 2) throw new Error('ack write failed'); return write(...args); };
  const scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle(f); await assert.rejects(f.drain(), /ack write failed/);
  await new Promise(resolve => setImmediate(resolve));
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'delivered');
  assert.equal(f.dispatched.length, 2);
});

test('slow roles coalesce while other roles advance and old acknowledgements cannot overwrite a new revision', async () => {
  const f = fixture(); const blocked = deferred();
  f.items.push({ itemId: 'work-test', revision: 1, status: 'queued', currentTarget: { type: 'role', id: 'tester' } });
  const scheduler = new WorkContinuationScheduler(f.options);
  let developerRuns = 0;
  const dispatch = async ({ roleId }) => {
    if (roleId === 'developer') { developerRuns += 1; await blocked.promise; }
    else await f.dispatch({ roleId });
  };
  await scheduler.runCycle({ ...f, dispatch });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.dispatched, ['tester']);
  f.items[0].revision += 1;
  await scheduler.runCycle({ ...f, dispatch });
  assert.equal(developerRuns, 1);
  const pending = f.state().records.find(record => record.itemId === 'work-one');
  assert.equal(pending.status, 'pending');
  blocked.resolve(); await f.drain();
  assert.equal(f.state().records.find(record => record.itemId === 'work-one').fingerprint, pending.fingerprint);
  assert.equal(f.state().records.find(record => record.itemId === 'work-one').status, 'pending');
});

test('repeated unchanged inputs back off and remain recoverable after stalled diagnostics', async () => {
  const f = fixture(); const scheduler = new WorkContinuationScheduler(f.options); let calls = 0;
  const input = { ...f, dispatch: async () => { calls += 1; } };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await scheduler.runCycle(input); await f.drain();
    await scheduler.runCycle(input); await f.drain();
    assert.equal(calls, attempt + 1);
    f.advance(90_000);
  }
  assert.equal(scheduler.readStatus().stalledCount, 1);
  f.advance(300_000);
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'delivered');
});

test('automatic mode, role pause, task pause and graph dependencies retain their boundaries', async () => {
  for (const boundary of ['mode', 'role', 'task', 'graph', 'scope']) {
    const f = fixture();
    if (boundary === 'mode') f.config.githubActions.enabled = false;
    if (boundary === 'role') f.role.paused = true;
    if (boundary === 'task') f.options.taskRuns = { async order() { return []; } };
    if (boundary === 'graph') {
      const list = f.ledger.listClaimCandidates;
      f.ledger.listClaimCandidates = async () => { const page = await list(); page.facts[0].graphBlocked = true; return page; };
    }
    if (boundary === 'scope') f.items[0].source = { scope: { active: false } };
    await new WorkContinuationScheduler(f.options).runCycle(f); await f.drain();
    assert.equal(f.dispatched.length, 0, boundary);
  }
});

test('task pause introduced after persistence is rechecked before dispatch', async () => {
  const f = fixture(); let paused = false;
  f.options.taskRuns = { async order(items) { return paused ? [] : items; } };
  await new WorkContinuationScheduler(f.options).runCycle({ ...f, runOperation: operation => {
    paused = true; return f.runOperation(operation);
  } });
  await f.drain(); assert.equal(f.dispatched.length, 0);
  assert.equal(f.state().records[0].reason, 'runtime_deferred');
  assert.equal(f.state().records[0].attempt, 0);
});

test('role rotation, bounded cursor recovery and failed preparation do not starve ready work', async () => {
  const f = fixture();
  f.items.push(...['tester', 'orchestrator', 'pr-engineer', 'requirements-analyst'].map((id, index) => ({
    itemId: `work-${index}`, revision: 1, status: 'queued', currentTarget: { type: 'role', id },
  })));
  const scheduler = new WorkContinuationScheduler({ ...f.options, preparations: [async () => { throw new Error('one unavailable reconciler'); }] });
  for (let count = 0; count < 3; count += 1) { await scheduler.runCycle(f); await f.drain(); }
  assert.equal(new Set(f.dispatched).size, 5);
  assert.equal(scheduler.readStatus().lastError, 'reconciliation_failed');
  const list = f.ledger.listClaimCandidates; let cursorCalls = 0;
  f.ledger.listClaimCandidates = async options => {
    cursorCalls += 1;
    if (options.cursor) throw Object.assign(new Error('revision changed'), { code: 'WORK_LEDGER_CURSOR_INVALID' });
    return { ...await list(), nextCursor: 'page-two' };
  };
  await scheduler.runCycle(f); await f.drain();
  await scheduler.runCycle(f); await f.drain();
  assert.equal(cursorCalls, 3);
});

test('obsolete and terminal pending intents are retired without dispatch', async () => {
  const f = fixture(); const scheduler = new WorkContinuationScheduler(f.options);
  await scheduler.runCycle({ dispatch: f.dispatch, runOperation: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  f.items.splice(0);
  await scheduler.runCycle(f); await f.drain();
  assert.equal(f.state().records[0].status, 'superseded');
  assert.equal(f.dispatched.length, 0);
});

test('persisted continuation timestamps and unknown schema versions fail validation', () => {
  assert.throws(() => normalizeWorkContinuationState({ schemaVersion: 2, records: [] }));
  assert.throws(() => normalizeWorkContinuationState({ schemaVersion: 1, records: [{
    itemId: 'work-one', roleId: 'developer', fingerprint: 'a'.repeat(64), attempt: 1,
    status: 'running', reason: 'work_ready', updatedAt: 123, nextAttemptAt: null,
  }] }));
});

test('adjacent completion signals share preparations and cleanup reads one bounded batch', async () => {
  const f = fixture(); let prepared = 0; let batches = 0; let durableReads = 0;
  const read = f.ledger.readItemForReconciliation;
  f.ledger.readItemForReconciliation = async args => { durableReads += 1; return read(args); };
  const progress = f.ledger.readItemProgress;
  f.ledger.readItemProgress = async ids => { batches += 1; assert.ok(ids.length <= 20); return progress(ids); };
  const scheduler = new WorkContinuationScheduler({ ...f.options, preparations: [async () => { prepared += 1; }] });
  const input = { ...f, dispatch: async () => {} };
  await scheduler.runCycle(input); await f.drain();
  const before = durableReads;
  await scheduler.runCycle(input); await f.drain();
  assert.equal(prepared, 1); assert.equal(batches, 1); assert.equal(durableReads, before);
  f.advance(5_000); await scheduler.runCycle(input); await f.drain(); assert.equal(prepared, 2);
});
