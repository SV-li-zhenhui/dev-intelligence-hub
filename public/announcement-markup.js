function escapeAnnouncementHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inlineMarkup(value) {
  return escapeAnnouncementHtml(value)
    .replace(/\*\*([^*\n]{1,120})\*\*/gu, "<strong>$1</strong>")
    .replace(/\*\*/gu, "");
}

function announcementLines(value) {
  return String(value || "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]*---[ \t]*/gu, "\n")
    .replace(/[ \t]+\|[ \t]+/gu, "\n")
    .replace(/[ \t]+(?=#{2,3}[ \t]+)/gu, "\n")
    .replace(/[ \t]+(?=\*\*[^*\n]{1,120}\*\*\s*[:：])/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function announcementDetailMarkup(value) {
  const lines = announcementLines(value);
  if (lines.length === 0) {
    return '<h2 class="announcement-title">无公告正文</h2>';
  }
  const title = lines.shift().replace(/^#{1,3}\s*/u, "").trim();
  const body = lines.map((line) => {
    if (/^#{1,3}\s+/u.test(line)) {
      return `<h3>${inlineMarkup(line.replace(/^#{1,3}\s*/u, ""))}</h3>`;
    }
    const kind = /^\*\*[^*]+\*\*\s*[:：]/u.test(line)
      ? "announcement-fact"
      : "announcement-paragraph";
    return `<p class="${kind}">${inlineMarkup(line)}</p>`;
  }).join("");
  return `
    <section class="announcement-content">
      <h2 class="announcement-title">${inlineMarkup(title)}</h2>
      ${body ? `<div class="announcement-copy">${body}</div>` : ""}
    </section>`;
}
