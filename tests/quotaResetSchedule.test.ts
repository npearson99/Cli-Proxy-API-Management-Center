/**
 * Which row on a quota card recovers first, per provider.
 */

import { describe, expect, test } from 'bun:test';
import { QUOTA_DEFAULT_SORT_MODE } from '@/features/quota/constants';
import {
  QUOTA_SORT_KEY_RESOLVERS,
  WEEKLY_PERIOD_HOURS,
  XAI_WEEKLY_ROW_ID,
  collectQuotaRowInstants,
  nextRecoveryMs,
  pickSoonestRowId,
  pickUrgentRowId,
  resetCreditRowId,
  weeklyRecoveryMs,
} from '@/features/quota/resetSchedule';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';

const NOW = new Date(2026, 7, 2, 12).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const claudeQuota = {
  status: 'success',
  windows: [
    { id: 'five_hour', resetAtMs: NOW + 3 * HOUR_MS, periodHours: 5 },
    { id: 'seven_day', resetAtMs: NOW + 4 * DAY_MS, periodHours: WEEKLY_PERIOD_HOURS },
  ],
};

const codexQuota = {
  status: 'success',
  windows: [
    { id: 'primary', resetAtMs: NOW + 3 * HOUR_MS, periodHours: 5 },
    { id: 'secondary', resetAtMs: NOW + 6 * DAY_MS, periodHours: WEEKLY_PERIOD_HOURS },
  ],
  rateLimitResetCredits: [
    { id: 'credit-a', status: 'available', expiresAt: iso(NOW + 11 * DAY_MS) },
    { id: 'credit-b', status: 'available', expiresAt: iso(NOW + 2 * DAY_MS) },
  ],
};

describe('collectQuotaRowInstants', () => {
  test('collects every Claude window', () => {
    expect(collectQuotaRowInstants('claude', claudeQuota)).toEqual([
      { rowId: 'five_hour', atMs: NOW + 3 * HOUR_MS, kind: 'window', weekly: false },
      { rowId: 'seven_day', atMs: NOW + 4 * DAY_MS, kind: 'window', weekly: true },
    ]);
  });

  test('collects Codex windows and available reset credits together', () => {
    const instants = collectQuotaRowInstants('codex', codexQuota);
    expect(instants).toHaveLength(4);
    expect(instants.filter((i) => i.kind === 'credit').map((i) => i.rowId)).toEqual([
      'credit-a',
      'credit-b',
    ]);
  });

  test('ignores reset credits that are not available', () => {
    const consumed = {
      ...codexQuota,
      rateLimitResetCredits: [
        { id: 'used', status: 'consumed', expiresAt: iso(NOW + HOUR_MS) },
        { id: 'live', status: 'available', expiresAt: iso(NOW + 2 * HOUR_MS) },
      ],
    };
    expect(
      collectQuotaRowInstants('codex', consumed)
        .filter((i) => i.kind === 'credit')
        .map((i) => i.rowId)
    ).toEqual(['live']);
  });

  test('collects the xAI weekly window', () => {
    const quota = { status: 'success', billing: { periodType: 'weekly', resetAtMs: NOW + DAY_MS } };
    expect(collectQuotaRowInstants('xai', quota)).toEqual([
      // Weekly by declaration: periodType already vouched for it.
      { rowId: XAI_WEEKLY_ROW_ID, atMs: NOW + DAY_MS, kind: 'window', weekly: true },
    ]);
  });

  test('ignores an xAI monthly summary — a billing cycle is not capacity returning', () => {
    const quota = {
      status: 'success',
      billing: { periodType: 'monthly', resetAtMs: NOW + DAY_MS },
    };
    expect(collectQuotaRowInstants('xai', quota)).toEqual([]);
  });

  test('flattens Antigravity buckets across groups', () => {
    const quota = {
      status: 'success',
      groups: [
        { id: 'g1', buckets: [{ id: 'b1', resetAtMs: NOW + HOUR_MS }] },
        { id: 'g2', buckets: [{ id: 'b2', resetAtMs: NOW + 2 * HOUR_MS }] },
      ],
    };
    expect(collectQuotaRowInstants('antigravity', quota).map((i) => i.rowId)).toEqual(['b1', 'b2']);
  });

  test('collects Kimi rows', () => {
    const quota = { status: 'success', rows: [{ id: 'r1', resetAtMs: NOW + HOUR_MS }] };
    expect(collectQuotaRowInstants('kimi', quota).map((i) => i.rowId)).toEqual(['r1']);
  });

  test('returns nothing unless the credential loaded successfully', () => {
    for (const status of ['idle', 'loading', 'error']) {
      expect(collectQuotaRowInstants('claude', { ...claudeQuota, status })).toEqual([]);
    }
    expect(collectQuotaRowInstants('claude', undefined)).toEqual([]);
  });

  test('drops rows with no usable instant rather than emitting NaN', () => {
    const quota = {
      status: 'success',
      windows: [
        { id: 'ok', resetAtMs: NOW + HOUR_MS },
        { id: 'missing' },
        { id: 'null', resetAtMs: null },
        { id: 'nan', resetAtMs: Number.NaN },
      ],
    };
    expect(collectQuotaRowInstants('claude', quota).map((i) => i.rowId)).toEqual(['ok']);
  });

  test('drops a reset credit whose expiry will not parse', () => {
    const quota = {
      status: 'success',
      windows: [],
      rateLimitResetCredits: [{ id: 'bad', status: 'available', expiresAt: 'not a date' }],
    };
    expect(collectQuotaRowInstants('codex', quota)).toEqual([]);
  });
});

describe('pickSoonestRowId', () => {
  test('picks the nearest upcoming instant', () => {
    expect(pickSoonestRowId(collectQuotaRowInstants('claude', claudeQuota), NOW)).toBe('five_hour');
  });

  test('a credit expiring before every window wins the emphasis', () => {
    const quota = {
      ...codexQuota,
      windows: [{ id: 'primary', resetAtMs: NOW + 5 * DAY_MS }],
    };
    expect(pickSoonestRowId(collectQuotaRowInstants('codex', quota), NOW)).toBe('credit-b');
  });

  test('a window resetting before every credit wins the emphasis', () => {
    expect(pickSoonestRowId(collectQuotaRowInstants('codex', codexQuota), NOW)).toBe('primary');
  });

  test('skips instants that have already passed', () => {
    const instants = [
      { rowId: 'past', atMs: NOW - HOUR_MS, kind: 'window' as const, weekly: false },
      { rowId: 'exactly-now', atMs: NOW, kind: 'window' as const, weekly: false },
      { rowId: 'future', atMs: NOW + HOUR_MS, kind: 'window' as const, weekly: false },
    ];
    expect(pickSoonestRowId(instants, NOW)).toBe('future');
  });

  test('returns null when nothing is pending', () => {
    expect(pickSoonestRowId([], NOW)).toBeNull();
    expect(
      pickSoonestRowId([{ rowId: 'past', atMs: NOW - 1, kind: 'window', weekly: false }], NOW)
    ).toBeNull();
  });

  test('breaks ties deterministically on row id', () => {
    const a = [
      { rowId: 'b', atMs: NOW + HOUR_MS, kind: 'window' as const, weekly: false },
      { rowId: 'a', atMs: NOW + HOUR_MS, kind: 'window' as const, weekly: false },
    ];
    expect(pickSoonestRowId(a, NOW)).toBe('a');
    expect(pickSoonestRowId([...a].reverse(), NOW)).toBe('a');
  });
});

describe('pickUrgentRowId', () => {
  test('highlights only the nearest reset strictly inside the final hour', () => {
    const instants = [
      {
        rowId: 'later-urgent',
        atMs: NOW + 45 * 60_000,
        kind: 'window' as const,
        weekly: false,
      },
      {
        rowId: 'nearest-urgent',
        atMs: NOW + 30 * 60_000,
        kind: 'window' as const,
        weekly: false,
      },
      { rowId: 'past', atMs: NOW - 1, kind: 'window' as const, weekly: false },
    ];

    expect(pickUrgentRowId(instants, NOW)).toBe('nearest-urgent');
  });

  test('does not highlight at exactly one hour or beyond', () => {
    expect(
      pickUrgentRowId(
        [
          { rowId: 'exactly-one-hour', atMs: NOW + HOUR_MS, kind: 'window', weekly: false },
          { rowId: 'later', atMs: NOW + 2 * HOUR_MS, kind: 'window', weekly: false },
        ],
        NOW
      )
    ).toBeNull();
  });
});

describe('resetCreditRowId', () => {
  test('prefers the credit id', () => {
    expect(resetCreditRowId({ id: 'credit-a', expiresAt: 'x' }, 3)).toBe('credit-a');
  });

  test('falls back to expiry and index when the payload carries no id', () => {
    // Must stay byte-identical to CodexQuotaBody's React key.
    expect(resetCreditRowId({ id: '', expiresAt: '2026-08-13T00:00:00Z' }, 2)).toBe(
      '2026-08-13T00:00:00Z-2'
    );
    expect(resetCreditRowId({ expiresAt: '2026-08-13T00:00:00Z' }, 0)).toBe(
      '2026-08-13T00:00:00Z-0'
    );
  });
});

describe('nextRecoveryMs', () => {
  test('returns the soonest upcoming instant across windows and credits', () => {
    expect(nextRecoveryMs('codex', codexQuota, NOW)).toBe(NOW + 3 * HOUR_MS);
  });

  test('ignores instants already in the past', () => {
    const quota = {
      status: 'success',
      windows: [
        { id: 'stale', resetAtMs: NOW - DAY_MS },
        { id: 'live', resetAtMs: NOW + DAY_MS },
      ],
    };
    expect(nextRecoveryMs('claude', quota, NOW)).toBe(NOW + DAY_MS);
  });

  test('is null for an unloaded credential, so sorting can sink it', () => {
    expect(nextRecoveryMs('claude', undefined, NOW)).toBeNull();
    expect(nextRecoveryMs('claude', { status: 'idle' }, NOW)).toBeNull();
    expect(nextRecoveryMs('claude', { status: 'error' }, NOW)).toBeNull();
  });

  test('is null when every known instant has passed', () => {
    const quota = { status: 'success', windows: [{ id: 'stale', resetAtMs: NOW - 1 }] };
    expect(nextRecoveryMs('claude', quota, NOW)).toBeNull();
  });
});

describe('weeklyRecoveryMs', () => {
  test('ranks by the 7-day window, ignoring the sooner 5-hour one', () => {
    expect(weeklyRecoveryMs('claude', claudeQuota, NOW)).toBe(NOW + 4 * DAY_MS);
  });

  test('ignores Codex reset credits even when they expire before the weekly window', () => {
    // credit-b expires at NOW + 2d, well before the weekly window at NOW + 6d.
    expect(weeklyRecoveryMs('codex', codexQuota, NOW)).toBe(NOW + 6 * DAY_MS);
  });

  test('tolerates hours derived from instants rather than stated exactly', () => {
    const quota = {
      status: 'success',
      windows: [{ id: 'w', resetAtMs: NOW + DAY_MS, periodHours: 167.5 }],
    };
    expect(weeklyRecoveryMs('claude', quota, NOW)).toBe(NOW + DAY_MS);
  });

  test('a DST-shifted week — exactly 167 or 169 hours — still counts as weekly', () => {
    for (const periodHours of [167, 169]) {
      const quota = {
        status: 'success',
        windows: [{ id: 'w', resetAtMs: NOW + DAY_MS, periodHours }],
      };
      expect(weeklyRecoveryMs('claude', quota, NOW)).toBe(NOW + DAY_MS);
    }
    for (const periodHours of [166, 170]) {
      const quota = {
        status: 'success',
        windows: [{ id: 'w', resetAtMs: NOW + DAY_MS, periodHours }],
      };
      expect(weeklyRecoveryMs('claude', quota, NOW)).toBeNull();
    }
  });

  test('accepts hours a payload states as a numeric string', () => {
    const quota = {
      status: 'success',
      windows: [{ id: 'w', resetAtMs: NOW + DAY_MS, periodHours: '168' }],
    };
    expect(weeklyRecoveryMs('claude', quota, NOW)).toBe(NOW + DAY_MS);
  });

  test('counts xAI weekly billing as a weekly window even without stated hours', () => {
    const quota = { status: 'success', billing: { periodType: 'weekly', resetAtMs: NOW + DAY_MS } };
    expect(weeklyRecoveryMs('xai', quota, NOW)).toBe(NOW + DAY_MS);
  });

  test('trusts the xAI weekly declaration even when derived hours stray far from a week', () => {
    // Monthly bounds standing in for missing weekly ones, or a partial first
    // period, both derive hours nowhere near 168. periodType still says weekly.
    for (const periodHours of [720, 72]) {
      const quota = {
        status: 'success',
        billing: { periodType: 'weekly', resetAtMs: NOW + DAY_MS, periodHours },
      };
      expect(weeklyRecoveryMs('xai', quota, NOW)).toBe(NOW + DAY_MS);
    }
  });

  test('ranks Antigravity weekly buckets and Kimi weekly rows', () => {
    const antigravity = {
      status: 'success',
      groups: [
        {
          id: 'g1',
          buckets: [
            { id: 'session', resetAtMs: NOW + HOUR_MS, periodHours: 5 },
            { id: 'week', resetAtMs: NOW + 2 * DAY_MS, periodHours: WEEKLY_PERIOD_HOURS },
          ],
        },
      ],
    };
    expect(weeklyRecoveryMs('antigravity', antigravity, NOW)).toBe(NOW + 2 * DAY_MS);

    const kimi = {
      status: 'success',
      rows: [{ id: 'r1', resetAtMs: NOW + 3 * DAY_MS, periodHours: WEEKLY_PERIOD_HOURS }],
    };
    expect(weeklyRecoveryMs('kimi', kimi, NOW)).toBe(NOW + 3 * DAY_MS);
  });

  test('is null when no weekly window exists, so sorting can sink it', () => {
    const monthly = {
      status: 'success',
      windows: [{ id: 'monthly', resetAtMs: NOW + DAY_MS, periodHours: 720 }],
    };
    expect(weeklyRecoveryMs('codex', monthly, NOW)).toBeNull();
    expect(weeklyRecoveryMs('claude', undefined, NOW)).toBeNull();
    expect(weeklyRecoveryMs('claude', { status: 'error' }, NOW)).toBeNull();
  });

  test('is null for windows that state no period at all', () => {
    const quota = { status: 'success', windows: [{ id: 'legacy', resetAtMs: NOW + DAY_MS }] };
    expect(weeklyRecoveryMs('claude', quota, NOW)).toBeNull();
  });

  test('skips a weekly window that already reset', () => {
    const quota = {
      status: 'success',
      windows: [{ id: 'stale', resetAtMs: NOW - 1, periodHours: WEEKLY_PERIOD_HOURS }],
    };
    expect(weeklyRecoveryMs('claude', quota, NOW)).toBeNull();
  });
});

describe('QUOTA_SORT_KEY_RESOLVERS', () => {
  test('wires the page default to the weekly ranking', () => {
    // The commit's whole point: the page opens ranked the way cpa-route ranks.
    expect(QUOTA_DEFAULT_SORT_MODE).toBe('weekly');
    expect(QUOTA_SORT_KEY_RESOLVERS[QUOTA_DEFAULT_SORT_MODE]).toBe(weeklyRecoveryMs);
  });

  test('maps every mode: weekly and soonest resolve, default keeps provider order', () => {
    expect(QUOTA_SORT_KEY_RESOLVERS.weekly).toBe(weeklyRecoveryMs);
    expect(QUOTA_SORT_KEY_RESOLVERS.soonest).toBe(nextRecoveryMs);
    expect(QUOTA_SORT_KEY_RESOLVERS.default).toBeNull();
  });
});
