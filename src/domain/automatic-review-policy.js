const DAY_MS = 86_400_000;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const sameLogin = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();

// These facts come from GitHub assignment events. PR activity or review requests
// and local observation times are deliberately not substitutes for receipt time.
export function automaticReviewEligibility(item, account, now = new Date()) {
  if (!LOGIN.test(account || "") || item?.kind !== "pull_request") return "INVALID_TARGET";
  if (item.state?.toLowerCase() !== "open" || item.isDraft !== false) return "PR_NOT_READY";
  if (item.ciStatus && !["NONE", "SUCCESS", "FAILURE", "ERROR"].includes(item.ciStatus)) return "CI_NOT_READY";
  if (!LOGIN.test(item.author || "") || sameLogin(item.author, account)) return "SELF_AUTHORED";
  if (item.incomingReviewFactsAvailable !== true || !sameLogin(item.reviewRecipient, account) ||
      !LOGIN.test(item.reviewReceivedFrom || "") || sameLogin(item.reviewReceivedFrom, account) ||
      item.reviewReceivedVia !== "assignee" || !item.reviewRequestEventId) return "NO_CURRENT_INCOMING_REQUEST";
  const received = Date.parse(item.reviewReceivedAt || "");
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(received) || !Number.isFinite(timestamp) || received > timestamp || timestamp - received > DAY_MS) return "OUTSIDE_RECEIVED_WINDOW";
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item.headRefOid || "")) return "HEAD_UNKNOWN";
  if (["APPROVED", "CHANGES_REQUESTED"].includes(item.myReviewState) && item.myReviewCommitOid === item.headRefOid) return "HEAD_ALREADY_REVIEWED";
  const published = Date.parse(item.myLatestPublishedReviewAt || "");
  if (Number.isFinite(published) && published >= received) return "ASSIGNMENT_ALREADY_REVIEWED";
  return null;
}

// The caller must supply a persisted ledger root, never a model decision or a
// timestamp copied from a proposed Review. The original root retains the first
// observation of its Assign even when later status/Head snapshots arrive.
export function automaticReviewWorkAdmission(root, inputRevision = root?.source?.activeRevision) {
  const source = root?.source;
  if (source?.kind !== "pull_request" || root.sourceQuarantine !== null || source.scope?.active !== true) return null;
  const event = source.current?.event;
  if (!event?.source || source.identity?.provider !== event.source.provider || source.identity?.scopeId !== event.source.scopeId) return null;
  if (event.source.provider === "local-owner" && source.scope.kind === "owner_requested" &&
      event.eventType === "pull_request.owner_requested" && event.payload?.workType === "pull_request") {
    return { kind: "owner_requested", admittedAt: root.createdAt };
  }
  const facts = event?.payload;
  if (event?.source.provider !== "github" || source.scope.kind !== "automatic" || facts?.relation !== "review_requested") return null;
  const original = root.event?.payload;
  const sameAssignment = original?.reviewRequestEventId === facts.reviewRequestEventId &&
    original?.reviewReceivedAt === facts.reviewReceivedAt;
  // New revisions retain each Assign identity. Legacy histories lack that
  // evidence, so only their current accepted snapshot can establish intake.
  const observedAt = sameAssignment ? root.createdAt : (
    source.revisions?.find(entry => entry.revision <= inputRevision && entry.disposition === "accepted" &&
      entry.incomingReview?.eventId === facts.reviewRequestEventId &&
      Date.parse(entry.incomingReview?.receivedAt) === Date.parse(facts.reviewReceivedAt)) ??
    source.revisions?.find(entry => entry.revision === inputRevision && entry.disposition === "accepted")
  )?.occurredAt;
  const admittedAt = Math.max(Date.parse(root.createdAt), Date.parse(observedAt));
  if (!Number.isFinite(admittedAt)) return null;
  return { kind: "assigned", admittedAt: new Date(admittedAt).toISOString(),
    reviewRequestEventId: facts.reviewRequestEventId, reviewReceivedAt: facts.reviewReceivedAt };
}

export function automaticReviewContinuationEligibility(item, account, now, admission) {
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  const admittedAt = Date.parse(admission?.admittedAt);
  const receivedAt = Date.parse(item?.reviewReceivedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(admittedAt) || admittedAt > timestamp ||
      !Number.isFinite(receivedAt) || receivedAt > timestamp) return "INVALID_REVIEW_ADMISSION";
  if (admission.kind === "assigned") {
    if (admission.reviewRequestEventId !== item.reviewRequestEventId ||
        Date.parse(admission.reviewReceivedAt) !== receivedAt) return "REVIEW_ASSIGNMENT_CHANGED";
    return automaticReviewEligibility(item, account, new Date(admittedAt));
  }
  if (admission.kind === "owner_requested") {
    // A trusted explicit Review task can continue an older Assign. Live scope,
    // identity, CI, Head and already-published checks still apply unchanged.
    return automaticReviewEligibility(item, account, new Date(receivedAt));
  }
  return "INVALID_REVIEW_ADMISSION";
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
