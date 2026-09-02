/**
 * How much 7-day capacity the fleet still has, counted in whole accounts.
 *
 * A percentage per card answers "is this credential nearly out"; it does not
 * answer "how much room do I have left in total", which is the number you need
 * to decide whether to start something expensive. Summing the remaining
 * fraction of every account-wide weekly limit gives that in the only unit that
 * means anything across a fleet: accounts. 14 Claude seats each 60% spent are
 * 5.6 accounts of headroom, not "60%".
 *
 * Pure and React-free, like the provider `data.ts` modules — tests/weeklyCapacity
 * .test.ts consumes it directly.
 *
 * Two limits of the unit, both deliberate:
 *
 * - It is account-*equivalents by percentage*, not by tokens. A Team seat and a
 *   Max seat both count as 1.0 while their absolute weekly budgets differ, so
 *   the figure tracks "how many typical accounts' worth" rather than a token
 *   count. Mixing tiers is normal here, so the UI says `measured` out loud
 *   rather than implying a precision the input does not have.
 * - It can only count what has been fetched. Quota loading on this page is
 *   click-to-fetch, so most cards are `idle` until the user asks. Unmeasured
 *   credentials are reported as a separate count instead of being treated as
 *   full (which would invent capacity) or empty (which would invent scarcity).
 */

import {
  CLAUDE_ACCOUNT_WIDE_WINDOW_ID,
  CLAUDE_FABLE_WINDOW_ID,
  CODEX_ACCOUNT_WIDE_WINDOW_ID,
  WEEKLY_PERIOD_HOURS,
  normalizeNumberValue,
} from '@/utils/quota';
import { QUOTA_TAB_ORDER } from './constants';
import type { QuotaProviderType } from './providers/types';

/**
 * The row that governs an account's overall weekly serving capacity.
 *
 * Claude and Codex both publish feature- and model-scoped weekly limits beside
 * the account-wide one, and those must not be mistaken for it: a Claude seat
 * whose Fable budget is gone still serves Opus from the same weekly pool, and
 * CPA skips it per-model rather than per-account (the same reason cpa-route's
 * ranking refuses to demote on a scoped limit). Counting a scoped row would
 * subtract capacity that is still there.
 */
const ACCOUNT_WIDE_WEEKLY_ROW_ID: Partial<Record<QuotaProviderType, string>> = {
  claude: CLAUDE_ACCOUNT_WIDE_WINDOW_ID,
  codex: CODEX_ACCOUNT_WIDE_WINDOW_ID,
};

export interface ScopedWeeklyRowSpec {
  /** Window id as the provider's `data.ts` builds it. */
  id: string;
  /** Short model name for the strip; the window's own label repeats "7-day". */
  labelKey: string;
}

/**
 * Model-scoped weekly rows reported as their own figure beside the account-wide
 * one.
 *
 * The account-wide figure deliberately ignores these, so a fleet can read as
 * having plenty of room while the one model you meant to run is out on every
 * seat. Each entry here gets its own "accounts left" under the provider, so
 * that question is answered without opening fourteen cards.
 */
const MODEL_SCOPED_WEEKLY_ROWS: Partial<Record<QuotaProviderType, readonly ScopedWeeklyRowSpec[]>> =
  {
    claude: [{ id: CLAUDE_FABLE_WINDOW_ID, labelKey: 'quota_management.capacity_scope_fable' }],
  };

/** Same tolerance as resetSchedule's: a DST week is 167 or 169 hours. */
const isWeeklyPeriod = (hours: number | null): boolean =>
  hours !== null && Math.abs(hours - WEEKLY_PERIOD_HOURS) <= 1;

const asFraction = (usedPercent: number | null): number | null => {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null;
  // Clamped, not trusted: an over-100 utilization is a real upstream answer on a
  // seat that burst past its limit, and a negative remainder would silently
  // cancel out another account's genuine headroom in the sum.
  return Math.min(1, Math.max(0, 1 - usedPercent / 100));
};

interface WindowLike {
  id?: string;
  usedPercent?: number | null;
  periodHours?: number | null;
}

const weeklyWindows = (rows: readonly WindowLike[]): WindowLike[] =>
  rows.filter((row) => isWeeklyPeriod(normalizeNumberValue(row.periodHours)));

const windowHeadroom = (quota: unknown, id: string): number | null => {
  const rows = (quota as { windows?: WindowLike[] }).windows ?? [];
  // Both conditions matter: the id names the row, and the period check keeps a
  // provider renaming a 5-hour row into that id from being counted as a week's
  // worth of capacity.
  const row = weeklyWindows(rows).find((candidate) => candidate.id === id);
  return row ? asFraction(normalizeNumberValue(row.usedPercent)) : null;
};

const isFetched = (quota: unknown): boolean =>
  (quota as { status?: string } | undefined)?.status === 'success';

/**
 * Least headroom among several weekly rows — used only where the payload does
 * not declare which row is account-wide (Kimi, Antigravity).
 *
 * The binding constraint is the honest reading there: whichever limit runs out
 * first is what stops the credential, and with no scope information there is no
 * basis for the Claude/Codex argument that a spent row leaves other work
 * unaffected. It can understate headroom; it cannot overstate it.
 */
const leastHeadroom = (values: readonly (number | null)[]): number | null => {
  const usable = values.filter((value): value is number => value !== null);
  return usable.length === 0 ? null : Math.min(...usable);
};

/**
 * Remaining share (0..1) of one credential's account-wide 7-day limit, or null
 * when that cannot be known: nothing fetched yet, the fetch failed, or the
 * provider reports no weekly window at all.
 */
export function weeklyHeadroom(provider: QuotaProviderType, quota: unknown): number | null {
  if (!isFetched(quota)) return null;

  const accountWideId = ACCOUNT_WIDE_WEEKLY_ROW_ID[provider];
  if (accountWideId !== undefined) return windowHeadroom(quota, accountWideId);

  if (provider === 'xai') {
    const billing = (
      quota as { billing?: { periodType?: string; usedPercent?: number | null } | null }
    ).billing;
    // Monthly is a spend cap rolling over, not rate-limited capacity coming
    // back, so it is not weekly headroom -- the same exclusion resetSchedule
    // makes when it refuses to rank on a monthly period.
    if (!billing || billing.periodType !== 'weekly') return null;
    return asFraction(normalizeNumberValue(billing.usedPercent));
  }

  if (provider === 'kimi') {
    const rows =
      (quota as { rows?: { limit?: number; used?: number; periodHours?: number | null }[] }).rows ??
      [];
    return leastHeadroom(
      weeklyWindows(rows as WindowLike[]).map((row) => {
        const { limit, used } = row as { limit?: number; used?: number };
        const cap = normalizeNumberValue(limit);
        const spent = normalizeNumberValue(used);
        // Kimi states absolutes rather than a percentage, and a zero cap is not
        // "full" -- it is a row that cannot express headroom.
        if (cap === null || spent === null || cap <= 0) return null;
        return asFraction((spent / cap) * 100);
      })
    );
  }

  if (provider === 'antigravity') {
    const buckets = ((quota as { groups?: { buckets?: WindowLike[] }[] }).groups ?? []).flatMap(
      (group) => group.buckets ?? []
    );
    return leastHeadroom(
      weeklyWindows(buckets).map((bucket) => {
        // Antigravity already reports what is left, so it needs no inversion.
        const remaining = normalizeNumberValue(
          (bucket as { remainingFraction?: number }).remainingFraction
        );
        return remaining === null ? null : Math.min(1, Math.max(0, remaining));
      })
    );
  }

  return null;
}

interface ScopedReading {
  headroom: number;
  /** Whether the credential publishes its own row for this model. */
  ownRow: boolean;
}

/**
 * A seat serves a model only while both its account-wide weekly and that
 * model's own weekly have room, so the figure is the smaller of the two: a seat
 * at 90% account-wide and 0% Fable has a tenth of an account of Fable left, not
 * a whole one. A seat with no row of its own for the model is bounded by the
 * account-wide row alone, so that is its figure — omitting it would hide a
 * seat that can serve the model in full. An unreadable account-wide row makes
 * the model's headroom unknowable too, whatever its own row says.
 */
const readScopedWindow = (
  quota: unknown,
  rowId: string,
  accountWide: number | null
): ScopedReading | null => {
  if (accountWide === null) return null;
  const own = windowHeadroom(quota, rowId);
  return own === null
    ? { headroom: accountWide, ownRow: false }
    : { headroom: Math.min(own, accountWide), ownRow: true };
};

/**
 * Remaining share (0..1) of one credential's weekly budget for a single model,
 * or null when the credential's account-wide headroom cannot be known. Only
 * providers with a declared account-wide row publish scoped rows, so the same
 * window shape is assumed here.
 */
export function scopedWeeklyHeadroom(
  provider: QuotaProviderType,
  quota: unknown,
  rowId: string
): number | null {
  if (ACCOUNT_WIDE_WEEKLY_ROW_ID[provider] === undefined) return null;
  return readScopedWindow(quota, rowId, weeklyHeadroom(provider, quota))?.headroom ?? null;
}

export interface WeeklyCapacityScopedRow extends ScopedWeeklyRowSpec {
  /**
   * Sum of remaining fractions for this model across the provider's measured
   * credentials — the same `measured` as the account-wide figure, since a seat
   * is readable for a model exactly when its account-wide row is.
   */
  accountsFree: number;
  /** Credentials that publish their own weekly row for this model. */
  ownRows: number;
}

export interface WeeklyCapacityRow {
  provider: QuotaProviderType;
  /** Sum of remaining weekly fractions across measured credentials. */
  accountsFree: number;
  /** Credentials whose weekly headroom could be read. */
  measured: number;
  /** Credentials of this provider in the current filter. */
  total: number;
  /**
   * Per-model figures, in MODEL_SCOPED_WEEKLY_ROWS order. A model no fetched
   * credential publishes a row for is omitted: its figure would only repeat the
   * account-wide one.
   */
  scoped: WeeklyCapacityScopedRow[];
}

export interface WeeklyCapacitySummary {
  rows: WeeklyCapacityRow[];
  /** True when at least one credential in scope has no weekly reading yet. */
  partial: boolean;
}

/**
 * Per-provider weekly headroom over exactly the credentials handed in.
 *
 * The caller passes the *filtered* entries, so the summary follows the page's
 * provider tab without knowing that tabs exist. Providers with no credentials
 * in scope are dropped rather than shown as a zero, which would read as "no
 * capacity left" for a provider you simply do not use.
 */
export function summarizeWeeklyCapacity(
  entries: readonly { file: { name: string }; type: QuotaProviderType }[],
  quotaFor: (entry: { file: { name: string }; type: QuotaProviderType }) => unknown
): WeeklyCapacitySummary {
  const byProvider = new Map<QuotaProviderType, WeeklyCapacityRow>();

  for (const entry of entries) {
    const row = byProvider.get(entry.type) ?? {
      provider: entry.type,
      accountsFree: 0,
      measured: 0,
      total: 0,
      scoped: (MODEL_SCOPED_WEEKLY_ROWS[entry.type] ?? []).map((spec) => ({
        ...spec,
        accountsFree: 0,
        ownRows: 0,
      })),
    };
    row.total += 1;
    const quota = quotaFor(entry);
    const headroom = weeklyHeadroom(entry.type, quota);
    if (headroom !== null) {
      row.accountsFree += headroom;
      row.measured += 1;
    }
    for (const scope of row.scoped) {
      const reading = readScopedWindow(quota, scope.id, headroom);
      if (reading !== null) {
        scope.accountsFree += reading.headroom;
        if (reading.ownRow) scope.ownRows += 1;
      }
    }
    byProvider.set(entry.type, row);
  }

  // QUOTA_TAB_ORDER, not insertion order: the strip sits directly under the
  // tabs and reading them in a different order than they are listed makes the
  // two look unrelated.
  const rows = QUOTA_TAB_ORDER.flatMap((provider) => {
    const row = byProvider.get(provider);
    return row ? [{ ...row, scoped: row.scoped.filter((scope) => scope.ownRows > 0) }] : [];
  });

  return { rows, partial: rows.some((row) => row.measured < row.total) };
}
