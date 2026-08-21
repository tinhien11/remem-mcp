/**
 * WriteQueue — async mutex for serializing all write operations.
 * Prevents "database is locked" errors when multiple hooks fire concurrently.
 *
 * All write operations (put, putVector, recordAccess, linkCaptures, etc.)
 * go through this queue. Reads are unaffected (WAL mode allows concurrent reads).
 *
 * Adapted from ai-memory's single-writer actor pattern.
 */

type WriteTask<T> = () => T | Promise<T>;

export class WriteQueue {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;

  /**
   * Enqueue a write task. All tasks are serialized — the next task
   * only starts after the previous one completes (success or failure).
   */
  async enqueue<T>(task: WriteTask<T>): Promise<T> {
    this.pendingCount++;
    const result = this.queue.then(async () => {
      try {
        return await task();
      } finally {
        this.pendingCount--;
      }
    });
    // Update the queue chain, but don't let one failure block subsequent tasks
    this.queue = result.catch(() => {});
    return result as Promise<T>;
  }

  /** Number of tasks currently waiting/running. */
  get pending(): number {
    return this.pendingCount;
  }

  /** Wait for all pending tasks to complete. */
  async drain(): Promise<void> {
    while (this.pendingCount > 0) {
      await this.queue;
    }
  }
}
