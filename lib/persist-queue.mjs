export function createPersistQueue(writeSnapshot) {
  let tail = Promise.resolve();

  return function enqueuePersist(snapshot) {
    const write = tail.then(() => writeSnapshot(snapshot));
    // Keep the queue usable after a failed write while preserving the error for
    // the caller that initiated that write.
    tail = write.catch(() => {});
    return write;
  };
}
