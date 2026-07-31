export class OperationQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
}
