import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createNativeCodexBrainProvider } from "../src/adapters/native-codex-brain-provider.js";
import { nativeCodexDigest, nativeCodexHomeIdentity } from "../src/adapters/codex-native-session-store.js";
import { createTestSupervisedProcessRunner } from "../src/lib/supervised-process-runner.js";
import { BrainRouter } from "../src/services/brain-router.js";
import { CodexAppServerRunner } from '../src/lib/codex-app-server-runner.js';

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const request = (overrides = {}) => ({ model: "gpt-6.1-sol", reasoningEffort: "high", messages: [{ role: "user", content: "PRIVATE_TASK_INPUT" }], schema, ...overrides });
const error = (code) => Object.assign(new Error("private diagnostic must not escape"), { code });
const options = { id: "native-test", cliKind: "codex-cli", credentialMode: "codex-native-login", timeoutMs: 3000 };
const success = (stdout = "") => ({ exitCode: 0, signal: null, stdout, stderr: "", stdoutBytes: Buffer.from(stdout), stderrBytes: Buffer.alloc(0) });
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('opt-in app-server retains native config, rule and feature isolation before starting a model',async(t)=>{
  const f=await fixture(t);const calls=[];
  f.environment.DIH_CODEX_NATIVE_TRANSPORT='app-server';
  const provider=f.create(()=>assert.fail('must not silently fall back to exec'),{}, {appServerRunner:{async run(call){
    calls.push(call);await writeFile(path.join(call.cwd,'last-message.json'),JSON.stringify({result:JSON.stringify({ok:true})}));
    return success(JSON.stringify({type:'thread.started',thread_id:'thread-42'}));
  }}});
  assert.deepEqual(JSON.parse(await provider.generate(request())),{ok:true});
  for(const flag of ['--ignore-user-config','--ignore-rules','--strict-config'])assert.ok(calls[0].args.includes(flag),flag);
  for(const feature of ['hooks','plugins','apps','multi_agent'])assert.ok(calls[0].args.some((value,index)=>value==='--disable' && calls[0].args[index+1]===feature),feature);
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
  const environment = { ...process.env, CODEX_HOME: home, GH_TOKEN: "private-gh-token", OPENAI_API_KEY: "must-not-override-native-login", NODE_OPTIONS: "must-not-inject", GIT_SSH_COMMAND: "must-not-inject" };
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
  let running = 0; let maximum = 0;
  const handler = async (call, count) => {
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
  assert.ok(f.calls[1].input.toString().includes("SECOND"));
});

test("native timeout waits for supervised exit before the next queued provider launches", async (t) => {
  const f = await fixture(t);
  const aborted = gate(); const reaped = gate();
  const slow = f.create(async (call) => {
    call.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    await reaped.promise;
    return result(call);
  }, { timeoutMs: 35 });
  const fast = f.create();
  const first = slow.generate(request());
  const failure = assert.rejects(first, { code: "STRUCTURED_PROVIDER_TIMEOUT" });
  await aborted.promise;
  const next = fast.generate(request());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 1);
  reaped.resolve(); await failure; await next;
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
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
  await assert.rejects(provider.close(), { code: "STRUCTURED_PROVIDER_REAP_FAILED" });
  assert.equal(f.calls.length, 1);
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

test("native review requires immutable reader completeness and closes the read endpoint on failure", async (t) => {
  const f = await fixture(t);
  const gitTarget = { schemaVersion: 1, provider: "github", sourceAccountId: "owner", baseRepository: "owner/repo", headRepository: "owner/repo", baseRefName: "main", headRefName: "feature", baseRefOid: "a".repeat(40), headRefOid: "b".repeat(40) };
  let closed = 0; let checked = 0;
  const provider = f.create(async (call) => {
    assert.equal(await readFile(path.join(call.cwd, "review.diff"), "utf8"), "complete-diff");
    assert.ok(call.args.includes('mcp_servers.pr_review.required=true'));
    assert.equal(call.maxStdoutBytes, 64 * 1024 * 1024);
    return result(call, { intent: { type: "propose_github_review" } });
  }, {}, { reviewReaderFactory: async () => ({ url: "http://127.0.0.1:12345/fixture", diffText: "complete-diff", manifestText: "{}",
    async assertComplete() { checked += 1; throw error("PR_REVIEW_READ_INCOMPLETE"); }, async close() { closed += 1; } }) });
  await assert.rejects(provider.generate(request({ reviewTarget: { gitTarget, pullRequestNumber: 42 } })), { code: "PR_REVIEW_READ_INCOMPLETE" });
  assert.equal(checked, 1); assert.equal(closed, 1);
  assert.deepEqual(await readdir(f.runtime), ["sessions"]);
});
