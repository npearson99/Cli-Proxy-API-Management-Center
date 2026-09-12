/**
 * Claude 额度数据层：用量窗口 + 套餐 + 额外用量。
 * React-free / SCSS-free —— 由 tests/claudeFableQuota.test.ts 直接消费。
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  ClaudeExtraUsage,
  ClaudeProfileResponse,
  ClaudeQuotaState,
  ClaudeQuotaWindow,
  ClaudeUsagePayload,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_FABLE_WINDOW_ID,
  CLAUDE_FABLE_WINDOW_LABEL_KEY,
  CLAUDE_USAGE_WINDOW_KEYS,
  claudePeriodHours,
  normalizeNumberValue,
  normalizeStringValue,
  parseClaudeUsagePayload,
  formatQuotaResetTime,
  resolveResetMs,
  createStatusError,
  isClaudeFile,
  isDisabledAuthFile,
} from '@/utils/quota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaProviderData } from '../types';
import { buildClaudeQuotaFromSignals } from './signals';

export type ClaudeQuotaData = {
  windows: ClaudeQuotaWindow[];
  extraUsage?: ClaudeExtraUsage | null;
  planType?: string | null;
};

const findFableUsageLimit = (payload: ClaudeUsagePayload) => {
  if (!Array.isArray(payload.limits)) return null;

  const candidates = payload.limits.filter((limit) => {
    const kind = (normalizeStringValue(limit?.kind) ?? '').trim().toLowerCase();
    const modelName = (normalizeStringValue(limit?.scope?.model?.display_name) ?? '')
      .trim()
      .toLowerCase();
    const isFable = modelName === 'fable' || modelName === 'fable 5';
    return kind === 'weekly_scoped' && isFable && normalizeNumberValue(limit?.percent) !== null;
  });

  return candidates.find((limit) => limit.is_active === true) ?? candidates[0] ?? null;
};

export const buildClaudeQuotaWindows = (
  payload: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaWindow[] => {
  const windows: ClaudeQuotaWindow[] = [];
  const fableLimit = findFableUsageLimit(payload);

  for (const { key, id, labelKey } of CLAUDE_USAGE_WINDOW_KEYS) {
    if (key === 'iguana_necktie' && fableLimit) continue;
    const window = payload[key as keyof ClaudeUsagePayload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) continue;
    const typedWindow = window as { utilization: number; resets_at: string | null };
    const usedPercent = normalizeNumberValue(typedWindow.utilization);
    const resetLabel = formatQuotaResetTime(typedWindow.resets_at ?? undefined);
    windows.push({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent,
      resetLabel,
      // Claude states the period nowhere in the payload, so it comes from the
      // key: `five_hour` is the rolling window, everything else is weekly.
      resetAtMs: resolveResetMs([typedWindow.resets_at]),
      periodHours: claudePeriodHours(key),
    });
  }

  if (fableLimit) {
    const usedPercent = normalizeNumberValue(fableLimit.percent);
    if (usedPercent !== null) {
      windows.push({
        id: CLAUDE_FABLE_WINDOW_ID,
        label: t(CLAUDE_FABLE_WINDOW_LABEL_KEY),
        labelKey: CLAUDE_FABLE_WINDOW_LABEL_KEY,
        usedPercent,
        resetLabel: formatQuotaResetTime(fableLimit.resets_at ?? undefined),
        // `weekly_scoped` is a 7-day window by definition, so the timeline can
        // place this row alongside the ones derived from the named keys.
        resetAtMs: resolveResetMs([fableLimit.resets_at]),
        periodHours: claudePeriodHours('seven_day'),
      });
    }
  }

  return windows;
};

const normalizeFlagValue = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(trimmed)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(trimmed)) return false;
  }
  return undefined;
};

const parseClaudeProfilePayload = (payload: unknown): ClaudeProfileResponse | null => {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as ClaudeProfileResponse;
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') {
    return payload as ClaudeProfileResponse;
  }
  return null;
};

const resolveClaudePlanType = (profile: ClaudeProfileResponse | null): string | null => {
  if (!profile) return null;

  const hasClaudeMax = normalizeFlagValue(profile.account?.has_claude_max);
  if (hasClaudeMax) return 'plan_max';

  const hasClaudePro = normalizeFlagValue(profile.account?.has_claude_pro);
  if (hasClaudePro) return 'plan_pro';

  const organizationType = normalizeStringValue(
    profile.organization?.organization_type
  )?.toLowerCase();
  const subscriptionStatus = normalizeStringValue(
    profile.organization?.subscription_status
  )?.toLowerCase();

  if (organizationType === 'claude_team' && subscriptionStatus === 'active') {
    return 'plan_team';
  }

  if (hasClaudeMax === false && hasClaudePro === false) return 'plan_free';

  return null;
};

const fetchClaudeProfile = (authIndex: string) =>
  apiCallApi
    .request({
      authIndex,
      method: 'GET',
      url: CLAUDE_PROFILE_URL,
      header: { ...CLAUDE_REQUEST_HEADERS },
    })
    .catch(() => null);

/**
 * Whether this credential's access token is expired rather than throttled.
 *
 * 401 only. A profile call that fails any other way says nothing about the token
 * — a network error or a 5xx would otherwise convict a seat that is merely rate
 * limited, which is the misreading this exists to prevent.
 */
const claudeTokenIsDead = async (authIndex: string): Promise<boolean> => {
  const profile = await fetchClaudeProfile(authIndex);
  return profile?.statusCode === 401;
};

const fetchClaudeQuota = async (file: AuthFileItem, t: TFunction): Promise<ClaudeQuotaData> => {
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndex = normalizeAuthIndex(rawAuthIndex);
  if (!authIndex) {
    throw new Error(t('claude_quota.missing_auth_index'));
  }

  // Usage first and alone, then the profile: a card holds one slot in the fetch
  // queue, and asking for both at once would put two requests on the wire per
  // slot — twice the burst the queue exists to bound, against the limiter that
  // rejects bursts. Ordering them also spends nothing on the plan tier when the
  // usage call has just been refused, which is the case that matters here.
  const result = await apiCallApi.request({
    authIndex,
    method: 'GET',
    url: CLAUDE_USAGE_URL,
    header: { ...CLAUDE_REQUEST_HEADERS },
  });

  if (result.statusCode < 200 || result.statusCode >= 300) {
    // A dead OAuth token and a real rate limit are the same answer here: Anthropic
    // rejects an expired token on the usage endpoint with 429 `rate_limit_error`,
    // word for word what it sends a client that asked too often. Reading that as a
    // limit sends you to wait out a window that is not running, when what the seat
    // needs is a live credential copied from a box that still refreshes it.
    //
    // Retry-After does not separate them — a dead seat answered 457s here, inside
    // the range a genuine limit uses. The profile endpoint does, in one extra
    // request spent only on the failing card: a dead token 401s there while a
    // rate-limited one still answers 200.
    if (result.statusCode === 429 && (await claudeTokenIsDead(authIndex))) {
      throw createStatusError(t('claude_quota.token_expired'), result.statusCode);
    }
    throw createStatusError(getApiCallErrorMessage(result), result.statusCode);
  }

  const payload = parseClaudeUsagePayload(result.body ?? result.bodyText);
  if (!payload) {
    throw new Error(t('claude_quota.empty_windows'));
  }

  const windows = buildClaudeQuotaWindows(payload, t);
  const profileResult = await fetchClaudeProfile(authIndex);
  const planType =
    profileResult && profileResult.statusCode >= 200 && profileResult.statusCode < 300
      ? resolveClaudePlanType(
          parseClaudeProfilePayload(profileResult.body ?? profileResult.bodyText)
        )
      : null;

  return { windows, extraUsage: payload.extra_usage, planType };
};

export const CLAUDE_CONFIG: QuotaProviderData<ClaudeQuotaState, ClaudeQuotaData> = {
  type: 'claude',
  i18nPrefix: 'claude_quota',
  filterFn: (file) => isClaudeFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchClaudeQuota,
  deriveQuota: (file, t) => {
    const derived = buildClaudeQuotaFromSignals(file, t);
    if (!derived) return null;
    return {
      status: 'success',
      windows: derived.windows,
      observedAtMs: derived.observedAtMs,
    };
  },
  storeSelector: (state) => state.claudeQuota,
  storeSetter: 'setClaudeQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: data.windows,
    extraUsage: data.extraUsage,
    planType: data.planType,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
};
