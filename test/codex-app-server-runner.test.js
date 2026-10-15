import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServerRunner,didAppServerNotStart,didAppServerNotStartModel,didAppServerReap } from '../src/lib/codex-app-server-runner.js';
import { ManagedProcess } from '../src/lib/managed-process.js';
import { TaskRunRegistry } from '../src/services/task-run-registry.js';
import { withTaskExecution } from '../src/lib/task-execution-context.js';
import { createTestSupervisedProcessRunner } from '../src/lib/supervised-process-runner.js';
const threadId='01973bca-3d8b-7000-a000-123456789abc';

test('late native activity after failure cannot change runtime receipts while reap drains',async()=>{
  let release;const stopGate={promise:new Promise(resolve=>{release=resolve;})};
  const f=fixture({hold:true,stopGate}),events=[];
  await invocation(f.runner,async run=>{
    const operation=withTaskExecution({reportProgress(){},reportEvent:event=>events.push(event)},run);void operation.catch(()=>{});
    while(!f.calls.some(call=>call.method==='turn/start'))await new Promise(resolve=>setImmediate(resolve));
    f.send({method:'error',params:{threadId,willRetry:false}});
    await f.stopping;
    f.send({method:'item/agentMessage/delta',params:{threadId,turnId:'turn-1',itemId:'late',delta:'LATE_PRIVATE_BODY'}});
    release();await assert.rejects(operation);
    assert.equal(events.length,0);
  });
});
test('production app-server certifies invalid invocations as not started',async()=>{
  const runner=new CodexAppServerRunner({materialize:async()=>assert.fail('must not materialize or spawn')});
  await assert.rejects(runner.run({}),error=>error.code==='STRUCTURED_PROVIDER_UNAVAILABLE' && didAppServerNotStart(error));
});
function fixture({hold=false,failed=false,stopFailure=false,manualInterrupt=false,stopGate=null,steerTurnId=null,initializationFailure=false,codeJob=false,toolInventory=null,onInterrupt=null}={}) {
  let options; const calls=[]; let finish,interruptId,signalStopping;
  const stopping=new Promise(resolve=>{signalStopping=resolve;});
  const done = new Promise((r)=>{finish=r;});
  const send=(value)=>options.onLine({stream:'stdout',line:JSON.stringify(value)});
  const complete=()=>{send({method:'item/completed',params:{threadId,turnId:'turn-1',item:{type:'agentMessage',text:'{"result":"{\\"ok\\":true}"}'}}});send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:failed?'failed':'completed'}}});};
  const process={done,exited:false,start(value){options=value;},write(line){
    const request=JSON.parse(line); if(!request.id)return;
    calls.push(request); let result={};
    if(request.method==='initialize' && initializationFailure){send({id:request.id,error:{code:-32600,message:'fixture startup refused'}});return;}
    if(request.method==='config/read') result={config:{
      features:{...Object.fromEntries(['shell_tool','apps','browser_use','computer_use','image_generation','hooks','plugins','remote_plugin','plugin_sharing','skill_search','skill_mcp_dependency_install','goals','memories','workspace_dependencies','multi_agent_v2','code_mode','multi_agent'].map(name=>[name,false])),skip_host_skill_discovery:true,code_mode_host:true},
      agents:{enabled:false},web_search:'disabled',approval_policy:'never',sandbox_mode:'read-only',model_provider:'openai',notify:[],mcp_servers:{old:{url:'private'}},
    }};
    if(request.method.startsWith('thread/'))result={thread:{id:threadId}};
    if(request.method.startsWith('thread/') && codeJob)Object.assign(result,{approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}});
    if(request.method==='mcpServerStatus/list') {
      const namespace=Object.keys(calls.find(call=>call.method.startsWith('thread/')).params.config.mcp_servers).find(name=>name.startsWith('dih_code_job_'));
      result={data:[{name:namespace,tools:Object.fromEntries((toolInventory??['perform_action','read_source','get_state']).map(name=>[name,{}]))}],nextCursor:null};
    }
    if(request.method==='turn/start')result={turn:{id:'turn-1'}};
    if(request.method==='turn/steer')result=steerTurnId===false?{}:{turnId:steerTurnId??'turn-1'};
    if(request.method==='turn/interrupt')onInterrupt?.();
    if(request.method==='turn/interrupt' && manualInterrupt){interruptId=request.id;return;}
    send({id:request.id,result});
    if(request.method==='turn/start' && !hold)queueMicrotask(complete);
    if(request.method==='turn/interrupt')queueMicrotask(()=>send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'interrupted'}}}));
  },async stop(){signalStopping();await stopGate?.promise;if(stopFailure)throw new Error('not confirmed');this.exited=true;finish({code:0,signal:null});}};
  return {runner:new CodexAppServerRunner({processFactory:()=>process,materialize:async()=>({command:'codex',prefixArgs:[]})}),calls,complete,send,stopping,
    acknowledgeInterrupt:()=>send({id:interruptId,result:{}}),
    interrupted:()=>send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'interrupted'}}})};
}
async function invocation(runner,execute=(run)=>run(),appServerOverrides={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'dih-app-server-'));
  try{return await execute(()=>runner.run({executable:{},args:['app-server'],cwd:directory,env:{},timeoutMs:1000,
    appServer:{input:'safe task',model:'test-model',schema:{type:'object'},previous:null,...appServerOverrides}}),directory);}
  finally{await rm(directory,{recursive:true,force:true});}
}
test('app-server initializes, starts a bound turn, writes structured output and confirms exit',async()=>{
  const f=fixture();
  await invocation(f.runner,async(run,directory)=>{
    const result=await run(); assert.equal(result.exitCode,0);
    assert.match(result.stdoutBytes.toString(),/thread.started/);
    assert.equal(JSON.parse(await readFile(path.join(directory,'last-message.json'),'utf8')).result,'{"ok":true}');
  });
  assert.deepEqual(f.calls.map(x=>x.method),['initialize','thread/start','turn/start']);
  assert.equal(f.calls[2].params.approvalPolicy,'never');
  assert.equal(f.calls[2].params.sandboxPolicy.type,'readOnly');
});
test('live steering goes to the same active turn without rerunning the operation',async()=>{
  const f=fixture({hold:true}); let state=null;
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>state??v,write:async(_k,v)=>{state=structuredClone(v);}},settleControl:async()=>{}});
  await invocation(f.runner,async(run)=>{
    const result=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    let view; for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(r=>setImmediate(r));}
    assert.equal(view.live,true);
    await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'instruct',instruction:'check thread safety'});
    f.complete(); await result;
    assert.equal(f.calls.filter(x=>x.method==='turn/start').length,1);
    assert.equal(f.calls.find(x=>x.method==='turn/steer').params.expectedTurnId,'turn-1');
  });
});
test('failed turns never publish a structured result',async()=>{
  await assert.rejects(invocation(fixture({failed:true}).runner),e=>e.code==='STRUCTURED_PROVIDER_PROCESS_FAILED' && didAppServerReap(e));
});

test('a reaped initialization failure certifies no model turn without claiming no process spawned',async()=>{
  await assert.rejects(invocation(fixture({initializationFailure:true}).runner),error=>
    didAppServerNotStartModel(error) && !didAppServerNotStart(error));
});

test('unknown terminal status is not accepted as a completed response',async()=>{
  const f=fixture({hold:true});
  await assert.rejects(invocation(f.runner,async run=>{
    const result=run();void result.catch(()=>{});
    for(let i=0;i<100&&!f.calls.some(x=>x.method==='turn/start');i++)await new Promise(resolve=>setImmediate(resolve));
    await new Promise(resolve=>setImmediate(resolve));
    f.send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'inProgress'}}});return result;
  }),{code:'STRUCTURED_PROVIDER_RESPONSE_INVALID'});
});
test('unconfirmed process stop remains fenced',async()=>{
  await assert.rejects(invocation(fixture({stopFailure:true}).runner),e=>e.code==='STRUCTURED_PROVIDER_REAP_FAILED' && !didAppServerReap(e));
});

test('the real managed stdio process exchanges RPC frames without closing its input early',async()=>{
  const source=`import readline from 'node:readline';const send=x=>console.log(JSON.stringify(x));readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method.startsWith('thread/'))result={thread:{id:'${threadId}'}};if(r.method==='turn/start')result={turn:{id:'turn-1'}};send({id:r.id,result});if(r.method==='turn/start'){send({method:'item/completed',params:{threadId:'${threadId}',turnId:'turn-1',item:{type:'agentMessage',text:JSON.stringify({result:JSON.stringify({ok:true})})}}});send({method:'turn/completed',params:{threadId:'${threadId}',turn:{id:'turn-1',status:'completed'}}});}});`;
  const runner=new CodexAppServerRunner({processFactory:()=>new ManagedProcess(),materialize:async()=>({command:process.execPath,prefixArgs:['--input-type=module','-e',source]})});
  const result=await invocation(runner);assert.equal(result.exitCode,0);
});

test('contained stdio drives RPC through the Windows Job Object supervisor', {skip:process.platform!=='win32'},async(t)=>{
  const source=`const send=x=>console.log(JSON.stringify(x));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method.startsWith('thread/'))result={thread:{id:'${threadId}'}};if(r.method==='turn/start')result={turn:{id:'turn-1'}};send({id:r.id,result});if(r.method==='turn/start'){send({method:'item/completed',params:{threadId:'${threadId}',turnId:'turn-1',item:{id:'final',type:'agentMessage',text:JSON.stringify({result:JSON.stringify({ok:true})})}}});send({method:'turn/completed',params:{threadId:'${threadId}',turn:{id:'turn-1',status:'completed'}}});}});`;
  const processRunner=createTestSupervisedProcessRunner({descriptorMaterializer:async descriptor=>descriptor});
  const runner=new CodexAppServerRunner({processRunner});
  const directory=await mkdtemp(path.join(tmpdir(),'contained-app-server-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const result=await runner.run({executable:{command:process.execPath,prefixArgs:['-e',source]},args:[],cwd:directory,env:{},timeoutMs:15_000,
    appServer:{input:'safe task',model:'test-model',schema:{type:'object'},previous:null}});
  assert.equal(runner.supportsContainedExecution,true);
  assert.equal(result.exitCode,0);
  assert.equal(JSON.parse(await readFile(path.join(directory,'last-message.json'),'utf8')).result,'{"ok":true}');
});

test('live pause waits for interrupted turn and confirmed process exit before settling',async()=>{
  const f=fixture({hold:true});let state=null;const settlements=[];
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>state??v,write:async(_k,v)=>{state=structuredClone(v);}},settleControl:async(input)=>settlements.push(input)});
  await invocation(f.runner,async(run)=>{
    const result=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    const rejected=assert.rejects(result,e=>e.code==='TASK_RUN_PAUSED');
    let view;for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(r=>setImmediate(r));}
    await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});
    await rejected;assert.equal(settlements[0].command,'pause');assert.equal((await registry.list()).held[0].phase,'paused');
  });
});

test('interrupt acknowledgement and turn interruption do not settle pause before confirmed exit',async()=>{
  let releaseStop;const stopGate={promise:new Promise(resolve=>{releaseStop=resolve;})};
  const f=fixture({hold:true,manualInterrupt:true,stopGate});let saved=null;const settlements=[];
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>saved??v,write:async(_k,v)=>{saved=structuredClone(v);}},settleControl:async value=>settlements.push(value)});
  await invocation(f.runner,async(run)=>{
    const running=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    const stopped=assert.rejects(running,error=>error.code==='TASK_RUN_PAUSED');
    let view;for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(resolve=>setImmediate(resolve));}
    const control=registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});
    for(let i=0;i<100 && !f.calls.some(call=>call.method==='turn/interrupt');i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settlements.length,0);f.acknowledgeInterrupt();await control;
    assert.equal((await registry.list()).items[0].pendingCommand,'pause');assert.equal(settlements.length,0);
    f.interrupted();await f.stopping;assert.equal(settlements.length,0);
    assert.equal((await registry.list()).items[0].pendingCommand,'pause');
    releaseStop();await stopped;assert.equal(settlements.length,1);
  });
});

test('a registry-bound reap failure remains stop-unconfirmed after interruption',async()=>{
  const f=fixture({hold:true,stopFailure:true});let saved=null;let settlements=0;
  const registry=new TaskRunRegistry({store:{read:async(_k,v)=>saved??v,write:async(_k,v)=>{saved=structuredClone(v);}},settleControl:async()=>{settlements++;}});
  await invocation(f.runner,async(run)=>{
    const running=registry.run({kind:'work-item',taskId:'work-1',roleId:'reviewer',title:'Review',subject:'repo#1',revision:1},run);
    const stopped=assert.rejects(running,error=>error.code==='TASK_RUN_CONTROL_PENDING');
    let view;for(let i=0;i<100;i++){view=(await registry.list()).items[0];if(view?.live)break;await new Promise(resolve=>setImmediate(resolve));}
    await registry.control(view.kind,view.taskId,{runId:view.runId,expectedRevision:view.revision,command:'pause'});
    await stopped;await registry.reconcile();assert.equal(settlements,0);
    assert.equal((await registry.list()).held[0].stopUnconfirmed,true);
  });
});

test('another thread or turn cannot complete the active response',async()=>{
  const f=fixture({hold:true});
  await invocation(f.runner,async(run)=>{
    let finished=false;const running=run().then(value=>{finished=true;return value;});
    for(let i=0;i<100 && !f.calls.some(call=>call.method==='turn/start');i++)await new Promise(resolve=>setImmediate(resolve));
    for(const [target,turn] of [[threadId,'old-turn'],['another-thread','turn-1']])f.send({method:'turn/completed',params:{threadId:target,turn:{id:turn,status:'completed'}}});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);f.complete();await running;
  });
});

test('notifications preceding turn start response are fenced by the returned turn ID',async()=>{
  let options;
  const process={exited:false,start(value){options=value;},write(line){
    const r=JSON.parse(line);if(!r.id)return;
    const send=value=>options.onLine({stream:'stdout',line:JSON.stringify(value)});
    if(r.method==='turn/start') {
      send({method:'turn/completed',params:{threadId,turn:{id:'old-turn',status:'completed'}}});
      send({method:'item/agentMessage/delta',params:{threadId,turnId:'turn-1',itemId:'answer',delta:'visible progress'}});
    }
    send({id:r.id,result:r.method.startsWith('thread/')?{thread:{id:threadId}}:r.method==='turn/start'?{turn:{id:'turn-1'}}:{}});
    if(r.method==='turn/start')queueMicrotask(()=>{
      send({method:'item/completed',params:{threadId,turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'{"result":"{\\"ok\\":true}"}'}}});
      send({method:'turn/completed',params:{threadId,turn:{id:'turn-1',status:'completed'}}});
    });
  },async stop(){this.exited=true;}};
  const events=[];const sessions=[];
  await invocation(new CodexAppServerRunner({processFactory:()=>process,materialize:async()=>({command:'codex',prefixArgs:[]})}),
    run=>withTaskExecution({reportProgress(){},reportEvent:value=>events.push(value),reportSession:value=>sessions.push(value)},run));
  assert.equal(events.length,1);assert.equal(events[0].text,'visible progress');
  assert.equal(sessions.at(-1).status,'completed');assert.equal(sessions.at(-1).turnId,'turn-1');
});

test('a steer acknowledgement for a different turn is rejected',async()=>{
  const f=fixture({hold:true,steerTurnId:'different-turn'});
  await invocation(f.runner,async(run)=>{
    let live;const running=withTaskExecution({reportProgress(){},registerLiveControl:value=>{live=value;return()=>{};}},run);
    for(let i=0;i<100 && !live;i++)await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(live.steer('check races','message-1'),error=>error.code==='STRUCTURED_PROVIDER_RESPONSE_INVALID');
    f.complete();await running;
  });
});

test('a missing steer acknowledgement turn ID cannot certify delivery',async()=>{
  const f=fixture({hold:true,steerTurnId:false});
  await invocation(f.runner,async run=>{
    let live;const running=withTaskExecution({reportProgress(){},registerLiveControl:value=>{live=value;return()=>{};}},run);
    for(let i=0;i<100&&!live;i++)await new Promise(resolve=>setImmediate(resolve));
    await assert.rejects(live.steer('check races','message-1'),{code:'STRUCTURED_PROVIDER_RESPONSE_INVALID'});
    f.complete();await running;
  });
});

test('resuming a different native thread fails before a model turn starts',async()=>{
  const f=fixture();
  await assert.rejects(invocation(f.runner,run=>run(),{previous:'01973bca-3d8b-7000-a000-987654321abc'}),error=>error.code==='STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED');
  assert.equal(f.calls.some(call=>call.method==='turn/start'),false);
});

test('a continuous code channel verifies exact host tools and revokes admission at native completion',async()=>{
  const f=fixture({codeJob:true});let revoked=false,confirmed=0;
  await invocation(f.runner,run=>withTaskExecution({reportProgress(){},confirmStopped(){confirmed++;}},run),{
    isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true},
  });
  assert.equal(revoked,true);assert.equal(confirmed,0);
  const thread=f.calls.find(call=>call.method==='thread/start');
  assert.match(thread.params.baseInstructions,/one continuous controlled code job/);
  assert.equal(thread.params.config.mcp_servers.old.enabled,false);
  const input=f.calls.find(call=>call.method==='turn/start').params.input[0].text;
  assert.match(input,/dih_code_job_[a-f0-9]{16}/);
});

test('continuous pause revokes tools before interrupt and defers stop certification to the host drain',async()=>{
  let revoked=false,confirmed=0,live;
  const f=fixture({hold:true,codeJob:true,onInterrupt(){assert.equal(revoked,true);}});
  await invocation(f.runner,async run=>{
    const running=withTaskExecution({reportProgress(){},confirmStopped(){confirmed++;},registerLiveControl(value){live=value;return()=>{};}},run);
    for(let i=0;i<100&&!live;i++)await new Promise(resolve=>setImmediate(resolve));
    await live.interrupt();
    const result=await running;
    assert.equal(result.interrupted,true);assert.equal(confirmed,0);
  },{isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true}});
});

test('review tools and extra tools cannot enter a continuous code turn',async()=>{
  for(const toolInventory of [['read_document','read_source','list_directory'],['perform_action','read_source','get_state','shell']]) {
    const f=fixture({codeJob:true,toolInventory});let revoked=false;
    await assert.rejects(invocation(f.runner,run=>run(),{isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true}}),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
    assert.equal(revoked,true);assert.equal(f.calls.some(call=>call.method==='turn/start'),false);
  }
});

test('a captured late interrupt after terminal completion does not send an RPC during process teardown',async()=>{
  let releaseStop,live;
  const stopGate={promise:new Promise(resolve=>{releaseStop=resolve;})};
  const f=fixture({hold:true,codeJob:true,stopGate});let revoked=false;
  await invocation(f.runner,async run=>{
    const running=withTaskExecution({reportProgress(){},registerLiveControl(value){live=value;return()=>{};}},run);
    for(let i=0;i<100&&!live;i++)await new Promise(resolve=>setImmediate(resolve));
    f.complete();await f.stopping;
    await live.interrupt();
    assert.equal(revoked,true);
    assert.equal(f.calls.some(call=>call.method==='turn/interrupt'),false);
    releaseStop();await running;
  },{isolation:{channel:'code-job',execution:{url:'http://127.0.0.1:1234/code-execution/token',revoke(){revoked=true;}},agentConfigPath:'private.toml',ephemeral:true}});
});
