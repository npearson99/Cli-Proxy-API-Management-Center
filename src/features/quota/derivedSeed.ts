/**
 * Seeding the quota grid from what the auth-file listing already carries.
 *
 * The page used to open with every card `idle` and paint only what you asked it
 * to fetch, so the honest way to read the fleet was to press refresh — which
 * fired one upstream usage request per credential, all at once, and collected a
 * row of 429s for it. The listing already carries the same measurement (CPA
 * files the rate-limit headers off requests the fleet was making anyway), so the
 * grid can be full before anything is fetched at all.
 *
 * Seeding never overwrites a live answer. It fills a card that has nothing, and
 * it replaces an earlier seed the listing has since improved on; a `loading`,
 * an `error`, or a fetched `success` is left exactly where it is.
 *
 * React-free — tests/quotaDerivedSeed.test.ts consumes it directly.
 */

import type { TFunction } from 'i18next';
import type { QuotaFileEntry } from './logic';
import type { QuotaAdapter, QuotaCardState } from './providers';

/** A card built by `deriveQuota` rather than fetched; see QuotaCardState.observedAtMs. */
const isSeeded = (state: QuotaCardState | undefined): boolean =>
  state?.observedAtMs !== undefined;

const supersedes = (next: QuotaCardState, current: QuotaCardState | undefined): boolean => {
  if (!current || current.status === 'idle') return true;
  // A fetched card outranks the listing even when the listing is newer: it carries
  // the plan tier and the extra-usage block that the headers cannot report.
  if (!isSeeded(current)) return false;
  return (next.observedAtMs ?? 0) > (current.observedAtMs ?? 0);
};

/**
 * The cards this adapter can fill for free, or null when it would change nothing.
 *
 * Returning null rather than an equal copy is what keeps the caller's `setQuota`
 * from re-rendering the grid on every listing refresh.
 */
export function seedDerivedQuota(
  entries: QuotaFileEntry[],
  current: Record<string, QuotaCardState>,
  adapter: QuotaAdapter,
  t: TFunction
): Record<string, QuotaCardState> | null {
  if (!adapter.deriveQuota) return null;

  let next: Record<string, QuotaCardState> | null = null;
  for (const { file, type } of entries) {
    if (type !== adapter.type) continue;
    const derived = adapter.deriveQuota(file, t);
    if (!derived) continue;
    if (!supersedes(derived, current[file.name])) continue;
    next = next ?? { ...current };
    next[file.name] = derived;
  }
  return next;
}
