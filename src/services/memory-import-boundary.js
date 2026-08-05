export function strictOwnDataEntries(value, error) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw error;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

export function strictExactFields(value, allowed, required, error) {
  const entries = strictOwnDataEntries(value, error);
  const fields = new Map(entries);
  if (
    entries.some(([key]) => !allowed.includes(key)) ||
    required.some((key) => !fields.has(key))
  ) {
    throw error;
  }
  return fields;
}

export function strictDataArray(
  value,
  maximum,
  { minimum = 0, error },
) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw error;
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw error;
    result.push(descriptor.value);
  }
  return result;
}

export function bindMemoryAppendBatch(memoryProducer) {
  if (
    memoryProducer === null ||
    (typeof memoryProducer !== "object" && typeof memoryProducer !== "function")
  ) {
    throw new TypeError("memoryProducer.appendBatch is invalid");
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    memoryProducer,
    "appendBatch",
  );
  if (
    !descriptor ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    throw new TypeError("memoryProducer.appendBatch is invalid");
  }
  const method = descriptor.value;
  return (value) => Reflect.apply(method, memoryProducer, [value]);
}

export function memoryAppendCount(value, expected) {
  const error = new TypeError("memoryProducer.appendBatch result is invalid");
  const fields = new Map(strictOwnDataEntries(value, error));
  if (
    [...fields.keys()].some(
      (key) => !["added", "items", "health"].includes(key),
    ) ||
    !fields.has("added") ||
    !Number.isSafeInteger(fields.get("added")) ||
    fields.get("added") < 0 ||
    fields.get("added") > expected.length
  ) {
    throw error;
  }
  if (!fields.has("items")) return fields.get("added");
  const items = strictDataArray(fields.get("items"), expected.length, { error });
  if (items.length !== expected.length) throw error;
  let created = 0;
  for (let index = 0; index < items.length; index += 1) {
    const receipt = strictExactFields(
      items[index],
      ["recordId", "created"],
      ["recordId", "created"],
      error,
    );
    if (
      receipt.get("recordId") !== expected[index].recordId ||
      typeof receipt.get("created") !== "boolean"
    ) {
      throw error;
    }
    if (receipt.get("created")) created += 1;
  }
  if (created !== fields.get("added")) throw error;
  return fields.get("added");
}
