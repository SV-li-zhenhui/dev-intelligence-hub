import { types as utilTypes } from "node:util";

const DIRECT_ACTION_ADMISSION_GATE = Object.freeze({
  run(operation) {
    return operation();
  },
});

function actionAdmissionGateFrom(options) {
  if (options === undefined) return DIRECT_ACTION_ADMISSION_GATE;
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    utilTypes.isProxy(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("notification service options are invalid");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.length === 0) return DIRECT_ACTION_ADMISSION_GATE;
  const descriptor = keys.length === 1 && keys[0] === "actionAdmissionGate"
    ? Object.getOwnPropertyDescriptor(options, "actionAdmissionGate")
    : null;
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new TypeError("notification service options are invalid");
  }
  const gate = descriptor.value;
  if (!gate || utilTypes.isProxy(gate) || typeof gate.run !== "function") {
    throw new TypeError("notification action admission gate is invalid");
  }
  return gate;
}

function lineFor(item) {
  const source = item.repo ? `${item.repo} #${item.number}` : "钉钉";
  const reason = item.reasons?.[0] || "状态有变化";
  return `- [${reason}] ${source} · ${item.title}`;
}

function changedItems(diff) {
  return [
    ...diff.added,
    ...diff.changed.map((change) => change.after),
  ];
}

export class NotificationService {
  constructor(dingtalk, config, options) {
    this.dingtalk = dingtalk;
    this.config = config;
    this.actionAdmissionGate = actionAdmissionGateFrom(options);
  }

  async send(diff, prioritizedItems, { signal = null } = {}) {
    if (diff.baseline) {
      return { sent: false, reason: "baseline" };
    }
    const prioritizedById = new Map(
      prioritizedItems.map((item) => [item.id, item]),
    );
    const candidates = changedItems(diff)
      .map((item) => prioritizedById.get(item.id))
      .filter(Boolean)
      .filter((item) => !["announcement", "message"].includes(item.kind))
      .filter((item) => item.score >= this.config.notifyMinimumScore)
      .slice(0, this.config.maxNotificationsPerRun);

    if (!candidates.length) {
      return { sent: false, reason: "no-important-change" };
    }

    const message = [
      "研发雷达发现需要关注的新变化：",
      "",
      ...candidates.map(lineFor),
      "",
      "只推送新增或状态变化；完整上下文请打开 MyDashboard。",
    ].join("\n");
    return this.actionAdmissionGate.run(async () => {
      await this.dingtalk.notifySelf(
        this.config.selfUserId,
        `研发雷达 · ${candidates.length} 项变化`,
        message,
        signal === null ? {} : { signal },
      );
      return { sent: true, count: candidates.length };
    });
  }
}
