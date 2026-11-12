/**
 * The Claude fleet's banked resets in one list, beside the per-seat cards.
 *
 * Each card lists its own seat's grants; deciding when to spend one is a question about
 * all of them: how many of each are left, how many could go now, and which run out
 * first. Grants with the same id are one entry (Anthropic shapes one grant per seat: the
 * November 2026 full limit reset is `full` on a seat with a 5-hour window and `weekly`
 * on the rest), and every Fable reset is one entry, since they return the same thing.
 *
 * A disabled seat's grants are listed (they are still banked), but none is usable: the
 * page will not spend a reset on a seat CPA routes nothing to.
 *
 * React-free — tests/bankedResets.test.ts consumes it directly.
 */

import type { ClaudeResetInfo } from '@/types';
import { isClaimableClaudeGrant, isDisabledAuthFile, parseIsoToMs } from '@/utils/quota';
import type { QuotaProviderType } from './providers/types';

/**
 * The Fable group's key. A colon is outside the grant-id alphabet (CLAUDE_RESET_GRANT_ID),
 * so no grant id can land in the Fable group, nor a Fable reset in a grant's own.
 */
export const BANKED_FABLE_KEY = ':fable';

export interface BankedResetGroup {
  /** BANKED_FABLE_KEY for every Fable reset, otherwise the grant id. */
  key: string;
  fable: boolean;
  /** Anthropic's label for a grant; empty for the Fable group, which the page names. */
  label: string;
  /** Resets left across the seats that were read. */
  left: number;
  /** Seats holding at least one. */
  seats: number;
  /** Resets this page would spend now (usable, giving something back, on an enabled seat). */
  usable: number;
  /** The soonest use-by date among them. */
  endsAtMs: number | null;
}

export interface BankedResetSummary {
  groups: BankedResetGroup[];
  /**
   * Claude seats whose reset status was read (ineligible ones included: they hold
   * none), and all Claude seats in view.
   */
  read: number;
  total: number;
}

type Entry = { file: { name: string; disabled?: unknown }; type: QuotaProviderType };

export function summarizeBankedResets<E extends Entry>(
  entries: readonly E[],
  quotaFor: (entry: E) => unknown
): BankedResetSummary {
  const groups = new Map<string, BankedResetGroup & { holders: Set<string> }>();
  let read = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== 'claude') continue;
    total += 1;
    const info = (quotaFor(entry) as { resets?: ClaudeResetInfo } | undefined)?.resets;
    if (!info || info.error) continue;
    // An ineligible seat was read and holds nothing; it is not one still to be counted.
    read += 1;
    if (!info.eligible) continue;
    const disabled = isDisabledAuthFile(entry.file);
    for (const grant of info.grants) {
      if (grant.resetsLeft <= 0) continue;
      const key = grant.givesBackWeekly ? BANKED_FABLE_KEY : grant.id;
      const group = groups.get(key) ?? {
        key,
        fable: grant.givesBackWeekly,
        label: grant.givesBackWeekly ? '' : grant.label,
        left: 0,
        seats: 0,
        usable: 0,
        endsAtMs: null,
        holders: new Set<string>(),
      };
      group.left += grant.resetsLeft;
      group.holders.add(entry.file.name);
      if (!disabled && isClaimableClaudeGrant(grant, info)) group.usable += grant.resetsLeft;
      const endsAtMs = parseIsoToMs(grant.endsAt);
      if (endsAtMs !== null && (group.endsAtMs === null || endsAtMs < group.endsAtMs)) {
        group.endsAtMs = endsAtMs;
      }
      if (!group.label && !group.fable) group.label = grant.label;
      groups.set(key, group);
    }
  }
  const sorted = [...groups.values()]
    .map(({ holders, ...group }) => ({ ...group, seats: holders.size }))
    // Soonest use-by first: that is the one to spend first. Undated last.
    .sort(
      (a, b) =>
        (a.endsAtMs ?? Number.POSITIVE_INFINITY) - (b.endsAtMs ?? Number.POSITIVE_INFINITY) ||
        a.key.localeCompare(b.key)
    );
  return { groups: sorted, read, total };
}
