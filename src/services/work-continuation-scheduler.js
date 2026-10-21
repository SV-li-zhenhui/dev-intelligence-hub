import { createHash } from 'node:crypto';
import { OperationQueue } from '../lib/operation-queue.js';

export const WORK_CONTINUATION_STATE_KEY = 'work-continuations';
const MAX_RECORDS = 1_000;
const ROLES = new Set(['developer', 'tester', 'pr-engineer', 'orchestrator', 'requirements-analyst']);
const STATUSES = new Set(['pending', 'running', 'delivered', 'retry_wait', 'stalled', 'superseded']);
const digest = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ schemaVersion: 1, records: [] });
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fingerprintOf = item => digest(JSON.stringify([item.itemId, item.revision, item.currentTarget?.id]));

export function normalizeWorkContinuationState(value) {
  if (!value || value.schemaVersion !== 1 || Object.keys(value).sort().join() !== 'records,schemaVersion' ||
      !Array.isArray(value.records) || value.records.length > MAX_RECORDS) throw new Error('Invalid work continuation state');
  const ids = new Set();
  for (const record of value.records) {
    if (!record || Object.keys(record).sort().join() !== 'attempt,fingerprint,itemId,nextAttemptAt,reason,roleId,status,updatedAt' ||
        typeof record.itemId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/.test(record.itemId) || ids.has(record.itemId) ||
        !ROLES.has(record.roleId) || !STATUSES.has(record.status) || !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
        !Number.isSafeInteger(record.attempt) || record.attempt < 0 || record.attempt > 3 ||
        !timestamp(record.updatedAt) ||
        (record.nextAttemptAt !== null && !timestamp(record.nextAttemptAt)) ||
        !['work_ready', 'role_woken', 'runtime_deferred', 'wake_failed', 'no_progress', 'input_changed', 'restart_recovery'].includes(record.reason)) {
      throw new Error('Invalid work continuation record');
    }
    ids.add(record.itemId);
  }
  return structuredClone(value);
}

// Wake receipts are scheduling intent, never execution authority. The existing
// role loop still checks claims, PR input bindings, permissions and pause state.
export class WorkContinuationScheduler {
  #queue = new OperationQueue();
  #ports;
  #active = new Map();
  #cursor = null;
  #lastRole = null;
  #cleanupCursor = 0;
  #nextPreparationAt = 0;
  #status = { pending: 0, running: 0, stalledCount: 0, stalled: [], lastError: null };

  constructor({ store, ledger, configurationReader, roleStateReader, taskRuns = null, preparations = [], clock = () => new Date() }) {
    for (const [port, methods] of [[store, ['read', 'write']], [ledger, ['listClaimCandidates', 'readItemForReconciliation', 'readItemProgress']],
      [configurationReader, ['readActive']], [roleStateReader, ['read']]]) {
      if (methods.some(method => typeof port?.[method] !== 'function')) throw new TypeError('Invalid work continuation port');
    }
    this.#ports = { store, ledger, configurationReader, roleStateReader, taskRuns, preparations, clock };
  }

  readStatus() { return structuredClone(this.#status); }

  runCycle({ dispatch, runOperation = operation => operation(), signal = null } = {}) {
    return this.#queue.enqueue(async () => {
      signal?.throwIfAborted();
      if (!await this.#enabled()) return { started: 0, skipped: 'disabled' };
      if (typeof dispatch !== 'function') throw new TypeError('Work continuation dispatch is required');
      const now = new Date(this.#ports.clock()).toISOString();
      if (Date.parse(now) >= this.#nextPreparationAt) {
        this.#nextPreparationAt = Date.parse(now) + 5_000;
        for (const prepare of this.#ports.preparations) {
          try { await prepare(); } catch { this.#status.lastError = 'reconciliation_failed'; }
        }
      }
      signal?.throwIfAborted();
      let state = normalizeWorkContinuationState(await this.#ports.store.read(WORK_CONTINUATION_STATE_KEY, empty()));
      const before = JSON.stringify(state);
      for (const record of state.records) if (record.status === 'running' && !this.#active.has(record.roleId)) {
        Object.assign(record, { status: 'pending', attempt: Math.max(0, record.attempt - 1), reason: 'restart_recovery', nextAttemptAt: now });
      }
      // Retire obsolete wake intents in bounded pages; retain paused work for resume.
      const cleanup = state.records.slice(this.#cleanupCursor, this.#cleanupCursor + 20)
        .filter(record => ['pending', 'retry_wait', 'stalled'].includes(record.status));
      this.#cleanupCursor = this.#cleanupCursor + 20 >= state.records.length ? 0 : this.#cleanupCursor + 20;
      // This batch is only housekeeping; dispatch independently rereads durable authority.
      const progress = cleanup.length ? await this.#ports.ledger.readItemProgress(cleanup.map(record => record.itemId)) : [];
      const progressById = new Map(progress.map(item => [item.itemId, item]));
      for (const record of cleanup) {
        const item = progressById.get(record.itemId);
        if (!item || item.currentTarget?.id !== record.roleId || ['completed', 'cancelled', 'superseded'].includes(item.status)) {
          Object.assign(record, { status: 'superseded', reason: 'input_changed', updatedAt: now, nextAttemptAt: null });
        }
      }
      let page;
      try { page = await this.#ports.ledger.listClaimCandidates({ at: now, limit: 100, ...(this.#cursor ? { cursor: this.#cursor } : {}) }); }
      catch (error) {
        if (error?.code !== 'WORK_LEDGER_CURSOR_INVALID' || !this.#cursor) throw error;
        this.#cursor = null;
        page = await this.#ports.ledger.listClaimCandidates({ at: now, limit: 100 });
      }
      this.#cursor = page.nextCursor;
      const facts = new Map(page.facts.map(fact => [fact.itemId, fact]));
      const ordered = this.#ports.taskRuns ? await this.#ports.taskRuns.order(page.items, 'work-item', 'itemId') : page.items;
      const roleStates = new Map();
      const ready = [];
      for (const item of ordered) {
        const roleId = item.currentTarget?.id;
        const fact = facts.get(item.itemId);
        if (item.currentTarget?.type !== 'role' || !ROLES.has(roleId) || !fact ||
            (fact.graphBlocked && !(roleId === 'orchestrator' && fact.submittedChildren > 0)) ||
            item.source?.scope?.active === false || item.sourceQuarantine) continue;
        if (!roleStates.has(roleId)) roleStates.set(roleId, await this.#ports.roleStateReader.read(roleId));
        const role = roleStates.get(roleId);
        if (role?.enabled !== true || role.paused !== false) continue;
        const fingerprint = fingerprintOf(item);
        let record = state.records.find(record => record.itemId === item.itemId);
        if (!record || record.fingerprint !== fingerprint) {
          if (state.records.length >= MAX_RECORDS && !record) {
            const discard = state.records.findIndex(record => ['delivered', 'superseded', 'stalled'].includes(record.status));
            if (discard < 0) continue;
            state.records.splice(discard, 1);
          }
          const next = { itemId: item.itemId, roleId, fingerprint, status: 'pending', attempt: 0,
            reason: 'work_ready', nextAttemptAt: now, updatedAt: now };
          if (record) Object.assign(record, next); else state.records.push(record = next);
        }
        if (!this.#active.has(roleId) && ['pending', 'retry_wait', 'stalled'].includes(record.status) &&
            (record.nextAttemptAt === null || Date.parse(record.nextAttemptAt) <= Date.parse(now))) ready.push(record);
      }
      const selected = new Map();
      const roleOrder = [...ROLES];
      const offset = (roleOrder.indexOf(this.#lastRole) + 1) % roleOrder.length;
      for (let index = 0; index < roleOrder.length && selected.size < 2; index += 1) {
        const roleId = roleOrder[(index + offset) % roleOrder.length];
        const record = ready.find(candidate => candidate.roleId === roleId);
        if (record) { selected.set(roleId, record); this.#lastRole = roleId; }
      }
      for (const record of selected.values()) Object.assign(record, { status: 'running', attempt: Math.min(3, record.attempt + 1), updatedAt: now });
      if (before !== JSON.stringify(state)) await this.#ports.store.write(WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState(state));
      this.#project(state);
      for (const record of selected.values()) {
        const claim = structuredClone(record);
        const running = Promise.resolve().then(() => runOperation(() => this.#execute(claim, dispatch, signal)))
          .catch(() => { this.#status.lastError = 'wake_receipt_failed'; })
          .finally(() => { if (this.#active.get(claim.roleId) === running) this.#active.delete(claim.roleId); });
        this.#active.set(claim.roleId, running);
      }
      return { started: selected.size, skipped: null };
    });
  }

  async #enabled() {
    const config = (await this.#ports.configurationReader.readActive())?.configuration;
    return config?.githubActions?.enabled === true &&
      (config.githubActions.automaticReview === true || config.githubActions.automaticOwnPrRepair === true);
  }

  async #execute(claim, dispatch, signal) {
    let result;
    try {
      signal?.throwIfAborted();
      const role = await this.#ports.roleStateReader.read(claim.roleId);
      const item = await this.#ports.ledger.readItemForReconciliation({ itemId: claim.itemId });
      if (!await this.#enabled() || role?.enabled !== true || role.paused !== false) result = 'runtime_deferred';
      else if (!item || fingerprintOf(item) !== claim.fingerprint) result = 'input_changed';
      else if (this.#ports.taskRuns && (await this.#ports.taskRuns.order([item], 'work-item', 'itemId')).length === 0) result = 'runtime_deferred';
      else {
        const dispatched = await dispatch({ roleId: claim.roleId, signal });
        if (dispatched?.skipped) result = 'runtime_deferred';
        else {
          const latest = await this.#ports.ledger.readItemForReconciliation({ itemId: claim.itemId });
          result = latest?.revision === item.revision ? 'no_progress' : 'role_woken';
        }
      }
    } catch { result = signal?.aborted ? 'runtime_deferred' : 'wake_failed'; }
    await this.#queue.enqueue(async () => {
      const state = normalizeWorkContinuationState(await this.#ports.store.read(WORK_CONTINUATION_STATE_KEY, empty()));
      const record = state.records.find(record => record.itemId === claim.itemId && record.fingerprint === claim.fingerprint);
      if (!record || record.status !== 'running') return;
      const now = new Date(this.#ports.clock()).toISOString();
      if (result === 'runtime_deferred') record.attempt = Math.max(0, record.attempt - 1);
      Object.assign(record, { reason: result, updatedAt: now,
        status: result === 'role_woken' ? 'delivered' : result === 'input_changed' ? 'superseded' : record.attempt >= 3 ? 'stalled' : 'retry_wait',
        nextAttemptAt: ['role_woken', 'input_changed'].includes(result) ? null : new Date(Date.parse(now) + (record.attempt >= 3 ? 300_000 : 30_000 * Math.max(1, record.attempt))).toISOString() });
      await this.#ports.store.write(WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState(state));
      this.#project(state);
    });
  }

  #project(state) {
    const stalled = state.records.filter(r => r.status === 'stalled');
    this.#status = { lastError: this.#status.lastError, pending: state.records.filter(r => ['pending', 'retry_wait'].includes(r.status)).length,
      running: state.records.filter(r => r.status === 'running').length,
      stalledCount: stalled.length,
      stalled: stalled.slice(0, 20).map(({ itemId, roleId, reason }) => ({ itemId, roleId, reason })) };
  }
}
