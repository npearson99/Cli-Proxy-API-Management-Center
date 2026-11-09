/**
 * Filling in what a card painted from the listing cannot carry.
 *
 * `deriveQuota` paints a card for free from the rate-limit headers CPA already filed,
 * but some of what a card shows exists only upstream: a Claude seat's banked resets
 * are one. `supplementQuota` fetches that alone, once per card per cache generation,
 * through the provider's paced queue, and the answer is merged only into a card that
 * still needs it. A live fetch that landed meanwhile carries its own copy and wins.
 *
 * React-free — tests/claudeResets.test.ts consumes it directly.
 */

import type { QuotaFileEntry } from './logic';
import type { QuotaAdapter, QuotaCardState } from './providers';

export const supplementKey = (entry: QuotaFileEntry): string => `${entry.type}:${entry.file.name}`;

/** The cards of `adapter` that need a supplement and have not been asked for one. */
export function pendingSupplements(
  entries: QuotaFileEntry[],
  current: Record<string, QuotaCardState>,
  adapter: QuotaAdapter,
  requested: ReadonlySet<string>
): QuotaFileEntry[] {
  const { supplementQuota, needsSupplement } = adapter;
  if (!supplementQuota || !needsSupplement) return [];
  return entries.filter((entry) => {
    if (entry.type !== adapter.type || entry.file.disabled) return false;
    if (requested.has(supplementKey(entry))) return false;
    const state = current[entry.file.name];
    return state !== undefined && needsSupplement(state);
  });
}

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
  return state !== undefined && Boolean(adapter.needsSupplement?.(state));
};

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
