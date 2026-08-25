function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function boundedText(value, maximumCharacters) {
  const characters = [...String(value || "")];
  return {
    text: characters.slice(0, maximumCharacters).join(""),
    truncated: characters.length > maximumCharacters,
  };
}

function readableMarkdown(value, maximumCharacters) {
  const source = String(value || "");
  const hasImages = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>/iu.test(source);
  const normalized = source
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<img\b[^>]*>/giu, "")
    .replace(/<[^>]+>/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\r\n?/gu, "\n")
    .trim();
  const bounded = boundedText(normalized, maximumCharacters);
  return { ...bounded, hasImages };
}

function inlineMarkup(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]{1,240})\*\*/gu, "<strong>$1</strong>")
    .replace(/`([^`\n]{1,500})`/gu, "<code>$1</code>")
    .replace(/\*\*/gu, "")
    .replace(/`/gu, "");
}

function markdownBlocks(value, maximumCharacters) {
  const content = readableMarkdown(value, maximumCharacters);
  const blocks = [];
  let list = [];
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(`<ul>${list.map((line) => `<li>${inlineMarkup(line)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const rawLine of content.text.split(/\n+/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const listItem = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/u);
    if (listItem) {
      list.push(listItem[1]);
      continue;
    }
    flushList();
    const heading = line.match(/^#{1,4}\s+(.+)$/u);
    blocks.push(heading
      ? `<h4>${inlineMarkup(heading[1])}</h4>`
      : `<p>${inlineMarkup(line)}</p>`);
  }
  flushList();
  if (content.hasImages) {
    blocks.push('<p class="github-media-note">正文包含图片，请在 GitHub 中查看原图。</p>');
  }
  if (content.truncated) {
    blocks.push('<p class="github-media-note">这里只显示正文摘要，完整内容请在 GitHub 中查看。</p>');
  }
  return blocks.join("");
}

function latestCommentMarkup(comment) {
  if (!comment?.body) return "";
  const author = comment.author ? `@${comment.author}` : "GitHub 评论";
  const timestamp = comment.updatedAt || comment.createdAt || "";
  return `
    <section class="github-detail-section github-latest-comment">
      <div class="github-detail-heading">
        <h3>最新评论</h3>
        <span>评论者 ${escapeHtml(author)}${timestamp ? ` · ${escapeHtml(new Date(timestamp).toLocaleString("zh-CN"))}` : ""}</span>
      </div>
      <div class="github-detail-copy">${markdownBlocks(comment.body, 900)}</div>
    </section>`;
}

export function githubItemDetailMarkup(item) {
  if (!item || !["issue", "pull_request"].includes(item.kind)) return "";
  const description = item.description
    ? `
      <section class="github-detail-section">
        <div class="github-detail-heading">
          <h3>${item.kind === "issue" ? "问题说明" : "变更说明"}</h3>
          <span>GitHub 正文摘要</span>
        </div>
        <div class="github-detail-copy">${markdownBlocks(item.description, 2_400)}</div>
      </section>`
    : "";
  return `${description}${latestCommentMarkup(item.latestComment)}`;
}
