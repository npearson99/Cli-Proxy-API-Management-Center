/**
 * 7-day headroom counted in accounts, per provider.
 *
 * The unit is account-equivalents: sum the remaining share of every
 * account-wide weekly limit. What this suite mostly pins is which rows are
 * allowed to contribute, because the interesting failures all overstate or
 * understate capacity rather than crashing.
 */

import { describe, expect, test } from 'bun:test';
import {
  summarizeWeeklyCapacity,
  weeklyHeadroom,
  type WeeklyCapacityRow,
} from '@/features/quota/weeklyCapacity';
import { WEEKLY_PERIOD_HOURS } from '@/utils/quota';
import type { QuotaProviderType } from '@/features/quota/providers/types';

const WEEK = WEEKLY_PERIOD_HOURS;

const claude = (windows: unknown[], status = 'success') => ({ status, windows });
const codex = (windows: unknown[]) => ({ status: 'success', windows });

describe('weeklyHeadroom — Claude', () => {
  test('reads the account-wide seven-day row', () => {
    expect(
      weeklyHeadroom(
        'claude',
        claude([
          { id: 'five-hour', usedPercent: 90, periodHours: 5 },
          { id: 'seven-day', usedPercent: 60, periodHours: WEEK },
        ])
      )
    ).toBeCloseTo(0.4, 10);
  });

  test('a spent model-scoped row does not subtract account capacity', () => {
    // A seat whose Fable weekly is gone still serves Opus from the same weekly
    // pool; CPA skips it per model, not per account.
    const headroom = weeklyHeadroom(
      'claude',
      claude([
        { id: 'seven-day', usedPercent: 60, periodHours: WEEK },
        { id: 'seven-day-fable', usedPercent: 100, periodHours: WEEK },
        { id: 'seven-day-opus', usedPercent: 100, periodHours: WEEK },
      ])
    );
    expect(headroom).toBeCloseTo(0.4, 10);
  });

  test('a scoped row alone is not mistaken for the account-wide one', () => {
    expect(
      weeklyHeadroom('claude', claude([{ id: 'seven-day-opus', usedPercent: 10, periodHours: WEEK }]))
    ).toBeNull();
  });

  test('the id alone is not enough — the period must be a week', () => {
    expect(
      weeklyHeadroom('claude', claude([{ id: 'seven-day', usedPercent: 10, periodHours: 5 }]))
    ).toBeNull();
  });

  test('an unloaded or failed card contributes nothing', () => {
    const row = [{ id: 'seven-day', usedPercent: 10, periodHours: WEEK }];
    expect(weeklyHeadroom('claude', claude(row, 'idle'))).toBeNull();
    expect(weeklyHeadroom('claude', claude(row, 'loading'))).toBeNull();
    expect(weeklyHeadroom('claude', claude(row, 'error'))).toBeNull();
    expect(weeklyHeadroom('claude', undefined)).toBeNull();
  });

  test('a seat past its own limit clamps to zero rather than going negative', () => {
    // A negative remainder would cancel out another account's real headroom.
    expect(
      weeklyHeadroom('claude', claude([{ id: 'seven-day', usedPercent: 118, periodHours: WEEK }]))
    ).toBe(0);
  });

  test('a DST week still counts as weekly', () => {
    expect(
      weeklyHeadroom('claude', claude([{ id: 'seven-day', usedPercent: 25, periodHours: 169 }]))
    ).toBeCloseTo(0.75, 10);
  });
});

describe('weeklyHeadroom — Codex', () => {
  test('reads the account-wide weekly window', () => {
    expect(
      weeklyHeadroom(
        'codex',
        codex([
          { id: 'five-hour', usedPercent: 10, periodHours: 5 },
          { id: 'weekly', usedPercent: 30, periodHours: WEEK },
        ])
      )
    ).toBeCloseTo(0.7, 10);
  });

  test('the code-review weekly limit is not the account limit', () => {
    expect(
      weeklyHeadroom('codex', codex([{ id: 'code-review-weekly', usedPercent: 100, periodHours: WEEK }]))
    ).toBeNull();
  });

  test('a monthly-only plan reports no weekly headroom', () => {
    expect(
      weeklyHeadroom('codex', codex([{ id: 'monthly', usedPercent: 20, periodHours: 720 }]))
    ).toBeNull();
  });
});

describe('weeklyHeadroom — xAI', () => {
  test('a weekly billing period counts', () => {
    expect(
      weeklyHeadroom('xai', {
        status: 'success',
        billing: { periodType: 'weekly', usedPercent: 75 },
      })
    ).toBeCloseTo(0.25, 10);
  });

  test('a monthly period does not — a spend cap is not rate-limited capacity', () => {
    expect(
      weeklyHeadroom('xai', {
        status: 'success',
        billing: { periodType: 'monthly', usedPercent: 10 },
      })
    ).toBeNull();
  });
});

describe('weeklyHeadroom — Kimi and Antigravity', () => {
  test('Kimi converts absolutes into a fraction', () => {
    expect(
      weeklyHeadroom('kimi', {
        status: 'success',
        rows: [{ id: 'w', used: 25, limit: 100, periodHours: WEEK }],
      })
    ).toBeCloseTo(0.75, 10);
  });

  test('a zero limit cannot express headroom and is skipped, not treated as full', () => {
    expect(
      weeklyHeadroom('kimi', {
        status: 'success',
        rows: [{ id: 'w', used: 0, limit: 0, periodHours: WEEK }],
      })
    ).toBeNull();
  });

  test('with no declared account-wide row, the binding constraint wins', () => {
    // Understating headroom is acceptable where scope is unknown; overstating
    // it is not.
    expect(
      weeklyHeadroom('kimi', {
        status: 'success',
        rows: [
          { id: 'a', used: 10, limit: 100, periodHours: WEEK },
          { id: 'b', used: 80, limit: 100, periodHours: WEEK },
        ],
      })
    ).toBeCloseTo(0.2, 10);
  });

  test('Antigravity reports what is left, so it is not inverted', () => {
    expect(
      weeklyHeadroom('antigravity', {
        status: 'success',
        groups: [{ buckets: [{ id: 'b', remainingFraction: 0.3, periodHours: WEEK }] }],
      })
    ).toBeCloseTo(0.3, 10);
  });

  test('a 5-hour bucket is ignored', () => {
    expect(
      weeklyHeadroom('antigravity', {
        status: 'success',
        groups: [{ buckets: [{ id: 'b', remainingFraction: 0.9, periodHours: 5 }] }],
      })
    ).toBeNull();
  });
});

describe('summarizeWeeklyCapacity', () => {
  const entry = (type: QuotaProviderType, name: string) => ({ file: { name }, type });

  const fleet = [
    entry('claude', 'a'),
    entry('claude', 'b'),
    entry('claude', 'c'),
    entry('codex', 'd'),
  ];

  const quotas: Record<string, unknown> = {
    a: claude([{ id: 'seven-day', usedPercent: 60, periodHours: WEEK }]),
    b: claude([{ id: 'seven-day', usedPercent: 100, periodHours: WEEK }]),
    c: claude([{ id: 'seven-day', usedPercent: 0, periodHours: WEEK }], 'idle'),
    d: codex([{ id: 'weekly', usedPercent: 50, periodHours: WEEK }]),
  };

  const summarize = (entries: typeof fleet) =>
    summarizeWeeklyCapacity(entries, (item) => quotas[item.file.name]);

  const rowFor = (rows: WeeklyCapacityRow[], provider: QuotaProviderType) =>
    rows.find((row) => row.provider === provider);

  test('sums remaining fractions into account-equivalents', () => {
    const claudeRow = rowFor(summarize(fleet).rows, 'claude');
    // 0.4 free + 0.0 free; the third is unloaded and counted nowhere.
    expect(claudeRow?.accountsFree).toBeCloseTo(0.4, 10);
    expect(claudeRow?.measured).toBe(2);
    expect(claudeRow?.total).toBe(3);
  });

  test('an unmeasured credential is neither full nor empty', () => {
    const summary = summarize(fleet);
    expect(summary.partial).toBe(true);
  });

  test('partial is false once every credential in scope has a reading', () => {
    const summary = summarize([entry('claude', 'a'), entry('codex', 'd')]);
    expect(summary.partial).toBe(false);
    expect(rowFor(summary.rows, 'codex')?.accountsFree).toBeCloseTo(0.5, 10);
  });

  test('providers with no credentials in scope are dropped, not shown as zero', () => {
    const rows = summarize([entry('codex', 'd')]).rows;
    expect(rows.map((row) => row.provider)).toEqual(['codex']);
  });

  test('rows follow the tab order so the strip reads like the tabs above it', () => {
    const rows = summarize([entry('codex', 'd'), entry('claude', 'a')]).rows;
    expect(rows.map((row) => row.provider)).toEqual(['claude', 'codex']);
  });

  test('an empty scope yields no rows and is not partial', () => {
    const summary = summarize([]);
    expect(summary.rows).toEqual([]);
    expect(summary.partial).toBe(false);
  });
});
