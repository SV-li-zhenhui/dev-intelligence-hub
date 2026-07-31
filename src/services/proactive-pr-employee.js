import { createHash } from "node:crypto";

const STATE_KEY = "pr-employee-state";
const MEMORY_KEY = "pr-employee-memory";
const ACTIVE_JOB_STATES = new Set([
  "queued",
  "running",
  "retry_wait",
  "ready",
  "ready_for_human",
]);
const WORK_POLICY_BY_ACTION = Object.freeze({
  review: {
    mode: "review",
    workType: "review_draft",
    requiresApproval: true,
    relations: ["review_requested"],
  },
  rereview: {
    mode: "review",
    workType: "review_draft",
    requiresApproval: true,
    relations: ["review_requested"],
  },
  complete_review: {
    mode: "review",
    workType: "review_draft",
    requiresApproval: true,
    relations: ["review_requested"],
  },
  fix_ci: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
  },
  resolve_conflict: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
  },
  address_review: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
  },
  continue_draft: {
    mode: "owner",
    workType: "owner_plan",
    requiresApproval: false,
    relations: ["authored"],
  },
});
const DECISIONS = new Set(["accept", "reject"]);

function serviceError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function defaultState() {
  return {
    revision: 0,
    paused: false,
    jobs: [],
    memoryOutbox: [],
    memoryOutboxError: "",
    memoryOutboxDropped: 0,
    lastRun: null,
    lastError: "",
  };
}

function normalizedState(value) {
  if (!value || typeof value !== "object") return defaultState();
  return {
    ...defaultState(),
    ...value,
    jobs: Array.isArray(value.jobs) ? value.jobs : [],
    memoryOutbox: Array.isArray(value.memoryOutbox)
      ? value.memoryOutbox
      : [],
  };
}

function jobFingerprint(item, policyVersion) {
  return [item.id, item.headRefOid, item.nextAction, policyVersion].join("\u0000");
}

function jobId(fingerprint) {
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `pr-work-${digest.slice(0, 20)}`;
}

function workPolicy(item) {
  const policy = WORK_POLICY_BY_ACTION[item?.nextAction];
  return policy?.relations.includes(item?.relation) ? policy : null;
}

function isCandidate(item) {
  return Boolean(
    item?.kind === "pull_request" &&
      item.actionState === "action_now" &&
      item.reviewFactsAvailable === true &&
      item.headRefOid &&
      workPolicy(item),
  );
}

function roleState(state, enabled) {
  if (!enabled) return "disabled";
  if (state.paused) return "paused";
  if (
    state.jobs.some((job) =>
      ["queued", "running", "retry_wait"].includes(job.status),
    )
  ) {
    return "working";
  }
  if (state.jobs.some((job) => job.status === "ready_for_human")) {
    return "waiting_user";
  }
  if (state.jobs.some((job) => job.status === "blocked")) return "degraded";
  if (state.memoryOutboxError) return "degraded";
  if (state.lastError) return "degraded";
  return "observing";
}

function latestJobError(jobs) {
  const job = [...jobs]
    .filter(
      (job) =>
        ["retry_wait", "blocked"].includes(job.status) && job.error,
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0),
    )[0];
  return job ? `#${job.number}: ${job.error}` : "";
}

function trimJobs(jobs, limit) {
  const cappedLimit = Math.max(1, Number(limit) || 500);
  if (jobs.length <= cappedLimit) return jobs;
  const active = jobs.filter((job) => ACTIVE_JOB_STATES.has(job.status));
  const terminal = jobs
    .filter((job) => !ACTIVE_JOB_STATES.has(job.status))
    .sort(
      (left, right) =>
        Date.parse(
          right.completedAt || right.updatedAt || right.createdAt || 0,
        ) -
        Date.parse(
          left.completedAt || left.updatedAt || left.createdAt || 0,
        ),
    );
  return [
    ...active,
    ...terminal.slice(0, Math.max(0, cappedLimit - active.length)),
  ];
}

function memoryText(memory) {
  return [
    memory.title,
    memory.summary,
    ...(memory.evidence || []),
    ...(memory.steps || []),
    memory.reviewBody,
    memory.repository,
    memory.sourceId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

export class ProactivePrEmployeeService {
  constructor({
    store,
    github,
    reviewer,
    config = {},
    clock = () => new Date(),
    operationQueue = null,
  }) {
    this.store = store;
    this.github = github;
    this.reviewer = reviewer;
    this.clock = clock;
    this.config = {
      enabled: true,
      name: "PR 推进员工",
      policyVersion: 1,
      maxJobsPerTick: 2,
      maxAttempts: 3,
      retryMinutes: [1, 5, 30],
      memoryLimit: 1_000,
      memoryOutboxLimit: 100,
      jobLimit: 500,
      ...config,
    };
    this.operationQueue = operationQueue;
    this.operations = Promise.resolve();
    this.running = null;
  }

  tick({ trigger = "scheduled" } = {}) {
    if (this.running) return this.running;
    const operation = this.#enqueue(() => this.#performTick(trigger));
    const tracked = operation.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
    return tracked;
  }

  control(command, expectedRevision) {
    return this.#enqueue(() => this.#control(command, expectedRevision));
  }

  decide(id, decision, options = {}) {
    return this.#enqueue(() => this.#decide(id, decision, options));
  }

  async view() {
    return this.#projection(await this.#readState());
  }

  async searchMemory(query = "", limit = 30) {
    const [storedMemories, state] = await Promise.all([
      this.store.read(MEMORY_KEY, []),
      this.#readState(),
    ]);
    const memories = [
      ...(Array.isArray(state.memoryOutbox) ? state.memoryOutbox : []),
      ...(Array.isArray(storedMemories) ? storedMemories : []),
    ].filter(
      (memory, index, all) =>
        all.findIndex((candidate) => candidate.id === memory.id) === index,
    );
    const terms = String(query)
      .trim()
      .toLocaleLowerCase("zh-CN")
      .split(/\s+/)
      .filter(Boolean);
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
    return memories
      .filter((memory) => {
        const text = memoryText(memory);
        return terms.every((term) => text.includes(term));
      })
      .sort(
        (left, right) =>
          Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0),
      )
      .slice(0, cappedLimit);
  }

  #enqueue(operation) {
    if (this.operationQueue) return this.operationQueue.enqueue(operation);
    const result = this.operations.then(operation, operation);
    this.operations = result.catch(() => {});
    return result;
  }

  async #readState() {
    return normalizedState(await this.store.read(STATE_KEY, defaultState()));
  }

  async #writeState(state, { bumpRevision = true } = {}) {
    const next = {
      ...state,
      revision: (state.revision || 0) + (bumpRevision ? 1 : 0),
    };
    await this.store.write(STATE_KEY, next);
    return next;
  }

  #projection(state) {
    const jobs = [...state.jobs].sort(
      (left, right) =>
        Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0),
    );
    const confirmationQueue = jobs.filter(
      (job) => job.status === "ready_for_human",
    );
    return {
      role: {
        id: "pr-reviewer",
        name: this.config.name,
        mission: "主动巡查与你相关的 PR，生成评审草稿或推进方案",
        state: roleState(state, this.config.enabled),
        revision: state.revision,
        brain: {
          provider: this.reviewer?.provider || "",
          model: this.reviewer?.model || "",
          remoteCodeContext: Boolean(this.reviewer?.remoteCodeContext),
        },
        paused: state.paused,
        lastRun: state.lastRun,
        lastError:
          latestJobError(state.jobs) ||
          state.memoryOutboxError ||
          state.lastError,
      },
      jobs,
      confirmationQueue,
    };
  }

  async #control(command, expectedRevision) {
    if (!["pause", "resume"].includes(command)) {
      throw serviceError(400, "command 只能是 pause 或 resume");
    }
    const state = await this.#readState();
    this.#assertRevision(state, expectedRevision);
    const shouldPause = command === "pause";
    if (state.paused === shouldPause) return this.#projection(state);
    const next = await this.#writeState({
      ...state,
      paused: shouldPause,
      lastError: "",
    });
    return this.#projection(next);
  }

  async #decide(id, decision, { headRefOid, expectedRevision } = {}) {
    if (typeof id !== "string" || !id.trim()) {
      throw serviceError(400, "作业 id 不能为空");
    }
    if (!DECISIONS.has(decision)) {
      throw serviceError(400, "decision 只能是 accept 或 reject");
    }
    let state = await this.#readState();
    this.#assertRevision(state, expectedRevision);
    const index = state.jobs.findIndex((job) => job.id === id.trim());
    if (index < 0) throw serviceError(404, "找不到这条 PR 员工作业");
    const job = state.jobs[index];
    if (job.status !== "ready_for_human") {
      throw serviceError(409, "该评审草稿已不在待确认状态");
    }
    if (job.headRefOid !== headRefOid) {
      throw serviceError(409, "PR head 已变化，请查看最新草稿");
    }
    const snapshot = await this.store.read("snapshot");
    const current = snapshot?.items?.find((item) => item.id === job.subjectId);
    if (!current || current.headRefOid !== job.headRefOid || !isCandidate(current)) {
      state.jobs[index] = {
        ...job,
        status: "superseded",
        completedAt: this.clock().toISOString(),
      };
      await this.#writeState(state);
      throw serviceError(409, "PR 状态或 head 已变化，旧草稿已失效");
    }

    const decidedAt = this.clock().toISOString();
    const decidedJob = {
      ...job,
      status: decision === "accept" ? "accepted" : "rejected",
      decision,
      decidedAt,
      updatedAt: decidedAt,
      completedAt: decidedAt,
    };
    state.jobs[index] = decidedJob;
    state.lastError = "";
    state = this.#queueMemory(state, decidedJob, `draft_${decision}`);
    state = await this.#writeState(state);
    state = await this.#flushMemoryOutbox(state);
    return this.#projection(state);
  }

  #assertRevision(state, expectedRevision) {
    if (!Number.isInteger(expectedRevision)) {
      throw serviceError(400, "expectedRevision 必须是整数");
    }
    if (state.revision !== expectedRevision) {
      throw serviceError(409, "员工状态已更新，请刷新后重新操作");
    }
  }

  async #performTick(trigger) {
    let state = await this.#readState();
    if (!this.config.enabled || state.paused) return this.#projection(state);
    state = await this.#flushMemoryOutbox(state);

    const runAt = this.clock().toISOString();
    const [snapshot, memories] = await Promise.all([
      this.store.read("snapshot"),
      this.store.read(MEMORY_KEY, []),
    ]);
    if (!snapshot?.items) {
      state.lastRun = {
        trigger,
        at: runAt,
        newJobs: 0,
        summary: "尚无事实快照，等待数据源完成首次刷新",
      };
      state = await this.#writeState(state, { bumpRevision: false });
      return this.#projection(state);
    }
    if (snapshot.sourceStatus?.githubPullRequests?.ok !== true) {
      state.lastRun = {
        trigger,
        at: runAt,
        newJobs: 0,
        summary: "GitHub PR 本轮未刷新，未使用旧数据触发员工",
      };
      state = await this.#writeState(state, { bumpRevision: false });
      return this.#projection(state);
    }

    const candidates = snapshot.items.filter(isCandidate);
    const currentBySubject = new Map(candidates.map((item) => [item.id, item]));
    let jobsChanged = false;
    state.jobs = state.jobs.map((job) => {
      if (!ACTIVE_JOB_STATES.has(job.status)) return job;
      const current = currentBySubject.get(job.subjectId);
      if (
        current?.headRefOid === job.headRefOid &&
        current?.nextAction === job.nextAction &&
        job.policyVersion === this.config.policyVersion
      ) {
        return job;
      }
      jobsChanged = true;
      return {
        ...job,
        status: "superseded",
        completedAt: runAt,
        updatedAt: runAt,
      };
    });

    const fingerprints = new Set(
      [
        ...state.jobs,
        ...(Array.isArray(memories) ? memories : []),
        ...state.memoryOutbox,
      ]
        .map((entry) => entry.fingerprint)
        .filter(Boolean),
    );
    const newJobs = candidates
      .map((item) => ({ item, fingerprint: jobFingerprint(item, this.config.policyVersion) }))
      .filter(({ fingerprint }) => !fingerprints.has(fingerprint))
      .map(({ item, fingerprint }) => this.#newJob(item, fingerprint, runAt));
    state.jobs.push(...newJobs);
    const beforeTrim = state.jobs.length;
    state.jobs = trimJobs(state.jobs, this.config.jobLimit);
    jobsChanged ||= state.jobs.length !== beforeTrim;
    state.lastRun = {
      trigger,
      at: runAt,
      newJobs: newJobs.length,
      observed: candidates.length,
      summary: candidates.length
        ? `巡查 ${candidates.length} 条需行动 PR，新建 ${newJobs.length} 个作业`
        : "已主动巡查，没有发现需要启动的新 PR 作业",
    };
    state.lastError = "";
    state = await this.#writeState(state, {
      bumpRevision: jobsChanged || newJobs.length > 0,
    });

    const readyToRun = state.jobs
      .filter((job) => this.#canRun(job, runAt))
      .slice(0, Math.max(1, this.config.maxJobsPerTick));
    for (const job of readyToRun) {
      state = await this.#runJob(state, job.id);
    }
    return this.#projection(state);
  }

  #newJob(item, fingerprint, createdAt) {
    return {
      id: jobId(fingerprint),
      fingerprint,
      policyVersion: this.config.policyVersion,
      subjectId: item.id,
      repo: item.repo,
      number: item.number,
      title: item.title,
      url: item.url,
      relation: item.relation,
      headRefOid: item.headRefOid,
      nextAction: item.nextAction,
      triggerReason: item.actionReasons?.[0] || "PR 状态需要你采取行动",
      status: "queued",
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
    };
  }

  #canRun(job, now) {
    if (job.status === "queued") return true;
    if (job.status === "running") {
      return Date.parse(job.leaseUntil || 0) <= Date.parse(now);
    }
    if (job.status === "retry_wait") {
      return Date.parse(job.nextAttemptAt || 0) <= Date.parse(now);
    }
    return false;
  }

  async #runJob(state, id) {
    let index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return state;
    const startedAt = this.clock().toISOString();
    const claimed = {
      ...state.jobs[index],
      status: "running",
      attempts: (state.jobs[index].attempts || 0) + 1,
      startedAt,
      updatedAt: startedAt,
      leaseUntil: new Date(Date.parse(startedAt) + 120_000).toISOString(),
      error: "",
    };
    state.jobs[index] = claimed;
    state = await this.#writeState(state);

    try {
      if (!this.reviewer) throw new Error("岗位大脑未配置");
      const snapshot = await this.store.read("snapshot");
      const item = snapshot?.items?.find(
        (candidate) =>
          candidate.id === claimed.subjectId &&
          candidate.headRefOid === claimed.headRefOid,
      );
      if (!item || !isCandidate(item)) {
        return this.#finishAsSuperseded(state, claimed.id);
      }
      const policy = workPolicy(item);
      const context = await this.github.loadReviewContext(item, {
        includePatch: policy.mode === "review",
      });
      if (context.headRefOid !== claimed.headRefOid) {
        return this.#finishAsSuperseded(state, claimed.id);
      }
      const analysis = await this.reviewer.analyze({
        ...context,
        workMode: policy.mode,
        requestedAction: item.nextAction,
      });
      const latest = await this.store.read("snapshot");
      const current = latest?.items?.find(
        (candidate) => candidate.id === claimed.subjectId,
      );
      if (
        !current ||
        current.headRefOid !== claimed.headRefOid ||
        current.nextAction !== claimed.nextAction ||
        !isCandidate(current)
      ) {
        return this.#finishAsSuperseded(state, claimed.id);
      }

      index = state.jobs.findIndex((job) => job.id === claimed.id);
      const completedAt = this.clock().toISOString();
      const completed = {
        ...state.jobs[index],
        workType: policy.workType,
        summary: analysis.summary,
        confidence: analysis.confidence,
        evidence: analysis.evidence,
        steps: analysis.steps,
        questions: analysis.questions,
        reviewVerdict:
          policy.mode === "review" ? analysis.reviewVerdict : "none",
        reviewBody: policy.mode === "review" ? analysis.reviewBody : "",
        requiresApproval: policy.requiresApproval,
        status: policy.requiresApproval ? "ready_for_human" : "ready",
        brain: {
          provider: this.reviewer.provider || "",
          model: this.reviewer.model || "",
        },
        updatedAt: completedAt,
        completedAt,
        leaseUntil: null,
      };
      state.jobs[index] = completed;
      state.lastError = "";
      state = this.#queueMemory(state, completed, "analysis_ready");
      state = await this.#writeState(state);
      return this.#flushMemoryOutbox(state);
    } catch (error) {
      index = state.jobs.findIndex((job) => job.id === claimed.id);
      if (index < 0) return state;
      const failedAt = this.clock().toISOString();
      const attempts = state.jobs[index].attempts || 1;
      const blocked = attempts >= this.config.maxAttempts;
      const retryIndex = Math.min(
        attempts - 1,
        this.config.retryMinutes.length - 1,
      );
      const retryMinutes = this.config.retryMinutes[retryIndex] || 1;
      state.jobs[index] = {
        ...state.jobs[index],
        status: blocked ? "blocked" : "retry_wait",
        error: error.message || String(error),
        updatedAt: failedAt,
        leaseUntil: null,
        nextAttemptAt: blocked
          ? null
          : new Date(Date.parse(failedAt) + retryMinutes * 60_000).toISOString(),
      };
      state.lastError = `#${state.jobs[index].number}: ${state.jobs[index].error}`;
      if (blocked) {
        state = this.#queueMemory(
          state,
          state.jobs[index],
          "analysis_blocked",
        );
      }
      state = await this.#writeState(state);
      return this.#flushMemoryOutbox(state);
    }
  }

  async #finishAsSuperseded(state, id) {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index < 0) return state;
    const completedAt = this.clock().toISOString();
    state.jobs[index] = {
      ...state.jobs[index],
      status: "superseded",
      completedAt,
      updatedAt: completedAt,
      leaseUntil: null,
    };
    return this.#writeState(state);
  }

  #queueMemory(state, job, event) {
    const createdAt = this.clock().toISOString();
    const id = `${job.id}:${event}`;
    const memory = {
      id,
      event,
      fingerprint: job.fingerprint,
      roleId: "pr-reviewer",
      sourceId: job.subjectId,
      sourceUrl: job.url,
      repository: job.repo,
      number: job.number,
      headRefOid: job.headRefOid,
      title: job.title,
      summary: job.summary || job.triggerReason || job.error || "",
      evidence: job.evidence || [],
      steps: job.steps || [],
      reviewBody: job.reviewBody || "",
      decision: job.decision || "",
      brain: job.brain || null,
      createdAt,
    };
    const pending = [
      ...state.memoryOutbox.filter((candidate) => candidate.id !== id),
      memory,
    ];
    const outboxLimit = Math.max(
      1,
      Number(this.config.memoryOutboxLimit) || 100,
    );
    const dropped = Math.max(0, pending.length - outboxLimit);
    return {
      ...state,
      memoryOutbox: pending.slice(-outboxLimit),
      memoryOutboxDropped: (state.memoryOutboxDropped || 0) + dropped,
    };
  }

  async #flushMemoryOutbox(state) {
    if (!state.memoryOutbox.length) return state;
    try {
      const memories = await this.store.read(MEMORY_KEY, []);
      const pendingIds = new Set(
        state.memoryOutbox.map((memory) => memory.id),
      );
      const next = [
        ...state.memoryOutbox,
        ...(Array.isArray(memories)
          ? memories.filter((memory) => !pendingIds.has(memory.id))
          : []),
      ]
        .sort(
          (left, right) =>
            Date.parse(right.createdAt || 0) -
            Date.parse(left.createdAt || 0),
        )
        .slice(0, Math.max(1, this.config.memoryLimit));
      await this.store.write(MEMORY_KEY, next);
      return this.#writeState(
        { ...state, memoryOutbox: [], memoryOutboxError: "" },
        { bumpRevision: false },
      );
    } catch (error) {
      const failed = {
        ...state,
        memoryOutboxError: `记忆队列写入失败：${error.message || error}`,
      };
      try {
        return await this.#writeState(failed, { bumpRevision: false });
      } catch {
        return failed;
      }
    }
  }
}
