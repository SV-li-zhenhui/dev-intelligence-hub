import assert from 'node:assert/strict';
import test from 'node:test';
import {readNativeModelCapacity} from '../src/lib/native-model-capacity.js';

test('native deployment capacity defaults to serial and requires explicit validated opt-in',()=>{
  assert.deepEqual(readNativeModelCapacity({}),{maxConcurrentTurns:1,allowConcurrentNativeHome:false});
  assert.deepEqual(readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:'2',DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:'true'}),{maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  for(const value of ['0','5','2.0',' 2','NaN',''])assert.throws(()=>readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:value,DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:'true'}),/capacity/);
  for(const validated of [undefined,'false','1','TRUE'])assert.throws(()=>readNativeModelCapacity({DIH_CODEX_NATIVE_MAX_CONCURRENT_TURNS:'2',DIH_CODEX_NATIVE_CONCURRENCY_VALIDATED:validated}),/validation/);
});
