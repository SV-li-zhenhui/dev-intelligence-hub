import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from "node:test";

import { createNativeCodexBrainProvider } from "../src/adapters/native-codex-brain-provider.js";
import { nativeCodexDigest, nativeCodexHomeIdentity } from "../src/adapters/codex-native-session-store.js";
import { createTestSupervisedProcessRunner } from "../src/lib/supervised-process-runner.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { CodexAppServerRunner } from '../src/lib/codex-app-server-runner.js';
import { createCodeReadContext, hasCompleteCodeRead } from "../src/lib/code-read-context.js";
import { createCodeJobArtifactReader } from "../src/adapters/code-job-artifact-reader.js";
import { beginCodeExecutionSession, createCodeExecutionContext } from "../src/lib/code-execution-context.js";
import { withTaskExecution } from "../src/lib/task-execution-context.js";
import {TaskRunRegistry} from '../src/services/task-run-registry.js';
import {CodeJobBrainDirectory} from '../src/services/code-job-brain-directory.js';
import {githubEntitySessionKey} from '../src/lib/session-key.js';
import { startCodeExecutionTurn } from '../src/lib/code-execution-watchdog.js';
import { ContainedStdioProcess } from '../src/lib/contained-stdio-process.js';
import { preparePrEmployeeAnalysis } from '../src/adapters/ollama-pr-employee-reviewer.js';
import { NATIVE_ADVISORY_INSTRUCTION } from '../src/lib/codex-app-server-policy.js';

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const request = (overrides = {}) => ({ model: "gpt-6.1-sol", reasoningEffort: "high", messages: [{ role: "user", content: "PRIVATE_TASK_INPUT" }], schema, ...overrides });
const error = (code) => Object.assign(new Error("private diagnostic must not escape"), { code });
const options = { id: "native-test", cliKind: "codex-cli", credentialMode: "codex-native-login", timeoutMs: 3000 };
const success = (stdout = "") => ({ exitCode: 0, signal: null, stdout, stderr: "", stdoutBytes: Buffer.from(stdout), stderrBytes: Buffer.alloc(0) });
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("native entity quiescence uses the launch journal and holds exclusion without clearing unrelated unknown work", async t => {
  const f = await fixture(t);
  const provider = createNativeCodexBrainProvider(options, { ...f.dependencies, maxConcurrentTurns: 2, allowConcurrentNativeHome: true });
  await mkdir(f.runtime);
  const entityKey = githubEntitySessionKey({ kind: "pull_request", repository: "owner/repo", number: 42 });
  const prefix = `active-${nativeCodexDigest(nativeCodexHomeIdentity(f.home))}`;
  const invocation = `invocation-${randomUUID()}`;
  await mkdir(path.join(f.runtime, invocation));
  const marker = path.join(f.runtime, `${prefix}-${randomUUID()}.json`);
  const unrelated = { schemaVersion: 2, invocation, createdAt: Date.now(), entity: nativeCodexDigest("pr:other") };
  await writeFile(marker, JSON.stringify(unrelated));
  const result = await provider.withEntityQuiescence({ entityKey }, async () => {
    await assert.rejects(provider.withAdmission({ entityKey }, () => assert.fail("same entity entered")), { code: "STRUCTURED_PROVIDER_BUSY" });
    return "settled";
  });
  assert.deepEqual(result, { executed: true, result: "settled" });
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), unrelated);
  await writeFile(marker, JSON.stringify({ ...unrelated, entity: nativeCodexDigest(entityKey) }));
  assert.deepEqual(await provider.withEntityQuiescence({ entityKey }, () => assert.fail("unresolved launch entered")), { executed: false });
  await writeFile(marker, "invalid launch journal");
  assert.deepEqual(await provider.withEntityQuiescence({ entityKey }, () => assert.fail("malformed journal entered")), { executed: false });
  await provider.close();
});

test("custom process runners cannot certify native entity quiescence", async t => {
  const f = await fixture(t), provider = f.create();
  await mkdir(f.runtime);
  assert.deepEqual(await provider.withEntityQuiescence({ entityKey: "pr:42" }, () => assert.fail("uncertified runner")), { executed: false });
  await provider.close();
});

for(const sharedSessionScope of [true,false])test(`employee admission and direct code jobs serialize one PR with session scopes ${sharedSessionScope?'equal':'isolated'}`,async t=>{
  const f=await fixture(t),entered=gate(),finish=gate(),otherEntered=gate(),starts=[];
  const provider=f.create(async call=>{
    const wire=JSON.parse(await readFile(path.join(call.cwd,'task.json'),'utf8'));
    const label=wire.messages[0].content==='employee-42'?'employee-42':JSON.parse(wire.messages[1].content).task.objective;
    starts.push(label);
    if(label==='employee-42'){entered.resolve();await finish.promise;}
    if(label==='code-43')otherEntered.resolve();
    const resume=call.args.indexOf('resume');
    return result(call,codeDecision({type:'read_text',path:'src/example.js'}),resume<0?`thread-${label}`:call.args[resume+1]);
  },{}, {maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  const router=new BrainRouter({providers:[provider]});
  const brain={provider:'native-test',model:'review-model',remoteData:{requirements:true,code:true,memory:false}};
  const directory=new CodeJobBrainDirectory({brainRouter:router,roles:{developer:{taskBrain:{...brain,model:sharedSessionScope?'review-model':'code-model'}}}});
  const entity=number=>githubEntitySessionKey({kind:'pull_request',repository:'Owner/Repo',number});
  const job=number=>({roleId:'developer',sessionKey:entity(number),task:{operation:'inspect',repository:'owner/repo',objective:`code-${number}`,acceptanceCriteria:[],evidence:[]},
    capabilities:{allowedActions:['read_text'],writablePaths:[],requiredProfilesRemaining:0},turn:1,observations:[]});
  const active=router.withAdmission(brain,{entityKey:entity(42)},()=>router.generate({brain,messages:[{role:'user',content:'employee-42'}],schema:{type:'object'},dataClasses:['requirements','code'],sessionKey:entity(42)}));
  await entered.promise;
  const same=directory.decide(job(42),{beforeGenerate:async()=>{}}).then(value=>({value}),error=>({error}));
  const other=directory.decide(job(43),{beforeGenerate:async()=>{}}).then(value=>({value}),error=>({error}));
  try{
    await Promise.race([otherEntered.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('different PR could not enter')),2000))]);
    assert.deepEqual(starts,['employee-42','code-43'],'same PR must remain queued before session staging or model start');
  }finally{finish.resolve();await active;}
  assert.equal((await same).error,undefined,'shared native session must not collide with its pending journal');
  assert.equal((await other).error,undefined);
  assert.equal(starts.at(-1),'code-42');await provider.close();
});

test("model execution budget starts after shared-home admission", async (t) => {
  const f = await fixture(t), entered = gate(), finish = gate();
  const first = f.create(async (call) => { entered.resolve(); await finish.promise; return result(call); });
  const second = f.create(call => result(call), { timeoutMs: 200 });
  const active = first.generate(request()); await entered.promise;
  const queued = second.generate(request()).then(value => ({value}), error => ({error}));
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(f.calls.length, 1);
  finish.resolve(); await active;
  const outcome = await queued;
  assert.equal(outcome.error, undefined, "waiting must not consume the model's execution deadline");
  assert.deepEqual(JSON.parse(outcome.value), {ok:true});
  await first.close(); await second.close();
});

test("native resource admission is nonblocking, held through callback, and released on errors", async (t) => {
  const f = await fixture(t), entered = gate(), finish = gate();
  const provider = f.create();
  const active = provider.withAdmission({entityKey:'github:owner/repo:pull_request:42'}, async () => {
    entered.resolve(); await finish.promise; return provider.generate(request({sessionKey:'pr:42'}));
  });
  await entered.promise;
  await assert.rejects(provider.withAdmission({entityKey:'github:owner/repo:pull_request:43'}, () => assert.fail('busy callback')), {code:'STRUCTURED_PROVIDER_BUSY'});
  finish.resolve(); await active;
  await assert.rejects(provider.withAdmission({entityKey:'pr:43'}, () => { throw new Error('callback failed'); }), /callback failed/);
  await provider.withAdmission({entityKey:'pr:43'}, () => provider.generate(request({sessionKey:'pr:43'})));
  await provider.close();
});

test("queued automatic admission gets the next slot before a later orchestrator", async (t) => {
  const f = await fixture(t), releaseCode = gate(), releaseOther = gate(), releaseReview = gate(), enteredReview = gate();
  const provider = f.create(undefined, {}, { maxConcurrentTurns: 2, allowConcurrentNativeHome: true });
  const order = [], errors = [];
  const code = provider.withAdmission({ entityKey: "pr:code" }, () => releaseCode.promise);
  const other = provider.withAdmission({ entityKey: "pr:other" }, () => releaseOther.promise);
  const review = provider.withAdmission({ entityKey: "pr:review", waitForCapacity: true }, async () => {
    order.push("review"); enteredReview.resolve(); await releaseReview.promise;
    return provider.generate(request());
  }).catch(error => errors.push(error.code));
  const orchestrator = provider.withAdmission({ entityKey: "pr:orchestrator", waitForCapacity: true }, () => {
    order.push("orchestrator");
  }).catch(error => errors.push(error.code));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, [], "automatic roles must queue without repeatedly losing their place");
    assert.deepEqual(order, []);
    releaseOther.resolve(); await enteredReview.promise;
    assert.deepEqual(order, ["review"]);
    releaseReview.resolve();
    await Promise.all([review, orchestrator]);
    assert.deepEqual(order, ["review", "orchestrator"]);
    assert.deepEqual(errors, [], "nested generation must borrow its reservation");
  } finally {
    releaseCode.resolve(); releaseOther.resolve(); releaseReview.resolve();
    await Promise.all([code, other, review, orchestrator]); await provider.close();
  }
});

for (const ending of ["cancel", "timeout", "close"]) {
  test(`queued automatic admission ${ending} never claims capacity or invokes work`, async (t) => {
    const f = await fixture(t), release = gate(), controller = new AbortController();
    const provider = f.create(undefined, { queueTimeoutMs: 20 });
    const active = provider.withAdmission({ entityKey: "pr:active" }, () => release.promise);
    const expected = { cancel: "STRUCTURED_PROVIDER_CANCELLED", timeout: "STRUCTURED_PROVIDER_QUEUE_TIMEOUT", close: "STRUCTURED_PROVIDER_CANCELLED" }[ending];
    const queued = assert.rejects(provider.withAdmission({ entityKey: "pr:queued", waitForCapacity: true, signal: controller.signal },
      () => assert.fail("cancelled or expired work must remain unclaimed")), { code: expected });
    if (ending === "cancel") controller.abort();
    const closing = ending === "close" ? provider.close() : null;
    try { await queued; }
    finally { release.resolve(); await active; await closing; }
    if (ending !== "close") await provider.withAdmission({ entityKey: "pr:next", waitForCapacity: true }, async () => {});
    await provider.close();
  });
}

test('a rejected overlapping use cannot unlock a still-running reservation',async(t)=>{
  const f=await fixture(t),entered=gate(),finish=gate();
  const provider=f.create(async call=>{entered.resolve();await finish.promise;return result(call);});
  await provider.withAdmission({entityKey:'pr:42'},async()=>{
    const active=provider.generate(request());void active.catch(()=>{});await entered.promise;
    try {
      await assert.rejects(provider.generate(request()),{code:'STRUCTURED_PROVIDER_BUSY'});
      await assert.rejects(provider.generate(request()),{code:'STRUCTURED_PROVIDER_BUSY'});
      assert.equal(f.calls.length,1);
    } finally {finish.resolve();await active.catch(()=>{});}
  });
});

test('native concurrency remains opt-in and protocol fixtures preserve entity, login, and marker barriers',async(t)=>{
  const f=await fixture(t),enteredA=gate(),enteredB=gate(),finishA=gate(),finishB=gate();
  assert.throws(()=>f.create(undefined,{}, {maxConcurrentTurns:2}),/explicit validation opt-in/);
  let models=0,loginStarted=false;
  const provider=f.create(async call=>{
    if(call.args[0]==='login'){loginStarted=true;return success('Logged in using ChatGPT');}
    models++;
    if(models===1){enteredA.resolve();await finishA.promise;}
    if(models===2){enteredB.resolve();await finishB.promise;}
    return result(call);
  },{}, {maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  const a=provider.generate(request({sessionKey:'pr:42'}));await enteredA.promise;
  const same=provider.generate(request({sessionKey:'pr:42'}));
  const b=provider.generate(request({sessionKey:'pr:43'}));await enteredB.promise;
  assert.equal(models,2,'another entity can occupy the second slot while the first entity stays serialized');
  assert.equal((await readdir(f.runtime)).filter(name=>name.startsWith('active-')).length,2);
  const probe=provider.readStatus();
  const c=provider.generate(request({sessionKey:'pr:44'}));
  finishB.resolve();await b;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(loginStarted,false,'login probe is exclusive');
  assert.equal(models,2,'waiting login probe prevents new model admission');
  finishA.resolve();await Promise.all([a,same,c]);
  assert.equal((await probe).state,'available');
  assert.equal((await readdir(f.runtime)).filter(name=>name.startsWith('active-')).length,0);
  await provider.close();
});

test('queued registry cancellation certifies no model start and keeps durable receipt body-free',async(t)=>{
  const f=await fixture(t),entered=gate(),finish=gate();
  const provider=f.create(async call=>{entered.resolve();await finish.promise;return result(call);});
  const active=provider.generate(request());await entered.promise;
  t.after(async()=>{finish.resolve();await active.catch(()=>{});});
  const values=new Map(),store={async read(key,fallback){return structuredClone(values.get(key)??fallback);},async write(key,value){values.set(key,structuredClone(value));}};
  const registry=new TaskRunRegistry({store,receiptStore:store,settleControl:async()=>{}});
  const task={kind:'work-item',taskId:'queued-work',roleId:'reviewer',title:'Private task title',subject:'owner/repo#42',revision:1};
  const queued=registry.run(task,()=>provider.generate(request()),{requireStopConfirmation:true});
  const rejected=assert.rejects(queued,{code:'TASK_RUN_CANCELLED'});
  let view;
  for(let attempt=0;attempt<100;attempt++){
    view=await registry.get(task.kind,task.taskId).catch(()=>null);
    if(view?.phase==='waiting_model' && view.live)break;
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(view.phase,'waiting_model');
  assert.deepEqual((await registry.list()).counts,{active:0,queued:1,preparing:0});
  await registry.control(task.kind,task.taskId,{runId:view.runId,expectedRevision:view.revision,command:'cancel'});
  await rejected;
  const receipt=values.get('task-run-execution-receipts').records.at(-1);
  assert.equal(receipt.modelStartedAt,null);assert.equal(receipt.stopConfirmed,true);
  assert.equal(f.calls.length,1,'cancelled queued request never launches');
  assert.equal(JSON.stringify(values.get('task-run-execution-receipts')).includes('PRIVATE_TASK_INPUT'),false);
  finish.resolve();await active;await provider.close();
});

test('certified exec preparation failures never claim the model started',async(t)=>{
  const f=await fixture(t),phases=[];
  const runner=createTestSupervisedProcessRunner({platform:process.platform,descriptorMaterializer:async()=>{throw error('STRUCTURED_PROVIDER_UNAVAILABLE');}});
  const provider=f.create(undefined,{}, {processRunner:runner});
  await assert.rejects(withTaskExecution({reportModelState:phase=>phases.push(phase)},()=>provider.generate(request())),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.equal(phases.includes('running'),false);
  await provider.close();
});

test('queue admission has its own bounded deadline and never reports model execution timeout',async(t)=>{
  const f=await fixture(t),entered=gate(),finish=gate();
  const first=f.create(async call=>{entered.resolve();await finish.promise;return result(call);});
  const active=first.generate(request());await entered.promise;
  t.after(async()=>{finish.resolve();await active.catch(()=>{});});
  const queued=f.create(undefined,{queueTimeoutMs:20,timeoutMs:1000});
  await assert.rejects(queued.generate(request()),{code:'STRUCTURED_PROVIDER_QUEUE_TIMEOUT'});
  assert.equal(f.calls.length,1);
  finish.resolve();await active;await first.close();await queued.close();
});

test('unknown concurrent-home markers block admission after recovery without removing owned files',async(t)=>{
  const f=await fixture(t);await mkdir(f.runtime);
  const marker=`active-${nativeCodexDigest(nativeCodexHomeIdentity(f.home))}-old-concurrent-invocation.json`;
  await writeFile(path.join(f.runtime,marker),'{"schemaVersion":1,"invocation":"unknown-process"}');
  const provider=f.create(undefined,{}, {maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  await assert.rejects(provider.generate(request()),{code:'STRUCTURED_PROVIDER_REAP_FAILED'});
  assert.equal(f.calls.length,0);assert.equal((await readdir(f.runtime)).includes(marker),true);
  await assert.rejects(provider.withAdmission({entityKey:'pr:42'},()=>assert.fail('unknown process owner')),{code:'STRUCTURED_PROVIDER_REAP_FAILED'});
});

test('concurrent model slots serialize private runtime bootstrap before either process launch',async(t)=>{
  const f=await fixture(t),entered=gate(),finish=gate();let preparing=false;
  const manager={async prepare(options){
    if(options.directory===f.runtime){
      if(preparing)throw error('STRUCTURED_PROVIDER_UNAVAILABLE');
      preparing=true;entered.resolve();await finish.promise;
      try{return await f.dependencies.rootDirectoryManager.prepare(options);}finally{preparing=false;}
    }
    return f.dependencies.rootDirectoryManager.prepare(options);
  }};
  const provider=f.create(undefined,{}, {maxConcurrentTurns:2,allowConcurrentNativeHome:true,rootDirectoryManager:manager});
  const first=provider.generate(request({sessionKey:'pr:42'})).then(value=>({value}),error=>({error}));await entered.promise;
  const second=provider.generate(request({sessionKey:'pr:43'})).then(value=>({value}),error=>({error}));
  await new Promise(resolve=>setTimeout(resolve,10));finish.resolve();
  const outcomes=await Promise.all([first,second]);
  assert.ok(outcomes.every(outcome=>!outcome.error),'shared private roots cannot be created concurrently');
  assert.equal(f.calls.length,2);await provider.close();
});

test('admission callback completion cannot release a model still owned by its reservation',async(t)=>{
  const f=await fixture(t),entered=gate(),finish=gate();
  const provider=f.create(async call=>{entered.resolve();await finish.promise;return result(call);});
  let active;
  await provider.withAdmission({entityKey:'pr:42'},async()=>{active=provider.generate(request());await entered.promise;});
  try{await assert.rejects(provider.withAdmission({entityKey:'pr:43'},()=>assert.fail('active model lost its slot')),{code:'STRUCTURED_PROVIDER_BUSY'});}
  finally{finish.resolve();await active;await provider.close();}
});

function auditedCode(content = "\uFEFF中文开头\n" + "x".repeat(80 * 1024) + "\n完整文件尾部") {
  const document = { actionId: "read-current", path: "src/large.cpp", content,
    bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
  const binding = { jobId: "code-job-test", workspaceRevision: "a".repeat(64) };
  return { document, binding, context: createCodeReadContext({ ...binding, documents: [document] }) };
}

async function readAuditedPages(url, path, { firstPageOnly = false } = {}) {
  let offset = 0;
  let text = "";
  do {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: offset + 1, method: "tools/call",
        params: { name: "read_source", arguments: { path, offset, length: 24_000 } } }) });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.notEqual(message.result.isError, true);
    const page = JSON.parse(message.result.content[0].text);
    text += page.text;
    offset = page.nextOffset;
    if (firstPageOnly) break;
  } while (offset !== null);
  return text;
}

const codeDecision = (action) => ({ schemaVersion: 1, confidence: 90, summary: "检查当前代码", reason: "使用完整受控读取", action });

async function executionTool(url, id, name, args = {}) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.notEqual(message.result.isError, true);
  return JSON.parse(message.result.content[0].text);
}

test("native continuous execution keeps several host actions inside one invocation and a distinct tool channel", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  const actions = []; let remaining = 1, closed = 0, invocations = 0;
  const context = createCodeExecutionContext({
    async performAction({ decision }) { actions.push(decision.action.type); if (decision.action.type === "run_profile") remaining--; return { status: "succeeded" }; },
    readSource: () => ({ text: "full audited content", nextOffset: null, sourceVersion: "version-1" }),
    getState: () => ({ requiredProfilesRemaining: remaining }), close: () => { closed++; return { settled: true }; },
  });
  const provider = f.create(() => assert.fail("continuous execution cannot use exec fallback"), {}, { appServerRunner: { async run(call) {
    invocations++;
    assert.equal(call.timeoutMs, options.timeoutMs, 'startup keeps its own bound; code jobs have no elapsed execution deadline');
    assert.equal(call.appServer.isolation.channel, "code-job");
    assert.equal(call.appServer.isolation.reader, null);
    assert.match(await readFile(path.join(call.cwd, "model-instructions.txt"), "utf8"), /one continuous controlled code job/);
    const url = call.appServer.isolation.execution.url;
    assert.equal((await executionTool(url, 1, "get_state")).requiredProfilesRemaining, 1);
    await executionTool(url, 2, "perform_action", { decision: codeDecision({ type: "read_text", path: "src/app.cpp" }) });
    assert.equal((await executionTool(url, 3, "read_source", { path: "src/app.cpp", offset: 0 })).nextOffset, null);
    await executionTool(url, 4, "perform_action", { decision: codeDecision({ type: "write_text", path: "src/app.cpp", content: "fixed" }) });
    await executionTool(url, 5, "perform_action", { decision: codeDecision({ type: "run_profile" }) });
    assert.equal((await executionTool(url, 6, "get_state")).requiredProfilesRemaining, 0);
    await writeFile(path.join(call.cwd, "last-message.json"), JSON.stringify({ result: JSON.stringify(codeDecision({ type: "complete", outcome: "done", evidence: [] })) }));
    return success();
  } } });
  assert.equal(provider.supportsCodeExecution, true);
  assert.equal(JSON.parse(await provider.generate(request({ codeExecutionContext: context }))).action.type, "complete");
  assert.deepEqual(actions, ["read_text", "write_text", "run_profile"]);
  assert.equal(invocations, 1); assert.equal(closed, 1);
  assert.equal(await readFile(path.join(f.home, "auth.json"), "utf8"), "private-native-auth");
  assert.equal(await readFile(path.join(f.home, "config.toml"), "utf8"), 'model = "user-preferred-model"\n');
  await provider.close();
});

test("continuous useful code work can exceed ten hours without an elapsed provider cutoff", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  let actions = 0;
  const context = createCodeExecutionContext({ performAction: async () => ({ turn: ++actions }),
    progressFingerprint: async () => createHash('sha256').update(`verified-file-${actions}`).digest('hex'),
    readSource: async () => ({ text: 'source', nextOffset: null }), getState: async () => ({}), close: async () => ({ settled: true }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const provider = f.create(result, {}, { appServerRunner: { async run(call) {
    startCodeExecutionTurn(call.codeExecutionWatchdog);
    for (let turn = 0; turn < 61; turn++) {
      await executionTool(call.appServer.isolation.execution.url, turn + 1, 'perform_action', {
        decision: codeDecision({ type: 'read_text', path: `src/file${turn}.cpp` }),
      });
      t.mock.timers.tick(10 * 60_000);
      assert.equal(call.signal.aborted, false, `useful action ${turn + 1} must retain execution`);
    }
    await writeFile(path.join(call.cwd, 'last-message.json'), JSON.stringify({ result: JSON.stringify(codeDecision({ type: 'complete', outcome: 'done', evidence: [] })) }));
    return success();
  } } });
  assert.equal(JSON.parse(await provider.generate(request({ codeExecutionContext: context }))).action.type, 'complete');
  assert.equal(actions, 61);
  await provider.close();
});

test('one host watchdog carries useful code progress beyond ten hours through the full native process chain', async t => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = 'app-server';
  const child = new EventEmitter(); child.pid = 424242;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const threadId = '01973bca-3d8b-7000-a000-123456789abc', entered = gate();
  let namespace, sharedWatchdog, propagated = 0, reaps = 0, confirmed = 0, closed = false;
  const send = message => child.stdout.write(JSON.stringify(message) + '\n');
  const close = () => { if (!closed) { closed = true; child.emit('close', 0, null); } };
  child.stdin.on('finish', close);
  child.stdin.on('data', chunk => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      const message = JSON.parse(line); if (message.id === undefined) continue;
      let result = {};
      if (message.method === 'config/read') result = { config: {
        features: { ...Object.fromEntries(['shell_tool','apps','browser_use','computer_use','image_generation','hooks','plugins','remote_plugin','plugin_sharing','skill_search','skill_mcp_dependency_install','goals','memories','workspace_dependencies','multi_agent_v2','code_mode','multi_agent'].map(name => [name, false])),
          skip_host_skill_discovery: true, code_mode_host: true },
        agents: { enabled: false }, web_search: 'disabled', approval_policy: 'never', sandbox_mode: 'read-only', model_provider: 'openai', notify: [], mcp_servers: {},
      } };
      if (message.method.startsWith('thread/')) {
        namespace = Object.keys(message.params.config.mcp_servers).find(name => name.startsWith('dih_code_job_'));
        result = { thread: { id: threadId }, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } };
      }
      if (message.method === 'mcpServerStatus/list') result = { data: [{ name: namespace,
        tools: Object.fromEntries(['perform_action', 'read_source', 'edit_source', 'get_state', 'read_conflict_source'].map(name => [name, {}])) }], nextCursor: null };
      if (message.method === 'turn/start') result = { turn: { id: 'turn-1' } };
      send({ id: message.id, result });
      if (message.method === 'turn/start') entered.resolve();
    }
  });
  const supervised = createTestSupervisedProcessRunner({ platform: 'linux', spawnImpl: () => child,
    descriptorMaterializer: async () => ({ command: process.execPath, prefixArgs: [] }), treeTerminator: async () => { reaps++; close(); } });
  const runner = new CodexAppServerRunner({ materialize: async () => null,
    processFactory: () => new ContainedStdioProcess({ run(call) {
      assert.equal(call.codeExecutionWatchdog, sharedWatchdog, 'contained supervision must retain the same opaque capability');
      propagated++; return supervised.run(call);
    } }) });
  const provider = f.create(result, {}, { appServerRunner: { run(call) {
    sharedWatchdog = call.codeExecutionWatchdog; assert.ok(sharedWatchdog); return runner.run(call);
  } } });
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {}, close: async () => ({ settled: true }) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = withTaskExecution({ reportProgress() {}, registerLiveControl() {}, confirmStopped() { confirmed++; } }, () => provider.generate(request({ codeExecutionContext: context })));
  void running.catch(() => {}); await entered.promise; await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 61; index++) {
    send({ method: 'item/reasoning/textDelta', params: { threadId, turnId: 'turn-1', itemId: `reasoning-${index}`, contentIndex: 0, delta: 'Verified the next implementation step.' } });
    t.mock.timers.tick(10 * 60_000);
    await new Promise(resolve => setImmediate(resolve));
    if (closed) await running;
    assert.equal(closed, false, `native step ${index + 1} remains active`);
  }
  send({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage',
    text: JSON.stringify({ result: JSON.stringify(codeDecision({ type: 'complete', outcome: 'done', evidence: [] })) }) } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(JSON.parse(await running).action.type, 'complete');
  assert.equal(propagated, 1); assert.equal(reaps, 1); assert.equal(confirmed, 1);
  await provider.close();
});

test("continuous stop confirmation waits for an admitted host action and its trusted drain receipt", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  const entered = gate(), release = gate(), nativeExited = gate(); let confirmed = 0, closed = 0, fetched;
  const context = createCodeExecutionContext({
    async performAction() { entered.resolve(); await release.promise; return { status: "succeeded" }; },
    readSource() {}, getState() {}, close() { closed++; return { settled: true }; },
  });
  const provider = f.create(result, {}, { appServerRunner: { async run(call) {
    fetched = executionTool(call.appServer.isolation.execution.url, 1, "perform_action", { decision: codeDecision({ type: "run_profile" }) });
    await entered.promise;
    call.appServer.isolation.execution.revoke();
    nativeExited.resolve();
    return { ...success(), interrupted: true };
  } } });
  const running = withTaskExecution({ confirmStopped() { confirmed++; } }, () => provider.generate(request({ codeExecutionContext: context })));
  const stopped = assert.rejects(running, { code: "STRUCTURED_PROVIDER_CANCELLED" });
  await nativeExited.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, 0); assert.equal(closed, 0);
  release.resolve(); await stopped; await fetched;
  assert.equal(confirmed, 1); assert.equal(closed, 1);
  await provider.close();
});

test("an unknown host action result never certifies a continuous stop", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server"; let confirmed = 0;
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {}, close: () => ({ settled: false }) });
  const provider = f.create(result, {}, { appServerRunner: { async run() { return { ...success(), interrupted: true }; } } });
  await assert.rejects(withTaskExecution({ confirmStopped() { confirmed++; } }, () => provider.generate(request({ codeExecutionContext: context }))), { code: "STRUCTURED_PROVIDER_CANCELLED" });
  assert.equal(confirmed, 0); await provider.close();
});

test("a completed native turn certifies a late stop only after its host drain settles", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  const closing = gate(), release = gate(); let confirmed = 0;
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {}, async close() {
    closing.resolve(); await release.promise; return { settled: true };
  } });
  const provider = f.create(result, {}, { appServerRunner: { async run(call) {
    await writeFile(path.join(call.cwd, "last-message.json"), JSON.stringify({ result: JSON.stringify(codeDecision({ type: "complete", outcome: "done", evidence: [] })) }));
    return success();
  } } });
  const running = withTaskExecution({ confirmStopped() { confirmed++; } }, () => provider.generate(request({ codeExecutionContext: context })));
  await closing.promise; assert.equal(confirmed, 0);
  release.resolve(); await running; assert.equal(confirmed, 1);
  await provider.close();
});

test("a native failure without a verified process result cannot certify stop from a drained host alone", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server"; let confirmed = 0;
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {}, close: () => ({ settled: true }) });
  const provider = f.create(result, {}, { appServerRunner: { async run() { throw error("STRUCTURED_PROVIDER_TIMEOUT"); } } });
  await assert.rejects(withTaskExecution({ confirmStopped() { confirmed++; } }, () => provider.generate(request({ codeExecutionContext: context }))), { code: "STRUCTURED_PROVIDER_TIMEOUT" });
  assert.equal(confirmed, 0); await provider.close();
});

test("caller cancellation preserves explicit native reap proof through abort remapping before certifying stop", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  const entered = gate(), controller = new AbortController(); let confirmed = 0, processOptions;
  const threadId = "01973bca-3d8b-7000-a000-123456789abc";
  const process = { exited: false, start(value) { processOptions = value; }, write(line) {
    const message = JSON.parse(line); if (!message.id) return;
    const result = message.method.startsWith("thread/") ? { thread: { id: threadId } }
      : message.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
    processOptions.onLine({ stream: "stdout", line: JSON.stringify({ id: message.id, result }) });
    if (message.method === "turn/start") entered.resolve();
  }, async stop() { this.exited = true; } };
  const runner = new CodexAppServerRunner({ processFactory: () => process, materialize: async () => ({ command: "fixture", prefixArgs: [] }) });
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {}, close: () => ({ settled: true }) });
  const provider = f.create(result, {}, { appServerRunner: { run(call) {
    // Policy isolation is tested separately; this fixture isolates the actual
    // runner's reap certificate and provider abort-reason translation.
    return runner.run({ ...call, codeExecutionWatchdog: null, appServer: { ...call.appServer, isolation: undefined } });
  } } });
  const running = withTaskExecution({ confirmStopped() { confirmed++; } }, () => provider.generate(request({ codeExecutionContext: context, signal: controller.signal })));
  const stopped = assert.rejects(running, { code: "STRUCTURED_PROVIDER_CANCELLED" });
  await entered.promise; controller.abort(); await stopped;
  assert.equal(process.exited, true); assert.equal(confirmed, 1);
  await provider.close();
});

test("execution capability is not serialized, combined with readers, or accepted by exec transport", async (t) => {
  const f = await fixture(t); let starts = 0;
  const provider = f.create(() => { starts++; return success(); });
  const context = createCodeExecutionContext({ performAction() {}, readSource() {}, getState() {} });
  assert.equal(provider.supportsCodeExecution, false);
  await assert.rejects(provider.generate(request({ codeExecutionContext: context })), { code: "CODE_EXECUTION_UNAVAILABLE" });
  await assert.rejects(provider.generate(request({ codeExecutionContext: structuredClone(context) })), /codeExecutionContext is invalid/);
  await assert.rejects(provider.generate(request({ codeExecutionContext: context, codeReadContext: auditedCode().context })), /codeExecutionContext is invalid/);
  await assert.rejects(provider.generate(request({ codeExecutionContext: context, reviewTarget: {} })), /codeExecutionContext is invalid/);
  assert.equal(starts, 0); await provider.close();
});

test("continuous CLI lookup failure closes and revokes the host capability before any model starts", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  let closed = 0, starts = 0, endpoints = 0;
  const context = createCodeExecutionContext({
    performAction() {}, readSource() {}, getState() {},
    close() { closed++; return { settled: true }; },
  });
  const provider = f.create(() => { starts++; assert.fail("lookup failure must not launch exec"); }, {}, {
    commandLocator: { async resolve() { throw error("STRUCTURED_PROVIDER_UNAVAILABLE"); } },
    appServerRunner: { async run() { starts++; assert.fail("lookup failure must not launch App Server"); } },
    codeExecutionFactory() { endpoints++; assert.fail("lookup failure precedes endpoint construction"); },
  });
  try {
    await assert.rejects(provider.generate(request({ codeExecutionContext: context })), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
    assert.equal(closed, 1);
    assert.throws(() => beginCodeExecutionSession(context), { code: "CODE_EXECUTION_SESSION_REVOKED" });
    assert.equal(endpoints, 0);
    assert.equal(starts, 0);
    assert.equal(f.calls.length, 0);
  } finally { await provider.close(); }
  assert.equal(closed, 1);
});

test("native code reader reaches the full audited BOM source tail and preserves exact write proof", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  const source = auditedCode();
  const provider = f.create(() => assert.fail("must use native app-server"), {}, { appServerRunner: { async run(call) {
    assert.equal(call.appServer.isolation.reader.url.includes("/code-read/"), true);
    assert.equal(call.maxStdoutBytes, 64 * 1024 * 1024);
    assert.equal(call.appServer.input.includes(source.document.content), false);
    assert.equal(await readAuditedPages(call.appServer.isolation.reader.url, source.document.path), source.document.content);
    const manifest = JSON.parse(await readFile(path.join(call.cwd, "code-read-manifest.json"), "utf8"));
    assert.deepEqual(manifest, { documents: [{ path: source.document.path, bytes: source.document.bytes }] });
    await writeFile(path.join(call.cwd, "last-message.json"), JSON.stringify({ result: JSON.stringify(codeDecision({ type: "write_text", path: source.document.path, content: "replacement" })) }));
    return success();
  } } });
  const result = JSON.parse(await provider.generate(request({ codeReadContext: source.context })));
  assert.equal(result.action.type, "write_text");
  assert.equal(hasCompleteCodeRead(source.context, { ...source.binding, ...source.document }), true);
  await provider.close();
});

test("native completion rejects a truncated preview without all audited pages", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  const source = auditedCode();
  const provider = f.create(result, {}, { appServerRunner: { async run(call) {
    await readAuditedPages(call.appServer.isolation.reader.url, source.document.path, { firstPageOnly: true });
    await writeFile(path.join(call.cwd, "last-message.json"), JSON.stringify({ result: JSON.stringify(codeDecision({ type: "complete", outcome: "done", evidence: [] })) }));
    return success();
  } } });
  await assert.rejects(provider.generate(request({ codeReadContext: source.context })), { code: "CODE_ARTIFACT_READ_INCOMPLETE" });
  assert.equal(hasCompleteCodeRead(source.context, { ...source.binding, ...source.document }), false);
  await provider.close();
});

test("native reader maps invalid controlled artifacts explicitly and rejects serialized capability copies", async (t) => {
  const f = await fixture(t); const source = auditedCode();
  const provider = f.create(() => assert.fail("invalid reader must not start a model"), {}, {
    codeReaderFactory: async () => { throw error("CODE_READ_DOCUMENT_INVALID"); },
  });
  await assert.rejects(provider.generate(request({ codeReadContext: source.context })), { code: "CODE_ARTIFACT_READ_INVALID" });
  await assert.rejects(provider.generate(request({ codeReadContext: structuredClone(source.context) })), /codeReadContext is invalid/);
  assert.equal(hasCompleteCodeRead(source.context, { ...source.binding, ...source.document }), false);
  await provider.close();
});

test("native code reader allows a newly created file without requiring an existing-file read", async (t) => {
  const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
  const source = auditedCode();
  const provider = f.create(result, {}, { appServerRunner: { async run(call) {
    await writeFile(path.join(call.cwd, "last-message.json"), JSON.stringify({ result: JSON.stringify(codeDecision({ type: "write_text", path: "src/new.cpp", content: "new file" })) }));
    return success();
  } } });
  assert.equal(JSON.parse(await provider.generate(request({ codeReadContext: source.context }))).action.path, "src/new.cpp");
  assert.equal(hasCompleteCodeRead(source.context, { ...source.binding, ...source.document }), false);
  await provider.close();
});

test("native code reader revokes full-read proof on invalid output, cleanup failure, and cancellation", async (t) => {
  for (const scenario of ["invalid-business-output", "cleanup-failure", "cancel-after-commit"]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t); f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
      const source = auditedCode(); const controller = new AbortController();
      const provider = f.create(result, {}, {
        ...(scenario === "cancel-after-commit" ? { codeReaderFactory: async (context, options) => {
          const reader = await createCodeJobArtifactReader(context, options);
          return { ...reader, commit() { reader.commit(); controller.abort(); } };
        } } : {}),
        appServerRunner: { async run(call) {
          await readAuditedPages(call.appServer.isolation.reader.url, source.document.path);
          if (scenario === "cleanup-failure") await writeFile(path.join(call.cwd, "unexpected-runtime-file"), "preserve unknown file");
          const action = scenario === "invalid-business-output" ? { type: "write_text", path: source.document.path, content: "replacement", untrusted: true }
            : { type: "write_text", path: source.document.path, content: "replacement" };
          await writeFile(path.join(call.cwd, "last-message.json"), JSON.stringify({ result: JSON.stringify(codeDecision(action)) }));
          return success();
        } },
      });
      await assert.rejects(provider.generate(request({ codeReadContext: source.context, signal: controller.signal })), {
        code: scenario === "cleanup-failure" ? "STRUCTURED_PROVIDER_CLEANUP_FAILED"
          : scenario === "cancel-after-commit" ? "STRUCTURED_PROVIDER_CANCELLED" : "STRUCTURED_PROVIDER_RESPONSE_INVALID",
      });
      assert.equal(hasCompleteCodeRead(source.context, { ...source.binding, ...source.document }), false);
      await provider.close();
    });
  }
});

test('opt-in app-server retains native home and explicit capability isolation before starting a model',async(t)=>{
  const f=await fixture(t);const calls=[];
  f.environment.DIH_CODEX_NATIVE_TRANSPORT='app-server';
  const provider=f.create(()=>assert.fail('must not silently fall back to exec'),{}, {appServerRunner:{async run(call){
    calls.push(call);await writeFile(path.join(call.cwd,'last-message.json'),JSON.stringify({result:JSON.stringify({ok:true})}));
    return success(JSON.stringify({type:'thread.started',thread_id:'thread-42'}));
  }}});
  assert.deepEqual(JSON.parse(await provider.generate(request())),{ok:true});
  assert.equal(calls[0].args.includes('--strict-config'),false);
  for(const flag of ['--ignore-user-config','--ignore-rules'])assert.equal(calls[0].args.includes(flag),false);
  for(const feature of ['hooks','plugins','apps','multi_agent','shell_tool'])assert.ok(calls[0].args.includes(`features.${feature}=false`),feature);
  assert.equal(calls[0].appServer.isolation.ephemeral,true);
  assert.ok(calls[0].appServer.isolation.agentConfigPath.endsWith('reviewer.toml'));
  assert.equal(calls[0].env.CODEX_HOME,f.home);await provider.close();
});

test('unavailable production live transport leaves no unknown native session or active marker',async(t)=>{
  const f=await fixture(t);f.environment.DIH_CODEX_NATIVE_TRANSPORT='app-server';
  const provider=f.create(()=>assert.fail('must not fall back to exec'));
  assert.equal((await provider.readStatus()).state,'cli_unavailable');
  await assert.rejects(provider.generate(request({sessionKey:'pr:42'})),{code:'STRUCTURED_PROVIDER_UNAVAILABLE'});
  assert.deepEqual(await readdir(path.join(f.runtime,'sessions')),[]);
  assert.deepEqual(await readdir(f.runtime),['sessions']);await provider.close();
});

test('cancellation racing a certified unavailable live transport still clears a fresh session journal',async(t)=>{
  const f=await fixture(t);f.environment.DIH_CODEX_NATIVE_TRANSPORT='app-server';const controller=new AbortController();
  const provider=f.create(()=>assert.fail('must not fall back'),{}, {appServerRunner:{async run(){
    try{return await new CodexAppServerRunner().run({});}catch(error){controller.abort();throw error;}
  }}});
  await assert.rejects(provider.generate(request({sessionKey:'pr:42',signal:controller.signal})),{code:'STRUCTURED_PROVIDER_CANCELLED'});
  assert.deepEqual(await readdir(path.join(f.runtime,'sessions')),[]);await provider.close();
});

async function result(invocation, value = { ok: true }, threadId = "thread-42") {
  invocation.duplex?.onOutput({stream:'stdout',chunk:Buffer.from('{"type":"turn.started"}\n')});
  await writeFile(invocation.args[invocation.args.indexOf("--output-last-message") + 1], JSON.stringify({ result: JSON.stringify(value) }));
  return success(JSON.stringify({ type: "thread.started", thread_id: threadId }));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "native-codex-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "codex-home");
  await mkdir(home);
  await writeFile(path.join(home, "auth.json"), "private-native-auth");
  await writeFile(path.join(home, "config.toml"), 'model = "user-preferred-model"\n');
  const calls = [];
  const environment = { ...process.env, DIH_CODEX_NATIVE_TRANSPORT: 'exec', CODEX_HOME: home, GH_TOKEN: "private-gh-token", OPENAI_API_KEY: "must-not-override-native-login", NODE_OPTIONS: "must-not-inject", GIT_SSH_COMMAND: "must-not-inject" };
  const dependencies = {
    environment, temporaryRoot: path.join(root, "runtime"),
    commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: [] }; } },
    rootDirectoryManager: { async prepare({ directory, validateLocation, signal }) {
      signal?.throwIfAborted(); await validateLocation(); await mkdir(directory, { recursive: true });
      const stat = await lstat(directory, { bigint: true });
      return { path: await realpath(directory), device: String(stat.dev), inode: String(stat.ino) };
    } },
  };
  const create = (handler = (call) => result(call), optionOverrides = {}, overrides = {}) => createNativeCodexBrainProvider({ ...options, ...optionOverrides }, {
    ...dependencies, processRunner: { async run(invocation) { calls.push(invocation); return handler(invocation, calls.length); } }, ...overrides,
  });
  return { root, home, calls, environment, dependencies, create, runtime: `${dependencies.temporaryRoot}-native` };
}

test('native Windows transport defaults to live app-server with an explicit exec fallback',async(t)=>{
  const f=await fixture(t);delete f.environment.DIH_CODEX_NATIVE_TRANSPORT;
  const provider=f.create();
  assert.equal(provider.transport,process.platform==='win32'?'app-server':'exec');
  await provider.close();
  f.environment.DIH_CODEX_NATIVE_TRANSPORT='exec';
  const fallback=f.create();assert.equal(fallback.transport,'exec');await fallback.close();
});

test("native provider runs a real fixture CLI in the original home and resumes its thread in place", async (t) => {
  const f = await fixture(t);
  const script = path.join(f.root, "fixture-cli.cjs");
  await writeFile(script, `
    const fs = require('node:fs'); const path = require('node:path');
    const args = process.argv.slice(2); let input = '';
    process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const home = process.env.CODEX_HOME;
      const resume = args.indexOf('resume');
      const threadId = resume >= 0 ? args[resume + 1] : 'fixture-native-thread';
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      fs.appendFileSync(path.join(home, 'sessions', threadId + '.jsonl'), JSON.stringify({ input, args }) + '\\n');
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ result: JSON.stringify({ ok: true }) }));
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n');
    });
  `);
  const nativeRunner = createTestSupervisedProcessRunner({ platform: process.platform, descriptorMaterializer: async (descriptor) => descriptor });
  const create = () => f.create(result, { timeoutMs: 15_000 }, { processRunner: nativeRunner, commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: [script] }; } } });
  const first = create();
  assert.deepEqual(JSON.parse(await first.generate(request({ sessionKey: "pr:42" }))), { ok: true });
  await first.close();
  const second = create();
  assert.deepEqual(JSON.parse(await second.generate(request({ sessionKey: "pr:42" }))), { ok: true });
  await second.close();
  const transcript = (await readFile(path.join(f.home, "sessions", "fixture-native-thread.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(transcript.length, 2);
  assert.ok(!transcript[0].args.includes("resume"));
  assert.equal(transcript[1].args[transcript[1].args.indexOf("resume") + 1], "fixture-native-thread");
  assert.ok(transcript.every((turn) => !turn.args.join(" ").includes("PRIVATE_TASK_INPUT")));
  assert.ok(transcript.every((turn) => turn.input.includes("PRIVATE_TASK_INPUT")));
  assert.equal(await readFile(path.join(f.home, "auth.json"), "utf8"), "private-native-auth");
  assert.equal(await readFile(path.join(f.home, "config.toml"), "utf8"), 'model = "user-preferred-model"\n');
  assert.deepEqual((await readdir(f.home)).sort(), ["auth.json", "config.toml", "sessions"]);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test("native process uses read-only native login with scrubbed environment and safe model arguments", async (t) => {
  const f = await fixture(t);
  const provider = f.create();
  assert.equal(provider.supportsEntitySessions, true);
  assert.equal(provider.sessionIsolationKey, "codex-cli:codex-native-login");
  assert.equal(provider.supportsReviewReading, true);
  assert.equal(provider.remote, true);
  assert.equal(provider.singleAttempt, true);
  await provider.generate(request());
  const [call] = f.calls;
  assert.equal(call.env.CODEX_HOME, f.home);
  for (const secret of ["GH_TOKEN", "OPENAI_API_KEY", "NODE_OPTIONS", "GIT_SSH_COMMAND"]) assert.ok(!Object.hasOwn(call.env, secret));
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral"]) assert.ok(call.args.includes(flag));
  assert.equal(call.args[call.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(call.args.includes('approval_policy="never"'));
  assert.ok(call.args.includes('model_reasoning_effort="high"'));
  assert.ok(call.args.includes("project_doc_max_bytes=0"));
  assert.ok(!call.args.includes("shell_tool"));
  await assert.rejects(provider.generate(request({ model: "--dangerous-argument" })), TypeError);
  assert.equal(f.calls.length, 1);
});

test("a raw native provider registers with BrainRouter and preserves its authorized entity session", async (t) => {
  const f = await fixture(t);
  const provider = f.create();
  const router = new BrainRouter({ providers: [provider] });
  const brain = { provider: provider.id, model: "gpt-6.1-sol", remoteData: { requirements: true, code: false, memory: false } };
  const input = { brain, messages: request().messages, schema, dataClasses: ["requirements"], sessionKey: "pr:42" };
  assert.equal(router.describe(brain).supportsReviewReading, true);
  assert.deepEqual(JSON.parse(await router.generate(input)), { ok: true });
  assert.deepEqual(JSON.parse(await router.generate(input)), { ok: true });
  assert.ok(!f.calls[0].args.includes("resume"));
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf("resume") + 1], "thread-42");
  await provider.close();
});

test("native status runs only login status, returns minimal projection and does not execute a model", async (t) => {
  const f = await fixture(t);
  const provider = f.create(async () => success("Logged in using ChatGPT\n"));
  assert.deepEqual(await provider.readStatus(), { schemaVersion: 1, state: "available", cliAvailable: true, fileLoginAvailable: true, credentialMode: "codex-native-login" });
  assert.deepEqual(f.calls[0].args, ["login", "status"]);
  assert.equal(f.calls[0].env.CODEX_HOME, f.home);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test("native login status failure distinguishes missing login from a missing CLI", async (t) => {
  const f = await fixture(t);
  const provider = f.create(async () => { throw error("STRUCTURED_PROVIDER_PROCESS_EXITED"); });
  assert.deepEqual(await provider.readStatus(), { schemaVersion: 1, state: "file_login_unavailable", cliAvailable: true, fileLoginAvailable: false, credentialMode: "codex-native-login" });
  assert.deepEqual(f.calls[0].args, ["login", "status"]);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test("native FIFO is shared across providers and a cancelled queued request never launches", async (t) => {
  const f = await fixture(t);
  const started = gate(); const finish = gate();
  let running = 0; let maximum = 0;const inputs=[];
  const handler = async (call, count) => {
    inputs.push(await readFile(path.join(call.cwd,'task.json'),'utf8'));
    running += 1; maximum = Math.max(maximum, running);
    if (count === 1) { started.resolve(); await finish.promise; }
    try { return await result(call); } finally { running -= 1; }
  };
  const first = f.create(handler); const second = f.create(handler);
  const a = first.generate(request()); await started.promise;
  const b = second.generate(request({ messages: [{ role: "user", content: "SECOND" }] }));
  const controller = new AbortController();
  const c = second.generate(request({ signal: controller.signal }));
  const cancelled = assert.rejects(c, { code: "STRUCTURED_PROVIDER_CANCELLED" }); controller.abort(); await cancelled;
  assert.equal(f.calls.length, 1);
  finish.resolve(); await Promise.all([a, b]);
  assert.equal(maximum, 1); assert.equal(f.calls.length, 2);
  assert.ok(inputs[1].includes("SECOND"));
});

test("native availability does not queue behind the first active model in the shared home", async (t) => {
  const f = await fixture(t);
  const started = gate();
  const finish = gate();
  const handler = async (call, count) => {
    if (call.args[0] === "login") return success("Logged in using ChatGPT\n");
    if (count === 1) { started.resolve(); await finish.promise; }
    return result(call);
  };
  const first = f.create(handler);
  const second = f.create(handler);
  const generation = first.generate(request());
  await started.promise;
  let available = false;
  const probe = second.checkAvailability().then(() => { available = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(available, true, "an active model must not make another role time out before claiming");
    assert.equal(f.calls.length, 1, "do not launch a redundant login probe");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(second.checkAvailability({ signal: controller.signal }), { code: "STRUCTURED_PROVIDER_CANCELLED" });
    f.environment.DIH_CODEX_NATIVE_TRANSPORT = "app-server";
    const unsupported = f.create(handler, {}, { appServerRunner: { supportsContainedExecution: false } });
    await assert.rejects(unsupported.checkAvailability(), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
    await unsupported.close();
    await second.close();
    await assert.rejects(second.checkAvailability(), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
  } finally {
    finish.resolve();
    await Promise.all([generation, probe]);
    await first.close();
    await second.close();
  }
});

test("native timeout waits for supervised exit before the next queued provider launches", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = gate(); const aborted = gate(); const reaped = gate();
  const slow = f.create(async (call) => {
    call.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await reaped.promise;
    return result(call);
  }, { timeoutMs: 35 });
  const fast = f.create();
  const first = slow.generate(request());
  const failure = assert.rejects(first, { code: "STRUCTURED_PROVIDER_TIMEOUT" });
  await started.promise;
  t.mock.timers.tick(35);
  await aborted.promise;
  const next = fast.generate(request());
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 1);
  reaped.resolve(); await failure; await next;
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test("native cancellation waits for supervised cleanup beyond ten seconds without blocking the home", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = gate(), aborted = gate(), reaped = gate();
  const provider = f.create(async call => {
    call.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    await reaped.promise;
    return result(call);
  });
  const controller = new AbortController();
  const generation = provider.generate(request({ signal: controller.signal }));
  const cancelled = assert.rejects(generation, { code: "STRUCTURED_PROVIDER_CANCELLED" });
  let settled = false;
  generation.then(() => { settled = true; }, () => { settled = true; });
  await started.promise;
  controller.abort();
  await aborted.promise;
  await new Promise(setImmediate);
  t.mock.timers.tick(10_001);
  await new Promise(setImmediate);
  assert.equal(settled, false, "supervision still owns the bounded teardown");
  t.mock.timers.tick(5_000);
  reaped.resolve();
  await cancelled;
  await provider.close();
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test("native inner result preserves literal string whitespace while the outer envelope stays strict", async (t) => {
  const f = await fixture(t);
  const expected = { text: "line one\nline two\tindent\r\nend", literal: "\\n" };
  const provider = f.create(async call => {
    const finished = await result(call);
    const inner = JSON.stringify(expected).replace('one\\nline', 'one\nline').replace('two\\tindent', 'two\tindent').replace('indent\\r\\nend', 'indent\r\nend');
    await writeFile(call.args[call.args.indexOf("--output-last-message") + 1], JSON.stringify({ result: inner }));
    return finished;
  });
  try {
    assert.deepEqual(JSON.parse(await provider.generate(request({ schema: { type: "object" } }))), expected);
  } finally { await provider.close(); }
});

for (const [label, serialized] of [
  ['duplicate decoded keys', JSON.stringify({ result: '{"text":"line\nbreak","text":"duplicate"}' })],
  ['dangerous keys', JSON.stringify({ result: '{"text":"line\nbreak","__proto__":{}}' })],
  ['raw whitespace in the outer envelope', '{"result":"{\n}"}'],
]) test(`native string normalization still rejects ${label}`, async t => {
  const f = await fixture(t);
  const provider = f.create(async call => {
    const finished = await result(call);
    await writeFile(call.args[call.args.indexOf("--output-last-message") + 1], serialized);
    return finished;
  });
  try { await assert.rejects(provider.generate(request()), { code: "STRUCTURED_PROVIDER_RESPONSE_INVALID" }); }
  finally { await provider.close(); }
});

test("malformed output keeps native session progress and does not fence later work", async (t) => {
  const f = await fixture(t);
  const bad = f.create(async (call) => {
    await result(call);
    await writeFile(call.args[call.args.indexOf("--output-last-message") + 1], '{"result":"bad JSON"}');
    return success('{"type":"thread.started","thread_id":"thread-42"}');
  });
  await assert.rejects(bad.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_RESPONSE_INVALID" });
  await bad.close();
  const good = f.create();
  await good.generate(request({ sessionKey: "pr:42" }));
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf("resume") + 1], "thread-42");
});

test("a cancelled fresh session saves the emitted native thread after confirmed reaping", async (t) => {
  const f = await fixture(t);
  const started = gate(); const finish = gate(); const controller = new AbortController();
  const provider = f.create(async (call) => { started.resolve(); await finish.promise; return result(call, { ok: true }, "cancelled-native-thread"); });
  const attempt = provider.generate(request({ sessionKey: "pr:42", signal: controller.signal }));
  const cancelled = assert.rejects(attempt, { code: "STRUCTURED_PROVIDER_CANCELLED" });
  await started.promise; controller.abort();
  assert.equal(f.calls.length, 1);
  finish.resolve(); await cancelled;
  await provider.close();
  await f.create((call) => result(call, { ok: true }, "cancelled-native-thread")).generate(request({ sessionKey: "pr:42" }));
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf("resume") + 1], "cancelled-native-thread");
  assert.equal((await readdir(path.join(f.runtime, "sessions"))).some((name) => name.endsWith(".pending")), false);
});

test("a real unsuccessful process preserves its emitted fresh thread and the recreated provider resumes it", async (t) => {
  const f = await fixture(t);
  const transcriptFile = path.join(f.root, "failed-process-calls.jsonl");
  const script = `const fs = require('node:fs'); const args = process.argv.slice(1);
    fs.appendFileSync(${JSON.stringify(transcriptFile)}, JSON.stringify(args) + '\\n');
    const resume = args.indexOf('resume'); const threadId = 'real-failed-thread';
    if (resume < 0) {
      process.stdout.write(JSON.stringify({type: 'thread.started', thread_id: threadId}) + '\\n', () => { process.exitCode = 3; });
    } else {
      if (args[resume + 1] !== threadId) throw new Error('unexpected replacement thread');
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({result: JSON.stringify({ok: true})}));
      process.stdout.write(JSON.stringify({type: 'thread.started', thread_id: threadId}) + '\\n');
    }`;
  const runner = createTestSupervisedProcessRunner({ platform: process.platform, descriptorMaterializer: async (descriptor) => descriptor });
  const create = () => f.create(result, { timeoutMs: 15_000 }, {
    processRunner: runner,
    commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: ["-e", script, "--"] }; } },
  });
  const first = create();
  await assert.rejects(first.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
  const references = await readdir(path.join(f.runtime, "sessions"));
  assert.equal(references.length, 1);
  assert.ok(references[0].endsWith(".json"));
  assert.equal(JSON.parse(await readFile(path.join(f.runtime, "sessions", references[0]), "utf8")).threadId, "real-failed-thread");
  await first.close();

  const second = create();
  assert.deepEqual(JSON.parse(await second.generate(request({ sessionKey: "pr:42" }))), { ok: true });
  await second.close();
  const turns = (await readFile(transcriptFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(turns.length, 2);
  assert.ok(!turns[0].includes("resume"));
  assert.equal(turns[1][turns[1].indexOf("resume") + 1], "real-failed-thread");
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test("real cancellation after a fresh thread event saves its exact ID after confirmed process reaping", async (t) => {
  const f = await fixture(t);
  const readyFile = path.join(f.root, "cancelled-process-ready.json");
  const script = `const fs = require('node:fs'); const args = process.argv.slice(1);
    const resume = args.indexOf('resume'); const threadId = 'real-cancelled-thread';
    if (resume < 0) {
      process.stdout.write(JSON.stringify({type: 'thread.started', thread_id: threadId}) + '\\n', () => {
        fs.writeFileSync(${JSON.stringify(`${readyFile}.tmp`)}, JSON.stringify({pid: process.pid}));
        fs.renameSync(${JSON.stringify(`${readyFile}.tmp`)}, ${JSON.stringify(readyFile)});
        setInterval(() => {}, 1000);
      });
    } else {
      if (args[resume + 1] !== threadId) throw new Error('unexpected replacement thread');
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({result: JSON.stringify({ok: true})}));
      process.stdout.write(JSON.stringify({type: 'thread.started', thread_id: threadId}) + '\\n');
    }`;
  const runner = createTestSupervisedProcessRunner({ platform: process.platform, descriptorMaterializer: async (descriptor) => descriptor });
  const create = () => f.create(result, { timeoutMs: 15_000 }, {
    processRunner: runner,
    commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: ["-e", script, "--"] }; } },
  });
  const first = create();
  const controller = new AbortController();
  const cancelled = assert.rejects(first.generate(request({ sessionKey: "pr:42", signal: controller.signal })), { code: "STRUCTURED_PROVIDER_CANCELLED" });
  let ready;
  try {
    const deadline = Date.now() + 5_000;
    while (!ready) {
      try { ready = JSON.parse(await readFile(readyFile, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    controller.abort();
    await cancelled;
    await first.close();
  }
  assert.throws(() => process.kill(ready.pid, 0), { code: "ESRCH" });
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
  const references = await readdir(path.join(f.runtime, "sessions"));
  assert.equal(references.length, 1);
  assert.ok(references[0].endsWith(".json"));
  assert.equal(JSON.parse(await readFile(path.join(f.runtime, "sessions", references[0]), "utf8")).threadId, "real-cancelled-thread");

  const second = create();
  assert.deepEqual(JSON.parse(await second.generate(request({ sessionKey: "pr:42" }))), { ok: true });
  await second.close();
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test("settled cleanup preserves disguised runner inputs and unknown files", async (t) => {
  for (const kind of ["directory", "hard-link", "unknown-name"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const outside = path.join(f.root, "must-preserve.txt");
      await writeFile(outside, "must preserve this content");
      const name = kind === "unknown-name" ? ".supervised-stdin-user-input.bin" : `.supervised-stdin-${"a".repeat(32)}.bin`;
      let directory;
      const provider = f.create(async (call) => {
        directory = call.cwd;
        const entry = path.join(directory, name);
        if (kind === "directory") await mkdir(entry);
        else if (kind === "hard-link") await link(outside, entry);
        else await writeFile(entry, "unknown invocation content");
        return result(call);
      });
      await assert.rejects(provider.generate(request()), { code: "STRUCTURED_PROVIDER_CLEANUP_FAILED" });
      await provider.close();
      assert.deepEqual(await readdir(directory), [name]);
      assert.equal(await readFile(outside, "utf8"), "must preserve this content");
      assert.ok((await readdir(f.runtime)).includes(path.basename(directory)));
      assert.equal((await readdir(f.runtime)).some((entry) => entry.startsWith("active-")), false);
    });
  }
});

test("conflicting fresh thread IDs preserve the unknown journal and never launch a replacement session", async (t) => {
  const f = await fixture(t);
  const provider = f.create(async (call) => {
    await result(call, { ok: true }, "first-fresh-thread");
    return success([
      JSON.stringify({ type: "thread.started", thread_id: "first-fresh-thread" }),
      JSON.stringify({ type: "thread.started", thread_id: "conflicting-fresh-thread" }),
    ].join("\n"));
  });
  await assert.rejects(provider.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  await provider.close();
  const files = await readdir(path.join(f.runtime, "sessions"));
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith(".pending"));
  assert.equal(JSON.parse(await readFile(path.join(f.runtime, "sessions", files[0]), "utf8")).threadId, null);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
  await assert.rejects(f.create().generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal(f.calls.length, 1);
});

test("a conflicting resumed thread cannot overwrite the known ID and later resumes use the original thread", async (t) => {
  const f = await fixture(t);
  const first = f.create((call) => result(call, { ok: true }, "known-native-thread"));
  await first.generate(request({ sessionKey: "pr:42" }));
  await first.close();
  const [reference] = await readdir(path.join(f.runtime, "sessions"));
  const before = await readFile(path.join(f.runtime, "sessions", reference), "utf8");
  const conflicting = f.create((call) => result(call, { ok: true }, "unexpected-native-thread"));
  await assert.rejects(conflicting.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  await conflicting.close();
  assert.equal(await readFile(path.join(f.runtime, "sessions", reference), "utf8"), before);
  assert.equal(JSON.parse(await readFile(path.join(f.runtime, "sessions", `${reference}.pending`), "utf8")).threadId, "known-native-thread");
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);

  const next = f.create((call) => result(call, { ok: true }, "known-native-thread"));
  assert.deepEqual(JSON.parse(await next.generate(request({ sessionKey: "pr:42" }))), { ok: true });
  await next.close();
  assert.equal(f.calls.length, 3);
  for (const call of f.calls.slice(1)) assert.equal(call.args[call.args.indexOf("resume") + 1], "known-native-thread");
  assert.deepEqual(await readdir(path.join(f.runtime, "sessions")), [reference]);
});

test("missing fresh thread metadata blocks that entity without fencing unrelated work", async (t) => {
  const f = await fixture(t);
  const bad = f.create(async (call) => { await result(call); return success(); });
  await assert.rejects(bad.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  await bad.close();
  const next = f.create();
  await assert.rejects(next.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal(f.calls.length, 1);
  await next.generate(request({ sessionKey: "pr:43" }));
  assert.equal(f.calls.length, 2);
});

test("pre-process reference failure neither launches CLI nor blocks the next settled request", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const provider = f.create((call) => result(call), {}, { nativeSessionStore: {
    async read() { if (attempts++ === 0) throw error("STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED"); return null; },
    async save() {},
  } });
  await assert.rejects(provider.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal(f.calls.length, 0);
  await provider.generate(request({ sessionKey: "pr:42" }));
  assert.equal(f.calls.length, 1);
});

test("a certified descriptor preparation failure clears the unknown journal so the same entity can retry", async (t) => {
  const f = await fixture(t);
  let materializations = 0;
  const runner = createTestSupervisedProcessRunner({
    platform: process.platform,
    descriptorMaterializer: async (descriptor) => {
      if (materializations++ === 0) throw error("STRUCTURED_PROVIDER_UNAVAILABLE");
      return descriptor;
    },
  });
  const script = `const fs = require('node:fs'); const args = process.argv.slice(1);
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({result: JSON.stringify({ok: true})}));
    process.stdout.write(JSON.stringify({type: 'thread.started', thread_id: 'after-preparation-failure'}));`;
  const provider = f.create(result, { timeoutMs: 15_000 }, {
    processRunner: runner,
    commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: ["-e", script, "--"] }; } },
  });

  await assert.rejects(provider.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
  assert.deepEqual(await readdir(path.join(f.runtime, "sessions")), []);
  assert.deepEqual(JSON.parse(await provider.generate(request({ sessionKey: "pr:42" }))), { ok: true });
  assert.equal(materializations, 2);
  assert.equal((await readdir(path.join(f.runtime, "sessions"))).some((name) => name.endsWith(".pending")), false);
  await provider.close();
});

test("an uncertified unavailable error cannot clear an unknown native session journal", async (t) => {
  const f = await fixture(t);
  const provider = f.create(async () => {
    throw Object.assign(error("STRUCTURED_PROVIDER_UNAVAILABLE"), { processNotStarted: true });
  });
  await assert.rejects(provider.generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal((await readdir(path.join(f.runtime, "sessions"))).some((name) => name.endsWith(".pending")), true);
  await provider.close();
  await assert.rejects(f.create().generate(request({ sessionKey: "pr:42" })), { code: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" });
  assert.equal(f.calls.length, 1);
});

test("cancellation during real runner preparation clears only the certified unknown journal", async (t) => {
  const f = await fixture(t);
  const entered = gate();
  let materializations = 0;
  const runner = createTestSupervisedProcessRunner({
    platform: process.platform,
    descriptorMaterializer: async (descriptor, { signal }) => {
      if (materializations++ === 0) {
        entered.resolve();
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return descriptor;
    },
  });
  const script = `const fs = require('node:fs'); const args = process.argv.slice(1);
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({result: JSON.stringify({ok: true})}));
    process.stdout.write(JSON.stringify({type: 'thread.started', thread_id: 'after-preparation-cancellation'}));`;
  const provider = f.create(result, { timeoutMs: 15_000 }, {
    processRunner: runner,
    commandLocator: { async resolve() { return { command: process.execPath, prefixArgs: ["-e", script, "--"] }; } },
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(provider.generate(request({ sessionKey: "pr:42", signal: controller.signal })), { code: "STRUCTURED_PROVIDER_CANCELLED" });
  await entered.promise;
  controller.abort();
  await cancelled;
  assert.deepEqual(await readdir(path.join(f.runtime, "sessions")), []);
  assert.deepEqual(JSON.parse(await provider.generate(request({ sessionKey: "pr:42" }))), { ok: true });
  assert.equal(materializations, 2);
  await provider.close();
});

test("uncertain reap preserves the owned invocation and persistent marker and fences new work", async (t) => {
  const f = await fixture(t);
  const provider = f.create(async () => { throw error("STRUCTURED_PROVIDER_REAP_FAILED"); });
  await assert.rejects(provider.generate(request()), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  const entries = await readdir(f.runtime);
  assert.equal(entries.filter((name) => name.startsWith("active-")).length, 1);
  assert.equal(entries.filter((name) => name.startsWith("invocation-")).length, 1);
  await assert.rejects(f.create().generate(request()), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  assert.equal((await provider.readStatus()).state, "broker_blocked");
  await assert.rejects(provider.checkAvailability(), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  await assert.rejects(provider.close(), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  assert.equal(f.calls.length, 1);
});

test("an unconfirmed native invocation retains its entity and capacity slot without blocking unrelated PRs", async (t) => {
  const f = await fixture(t);
  let first = true;
  const provider = f.create(async call => {
    if (first) { first = false; throw error("STRUCTURED_PROVIDER_REAP_FAILED"); }
    return call.args[0] === "login" ? success("Logged in using ChatGPT") : result(call);
  }, {}, { maxConcurrentTurns: 2, allowConcurrentNativeHome: true });
  const held = "github:pull_request:owner/repo#42";
  await assert.rejects(provider.generate(request({ admissionEntityKey: held })), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  const retained = (await readdir(f.runtime)).find(name => name.startsWith("invocation-"));
  await provider.checkAvailability();
  await assert.rejects(provider.withAdmission({ entityKey: held }, () => assert.fail("the unknown entity remains fenced")), { code: "STRUCTURED_PROVIDER_BUSY" });
  const controller = new AbortController();
  const heldWaiter = assert.rejects(provider.withAdmission({ entityKey: held, waitForCapacity: true, signal: controller.signal }, () => assert.fail("unknown entity waiter cannot start")), { code: "STRUCTURED_PROVIDER_CANCELLED" });
  try {
    await provider.withAdmission({ entityKey: "github:pull_request:owner/repo#43" }, async () => {});
  } finally { controller.abort(); await heldWaiter; }
  assert.deepEqual(JSON.parse(await provider.generate(request({ admissionEntityKey: "github:pull_request:owner/repo#43" }))), { ok: true });
  const entries = await readdir(f.runtime);
  assert.ok(entries.includes(retained));
  assert.equal(entries.filter(name => name.startsWith("active-")).length, 1, "unknown stop evidence remains intact");
  const release = gate(), entered = gate();
  const remaining = provider.withAdmission({ entityKey: "github:pull_request:owner/repo#43" }, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  await assert.rejects(provider.withAdmission({ entityKey: "github:pull_request:owner/repo#44" }, () => assert.fail("unknown invocation still consumes a slot")), { code: "STRUCTURED_PROVIDER_BUSY" });
  release.resolve(); await remaining;
  await provider.close();
});

for (const variant of ["valid", "wrong-schema", "wrong-entity", "non-triage", "capacity-exhausted"]) {
  test(`legacy triage marker keeps a durable entity reservation after restart: ${variant}`, async t => {
    const f = await fixture(t);
    await mkdir(f.runtime);
    const count = variant === "capacity-exhausted" ? 2 : 1;
    for (let index = 0; index < count; index++) {
      const invocation = `invocation-${randomUUID()}`;
      const directory = path.join(f.runtime, invocation); await mkdir(directory);
      const input = { id: "github:pr:owner/repo#42", repo: "owner/repo", number: 42, workMode: variant === "non-triage" ? "owner" : "triage" };
      const wire = preparePrEmployeeAnalysis(input);
      if (variant === "wrong-schema") wire.schema = schema;
      if (variant === "wrong-entity") { const context = JSON.parse(wire.messages[1].content); context.id = "github:pr:other/repo#42"; wire.messages[1].content = JSON.stringify(context); }
      await writeFile(path.join(directory, "task.json"), JSON.stringify({ instruction: NATIVE_ADVISORY_INSTRUCTION, messages: wire.messages, schema: wire.schema }));
      await writeFile(path.join(f.runtime, `active-${nativeCodexDigest(nativeCodexHomeIdentity(f.home))}-${randomUUID()}.json`), JSON.stringify({ schemaVersion: 1, invocation, createdAt: Date.now() }));
    }
    const provider = f.create(call => call.args[0] === "login" ? success("Logged in using ChatGPT") : result(call), {}, { maxConcurrentTurns: 2, allowConcurrentNativeHome: true });
    await assert.rejects(provider.checkAvailability(), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
    if (variant !== "valid") {
      await assert.rejects(provider.checkAvailability(), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
      assert.equal(f.calls.length, 0);
      await assert.rejects(provider.close(), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
      return;
    }
    await provider.checkAvailability();
    await provider.checkAvailability();
    assert.equal((await provider.readStatus()).state, "available");
    await assert.rejects(provider.withAdmission({ entityKey: "github:pull_request:owner/repo#42" }, () => assert.fail("the legacy entity is held")), { code: "STRUCTURED_PROVIDER_BUSY" });
    assert.deepEqual(JSON.parse(await provider.generate(request({ admissionEntityKey: "github:pull_request:owner/repo#43" }))), { ok: true });
    assert.equal((await readdir(f.runtime)).filter(name => name.startsWith("active-")).length, 1);
    await provider.close();
  });
}

for (const number of [43, 42]) test(`legacy isolation accounts for a role's existing admission on PR ${number}`, async t => {
  const f = await fixture(t), invocation = `invocation-${randomUUID()}`;
  await mkdir(path.join(f.runtime, invocation), { recursive: true });
  const wire = preparePrEmployeeAnalysis({ id: "github:pr:owner/repo#42", repo: "owner/repo", number: 42, workMode: "triage" });
  await writeFile(path.join(f.runtime, invocation, "task.json"), JSON.stringify({ instruction: NATIVE_ADVISORY_INSTRUCTION, messages: wire.messages, schema: wire.schema }));
  await writeFile(path.join(f.runtime, `active-${nativeCodexDigest(nativeCodexHomeIdentity(f.home))}-${randomUUID()}.json`), JSON.stringify({ schemaVersion: 1, invocation, createdAt: Date.now() }));
  const provider = f.create(call => call.args[0] === "login" ? success("Logged in using ChatGPT") : result(call), {}, { maxConcurrentTurns: 2, allowConcurrentNativeHome: true });
  const entity = `github:pull_request:owner/repo#${number}`;
  await provider.withAdmission({ entityKey: entity }, async () => {
    await assert.rejects(provider.generate(request({ admissionEntityKey: entity })), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
    if (number === 42) {
      await assert.rejects(provider.checkAvailability(), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
      await assert.rejects(provider.generate(request({ admissionEntityKey: entity })), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
      assert.equal(f.calls.length, 0, "an existing same-entity reservation cannot bypass the unknown invocation");
      return;
    }
    await provider.checkAvailability();
    assert.deepEqual(JSON.parse(await provider.generate(request({ admissionEntityKey: entity }))), { ok: true });
  });
  await provider.checkAvailability();
  await assert.rejects(provider.withAdmission({ entityKey: "github:pull_request:owner/repo#42" }, () => assert.fail("legacy entity remains held")), { code: "STRUCTURED_PROVIDER_BUSY" });
  assert.equal((await readdir(f.runtime)).filter(name => name.startsWith("active-")).length, 1);
  await provider.close();
});

test("a retained process marker from an earlier service lifetime prevents a duplicate launch", async (t) => {
  const f = await fixture(t);
  await mkdir(f.runtime);
  const marker = `active-${nativeCodexDigest(nativeCodexHomeIdentity(f.home))}.json`;
  await writeFile(path.join(f.runtime, marker), '{"schemaVersion":1,"invocation":"owned-old-process"}');
  const provider = f.create();
  await assert.rejects(provider.generate(request()), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  assert.equal(f.calls.length, 0);
  assert.ok((await readdir(f.runtime)).includes(marker));
});

test('idle workforce availability reuses successful login evidence without starving model admission',async(t)=>{
  const f=await fixture(t);let probes=0,models=0;
  const handler=async call=>{
    if(call.args[0]==='login'){probes++;return success('Logged in using ChatGPT');}
    models++;return result(call);
  };
  const first=f.create(handler,{}, {maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  const second=f.create(handler,{}, {maxConcurrentTurns:2,allowConcurrentNativeHome:true});
  await first.checkAvailability();
  for(let cycle=0;cycle<3;cycle++){
    await Promise.all([first.checkAvailability(),second.checkAvailability()]);
    await Promise.all([
      first.withAdmission({entityKey:`pr:first-${cycle}`},()=>first.generate(request())),
      second.withAdmission({entityKey:`pr:second-${cycle}`},()=>second.generate(request())),
    ]);
  }
  assert.equal(probes,1,'idle scheduling cycles must not start another exclusive login probe');
  assert.equal(models,6,'both workforce slots remain available for real work');
  await first.close();await second.close();
});

test('a native execution failure invalidates positive availability and requires a fresh login check',async(t)=>{
  const f=await fixture(t);let probes=0,loggedIn=true;
  const provider=f.create(async call=>{
    if(call.args[0]==='login'){probes++;return success(loggedIn?'Logged in using ChatGPT':'Not logged in');}
    throw error('STRUCTURED_PROVIDER_PROCESS_FAILED');
  });
  await provider.checkAvailability();
  loggedIn=false;
  await assert.rejects(provider.generate(request()),{code:'STRUCTURED_PROVIDER_PROCESS_FAILED'});
  await assert.rejects(provider.checkAvailability(),{code:'STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE'});
  assert.equal(probes,2);
  loggedIn=true;await provider.checkAvailability();assert.equal(probes,3);
  await provider.close();
});

for(const code of ['STRUCTURED_PROVIDER_UNAVAILABLE','STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE',
  'STRUCTURED_PROVIDER_PROCESS_FAILED','STRUCTURED_PROVIDER_PROCESS_EXITED'])test(`a fresh-session ${code} invalidates shared availability before session recovery`,async(t)=>{
  const f=await fixture(t);let probes=0,models=0,loggedIn=true;
  const handler=async call=>{
    if(call.args[0]==='login'){probes++;return success(loggedIn?'Logged in using ChatGPT':'Not logged in');}
    models++;throw error(code);
  };
  const first=f.create(handler),second=f.create(handler);
  await first.checkAvailability();loggedIn=false;
  await assert.rejects(first.generate(request({sessionKey:'pr:42'})),{code:'STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED'});
  const journal=await readdir(path.join(f.runtime,'sessions'));
  assert.equal(journal.some(name=>name.endsWith('.pending')),true);
  await assert.rejects(second.generate(request({sessionKey:'pr:42'})),{code:'STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED'});
  assert.equal(models,1,'the unknown session journal must fence the same entity');
  await assert.rejects(second.checkAvailability(),{code:'STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE'});
  assert.equal(probes,2,'the shared native home must refresh stale login evidence');
  assert.deepEqual(await readdir(path.join(f.runtime,'sessions')),journal);
  await first.close();await second.close();
});

test('an explicit failed native status refresh cannot leave positive availability cached',async(t)=>{
  const f=await fixture(t);let probes=0,available=true;
  const provider=f.create(async()=>{
    probes++;
    if(!available)throw error('STRUCTURED_PROVIDER_PROCESS_FAILED');
    return success('Logged in using ChatGPT');
  });
  await provider.checkAvailability();available=false;
  assert.equal((await provider.readStatus()).state,'file_login_unavailable');
  await assert.rejects(provider.checkAvailability(),{code:'STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE'});
  assert.equal(probes,3);
  await provider.close();
});

test('idle native status probes recover login and notice credential loss while active models use cached status',async(t)=>{
  const f=await fixture(t),entered=gate(),finish=gate();let loggedIn=false,probes=0;
  const provider=f.create(async call=>{
    if(call.args[0]==='login'){probes++;return success(loggedIn?'Logged in using ChatGPT':'Not logged in');}
    entered.resolve();await finish.promise;return result(call);
  });
  assert.equal((await provider.readStatus()).state,'file_login_unavailable');
  loggedIn=true;await provider.checkAvailability();assert.equal(probes,2);
  const active=provider.generate(request());await entered.promise;
  assert.equal((await provider.readStatus()).state,'available');assert.equal(probes,2);
  finish.resolve();await active;
  loggedIn=false;assert.equal((await provider.readStatus()).state,'file_login_unavailable');assert.equal(probes,3);
  await provider.close();
});

for(const intentType of ['propose_github_review','complete','handoff'])test(`native review requires immutable reader completeness before ${intentType}`, async (t) => {
  const f = await fixture(t);
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "owner", baseRepository: "owner/repo", headRepository: "owner/repo", baseRefName: "main", headRefName: "feature", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) };
  let closed = 0; let checked = 0;
  const provider = f.create(async (call) => {
    assert.equal(await readFile(path.join(call.cwd, "review.diff"), "utf8"), "complete-diff");
    assert.ok(call.args.includes('mcp_servers.pr_review.required=true'));
    assert.equal(call.maxStdoutBytes, 64 * 1024 * 1024);
    return result(call, { intent: { type: intentType } });
  }, {}, { reviewReaderFactory: async () => ({ url: "http://127.0.0.1:12345/fixture", diffText: "complete-diff", manifestText: "{}",
    async assertComplete() { checked += 1; throw error("PR_REVIEW_READ_INCOMPLETE"); }, async close() { closed += 1; } }) });
  await assert.rejects(provider.generate(request({ reviewTarget: { gitTarget, pullRequestNumber: 42 } })), { code: "PR_REVIEW_READ_INCOMPLETE" });
  assert.equal(checked, 1); assert.equal(closed, 1);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});

test('native nonterminal review wait closes its reader without pretending completeness',async(t)=>{
  const f=await fixture(t);let checked=0,closed=0;
  const gitTarget={schemaVersion:1,provider:'github',sourceAccountId:'owner',baseRepository:'owner/repo',headRepository:'owner/repo',baseRefName:'main',headRefName:'feature',baseRefOid:'a'.repeat(40),headRefOid:'b'.repeat(40)};
  const provider=f.create(call=>result(call,{intent:{type:'wait_condition'}}),{}, {reviewReaderFactory:async()=>({url:'http://127.0.0.1:12345/fixture',diffText:'complete-diff',manifestText:'{}',
    async assertComplete(){checked++;throw error('PR_REVIEW_READ_INCOMPLETE');},async close(){closed++;}})});
  assert.equal(JSON.parse(await provider.generate(request({reviewTarget:{gitTarget,pullRequestNumber:42}}))).intent.type,'wait_condition');
  assert.equal(checked,0);assert.equal(closed,1);await provider.close();
});
