import { DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS } from "../domain/prioritizer.js";
import { ISSUE_OUTSIDE_ACTIVE_WINDOW_REASON } from "./work-ledger-issue-lifecycle.js";
import {
  CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
  PR_SOURCE_AUTHORITY_FENCED_REASON,
} from "./work-ledger-pr-cutover-commands.js";
import {
  currentWorkItemEvent,
  LEGACY_PR_SOURCE_CUTOVER_REASON,
} from "./work-ledger-pr-source.js";
import { MAX_WORK_LEDGER_QUERY_PAGE } from "./work-ledger-records.js";
import {
  MAX_WORK_LEDGER_ITEMS,
  MAX_WORK_LEDGER_SOURCE_ROOTS,
} from "./work-ledger-state.js";
import {
  isPlainLedgerObject,
  workLedgerError,
  WORK_LEDGER_STATUSES,
} from "./work-ledger-values.js";

const DAY_MS = 86_400_000;
const DEFAULT_MAX_PAGES = Math.ceil(
  (MAX_WORK_LEDGER_ITEMS + MAX_WORK_LEDGER_SOURCE_ROOTS) /
    MAX_WORK_LEDGER_QUERY_PAGE,
);
const DEFAULT_SNAPSHOT_ATTEMPTS = 3;

const WORKLOAD_STATUSES = new Map([
  ["working", { group: "working", priority: 0 }],
  ["dispatch_pending", { group: "working", priority: 0 }],
  ["waiting_user", { group: "waiting", priority: 1 }],
  ["waiting_condition", { group: "waiting", priority: 1 }],
  ["waiting_external", { group: "waiting", priority: 1 }],
  ["retry_wait", { group: "waiting", priority: 1 }],
  ["queued", { group: "queued", priority: 2 }],
  ["blocked", { group: "blocked", priority: 3 }],
]);

const HISTORICAL_CONTROL_REASONS = [
  "pr_source_left_scope",
  "pr_source_terminal",
  LEGACY_PR_SOURCE_CUTOVER_REASON,
  "pr_source_cross_root_cutover_retired",
  "pr_source_cross_root_cutover_replaced",
  CROSS_ROOT_PR_SOURCE_CUTOVER_PENDING_REASON,
  PR_SOURCE_AUTHORITY_FENCED_REASON,
  ISSUE_OUTSIDE_ACTIVE_WINDOW_REASON,
];

function requirePort(value) {
  const methods = ["getSummary", "listItems", "listTimeline"];
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`ledger must provide ${methods.join(", ")}`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function isOwnerOverride(item) {
  const source = currentWorkItemEvent(item)?.source;
  return source?.provider === "local-owner" ||
    (typeof source?.scopeId === "string" &&
      source.scopeId.startsWith("owner-request:"));
}

function sourceUpdatedAt(item) {
  const event = currentWorkItemEvent(item);
  return event?.payload?.updatedAt || event?.payload?.createdAt || null;
}

function isHistoricalControlRecord(item) {
  const event = currentWorkItemEvent(item);
  const reason = String(item?.statusReason || "");
  return item?.status === "superseded" ||
    event?.payload?.actionState === "historical" ||
    event?.eventType?.endsWith(".left_scope") === true ||
    item?.source?.scope?.active === false ||
    HISTORICAL_CONTROL_REASONS.some(
      (prefix) => reason === prefix || reason.startsWith(`${prefix}:`) ||
        reason.startsWith(`${prefix}_`),
    );
}

function isWithinDailyScope(item, cutoff) {
  if (isHistoricalControlRecord(item)) return false;
  if (isOwnerOverride(item)) return true;
  const event = currentWorkItemEvent(item);
  if (!event?.eventType?.startsWith("issue.")) return true;
  const parsed = Date.parse(sourceUpdatedAt(item) || "");
  return !Number.isFinite(parsed) || parsed > cutoff;
}

function itemSubjectKey(item) {
  const subject = currentWorkItemEvent(item)?.subject;
  if (typeof subject?.id !== "string" || !subject.id) return item.itemId;
  const target = item?.currentTarget;
  const targetKey = target?.type && target?.id
    ? `${target.type}:${target.id}`
    : "target:unknown";
  return `${subject.id}\u0000${targetKey}`;
}

function itemAuthorityRank(item) {
  const root = item?.kind === "source_root" ? 1_000_000 : 0;
  const owner = isOwnerOverride(item) ? 100_000 : 0;
  const activeRevision = Number(item?.source?.activeRevision) || 0;
  const inputRevision = Number(item?.source?.inputRevision) || 0;
  return root + owner + activeRevision * 100 + inputRevision;
}

function itemTimestamp(item) {
  const parsed = Date.parse(item?.updatedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function preferredItem(left, right) {
  const rank = itemAuthorityRank(right) - itemAuthorityRank(left);
  if (rank !== 0) return rank > 0 ? right : left;
  return itemTimestamp(right) >= itemTimestamp(left) ? right : left;
}

function projectCurrentItems(items, cutoff) {
  const bySubject = new Map();
  for (const item of items) {
    if (!isWithinDailyScope(item, cutoff)) continue;
    const key = itemSubjectKey(item);
    const existing = bySubject.get(key);
    bySubject.set(key, existing ? preferredItem(existing, item) : item);
  }
  return [...bySubject.values()];
}

function itemCounts(items) {
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function durableCount(summary) {
  return Object.values(summary?.itemCounts || {}).reduce(
    (total, count) => total + (Number(count) || 0),
    0,
  );
}

function workloadTitle(item) {
  const assignmentTitle = item?.assignment?.work?.title;
  if (typeof assignmentTitle === "string" && assignmentTitle.trim()) {
    return assignmentTitle;
  }
  const event = currentWorkItemEvent(item);
  if (typeof event?.payload?.title === "string" && event.payload.title.trim()) {
    return event.payload.title;
  }
  const subject = event?.subject;
  if (typeof subject?.repository === "string" && Number.isSafeInteger(subject.number)) {
    return `${subject.repository} #${subject.number}`;
  }
  return item?.assignmentId || item?.itemId;
}

function workloadSubject(item) {
  const event = currentWorkItemEvent(item);
  const { repository, number } = event?.subject || {};
  if (
    typeof repository !== "string" || !repository ||
    !Number.isSafeInteger(number) || number < 1
  ) return null;
  const eventType = event?.eventType || "";
  const kind = eventType.startsWith("pull_request.")
    ? "pull_request"
    : eventType.startsWith("issue.")
      ? "issue"
      : item?.source?.kind;
  return ["pull_request", "issue"].includes(kind)
    ? { kind, repository, number }
    : null;
}

function workloadTask(item) {
  return {
    itemId: item.itemId,
    status: item.status,
    statusReason: item.statusReason,
    title: workloadTitle(item),
    updatedAt: item.updatedAt,
    subject: workloadSubject(item),
  };
}

function compareWorkloadTasks(left, right) {
  const priority =
    (WORKLOAD_STATUSES.get(left.status)?.priority ?? 99) -
    (WORKLOAD_STATUSES.get(right.status)?.priority ?? 99);
  return priority || itemTimestamp(right) - itemTimestamp(left) ||
    String(left.itemId).localeCompare(String(right.itemId));
}

function retainTopWorkloadTask(tasks, task) {
  tasks.push(task);
  tasks.sort(compareWorkloadTasks);
  if (tasks.length > 3) tasks.pop();
}

function projectRoleWorkloads(items) {
  const roles = new Map();
  for (const item of items) {
    const status = WORKLOAD_STATUSES.get(item.status);
    if (!status || item?.currentTarget?.type !== "role") continue;
    const roleId = item.currentTarget.id;
    const workload = roles.get(roleId) || {
      roleId,
      counts: { queued: 0, working: 0, waiting: 0, blocked: 0 },
      tasks: [],
    };
    workload.counts[status.group] += 1;
    retainTopWorkloadTask(workload.tasks, workloadTask(item));
    roles.set(roleId, workload);
  }
  return {
    items: [...roles.values()]
      .sort((left, right) => left.roleId.localeCompare(right.roleId)),
  };
}

function listOptions(value = {}) {
  if (!isPlainLedgerObject(value)) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const allowed = new Set(["cursor", "limit", "status", "order", "roleId"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "工作台账查询无效");
  }
  const requestedLimit = value.limit === undefined ? 50 : Number(value.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "查询条数无效");
  }
  if (value.cursor !== undefined && typeof value.cursor !== "string") {
    throw workLedgerError("WORK_LEDGER_CURSOR_INVALID", "工作台账游标无效");
  }
  if (
    value.status !== undefined &&
    !WORK_LEDGER_STATUSES.has(value.status)
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "状态过滤无效");
  }
  if (value.order !== undefined && !["oldest", "newest"].includes(value.order)) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "排序方式无效");
  }
  if (
    value.roleId !== undefined &&
    (
      typeof value.roleId !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value.roleId)
    )
  ) {
    throw workLedgerError("WORK_LEDGER_QUERY_INVALID", "岗位过滤无效");
  }
  return {
    ...value,
    limit: Math.min(requestedLimit, MAX_WORK_LEDGER_QUERY_PAGE),
  };
}

function queryCurrentItems(items, input) {
  const options = listOptions(input);
  let selected = items;
  if (options.status !== undefined) {
    selected = selected.filter((item) => item.status === options.status);
  }
  if (options.roleId !== undefined) {
    selected = selected.filter(
      (item) => item?.currentTarget?.type === "role" &&
        item.currentTarget.id === options.roleId,
    );
  }
  selected = [...selected].sort(
    (left, right) => itemTimestamp(left) - itemTimestamp(right) ||
      String(left.itemId).localeCompare(String(right.itemId)),
  );
  if (options.order === "newest") selected.reverse();
  let start = 0;
  if (options.cursor) {
    const cursorIndex = selected.findIndex(
      (item) => item.itemId === options.cursor,
    );
    if (cursorIndex < 0) {
      throw workLedgerError(
        "WORK_LEDGER_CURSOR_INVALID",
        "工作台账游标已失效",
      );
    }
    start = cursorIndex + 1;
  }
  const page = selected.slice(start, start + options.limit);
  return {
    items: structuredClone(page),
    nextCursor: start + page.length < selected.length && page.length > 0
      ? page.at(-1).itemId
      : null,
  };
}

function unstableSnapshotError() {
  return Object.assign(new Error("日常任务投影期间台账持续变化"), {
    code: "DAILY_WORK_LEDGER_SNAPSHOT_UNSTABLE",
    statusCode: 503,
  });
}

export class DailyWorkLedgerView {
  constructor({
    ledger,
    activeWindowDays = DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS,
    clock = () => new Date(),
    maxPages = DEFAULT_MAX_PAGES,
    snapshotAttempts = DEFAULT_SNAPSHOT_ATTEMPTS,
  } = {}) {
    this.ledger = requirePort(ledger);
    this.activeWindowDays = positiveInteger(activeWindowDays, "activeWindowDays");
    this.maxPages = positiveInteger(maxPages, "maxPages");
    this.snapshotAttempts = positiveInteger(snapshotAttempts, "snapshotAttempts");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.clock = clock;
    this.cache = null;
    this.snapshotPromise = null;
  }

  listTimeline(options) {
    return this.ledger.listTimeline(options);
  }

  getSummary() {
    return this.getCurrentSummary();
  }

  getRoleWorkloads() {
    return this.getCurrentRoleWorkloads();
  }

  listItems(options) {
    return this.listCurrentItems(options);
  }

  async getCurrentSummary() {
    const snapshot = await this.#currentSnapshot();
    return structuredClone({
      ...snapshot.summary,
      itemCounts: itemCounts(snapshot.currentItems),
      durableItemCounts: snapshot.summary.itemCounts,
      dailyScope: {
        activeWindowDays: this.activeWindowDays,
        currentItems: snapshot.currentItems.length,
        historyItems: snapshot.items.length - snapshot.currentItems.length,
        durableItems: durableCount(snapshot.summary),
      },
    });
  }

  async getCurrentRoleWorkloads() {
    const snapshot = await this.#currentSnapshot();
    return structuredClone(projectRoleWorkloads(snapshot.currentItems));
  }

  async listCurrentItems(options = {}) {
    const snapshot = await this.#currentSnapshot();
    return queryCurrentItems(snapshot.currentItems, options);
  }

  async #snapshot() {
    const observed = await this.ledger.getSummary();
    if (this.cache?.revision === observed.revision) return this.cache;
    const snapshot = await this.#sharedSnapshotLoad();
    if (snapshot.revision !== observed.revision) return this.#snapshot();
    return snapshot;
  }

  #sharedSnapshotLoad() {
    if (this.snapshotPromise !== null) return this.snapshotPromise;
    const pending = this.#loadSnapshot();
    this.snapshotPromise = pending;
    void pending.then(
      () => {
        if (this.snapshotPromise === pending) this.snapshotPromise = null;
      },
      () => {
        if (this.snapshotPromise === pending) this.snapshotPromise = null;
      },
    );
    return pending;
  }

  async #loadSnapshot() {
    for (let attempt = 0; attempt < this.snapshotAttempts; attempt += 1) {
      const before = await this.ledger.getSummary();
      if (this.cache?.revision === before.revision) return this.cache;
      const items = await this.#readAllItems();
      const after = await this.ledger.getSummary();
      if (before.revision !== after.revision) continue;
      this.cache = {
        revision: after.revision,
        summary: after,
        items,
      };
      return this.cache;
    }
    throw unstableSnapshotError();
  }

  async #currentSnapshot() {
    const snapshot = await this.#snapshot();
    const clockValue = this.clock();
    const now = clockValue instanceof Date ? clockValue.getTime() : Date.parse(clockValue);
    if (!Number.isFinite(now)) throw new TypeError("clock returned an invalid time");
    const cutoff = now - this.activeWindowDays * DAY_MS;
    return {
      ...snapshot,
      currentItems: projectCurrentItems(snapshot.items, cutoff),
    };
  }

  async #readAllItems() {
    const items = [];
    let cursor;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
      const page = await this.ledger.listItems({
        limit: MAX_WORK_LEDGER_QUERY_PAGE,
        order: "oldest",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!page || !Array.isArray(page.items)) {
        throw new TypeError("ledger returned an invalid work item page");
      }
      items.push(...page.items);
      if (page.nextCursor === null) return items;
      if (
        typeof page.nextCursor !== "string" || page.items.length === 0 ||
        page.items.at(-1)?.itemId !== page.nextCursor || seen.has(page.nextCursor)
      ) {
        throw new TypeError("ledger returned an invalid work item cursor");
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new TypeError("daily work item projection exceeded the page limit");
  }
}

export function createDailyWorkLedgerView(options) {
  return new DailyWorkLedgerView(options);
}
