import { OperationQueue } from "./operation-queue.js";

export class ActionAdmissionGate {
  #queue;

  constructor({ operationQueue = new OperationQueue() } = {}) {
    if (!operationQueue || typeof operationQueue.enqueue !== "function") {
      throw new TypeError("action admission operationQueue is invalid");
    }
    this.#queue = operationQueue;
    Object.freeze(this);
  }

  run(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("action admission operation must be a function");
    }
    return this.#queue.enqueue(() => operation());
  }
}
