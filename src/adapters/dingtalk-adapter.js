import { runCommand, runJson } from "../lib/command-runner.js";

function isoWithOffset(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  const pad = (value) => String(value).padStart(2, "0");
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return `${local.toISOString().slice(0, 19)}${sign}${pad(
    Math.floor(absolute / 60),
  )}:${pad(absolute % 60)}`;
}

function textValue(message) {
  const value = message.text || message.content || "";
  return typeof value === "string"
    ? value
    : value.content || JSON.stringify(value);
}

export class DingTalkAdapter {
  async collect(since) {
    const now = new Date();
    const start = since ? new Date(since) : new Date(now.getTime() - 3_600_000);
    const [unread, mentions, todos] = await Promise.allSettled([
      this.unreadConversations(),
      this.mentions(start, now),
      this.todos(),
    ]);
    const errors = [];
    const value = (result, label) => {
      if (result.status === "fulfilled") return result.value;
      errors.push(`${label}: ${result.reason.message}`);
      return [];
    };
    return {
      items: [
        ...value(unread, "unread"),
        ...value(mentions, "mentions"),
        ...value(todos, "todos"),
      ],
      errors,
    };
  }

  async unreadConversations() {
    const data = await runJson("dws", [
      "chat",
      "message",
      "list-unread-conversations",
      "--format",
      "json",
    ]);
    return (data.result?.conversations || []).map((conversation) => ({
      id: `dingtalk:conversation:${conversation.openConversationId}`,
      kind: "conversation",
      relation: "unread",
      title: conversation.title || "未命名会话",
      unread: conversation.unreadPoint || 0,
      updatedAt: new Date(conversation.lastMsgCreateAt || Date.now()).toISOString(),
      state: "open",
    }));
  }

  async mentions(start, end) {
    const data = await runJson("dws", [
      "chat",
      "message",
      "search-advanced",
      "--at-me",
      "--start",
      isoWithOffset(start),
      "--end",
      isoWithOffset(end),
      "--limit",
      "50",
      "--format",
      "json",
    ]);
    const messages = data.result?.messages || data.result?.list || [];
    return messages.map((message, index) => {
      const id =
        message.msgId ||
        message.messageId ||
        message.openMessageId ||
        `${message.createAt || message.createTime || ""}:${index}`;
      return {
        id: `dingtalk:mention:${id}`,
        kind: "mention",
        relation: "mentioned",
        title: textValue(message).replace(/\s+/g, " ").slice(0, 180),
        author:
          message.senderName ||
          message.sender ||
          message.senderInfo?.name ||
          "",
        context: message.conversationTitle || message.title || "",
        updatedAt:
          message.createAt || message.createTime || new Date().toISOString(),
        state: "open",
      };
    });
  }

  async todos() {
    const data = await runJson("dws", [
      "todo",
      "task",
      "list",
      "--page",
      "1",
      "--size",
      "30",
      "--status",
      "false",
      "--format",
      "json",
    ]);
    return (data.result?.todoCards || []).map((todo) => ({
      id: `dingtalk:todo:${todo.taskId}`,
      kind: "todo",
      relation: "assigned",
      title: todo.subject || todo.title || "未命名待办",
      dueAt: todo.dueTime
        ? new Date(todo.dueTime).toISOString()
        : null,
      updatedAt: todo.modifiedTime
        ? new Date(todo.modifiedTime).toISOString()
        : new Date().toISOString(),
      url: todo.detailUrl || todo.url || "",
      state: "open",
    }));
  }

  async notifySelf(userId, title, message) {
    await runCommand(
      "dws",
      [
        "chat",
        "message",
        "send",
        "--user",
        userId,
        "--title",
        title,
        "--text",
        message,
        "--format",
        "json",
      ],
      { timeoutMs: 60_000 },
    );
  }
}
