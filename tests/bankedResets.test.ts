import { describe, expect, test } from 'bun:test';
import { BANKED_FABLE_KEY, summarizeBankedResets } from '@/features/quota/bankedResets';
import type { QuotaProviderType } from '@/features/quota/providers/types';
import { parseClaudeResetInfo } from '@/utils/quota';

/** As the usage API sent them on 2026-11-10. */
const fullReset = (
  percentUsed: Record<string, number>,
  overrides: Record<string, unknown> = {}
) => ({
  id: 'full-reset-2611',
  label: 'One full limit reset (November 2026)',
  resets_total: 1,
  resets_left: 1,
  ends_at: '2026-12-10T22:00:00+00:00',
  clears: ['seven_day', 'seven_day_overage_included'],
  usable_now: true,
  paused: false,
  use_requires_limit: false,
  percent_used: percentUsed,
  type: 'weekly',
  gives_back_weekly: false,
  ...overrides,
});
const fableReset = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  label: 'New model launch: one Fable reset',
  resets_total: 1,
  resets_left: 1,
  ends_at: '2027-03-09T07:59:00+00:00',
  clears: ['five_hour', 'seven_day_overage_included'],
  usable_now: true,
  paused: false,
  type: 'full',
  gives_back_weekly: true,
  ...overrides,
});
const seat = (
  grants: Record<string, unknown>[],
  fableShare = 0,
  cedar: Record<string, unknown> = {}
) => ({
  status: 'success',
  resets: parseClaudeResetInfo(
    {
      limits: [
        { kind: 'weekly_all' },
        { kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } } },
      ],
      weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: fableShare }],
      cedar_ember: { eligible: true, grants, ...cedar },
    },
    'invalid'
  ),
});

type Entry = { file: { name: string; disabled?: boolean }; type: QuotaProviderType };
const entry = (name: string, type: QuotaProviderType = 'claude'): Entry => ({
  file: { name },
  type,
});

describe("the fleet's banked Claude resets", () => {
  test('one line per grant id, every Fable reset on one, soonest use-by first', () => {
    const states: Record<string, unknown> = {
      // The Fable reset is met first, so only the sort can put the full reset ahead.
      'weekly-out.json': seat([fableReset('launch-2610-fable'), fullReset({ seven_day: 100 })]),
      'fable-out.json': seat(
        [
          fullReset({ seven_day: 52, seven_day_overage_included: 100 }),
          fableReset('launch-2610-fable'),
          fableReset('launch-2610-fable-6mo'),
        ],
        50
      ),
      'enterprise.json': seat([
        fullReset(
          { five_hour: 100, seven_day: 34 },
          {
            type: 'full',
            clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
          }
        ),
      ]),
      'idle.json': seat([fullReset({ seven_day: 0, seven_day_overage_included: 0 })]),
    };
    const summary = summarizeBankedResets(
      [...Object.keys(states).map((name) => entry(name)), entry('codex.json', 'codex')],
      (e) => states[e.file.name]
    );
    expect(summary.read).toBe(4);
    expect(summary.total).toBe(4);
    expect(summary.groups.map((g) => [g.key, g.left, g.seats, g.usable])).toEqual([
      // The idle seat's full reset would give back nothing: held, not usable.
      ['full-reset-2611', 4, 4, 3],
      // Fable resets give back nothing where Fable spent nothing.
      [BANKED_FABLE_KEY, 3, 2, 2],
    ]);
    expect(summary.groups[0].label).toBe('One full limit reset (November 2026)');
    expect(summary.groups[0].endsAtMs).toBe(Date.parse('2026-12-10T22:00:00+00:00'));
    expect(summary.groups[1].fable).toBe(true);
  });

  test('a group dates from its soonest use-by on any seat; undated groups go last', () => {
    const states: Record<string, unknown> = {
      'a.json': seat(
        [
          fableReset('launch-2610-fable'),
          fullReset({ seven_day: 40 }, { id: 'undated', ends_at: null }),
        ],
        20
      ),
      'b.json': seat([fableReset('launch-2611-fable', { ends_at: '2026-11-30T08:00:00+00:00' })], 20),
      'c.json': seat([fullReset({ seven_day: 40 })]),
    };
    const summary = summarizeBankedResets(
      Object.keys(states).map((name) => entry(name)),
      (e) => states[e.file.name]
    );
    expect(summary.groups.map((g) => [g.key, g.endsAtMs])).toEqual([
      [BANKED_FABLE_KEY, Date.parse('2026-11-30T08:00:00+00:00')],
      ['full-reset-2611', Date.parse('2026-12-10T22:00:00+00:00')],
      ['undated', null],
    ]);
  });

  test('a grant whose id is "fable" is its own line, not the Fable resets', () => {
    const summary = summarizeBankedResets([entry('a.json')], () =>
      seat([fullReset({ seven_day: 40 }, { id: 'fable', label: 'Odd' }), fableReset('x')], 20)
    );
    expect(summary.groups.map((g) => [g.key, g.fable, g.left])).toEqual([
      ['fable', false, 1],
      [BANKED_FABLE_KEY, true, 1],
    ]);
  });

  test('spent, unread, ineligible and failed seats add nothing; spent and ineligible were read', () => {
    const states: Record<string, unknown> = {
      'spent.json': seat([fullReset({ seven_day: 50 }, { resets_left: 0 })]),
      'ineligible.json': seat([fullReset({ seven_day: 50 })], 0, { eligible: false }),
      'failed.json': { status: 'success', resets: { ...seat([]).resets, error: 'HTTP 500' } },
    };
    const summary = summarizeBankedResets(
      ['spent.json', 'ineligible.json', 'failed.json', 'unread.json'].map((name) => entry(name)),
      (e) => states[e.file.name]
    );
    // Only the failed and the unread seat are still to be counted.
    expect(summary).toEqual({ groups: [], read: 2, total: 4 });
  });

  test("a disabled seat's grants are still banked, but none is usable", () => {
    const states: Record<string, unknown> = {
      'on.json': seat([fullReset({ seven_day: 80 }), fableReset('launch-2610-fable')], 40),
      'off.json': seat([fullReset({ seven_day: 90 }), fableReset('launch-2610-fable')], 60),
    };
    const summary = summarizeBankedResets(
      [entry('on.json'), { file: { name: 'off.json', disabled: true }, type: 'claude' }],
      (e) => states[e.file.name]
    );
    expect(summary.read).toBe(2);
    expect(summary.total).toBe(2);
    expect(summary.groups.map((g) => [g.key, g.left, g.seats, g.usable])).toEqual([
      ['full-reset-2611', 2, 2, 1],
      [BANKED_FABLE_KEY, 2, 2, 1],
    ]);
  });
});
