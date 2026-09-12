import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { buildClaudeQuotaFromSignals } from '@/features/quota/providers/claude/signals';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as TFunction;

const FIVE_HOUR_RESET = 1789258200;
const WEEKLY_RESET = 1789826400;
// Fixed, an hour before the soonest reset, so no case depends on the wall clock.
const NOW = (FIVE_HOUR_RESET - 3600) * 1000;

const signals = (over: Record<string, string> = {}) => ({
  'Anthropic-Ratelimit-Unified-5h-Reset': String(FIVE_HOUR_RESET),
  'Anthropic-Ratelimit-Unified-5h-Status': 'allowed',
  'Anthropic-Ratelimit-Unified-5h-Utilization': '0.06',
  'Anthropic-Ratelimit-Unified-7d-Reset': String(WEEKLY_RESET),
  'Anthropic-Ratelimit-Unified-7d-Status': 'allowed',
  'Anthropic-Ratelimit-Unified-7d-Utilization': '0.04',
  'Anthropic-Ratelimit-Unified-7d_oi-Reset': String(WEEKLY_RESET),
  'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '0.08',
  ...over,
});

const file = (modelQuotas: unknown): AuthFileItem =>
  ({ name: 'claude-seat.json', type: 'claude', model_quotas: modelQuotas }) as AuthFileItem;

describe('Claude quota from harvested rate-limit headers', () => {
  test('builds the 5h, account-wide and scoped weekly windows with no network call', () => {
    const result = buildClaudeQuotaFromSignals(
      file({
        'claude-fable-5-1': { observed_at: '2026-09-12T12:55:53.316555-07:00', signals: signals() },
      }),
      t,
      NOW
    );

    expect(result?.windows).toEqual([
      {
        id: 'five-hour',
        label: 'claude_quota.five_hour',
        labelKey: 'claude_quota.five_hour',
        usedPercent: 6,
        resetLabel: expect.any(String),
        resetAtMs: FIVE_HOUR_RESET * 1000,
        periodHours: 5,
      },
      {
        id: 'seven-day',
        label: 'claude_quota.seven_day',
        labelKey: 'claude_quota.seven_day',
        usedPercent: 4,
        resetLabel: expect.any(String),
        resetAtMs: WEEKLY_RESET * 1000,
        periodHours: 24 * 7,
      },
      {
        id: 'seven-day-fable',
        label: 'claude_quota.seven_day_fable',
        labelKey: 'claude_quota.seven_day_fable',
        usedPercent: 8,
        resetLabel: expect.any(String),
        resetAtMs: WEEKLY_RESET * 1000,
        periodHours: 24 * 7,
      },
    ]);
    expect(result?.observedAtMs).toBe(Date.parse('2026-09-12T12:55:53.316555-07:00'));
  });

  test('takes each account-wide window from the model observed most recently', () => {
    const result = buildClaudeQuotaFromSignals(
      file({
        'claude-sonnet-5': {
          observed_at: '2026-09-09T03:05:46.605197-07:00',
          signals: signals({ 'Anthropic-Ratelimit-Unified-7d-Utilization': '0.99' }),
        },
        'claude-opus-5': {
          observed_at: '2026-09-12T12:56:15.424698-07:00',
          signals: signals({ 'Anthropic-Ratelimit-Unified-7d-Utilization': '0.04' }),
        },
      }),
      t,
      NOW
    );

    const weekly = result?.windows.find((window) => window.id === 'seven-day');
    expect(weekly?.usedPercent).toBe(4);
  });

  test('attributes the scoped weekly by the model key, not by the header name', () => {
    // An opus entry reporting 7d_oi must not land in Fable's row: the header names
    // the claim, and only the key it is filed under says whose claim it is.
    const result = buildClaudeQuotaFromSignals(
      file({
        'claude-opus-5': { observed_at: '2026-09-12T12:56:15.424698-07:00', signals: signals() },
      }),
      t,
      NOW
    );

    expect(result?.windows.map((window) => window.id)).toEqual(['five-hour', 'seven-day']);
  });

  test('reports a seat that has never served as having nothing to show', () => {
    expect(buildClaudeQuotaFromSignals(file(undefined), t, NOW)).toBeNull();
    expect(buildClaudeQuotaFromSignals(file({}), t, NOW)).toBeNull();
    expect(
      buildClaudeQuotaFromSignals(file({ 'claude-opus-5': { observed_at: '', signals: {} } }), t, NOW)
    ).toBeNull();
  });

  test('skips an entry with no observation time rather than dating it now', () => {
    expect(
      buildClaudeQuotaFromSignals(file({ 'claude-opus-5': { signals: signals() } }), t, NOW)
    ).toBeNull();
  });

  test('keeps a window whose reset the headers omitted', () => {
    const bare = { 'Anthropic-Ratelimit-Unified-7d-Utilization': '0.51' };
    const result = buildClaudeQuotaFromSignals(
      file({ 'claude-opus-5': { observed_at: '2026-09-12T12:56:15.424698-07:00', signals: bare } }),
      t,
      NOW
    );

    expect(result?.windows).toHaveLength(1);
    expect(result?.windows[0]).toMatchObject({ id: 'seven-day', usedPercent: 51, resetAtMs: null });
  });

  test('reads a window past its own reset as unknown, not as the old number', () => {
    // The 5-hour window turns over several times in a day an idle seat spends not
    // reporting, so its last reading describes a window that no longer exists.
    const result = buildClaudeQuotaFromSignals(
      file({
        'claude-fable-5-1': {
          observed_at: '2026-09-11T12:55:53.316555-07:00',
          signals: signals({ 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.8' }),
        },
      }),
      t,
      (FIVE_HOUR_RESET + 60) * 1000
    );

    const fiveHour = result?.windows.find((window) => window.id === 'five-hour');
    expect(fiveHour?.usedPercent).toBeNull();
    // The row survives, and its reset label still says when it lapsed.
    expect(fiveHour?.resetAtMs).toBe(FIVE_HOUR_RESET * 1000);
    // The weekly windows have not lapsed, so they keep their figures.
    expect(result?.windows.find((window) => window.id === 'seven-day')?.usedPercent).toBe(4);
  });

  test('keeps an undated window, which is idle rather than lapsed', () => {
    // Anthropic dates a window nobody has opened since it rolled over as null; that
    // is not the same as a window whose reset has passed.
    const result = buildClaudeQuotaFromSignals(
      file({
        'claude-opus-5': {
          observed_at: '2026-09-12T12:56:15.424698-07:00',
          signals: { 'Anthropic-Ratelimit-Unified-7d-Utilization': '0.51' },
        },
      }),
      t,
      Number.MAX_SAFE_INTEGER
    );

    expect(result?.windows[0]?.usedPercent).toBe(51);
  });

  test('drops a reset that is not an instant rather than throwing out of the seed', () => {
    // This runs inside the page's seeding effect, so a value `new Date` cannot
    // represent must not reach a formatter that throws on it: one credential's
    // malformed header would take the whole grid down, not one row.
    const result = buildClaudeQuotaFromSignals(
      file({
        'claude-opus-5': {
          observed_at: '2026-09-12T12:56:15.424698-07:00',
          signals: {
            'Anthropic-Ratelimit-Unified-7d-Utilization': '0.42',
            'Anthropic-Ratelimit-Unified-7d-Reset': '1e21',
          },
        },
      }),
      t,
      Date.parse('2026-09-12T13:00:00-07:00')
    );

    expect(result?.windows[0]).toMatchObject({
      id: 'seven-day',
      usedPercent: 42,
      resetAtMs: null,
      resetLabel: '-',
    });
  });

  test('carries an over-limit reading through instead of clamping it away', () => {
    // Seats really do report 1.01: the weekly row is what marks a seat spent, so a
    // reading past 100% has to survive to the card that renders it.
    const result = buildClaudeQuotaFromSignals(
      file({
        'claude-fable-5-1': {
          observed_at: '2026-09-12T12:55:53.316555-07:00',
          signals: signals({ 'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '1.01' }),
        },
      }),
      t,
      NOW
    );

    expect(result?.windows.find((window) => window.id === 'seven-day-fable')?.usedPercent).toBe(101);
  });
});
