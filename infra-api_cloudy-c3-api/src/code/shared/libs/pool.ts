/**
 * Async worker pool with configurable concurrency.
 * Limits parallel operations to avoid overwhelming SSH connections / CPU.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_CONCURRENCY = 6;

/**
 * Marks work as "bulk" (a fan-out route like /v2/up/all-services).
 *
 * Why: every probe funnels through the shared sshPool. One fan-out enqueues far
 * more tasks than the pool has slots, so a single-target request arriving mid
 * fan-out sat behind the whole backlog and timed out — the API looked down while
 * it was merely queued (healthy routes flapping 200 -> timeout -> 200).
 *
 * AsyncLocalStorage rather than a parameter because the queueing happens deep
 * inside up()/health()/profile(), several layers below the route that knows it's
 * a fan-out; the store propagates across awaits without threading a flag through
 * every signature.
 */
const bulkScope = new AsyncLocalStorage<boolean>();

/** Run `fn` with everything it awaits marked as low-priority bulk work. */
export function runAsBulk<T>(fn: () => Promise<T>): Promise<T> {
  return bulkScope.run(true, fn);
}

export class Pool {
  private running = 0;
  /** Interactive waiters — always drained before `bulkQueue`. */
  private queue: (() => void)[] = [];
  private bulkQueue: (() => void)[] = [];

  constructor(private concurrency = DEFAULT_CONCURRENCY) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      const bulk = bulkScope.getStore() === true;
      await new Promise<void>((resolve) => {
        (bulk ? this.bulkQueue : this.queue).push(resolve);
      });
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      // Interactive first: a fan-out already in flight keeps making progress,
      // but it can never starve a single-target request behind its backlog.
      const next = this.queue.shift() ?? this.bulkQueue.shift();
      if (next) next();
    }
  }

  async map<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item) => this.run(() => fn(item))));
  }

  async settle<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
  ): Promise<PromiseSettledResult<R>[]> {
    return Promise.allSettled(items.map((item) => this.run(() => fn(item))));
  }
}

/** Shared pool for SSH operations — 6 concurrent max */
export const sshPool = new Pool(DEFAULT_CONCURRENCY);

/** Shared pool for HTTP/curl probes — 6 concurrent max */
export const httpPool = new Pool(DEFAULT_CONCURRENCY);
