/**
 * The Claude fleet's banked resets in one list, beside the per-seat cards.
 *
 * Each card lists its own seat's grants; deciding when to spend one is a question about
 * all of them: how many of each are left, how many could go now, and which run out
 * first. Grants with the same id are one entry (Anthropic shapes one grant per seat: the
 * November 2026 full limit reset is `full` on a seat with a 5-hour window and `weekly`
 * on the rest), and every Fable reset is one entry, since they return the same thing.
 *
 * React-free — tests/bankedResets.test.ts consumes it directly.
 */

import type { ClaudeResetInfo } from '@/types';
import { isClaimableClaudeGrant, parseIsoToMs } from '@/utils/quota';
import type { QuotaProviderType } from './providers/types';

export interface BankedResetGroup {
  /** `fable` for every Fable reset, otherwise the grant id. */
  key: string;
  fable: boolean;
  /** Anthropic's label for a grant; empty for the Fable group, which the page names. */
  label: string;
  /** Resets left across the seats that were read. */
  left: number;
  /** Seats holding at least one. */
  seats: number;
  /** Resets this page would spend now (usable, and giving something back). */
  usable: number;
  /** The soonest use-by date among them. */
  endsAtMs: number | null;
}

export interface BankedResetSummary {
  groups: BankedResetGroup[];
  /** Claude seats whose reset status was read, and all Claude seats in view. */
  read: number;
  total: number;
}

type Entry = { file: { name: string }; type: QuotaProviderType };

export function summarizeBankedResets(
  entries: readonly Entry[],
  quotaFor: (entry: Entry) => unknown
): BankedResetSummary {
  const groups = new Map<string, BankedResetGroup & { holders: Set<string> }>();
  let read = 0;
  let total = 0;
  for (const entry of entries) {
    if (entry.type !== 'claude') continue;
    total += 1;
    const info = (quotaFor(entry) as { resets?: ClaudeResetInfo } | undefined)?.resets;
    if (!info || info.error || !info.eligible) continue;
    read += 1;
    for (const grant of info.grants) {
      if (grant.resetsLeft <= 0) continue;
      const key = grant.givesBackWeekly ? 'fable' : grant.id;
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
      if (isClaimableClaudeGrant(grant, info)) group.usable += grant.resetsLeft;
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
