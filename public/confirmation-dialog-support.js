const MAX_DEFERRED_CONFIRMATION_KEYS = 32;
const MAX_DEFERRED_CONFIRMATION_ID_LENGTH = 128;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXTERNAL_CONFIRMATION_ID =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const INTERNAL_CONFIRMATION_ID = /^attention-[a-f0-9]{64}$/;
const deferredConfirmationKinds = Object.freeze({
  external: Object.freeze({ binding: SHA256, id: EXTERNAL_CONFIRMATION_ID }),
  internal: Object.freeze({ binding: SHA256, id: INTERNAL_CONFIRMATION_ID }),
  responsibility: Object.freeze({ binding: SHA1 }),
  review: Object.freeze({ binding: SHA1 }),
});

function isDeferredConfirmationKey(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("\u0000");
  if (parts.length !== 3) return false;
  const [kind, id, binding] = parts;
  if (!Object.hasOwn(deferredConfirmationKinds, kind)) return false;
  const definition = deferredConfirmationKinds[kind];
  return (
    id.length > 0 &&
    id.length <= MAX_DEFERRED_CONFIRMATION_ID_LENGTH &&
    (!definition.id || definition.id.test(id)) &&
    definition.binding.test(binding)
  );
}

export function parseDeferredConfirmationKeys(serialized) {
  let keys;
  try {
    keys = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (
    !Array.isArray(keys) ||
    keys.length > MAX_DEFERRED_CONFIRMATION_KEYS ||
    keys.some((key) => !isDeferredConfirmationKey(key))
  ) {
    return [];
  }
  return [...new Set(keys)];
}

function storableDeferredConfirmationKeys(keys) {
  if (keys === null || keys === undefined || !keys[Symbol.iterator]) return [];
  const stored = [];
  const seen = new Set();
  for (const key of keys) {
    if (!isDeferredConfirmationKey(key) || seen.has(key)) continue;
    seen.add(key);
    stored.push(key);
    if (stored.length === MAX_DEFERRED_CONFIRMATION_KEYS) break;
  }
  return stored;
}

export function createSessionDeferredConfirmationStore({
  getStorage,
  storageKey,
}) {
  function withStorage(operation, fallback) {
    try {
      const storage = getStorage();
      return storage ? operation(storage) : fallback;
    } catch {
      return fallback;
    }
  }

  return Object.freeze({
    load() {
      return withStorage(
        (storage) => parseDeferredConfirmationKeys(storage.getItem(storageKey)),
        [],
      );
    },

    save(keys) {
      return withStorage(
        (storage) => {
          storage.setItem(
            storageKey,
            JSON.stringify(storableDeferredConfirmationKeys(keys)),
          );
          return true;
        },
        false,
      );
    },

    clear() {
      return withStorage(
        (storage) => {
          storage.removeItem(storageKey);
          return true;
        },
        false,
      );
    },
  });
}

export function createConfirmationDialogOwnership() {
  let nextOwner = 0;
  let activeOwner = null;
  let submissionOwner = null;

  function isOwner(owner) {
    return Number.isSafeInteger(owner) && owner > 0;
  }

  function ownsSubmission(owner) {
    return (
      isOwner(owner) &&
      activeOwner === owner &&
      submissionOwner === owner
    );
  }

  function close(owner) {
    if (!isOwner(owner) || activeOwner !== owner) return false;
    activeOwner = null;
    if (submissionOwner === owner) submissionOwner = null;
    return true;
  }

  return Object.freeze({
    open() {
      activeOwner = ++nextOwner;
      submissionOwner = null;
      return activeOwner;
    },

    current() {
      return activeOwner;
    },

    ownsSubmission,

    beginSubmission(owner) {
      if (
        !isOwner(owner) ||
        activeOwner !== owner ||
        submissionOwner !== null
      ) {
        return false;
      }
      submissionOwner = owner;
      return true;
    },

    finishSubmission(owner) {
      if (!ownsSubmission(owner)) return false;
      submissionOwner = null;
      return true;
    },

    close,

    handleCloseEvent({ dialogOpen } = {}) {
      if (dialogOpen !== false || !isOwner(activeOwner)) return false;
      return close(activeOwner);
    },
  });
}
