import { createHash } from "node:crypto";

export const WORKFLOW_OUTCOMES = new Set([
  "assigned",
  "unmatched",
  "disabled",
]);
export const WORKFLOW_TARGET_TYPES = new Set(["role", "person", "node"]);
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function workflowServiceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

export function cloneWorkflowValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isPlainWorkflowObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function workflowDataEntries(value) {
  if (!isPlainWorkflowObject(value)) return null;
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      return null;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function hasExactWorkflowKeys(value, expected) {
  const entries = workflowDataEntries(value);
  if (!entries) return false;
  const keys = entries.map(([key]) => key);
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key))
  );
}

export function canonicalWorkflowValue(
  value,
  depth = 0,
  budget = { entries: 0 },
) {
  budget.entries += 1;
  if (budget.entries > 20_000 || depth > 24) {
    throw workflowServiceError("WORKFLOW_VALUE_INVALID", "工作流记录过大");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw workflowServiceError(
        "WORKFLOW_VALUE_INVALID",
        "工作流记录必须是连续数组",
      );
    }
    return value.map((entry) =>
      canonicalWorkflowValue(entry, depth + 1, budget),
    );
  }
  const entries = workflowDataEntries(value);
  if (!entries) {
    throw workflowServiceError(
      "WORKFLOW_VALUE_INVALID",
      "工作流记录必须是纯 JSON",
    );
  }
  const result = {};
  for (const [key, entry] of entries.sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  )) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw workflowServiceError(
        "WORKFLOW_VALUE_INVALID",
        "工作流记录包含危险字段",
      );
    }
    result[key] = canonicalWorkflowValue(entry, depth + 1, budget);
  }
  return result;
}

export function workflowDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalWorkflowValue(value)), "utf8")
    .digest("hex");
}

export function largeWorkflowDigest(
  value,
  { maximumBytes, maximumDepth = 64 } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  const hash = createHash("sha256");
  const ancestors = new Set();
  let bytes = 0;
  const write = (text) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maximumBytes) {
      throw workflowServiceError(
        "WORKFLOW_VALUE_INVALID",
        "工作流状态摘要输入超过安全字节上限",
      );
    }
    hash.update(text, "utf8");
  };
  const visit = (entry, depth) => {
    if (depth > maximumDepth) {
      throw workflowServiceError(
        "WORKFLOW_VALUE_INVALID",
        "工作流状态摘要输入嵌套过深",
      );
    }
    if (entry === null || typeof entry === "boolean") {
      write(JSON.stringify(entry));
      return;
    }
    if (typeof entry === "string") {
      write(JSON.stringify(entry));
      return;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      write(JSON.stringify(Object.is(entry, -0) ? 0 : entry));
      return;
    }
    if (typeof entry !== "object" || ancestors.has(entry)) {
      throw workflowServiceError(
        "WORKFLOW_VALUE_INVALID",
        "工作流状态摘要输入必须是无环纯 JSON",
      );
    }
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (
          Object.getPrototypeOf(entry) !== Array.prototype ||
          Reflect.ownKeys(entry).length !== entry.length + 1
        ) {
          throw workflowServiceError(
            "WORKFLOW_VALUE_INVALID",
            "工作流状态摘要输入包含无效数组",
          );
        }
        write("[");
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, `${index}`);
          if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw workflowServiceError(
              "WORKFLOW_VALUE_INVALID",
              "工作流状态摘要输入包含访问器",
            );
          }
          if (index > 0) write(",");
          visit(descriptor.value, depth + 1);
        }
        write("]");
        return;
      }
      const entries = workflowDataEntries(entry);
      if (!entries) {
        throw workflowServiceError(
          "WORKFLOW_VALUE_INVALID",
          "工作流状态摘要输入必须是纯数据对象",
        );
      }
      write("{");
      const ordered = entries.sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      );
      for (let index = 0; index < ordered.length; index += 1) {
        const [key, child] = ordered[index];
        if (["__proto__", "prototype", "constructor"].includes(key)) {
          throw workflowServiceError(
            "WORKFLOW_VALUE_INVALID",
            "工作流状态摘要输入包含危险字段",
          );
        }
        if (index > 0) write(",");
        write(JSON.stringify(key));
        write(":");
        visit(child, depth + 1);
      }
      write("}");
    } finally {
      ancestors.delete(entry);
    }
  };
  visit(value, 0);
  return hash.digest("hex");
}

export function identifiedWorkflowRecord(idName, idPrefix, value) {
  const contentDigest = workflowDigest(value);
  return Object.freeze({
    [idName]: `${idPrefix}-${contentDigest}`,
    contentDigest,
    ...cloneWorkflowValue(value),
  });
}

export function normalizeWorkflowTimestamp(value) {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(Date.parse(timestamp)).toISOString() !== timestamp
  ) {
    throw workflowServiceError(
      "WORKFLOW_CLOCK_INVALID",
      "工作流时钟返回值无效",
      500,
    );
  }
  return timestamp;
}

export function boundedWorkflowString(value, name, maximum = 256) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw workflowServiceError("WORKFLOW_VALUE_INVALID", `${name} 无效`);
  }
  return value;
}

export function normalizeWorkflowTarget(value) {
  if (
    !hasExactWorkflowKeys(value, ["type", "id"]) ||
    !WORKFLOW_TARGET_TYPES.has(value.type)
  ) {
    throw workflowServiceError(
      "WORKFLOW_ROUTE_INVALID",
      "工作流分派目标无效",
      500,
    );
  }
  return {
    type: value.type,
    id: boundedWorkflowString(value.id, "target.id", 128),
  };
}

export function deepFreezeWorkflowValue(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeWorkflowValue(entry);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreezeWorkflowValue(entry);
  }
  return Object.freeze(value);
}

export function prettySerializedWorkflowBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
