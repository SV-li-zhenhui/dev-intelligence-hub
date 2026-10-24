import { AsyncLocalStorage } from 'node:async_hooks';
import {OperationQueue} from './operation-queue.js';

const reservations = new AsyncLocalStorage();
const problem = code => Object.assign(new Error(code), {code, statusCode:503});

export function createNativeModelAdmission(capacity = 1) {
  return {capacity, active:new Set(), queue:[], blocked:false, lastStatus:null, markers:new Set(), unknownInvocations:new Map(), preparation:new OperationQueue()};
}

export function retainUnknownNativeInvocations(state, entries) {
  if (state.capacity <= 1 || [...state.active].some(token => !token.unknown)) return false;
  if (entries.some(entry => state.unknownInvocations.has(entry.file) && state.unknownInvocations.get(entry.file).entity !== entry.entity)) return false;
  const additions = entries.filter(entry => !state.unknownInvocations.has(entry.file));
  if (state.active.size + additions.length >= state.capacity) return false;
  for (const entry of additions) {
    const token = { entity: entry.entity, exclusive: false, unknown: true };
    state.active.add(token);
    state.unknownInvocations.set(entry.file, token);
    state.markers.add(entry.file);
  }
  return entries.length > 0;
}

function fits(state, entity, exclusive) {
  return !state.blocked && state.active.size < state.capacity &&
    ![...state.active].some(token => token.exclusive || exclusive || token.entity === entity);
}

function reserve(state, entity, exclusive) {
  const token = {state, entity, exclusive, inUse:false, released:false};
  state.active.add(token);
  token.release = () => {
    if (token.released) return;
    token.releaseRequested=true;
    if(token.inUse)return;
    token.released = true;
    state.active.delete(token);
    drain(state);
  };
  return token;
}

function drain(state) {
  if (state.blocked) {
    for (const entry of state.queue.splice(0)) entry.fail(problem('STRUCTURED_PROVIDER_REAP_FAILED'));
    return;
  }
  // A blocked entity does not stall other entities; an exclusive login probe
  // remains a barrier, so no model starts while it waits for the home to drain.
  const blockedEntities = new Set();
  for (const entry of [...state.queue]) {
    if (blockedEntities.has(entry.entity) || !fits(state, entry.entity, entry.exclusive)) {
      blockedEntities.add(entry.entity);
      if (entry.exclusive) break;
      continue;
    }
    state.queue.splice(state.queue.indexOf(entry), 1);
    entry.start(reserve(state, entry.entity, entry.exclusive));
    if (entry.exclusive) break;
  }
}

export function currentNativeAdmission(state) {
  const token = reservations.getStore();
  return token?.state === state && !token.released ? token : null;
}

export async function withNativeAdmission(state, entity, signal, operation, {waitForCapacity = false} = {}) {
  signal?.throwIfAborted();
  if (state.blocked) throw problem('STRUCTURED_PROVIDER_REAP_FAILED');
  const queuedCompetitor = state.queue.some(entry => entry.exclusive ||
    ![...state.unknownInvocations.values()].some(token => token.entity === entry.entity));
  if (!waitForCapacity && (queuedCompetitor || !fits(state, entity, false))) throw problem('STRUCTURED_PROVIDER_BUSY');
  const token = waitForCapacity ? await acquireNativeAdmission(state, entity, signal) : reserve(state, entity, false);
  return reservations.run(token, async () => {
    try { signal?.throwIfAborted(); return await operation(); }
    finally { token.release(); }
  });
}

export function acquireNativeAdmission(state, entity, signal, {exclusive = false} = {}) {
  if (state.blocked) return Promise.reject(problem('STRUCTURED_PROVIDER_REAP_FAILED'));
  return new Promise((resolve,reject) => {
    const cleanup = () => signal?.removeEventListener('abort',abort);
    const entry = {
      entity, exclusive,
      start(token) { cleanup(); resolve(token); },
      fail(error) { cleanup(); reject(error); },
    };
    const abort = () => {
      const index = state.queue.indexOf(entry);
      if (index >= 0) state.queue.splice(index,1);
      entry.fail(signal.reason ?? problem('STRUCTURED_PROVIDER_CANCELLED'));
      drain(state);
    };
    state.queue.push(entry);
    signal?.addEventListener('abort',abort,{once:true});
    if (signal?.aborted) abort();
    else drain(state);
  });
}
