import { afterEach, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
  CLAUDE_CONFIG,
  CLAUDE_RESET_RETRY_WINDOW_MS,
  claimClaudeReset,
  resetClaudeClaimMemory,
  type ClaudeResetChoice,
} from '@/features/quota/providers/claude/data';
import { QUOTA_ADAPTERS, type QuotaCardState } from '@/features/quota/providers';
import { seedDerivedQuota } from '@/features/quota/derivedSeed';
import type { QuotaFileEntry } from '@/features/quota/logic';
import {
  buildResetConfirmation,
  isResetOutcomeUnknown,
  resetFailedNoticeDuration,
  resetSuccessNotice,
} from '@/features/quota/resetCopy';
import {
  mergeSupplement,
  pendingSupplements,
  stillNeedsSupplement,
} from '@/features/quota/supplement';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from '@/services/api';
import type { AuthFileItem, ClaudeQuotaState, ClaudeResetInfo } from '@/types';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_RESET_STATUS_URL,
  CLAUDE_USAGE_URL,
  classifyClaudeResetClaim,
  claudeResetKind,
  claudeResetReason,
  claudeResetReasonKey,
  newClaudeResetRequestId,
  parseClaudeResetGrant,
  parseClaudeResetInfo,
  pickClaudeResetGrant,
} from '@/utils/quota';

/** Echoes the key and its params, so assertions can see what was asked for. */
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as unknown as TFunction;

const originalRequest = apiCallApi.request;
afterEach(() => {
  apiCallApi.request = originalRequest;
  resetClaudeClaimMemory();
});

const result = (statusCode: number, body: unknown = null): ApiCallResult => ({
  statusCode,
  header: {},
  bodyText: body === null ? '' : JSON.stringify(body),
  body,
});

const file = { name: 'claude-seat.json', auth_index: 'idx-1' } as unknown as AuthFileItem;
const ORG = '0f8b2c4e-1a2b-4c3d-8e9f-0123456789ab';

/** The Fable 5.2 launch grant as Anthropic sent it on 2026-11-09. */
const fableGrant = (overrides: Record<string, unknown> = {}) => ({
  id: 'launch-2610-fable',
  label: 'New model launch: one Fable reset for Max, Team Premium and Enterprise Premium',
  resets_total: 1,
  resets_left: 1,
  starts_at: '2026-11-09T18:00:00+00:00',
  ends_at: '2027-03-09T07:59:00+00:00',
  clears: ['seven_day_overage_included'],
  paused: false,
  usable_now: false,
  use_requires_limit: false,
  percent_used: { seven_day_overage_included: 0 },
  blocking: ['seven_day'],
  arm: null,
  type: 'full',
  unavailable_reason: 'blocked_seven_day',
  gives_back_weekly: true,
  ...overrides,
});

const statusBody = (cedar: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  five_hour: null,
  seven_day: { utilization: 100 },
  limits: [
    { kind: 'weekly_all', percent: 100 },
    { kind: 'weekly_scoped', percent: 0, scope: { model: { id: null, display_name: 'Fable' } } },
  ],
  weekly_scoped_shares: [
    { limit_index: 1, used_percent_of_weekly: 12, allowance_percent_of_weekly: 50 },
  ],
  cedar_ember: {
    eligible: true,
    ineligible_reason: null,
    at_limit: false,
    exhausted: [],
    grants: [fableGrant()],
    next_grant_id: null,
    cooldown_until: null,
    ...cedar,
  },
  ...extra,
});

const info = (cedar: Record<string, unknown> = {}): ClaudeResetInfo =>
  parseClaudeResetInfo(statusBody(cedar), 'invalid');

/** The same seat with Fable at 0% of the week, as every seat read on 2026-11-09. */
const noFableShare = { weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 0 }] };
const infoNoShare = (cedar: Record<string, unknown> = {}): ClaudeResetInfo =>
  parseClaudeResetInfo(statusBody(cedar, noFableShare), 'invalid');

describe('parsing a reset status block', () => {
  test("reads the launch grant and Fable's share of the week", () => {
    const parsed = info();
    expect(parsed.error).toBe('');
    expect(parsed.eligible).toBe(true);
    expect(parsed.grants).toHaveLength(1);
    expect(parsed.grants[0].givesBackWeekly).toBe(true);
    expect(parsed.grants[0].endsAt).toBe('2027-03-09T07:59:00+00:00');
    expect(parsed.fableWeeklySharePercent).toBe(12);
  });

  test('drops a malformed grant and keeps the rest, as Claude Code does', () => {
    const parsed = info({
      grants: [
        fableGrant(),
        { id: 'BAD ID', resets_left: 1 },
        { id: 'ok-2' },
        'junk',
        fableGrant({ id: 'second' }),
      ],
    });
    expect(parsed.grants.map((grant) => grant.id)).toEqual(['launch-2610-fable', 'second']);
  });

  test('ignores a next_grant_id that names no grant it kept', () => {
    expect(info({ next_grant_id: 'gone' }).nextGrantId).toBeNull();
    expect(info({ next_grant_id: 'launch-2610-fable' }).nextGrantId).toBe('launch-2610-fable');
  });

  test('a body without a status block is an error, not an empty list', () => {
    const parsed = parseClaudeResetInfo({ seven_day: { utilization: 1 } }, 'invalid');
    expect(parsed.error).toBe('invalid');
    expect(parsed.grants).toEqual([]);
  });

  test('defaults use_requires_limit to true when it is missing', () => {
    const grant = parseClaudeResetGrant({ id: 'g', resets_left: 1 });
    expect(grant?.useRequiresLimit).toBe(true);
  });
});

describe('what a grant is called', () => {
  const kind = (overrides: Record<string, unknown>) =>
    claudeResetKind(parseClaudeResetGrant(fableGrant(overrides))!);

  test('a grant that gives back weekly is a Fable reset, whatever its type says', () => {
    expect(kind({})).toBe('fable');
  });

  test('otherwise its type, otherwise what it clears', () => {
    expect(kind({ gives_back_weekly: false, type: 'weekly' })).toBe('weekly');
    expect(kind({ gives_back_weekly: false, type: null, clears: ['five_hour'] })).toBe('session');
    expect(kind({ gives_back_weekly: false, type: null, clears: ['seven_day'] })).toBe('weekly');
    expect(kind({ gives_back_weekly: false, type: null, clears: ['five_hour', 'seven_day'] })).toBe(
      'full'
    );
  });
});

describe('why a grant cannot be used', () => {
  const reasonFor = (grant: Record<string, unknown>, cedar: Record<string, unknown> = {}) => {
    const parsed = info({ grants: [fableGrant(grant)], ...cedar });
    return claudeResetReason(parsed.grants[0], parsed);
  };

  test('paused and spent come before any reason Anthropic gives', () => {
    expect(reasonFor({ paused: true })).toBe('paused');
    expect(reasonFor({ resets_left: 0 })).toBe('none_left');
    const parsed = info();
    expect(claudeResetReasonKey(parsed.grants[0], 'paused')).toBe('claude_quota.reset_paused');
    expect(claudeResetReasonKey(parsed.grants[0], 'none_left')).toBe(
      'claude_quota.reset_none_left'
    );
  });

  test("Anthropic's own reason comes first", () => {
    expect(reasonFor({}, { cooldown_until: '2026-11-09T20:00:00Z' })).toBe('blocked_seven_day');
  });

  test('then a cooldown, then the first blocking window', () => {
    expect(
      reasonFor({ unavailable_reason: null }, { cooldown_until: '2026-11-09T20:00:00Z' })
    ).toBe('cooldown');
    expect(
      reasonFor({ unavailable_reason: null, blocking: ['seven_day_cowork', 'five_hour'] })
    ).toBe('blocked_five_hour');
    expect(reasonFor({ unavailable_reason: null, blocking: ['seven_day_opus'] })).toBe(
      'blocked_opus'
    );
    expect(reasonFor({ unavailable_reason: null, blocking: ['mystery'] })).toBe('blocked_other');
    // An unknown window listed first must not hide a named one, as Claude Code drops it.
    expect(reasonFor({ unavailable_reason: null, blocking: ['mystery', 'five_hour'] })).toBe(
      'blocked_five_hour'
    );
    expect(reasonFor({ unavailable_reason: null, blocking: ['seven_day_overage_included'] })).toBe(
      'blocked_other'
    );
  });

  test('at a limit it does not refill, then whether it needs a limit at all', () => {
    const open = { unavailable_reason: null, blocking: [] };
    expect(reasonFor(open, { at_limit: true, exhausted: ['seven_day_opus'] })).toBe('cannot_clear');
    // A Fable reset gives back into the weekly window, so a spent weekly is one it refills.
    expect(reasonFor(open, { at_limit: true, exhausted: ['seven_day'] })).toBe('unavailable');
    expect(reasonFor({ ...open, use_requires_limit: true })).toBe('needs_limit');
    expect(reasonFor(open)).toBe('unavailable');
  });

  test('a Fable reset blocked by the weekly window has nothing to give back', () => {
    const parsed = info();
    const grant = parsed.grants[0];
    expect(claudeResetReasonKey(grant, claudeResetReason(grant, parsed))).toBe(
      'claude_quota.reset_reason_nothing_to_give_back'
    );
    const weekly = parseClaudeResetGrant(fableGrant({ gives_back_weekly: false }))!;
    expect(claudeResetReasonKey(weekly, 'blocked_seven_day')).toBe(
      'claude_quota.reset_reason_blocked_seven_day'
    );
  });
});

describe('which grant a claim spends', () => {
  const usable = (id: string, overrides: Record<string, unknown> = {}) =>
    fableGrant({ id, usable_now: true, unavailable_reason: null, blocking: [], ...overrides });

  test('next_grant_id when it is usable', () => {
    expect(
      pickClaudeResetGrant(info({ grants: [usable('a'), usable('b')], next_grant_id: 'b' }))?.id
    ).toBe('b');
  });

  test('otherwise the first usable grant, skipping paused and spent ones', () => {
    const grants = [
      fableGrant({ id: 'blocked' }),
      usable('paused', { paused: true }),
      usable('empty', { resets_left: 0 }),
      usable('c'),
    ];
    expect(pickClaudeResetGrant(info({ grants, next_grant_id: 'blocked' }))?.id).toBe('c');
  });

  test('never a Fable reset that would give back 0%, as cpa-route refuses it', () => {
    const grants = [
      usable('fable'),
      usable('weekly', { gives_back_weekly: false, type: 'weekly' }),
    ];
    expect(pickClaudeResetGrant(infoNoShare({ grants, next_grant_id: 'fable' }))?.id).toBe(
      'weekly'
    );
    expect(pickClaudeResetGrant(infoNoShare({ grants: [usable('fable')] }))).toBeNull();
    // An unknown share is not a zero one: the dialog says it is unknown.
    const unknown = parseClaudeResetInfo(
      statusBody({ grants: [usable('fable')] }, { weekly_scoped_shares: [] }),
      'invalid'
    );
    expect(unknown.fableWeeklySharePercent).toBeNull();
    expect(pickClaudeResetGrant(unknown)?.id).toBe('fable');
  });

  test('nothing on an ineligible seat or one whose status failed', () => {
    expect(pickClaudeResetGrant(info({ eligible: false, grants: [usable('a')] }))).toBeNull();
    expect(pickClaudeResetGrant(parseClaudeResetInfo(null, 'invalid'))).toBeNull();
    expect(pickClaudeResetGrant(undefined)).toBeNull();
  });
});

describe('what a claim answer means', () => {
  test('reset spent one', () => {
    expect(
      classifyClaudeResetClaim({ result: 'reset', cleared: ['seven_day'], resets_left: 0 })
    ).toEqual({
      outcome: 'reset',
      cleared: ['seven_day'],
      resetsLeft: 0,
    });
  });

  test('six answers spent nothing', () => {
    for (const answer of [
      'not_limited',
      'cooldown',
      'already_used',
      'ineligible',
      'rate_limited',
      'auth_error',
    ]) {
      expect(classifyClaudeResetClaim({ result: answer }).outcome).toBe('not_spent');
    }
  });

  test('anything else leaves the outcome open', () => {
    for (const body of [
      { result: 'unavailable' },
      { result: 'error' },
      { result: 7 },
      null,
      'not json',
    ]) {
      expect(classifyClaudeResetClaim(body).outcome).toBe('unknown');
    }
  });
});

describe('claiming a reset', () => {
  type Route = (payload: ApiCallRequest) => ApiCallResult | Promise<ApiCallResult>;
  const calls: ApiCallRequest[] = [];
  const route = (handler: Route) => {
    calls.length = 0;
    apiCallApi.request = (async (payload: ApiCallRequest) => {
      calls.push(payload);
      return handler(payload);
    }) as typeof apiCallApi.request;
  };
  const usableBody = statusBody({
    grants: [fableGrant({ usable_now: true, unavailable_reason: null, blocking: [] })],
  });
  const claimUrl = `https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`;
  const choice: ClaudeResetChoice = { grantId: 'launch-2610-fable', atLimit: false };

  test('re-reads the grant, finds the organization, and posts the claim', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      if (payload.url === claimUrl)
        return result(200, { result: 'reset', cleared: ['seven_day'], resets_left: 0 });
      throw new Error(`unexpected url ${payload.url}`);
    });
    const claimed = await claimClaudeReset(file, t, choice);
    expect(claimed).toEqual({ cleared: ['seven_day'], resetsLeft: 0 });
    const post = calls.find((call) => call.method === 'POST')!;
    const body = JSON.parse(post.data ?? '{}');
    expect(body.program).toBe('cedar_ember');
    expect(body.grant_id).toBe('launch-2610-fable');
    expect(body.request_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(post.header?.['anthropic-client-platform']).toBe('claude_code_cli');
  });

  test('spends nothing when the grant is no longer usable', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, statusBody());
      throw new Error(`unexpected url ${payload.url}`);
    });
    const error = (await claimClaudeReset(file, t, choice).catch((err) => err)) as Error;
    expect(error.message).toContain('claude_quota.reset_not_claimed');
    expect(error.message).toContain('reset_reason_nothing_to_give_back');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  test('spends nothing when Fable has used none of the week by the time it is claimed', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL)
        return result(
          200,
          statusBody(
            { grants: [fableGrant({ usable_now: true, unavailable_reason: null, blocking: [] })] },
            noFableShare
          )
        );
      throw new Error(`unexpected url ${payload.url}`);
    });
    const error = (await claimClaudeReset(file, t, choice).catch((err) => err)) as Error;
    expect(error.message).toContain('claude_quota.reset_not_claimed');
    expect(error.message).toContain('reset_reason_nothing_to_give_back');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  test('spends nothing without a well-formed organization uuid', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL)
        return result(200, { organization: { uuid: '../x' } });
      throw new Error(`unexpected url ${payload.url}`);
    });
    const error = (await claimClaudeReset(file, t).catch((err) => err)) as Error;
    expect(error.message).toContain('reset_no_organization');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  test('an open outcome names the request id and the safe retry', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      return result(502, { error: 'upstream' });
    });
    const error = (await claimClaudeReset(file, t).catch((err) => err)) as Error;
    expect(error.message).toContain('claude_quota.reset_outcome_unknown');
    // Its notice is the only record of the request id: it stays until dismissed.
    expect(isResetOutcomeUnknown(error)).toBe(true);
    expect(resetFailedNoticeDuration(error)).toBe(0);
    const requestId = JSON.parse(calls.find((call) => call.method === 'POST')!.data!).request_id;
    expect(error.message).toContain(requestId);
    expect(error.message).toContain(
      `cpa-route claude reset claude-seat.json --grant launch-2610-fable --request-id ${requestId}`
    );
  });

  test('the management API refusing the call spent nothing', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    });
    const error = (await claimClaudeReset(file, t).catch((err) => err)) as Error;
    expect(error.message).toContain('claude_quota.reset_not_claimed');
  });

  test('a not-spent answer says nothing was used', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      return result(200, { result: 'not_limited', reason: 'under limit' });
    });
    const error = (await claimClaudeReset(file, t).catch((err) => err)) as Error;
    expect(error.message).toContain('claude_quota.reset_not_claimed');
    expect(error.message).toContain('not_limited: under limit');
    expect(isResetOutcomeUnknown(error)).toBe(false);
    expect(resetFailedNoticeDuration(error)).toBeUndefined();
  });

  const atLimitBody = statusBody({
    at_limit: true,
    exhausted: ['seven_day'],
    grants: [fableGrant({ usable_now: true, unavailable_reason: null, blocking: [] })],
  });
  const posts = () => calls.filter((call) => call.method === 'POST');
  const postedRequestIds = () => posts().map((call) => JSON.parse(call.data ?? '{}').request_id);

  test('a second claim on the same seat while one is in flight sends nothing', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    route(async (payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      await held;
      return result(200, { result: 'reset', cleared: ['seven_day'], resets_left: 0 });
    });
    const first = claimClaudeReset(file, t, choice);
    const second = (await claimClaudeReset(file, t, choice).catch((err) => err)) as Error;
    expect(second.message).toContain('claude_quota.reset_in_progress');
    release();
    await first;
    expect(posts()).toHaveLength(1);
    // Once the first settles, the seat can be claimed again.
    await claimClaudeReset(file, t, choice);
    expect(posts()).toHaveLength(2);
  });

  test('using the reset again after an open outcome retries the same request id', async () => {
    let answer: ApiCallResult = result(502, { error: 'upstream' });
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      return answer;
    });
    await claimClaudeReset(file, t, choice).catch(() => undefined);
    await claimClaudeReset(file, t, choice).catch(() => undefined);
    answer = result(200, { result: 'reset', cleared: ['seven_day'], resets_left: 0 });
    await claimClaudeReset(file, t, choice);
    const ids = postedRequestIds();
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    // Settled by `reset`: the next claim is a new request.
    await claimClaudeReset(file, t, choice);
    expect(new Set(postedRequestIds()).size).toBe(2);
  });

  test('an open outcome is never later reported as nothing having been used', async () => {
    let status = usableBody;
    let answer: ApiCallResult = result(200, { result: 'unavailable' });
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, status);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      return answer;
    });
    const open = (await claimClaudeReset(file, t, choice).catch((err) => err)) as Error;
    expect(open.message).toContain('claude_quota.reset_outcome_unknown');
    const requestId = postedRequestIds()[0];

    // The first request landed after all: the grant reads spent before any POST.
    status = statusBody({ grants: [fableGrant({ resets_left: 0, usable_now: false })] });
    const spent = (await claimClaudeReset(file, t, choice).catch((err) => err)) as Error;
    expect(spent.message).toContain('claude_quota.reset_retry_unsettled');
    expect(spent.message).toContain(requestId);
    expect(spent.message).not.toContain('reset_not_claimed');
    expect(isResetOutcomeUnknown(spent)).toBe(true);
    expect(posts()).toHaveLength(1);

    // A retry Anthropic answers with a not-spent result still names the earlier request.
    status = usableBody;
    answer = result(200, { result: 'cooldown' });
    const cooled = (await claimClaudeReset(file, t, choice).catch((err) => err)) as Error;
    expect(cooled.message).toContain('claude_quota.reset_retry_unsettled');
    expect(postedRequestIds()).toEqual([requestId, requestId]);
  });

  test('an open outcome older than the retry window is not retried', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      route((payload) => {
        if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
        if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
        return result(502, { error: 'upstream' });
      });
      await claimClaudeReset(file, t, choice).catch(() => undefined);
      now += CLAUDE_RESET_RETRY_WINDOW_MS;
      await claimClaudeReset(file, t, choice).catch(() => undefined);
      expect(new Set(postedRequestIds()).size).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  test('spends nothing when the seat has left the limit the dialog was shown at', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      throw new Error(`unexpected url ${payload.url}`);
    });
    const error = (await claimClaudeReset(file, t, { ...choice, atLimit: true }).catch(
      (err) => err
    )) as Error;
    expect(error.message).toContain('claude_quota.reset_not_claimed');
    expect(error.message).toContain('reset_limit_cleared');
    expect(posts()).toHaveLength(0);
  });

  test('a seat still at its limit is claimed as the dialog said', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, atLimitBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      return result(200, { result: 'reset', cleared: ['seven_day'], resets_left: 0 });
    });
    await claimClaudeReset(file, t, { ...choice, atLimit: true });
    expect(posts()).toHaveLength(1);
  });

  test('the retry command quotes a file name the shell would split', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      return result(502, { error: 'upstream' });
    });
    const odd = { name: "claude seat's.json", auth_index: 'idx-2' } as unknown as AuthFileItem;
    const error = (await claimClaudeReset(odd, t, choice).catch((err) => err)) as Error;
    const params = JSON.parse(error.message.slice(error.message.indexOf('{')));
    expect(params.command).toStartWith(`cpa-route claude reset 'claude seat'\\''s.json' --grant `);
  });

  test('a spent reset whose read-back fails lands as a card error, not a failed claim', async () => {
    route((payload) => {
      if (payload.url === CLAUDE_RESET_STATUS_URL) return result(200, usableBody);
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { organization: { uuid: ORG } });
      if (payload.url === claimUrl)
        return result(200, { result: 'reset', cleared: ['seven_day'], resets_left: 0 });
      return result(500, { error: 'usage down' });
    });
    const data = await CLAUDE_CONFIG.resetQuota!(file, t, choice);
    expect(data.claimed).toEqual({ cleared: ['seven_day'], resetsLeft: 0 });
    const state = CLAUDE_CONFIG.buildSuccessState(data);
    expect(state.status).toBe('error');
    expect(state.error).toContain('claude_quota.reset_readback_failed');
    expect(CLAUDE_CONFIG.canResetQuota?.(state)).toBe(false);
  });
});

describe('a claim request id', () => {
  test('is a v4 UUID even where crypto.randomUUID is missing (plain HTTP)', () => {
    const cryptoApi = globalThis.crypto as { randomUUID?: unknown };
    const original = cryptoApi.randomUUID;
    Object.defineProperty(cryptoApi, 'randomUUID', { value: undefined, configurable: true });
    try {
      const id = newClaudeResetRequestId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(newClaudeResetRequestId()).not.toBe(id);
    } finally {
      Object.defineProperty(cryptoApi, 'randomUUID', { value: original, configurable: true });
    }
  });
});

describe('the live fetch and the card', () => {
  test('a reset status failure does not fail the card', async () => {
    apiCallApi.request = (async (payload: ApiCallRequest) => {
      if (payload.url === CLAUDE_USAGE_URL)
        return result(200, { seven_day: { utilization: 10, resets_at: null } });
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { account: {} });
      return result(500, { error: 'boom' });
    }) as typeof apiCallApi.request;
    const data = await CLAUDE_CONFIG.fetchQuota(file, t);
    expect(data.windows.length).toBeGreaterThan(0);
    expect(data.resets?.error).toContain('500');
  });

  test('keeps the canonical usage GET exactly as it was', async () => {
    const urls: string[] = [];
    apiCallApi.request = (async (payload: ApiCallRequest) => {
      urls.push(payload.url);
      if (payload.url === CLAUDE_USAGE_URL)
        return result(200, { seven_day: { utilization: 10, resets_at: null } });
      if (payload.url === CLAUDE_PROFILE_URL) return result(200, { account: {} });
      return result(200, statusBody());
    }) as typeof apiCallApi.request;
    await CLAUDE_CONFIG.fetchQuota(file, t);
    expect(urls).toEqual([CLAUDE_USAGE_URL, CLAUDE_PROFILE_URL, CLAUDE_RESET_STATUS_URL]);
  });

  test('offers a reset only when a grant is usable now', () => {
    const blocked: ClaudeQuotaState = { status: 'success', windows: [], resets: info() };
    const open: ClaudeQuotaState = {
      status: 'success',
      windows: [],
      resets: info({ grants: [fableGrant({ usable_now: true, unavailable_reason: null })] }),
    };
    const nothingBack: ClaudeQuotaState = {
      status: 'success',
      windows: [],
      resets: infoNoShare({ grants: [fableGrant({ usable_now: true, unavailable_reason: null })] }),
    };
    expect(CLAUDE_CONFIG.canResetQuota?.(blocked)).toBe(false);
    expect(CLAUDE_CONFIG.canResetQuota?.(open)).toBe(true);
    expect(CLAUDE_CONFIG.canResetQuota?.(nothingBack)).toBe(false);
    expect(CLAUDE_CONFIG.canResetQuota?.({ status: 'success', windows: [] })).toBe(false);
  });
});

describe('the words around a reset', () => {
  test('Codex keeps its own keys and the file name', () => {
    const confirmation = buildResetConfirmation(
      QUOTA_ADAPTERS.codex,
      file,
      { status: 'success' },
      t
    );
    expect(confirmation).toEqual({
      title: 'codex_quota.reset_confirm_title',
      message: 'codex_quota.reset_confirm_message {"name":"claude-seat.json"}',
      confirmText: 'codex_quota.reset_confirm_button',
    });
    expect(resetSuccessNotice(QUOTA_ADAPTERS.codex, file, {}, t)).toBe(
      'codex_quota.reset_success {"name":"claude-seat.json"}'
    );
  });

  test('Claude names the grant it will spend and what it gives back', () => {
    const quota = {
      status: 'success',
      windows: [],
      resets: info({ grants: [fableGrant({ usable_now: true, unavailable_reason: null })] }),
    } as QuotaCardState;
    const confirmation = buildResetConfirmation(QUOTA_ADAPTERS.claude, file, quota, t)!;
    expect(confirmation.option).toEqual({ grantId: 'launch-2610-fable', atLimit: false });
    expect(confirmation.message).toContain('claude_quota.reset_confirm_message_fable');
    expect(confirmation.message).toContain('"share":"12%"');
    expect(confirmation.message).toContain('"left":1');
    expect(confirmation.message).toContain(
      '"label":"New model launch: one Fable reset for Max, Team Premium and Enterprise Premium"'
    );
  });

  test('Claude says when the seat is not at a limit the reset program counts', () => {
    const grants = [fableGrant({ usable_now: true, unavailable_reason: null })];
    const confirm = (atLimit: boolean) =>
      buildResetConfirmation(
        QUOTA_ADAPTERS.claude,
        file,
        {
          status: 'success',
          windows: [],
          resets: info({ grants, at_limit: atLimit }),
        } as QuotaCardState,
        t
      )!.message;
    expect(confirm(false)).toContain('claude_quota.reset_confirm_not_at_limit_fable');
    expect(confirm(true)).not.toContain('reset_confirm_not_at_limit');
    const weekly = buildResetConfirmation(
      QUOTA_ADAPTERS.claude,
      file,
      {
        status: 'success',
        windows: [],
        resets: info({
          grants: [
            fableGrant({
              usable_now: true,
              unavailable_reason: null,
              gives_back_weekly: false,
              type: 'weekly',
              clears: ['seven_day'],
            }),
          ],
        }),
      } as QuotaCardState,
      t
    )!.message;
    expect(weekly).toContain('claude_quota.reset_confirm_message ');
    expect(weekly).toContain('claude_quota.reset_confirm_not_at_limit ');
  });

  test('Claude asks nothing when nothing can be spent', () => {
    const quota = { status: 'success', windows: [], resets: info() } as QuotaCardState;
    expect(buildResetConfirmation(QUOTA_ADAPTERS.claude, file, quota, t)).toBeNull();
  });
});

describe('the supplement for cards painted from the listing', () => {
  const adapter = QUOTA_ADAPTERS.claude;
  const entry = (name: string): QuotaFileEntry =>
    ({ file: { name }, type: 'claude' }) as QuotaFileEntry;
  const seeded = (observedAtMs: number): QuotaCardState =>
    ({ status: 'success', windows: [], observedAtMs }) as QuotaCardState;

  test('asks once for each seeded card without resets', () => {
    const current = {
      'a.json': seeded(1),
      'b.json': { ...seeded(1), resets: info() } as QuotaCardState,
      'c.json': { status: 'loading' } as QuotaCardState,
    };
    const pending = pendingSupplements(
      [entry('a.json'), entry('b.json'), entry('c.json'), entry('d.json')],
      current,
      adapter,
      new Set()
    );
    expect(pending.map((item) => item.file.name)).toEqual(['a.json']);
    expect(
      pendingSupplements([entry('a.json')], current, adapter, new Set(['claude:a.json']))
    ).toEqual([]);
  });

  test('merges into a card that still needs it and never changes its status', () => {
    const merged = mergeSupplement(
      { 'a.json': seeded(1) },
      'a.json',
      { resets: info() } as Partial<QuotaCardState>,
      adapter
    );
    expect((merged?.['a.json'] as ClaudeQuotaState).resets?.grants).toHaveLength(1);
    expect(merged?.['a.json'].status).toBe('success');
  });

  test('is not sent once a live fetch has started while it waited in the queue', () => {
    expect(stillNeedsSupplement({ 'a.json': seeded(1) }, 'a.json', adapter)).toBe(true);
    expect(stillNeedsSupplement({ 'a.json': { status: 'loading' } }, 'a.json', adapter)).toBe(
      false
    );
    expect(stillNeedsSupplement({}, 'a.json', adapter)).toBe(false);
  });

  test('drops the answer once a live fetch has started or landed', () => {
    const patch = { resets: info() } as Partial<QuotaCardState>;
    expect(
      mergeSupplement({ 'a.json': { status: 'loading' } }, 'a.json', patch, adapter)
    ).toBeNull();
    const live = { status: 'success', windows: [], resets: info({ grants: [] }) } as QuotaCardState;
    expect(mergeSupplement({ 'a.json': live }, 'a.json', patch, adapter)).toBeNull();
  });

  test('a newer seed keeps the resets the older one was given', () => {
    const withResets = { 'a.json': { ...seeded(1), resets: info() } as QuotaCardState };
    const seedAdapter = { ...adapter, deriveQuota: () => seeded(2) };
    const next = seedDerivedQuota([entry('a.json')], withResets, seedAdapter, t);
    expect(next?.['a.json'].observedAtMs).toBe(2);
    expect((next?.['a.json'] as ClaudeQuotaState).resets?.grants).toHaveLength(1);
  });
});
