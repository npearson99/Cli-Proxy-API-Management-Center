import { afterEach, describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { CLAUDE_CONFIG } from '@/features/quota/providers/claude/data';
import { apiCallApi, type ApiCallRequest, type ApiCallResult } from '@/services/api';
import { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL, getStatusFromError } from '@/utils/quota';
import type { AuthFileItem } from '@/types';

const t = ((key: string) => key) as unknown as TFunction;
const originalRequest = apiCallApi.request;

const result = (statusCode: number, body: unknown = null): ApiCallResult => ({
  statusCode,
  header: {},
  bodyText: body === null ? '' : JSON.stringify(body),
  body,
});

/** Anthropic's answer to a *dead* token on the usage endpoint — a rate-limit error. */
const RATE_LIMITED = { error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' } };
const TOKEN_EXPIRED = {
  type: 'error',
  error: { type: 'authentication_error', message: 'OAuth access token has expired.' },
};

const file = { name: 'claude-seat.json', auth_index: 'idx-1' } as unknown as AuthFileItem;

const route = (usage: ApiCallResult, profile: ApiCallResult) => {
  apiCallApi.request = (async (payload: ApiCallRequest) => {
    if (payload.url === CLAUDE_USAGE_URL) return usage;
    if (payload.url === CLAUDE_PROFILE_URL) return profile;
    throw new Error(`unexpected url ${payload.url}`);
  }) as typeof apiCallApi.request;
};

const fetchQuota = () => CLAUDE_CONFIG.fetchQuota(file, t);

afterEach(() => {
  apiCallApi.request = originalRequest;
});

describe('a 429 on the usage endpoint: dead token or real rate limit', () => {
  test('names an expired token as expired, not as a rate limit', async () => {
    // The two are word-for-word identical upstream; only the profile call separates
    // them, and reading a dead seat as throttled sends you to wait out a window that
    // is not running.
    route(result(429, RATE_LIMITED), result(401, TOKEN_EXPIRED));

    const error = await fetchQuota().catch((err: unknown) => err);
    expect((error as Error).message).toBe('claude_quota.token_expired');
    expect(getStatusFromError(error)).toBe(429);
  });

  test('leaves a genuine rate limit reading as a rate limit', async () => {
    route(result(429, RATE_LIMITED), result(200, { account: {} }));

    const error = await fetchQuota().catch((err: unknown) => err);
    expect((error as Error).message).toContain('Rate limited');
    expect((error as Error).message).not.toContain('token_expired');
  });

  test('does not convict a seat when the profile call fails some other way', async () => {
    // A 5xx or a network error says nothing about the token.
    for (const profile of [result(500), result(403)]) {
      route(result(429, RATE_LIMITED), profile);
      const error = await fetchQuota().catch((err: unknown) => err);
      expect((error as Error).message).toContain('Rate limited');
    }
  });

  test('spends nothing on the profile endpoint when usage fails for another reason', async () => {
    let profileCalls = 0;
    apiCallApi.request = (async (payload: ApiCallRequest) => {
      if (payload.url === CLAUDE_PROFILE_URL) {
        profileCalls += 1;
        return result(401, TOKEN_EXPIRED);
      }
      return result(503);
    }) as typeof apiCallApi.request;

    await fetchQuota().catch(() => undefined);
    expect(profileCalls).toBe(0);
  });

  test('still reports the plan tier on the happy path', async () => {
    route(
      result(200, { five_hour: { utilization: 6, resets_at: null } }),
      result(200, { account: { has_claude_max: true } })
    );

    const data = (await fetchQuota()) as { planType?: string | null };
    expect(data.planType).toBe('plan_max');
  });
});
