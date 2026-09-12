/**
 * The gate every live quota fetch passes through.
 *
 * A provider's usage endpoint is rate limited, and the page asks about a whole
 * page of credentials at once. Fanned out with `Promise.all` that is one burst
 * of N simultaneous requests from a single address, which is exactly the shape a
 * limiter exists to reject — so the grid came back a row of 429s, and the seat
 * that did answer had told us nothing the listing had not.
 *
 * Two limits, because they stop different things: `concurrency` bounds how many
 * are open at once, `minGapMs` bounds how closely their starts are spaced. A
 * limiter counting requests per interval is unmoved by concurrency alone.
 *
 * The defaults are the envelope cpa-route has been driving this same endpoint
 * with, unthrottled, for months: two at a time, 400 ms apart.
 *
 * React-free — tests/quotaFetchQueue.test.ts consumes it directly.
 */

export const QUOTA_FETCH_CONCURRENCY = 2;
export const QUOTA_FETCH_MIN_GAP_MS = 400;

export interface FetchQueueOptions {
  concurrency?: number;
  minGapMs?: number;
  /** Injected by the tests; production uses the real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FetchQueue {
  run: <T>(task: () => Promise<T>) => Promise<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFetchQueue(options: FetchQueueOptions = {}): FetchQueue {
  const concurrency = Math.max(1, options.concurrency ?? QUOTA_FETCH_CONCURRENCY);
  const minGapMs = Math.max(0, options.minGapMs ?? QUOTA_FETCH_MIN_GAP_MS);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());

  let active = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  const waiting: (() => void)[] = [];

  // The slot is handed to the next waiter rather than freed and re-taken: a
  // decrement here would be visible to anyone calling run() before the waiter's
  // microtask resumed, and both would then be holding the same slot.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const acquire = async () => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    // The start instant is reserved before the wait rather than stamped after
    // it. Measuring afterwards spaces each task only from the last one that
    // *began*, so a slot released while another task is waiting out the gap
    // hands its successor the same wake-up instant: both then go on the wire
    // together, which is the burst the gap exists to prevent. Reserving makes
    // the slots take distinct starts, and it stays inside the slot so a task
    // waiting out its gap still counts as running.
    const startAt = Math.max(now(), lastStart + minGapMs);
    lastStart = startAt;
    const wait = startAt - now();
    if (wait > 0) await sleep(wait);
  };

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

const queues = new Map<string, FetchQueue>();

/**
 * The queue a provider's live fetches actually run through.
 *
 * One per provider, because the limiter being respected is the upstream's and
 * each provider has its own — spending Claude's budget on Codex requests would
 * slow both for nothing. Module-scoped within a provider, because a per-card
 * click and a refresh-all have to share one budget, or clicking four cards while
 * a batch runs puts the burst straight back.
 */
export function quotaFetchQueueFor(provider: string): FetchQueue {
  const existing = queues.get(provider);
  if (existing) return existing;
  const created = createFetchQueue();
  queues.set(provider, created);
  return created;
}
