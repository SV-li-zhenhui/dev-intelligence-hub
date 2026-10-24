import { OperationQueue } from '../lib/operation-queue.js';
import { hasIncompleteReadPause, stoppedCodeJobRun } from './code-job-read-recovery.js';

const NATIVE_PAUSES = new Map(['STRUCTURED_PROVIDER_RESPONSE_INVALID', 'CODE_BRAIN_COMPLETION_NOT_READY']
  .map(code => [`等待人工处理（${code}）`, code]));

export function recoverableNativePauseCode(job) {
  return job?.status === 'paused' && job.execution?.pause?.from === 'active' &&
    job.execution.pendingAction === null && job.execution.actionAdmission === null && job.execution.uncertainty === null
    ? NATIVE_PAUSES.get(job.execution.pause.reason) ?? null : null;
}

function stoppedRun(proof, job) {
  const receipt = proof?.receipt;
  const started = Date.parse(receipt?.modelStartedAt);
  const finished = Date.parse(receipt?.finishedAt);
  const paused = Date.parse(job.execution.pause.at);
  const created = Date.parse(job.createdAt);
  const code = recoverableNativePauseCode(job);
  return code !== null && proof?.mode === 'active' && proof.active === false && proof.pendingCommand === null &&
    proof.stopUnconfirmed !== true && typeof proof.runId === 'string' && proof.runId.length > 0 &&
    proof.runId === receipt?.runId && receipt?.kind === 'code-job' && receipt.taskId === job.jobId &&
    receipt.roleId === job.grant.requestedBy.roleId && receipt.phase === 'failed' &&
    receipt.outcomeCode === code && receipt.stopConfirmed === true && receipt.session?.transport === 'app-server' &&
    [started, finished, paused, created].every(Number.isFinite) && created <= started && started <= finished && finished <= paused;
}

// Runs independently of long model/build execution. It restores an existing
// checkpoint; normal worker execution still verifies its current grant.
export class AutomaticCodeJobPauseRecovery {
  #queue = new OperationQueue();
  #cursor = null;

  constructor({ jobs, taskRuns, eligibility }) {
    this.jobs = jobs;
    this.taskRuns = taskRuns;
    this.eligibility = eligibility;
    for (const [port, methods] of [[jobs, ['listPaused', 'getForWorker', 'resume']], [taskRuns, ['get']], [eligibility, ['canRecover']]]) {
      if (methods.some(name => typeof port?.[name] !== 'function')) throw new TypeError('automatic code job recovery port is invalid');
    }
  }

  runCycle({ limit = 10, signal = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return Promise.reject(new TypeError('automatic code job recovery limit is invalid'));
    return this.#queue.enqueue(async () => {
      signal?.throwIfAborted();
      const page = await this.jobs.listPaused({ limit, afterSequence: this.#cursor });
      this.#cursor = page.items.at(-1)?.sequence ?? null;
      const result = { scanned: page.items.length, resumed: 0, waiting: 0, failed: 0, outcomes: [] };
      for (const candidate of page.items) {
        signal?.throwIfAborted();
        try {
          const job = await this.jobs.getForWorker(candidate.jobId);
          let status = 'waiting';
          const hostReadPause = hasIncompleteReadPause(job) && typeof this.eligibility.canReplanUnstartedWrite === 'function';
          if (recoverableNativePauseCode(job) !== null || hostReadPause) {
            const stopped = value => hostReadPause ? stoppedCodeJobRun(value, job, job.execution.pause.at) : stoppedRun(value, job);
            const eligible = () => hostReadPause ? this.eligibility.canReplanUnstartedWrite(job) : this.eligibility.canRecover(job);
            const proof = await this.taskRuns.get('code-job', job.jobId);
            if (stopped(proof) && await eligible() === true) {
              const latestProof = await this.taskRuns.get('code-job', job.jobId);
              signal?.throwIfAborted();
              if (stopped(latestProof) && latestProof.runId === proof.runId) {
                await this.jobs.resume({ jobId: job.jobId, expectedRevision: job.revision });
                status = 'resumed';
              }
            }
          }
          result[status]++;
          result.outcomes.push({ jobId: candidate.jobId, status });
        } catch (error) {
          signal?.throwIfAborted();
          result.failed++;
          result.outcomes.push({ jobId: candidate.jobId, status: 'failed', code: error?.code ?? 'CODE_JOB_PAUSE_RECOVERY_UNAVAILABLE' });
        }
      }
      return result;
    });
  }
}
