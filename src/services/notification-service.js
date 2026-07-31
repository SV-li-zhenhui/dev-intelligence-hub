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
  constructor(dingtalk, config) {
    this.dingtalk = dingtalk;
    this.config = config;
  }

  async send(diff, prioritizedItems) {
    if (diff.baseline) {
      return { sent: false, reason: "baseline" };
    }
    const prioritizedById = new Map(
      prioritizedItems.map((item) => [item.id, item]),
    );
    const candidates = changedItems(diff)
      .map((item) => prioritizedById.get(item.id))
      .filter(Boolean)
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
    await this.dingtalk.notifySelf(
      this.config.selfUserId,
      `研发雷达 · ${candidates.length} 项变化`,
      message,
    );
    return { sent: true, count: candidates.length };
  }
}
