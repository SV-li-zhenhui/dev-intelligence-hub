import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { materializeVerifiedCliDescriptor } from './known-cli-locator.js';
import { parseJsonWithUniqueKeys } from './strict-json.js';
import { currentTaskExecution } from './task-execution-context.js';
import { isNativeCodexThreadId } from '../adapters/codex-native-session-store.js';

const FAILURE_OUTPUT = new WeakMap();
const NOT_STARTED = new WeakSet();
export const readAppServerFailureOutput = (error) => FAILURE_OUTPUT.get(error) ?? null;
export const didAppServerNotStart = (error) => NOT_STARTED.has(error);
function failure(code='STRUCTURED_PROVIDER_PROCESS_FAILED') {
  return Object.assign(new Error(code),{code,statusCode:code==='STRUCTURED_PROVIDER_TIMEOUT'?504:502});
}
function deferred() {
  let resolve,reject;
  const promise=new Promise((accept,fail)=>{resolve=accept;reject=fail;});
  // Notifications can precede the response that the caller is awaiting.
  void promise.catch(()=>{});
  return {promise,resolve,reject};
}

export class CodexAppServerRunner {
  constructor({processFactory=null,materialize=materializeVerifiedCliDescriptor}={}) {
    this.processFactory=processFactory; this.materialize=materialize;
    this.supportsContainedExecution=false;
  }

  async run({executable,args,cwd,env,signal,timeoutMs,appServer}) {
    // Protocol fixtures can inject a process. Production needs a contained,
    // bidirectional supervisor: a direct child's exit is not tree-reap proof.
    if (!this.processFactory) {
      const error=failure('STRUCTURED_PROVIDER_UNAVAILABLE');NOT_STARTED.add(error);throw error;
    }
    let descriptor;
    try { descriptor=await this.materialize(executable,{signal}); }
    catch(cause){const error=failure('STRUCTURED_PROVIDER_UNAVAILABLE');NOT_STARTED.add(error);throw error;}
    if(signal?.aborted){const error=failure('STRUCTURED_PROVIDER_CANCELLED');NOT_STARTED.add(error);throw error;}
    const process=this.processFactory(); const completed=deferred(); const pending=new Map();
    const context=currentTaskExecution(); let threadId=appServer.previous,turnId=null,text=null;
    let sequence=0,started=false,initialized=false,terminal=false,interrupted=false,detach,output,error;
    const request=(method,params)=>{
      if(process.exited) return Promise.reject(failure());
      const id=++sequence; const waiting=deferred();
      const timer=setTimeout(()=>{pending.delete(id);waiting.reject(failure('STRUCTURED_PROVIDER_TIMEOUT'));},Math.min(timeoutMs,30_000));
      pending.set(id,{...waiting,timer});
      try{process.write(`${JSON.stringify({id,method,params})}\n`);}catch(cause){clearTimeout(timer);pending.delete(id);waiting.reject(failure());}
      return waiting.promise;
    };
    const fail=(cause)=>{
      const problem=cause?.code?.startsWith('STRUCTURED_PROVIDER_') ? cause : failure(initialized ? 'STRUCTURED_PROVIDER_PROCESS_FAILED' : 'STRUCTURED_PROVIDER_UNAVAILABLE');
      completed.reject(problem);
      for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(problem);}
      pending.clear();
    };
    const receive=({stream,line})=>{
      if(stream!=='stdout' || !line.trim())return;
      try {
        const message=parseJsonWithUniqueKeys(line);
        if(!message || typeof message!=='object' || Array.isArray(message))throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
        if(message.method && message.id!==undefined){
          process.write(`${JSON.stringify({id:message.id,error:{code:-32601,message:'Interactive server requests are not authorized in this read-only decision channel'}})}\n`);
          return;
        }
        if(message.id!==undefined){
          const waiting=pending.get(message.id);if(!waiting)return;
          clearTimeout(waiting.timer);pending.delete(message.id);
          if(message.error)waiting.reject(failure());else waiting.resolve(message.result);
          return;
        }
        const params=message.params??{};
        if(params.threadId!==threadId)return;
        const eventTurn=params.turnId??params.turn?.id;
        if(turnId && eventTurn && eventTurn!==turnId)return;
        if(message.method==='turn/started' && params.turn?.id)turnId=params.turn.id;
        if(message.method==='item/completed' && params.item?.type==='agentMessage')text=params.item.text;
        const progress={
          'turn/started':'正在分析任务', 'item/started':'正在读取或检查代码',
          'item/completed':'检查步骤已完成', 'item/commandExecution/outputDelta':'代码检查有新输出',
          'item/mcpToolCall/progress':'正在读取 PR 材料', 'turn/plan/updated':'执行计划已更新',
          'item/agentMessage/delta':'正在生成判断',
        }[message.method];
        if(progress)context?.reportProgress(progress);
        if(message.method==='turn/completed'){
          terminal=true;turnId=params.turn?.id??turnId;
          interrupted=params.turn?.status==='interrupted';
          if(params.turn?.status==='failed')completed.reject(failure());
          else completed.resolve();
        }
        if(message.method==='error' && params.willRetry===false)fail(failure());
      }catch(cause){fail(cause);}
    };
    const abort=()=>fail(failure('STRUCTURED_PROVIDER_CANCELLED'));
    const deadline=setTimeout(()=>fail(failure('STRUCTURED_PROVIDER_TIMEOUT')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try {
      process.start({command:descriptor.command,args:[...descriptor.prefixArgs,...args],cwd,env,
        keepStdinOpen:true,onLine:receive,onError:fail,onLimit:()=>fail(failure('STRUCTURED_PROVIDER_OUTPUT_LIMIT')),
        onExit:()=>{if(!terminal)fail(failure(initialized ? 'STRUCTURED_PROVIDER_PROCESS_FAILED' : 'STRUCTURED_PROVIDER_UNAVAILABLE'));}});
      started=true;
      await request('initialize',{clientInfo:{name:'dev_intelligence_hub',version:'0.1.0'},capabilities:{experimentalApi:true}});
      initialized=true;
      process.write(`${JSON.stringify({method:'initialized',params:{}})}\n`);
      const resumed=await request(threadId?'thread/resume':'thread/start',{
        ...(threadId?{threadId}:{}),cwd,model:appServer.model,approvalPolicy:'never',sandbox:'read-only',
      });
      const actual=resumed?.thread?.id;
      if(!isNativeCodexThreadId(actual) || (threadId && actual!==threadId))throw failure('STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED');
      threadId=actual;
      const begun=await request('turn/start',{threadId,cwd,model:appServer.model,
        ...(appServer.effort?{effort:appServer.effort}:{}),
        input:[{type:'text',text:appServer.input}],outputSchema:appServer.schema,
        approvalPolicy:'never',sandboxPolicy:{type:'readOnly',networkAccess:false}});
      if(typeof begun?.turn?.id!=='string' || !begun.turn.id || (turnId && turnId!==begun.turn.id))throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
      turnId=begun.turn.id;
      if(!terminal)detach=context?.registerLiveControl({
        steer:async(instruction,clientUserMessageId)=>{
          if(terminal)throw failure();
          const accepted=await request('turn/steer',{threadId,expectedTurnId:turnId,input:[{type:'text',text:instruction}],clientUserMessageId});
          if(accepted?.turnId && accepted.turnId!==turnId)throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
        },
        interrupt:()=>request('turn/interrupt',{threadId,turnId}),
      });
      await completed.promise;
      if(!interrupted){
        if(typeof text!=='string' || Buffer.byteLength(text)>1024*1024)throw failure('STRUCTURED_PROVIDER_RESPONSE_INVALID');
        parseJsonWithUniqueKeys(text);
        await writeFile(path.join(cwd,'last-message.json'),text,{flag:'wx',mode:0o600});
      }
      output={exitCode:0,signal:null,stdoutBytes:Buffer.from(JSON.stringify({type:'thread.started',thread_id:threadId})+'\n'),interrupted};
    }catch(cause){error=cause;}
    finally {
      clearTimeout(deadline);signal?.removeEventListener('abort',abort);detach?.();
      for(const waiting of pending.values()){clearTimeout(waiting.timer);waiting.reject(error??failure());}pending.clear();
      if(started){
        try { await process.stop({gracefulMs:100});if(!process.exited)throw failure(); }
        catch { error=failure('STRUCTURED_PROVIDER_REAP_FAILED'); }
      }
      if(interrupted && !error)context?.confirmStopped();
    }
    if(error){
      if(threadId)FAILURE_OUTPUT.set(error,{stdoutBytes:Buffer.from(JSON.stringify({type:'thread.started',thread_id:threadId})+'\n')});
      if(!started)NOT_STARTED.add(error);
      throw error;
    }
    return output;
  }
}
