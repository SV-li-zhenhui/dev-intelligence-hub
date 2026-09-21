import { createHash } from "node:crypto";

const IMPORTANT_TOPIC =
  /(?:@|公告|通知|提醒|预警|风险|阻塞|故障|截止|待办|确认|评审|审核|测试|发布|版本|研发|需求|客户|FDA|\bPR\b|\bIssue\b|日报|早报|周报|总结|关注|更新|重置)/iu;
const REACTION_ONLY =
  /^(?:\[(?:赞|感谢|鼓掌|微笑|笑脸|OK|收到|加油|心|爱心)\]\s*)+$/iu;

function compactText(value, limit = 240) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

export function cleanDingTalkMessage(value) {
  const original = compactText(value, 2_000);
  if (!original || REACTION_ONLY.test(original)) return "";
  return original
    .replace(/\[图片消息\]\s*\(\s*mediaId\s*=\s*[^)]+\)/giu, " ")
    .replace(/\[图片消息\]\s*mediaId\s*=\s*[^\s)]+\)?/giu, " ")
    .replace(/\[图片消息\]/giu, " ")
    .replace(/\bmediaId\s*=\s*[^\s)]+\)?/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function groupId(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 20);
}

function rawMessages(item) {
  if (item.summaryStatus && Array.isArray(item.sourceMessages)) {
    return item.sourceMessages;
  }
  return [{
    id: item.id,
    author: item.author || "",
    content: item.title || "",
    updatedAt: item.updatedAt || "",
    url: item.url || "",
  }];
}

function newestFirst(left, right) {
  return Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0);
}

export function prepareDingTalkDigest(items) {
  const passthrough = [];
  const groups = new Map();

  for (const item of items || []) {
    if (item.kind === "todo" || item.summaryStatus) {
      passthrough.push(item);
      continue;
    }
    if (item.kind === "conversation") continue;
    if (!["announcement", "message", "mention"].includes(item.kind)) {
      passthrough.push(item);
      continue;
    }

    const key = compactText(
      item.conversationId || item.context || item.id,
      300,
    );
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: groupId(key),
        context: compactText(item.context || "钉钉会话", 120),
        kinds: new Set(),
        messages: [],
        signatures: new Set(),
      });
    }
    const group = groups.get(key);
    group.kinds.add(item.kind);
    for (const message of rawMessages(item)) {
      const content = cleanDingTalkMessage(message.content);
      if (!content) continue;
      const author = compactText(message.author, 80);
      const signature = `${author}\u0000${content}`;
      if (group.signatures.has(signature)) continue;
      group.signatures.add(signature);
      group.messages.push({
        id: compactText(message.id || item.id, 180),
        author,
        content: compactText(content),
        updatedAt: message.updatedAt || item.updatedAt || "",
        url: message.url || item.url || "",
      });
    }
  }

  return {
    passthrough,
    groups: [...groups.values()]
      .map((group) => ({
        groupId: group.groupId,
        context: group.context,
        kinds: [...group.kinds],
        messages: group.messages.sort(newestFirst).slice(0, 12),
      }))
      .filter((group) => group.messages.length > 0),
  };
}

export function dingTalkDigestFacts(groups) {
  return groups.map((group) => ({
    groupId: group.groupId,
    context: group.context,
    messages: group.messages.map(({ author, content, updatedAt }) => ({
      author,
      content,
      updatedAt,
    })),
  }));
}

function fallbackSummary(group) {
  const [newest, second] = group.messages;
  const author = newest.author ? `${newest.author}反馈` : "会话动态";
  if (group.messages.length === 1) {
    return `${author}：${newest.content}`.slice(0, 100);
  }
  const secondTopic = second?.content && second.content !== newest.content
    ? `；另涉及 ${second.content}`
    : "";
  return `${group.context}今日 ${group.messages.length} 条相关消息：${newest.content}${secondTopic}`
    .slice(0, 100);
}

function fallbackResult(group) {
  const important = group.kinds.some((kind) => kind !== "message") ||
    group.messages.some((message) => IMPORTANT_TOPIC.test(message.content));
  return {
    groupId: group.groupId,
    important,
    summary: fallbackSummary(group),
    highlights: group.messages.slice(0, 2).map((message) => message.content),
    actionRequired: "",
  };
}

function digestItem(group, result, summaryStatus) {
  const newest = group.messages[0];
  const authors = [...new Set(group.messages.map((message) => message.author).filter(Boolean))];
  const kind = group.kinds.includes("announcement")
    ? "announcement"
    : group.kinds.includes("mention")
      ? "mention"
      : "message";
  return {
    id: `dingtalk:digest:${group.groupId}`,
    kind,
    relation: kind === "mention" ? "mentioned" : "daily",
    title: compactText(result.summary, 120),
    summary: compactText(result.summary, 500),
    highlights: (result.highlights || []).map((value) => compactText(value, 240)).filter(Boolean).slice(0, 3),
    actionRequired: compactText(result.actionRequired, 300),
    author: authors.join("、"),
    context: group.context,
    updatedAt: newest.updatedAt,
    url: group.messages.find((message) => message.url)?.url || "",
    state: "open",
    messageCount: group.messages.length,
    sourceMessages: group.messages,
    summaryStatus,
  };
}

export function applyDingTalkSummaries(prepared, summaries = null) {
  const summaryById = new Map(
    (summaries || []).map((summary) => [summary.groupId, summary]),
  );
  const digests = [];
  for (const group of prepared.groups) {
    const generated = summaryById.get(group.groupId);
    const result = generated || fallbackResult(group);
    if (!result.important) continue;
    digests.push(digestItem(group, result, generated ? "ai" : "fallback"));
  }
  return [...prepared.passthrough, ...digests];
}
