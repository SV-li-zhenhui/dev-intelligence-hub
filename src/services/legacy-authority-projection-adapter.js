import { createHash } from "node:crypto";

import {
  applyMemoryAuthorityProjectionAdoptionCandidate,
  normalizeMemoryAuthorityProjectionReferences,
  normalizeMemoryJournalState,
} from "./local-memory-journal.js";
import {
  normalizeLegacyAuthorityProjectionState,
  planAuthorityBoundProjectionCandidate,
} from "./memory-projector.js";
import {
  projectConfirmationMemoryState,
} from "./confirmation-queue.js";
import {
  readWorkGraphMemoryProjectionBatch,
} from "./work-ledger-graph-memory.js";
import {
  verifyPullRequestExecutionBinding,
} from "./work-ledger-pr-source.js";
import {
  normalizeWorkLedgerPersistedState,
} from "./work-ledger-state.js";

const EMPTY_AUTHORITY_STATE_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex");

export const RESTORE_AUTHORITY_ADOPTION_BLOCKED =
  "RESTORE_AUTHORITY_ADOPTION_BLOCKED";

function adoptionBlocked(cause) {
  if (cause?.code === RESTORE_AUTHORITY_ADOPTION_BLOCKED) return cause;
  return Object.assign(
    new Error("legacy authority projection adoption is blocked", { cause }),
    { code: RESTORE_AUTHORITY_ADOPTION_BLOCKED },
  );
}

function materialProjection(value) {
  return value.revision > 0 ||
    value.workLedgerRevision > 0 ||
    value.authorityStateDigest !== EMPTY_AUTHORITY_STATE_DIGEST ||
    value.confirmationHighWatermark > 0 ||
    value.entries.length > 0;
}

function populatedJournalCheckpoint(value) {
  return materialProjection(value);
}

function referencedProjectionForValidation(
  legacyProjection,
  legacySchemaVersion,
  journal,
) {
  const recordsById = new Map(
    journal.records.map((record) => [record.recordId, record]),
  );
  const entries = legacyProjection.entries.map((entry) => {
    if (legacySchemaVersion !== 1) return entry;
    const record = recordsById.get(entry.recordId);
    let content;
    try {
      content = JSON.parse(record?.content);
    } catch {
      content = null;
    }
    const authority = content?.authority;
    return {
      ...entry,
      sourceKind: record?.source?.kind,
      binding: authority?.applies === true
        ? authority.inputBinding
        : null,
      current: authority?.current,
      occurredAt: record?.occurredAt,
    };
  });
  return normalizeMemoryAuthorityProjectionReferences(
    {
      ...legacyProjection,
      schemaVersion: 4,
      entries,
    },
    journal.records,
  );
}

function stableNormalizedJournal(journal, memoryLimits) {
  return normalizeMemoryJournalState(
    normalizeMemoryJournalState(journal, memoryLimits),
    memoryLimits,
  );
}

function requiresConfirmationState(projection) {
  return projection.confirmationHighWatermark > 0 ||
    projection.entries.some(({ sourceKind }) =>
      ["confirmation", "external-result"].includes(sourceKind)
    );
}

export async function planLegacyAuthorityProjectionAdoption({
  journal,
  legacyProjection,
  workLedger,
  confirmationState = null,
  memoryLimits = {},
} = {}) {
  try {
    const normalizedJournal = normalizeMemoryJournalState(
      journal,
      memoryLimits,
    );
    if (legacyProjection === null || legacyProjection === undefined) {
      return stableNormalizedJournal(journal, memoryLimits);
    }
    const legacySchemaVersion = legacyProjection?.schemaVersion;
    const normalizedLegacy = normalizeLegacyAuthorityProjectionState(
      legacyProjection,
    );
    const journalCheckpoint =
      normalizedJournal.lifecycleAuthority.authorityProjection;
    if (populatedJournalCheckpoint(journalCheckpoint)) {
      return stableNormalizedJournal(journal, memoryLimits);
    }
    if (!materialProjection(normalizedLegacy)) {
      return stableNormalizedJournal(journal, memoryLimits);
    }
    const normalizedLedger = normalizeWorkLedgerPersistedState(workLedger);
    const validatedLegacy = referencedProjectionForValidation(
      normalizedLegacy,
      legacySchemaVersion,
      normalizedJournal,
    );
    for (const entry of validatedLegacy.entries) {
      if (entry.binding !== null) {
        verifyPullRequestExecutionBinding(normalizedLedger, entry.binding);
      }
    }
    if (
      confirmationState === null &&
      requiresConfirmationState(validatedLegacy)
    ) {
      throw new TypeError("confirmation authority state is missing");
    }
    const confirmationSnapshot = confirmationState === null
      ? { highWatermark: 0, items: [] }
      : projectConfirmationMemoryState(confirmationState);
    if (
      confirmationSnapshot.highWatermark <
        validatedLegacy.confirmationHighWatermark
    ) {
      throw new TypeError("confirmation authority state is stale");
    }
    const stored = {
      ...normalizedLegacy,
      revision: journalCheckpoint.revision,
      workLedgerRevision: journalCheckpoint.workLedgerRevision,
      authorityStateDigest: journalCheckpoint.authorityStateDigest,
      confirmationHighWatermark:
        journalCheckpoint.confirmationHighWatermark,
    };
    const projectionPlan = await planAuthorityBoundProjectionCandidate({
      stored,
      snapshot: {
        ledgerRevision: normalizedLedger.revision,
        items: normalizedLedger.items,
        timeline: normalizedLedger.timeline,
        graph: readWorkGraphMemoryProjectionBatch(
          normalizedLedger.graphMemoryProjection,
          { limit: 100 },
        ),
      },
      confirmationSnapshot,
      verifyInputAuthority: (binding) =>
        verifyPullRequestExecutionBinding(normalizedLedger, binding),
      requiresJournalAdoption: true,
      strictBindings: true,
    });
    if (projectionPlan.projectionState === null) {
      throw new TypeError("authority adoption did not produce a checkpoint");
    }
    return applyMemoryAuthorityProjectionAdoptionCandidate(
      journal,
      {
        records: projectionPlan.records,
        projectionState: projectionPlan.projectionState,
      },
      validatedLegacy,
      memoryLimits,
    );
  } catch (cause) {
    throw adoptionBlocked(cause);
  }
}
