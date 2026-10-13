import { escapeHtml } from "./view-format.js";

const priorities = { normal: "普通", high: "高", urgent: "紧急" };
const commands = new Set(["instruct", "priority", "pause", "resume", "cancel"]);

function identity(task) {
  return `${task.kind}:${task.taskId}`;
}

function taskUrl(task) {
  return `/api/task-runs/${encodeURIComponent(task.kind)}/${encodeURIComponent(task.taskId)}`;
}

function phaseLabel(task) {
  if (task.phase === "control_failed") return "停止尚未确认";
  if (task.pendingCommand === "pause") return task.live ? "暂停请求已提交，等待停止确认" : "暂停请求已提交，等待检查点";
  if (task.pendingCommand === "cancel") return task.live ? "取消请求已提交，等待停止确认" : "取消请求已提交，等待检查点";
  if (task.phase === "waiting_checkpoint") return "补充要求等待检查点";
  return { running: "正在运行", paused: "已暂停", cancelled: "已取消", completed:"已完成", failed:"已失败", fenced:"已隔离，等待维护", idle: "等待后续调度" }[task.phase] || "状态待确认";
}

function timeMarkup(value) {
  return value ? `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>` : "未知";
}

function taskRow(task) {
  return `<li><button type="button" class="task-run-row" data-task-run-kind="${escapeHtml(task.kind)}" data-task-run-id="${escapeHtml(task.taskId)}">
    <span class="task-run-row-title"><strong>${escapeHtml(task.title || task.taskId)}</strong><span class="status-pill">${escapeHtml(phaseLabel(task))}</span></span>
    <span>${escapeHtml(task.roleId)} · ${escapeHtml(task.subject || "无关联对象")}</span>
    <span>开始于 ${timeMarkup(task.startedAt)} · 优先级：${escapeHtml(priorities[task.priority] || "未知")}</span>
    ${task.progress ? `<span>${escapeHtml(task.progress)}</span>` : ""}
  </button></li>`;
}

export function renderTaskRuns({ loaded = false, loading = false, enabled = false, items = [], held = [], error = "" } = {}) {
  const active = items.filter((task) => task.active === true);
  const paused = held.filter((task) => task.active !== true);
  return `<div class="section-heading task-runs-heading"><h2 id="task-runs-title">当前运行任务</h2>
    <button type="button" class="secondary-button" data-task-runs-refresh ${loading ? "disabled" : ""}>${loading ? "读取中…" : "刷新任务"}</button></div>
    <p class="task-runs-hint">正在执行的任务，包括模型判断和受控动作。点击查看进展或调整要求。</p>
    ${error ? `<p class="task-runs-error" role="status">${escapeHtml(error)}${loaded ? "；当前显示上次读取结果。" : "；可点击刷新任务重试。"}</p>` : ""}
    ${loaded && !enabled ? '<p class="task-runs-empty">当前服务未启用运行任务控制。</p>' : ""}
    ${enabled || !loaded ? `<div class="task-runs-groups"><div><h3>正在运行 · ${active.length}</h3>
      ${active.length ? `<ul class="task-runs-list">${active.map(taskRow).join("")}</ul>` : `<p class="task-runs-empty">${loaded ? "当前没有正在运行的模型任务。" : "正在读取运行任务…"}</p>`}</div>
      ${paused.length ? `<div class="task-runs-held"><h3>暂停与待确认 · ${paused.length}</h3><ul class="task-runs-list">${paused.map(taskRow).join("")}</ul></div>` : ""}</div>` : ""}`;
}

function deliveryMarkup(task) {
  if (task.instructionReceipt === "failed") return "实时引导未确认送达；补充要求已保存，将在安全检查点续接，请先核对已提交的要求。";
  if (task.live === true) {
    if (task.instructionReceipt === "submitted") return "实时引导已提交；回执不代表模型已经采用，请继续查看进展。";
    if (task.instructionReceipt === "checkpoint") return "补充要求已在检查点接续；当前回合未实时采用。";
    return "支持当前回合实时引导；提交后查看回执和后续进展。";
  }
  return "检查点兼容模式：补充要求在当前步骤结束后接续；旧模型判断会丢弃，已执行的动作不会重复。暂停和取消需等待安全检查点确认。";
}

function allowedCommand(task, command) {
  if (!task || !commands.has(command) || task.phase === "cancelled" || task.phase === "control_failed") return false;
  if (command === "resume") return task.active !== true && task.phase === "paused" && task.mode === "paused" && !task.pendingCommand;
  if (command === "priority") return task.active === true || task.phase === "paused";
  if (command === "cancel") return !task.pendingCommand && (task.active === true || task.phase === "paused");
  return task.active === true && !task.pendingCommand;
}

export function renderTaskRunSummary(task) {
  if (!task) return '<p class="task-runs-empty">正在读取任务详情…</p>';
  return `<p class="eyebrow">${task.kind === "code-job" ? "CODE JOB" : "WORK ITEM"}</p>
    <h2 id="task-run-detail-title">${escapeHtml(task.title || task.taskId)}</h2>
    <p class="task-run-phase"><strong>${escapeHtml(phaseLabel(task))}</strong></p>
    <dl class="task-run-metadata">
      <div><dt>岗位</dt><dd>${escapeHtml(task.roleId)}</dd></div>
      <div><dt>关联对象</dt><dd>${escapeHtml(task.subject || "无")}</dd></div>
      <div><dt>开始时间</dt><dd>${timeMarkup(task.startedAt)}</dd></div>
      <div><dt>优先级</dt><dd>${escapeHtml(priorities[task.priority] || "未知")}</dd></div>
      <div><dt>控制修订</dt><dd>${escapeHtml(task.revision)} · 已交给模型的修订 ${escapeHtml(task.appliedRevision)}</dd></div>
      ${task.lastActivityAt ? `<div><dt>最近活动</dt><dd>${timeMarkup(task.lastActivityAt)}</dd></div>` : ""}
    </dl>
    ${task.progress ? `<p class="task-run-progress">${escapeHtml(task.progress)}</p>` : ""}
    <p class="task-run-delivery">${escapeHtml(deliveryMarkup(task))}</p>
    ${task.phase === "control_failed" ? '<p class="task-runs-error">停止尚未确认，请等待维护确认后再继续。</p>' : ""}
    <details class="task-run-instructions"><summary>已提交的补充要求（${task.instructions?.length || 0}）</summary>
      ${task.instructions?.length ? `<ol>${task.instructions.map((instruction) => `<li><p>${escapeHtml(instruction.text)}</p><small>${timeMarkup(instruction.at)}</small></li>`).join("")}</ol>` : "<p>尚未提交补充要求。</p>"}</details>`;
}

function controlDisabled(state, command) {
  return state.submitting || state.detailLoading || state.detailStale || !allowedCommand(state.detail, command);
}

export function renderTaskRunDetail(state = {}) {
  const { detail, draft = { instruction: "", priority: "normal" } } = state;
  const disabled = (command) => controlDisabled(state, command) ? "disabled" : "";
  return `<div class="detail task-run-detail"><div data-task-run-summary>${renderTaskRunSummary(detail)}</div>
    <p class="task-run-notice" data-task-run-notice role="status">${escapeHtml(state.notice || "")}</p>
    <p class="task-runs-error" data-task-run-error role="status">${escapeHtml(state.detailError || "")}</p>
    <button type="button" class="secondary-button" data-task-run-reload ${state.detailLoading ? "disabled" : ""}>刷新详情</button>
    <form data-task-run-instruction-form>
      <label for="task-run-instruction">补充要求</label>
      <textarea id="task-run-instruction" name="instruction" rows="4" maxlength="4000" aria-describedby="task-run-permission">${escapeHtml(draft.instruction)}</textarea>
      <p id="task-run-permission">补充要求不能扩大原任务权限，原有测试和发布授权仍然生效。</p>
      <button type="submit" class="secondary-button" data-task-run-command="instruct" ${disabled("instruct")}>提交补充要求</button>
    </form>
    <form data-task-run-priority-form class="task-run-priority-form">
      <label for="task-run-priority">后续调度优先级</label>
      <select id="task-run-priority" name="priority">${Object.entries(priorities).map(([value, label]) => `<option value="${value}" ${draft.priority === value ? "selected" : ""}>${label}</option>`).join("")}</select>
      <button type="submit" class="secondary-button" data-task-run-command="priority" ${disabled("priority")}>保存优先级</button>
    </form>
    <div class="task-run-actions" data-task-run-actions>${renderTaskRunActions(state)}</div>
  </div>`;
}

function renderTaskRunActions(state) {
  const task = state.detail;
  const pauseOrResume = task?.phase === "paused" ? "resume" : "pause";
  const labels = { pause: "暂停任务", resume: "恢复原任务", cancel: "取消任务" };
  return [pauseOrResume, "cancel"].filter((command) => allowedCommand(task, command)).map((command) =>
    `<button type="button" class="secondary-button ${command === "cancel" ? "task-run-cancel" : ""}" data-task-run-command="${command}" ${controlDisabled(state, command) ? "disabled" : ""}>${labels[command]}</button>`,
  ).join("");
}

async function readResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    const error = new Error(message || `运行任务请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function validateDetail(value, selected) {
  if (!value || value.kind !== selected.kind || value.taskId !== selected.taskId ||
      typeof value.runId !== "string" || !Number.isSafeInteger(value.revision)) {
    throw new Error("运行任务详情格式无效，请刷新后重试");
  }
  return value;
}

export function createTaskRunsController({
  fetchImpl = globalThis.fetch,
  onChange = () => {},
  isVisible = () => globalThis.document?.visibilityState !== "hidden",
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const state = { loaded: false, loading: false, enabled: false, items: [], held: [], error: "",
    selected: null, detail: null, detailLoading: false, detailStale: false, detailError: "",
    submitting: false, notice: "", draft: { instruction: "", priority: "normal" } };
  const drafts = new Map();
  let listRequest = null;
  let detailRequest = null;
  let detailSequence = 0;
  let selectionSequence = 0;
  let running = false;
  let timer = null;
  let pollRequest = null;

  function getState() { return { ...state, draft: { ...state.draft } }; }
  function notify() { onChange(getState()); }
  function currentDraft() { return state.selected ? drafts.get(identity(state.selected)) : null; }

  function applyDetail(detail) {
    state.detail = detail;
    state.detailStale = false;
    const draft = currentDraft();
    if (draft && !draft.priorityDirty) draft.priority = detail.priority;
    if (draft) state.draft = { instruction: draft.instruction, priority: draft.priority };
  }

  function setDraft(patch) {
    const draft = currentDraft();
    if (!draft) return;
    if (typeof patch.instruction === "string") draft.instruction = patch.instruction;
    if (Object.hasOwn(priorities, patch.priority)) { draft.priority = patch.priority; draft.priorityDirty = true; }
    state.draft = { instruction: draft.instruction, priority: draft.priority };
    notify();
  }

  async function refresh() {
    if (listRequest) return listRequest;
    state.loading = true;
    notify();
    listRequest = (async () => {
      try {
        const body = await readResponse(await fetchImpl("/api/task-runs", { cache: "no-store" }));
        if (typeof body.enabled !== "boolean" || !Array.isArray(body.items) || !Array.isArray(body.held)) throw new Error("运行任务列表格式无效");
        Object.assign(state, { loaded: true, enabled: body.enabled, items: body.items, held: body.held, error: "" });
      } catch (error) { state.error = error.message; }
      finally { state.loading = false; listRequest = null; notify(); }
    })();
    return listRequest;
  }

  async function refreshDetail() {
    if (!state.selected) return;
    if (detailRequest) return detailRequest;
    const selected = { ...state.selected };
    const sequence = ++detailSequence;
    state.detailLoading = true;
    notify();
    const request = (async () => {
      try {
        const detail = validateDetail(await readResponse(await fetchImpl(taskUrl(selected), { cache: "no-store" })), selected);
        if (sequence !== detailSequence) return;
        applyDetail(detail);
        state.detailError = "";
      } catch (error) {
        if (sequence !== detailSequence) return;
        state.detailError = error.message;
        state.detailStale = true;
      } finally {
        if (sequence === detailSequence) { state.detailLoading = false; detailRequest = null; notify(); }
      }
    })();
    detailRequest = request;
    return request;
  }

  async function open(kind, taskId) {
    if (!["work-item", "code-job"].includes(kind) || !taskId) return;
    selectionSequence += 1;
    detailSequence += 1;
    detailRequest = null;
    state.selected = { kind, taskId };
    const key = identity(state.selected);
    if (!drafts.has(key)) drafts.set(key, { instruction: "", priority: "normal", priorityDirty: false });
    const draft = drafts.get(key);
    Object.assign(state, { detail: null, detailError: "", detailStale: false, notice: "",
      draft: { instruction: draft.instruction, priority: draft.priority } });
    notify();
    await refreshDetail();
  }

  function close() {
    selectionSequence += 1;
    detailSequence += 1;
    detailRequest = null;
    Object.assign(state, { selected: null, detail: null, detailLoading: false });
    notify();
  }

  function updateList(detail) {
    const key = identity(detail);
    state.items = state.items.filter((task) => identity(task) !== key);
    state.held = state.held.filter((task) => identity(task) !== key);
    if (detail.active) state.items.push(detail);
    else if (detail.phase === "paused" || detail.pendingCommand) state.held.push(detail);
  }

  async function control(command) {
    if (state.submitting || state.detailStale || !allowedCommand(state.detail, command)) return false;
    const selected = { ...state.selected };
    const selection = selectionSequence;
    const draft = currentDraft();
    const instruction = draft.instruction.trim();
    if (command === "instruct" && (!instruction || new TextEncoder().encode(instruction).length > 4_000)) {
      state.detailError = "请填写补充要求，长度不超过 4000 UTF-8 字节。";
      notify();
      return false;
    }
    const payload = { runId: state.detail.runId, expectedRevision: state.detail.revision, command,
      ...(command === "instruct" ? { instruction } : {}), ...(command === "priority" ? { priority: draft.priority } : {}) };
    const submittedText = draft.instruction;
    state.submitting = true;
    state.notice = "正在提交…";
    state.detailError = "";
    detailSequence += 1;
    detailRequest = null;
    state.detailLoading = false;
    notify();
    try {
      const detail = validateDetail(await readResponse(await fetchImpl(`${taskUrl(selected)}/control`, {
        method: "POST", headers: { "content-type": "application/json", "x-mydashboard-action": "1" }, body: JSON.stringify(payload),
      })), selected);
      if (command === "instruct" && draft.instruction === submittedText) draft.instruction = "";
      if (command === "priority" && draft.priority === payload.priority) draft.priorityDirty = false;
      updateList(detail);
      if (selection !== selectionSequence) return true;
      applyDetail(detail);
      state.notice = command === "resume" ? "原任务已恢复，等待后续调度。" : command === "priority" ? "后续调度优先级已保存。" : phaseLabel(detail);
      return true;
    } catch (error) {
      if (selection !== selectionSequence) return false;
      state.notice = "";
      if (error.status === 409 || !error.status) {
        await refreshDetail();
        if (selection !== selectionSequence) return false;
        state.detailError = state.detailStale ? `${error.message}；未能刷新状态，请先刷新详情。` :
          state.detail.instructionReceipt === "failed" ? "实时引导未确认送达，已保存的要求将在检查点续接；草稿已保留，请先核对已提交的要求。" :
            error.status === 409 ? "任务状态已更新，草稿已保留，请核对后重新提交。" : "提交结果尚未确认，已读取最新状态；请核对已提交要求后再操作。";
      } else state.detailError = error.message;
      return false;
    } finally { state.submitting = false; notify(); }
  }

  function clearTimer() { if (timer !== null) clearTimeoutImpl(timer); timer = null; }
  function schedule() {
    if (!running || !isVisible() || timer !== null) return;
    timer = setTimeoutImpl(() => { timer = null; void poll(); }, 5_000);
  }
  async function poll() {
    if (!running || !isVisible()) return;
    if (pollRequest) return pollRequest;
    pollRequest = Promise.allSettled([refresh(), state.selected && !state.submitting ? refreshDetail() : null]);
    try { await pollRequest; } finally { pollRequest = null; schedule(); }
  }
  async function start() { if (running) return pollRequest; running = true; await poll(); }
  function stop() { running = false; clearTimer(); }
  async function visibilityChanged() { clearTimer(); if (isVisible()) await poll(); }

  return { getState, setDraft, refresh, refreshDetail, open, close, control, start, stop, visibilityChanged };
}

export function createTaskRunsView({ container, dialog, documentImpl = document, ...options }) {
  const detailContent = dialog.querySelector("[data-task-run-content]");
  let renderedSelection = "";
  let lastListMarkup = "";
  let lastSummaryMarkup = "";
  let lastActionsMarkup = "";
  const controller = createTaskRunsController({ ...options, onChange: render });

  function render(state) {
    const listMarkup = renderTaskRuns(state);
    if (listMarkup !== lastListMarkup) {
      const focused = documentImpl.activeElement;
      const taskButton = focused?.closest?.("[data-task-run-kind]");
      const refreshFocused = focused?.matches?.("[data-task-runs-refresh]");
      container.innerHTML = listMarkup;
      lastListMarkup = listMarkup;
      if (taskButton) {
        [...container.querySelectorAll("[data-task-run-kind]")].find((button) =>
          button.dataset.taskRunKind === taskButton.dataset.taskRunKind && button.dataset.taskRunId === taskButton.dataset.taskRunId,
        )?.focus({ preventScroll: true });
      } else if (refreshFocused) container.querySelector("[data-task-runs-refresh]")?.focus({ preventScroll: true });
    }
    if (!state.selected) return;
    const selected = identity(state.selected);
    if (renderedSelection !== selected) {
      detailContent.innerHTML = renderTaskRunDetail(state);
      renderedSelection = selected;
      lastSummaryMarkup = "";
      lastActionsMarkup = "";
    }
    const summaryMarkup = renderTaskRunSummary(state.detail);
    if (summaryMarkup !== lastSummaryMarkup) {
      const summary = detailContent.querySelector("[data-task-run-summary]");
      const historyOpen = summary.querySelector("details")?.open;
      summary.innerHTML = summaryMarkup;
      if (historyOpen) summary.querySelector("details").open = true;
      lastSummaryMarkup = summaryMarkup;
    }
    detailContent.querySelector("[data-task-run-notice]").textContent = state.notice;
    detailContent.querySelector("[data-task-run-error]").textContent = state.detailError;
    const instruction = detailContent.querySelector("textarea");
    const priority = detailContent.querySelector("select");
    if (instruction.value !== state.draft.instruction) instruction.value = state.draft.instruction;
    if (priority.value !== state.draft.priority) priority.value = state.draft.priority;
    detailContent.querySelector("[data-task-run-reload]").disabled = state.detailLoading || state.submitting;
    for (const button of detailContent.querySelectorAll("form button[data-task-run-command]")) button.disabled = controlDisabled(state, button.dataset.taskRunCommand);
    const actionsMarkup = renderTaskRunActions(state);
    if (lastActionsMarkup !== actionsMarkup) {
      const actions = detailContent.querySelector("[data-task-run-actions]");
      const focusedCommand = actions.contains(documentImpl.activeElement) ? documentImpl.activeElement.dataset.taskRunCommand : "";
      actions.innerHTML = actionsMarkup;
      lastActionsMarkup = actionsMarkup;
      if (focusedCommand) [...actions.querySelectorAll("button")].find((button) => button.dataset.taskRunCommand === focusedCommand)?.focus({ preventScroll: true });
    }
  }

  container.addEventListener("click", (event) => {
    if (event.target.closest("[data-task-runs-refresh]")) { void controller.refresh(); return; }
    const button = event.target.closest("[data-task-run-kind]");
    if (!button) return;
    renderedSelection = "";
    void controller.open(button.dataset.taskRunKind, button.dataset.taskRunId);
    if (!dialog.open) dialog.showModal();
  });
  detailContent.addEventListener("input", (event) => {
    if (event.target.name === "instruction") controller.setDraft({ instruction: event.target.value });
  });
  detailContent.addEventListener("change", (event) => {
    if (event.target.name === "priority") controller.setDraft({ priority: event.target.value });
  });
  detailContent.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.control(event.target.matches("[data-task-run-instruction-form]") ? "instruct" : "priority");
  });
  detailContent.addEventListener("click", (event) => {
    if (event.target.closest("[data-task-run-reload]")) { void controller.refreshDetail(); return; }
    const button = event.target.closest("button[type=button][data-task-run-command]");
    if (button) void controller.control(button.dataset.taskRunCommand);
  });
  dialog.querySelector("[data-task-run-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    const selected = controller.getState().selected;
    renderedSelection = "";
    controller.close();
    const opener = [...container.querySelectorAll("[data-task-run-kind]")].find((button) =>
      button.dataset.taskRunKind === selected?.kind && button.dataset.taskRunId === selected?.taskId,
    );
    (opener || container.querySelector("[data-task-runs-refresh]"))?.focus({ preventScroll: true });
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  const onVisibility = () => { void controller.visibilityChanged(); };
  documentImpl.addEventListener("visibilitychange", onVisibility);
  render(controller.getState());
  return { ...controller, stop() { controller.stop(); documentImpl.removeEventListener("visibilitychange", onVisibility); } };
}
