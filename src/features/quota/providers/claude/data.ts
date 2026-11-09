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
  ClaudeResetGrant,
  ClaudeResetInfo,
  ClaudeUsagePayload,
} from '@/types';
import { apiCallApi, getApiCallErrorMessage } from '@/services/api';
import {
  CLAUDE_PROFILE_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_REQUEST_HEADERS,
  CLAUDE_RESET_HEADERS,
  CLAUDE_RESET_PROGRAM,
  CLAUDE_RESET_RETRY_SETTLED,
  CLAUDE_RESET_STATUS_URL,
  claudeGrantGivesNothingBack,
  claudeResetClaimUrl,
  claudeResetKind,
  claudeResetReason,
  claudeResetReasonKey,
  classifyClaudeResetClaim,
  formatInstantShort,
  getStatusFromError,
  isClaudeOrganizationUuid,
  isUsableClaudeGrant,
  newClaudeResetRequestId,
  parseClaudeResetInfo,
  parseIsoToMs,
  pickClaudeResetGrant,
  shellWord,
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
import { resetOutcomeUnknownError } from '../../resetCopy';
import type { QuotaProviderData, QuotaResetDescription } from '../types';
import { buildClaudeQuotaFromSignals } from './signals';

export type ClaudeQuotaData = {
  windows: ClaudeQuotaWindow[];
  extraUsage?: ClaudeExtraUsage | null;
  planType?: string | null;
  resets?: ClaudeResetInfo;
  /** Set by a reset that spent a grant: what it refilled, for the notice. */
  claimed?: { cleared: string[]; resetsLeft: number | null };
  /** Set when a reset was spent but reading the seat back failed; the card shows it. */
  readbackError?: string;
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

/**
 * The seat's banked resets. Never throws: a card whose windows loaded must not fail
 * because the reset program could not be read, so the failure rides in `error`.
 */
export const fetchClaudeResets = async (
  authIndex: string,
  t: TFunction
): Promise<ClaudeResetInfo> => {
  const invalid = t('claude_quota.resets_invalid_payload');
  try {
    const result = await apiCallApi.request({
      authIndex,
      method: 'GET',
      url: CLAUDE_RESET_STATUS_URL,
      header: { ...CLAUDE_RESET_HEADERS },
    });
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return { ...parseClaudeResetInfo(null, ''), error: getApiCallErrorMessage(result) };
    }
    return parseClaudeResetInfo(result.body ?? result.bodyText, invalid);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : t('common.unknown_error');
    return { ...parseClaudeResetInfo(null, ''), error: message };
  }
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

  // Third and last, alone like the other two: the reset grants live on a separate
  // URL so the canonical usage read above stays the one the proxy reconciles on.
  const resets = await fetchClaudeResets(authIndex, t);

  return { windows, extraUsage: payload.extra_usage, planType, resets };
};

const resolveAuthIndex = (file: AuthFileItem, t: TFunction): string => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) throw new Error(t('claude_quota.missing_auth_index'));
  return authIndex;
};

const resetKindLabel = (grant: ClaudeResetGrant, t: TFunction): string =>
  t(`claude_quota.reset_kind_${claudeResetKind(grant)}`);

const formatDeadline = (grant: ClaudeResetGrant): string => {
  const ms = parseIsoToMs(grant.endsAt);
  return ms === null ? '-' : formatInstantShort(ms);
};

/** Why `grant` cannot be spent now, in Claude Code's words. */
export const describeClaudeResetReason = (
  grant: ClaudeResetGrant,
  info: ClaudeResetInfo,
  t: TFunction
): string => t(claudeResetReasonKey(grant, claudeResetReason(grant, info)));

/** What a Fable reset would give back now, in percent of the weekly limit. */
export const describeClaudeFableShare = (info: ClaudeResetInfo, t: TFunction): string =>
  info.fableWeeklySharePercent === null
    ? t('claude_quota.reset_share_unknown')
    : `${Math.round(info.fableWeeklySharePercent)}%`;

const describeClears = (grant: ClaudeResetGrant): string =>
  grant.clears
    .map((window) =>
      grant.percentUsed[window] === undefined ? window : `${window} (${grant.percentUsed[window]}%)`
    )
    .join(', ') || '-';

const describeClaudeReset = (
  file: AuthFileItem,
  quota: ClaudeQuotaState,
  t: TFunction
): QuotaResetDescription<ClaudeResetChoice> | null => {
  const info = quota.resets;
  const grant = pickClaudeResetGrant(info);
  if (!info || !grant) return null;
  const kind = resetKindLabel(grant, t);
  const params = {
    name: file.name,
    kind,
    label: grant.label || grant.id,
    left: grant.resetsLeft,
    deadline: formatDeadline(grant),
    share: describeClaudeFableShare(info, t),
    clears: describeClears(grant),
  };
  const message = [
    t(
      grant.givesBackWeekly
        ? 'claude_quota.reset_confirm_message_fable'
        : 'claude_quota.reset_confirm_message',
      params
    ),
  ];
  // `cpa-route claude reset` refuses this without --force; the dialog is the --force,
  // so it says what the CLI would have.
  if (!info.atLimit) {
    message.push(
      t(
        grant.givesBackWeekly
          ? 'claude_quota.reset_confirm_not_at_limit_fable'
          : 'claude_quota.reset_confirm_not_at_limit',
        params
      )
    );
  }
  return {
    option: { grantId: grant.id, atLimit: info.atLimit },
    title: t('claude_quota.reset_confirm_title', { kind }),
    message: message.join(' '),
    confirmText: t('claude_quota.reset_confirm_button', { kind }),
  };
};

/** What a confirmation named, and the premise it was shown on. */
export interface ClaudeResetChoice {
  grantId: string;
  /**
   * The card read the seat at a limit the reset program counts, so the dialog did
   * not warn that a reset now refills windows that still have room.
   */
  atLimit: boolean;
}

/**
 * Claude Code retries an unsettled claim on the same grant with the same request id
 * for ten minutes. The id is Anthropic's idempotency key, so using the reset again
 * after an unknown outcome retries the first request instead of risking a second one.
 */
export const CLAUDE_RESET_RETRY_WINDOW_MS = 10 * 60 * 1000;

interface UnsettledClaim {
  grantId: string;
  requestId: string;
  /** When the request was first sent; a retry keeps it, as Claude Code does. */
  atMs: number;
}

// Both keyed by credential, module-scoped so the quota page and the auth-file cards
// share them: one claim in flight per seat, and one unsettled request id per seat.
const claimsInFlight = new Set<string>();
const unsettledClaims = new Map<string, UnsettledClaim>();

/** Tests only: forget every claim in flight and every unsettled request id. */
export const resetClaudeClaimMemory = (): void => {
  claimsInFlight.clear();
  unsettledClaims.clear();
};

const notClaimed = (t: TFunction, message: string) =>
  new Error(t('claude_quota.reset_not_claimed', { message }));

type ClaimResult = { cleared: string[]; resetsLeft: number | null };

/**
 * Spends one banked reset: the grant the confirmation named, re-read fresh first.
 *
 * Everything before the POST provably spends nothing and says so. The POST itself is
 * idempotent on its request id, so an answer that leaves the outcome open names the
 * id and the `cpa-route` command that retries it, and the next claim of that grant on
 * this seat within CLAUDE_RESET_RETRY_WINDOW_MS sends the same id. While one is open,
 * no answer short of `reset` is reported as nothing having been used.
 */
export const claimClaudeReset = async (
  file: AuthFileItem,
  t: TFunction,
  choice?: ClaudeResetChoice
): Promise<ClaimResult> => {
  const authIndex = resolveAuthIndex(file, t);
  // A second claim racing the first would carry a fresh request id: two resets.
  if (claimsInFlight.has(authIndex)) throw new Error(t('claude_quota.reset_in_progress'));
  claimsInFlight.add(authIndex);
  try {
    return await claimOnce(file, authIndex, t, choice);
  } finally {
    claimsInFlight.delete(authIndex);
  }
};

const claimOnce = async (
  file: AuthFileItem,
  authIndex: string,
  t: TFunction,
  choice: ClaudeResetChoice | undefined
): Promise<ClaimResult> => {
  const recorded = unsettledClaims.get(authIndex);
  if (recorded && Date.now() - recorded.atMs >= CLAUDE_RESET_RETRY_WINDOW_MS) {
    unsettledClaims.delete(authIndex);
  }
  const open = unsettledClaims.get(authIndex);
  let retry = open && (!choice || open.grantId === choice.grantId) ? open : undefined;
  // While an earlier request may have landed, "nothing was used" would be a guess.
  const refuse = (message: string) =>
    retry
      ? resetOutcomeUnknownError(
          t('claude_quota.reset_retry_unsettled', { message, requestId: retry.requestId })
        )
      : notClaimed(t, message);

  const info = await fetchClaudeResets(authIndex, t);
  if (info.error) throw refuse(info.error);
  if (!info.eligible) {
    throw refuse(t('claude_quota.resets_ineligible', { reason: info.ineligibleReason ?? '-' }));
  }
  const grant = choice
    ? info.grants.find((candidate) => candidate.id === choice.grantId)
    : pickClaudeResetGrant(info);
  if (!grant) throw refuse(t('claude_quota.reset_grant_gone'));
  if (retry && retry.grantId !== grant.id) retry = undefined;
  if (!isUsableClaudeGrant(grant)) throw refuse(describeClaudeResetReason(grant, info, t));
  // Fable may have spent nothing since the dialog opened: re-checked on the fresh read.
  if (claudeGrantGivesNothingBack(grant, info)) {
    throw refuse(t('claude_quota.reset_reason_nothing_to_give_back'));
  }
  // The dialog warns about headroom only when the card read none, and the card can be
  // hours old. A seat that has left its limit since was never warned about, and
  // `cpa-route claude reset` refuses it without --force: so does this.
  if (choice?.atLimit && !info.atLimit) throw refuse(t('claude_quota.reset_limit_cleared'));

  const profile = await apiCallApi
    .request({
      authIndex,
      method: 'GET',
      url: CLAUDE_PROFILE_URL,
      header: { ...CLAUDE_RESET_HEADERS },
    })
    .catch(() => null);
  const organizationUuid =
    profile && profile.statusCode >= 200 && profile.statusCode < 300
      ? parseClaudeProfilePayload(profile.body ?? profile.bodyText)?.organization?.uuid
      : undefined;
  // Spliced into the claim URL's path, so only a well-formed UUID goes through.
  if (!isClaudeOrganizationUuid(organizationUuid)) {
    throw refuse(t('claude_quota.reset_no_organization'));
  }

  const requestId = retry?.requestId ?? newClaudeResetRequestId();
  const firstSentAtMs = retry?.atMs ?? Date.now();
  const unknown = (detail: string) => {
    unsettledClaims.set(authIndex, { grantId: grant.id, requestId, atMs: firstSentAtMs });
    return resetOutcomeUnknownError(
      t('claude_quota.reset_outcome_unknown', {
        detail,
        requestId,
        command: `cpa-route claude reset ${shellWord(file.name)} --grant ${grant.id} --request-id ${requestId}`,
      })
    );
  };
  let result;
  try {
    result = await apiCallApi.request({
      authIndex,
      method: 'POST',
      url: claudeResetClaimUrl(organizationUuid),
      header: { ...CLAUDE_RESET_HEADERS, 'Content-Type': 'application/json' },
      data: JSON.stringify({
        program: CLAUDE_RESET_PROGRAM,
        grant_id: grant.id,
        request_id: requestId,
      }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : t('common.unknown_error');
    // The management API refusing the call (a 4xx) answers before anything is sent;
    // anything else may have reached Anthropic.
    const status = getStatusFromError(err);
    if (status !== undefined && status >= 400 && status < 500) throw refuse(message);
    throw unknown(message);
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw unknown(getApiCallErrorMessage(result));
  }
  const claim = classifyClaudeResetClaim(result.body ?? result.bodyText);
  if (claim.outcome === 'reset') {
    unsettledClaims.delete(authIndex);
    return { cleared: claim.cleared, resetsLeft: claim.resetsLeft };
  }
  const detail = [claim.result || '-', claim.reason].filter(Boolean).join(': ');
  if (claim.outcome === 'unknown') throw unknown(detail);
  // A retry answered `already_used` or `not_limited` most likely means the first
  // attempt landed; whichever it was, the earlier request stays the one to check.
  if (retry && CLAUDE_RESET_RETRY_SETTLED.has(claim.result)) unsettledClaims.delete(authIndex);
  throw refuse(detail);
};

const resetClaudeQuota = async (
  file: AuthFileItem,
  t: TFunction,
  choice?: ClaudeResetChoice
): Promise<ClaudeQuotaData> => {
  const claimed = await claimClaudeReset(file, t, choice);
  // Read back live: the canonical usage GET is also what makes the proxy reconcile
  // the seat's routing, so the refilled window serves without a manual reset-quota.
  try {
    const data = await fetchClaudeQuota(file, t);
    return { ...data, claimed };
  } catch (err: unknown) {
    // The reset was spent. A throw here would report the claim as failed and leave the
    // card offering the grant again, so the read-back failure becomes the card's own
    // error instead: no reset is offered on it until a refresh reads the seat.
    const message = err instanceof Error ? err.message : t('common.unknown_error');
    return {
      windows: [],
      claimed,
      readbackError: t('claude_quota.reset_readback_failed', { message }),
    };
  }
};

const describeClaudeResetSuccess = (
  file: AuthFileItem,
  data: ClaudeQuotaData,
  t: TFunction
): string =>
  data.claimed
    ? t('claude_quota.reset_success_detail', {
        name: file.name,
        cleared: data.claimed.cleared.join(', ') || '-',
        left: data.claimed.resetsLeft ?? '-',
      })
    : t('claude_quota.reset_success', { name: file.name });

export const CLAUDE_CONFIG: QuotaProviderData<
  ClaudeQuotaState,
  ClaudeQuotaData,
  ClaudeResetChoice
> = {
  type: 'claude',
  i18nPrefix: 'claude_quota',
  filterFn: (file) => isClaudeFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchClaudeQuota,
  resetQuota: resetClaudeQuota,
  canResetQuota: (quota) => pickClaudeResetGrant(quota.resets) !== null,
  describeReset: describeClaudeReset,
  describeResetSuccess: describeClaudeResetSuccess,
  // A card painted from the listing has no grants; one paced read per seat adds them.
  supplementQuota: async (file, t) => ({
    resets: await fetchClaudeResets(resolveAuthIndex(file, t), t),
  }),
  needsSupplement: (quota) => quota.status === 'success' && quota.resets === undefined,
  carrySupplement: (from, to) =>
    to.resets === undefined && from.resets !== undefined ? { ...to, resets: from.resets } : to,
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
  buildSuccessState: (data) =>
    data.readbackError
      ? { status: 'error', windows: [], error: data.readbackError }
      : {
          status: 'success',
          windows: data.windows,
          extraUsage: data.extraUsage,
          planType: data.planType,
          resets: data.resets,
        },
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
};
