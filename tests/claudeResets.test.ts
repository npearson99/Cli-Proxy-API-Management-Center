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
  freeReadKey,
  freeReadsAskedIn,
  mergePrime,
  mergeSupplement,
  pendingFreeReads,
  scheduleFreeReads,
  stillNeedsSupplement,
  type FreeReadContext,
} from '@/features/quota/supplement';
import type { FetchQueue } from '@/features/quota/fetchQueue';
import {
  claudeGrantRowId,
  collectQuotaRowInstants,
  nextRecoveryMs,
  pickUrgentRowId,
} from '@/features/quota/resetSchedule';
import { buildTimelineLane, projectResetCredits } from '@/features/quota/quotaTimelineModel';
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
    const pending = pendingFreeReads(
      [entry('a.json'), entry('b.json'), entry('c.json'), entry('d.json')],
      current,
      adapter,
      new Set()
    );
    // d.json, which nothing painted, wants its prime: the same one read.
    expect(pending.map((item) => item.file.name)).toEqual(['a.json', 'd.json']);
    expect(
      pendingFreeReads([entry('a.json')], current, adapter, new Set(['claude:a.json']))
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

describe('priming a card nothing has painted', () => {
  const adapter = QUOTA_ADAPTERS.claude;
  const entry = (name: string, disabled = false): QuotaFileEntry =>
    ({ file: { name, disabled }, type: 'claude' }) as QuotaFileEntry;

  test('paints windows and banked resets from the one reset-status read', async () => {
    const urls: string[] = [];
    apiCallApi.request = (async (payload: ApiCallRequest) => {
      urls.push(payload.url);
      return result(
        200,
        statusBody(
          {},
          {
            seven_day: { utilization: 40, resets_at: '2026-11-17T13:00:00+00:00' },
            extra_usage: null,
          }
        )
      );
    }) as typeof apiCallApi.request;
    const data = await CLAUDE_CONFIG.primeQuota!(file, t);
    expect(urls).toEqual([CLAUDE_RESET_STATUS_URL]);
    expect(data.windows.map((window) => window.id)).toContain('seven-day');
    expect(data.windows.find((window) => window.id === 'seven-day')?.usedPercent).toBe(40);
    expect(data.resets?.grants.map((grant) => grant.id)).toEqual(['launch-2610-fable']);
    expect(data.planType).toBeUndefined();
    const state = CLAUDE_CONFIG.buildSuccessState(data);
    expect(state.status).toBe('success');
    expect(state.observedAtMs).toBeUndefined();
  });

  test('a 429 on a dead token says so, like a refresh does', async () => {
    const urls: string[] = [];
    apiCallApi.request = (async (payload: ApiCallRequest) => {
      urls.push(payload.url);
      if (payload.url === CLAUDE_PROFILE_URL) return result(401, { error: 'expired' });
      return result(429, { error: { type: 'rate_limit_error' } });
    }) as typeof apiCallApi.request;
    await expect(CLAUDE_CONFIG.primeQuota!(file, t)).rejects.toThrow('claude_quota.token_expired');
    expect(urls).toEqual([CLAUDE_RESET_STATUS_URL, CLAUDE_PROFILE_URL]);
  });

  test('an unreadable body fails rather than painting an empty card', async () => {
    apiCallApi.request = (async () => ({
      statusCode: 200,
      header: {},
      bodyText: 'not json',
      body: undefined,
    })) as typeof apiCallApi.request;
    await expect(CLAUDE_CONFIG.primeQuota!(file, t)).rejects.toThrow('claude_quota.empty_windows');
  });

  test('is asked once for each card nothing has painted', () => {
    const current = {
      'fetched.json': { status: 'success', resets: info() } as QuotaCardState,
      'loading.json': { status: 'loading' } as QuotaCardState,
      'idle.json': { status: 'idle' } as QuotaCardState,
      'failed.json': { status: 'error' } as QuotaCardState,
    };
    const entries = [
      entry('fetched.json'),
      entry('loading.json'),
      entry('idle.json'),
      entry('failed.json'),
      entry('empty.json'),
      entry('disabled.json', true),
    ];
    expect(
      pendingFreeReads(entries, current, adapter, new Set()).map((item) => item.file.name)
    ).toEqual(['idle.json', 'empty.json']);
    expect(
      pendingFreeReads(entries, current, adapter, new Set([freeReadKey(entry('empty.json'))])).map(
        (item) => item.file.name
      )
    ).toEqual(['idle.json']);
  });

  test('a provider without a prime is never primed', () => {
    const codex = QUOTA_ADAPTERS.codex;
    expect(
      pendingFreeReads(
        [{ file: { name: 'c.json' }, type: 'codex' } as QuotaFileEntry],
        {},
        codex,
        new Set()
      )
    ).toEqual([]);
  });

  test('drops its answer once a click, a refresh or a fetch painted the card', () => {
    const primed = { status: 'success', windows: [], resets: info() } as QuotaCardState;
    expect(mergePrime({}, 'a.json', primed, adapter)?.['a.json']).toBe(primed);
    expect(mergePrime({ 'a.json': { status: 'idle' } }, 'a.json', primed, adapter)).not.toBeNull();
    for (const painted of [
      { status: 'loading' },
      { status: 'success', resets: info({ grants: [] }) },
      { status: 'error' },
      { status: 'success', observedAtMs: 1, resets: info({ grants: [] }) },
    ] as QuotaCardState[]) {
      expect(mergePrime({ 'a.json': painted }, 'a.json', primed, adapter)).toBeNull();
    }
  });

  test('on a card a seed painted meanwhile it adds the resets and keeps the windows', () => {
    const seed = { status: 'success', windows: [], observedAtMs: 7 } as QuotaCardState;
    const primed = { status: 'success', windows: [], resets: info() } as QuotaCardState;
    const merged = mergePrime({ 'a.json': seed }, 'a.json', primed, adapter)?.[
      'a.json'
    ] as ClaudeQuotaState;
    expect(merged.observedAtMs).toBe(7);
    expect(merged.resets?.grants).toHaveLength(1);
    // A failure never replaces a seed.
    const failed = { status: 'error', error: 'x', primeFailed: true } as QuotaCardState;
    expect(mergePrime({ 'a.json': seed }, 'a.json', failed, adapter)).toBeNull();
  });

  test('a seed replaces an error a prime painted, never one a refresh did', () => {
    const seedAdapter = {
      ...adapter,
      deriveQuota: () => ({ status: 'success', observedAtMs: 5 }) as QuotaCardState,
    };
    const primeFailed = { status: 'error', error: 'x', primeFailed: true } as QuotaCardState;
    const refreshFailed = { status: 'error', error: 'x' } as QuotaCardState;
    const replaced = seedDerivedQuota([entry('a.json')], { 'a.json': primeFailed }, seedAdapter, t)?.[
      'a.json'
    ];
    expect(replaced?.observedAtMs).toBe(5);
    expect(replaced?.primeFailed).toBeUndefined();
    expect(
      seedDerivedQuota([entry('a.json')], { 'a.json': refreshFailed }, seedAdapter, t)
    ).toBeNull();
  });

  test('a primed card is never asked for a supplement', () => {
    const primed = CLAUDE_CONFIG.buildSuccessState({ windows: [], resets: info() });
    expect(adapter.needsSupplement?.(primed as QuotaCardState)).toBe(false);
  });
});

describe('one free read per card, whatever lands meanwhile', () => {
  const adapter = QUOTA_ADAPTERS.claude;
  const entry = (name: string): QuotaFileEntry =>
    ({ file: { name, auth_index: `idx-${name}` }, type: 'claude' }) as unknown as QuotaFileEntry;
  const seeded = (observedAtMs: number): QuotaCardState =>
    ({ status: 'success', windows: [], observedAtMs }) as QuotaCardState;

  /** A queue the test lets go one task at a time, and upstream answers it holds. */
  const harness = (initial: Record<string, QuotaCardState> = {}) => {
    const released: (() => void)[] = [];
    const queue: FetchQueue = {
      run: <T>(task: () => Promise<T>) =>
        new Promise<void>((resolve) => released.push(resolve)).then(task),
    };
    const answers: { url: string; answer: (value: ApiCallResult) => void }[] = [];
    apiCallApi.request = ((payload: ApiCallRequest) =>
      new Promise<ApiCallResult>((resolve) =>
        answers.push({ url: payload.url, answer: resolve })
      )) as typeof apiCallApi.request;
    const state = { store: initial, current: true };
    const ctx: FreeReadContext = {
      adapter,
      t,
      queue,
      asked: new Set(),
      isCurrent: () => state.current,
      read: () => state.store,
      write: (update) => {
        if (state.current) state.store = update(state.store);
      },
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
      ctx,
      state,
      answers,
      waiting: () => released.length,
      release: async () => {
        released.shift()?.();
        await settle();
      },
      answer: async (value: ApiCallResult) => {
        answers.shift()?.answer(value);
        await settle();
      },
      settle,
    };
  };

  test('re-running on every store change asks each card once', async () => {
    const h = harness({ 'seeded.json': seeded(1) });
    const entries = [entry('seeded.json'), entry('blank.json')];
    scheduleFreeReads(entries, h.ctx);
    scheduleFreeReads(entries, h.ctx);
    expect(h.waiting()).toBe(2);
    await h.release();
    await h.release();
    expect(h.answers.map((item) => item.url)).toEqual([
      CLAUDE_RESET_STATUS_URL,
      CLAUDE_RESET_STATUS_URL,
    ]);
    await h.answer(result(200, statusBody()));
    await h.answer(result(200, statusBody()));
    const store = h.state.store as Record<string, ClaudeQuotaState>;
    expect(store['seeded.json'].observedAtMs).toBe(1);
    expect(store['seeded.json'].resets?.grants).toHaveLength(1);
    expect(store['blank.json'].status).toBe('success');
    expect(store['blank.json'].resets?.grants).toHaveLength(1);
    scheduleFreeReads(entries, h.ctx);
    expect(h.waiting()).toBe(0);
  });

  test('a prime out when a seed paints the card gives the seed its resets, and nothing more is sent', async () => {
    const h = harness();
    scheduleFreeReads([entry('a.json')], h.ctx);
    await h.release();
    expect(h.answers).toHaveLength(1);
    h.state.store = { 'a.json': seeded(9) };
    // The page re-runs on the seed: the card's read is already out.
    scheduleFreeReads([entry('a.json')], h.ctx);
    expect(h.waiting()).toBe(0);
    await h.answer(result(200, statusBody()));
    const card = h.state.store['a.json'] as ClaudeQuotaState;
    expect(card.observedAtMs).toBe(9);
    expect(card.resets?.grants).toHaveLength(1);
    expect(h.answers).toHaveLength(0);
  });

  test('a prime still waiting when a seed paints the card goes as its supplement', async () => {
    const h = harness();
    scheduleFreeReads([entry('a.json')], h.ctx);
    h.state.store = { 'a.json': seeded(9) };
    scheduleFreeReads([entry('a.json')], h.ctx);
    expect(h.waiting()).toBe(1);
    await h.release();
    expect(h.answers.map((item) => item.url)).toEqual([CLAUDE_RESET_STATUS_URL]);
    await h.answer(result(200, statusBody()));
    const card = h.state.store['a.json'] as ClaudeQuotaState;
    expect(card.observedAtMs).toBe(9);
    expect(card.resets?.grants).toHaveLength(1);
  });

  test('a failed prime paints the error, and a later seed still gets its supplement', async () => {
    const h = harness();
    scheduleFreeReads([entry('a.json')], h.ctx);
    await h.release();
    await h.answer(result(500, { error: 'boom' }));
    expect(h.state.store['a.json'].status).toBe('error');
    expect(h.state.store['a.json'].primeFailed).toBe(true);
    // Re-run on the error itself: nothing to ask for.
    scheduleFreeReads([entry('a.json')], h.ctx);
    expect(h.waiting()).toBe(0);
    h.state.store = seedDerivedQuota(
      [entry('a.json')],
      h.state.store,
      { ...adapter, deriveQuota: () => seeded(3) },
      t
    )!;
    scheduleFreeReads([entry('a.json')], h.ctx);
    expect(h.waiting()).toBe(1);
    await h.release();
    await h.answer(result(200, statusBody()));
    expect((h.state.store['a.json'] as ClaudeQuotaState).resets?.grants).toHaveLength(1);
  });

  test('a prime that fails after a seed painted the card asks for its supplement itself', async () => {
    const h = harness();
    scheduleFreeReads([entry('a.json')], h.ctx);
    await h.release();
    h.state.store = { 'a.json': seeded(4) };
    await h.answer(result(500, { error: 'boom' }));
    // The seed stands, and the store did not change, so no re-render would ask for it.
    expect(h.state.store['a.json'].observedAtMs).toBe(4);
    expect(h.waiting()).toBe(1);
    await h.release();
    await h.answer(result(200, statusBody()));
    expect((h.state.store['a.json'] as ClaudeQuotaState).resets?.grants).toHaveLength(1);
  });

  test('a click while the prime waits makes it moot', async () => {
    const h = harness();
    scheduleFreeReads([entry('a.json')], h.ctx);
    h.state.store = { 'a.json': { status: 'loading' } };
    await h.release();
    expect(h.answers).toHaveLength(0);
    expect(h.state.store['a.json'].status).toBe('loading');
  });

  test('a cleared cache sends nothing it asked for and writes nothing', async () => {
    const h = harness();
    scheduleFreeReads([entry('a.json')], h.ctx);
    h.state.current = false;
    await h.release();
    expect(h.answers).toHaveLength(0);
    expect(h.state.store).toEqual({});
  });

  test('what was asked for outlives a mount of the page, until the cache is cleared', () => {
    const first = freeReadsAskedIn(41);
    first.add('claude:a.json');
    expect(freeReadsAskedIn(41).has('claude:a.json')).toBe(true);
    expect(freeReadsAskedIn(42).has('claude:a.json')).toBe(false);
  });
});

describe('banked resets on the schedule and the timeline', () => {
  const ENDS = '2027-03-09T07:59:00+00:00';
  const endsMs = Date.parse(ENDS);
  const card = (grants: Record<string, unknown>[]): ClaudeQuotaState => ({
    status: 'success',
    windows: [],
    resets: info({ grants }),
  });

  test('a grant still holding a reset is a use-by instant; a spent one is not', () => {
    const instants = collectQuotaRowInstants(
      'claude',
      card([
        fableGrant({ ends_at: ENDS }),
        fableGrant({ id: 'launch-2610-fable-6mo', resets_left: 0 }),
      ])
    );
    expect(instants).toEqual([
      {
        rowId: claudeGrantRowId({ id: 'launch-2610-fable' }),
        atMs: endsMs,
        kind: 'credit',
        weekly: false,
      },
    ]);
  });

  test('takes the emphasis only in its last hour, like a Codex credit', () => {
    const quota = card([fableGrant({ ends_at: ENDS })]);
    const instants = collectQuotaRowInstants('claude', quota);
    expect(pickUrgentRowId(instants, endsMs - 2 * 60 * 60 * 1000)).toBeNull();
    expect(pickUrgentRowId(instants, endsMs - 30 * 60 * 1000)).toBe('grant:launch-2610-fable');
    expect(nextRecoveryMs('claude', quota, endsMs - 1000)).toBe(endsMs);
  });

  test('the row id never collides with a window id', () => {
    expect(claudeGrantRowId({ id: 'seven-day' })).not.toBe('seven-day');
  });

  test('the timeline marks where each banked reset must be used by', () => {
    const quota = {
      ...card([
        fableGrant({ ends_at: ENDS }),
        fableGrant({ id: 'launch-2610-fable-6mo', resets_left: 0 }),
      ]),
      windows: [
        {
          id: 'seven-day',
          label: '7-day',
          usedPercent: 40,
          resetLabel: '',
          resetAtMs: endsMs - 3 * 24 * 60 * 60 * 1000,
          periodHours: 168,
        },
      ],
    };
    const lane = buildTimelineLane({
      name: 'a.json',
      displayName: 'a.json',
      provider: 'claude',
      quota,
    });
    expect(lane.resetCredits).toEqual([
      {
        id: 'launch-2610-fable',
        grantedAtMs: Date.parse('2026-11-09T18:00:00+00:00'),
        expiresAtMs: endsMs,
      },
    ]);
    const marks = projectResetCredits(lane, endsMs - 7 * 864e5, endsMs + 7 * 864e5, endsMs - 864e5);
    expect(marks).toHaveLength(1);
    expect(marks[0].leftPercent).toBe(50);
  });
});
