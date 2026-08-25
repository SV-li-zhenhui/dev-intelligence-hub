import { deliveryAcceptanceContractDigest } from "../domain/delivery-evidence-contract.js";
import { normalizeWorkGraphAcceptanceContract } from "../domain/work-graph-contract.js";
import { roleContextError } from "./role-context-error.js";

const MAXIMUM_RECORDS = 20;
const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,254}[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;

function evidenceError(code, message, options) {
  return roleContextError(code, message, 503, options);
}

function invalidEvidence(options) {
  return evidenceError(
    "ROLE_CONTEXT_EVIDENCE_INVALID",
    "Authoritative delivery evidence is invalid",
    options,
  );
}

function exactRecord(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${name} is invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function denseRecords(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAXIMUM_RECORDS ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new TypeError("authoritative evidence records are invalid");
  }
  const records = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("authoritative evidence records are invalid");
    }
    records.push(descriptor.value);
  }
  return records;
}

function text(value, name, maximumBytes) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function identifier(value, name, maximumBytes = 256) {
  const normalized = text(value, name, maximumBytes);
  if (!SAFE_ID.test(normalized)) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function bindCatalog(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" && typeof value !== "function") {
    throw new TypeError("evidenceCatalog is invalid");
  }
  let current = value;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(
        current,
        "listForTask",
      );
      if (descriptor) {
        if (
          !("value" in descriptor) ||
          typeof descriptor.value !== "function"
        ) {
          throw new TypeError("evidenceCatalog is invalid");
        }
        return descriptor.value.bind(value);
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "evidenceCatalog is invalid"
    ) {
      throw error;
    }
    throw new TypeError("evidenceCatalog is invalid", { cause: error });
  }
  throw new TypeError("evidenceCatalog is invalid");
}

function catalogKinds(contract) {
  return [...new Set(
    contract.expectedDeliverables
      .map(({ kind }) => kind)
      .filter((kind) => !["requirement-spec", "text-report"].includes(kind)),
  )].sort(compareText);
}

function normalizeEvidenceRecords(records, contract) {
  const deliverables = new Map(
    contract.expectedDeliverables.map((deliverable) => [
      deliverable.deliverableId,
      deliverable,
    ]),
  );
  const normalized = denseRecords(records).map((record) => {
    const descriptor = exactRecord(
      record,
      ["deliverableId", "evidence"],
      "authoritative evidence descriptor",
    );
    const selectedId = identifier(
      descriptor.deliverableId,
      "authoritative evidence deliverableId",
      128,
    );
    const selected = deliverables.get(selectedId);
    const source = exactRecord(
      descriptor.evidence,
      ["kind", "referenceId", "contentDigest"],
      "authoritative evidence",
    );
    const evidence = {
      kind: identifier(source.kind, "authoritative evidence kind", 128),
      referenceId: text(
        source.referenceId,
        "authoritative evidence referenceId",
        512,
      ),
      contentDigest: digest(
        source.contentDigest,
        "authoritative evidence contentDigest",
      ),
    };
    if (
      selected === undefined ||
      selected.kind !== evidence.kind ||
      evidence.kind === "requirement-spec"
    ) {
      throw new TypeError("authoritative evidence target is invalid");
    }
    return { deliverableId: selectedId, evidence };
  });
  const keys = normalized.map(({ deliverableId, evidence }) =>
    `${deliverableId}\u0000${evidence.kind}\u0000${evidence.referenceId}\u0000${evidence.contentDigest}`
  );
  if (new Set(keys).size !== normalized.length) {
    throw new TypeError("authoritative evidence contains duplicates");
  }
  return normalized;
}

export function createRoleContextEvidenceCatalogAdapter(value) {
  const listForTask = bindCatalog(value);
  return Object.freeze({
    async read({ roleId, taskId, acceptanceContract, signal } = {}) {
      signal?.throwIfAborted();
      const contract = normalizeWorkGraphAcceptanceContract(
        acceptanceContract,
      );
      const kinds = catalogKinds(contract);
      if (listForTask === null || kinds.length === 0) return [];
      let records;
      try {
        records = await listForTask({
          taskId,
          roleId,
          contractRevision: contract.revision,
          contractDigest: deliveryAcceptanceContractDigest(contract),
          kinds,
          limit: MAXIMUM_RECORDS,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (cause) {
        signal?.throwIfAborted();
        throw evidenceError(
          "ROLE_CONTEXT_EVIDENCE_UNAVAILABLE",
          "Unable to read authoritative delivery evidence",
          { cause },
        );
      }
      signal?.throwIfAborted();
      try {
        return normalizeEvidenceRecords(records, contract);
      } catch (cause) {
        throw invalidEvidence({ cause });
      }
    },
  });
}
