/**
 * Serialises mutations issued by this MCP server (FR-03).
 *
 * Multi-command workflows (select, set attribute, store ...) must not interleave with other
 * mutations from the same server, otherwise a concurrent tool call could change the selection
 * between two commands of a workflow. The lock is a simple FIFO promise chain.
 *
 * It only orders this process's own requests. It does not isolate a workflow from another console
 * operator, another MCP server, or anything else talking to the console at the same time.
 */
export class MutationLock {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  /** Run `fn` after every previously queued mutation has finished. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.depth++;
    try {
      return await fn();
    } finally {
      this.depth--;
      release();
    }
  }

  /** True while a mutation holds the lock. */
  get busy(): boolean {
    return this.depth > 0;
  }
}

/**
 * The lock as seen from inside a span that already holds it (SU-12 review round 1): `run` executes at once. A batch
 * takes the real lock once and gives its items a context with this view, so each item's single form, which takes the
 * lock itself, runs inside the batch's span instead of queueing behind it (the lock is not reentrant) and no other
 * mutation from this server can run between two items.
 */
export class HeldLock extends MutationLock {
  override async run<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}
