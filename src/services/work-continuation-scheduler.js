import { randomUUID } from 'node:crypto';
import { OperationQueue } from '../lib/operation-queue.js';
import { currentWorkItemInputBinding } from './work-ledger-pr-source.js';
import {
  WORK_CONTINUATION_STATE_KEY, CONTINUATION_MAX_RECORDS, CONTINUATION_ROLES,
  continuationFingerprint, emptyWorkContinuations, migrateWorkContinuationState, normalizeWorkContinuationState,
} from './work-continuation-state.js';

const WAITING = new Set(['waiting_external', 'waiting_condition', 'dispatch_pending', 'retry_wait', 'paused']);
const TERMINAL = new Set(['completed', 'cancelled', 'superseded']);
const timeout = () => Object.assign(new Error('Work continuation execution exceeded its lease budget'), { code: 'WORK_CONTINUATION_TIMEOUT' });
const recovery = (action, reason, dueAt = null) => ({ action, reason, dueAt });
const graphProgress = value => typeof value?.graphProgressDigest === 'string' && /^[a-f0-9]{64}$/.test(value.graphProgressDigest)
  ? value.graphProgressDigest : null;
function conditionFor(item, fact) {
  let type = 'claimable';
  if (item.status === 'paused') type = 'manual_resume';
  else if (['waiting_external', 'dispatch_pending'].includes(item.status)) type = 'intent_result';
  else if (item.status === 'waiting_condition') type = 'fact_change';
  else if (item.status === 'retry_wait') type = 'retry_due';
  else if (fact?.graphBlocked) type = 'child_delivery';
  const progress = graphProgress(fact);
  return { type, reference: ['intent_result', 'fact_change'].includes(type) ? item.activeIntentId ?? null :
    ['claimable', 'child_delivery'].includes(type) && progress !== null ? `graph:${progress}` : null };
}
function sourceFor(item) {
  const binding = currentWorkItemInputBinding(item);
  return { rootItemId: binding?.rootItemId ?? (item.kind === 'source_root' ? item.itemId : null),
    parentItemId: item.graph?.parentItemId ?? null, inputRevision: binding?.inputRevision ?? null, itemRevision: item.revision };
}

// Wake records describe delivery, never execution authority. Roles retain their
// own claims, PR bindings, permissions, pause checks and external-effect receipts.
export class WorkContinuationScheduler {
  #queue = new OperationQueue();
  #ports;
  #active = new Map();
  #cursors = new Map();
  #lastRole = null;
  #cleanupCursor = 0;
  #nextPreparationAt = 0;
  #status = { pending: 0, waitingCount: 0, running: 0, overdueCount: 0, stalledCount: 0, stalled: [], handoffs: [], lastError: null };

  constructor({ store, ledger, configurationReader, roleStateReader, taskRuns = null, preparations = [], clock = () => new Date() }) {
    for (const [port, methods] of [[store, ['read', 'write']], [ledger, ['listClaimCandidates', 'listItems', 'readItemForReconciliation', 'readItemProgress']],
      [configurationReader, ['readActive']], [roleStateReader, ['read']]]) {
      if (methods.some(method => typeof port?.[method] !== 'function')) throw new TypeError('Invalid work continuation port');
    }
    this.#ports = { store, ledger, configurationReader, roleStateReader, taskRuns, preparations, clock };
  }

  readStatus() { return structuredClone(this.#status); }
  #now() { return new Date(this.#ports.clock()).toISOString(); }

  async #configuration() {
    const config = (await this.#ports.configurationReader.readActive())?.configuration;
    return config?.githubActions?.enabled === true &&
      (config.githubActions.automaticReview === true || config.githubActions.automaticOwnPrRepair === true) ? config : null;
  }

  async #page(method, options) {
    const cursor = this.#cursors.get(method);
    let page;
    try { page = await this.#ports.ledger[method]({ ...options, limit: 100, ...(cursor ? { cursor } : {}) }); }
    catch (error) {
      if (error?.code !== 'WORK_LEDGER_CURSOR_INVALID' || !cursor) throw error;
      page = await this.#ports.ledger[method]({ ...options, limit: 100 });
    }
    this.#cursors.set(method, page.nextCursor);
    return page;
  }

  runCycle({ dispatch, runOperation = operation => operation(), signal = null, allowDispatch = true } = {}) {
    return this.#queue.enqueue(async () => {
      signal?.throwIfAborted();
      const config = await this.#configuration();
      if (!config) return { started: 0, skipped: 'disabled' };
      if (typeof dispatch !== 'function') throw new TypeError('Work continuation dispatch is required');
      const preparationAt = Date.parse(this.#now());
      if (allowDispatch && preparationAt >= this.#nextPreparationAt) {
        this.#nextPreparationAt = preparationAt + 5_000;
        for (const prepare of this.#ports.preparations) {
          try { await prepare(); } catch { this.#status.lastError = 'reconciliation_failed'; }
        }
      }
      signal?.throwIfAborted();
      const now = this.#now();
      const raw = await this.#ports.store.read(WORK_CONTINUATION_STATE_KEY, emptyWorkContinuations());
      const state = migrateWorkContinuationState(raw);
      const before = JSON.stringify(raw);
      const cancellations = this.#recoverExecutions(state, now);
      if (!allowDispatch) {
        if (before !== JSON.stringify(state)) await this.#ports.store.write(WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState(state));
        this.#project(state);
        for (const active of cancellations) active.controller.abort(timeout());
        return { started: 0, skipped: 'facts_not_ready' };
      }
      await this.#retireObsolete(state, now);
      const page = await this.#page('listClaimCandidates', { at: now });
      const facts = new Map(page.facts.map(fact => [fact.itemId, fact]));
      const ordered = this.#ports.taskRuns ? await this.#ports.taskRuns.order(page.items, 'work-item', 'itemId') : page.items;
      const eligible = new Set(ordered.map(item => item.itemId));
      const discovered = new Map(page.items.map(item => [item.itemId, item]));
      try {
        const waiting = await this.#page('listItems', {});
        for (const item of waiting.items) if (WAITING.has(item.status) && !discovered.has(item.itemId)) discovered.set(item.itemId, item);
      } catch { this.#status.lastError = 'waiting_discovery_failed'; }
      const roleStates = new Map();
      const ready = [];
      for (const item of discovered.values()) {
        const roleId = item.currentTarget?.id;
        if (item.currentTarget?.type !== 'role' || !CONTINUATION_ROLES.has(roleId) ||
            item.source?.scope?.active === false || item.sourceQuarantine) continue;
        const fact = facts.get(item.itemId);
        if (!roleStates.has(roleId)) roleStates.set(roleId, await this.#ports.roleStateReader.read(roleId));
        const role = roleStates.get(roleId);
        const canRun = eligible.has(item.itemId) && fact &&
          (!fact.graphBlocked || (roleId === 'orchestrator' && (fact.submittedChildren > 0 || fact.orchestrationReady === true))) &&
          role?.enabled === true && role.paused === false;
        const condition = conditionFor(item, fact);
        if ((role?.enabled !== true || role.paused !== false || (fact && !eligible.has(item.itemId))) && !fact?.graphBlocked) {
          condition.type = 'manual_resume'; condition.reference = roleId;
        }
        const record = this.#record(state, item, condition, Boolean(canRun), now);
        if (record && canRun && !this.#active.has(roleId) && ['pending', 'retry_wait', 'stalled'].includes(record.status) &&
            (record.nextAttemptAt === null || Date.parse(record.nextAttemptAt) <= Date.parse(now))) ready.push(record);
      }
      const selected = this.#select(ready);
      const coordination = config.workCoordination;
      const budget = Math.max(1_000, (coordination?.leaseDurationMs ?? 120_000) +
        (coordination?.resolveTimeoutMs ?? 0) + (coordination?.decisionTimeoutMs ?? 0));
      for (const record of selected) {
        const receipt = { wakeId: `wake-${randomUUID()}`, roleId: record.roleId, fingerprint: record.fingerprint, startedAt: now,
          deadlineAt: new Date(Date.parse(now) + budget).toISOString(), finishedAt: null, outcome: 'running', observedRevision: null, errorCode: null };
        record.receipts.push(receipt);
        while (record.receipts.length > 5) record.receipts.splice(record.receipts.findIndex(receipt => receipt.outcome !== 'running'), 1);
        Object.assign(record, { status: 'running', attempt: Math.min(3, record.attempt + 1), updatedAt: now,
          recovery: recovery('watch_execution', 'work_ready', receipt.deadlineAt) });
      }
      if (before !== JSON.stringify(state)) await this.#ports.store.write(WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState(state));
      this.#project(state);
      // Persist a timeout request before asking the owner to stop. Keep the
      // active slot until the actual operation settles, including late I/O.
      for (const active of cancellations) active.controller.abort(timeout());
      for (const record of selected) {
        const claim = structuredClone(record);
        const active = { controller: new AbortController(), wakeId: claim.receipts.at(-1).wakeId };
        const executionSignal = signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal;
        this.#active.set(claim.roleId, active);
        active.promise = Promise.resolve().then(() => runOperation(() => this.#execute(claim, dispatch, executionSignal)))
          .catch(() => { this.#status.lastError = 'wake_receipt_failed'; })
          .finally(() => { if (this.#active.get(claim.roleId) === active) this.#active.delete(claim.roleId); });
      }
      return { started: selected.length, skipped: null };
    });
  }

  #recoverExecutions(state, now) {
    const cancellations = [];
    for (const record of state.records) {
      let currentRunning = false;
      for (const receipt of record.receipts.filter(receipt => receipt.outcome === 'running')) {
        const active = this.#active.get(receipt.roleId);
        const current = record.fingerprint === receipt.fingerprint && record.status === 'running';
        if (current) currentRunning = true;
        if (!active || active.wakeId !== receipt.wakeId) {
          Object.assign(receipt, { finishedAt: now, outcome: 'interrupted', errorCode: 'WORK_CONTINUATION_RECEIPT_INCOMPLETE' });
          if (current) currentRunning = false;
        } else if (Date.parse(receipt.deadlineAt) <= Date.parse(now) && !active.controller.signal.aborted) {
          receipt.errorCode = 'WORK_CONTINUATION_TIMEOUT';
          record.updatedAt = now;
          if (current) record.recovery = recovery('wait_for_stop', 'execution_timeout', now);
          cancellations.push(active);
        }
      }
      if (record.status === 'running' && !currentRunning) {
        Object.assign(record, { status: 'pending', attempt: Math.max(0, record.attempt - 1), reason: 'restart_recovery', nextAttemptAt: now, updatedAt: now,
          recovery: recovery('retry', 'restart_recovery', now) });
      }
    }
    return cancellations;
  }

  async #retireObsolete(state, now) {
    const cleanup = state.records.slice(this.#cleanupCursor, this.#cleanupCursor + 20)
      .filter(record => ['pending', 'waiting', 'retry_wait', 'stalled'].includes(record.status));
    this.#cleanupCursor = this.#cleanupCursor + 20 >= state.records.length ? 0 : this.#cleanupCursor + 20;
    const progress = cleanup.length ? await this.#ports.ledger.readItemProgress(cleanup.map(record => record.itemId)) : [];
    const byId = new Map(progress.map(item => [item.itemId, item]));
    for (const record of cleanup) {
      const item = byId.get(record.itemId);
      if (!item || item.currentTarget?.id !== record.roleId || TERMINAL.has(item.status) ||
          (item.status === 'blocked' && item.statusReason === 'pr_source_cross_root_cutover_retired')) {
        Object.assign(record, { status: 'superseded', reason: 'input_changed', updatedAt: now, nextAttemptAt: null,
          recovery: recovery('none', 'input_changed') });
      }
    }
  }

  #record(state, item, condition, canRun, now) {
    const fingerprint = continuationFingerprint(item);
    let record = state.records.find(record => record.itemId === item.itemId);
    const conditionChanged = record && (record.condition.type !== condition.type || record.condition.reference !== condition.reference);
    if (!record || record.fingerprint !== fingerprint || conditionChanged) {
      if (!record && state.records.length >= CONTINUATION_MAX_RECORDS) {
        const inactive = record => record.receipts.every(receipt => receipt.outcome !== 'running');
        let discard = state.records.findIndex(record => ['delivered', 'superseded'].includes(record.status) && inactive(record));
        if (discard < 0 && canRun) discard = state.records.findIndex(record => ['waiting', 'stalled'].includes(record.status) && inactive(record));
        if (discard < 0) { this.#status.lastError = 'continuation_capacity'; return null; }
        state.records.splice(discard, 1);
      }
      const reason = canRun ? 'work_ready' : 'waiting_condition';
      const next = { itemId: item.itemId, roleId: item.currentTarget.id, fingerprint, source: sourceFor(item), condition,
        status: canRun ? 'pending' : 'waiting', attempt: 0, reason, nextAttemptAt: canRun ? now : null,
        updatedAt: now, receipts: record?.receipts ?? [], recovery: recovery(canRun ? 'none' : 'await_condition', reason) };
      if (record) Object.assign(record, next); else state.records.push(record = next);
    } else if (canRun && record.status === 'waiting') {
      Object.assign(record, { status: 'pending', condition, nextAttemptAt: now, reason: 'work_ready', updatedAt: now, recovery: recovery('none', 'work_ready') });
    } else if (!canRun && ['pending', 'retry_wait', 'stalled'].includes(record.status)) {
      Object.assign(record, { status: 'waiting', condition, reason: 'waiting_condition', updatedAt: now, recovery: recovery('await_condition', 'waiting_condition') });
    }
    if (record.source.itemRevision === null) Object.assign(record, { source: sourceFor(item), condition });
    return record;
  }

  #select(ready) {
    const selected = [];
    const roles = [...CONTINUATION_ROLES];
    const offset = (roles.indexOf(this.#lastRole) + 1) % roles.length;
    for (let index = 0; index < roles.length && selected.length < 2; index += 1) {
      const roleId = roles[(index + offset) % roles.length];
      const record = ready.find(candidate => candidate.roleId === roleId);
      if (record) { selected.push(record); this.#lastRole = roleId; }
    }
    return selected;
  }

  async #execute(claim, dispatch, signal) {
    let result, observedRevision = null, errorCode = null, relatedProgressed = false;
    try {
      signal.throwIfAborted();
      const role = await this.#ports.roleStateReader.read(claim.roleId);
      const item = await this.#ports.ledger.readItemForReconciliation({ itemId: claim.itemId });
      if (!await this.#configuration() || role?.enabled !== true || role.paused !== false) result = 'runtime_deferred';
      else if (!item || continuationFingerprint(item) !== claim.fingerprint) result = 'input_changed';
      else if (this.#ports.taskRuns && (await this.#ports.taskRuns.order([item], 'work-item', 'itemId')).length === 0) result = 'runtime_deferred';
      else {
        const beforeProgress = /^graph:[a-f0-9]{64}$/.test(claim.condition.reference ?? '')
          ? await this.#relatedProgress(claim.itemId) : null;
        const dispatched = await dispatch({ roleId: claim.roleId, signal,
          continuationTarget: { itemId: claim.itemId, fingerprint: claim.fingerprint } });
        signal.throwIfAborted();
        if (dispatched?.skipped) result = 'runtime_deferred';
        else {
          const latest = await this.#ports.ledger.readItemForReconciliation({ itemId: claim.itemId });
          observedRevision = latest?.revision ?? null;
          if (latest !== null && observedRevision === item.revision && beforeProgress !== null) {
            const afterProgress = await this.#relatedProgress(claim.itemId);
            relatedProgressed = beforeProgress !== null && afterProgress !== null && beforeProgress !== afterProgress;
          }
          result = latest === null ? 'input_changed' : observedRevision !== item.revision || relatedProgressed ? 'role_woken' : 'no_progress';
        }
      }
    } catch (error) {
      result = signal.reason?.code === 'WORK_CONTINUATION_TIMEOUT' ? 'execution_timeout' : signal.aborted ? 'runtime_deferred' : 'wake_failed';
      errorCode = result === 'execution_timeout' ? 'WORK_CONTINUATION_TIMEOUT' :
        typeof error?.code === 'string' && /^[A-Z][A-Z0-9_:-]{0,127}$/.test(error.code) ? error.code : null;
    }
    await this.#queue.enqueue(async () => {
      const state = migrateWorkContinuationState(await this.#ports.store.read(WORK_CONTINUATION_STATE_KEY, emptyWorkContinuations()));
      const record = state.records.find(record => record.itemId === claim.itemId);
      const receipt = record?.receipts.find(receipt => receipt.wakeId === claim.receipts.at(-1).wakeId);
      if (!record || !receipt || receipt.outcome !== 'running') return;
      const now = this.#now();
      const outcomes = { role_woken: 'progressed', input_changed: 'superseded', runtime_deferred: 'deferred', no_progress: 'no_progress', wake_failed: 'failed', execution_timeout: 'timed_out' };
      Object.assign(receipt, { finishedAt: now, outcome: outcomes[result], observedRevision, errorCode });
      if (record.fingerprint === claim.fingerprint && record.status === 'running') {
        if (relatedProgressed && result === 'role_woken') {
          Object.assign(record, { status: 'pending', attempt: 0, reason: result, nextAttemptAt: now, updatedAt: now,
            recovery: recovery('none', result) });
        } else {
          if (result === 'runtime_deferred') record.attempt = Math.max(0, record.attempt - 1);
          const done = ['role_woken', 'input_changed'].includes(result);
          const nextAttemptAt = done ? null : new Date(Date.parse(now) + (record.attempt >= 3 ? 300_000 : 30_000 * Math.max(1, record.attempt))).toISOString();
          const status = done ? (result === 'role_woken' ? 'delivered' : 'superseded') : record.attempt >= 3 ? 'stalled' : 'retry_wait';
          Object.assign(record, { reason: result, updatedAt: now, status, nextAttemptAt,
            recovery: recovery(done ? 'none' : 'retry', result, nextAttemptAt) });
        }
      }
      await this.#ports.store.write(WORK_CONTINUATION_STATE_KEY, normalizeWorkContinuationState(state));
      this.#project(state);
    });
  }

  async #relatedProgress(itemId) {
    try {
      const items = await this.#ports.ledger.readItemProgress([itemId]);
      return graphProgress(items.find(item => item.itemId === itemId));
    } catch {
      this.#status.lastError = 'progress_observation_failed';
      return null;
    }
  }

  #project(state) {
    const stalled = state.records.filter(record => record.status === 'stalled');
    const active = state.records.filter(record => !['delivered', 'superseded'].includes(record.status));
    this.#status = { lastError: this.#status.lastError,
      pending: state.records.filter(record => ['pending', 'retry_wait'].includes(record.status)).length,
      waitingCount: state.records.filter(record => record.status === 'waiting').length,
      running: state.records.filter(record => record.status === 'running').length,
      overdueCount: state.records.filter(record => record.receipts.some(receipt => receipt.outcome === 'running' && receipt.errorCode === 'WORK_CONTINUATION_TIMEOUT')).length,
      stalledCount: stalled.length, stalled: stalled.slice(0, 20).map(({ itemId, roleId, reason }) => ({ itemId, roleId, reason })),
      handoffs: active.slice(-20).map(({ itemId, roleId, status, source, condition, recovery, receipts }) =>
        ({ itemId, roleId, status, source, condition, recovery, receipt: receipts.at(-1) ?? null })),
    };
  }
}
