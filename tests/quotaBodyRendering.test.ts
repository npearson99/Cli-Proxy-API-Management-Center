/**
 * Provider bodies rendered end-to-end.
 *
 * Bodies receive their class map as a prop and import no stylesheet, so unlike
 * QuotaCard they can be rendered directly here — which is the only place the
 * "absolute plus countdown" pairing is checked as actual markup rather than as
 * a formatter's return value.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { CodexQuotaBody } from '@/features/quota/providers/codex/CodexQuotaBody';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import { KimiQuotaBody } from '@/features/quota/providers/kimi/KimiQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { formatInstantShort, parseClaudeResetInfo } from '@/utils/quota';
import { DAY_MS, HOUR_MS } from '@/utils/time/durations';
import type { ClaudeQuotaState, CodexQuotaState, KimiQuotaState } from '@/types';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);

/**
 * useNow() freezes to module-load time under renderToStaticMarkup (it reads
 * getServerSnapshot), so instants are placed relative to the real clock.
 */
const now = Date.now();

// The i18n fallback is zh-CN; pin English so the countdown assertions read.
beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('CodexQuotaBody', () => {
  const quota: CodexQuotaState = {
    status: 'success',
    planType: 'pro',
    windows: [
      {
        id: 'primary',
        label: '5-hour limit',
        usedPercent: 38,
        resetLabel: '08-02 18:00',
        resetAtMs: now + 3 * HOUR_MS,
        periodHours: 5,
      },
    ],
    rateLimitResetCredits: [
      {
        id: 'credit-1',
        status: 'available',
        grantedAt: new Date(now - DAY_MS).toISOString(),
        expiresAt: new Date(now + 11 * DAY_MS).toISOString(),
      },
    ],
    rateLimitResetCreditsAvailableCount: 1,
  };

  test('renders a window reset as absolute plus countdown', () => {
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota, classes }));

    expect(markup).toContain('08-02 18:00');
    expect(markup).toContain('quotaResetRelative');
    expect(markup).toMatch(/3 hours/);
  });

  test('renders reset-credit expiry in local time with a countdown', () => {
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota, classes }));

    expect(markup).toContain(formatInstantShort(now + 11 * DAY_MS));
    expect(markup).toMatch(/11 days/);
  });

  test('highlights a credit expiring within the final hour', () => {
    const creditFirst: CodexQuotaState = {
      ...quota,
      windows: [{ ...quota.windows[0], resetAtMs: now + 5 * DAY_MS }],
      rateLimitResetCredits: [
        {
          id: 'credit-1',
          status: 'available',
          grantedAt: new Date(now - DAY_MS).toISOString(),
          expiresAt: new Date(now + 30 * 60_000).toISOString(),
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(CodexQuotaBody, { quota: creditFirst, classes })
    );

    expect(markup).toContain('codexResetCreditRowSoon');
    expect(markup).not.toContain('quotaRowSoon');
  });

  test('does not emphasize a reset countdown more than one hour away', () => {
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota, classes }));

    expect(markup).not.toContain('quotaRowSoon');
    expect(markup).not.toContain('quotaResetRelativeSoon');
    expect(markup).not.toContain('codexResetCreditRowSoon');
  });

  test('emphasizes a reset countdown within the final hour', () => {
    const urgent: CodexQuotaState = {
      ...quota,
      windows: [{ ...quota.windows[0], resetAtMs: now + 30 * 60_000 }],
    };
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota: urgent, classes }));

    expect(markup).toContain('quotaResetRelativeSoon');
  });

  test('highlights nothing once every instant is in the past', () => {
    const stale: CodexQuotaState = {
      ...quota,
      windows: [{ ...quota.windows[0], resetAtMs: now - HOUR_MS }],
      rateLimitResetCredits: [],
      rateLimitResetCreditsAvailableCount: null,
    };
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota: stale, classes }));

    expect(markup).not.toContain('Soon');
  });

  test('keeps the baked label alone when the store entry predates resetAtMs', () => {
    const stale: CodexQuotaState = {
      ...quota,
      windows: [{ ...quota.windows[0], resetAtMs: undefined, periodHours: undefined }],
      rateLimitResetCredits: [],
      rateLimitResetCreditsAvailableCount: null,
    };
    const markup = renderToStaticMarkup(createElement(CodexQuotaBody, { quota: stale, classes }));

    expect(markup).toContain('08-02 18:00');
    expect(markup).not.toContain('quotaResetRelative');
  });
});

describe('KimiQuotaBody', () => {
  test('renders the concrete reset time alongside its countdown', () => {
    const resetAtMs = now + 3 * HOUR_MS;
    const quota: KimiQuotaState = {
      status: 'success',
      rows: [
        {
          id: 'summary',
          label: 'Weekly limit',
          used: 34,
          limit: 100,
          resetHint: '3h',
          resetAtMs,
          periodHours: 168,
        },
      ],
    };
    const markup = renderToStaticMarkup(createElement(KimiQuotaBody, { quota, classes }));

    expect(markup).toContain(formatInstantShort(resetAtMs));
    expect(markup).toContain('quotaResetRelative');
    expect(markup).toMatch(/3 hours/);
    expect(markup).not.toContain('resets in 3h');
  });
});

describe('ClaudeQuotaBody', () => {
  test('pairs each window reset with a countdown', () => {
    const quota: ClaudeQuotaState = {
      status: 'success',
      windows: [
        {
          id: 'five_hour',
          label: '5-hour',
          usedPercent: 12,
          resetLabel: '08-02 17:00',
          resetAtMs: now + 2 * HOUR_MS,
          periodHours: 5,
        },
        {
          id: 'seven_day',
          label: '7-day',
          usedPercent: 60,
          resetLabel: '08-06 04:00',
          resetAtMs: now + 4 * DAY_MS,
          periodHours: 168,
        },
      ],
    };
    const markup = renderToStaticMarkup(createElement(ClaudeQuotaBody, { quota, classes }));

    expect(markup).toContain('08-02 17:00');
    expect(markup).toContain('08-06 04:00');
    expect(markup).toMatch(/2 hours/);
    expect(markup).toMatch(/4 days/);
  });

  const grant = (overrides: Record<string, unknown> = {}) => ({
    id: 'weekly-a',
    resets_left: 1,
    usable_now: true,
    paused: false,
    type: 'weekly',
    clears: ['seven_day'],
    ends_at: new Date(now + 30 * DAY_MS).toISOString(),
    ...overrides,
  });
  const withGrants = (
    grants: Record<string, unknown>[],
    cedar: Record<string, unknown> = {}
  ): ClaudeQuotaState => ({
    status: 'success',
    windows: [
      {
        id: 'seven_day',
        label: '7-day',
        usedPercent: 60,
        resetLabel: '08-06 04:00',
        resetAtMs: now + 4 * DAY_MS,
        periodHours: 168,
      },
    ],
    resets: parseClaudeResetInfo({ cedar_ember: { eligible: true, grants, ...cedar } }, 'invalid'),
  });

  test('counts the resets left and how many of them are usable now', () => {
    const quota = withGrants([
      grant({ resets_left: 2 }),
      grant({ id: 'weekly-b', usable_now: false, unavailable_reason: 'cooldown' }),
    ]);
    const markup = renderToStaticMarkup(createElement(ClaudeQuotaBody, { quota, classes }));

    expect(markup).toContain('Resets left');
    expect(markup).toContain('<span class="codexPlanValue">3</span>');
    expect(markup).toContain('2 usable now');
  });

  test('a disabled seat holds its grants and never calls one usable', () => {
    const quota = withGrants([
      grant({ resets_left: 2 }),
      grant({ id: 'weekly-b', usable_now: false, unavailable_reason: 'cooldown' }),
    ]);
    const enabled = renderToStaticMarkup(createElement(ClaudeQuotaBody, { quota, classes }));
    const markup = renderToStaticMarkup(
      createElement(ClaudeQuotaBody, { quota, classes, disabled: true })
    );

    expect(enabled).toContain('Usable now');
    expect(enabled).toContain('claudeResetGrantStatusUsable');
    // Still banked: the count of what is left stays.
    expect(markup).toContain('<span class="codexPlanValue">3</span>');
    expect(markup).not.toMatch(/usable now/i);
    expect(markup).not.toContain('claudeResetGrantStatusUsable');
    expect(markup).toContain('Held while the seat is disabled');
  });

  test('shows no count for a seat the reset program does not serve', () => {
    const quota = withGrants([grant()], { eligible: false, ineligible_reason: 'surface' });
    const markup = renderToStaticMarkup(createElement(ClaudeQuotaBody, { quota, classes }));

    expect(markup).not.toContain('Resets left');
  });

  /** The November 2026 full limit reset on a seat with no 5-hour window. */
  const fullLimitReset = (percentUsed: Record<string, number>) =>
    grant({
      id: 'full-reset-2611',
      label: 'One full limit reset (November 2026)',
      clears: ['seven_day', 'seven_day_overage_included'],
      percent_used: percentUsed,
      use_requires_limit: false,
    });

  test('the full limit reset says what it gives back to the weekly', () => {
    const quota = withGrants([fullLimitReset({ seven_day: 100, seven_day_overage_included: 0 })]);
    const markup = renderToStaticMarkup(createElement(ClaudeQuotaBody, { quota, classes }));
    expect(markup).toContain('One full limit reset (November 2026)');
    expect(markup).toContain('Usable now · gives back 100% of the weekly limit');
  });

  test('on an idle seat it is not offered: it would give back nothing', () => {
    const quota = withGrants([fullLimitReset({ seven_day: 0, seven_day_overage_included: 0 })]);
    const markup = renderToStaticMarkup(createElement(ClaudeQuotaBody, { quota, classes }));
    expect(markup).toContain('nothing used yet to give back');
    // Neither the row's "Usable now" nor the count's "N usable now".
    expect(markup.toLowerCase()).not.toContain('usable now');
  });

  test('at 0% of the weekly it does not say it gives back 0% while the 5-hour is spent', () => {
    const quota = withGrants([
      grant({
        id: 'full-reset-2611',
        type: 'full',
        clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
        percent_used: { five_hour: 80, seven_day: 0, seven_day_overage_included: 0 },
        use_requires_limit: false,
      }),
    ]);
    const markup = renderToStaticMarkup(createElement(ClaudeQuotaBody, { quota, classes }));
    expect(markup).toContain('Usable now');
    expect(markup).not.toContain('gives back 0%');
  });

  test('a grant in its last hour takes the emphasis, and only then', () => {
    const later = renderToStaticMarkup(
      createElement(ClaudeQuotaBody, { quota: withGrants([grant()]), classes })
    );
    expect(later).not.toContain('codexResetCreditRowSoon');

    const expiring = withGrants([
      grant({ ends_at: new Date(now + 30 * 60_000).toISOString() }),
      grant({ id: 'weekly-b' }),
    ]);
    const markup = renderToStaticMarkup(
      createElement(ClaudeQuotaBody, { quota: expiring, classes })
    );
    expect(markup.match(/codexResetCreditRowSoon/g)).toHaveLength(1);
    expect(markup).toContain('quotaResetRelativeSoon');
  });
});
