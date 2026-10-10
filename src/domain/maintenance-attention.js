const MAINTENANCE_CODES = new Set([
  "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
  "STRUCTURED_PROVIDER_CLEANUP_FAILED",
  "STRUCTURED_PROVIDER_REAP_FAILED",
]);

// Recognize the system-generated retry request, including persisted requests
// from older versions. Business questions and missing configuration stay visible.
export function maintenanceAttentionCode(item) {
  if (!item.choices?.some(({ id }) => id === "configured-retry")) return null;
  const reason = item.context?.find(({ label }) => label === "判断依据")?.value;
  const code = /[（(](STRUCTURED_PROVIDER_[A-Z_]+)[）)]/.exec(reason || "")?.[1];
  return MAINTENANCE_CODES.has(code) ? code : null;
}
