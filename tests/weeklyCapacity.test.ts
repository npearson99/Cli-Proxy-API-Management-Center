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
  scopedWeeklyHeadroom,
  summarizeWeeklyCapacity,
  weeklyHeadroom,
  type WeeklyCapacityRow,
} from '@/features/quota/weeklyCapacity';
import { buildClaudeQuotaWindows } from '@/features/quota/providers/claude/data';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import { WEEKLY_PERIOD_HOURS } from '@/utils/quota';
import type { TFunction } from 'i18next';

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
      weeklyHeadroom(
        'claude',
        claude([{ id: 'seven-day-opus', usedPercent: 10, periodHours: WEEK }])
      )
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

describe('scopedWeeklyHeadroom — Claude Fable', () => {
  const FABLE = 'seven-day-fable';

  test('reads the Fable row when the account-wide row has more room', () => {
    expect(
      scopedWeeklyHeadroom(
        'claude',
        claude([
          { id: 'seven-day', usedPercent: 10, periodHours: WEEK },
          { id: FABLE, usedPercent: 60, periodHours: WEEK },
        ]),
        FABLE
      )
    ).toBeCloseTo(0.4, 10);
  });

  test('is capped by the account-wide row — a spent seat has no Fable left either', () => {
    // Fable is served from the same weekly pool: once the account is out, an
    // untouched Fable row is not room that can be used.
    expect(
      scopedWeeklyHeadroom(
        'claude',
        claude([
          { id: 'seven-day', usedPercent: 90, periodHours: WEEK },
          { id: FABLE, usedPercent: 0, periodHours: WEEK },
        ]),
        FABLE
      )
    ).toBeCloseTo(0.1, 10);
  });

  test('a seat with no Fable row of its own is bounded by the account-wide row alone', () => {
    // Nothing scopes Fable on this plan, so the whole weekly pool serves it.
    expect(
      scopedWeeklyHeadroom(
        'claude',
        claude([{ id: 'seven-day', usedPercent: 10, periodHours: WEEK }]),
        FABLE
      )
    ).toBeCloseTo(0.9, 10);
  });

  test('an unreadable account-wide row makes the Fable figure unknown, not full', () => {
    // A seat whose overall weekly cannot be read must not count as a whole
    // account of Fable on the strength of an untouched Fable row.
    const fableOnly = [{ id: FABLE, usedPercent: 0, periodHours: WEEK }];
    expect(scopedWeeklyHeadroom('claude', claude(fableOnly), FABLE)).toBeNull();
    expect(
      scopedWeeklyHeadroom(
        'claude',
        claude([{ id: 'seven-day', usedPercent: null, periodHours: WEEK }, ...fableOnly]),
        FABLE
      )
    ).toBeNull();
  });

  test('reads the row the Claude data layer builds, from either payload shape', () => {
    const t = ((key: string) => key) as TFunction;
    const modern = buildClaudeQuotaWindows(
      {
        seven_day: { utilization: 20, resets_at: null },
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 75,
            resets_at: null,
            is_active: true,
            scope: { model: { id: null, display_name: 'Fable' } },
          },
        ],
      },
      t
    );
    const legacy = buildClaudeQuotaWindows(
      {
        seven_day: { utilization: 20, resets_at: null },
        iguana_necktie: { utilization: 75, resets_at: null },
      },
      t
    );
    expect(scopedWeeklyHeadroom('claude', claude(modern), FABLE)).toBeCloseTo(0.25, 10);
    expect(scopedWeeklyHeadroom('claude', claude(legacy), FABLE)).toBeCloseTo(0.25, 10);
  });

  test('the scoped row does not feed back into the account-wide figure', () => {
    const quota = claude([
      { id: 'seven-day', usedPercent: 10, periodHours: WEEK },
      { id: FABLE, usedPercent: 100, periodHours: WEEK },
    ]);
    expect(weeklyHeadroom('claude', quota)).toBeCloseTo(0.9, 10);
    expect(scopedWeeklyHeadroom('claude', quota, FABLE)).toBe(0);
  });

  test('an unloaded card contributes nothing', () => {
    const rows = [
      { id: 'seven-day', usedPercent: 10, periodHours: WEEK },
      { id: FABLE, usedPercent: 10, periodHours: WEEK },
    ];
    expect(scopedWeeklyHeadroom('claude', claude(rows, 'idle'), FABLE)).toBeNull();
  });

  test('a Fable row with a non-weekly period is not a Fable row', () => {
    expect(
      scopedWeeklyHeadroom(
        'claude',
        claude([
          { id: 'seven-day', usedPercent: 10, periodHours: WEEK },
          { id: FABLE, usedPercent: 90, periodHours: 5 },
        ]),
        FABLE
      )
    ).toBeCloseTo(0.9, 10);
  });

  test('providers without a declared account-wide row have no scoped rows', () => {
    expect(
      scopedWeeklyHeadroom(
        'kimi',
        { status: 'success', windows: [{ id: FABLE, usedPercent: 10, periodHours: WEEK }] },
        FABLE
      )
    ).toBeNull();
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
      weeklyHeadroom(
        'codex',
        codex([{ id: 'code-review-weekly', usedPercent: 100, periodHours: WEEK }])
      )
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

  test('Fable gets its own figure under Claude, capped per seat by the account row', () => {
    const fable = [entry('claude', 'f1'), entry('claude', 'f2'), entry('claude', 'f3')];
    const fableQuotas: Record<string, unknown> = {
      // 0.5 Fable left, account-wide has more: counts 0.5.
      f1: claude([
        { id: 'seven-day', usedPercent: 10, periodHours: WEEK },
        { id: 'seven-day-fable', usedPercent: 50, periodHours: WEEK },
      ]),
      // Account-wide is the binding limit: counts 0.2, not 1.0.
      f2: claude([
        { id: 'seven-day', usedPercent: 80, periodHours: WEEK },
        { id: 'seven-day-fable', usedPercent: 0, periodHours: WEEK },
      ]),
      // No Fable row: the whole account serves Fable, so counts 1.0.
      f3: claude([{ id: 'seven-day', usedPercent: 0, periodHours: WEEK }]),
    };
    const row = rowFor(
      summarizeWeeklyCapacity(fable, (item) => fableQuotas[item.file.name]).rows,
      'claude'
    );
    expect(row?.measured).toBe(3);
    expect(row?.scoped).toHaveLength(1);
    expect(row?.scoped[0].id).toBe('seven-day-fable');
    expect(row?.scoped[0].accountsFree).toBeCloseTo(1.7, 10);
    expect(row?.scoped[0].ownRows).toBe(2);
  });

  test('a seat whose account-wide row is unreadable is unmeasured for Fable too', () => {
    const quotas: Record<string, unknown> = {
      f1: claude([{ id: 'seven-day-fable', usedPercent: 0, periodHours: WEEK }]),
      f2: claude([
        { id: 'seven-day', usedPercent: 50, periodHours: WEEK },
        { id: 'seven-day-fable', usedPercent: 50, periodHours: WEEK },
      ]),
    };
    const row = rowFor(
      summarizeWeeklyCapacity(
        [entry('claude', 'f1'), entry('claude', 'f2')],
        (item) => quotas[item.file.name]
      ).rows,
      'claude'
    );
    expect(row?.measured).toBe(1);
    expect(row?.scoped[0].ownRows).toBe(1);
    expect(row?.scoped[0].accountsFree).toBeCloseTo(0.5, 10);
  });

  test('a model no credential publishes its own row for is omitted', () => {
    const claudeRow = rowFor(summarize(fleet).rows, 'claude');
    expect(claudeRow?.scoped).toEqual([]);
    expect(rowFor(summarize(fleet).rows, 'codex')?.scoped).toEqual([]);
  });

  test('an empty scope yields no rows and is not partial', () => {
    const summary = summarize([]);
    expect(summary.rows).toEqual([]);
    expect(summary.partial).toBe(false);
  });
});
