/**
 * When each row on a quota card gets its capacity back.
 *
 * A card lists several limits at once — a 5-hour window, a weekly one, a
 * handful of manual reset credits — and the only one that governs what you can
 * do next is whichever recovers first. Reading five timestamps to find it is
 * the work this moves off the user.
 *
 * Pure and React-free: `nowMs` is passed in, the quota state is read
 * structurally, and nothing here imports the store.
 *
 * Related but deliberately separate from `buildTimelineLane` in
 * quotaTimelineModel.ts. That reads the same five shapes to pick *one* window
 * per credential — the longest that fits the visible span, because a fortnight
 * drawn from 5-hour windows is 67 unreadable slivers. This wants *every*
 * instant and the *soonest* of them. Same inputs, opposite selection rules;
 * merging them would mean one function with a mode flag and two sets of pinned
 * tests fighting each other.
 */

import { WEEKLY_PERIOD_HOURS, normalizeNumberValue, parseIsoToMs } from '@/utils/quota';
import { HOUR_MS } from '@/utils/time/durations';
import type { QuotaSortMode } from './constants';
import type { QuotaProviderType } from './providers/types';

export { WEEKLY_PERIOD_HOURS };

export interface QuotaRowInstant {
  /** Matches the React key of the row it belongs to. */
  rowId: string;
  atMs: number;
  kind: 'window' | 'credit';
  /**
   * True when this instant is a 7-day limit reset. Decided at collection,
   * where provider context still exists: stated hours near a week for window
   * rows, by declaration for the xAI billing summary. Credits are never
   * weekly, and neither are windows from legacy payloads that state no period.
   */
  weekly: boolean;
}

/**
 * Row identity for a Codex reset credit.
 *
 * Exported so `CodexQuotaBody` can use one expression for both its React key
 * and its highlight comparison. Two copies of `credit.id || fallback` that
 * drift apart would put the emphasis on the wrong row, which is worse than no
 * emphasis at all.
 */
export function resetCreditRowId(
  credit: { id?: string; expiresAt?: string },
  index: number
): string {
  return credit.id || `${credit.expiresAt}-${index}`;
}

/* Structural shapes — the five provider states disagree about where a window
   lives, so each is read on its own terms rather than through a lossy
   normalized model. */

interface WindowLike {
  id?: string;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface ResetCreditLike {
  id?: string;
  status?: string;
  expiresAt?: string;
}

/** Row id used by the xAI weekly limit, which has no id of its own. */
export const XAI_WEEKLY_ROW_ID = 'xai:weekly';

/**
 * Tolerant on purpose: Claude and Codex state 168 exactly, but derived spans
 * wobble, and a wall-clock week that crosses a DST change is exactly 167 or
 * 169 hours — so a full hour of drift still counts as a week.
 */
const isWeeklyPeriod = (hours: number | null): boolean =>
  hours !== null && Math.abs(hours - WEEKLY_PERIOD_HOURS) <= 1;

const isUsableMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const collectRows = (rows: readonly WindowLike[], fallbackPrefix: string): QuotaRowInstant[] =>
  rows
    .map((row, index): QuotaRowInstant | null =>
      isUsableMs(row.resetAtMs)
        ? {
            rowId: row.id || `${fallbackPrefix}-${index}`,
            atMs: row.resetAtMs,
            kind: 'window',
            weekly: isWeeklyPeriod(normalizeNumberValue(row.periodHours)),
          }
        : null
    )
    .filter((instant): instant is QuotaRowInstant => instant !== null);

/**
 * Every recovery instant on one credential, tagged with the row it belongs to.
 *
 * Only genuine capacity-return events are collected. The Codex subscription
 * renewal date and xAI's monthly billing rollover are excluded: a spend cap
 * turning over is not a rate limit lifting, and ranking cards by it would
 * answer a different question than the one being asked. Both still render
 * their own countdown.
 */
export function collectQuotaRowInstants(
  provider: QuotaProviderType,
  quota: unknown
): QuotaRowInstant[] {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return [];

  if (provider === 'claude' || provider === 'codex') {
    const windows = collectRows((quota as { windows?: WindowLike[] }).windows ?? [], 'window');
    if (provider !== 'codex') return windows;

    const credits = (
      (quota as { rateLimitResetCredits?: ResetCreditLike[] }).rateLimitResetCredits ?? []
    )
      .map((credit, index): QuotaRowInstant | null => {
        if (credit.status !== 'available') return null;
        const atMs = parseIsoToMs(credit.expiresAt);
        return atMs === null
          ? null
          : { rowId: resetCreditRowId(credit, index), atMs, kind: 'credit', weekly: false };
      })
      .filter((instant): instant is QuotaRowInstant => instant !== null);

    return [...windows, ...credits];
  }

  if (provider === 'xai') {
    const billing = (
      quota as { billing?: { periodType?: string; resetAtMs?: number | null } | null }
    ).billing;
    if (!billing || billing.periodType !== 'weekly' || !isUsableMs(billing.resetAtMs)) return [];
    return [
      {
        rowId: XAI_WEEKLY_ROW_ID,
        atMs: billing.resetAtMs,
        kind: 'window',
        // Weekly by declaration, not by measured span: the summary's derived
        // hours legitimately stray from 168 (a partial first period, monthly
        // bounds standing in for missing weekly ones), and the card presents
        // this instant as the weekly reset either way.
        weekly: true,
      },
    ];
  }

  if (provider === 'antigravity') {
    // Buckets live inside groups; the grouping is a display concern here.
    const buckets = ((quota as { groups?: { buckets?: WindowLike[] }[] }).groups ?? []).flatMap(
      (group) => group.buckets ?? []
    );
    return collectRows(buckets, 'bucket');
  }

  if (provider === 'kimi') {
    return collectRows((quota as { rows?: WindowLike[] }).rows ?? [], 'row');
  }

  return [];
}

/**
 * The row that recovers first, or null when nothing is still pending.
 *
 * Instants at or before `now` are ignored — a window that already reset must
 * not keep the emphasis. Ties break on row id so the choice is deterministic
 * rather than dependent on collection order.
 */
export function pickSoonestRowId(
  instants: readonly QuotaRowInstant[],
  nowMs: number
): string | null {
  let best: QuotaRowInstant | null = null;
  for (const instant of instants) {
    if (instant.atMs <= nowMs) continue;
    if (
      best === null ||
      instant.atMs < best.atMs ||
      (instant.atMs === best.atMs && instant.rowId < best.rowId)
    ) {
      best = instant;
    }
  }
  return best?.rowId ?? null;
}

/**
 * The recovery row whose countdown should receive warning emphasis.
 *
 * A nearest reset that is still hours or days away is informational, not
 * urgent. Only the final hour is highlighted, and exactly one hour remaining
 * is deliberately excluded to match the "less than one hour" UI rule.
 */
export function pickUrgentRowId(
  instants: readonly QuotaRowInstant[],
  nowMs: number
): string | null {
  return pickSoonestRowId(
    instants.filter((instant) => instant.atMs - nowMs > 0 && instant.atMs - nowMs < HOUR_MS),
    nowMs
  );
}

/** Soonest instant still in the future, or null when nothing is pending. */
const soonestUpcomingMs = (instants: readonly QuotaRowInstant[], nowMs: number): number | null => {
  let best: number | null = null;
  for (const instant of instants) {
    if (instant.atMs <= nowMs) continue;
    if (best === null || instant.atMs < best) best = instant.atMs;
  }
  return best;
};

/**
 * Soonest upcoming recovery instant for a whole credential — the sort key for
 * "soonest recovery first". Null when nothing is loaded or nothing is pending.
 */
export function nextRecoveryMs(
  provider: QuotaProviderType,
  quota: unknown,
  nowMs: number
): number | null {
  return soonestUpcomingMs(collectQuotaRowInstants(provider, quota), nowMs);
}

/**
 * Soonest upcoming reset of a 7-day window — the sort key for "soonest weekly
 * reset first". The 5-hour windows and reset credits that dominate
 * `nextRecoveryMs` are ignored. Every weekly window on the card competes,
 * including feature-scoped ones (Codex code review, per-model limits), so the
 * key is the card's earliest 7-day reset rather than specifically the
 * account-wide one. Null when the credential reports no weekly window
 * (unloaded, failed, or a provider without one), which lets the sort sink it.
 */
export function weeklyRecoveryMs(
  provider: QuotaProviderType,
  quota: unknown,
  nowMs: number
): number | null {
  return soonestUpcomingMs(
    collectQuotaRowInstants(provider, quota).filter((instant) => instant.weekly),
    nowMs
  );
}

export type QuotaSortKeyResolver = (
  provider: QuotaProviderType,
  quota: unknown,
  nowMs: number
) => number | null;

/**
 * Sort-key resolver for each mode; null keeps the provider-grouped order.
 * Exhaustive over QuotaSortMode so adding a mode fails the build here instead
 * of silently sorting by whatever fallback the page happened to reach for.
 */
export const QUOTA_SORT_KEY_RESOLVERS: Record<QuotaSortMode, QuotaSortKeyResolver | null> = {
  weekly: weeklyRecoveryMs,
  default: null,
  soonest: nextRecoveryMs,
};
