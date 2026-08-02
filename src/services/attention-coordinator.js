function assertReadPort(value, name) {
  if (value !== null && value !== undefined && typeof value.next !== "function") {
    throw new TypeError(`${name}.next must be a function`);
  }
  return value || null;
}

function emptyProjection(externalQueueRevision, externalEnabled) {
  return {
    available: false,
    source: null,
    pendingCount: 0,
    externalEnabled,
    externalQueueRevision,
    item: null,
  };
}

export class AttentionCoordinator {
  #externalNext;
  #internalNext;
  #externalEnabled;

  constructor({ externalQueue = null, internalInbox = null } = {}) {
    const external = assertReadPort(externalQueue, "externalQueue");
    const internal = assertReadPort(internalInbox, "internalInbox");
    this.#externalEnabled = Boolean(external);
    this.#externalNext = external ? external.next.bind(external) : null;
    this.#internalNext = internal ? internal.next.bind(internal) : null;
    Object.freeze(this);
  }

  async next() {
    let externalQueueRevision = 0;
    if (this.#externalNext) {
      const external = await this.#externalNext();
      externalQueueRevision = Number.isSafeInteger(external?.queueRevision)
        ? external.queueRevision
        : 0;
      if (external?.item) {
        return structuredClone({
          available: true,
          source: "external_confirmation",
          pendingCount: Number.isSafeInteger(external.pendingCount)
            ? external.pendingCount
            : 1,
          externalEnabled: true,
          externalQueueRevision,
          item: external.item,
        });
      }
    }

    const internal = this.#internalNext
      ? await this.#internalNext()
      : null;
    if (!internal) {
      return emptyProjection(externalQueueRevision, this.#externalEnabled);
    }
    return structuredClone({
      available: true,
      source: "internal_request",
      pendingCount: 1,
      externalEnabled: this.#externalEnabled,
      externalQueueRevision,
      item: internal,
    });
  }
}
