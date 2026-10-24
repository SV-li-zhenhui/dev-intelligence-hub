import assert from 'node:assert/strict';
import test from 'node:test';
import {readNativeModelCapacity} from '../src/lib/native-model-capacity.js';
import {createNativeModelAdmission,retainUnknownNativeInvocations} from '../src/lib/native-model-admission.js';

test('native deployment capacity defaults to serial and requires explicit validated opt-in',()=>{
  assert.deepEqual(readNativeModelCapacity({}),{maxConcurrentTurns:1,allowConcurrentNativeHome:false});
  assert.deepEqual(readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:'2',DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:'true'}),{maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  for(const value of ['0','5','2.0',' 2','NaN',''])assert.throws(()=>readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:value,DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:'true'}),/capacity/);
  for(const validated of [undefined,'false','1','TRUE'])assert.throws(()=>readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:'2',DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:validated}),/validation/);
});

test('unknown native reservations are idempotent, identity-bound, and never exceed validated capacity',()=>{
  const state=createNativeModelAdmission(2), entry={file:'/owned/marker.json',entity:'old-entity'};
  assert.equal(retainUnknownNativeInvocations(createNativeModelAdmission(1),[entry]),false);
  assert.equal(retainUnknownNativeInvocations(state,[entry]),true);
  assert.equal(retainUnknownNativeInvocations(state,[entry]),true);
  assert.equal(state.active.size,1);
  assert.equal(retainUnknownNativeInvocations(state,[{...entry,entity:'different'}]),false);
  assert.equal(retainUnknownNativeInvocations(state,[{file:'/owned/second.json',entity:'second'}]),false);
  assert.equal(state.active.size,1);
  state.active.add({entity:'running'});
  assert.equal(retainUnknownNativeInvocations(state,[entry]),true);
  assert.equal(retainUnknownNativeInvocations(state,[{file:'/owned/third.json',entity:'third'}]),false);
  assert.equal(state.active.size,2);
  assert.equal(state.unknownInvocations.size,1);
  const exclusive=createNativeModelAdmission(2); exclusive.active.add({entity:'login',exclusive:true});
  assert.equal(retainUnknownNativeInvocations(exclusive,[entry]),false);
});
