export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function relativeTime(value, now) {
  if (!value || !Number.isFinite(Date.parse(value))) return "未知时间";
  const seconds = Math.round((now - Date.parse(value)) / 1_000);
  if (Math.abs(seconds) < 60) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}
