const DAY_MS = 86_400_000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const sameLogin = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();

// These facts come from GitHub assignment/review-request events. PR activity
// and local observation times are deliberately not substitutes for receipt time.
export function automaticReviewEligibility(item, account, now = new Date()) {
  if (!LOGIN.test(account || "") || item?.kind !== "pull_request") return "INVALID_TARGET";
  if (item.state?.toLowerCase() !== "open" || item.isDraft !== false) return "PR_NOT_READY";
  if (item.ciStatus && !["NONE", "SUCCESS"].includes(item.ciStatus)) return "CI_NOT_READY";
  if (!LOGIN.test(item.author || "") || sameLogin(item.author, account)) return "SELF_AUTHORED";
  if (item.incomingReviewFactsAvailable !== true || !sameLogin(item.reviewRecipient, account) ||
      !LOGIN.test(item.reviewReceivedFrom || "") || sameLogin(item.reviewReceivedFrom, account) ||
      !["assignee", "reviewer"].includes(item.reviewReceivedVia) || !item.reviewRequestEventId) return "NO_CURRENT_INCOMING_REQUEST";
  const received = Date.parse(item.reviewReceivedAt || "");
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(received) || !Number.isFinite(timestamp) || received > timestamp || timestamp - received > DAY_MS) return "OUTSIDE_RECEIVED_WINDOW";
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.headRefOid || "")) return "HEAD_UNKNOWN";
  if (["APPROVED", "CHANGES_REQUESTED"].includes(item.myReviewState) && item.myReviewCommitOid === item.headRefOid) return "HEAD_ALREADY_REVIEWED";
  return null;
}

export function automaticTestingOwner(item, ownersByProduct = {}) {
  const text = [item.title, ...(item.labels || []), item.gitTarget?.baseRefName, item.gitTarget?.headRefName, item.repo].filter(Boolean).join(" ");
  const bs = /\bB\s*\/\s*S\b|\bBS(?:[-_ ]|版)|\bweb\b|网页端|浏览器端|Picasso-ProductAndFE/iu.test(text);
  const qt = /\bQt\b|桌面版|客户端|\bVG[S]?#|VanGogh|OCT-Software/iu.test(text);
  const product = bs ? "bs" : qt ? "qt" : null;
  const login = product && ownersByProduct[product]?.find((owner) => LOGIN.test(owner || "") && !sameLogin(owner, item.currentUser) && !sameLogin(owner, item.author));
  return login ? { login, product } : null;
}

export function isAutomaticReviewExecution(item) {
  return item?.kind === "github.work-proposal-review" && /^auto-review-v1-[a-f0-9]{48}$/.test(item.execution?.requestId || "");
}
