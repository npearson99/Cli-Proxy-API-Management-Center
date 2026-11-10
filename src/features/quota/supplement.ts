/**
 * Filling in what a card painted from the listing cannot carry, and painting the
 * cards the listing could not.
 *
 * `deriveQuota` paints a card for free from the rate-limit headers CPA already filed,
 * but some of what a card shows exists only upstream: a Claude seat's banked resets
 * are one. `supplementQuota` fetches that alone, through the provider's paced queue,
 * and the answer is merged only into a card that still needs it. A live fetch that
 * landed meanwhile carries its own copy and wins.
 *
 * A card the listing carries nothing for (a seat that has served no request since the
 * proxy started) gets `primeQuota` instead, where the provider has one: a single read
 * that paints the whole card.
 *
 * Either is the card's one free read for the cache generation, so the two share a key.
 * Which one goes is decided when the queue lets the read go, not when it was asked
 * for: a seed that painted the card while it waited turns its prime into the
 * supplement, and a prime that answers after a seed painted the card gives it the
 * resets a supplement would have read. A card is never sent both. A failed prime does
 * not spend the read: a seed that paints the card later can still send its supplement.
 *
 * React-free — tests/claudeResets.test.ts consumes it directly.
 */

import type { TFunction } from 'i18next';
import { getStatusFromError } from '@/utils/quota';
import type { FetchQueue } from './fetchQueue';
import type { QuotaFileEntry } from './logic';
import type { QuotaAdapter, QuotaCardState } from './providers';

/** One per card: its prime and its supplement are the same free read. */
export const freeReadKey = (entry: QuotaFileEntry): string => `${entry.type}:${entry.file.name}`;

/** Nothing painted it: no seed, no fetch, no earlier prime. */
const isUnpainted = (state: QuotaCardState | undefined): boolean =>
  state === undefined || state.status === 'idle';

const wantsPrime = (adapter: QuotaAdapter, state: QuotaCardState | undefined): boolean =>
  adapter.primeQuota !== undefined && isUnpainted(state);

/**
 * Whether `name` still wants its supplement. Asked again when the paced queue lets the
 * request go, since a card can wait seconds there: a live fetch that started meanwhile
 * reads the same data itself, and sending the supplement anyway would be a second
 * upstream request for that seat.
 */
export const stillNeedsSupplement = (
  current: Record<string, QuotaCardState>,
  name: string,
  adapter: QuotaAdapter
): boolean => {
  const state = current[name];
  return (
    adapter.supplementQuota !== undefined &&
    state !== undefined &&
    Boolean(adapter.needsSupplement?.(state))
  );
};

/**
 * The cards of `adapter` that want their free read and have not been asked for it:
 * a prime for a card nothing has painted, a supplement for one a seed painted.
 *
 * Read `current` from the store, not from a render: the seed lands synchronously in
 * the same pass, and a card it just painted needs a supplement at most, never a prime.
 */
export function pendingFreeReads(
  entries: QuotaFileEntry[],
  current: Record<string, QuotaCardState>,
  adapter: QuotaAdapter,
  asked: ReadonlySet<string>
): QuotaFileEntry[] {
  return entries.filter((entry) => {
    if (entry.type !== adapter.type || entry.file.disabled) return false;
    if (asked.has(freeReadKey(entry))) return false;
    return (
      wantsPrime(adapter, current[entry.file.name]) ||
      stillNeedsSupplement(current, entry.file.name, adapter)
    );
  });
}

/**
 * `current` with `primed` landed on `name`, or null when it changes nothing.
 *
 * A card nothing painted takes the whole answer. A card a seed painted while the read
 * was out keeps its windows, which later seeds keep current, and takes what no seed
 * can carry from a successful answer. Anything else (a click, a refresh, a fetched
 * card) painted it with something newer or fuller, and the answer is dropped.
 */
export function mergePrime(
  current: Record<string, QuotaCardState>,
  name: string,
  primed: QuotaCardState,
  adapter: QuotaAdapter
): Record<string, QuotaCardState> | null {
  const state = current[name];
  if (state === undefined || state.status === 'idle') return { ...current, [name]: primed };
  if (primed.status !== 'success' || !adapter.carrySupplement) return null;
  if (!stillNeedsSupplement(current, name, adapter)) return null;
  const carried = adapter.carrySupplement(primed, state);
  return carried === state ? null : { ...current, [name]: carried };
}

/** `current` with the supplement merged into `name`, or null when it no longer applies. */
export function mergeSupplement(
  current: Record<string, QuotaCardState>,
  name: string,
  patch: Partial<QuotaCardState>,
  adapter: QuotaAdapter
): Record<string, QuotaCardState> | null {
  if (!stillNeedsSupplement(current, name, adapter)) return null;
  const state = current[name];
  return { ...current, [name]: { ...state, ...patch, status: state.status } };
}

/**
 * The keys asked for in `generation`, shared by every mount of the page.
 *
 * The paced queue and the store outlive a mount, so a page left and opened again
 * while reads still wait in the queue must not ask for them a second time. A cleared
 * cache starts a new generation, which asks again.
 */
let askedIn: { generation: number; keys: Set<string> } = { generation: -1, keys: new Set() };
export function freeReadsAskedIn(generation: number): Set<string> {
  if (askedIn.generation !== generation) askedIn = { generation, keys: new Set() };
  return askedIn.keys;
}

export interface FreeReadContext {
  adapter: QuotaAdapter;
  t: TFunction;
  queue: FetchQueue;
  /** The keys this generation has asked for; see `freeReadsAskedIn`. */
  asked: Set<string>;
  /** False once the cache generation these reads were asked in has been cleared. */
  isCurrent: () => boolean;
  /** The adapter's cards as the store holds them when each step runs. */
  read: () => Record<string, QuotaCardState>;
  /** Commits an update to the adapter's cards, and only while `isCurrent`. */
  write: (update: (prev: Record<string, QuotaCardState>) => Record<string, QuotaCardState>) => void;
}

type FreeRead =
  { kind: 'prime'; state: QuotaCardState } | { kind: 'supplement'; patch: Partial<QuotaCardState> };

/** The read the card wants now that the queue has let it go, or null when it wants none. */
const sendFreeRead = async (
  entry: QuotaFileEntry,
  ctx: FreeReadContext
): Promise<FreeRead | null> => {
  if (!ctx.isCurrent()) return null;
  const { adapter, t } = ctx;
  const current = ctx.read();
  if (adapter.primeQuota && isUnpainted(current[entry.file.name])) {
    try {
      const data = await adapter.primeQuota(entry.file, t);
      return { kind: 'prime', state: adapter.buildSuccessState(data) };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      // Nobody asked for this read, so a seed may replace what it failed with.
      return {
        kind: 'prime',
        state: { ...adapter.buildErrorState(message, getStatusFromError(err)), primeFailed: true },
      };
    }
  }
  if (adapter.supplementQuota && stillNeedsSupplement(current, entry.file.name, adapter)) {
    return { kind: 'supplement', patch: await adapter.supplementQuota(entry.file, t) };
  }
  return null;
};

const landFreeRead = (
  entry: QuotaFileEntry,
  answer: FreeRead,
  ctx: FreeReadContext
): Promise<unknown> | undefined => {
  const { adapter } = ctx;
  const { name } = entry.file;
  if (answer.kind === 'supplement') {
    ctx.write((prev) => mergeSupplement(prev, name, answer.patch, adapter) ?? prev);
    return undefined;
  }
  const failed = answer.state.primeFailed === true;
  // A failed read does not spend the card's one, so the key is free again before the
  // commit below re-renders the page and asks what each card still wants.
  if (failed) ctx.asked.delete(freeReadKey(entry));
  ctx.write((prev) => mergePrime(prev, name, answer.state, adapter) ?? prev);
  if (!failed) return undefined;
  // A failure dropped on a card a seed painted while it was out leaves the store as it
  // was, so nothing re-renders to ask for that card's supplement: it is asked for here.
  return Promise.all(scheduleFreeReads([entry], ctx));
};

/**
 * Asks the paced queue for every free read `entries` still want, once per card per
 * generation. Resolves when each read has landed or been dropped, for the tests.
 */
export function scheduleFreeReads(
  entries: QuotaFileEntry[],
  ctx: FreeReadContext
): Promise<unknown>[] {
  if (!ctx.isCurrent()) return [];
  return pendingFreeReads(entries, ctx.read(), ctx.adapter, ctx.asked).map((entry) => {
    ctx.asked.add(freeReadKey(entry));
    return (
      ctx.queue
        .run(() => sendFreeRead(entry, ctx))
        .then((answer) => (answer ? landFreeRead(entry, answer, ctx) : undefined))
        // A supplement reports its own failure in the patch; a throw leaves the card as is.
        .catch(() => undefined)
    );
  });
}
