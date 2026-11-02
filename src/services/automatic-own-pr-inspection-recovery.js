import { OperationQueue } from "../lib/operation-queue.js";
import { normalizeCodeJobBrowserProjection } from "../domain/code-job-browser-projection.js";
import { normalizePullRequestExecutionBinding, samePullRequestExecutionBinding } from "../domain/pull-request-execution-binding.js";
import { AUTOMATIC_INSPECTION_FAILURES, FailedCodeJobContextReader } from "./failed-code-job-context-reader.js";

const STATE_KEY = "automatic-own-pr-inspection-recovery-state";
const MAX_RECOVERIES = 3;

function normalizeState(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.records)) throw new Error("自动检查恢复记录无效");
  const jobs = new Set();
  for (const record of value.records) {
    normalizePullRequestExecutionBinding(record.inputBinding);
    if (typeof record.itemId !== "string" || typeof record.jobId !== "string" || jobs.has(record.jobId) ||
        !Number.isSafeInteger(record.attempt) || record.attempt < 1 || record.attempt > MAX_RECOVERIES ||
        !["prepared", "requeued"].includes(record.status)) throw new Error("自动检查恢复记录无效");
    jobs.add(record.jobId);
  }
  return structuredClone(value);
}

function eligible(item) {
  return item?.status === "blocked" && item.statusReason === "proposal_failed" &&
    item.currentTarget?.type === "role" && item.currentTarget.id === "developer" &&
    item.activeIntentId === null && item.leaseId === null &&
    Array.isArray(item.graph?.deliveries) && item.graph.deliveries.length === 0 &&
    item.decisionContext?.source === "proposal" && item.decisionContext.outcome === "failed" &&
    item.decisionContext.value?.kind === "code_action_proposal";
}

// Requeue only an inspection which failed before its first action. The next
// decision creates a new grant and passes normal automatic admission again.
export class AutomaticOwnPrInspectionRecovery {
  #queue = new OperationQueue();
  #state;
  #cursor = null;

  constructor({ store, ledger, codeJobReader, objectSync, current, failedContextReader }) {
    Object.assign(this, { store, ledger, codeJobReader, objectSync, current });
    this.failedContextReader = failedContextReader ?? new FailedCodeJobContextReader({ codeJobReader, ledger });
  }

  async recover() {
    this.#state = normalizeState(await this.store.read(STATE_KEY, { schemaVersion: 1, records: [] }));
  }

  runCycle({ limit = 10 } = {}) {
    return this.#queue.enqueue(async () => {
      const readPage = () => this.ledger.listItems({ status: "blocked", roleId: "developer", order: "newest", limit,
        ...(this.#cursor === null ? {} : { cursor: this.#cursor }) });
      let page;
      try { page = await readPage(); }
      catch (error) {
        if (this.#cursor === null || error?.code !== "WORK_LEDGER_CURSOR_INVALID") throw error;
        // The cursor task can leave the blocked set between recovery cycles.
        this.#cursor = null;
        page = await readPage();
      }
      this.#cursor = page.nextCursor ?? null;
      const result = { scanned: 0, requeued: 0, failed: 0 };
      for (const item of page.items) {
        if (!eligible(item)) continue;
        result.scanned += 1;
        try { if (await this.#recoverItem(item)) result.requeued += 1; }
        catch (error) { result.failed += 1; result.lastFailure = error?.code ?? "OWN_PR_INSPECTION_RECOVERY_UNAVAILABLE"; }
      }
      return result;
    });
  }

  async #recoverItem(item) {
    const references = item.decisionContext.value.evidence?.filter(value => typeof value === "string" && value.startsWith("code-job:"));
    if (references?.length !== 1) return false;
    const jobId = references[0].slice(9);
    const value = await this.codeJobReader.get(jobId);
    if (!value) return false;
    const job = normalizeCodeJobBrowserProjection(value);
    if (job.status !== "failed" || job.operation !== "inspect" || job.inputBinding == null ||
        job.requestedBy.roleId !== "developer" || job.requestedBy.workItemId !== item.itemId) return false;
    const inputBinding = job.inputBinding;
    const prior = this.#state.records.filter(record => record.itemId === item.itemId &&
      samePullRequestExecutionBinding(record.inputBinding, inputBinding));
    let record = prior.find(record => record.jobId === jobId);
    if (record?.status === "requeued") return false;
    const attempts = Math.max(0, ...prior.map(record => record.attempt));
    if (!record && attempts >= MAX_RECOVERIES) return false;
    const failure = await this.failedContextReader.read({ itemId: item.itemId, inputBinding, decisionContext: item.decisionContext });
    if (!AUTOMATIC_INSPECTION_FAILURES.includes(failure?.failureCode) || failure.operation !== "inspect" ||
        failure.historyComplete !== true || failure.observationCount !== 0 || failure.observedActions.length !== 0) return false;
    let configuration = await this.current(inputBinding);
    if (!configuration) return false;
    await this.objectSync.prepare({ configuration, inputBinding });
    configuration = await this.current(inputBinding);
    if (!configuration) return false;
    const latest = await this.ledger.readItemForReconciliation({ itemId: item.itemId });
    if (!eligible(latest) || latest.revision !== item.revision ||
        JSON.stringify(latest.decisionContext) !== JSON.stringify(item.decisionContext)) return false;
    if (!record) {
      record = { itemId: item.itemId, jobId, inputBinding, attempt: attempts + 1, status: "prepared" };
      await this.#save([...this.#state.records, record]);
    }
    await this.ledger.transition({ itemId: item.itemId, expectedRevision: latest.revision, leaseId: null,
      actorId: "automatic-own-pr-inspection-recovery", toStatus: "queued", reason: "automatic_inspection_objects_ready",
      details: { code: failure.failureCode, downstreamRef: jobId } });
    await this.#save(this.#state.records.map(entry => entry.jobId === jobId ? { ...entry, status: "requeued" } : entry));
    return true;
  }

  async #save(records) {
    const next = normalizeState({ schemaVersion: 1, records });
    try { await this.store.write(STATE_KEY, next); this.#state = next; }
    catch (error) {
      this.#state = normalizeState(await this.store.read(STATE_KEY, { schemaVersion: 1, records: [] }));
      throw error;
    }
  }
}
