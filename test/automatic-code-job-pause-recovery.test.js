import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticCodeJobPauseRecovery } from '../src/services/automatic-code-job-pause-recovery.js';

function fixture() {
  const job = { jobId: 'job-1', sequence: 1, revision: 12, status: 'paused', createdAt: '2026-10-10T03:00:00Z',
    grant: { requestedBy: { roleId: 'developer' } }, execution: { pendingAction: null, actionAdmission: null, uncertainty: null,
      pause: { from: 'active', reason: '等待人工处理（STRUCTURED_PROVIDER_RESPONSE_INVALID）', at: '2026-10-10T03:01:01Z' } } };
  const proof = { runId: 'run-1', mode: 'active', active: false, pendingCommand: null, stopUnconfirmed: false,
    receipt: { runId: 'run-1', kind: 'code-job', taskId: job.jobId, roleId: 'developer', phase: 'failed', stopConfirmed: true,
      outcomeCode: 'STRUCTURED_PROVIDER_RESPONSE_INVALID', session: { transport: 'app-server' },
      modelStartedAt: '2026-10-10T03:00:30Z', finishedAt: '2026-10-10T03:01:00Z' } };
  const calls = []; let eligible = true;
  const jobs = {
    async listPaused() { return { items: job.status === 'paused' ? [structuredClone(job)] : [] }; },
    async getForWorker() { return structuredClone(job); },
    async resume(value) {
      calls.push(value);
      if (value.expectedRevision !== job.revision || job.status !== 'paused') throw Object.assign(new Error('changed'), { code: 'CODE_JOB_REVISION_CONFLICT' });
      job.status = 'active'; job.revision++; job.execution.pause = null;
    },
  };
  const taskRuns = { async get(kind, id) { assert.equal(kind, 'code-job'); assert.equal(id, job.jobId); return structuredClone(proof); } };
  const eligibility = { async canRecover() { return eligible; } };
  return { job, proof, jobs, taskRuns, eligibility, calls, setEligible(value) { eligible = value; },
    create: () => new AutomaticCodeJobPauseRecovery({ jobs, taskRuns, eligibility }) };
}

test('settled provider format pause automatically resumes the same checkpoint once across recovery restart', async () => {
  const f = fixture();
  const result = await f.create().runCycle();
  assert.equal(result.resumed, 1);
  assert.deepEqual(f.calls, [{ jobId: 'job-1', expectedRevision: 12 }]);
  assert.equal(f.job.status, 'active');
  assert.equal((await f.create().runCycle()).scanned, 0);
});

for (const [name, change] of [
  ['owner job pause', f => { f.job.execution.pause.reason = '用户从本地指挥中枢暂停代码任务'; }],
  ['owner task pause', f => { f.proof.mode = 'paused'; }],
  ['pending owner command', f => { f.proof.pendingCommand = 'pause'; }],
  ['active process', f => { f.proof.active = true; }],
  ['unconfirmed stop', f => { f.proof.stopUnconfirmed = true; }],
  ['missing stop certificate', f => { f.proof.receipt.stopConfirmed = false; }],
  ['unrelated run', f => { f.proof.receipt.runId = 'other-run'; }],
  ['unrelated task', f => { f.proof.receipt.taskId = 'other-job'; }],
  ['wrong role', f => { f.proof.receipt.roleId = 'tester'; }],
  ['other failure', f => { f.proof.receipt.outcomeCode = 'STRUCTURED_PROVIDER_TIMEOUT'; }],
  ['pending action', f => { f.job.execution.pendingAction = { action: { type: 'write_text' } }; }],
  ['admitted action', f => { f.job.execution.actionAdmission = { actionId: 'admitted' }; }],
  ['unknown result', f => { f.job.execution.uncertainty = { kind: 'unknown' }; }],
  ['late receipt', f => { f.proof.receipt.finishedAt = '2026-10-10T03:02:00Z'; }],
  ['pre-job receipt', f => { f.proof.receipt.modelStartedAt = '2026-10-09T03:00:00Z'; }],
  ['invalid eligibility', f => { f.setEligible(false); }],
]) test(`automatic recovery preserves ${name}`, async () => {
  const f = fixture(); change(f);
  assert.equal((await f.create().runCycle()).resumed, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.job.status, 'paused');
});

test('an owner pause or new run while eligibility is checked prevents recovery', async () => {
  for (const change of [f => { f.proof.mode = 'paused'; }, f => { f.proof.receipt.runId = f.proof.runId = 'new-run'; }]) {
    const f = fixture(); f.eligibility.canRecover = async () => { change(f); return true; };
    assert.equal((await f.create().runCycle()).resumed, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('job revision CAS preserves concurrent owner changes', async () => {
  const f = fixture(); f.eligibility.canRecover = async () => { f.job.revision++; f.job.execution.pause.reason = 'owner pause'; return true; };
  const result = await f.create().runCycle();
  assert.equal(result.failed, 1);
  assert.equal(result.outcomes[0].code, 'CODE_JOB_REVISION_CONFLICT');
  assert.equal(f.job.status, 'paused');
});
