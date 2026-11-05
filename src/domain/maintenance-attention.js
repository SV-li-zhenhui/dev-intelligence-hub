import { requiresBrainMaintenance } from "./brain-failure-recovery.js";

// Recognize the system-generated retry request, including persisted requests
// from older versions. Business questions and missing configuration stay visible.
export function maintenanceAttentionCode(item) {
  if (!item.choices?.some(({ id }) => id === "configured-retry")) return null;
  const reason = item.context?.find(({ label }) => label === "判断依据")?.value;
  const code = /[（(](STRUCTURED_PROVIDER_[A-Z_]+)[）)]/.exec(reason || "")?.[1];
  return requiresBrainMaintenance(code) ? code : null;
}
