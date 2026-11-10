/**
 * Claude banked usage-limit resets: Anthropic's `cedar_ember` program.
 *
 * A seat is granted resets (one per Max seat for a model launch, more at tenure
 * milestones) that Claude Code spends from its rate-limit screen. The usage endpoint
 * reports them only to a caller that identifies as the Claude Code CLI, and only when
 * asked with `?cedar_ember=1`; anything else reads `ineligible_reason: surface`.
 *
 * The kind, the reason a grant cannot be used, and which grant a claim spends are all
 * ported from Claude Code 2.1.321's own `/limit-reset`, so this page and the CLI say the
 * same thing about the same grant. Claude Code's wording is kept where it has one.
 *
 * React-free — tests/claudeResets.test.ts consumes it directly.
 */

import type {
  ClaudeResetGrant,
  ClaudeResetInfo,
  ClaudeResetKind,
  ClaudeResetReason,
} from '@/types';

const RESET_REASONS: readonly ClaudeResetReason[] = [
  'cooldown',
  'blocked_five_hour',
  'blocked_seven_day',
  'blocked_opus',
  'blocked_sonnet',
  'blocked_other',
  'cannot_clear',
  'needs_limit',
  'unavailable',
];

// Claude Code validates both ids before it sends a claim; so does this page.
export const CLAUDE_RESET_GRANT_ID = /^[a-z0-9_-]{1,40}$/;
export const CLAUDE_RESET_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const percentMap = (value: unknown): Record<string, number> => {
  const record = asRecord(value);
  const out: Record<string, number> = {};
  if (!record) return out;
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 100) out[key] = raw;
  }
  return out;
};

/**
 * One grant, or null when it is malformed. Claude Code drops a grant whose id or
 * `resets_left` fails its schema and keeps the rest; so does this.
 */
export function parseClaudeResetGrant(value: unknown): ClaudeResetGrant | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = record.id;
  if (typeof id !== 'string' || !CLAUDE_RESET_GRANT_ID.test(id)) return null;
  if (!isCount(record.resets_left)) return null;
  const type = record.type;
  const reason = record.unavailable_reason;
  return {
    id,
    label: typeof record.label === 'string' ? record.label : '',
    resetsTotal: isCount(record.resets_total) ? record.resets_total : 0,
    resetsLeft: record.resets_left,
    startsAt: stringOrNull(record.starts_at),
    endsAt: stringOrNull(record.ends_at),
    clears: stringList(record.clears),
    paused: record.paused === true,
    usableNow: record.usable_now === true,
    // Claude Code's default when the field is missing or malformed is true.
    useRequiresLimit: record.use_requires_limit !== false,
    percentUsed: percentMap(record.percent_used),
    blocking: stringList(record.blocking),
    type: type === 'session' || type === 'weekly' || type === 'full' ? type : null,
    givesBackWeekly: record.gives_back_weekly === true,
    unavailableReason: RESET_REASONS.includes(reason as ClaudeResetReason)
      ? (reason as ClaudeResetReason)
      : null,
  };
}

/** Fable's share of this week, read from `weekly_scoped_shares` against `limits`. */
const fableWeeklyShare = (payload: Record<string, unknown>): number | null => {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const shares = Array.isArray(payload.weekly_scoped_shares) ? payload.weekly_scoped_shares : [];
  for (const raw of shares) {
    const share = asRecord(raw);
    if (!share || !isCount(share.limit_index)) continue;
    const limit = asRecord(limits[share.limit_index]);
    const model = asRecord(asRecord(limit?.scope)?.model);
    const name =
      typeof model?.display_name === 'string' ? model.display_name.trim().toLowerCase() : '';
    if (limit?.kind !== 'weekly_scoped' || !name.startsWith('fable')) continue;
    const used = share.used_percent_of_weekly;
    if (typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100) return used;
  }
  return null;
};

const emptyInfo = (error: string): ClaudeResetInfo => ({
  eligible: false,
  ineligibleReason: null,
  atLimit: false,
  exhausted: [],
  grants: [],
  nextGrantId: null,
  cooldownUntil: null,
  fableWeeklySharePercent: null,
  error,
});

/**
 * The reset status a `?cedar_ember=1` usage response carries.
 *
 * `invalidMessage` is what a response without a readable status block becomes; the
 * caller supplies it translated.
 */
export function parseClaudeResetInfo(body: unknown, invalidMessage: string): ClaudeResetInfo {
  const payload = asRecord(parseMaybeJson(body));
  const status = asRecord(payload?.cedar_ember);
  if (!payload || !status || typeof status.eligible !== 'boolean') return emptyInfo(invalidMessage);
  const grants = (Array.isArray(status.grants) ? status.grants : [])
    .map(parseClaudeResetGrant)
    .filter((grant): grant is ClaudeResetGrant => grant !== null);
  // Claude Code ignores a next_grant_id that names no grant it kept.
  const next = status.next_grant_id;
  return {
    eligible: status.eligible,
    ineligibleReason: stringOrNull(status.ineligible_reason),
    atLimit: status.at_limit === true,
    exhausted: stringList(status.exhausted),
    grants,
    nextGrantId:
      typeof next === 'string' && grants.some((grant) => grant.id === next) ? next : null,
    cooldownUntil: stringOrNull(status.cooldown_until),
    fableWeeklySharePercent: fableWeeklyShare(payload),
    error: '',
  };
}

/** Claude Code's `Ye`: what a grant is called. */
export function claudeResetKind(grant: ClaudeResetGrant): ClaudeResetKind {
  if (grant.givesBackWeekly) return 'fable';
  if (grant.type !== null) return grant.type;
  const session = grant.clears.includes('five_hour');
  const other = grant.clears.some((window) => window !== 'five_hour');
  if (session && !other) return 'session';
  if (other && !session) return 'weekly';
  return 'full';
}

/** Whether a grant refills `window`; a Fable reset gives back into the weekly one. */
const refills = (grant: ClaudeResetGrant, window: string): boolean =>
  grant.clears.includes(window) || (window === 'seven_day' && grant.givesBackWeekly);

/** The blocking windows Claude Code has words for; the first one listed decides. */
const BLOCKING_REASONS: Record<string, ClaudeResetReason> = {
  five_hour: 'blocked_five_hour',
  seven_day: 'blocked_seven_day',
  seven_day_opus: 'blocked_opus',
  seven_day_sonnet: 'blocked_sonnet',
};

/**
 * Why a grant that is not usable now is not: paused and spent first, as `cpa-route
 * claude status` and Claude Code's grant list say them, then Claude Code's `tr`.
 */
export type ClaudeResetGrantReason = ClaudeResetReason | 'paused' | 'none_left';

/** Claude Code's `tr`, behind the paused and none-left checks it never reaches. */
export function claudeResetReason(
  grant: ClaudeResetGrant,
  info: ClaudeResetInfo
): ClaudeResetGrantReason {
  if (grant.paused) return 'paused';
  if (grant.resetsLeft === 0) return 'none_left';
  if (grant.unavailableReason !== null) return grant.unavailableReason;
  if (info.cooldownUntil !== null) return 'cooldown';
  // Any other blocking window (overage, Cowork, OAuth apps, one never heard of) counts
  // only when none of the named ones is listed: Claude Code drops unknown windows at
  // parse time, so one listed ahead of `five_hour` must not hide it.
  for (const window of grant.blocking) {
    const reason = BLOCKING_REASONS[window];
    if (reason) return reason;
  }
  if (grant.blocking.length > 0) return 'blocked_other';
  if (info.atLimit && !info.exhausted.some((window) => refills(grant, window))) {
    return 'cannot_clear';
  }
  return grant.useRequiresLimit ? 'needs_limit' : 'unavailable';
}

/**
 * The i18n key for a reason's text. A Fable reset blocked by the weekly window is
 * blocked because Fable used nothing this week: there is nothing for it to give back.
 */
export function claudeResetReasonKey(
  grant: ClaudeResetGrant,
  reason: ClaudeResetGrantReason
): string {
  if (reason === 'paused') return 'claude_quota.reset_paused';
  if (reason === 'none_left') return 'claude_quota.reset_none_left';
  if (reason === 'blocked_seven_day' && grant.givesBackWeekly) {
    return 'claude_quota.reset_reason_nothing_to_give_back';
  }
  return `claude_quota.reset_reason_${reason}`;
}

/**
 * A claim's idempotency key. `crypto.randomUUID` exists only in a secure context, and
 * the panel is often opened over plain HTTP on another box (http://<host>:8317), where
 * it is undefined; `getRandomValues` is available everywhere.
 */
export function newClaudeResetRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A word for a POSIX shell: as-is when it is plain, single-quoted otherwise. */
export const shellWord = (value: string): string =>
  /^[A-Za-z0-9@%+=:,./_-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export const isUsableClaudeGrant = (grant: ClaudeResetGrant): boolean =>
  grant.usableNow && !grant.paused && grant.resetsLeft > 0;

/**
 * A reset that would return 0%, and whose grant would still be gone. A Fable reset gives
 * back what Fable spent of this week, so at a 0% share it gives back nothing. Any other
 * grant gives back nothing when Anthropic reads every window it clears at 0% used (the
 * November 2026 full limit reset on an idle seat). Anthropic still marks either usable;
 * `cpa-route claude reset` refuses them without --force, and this page does not offer them.
 */
export const claudeGrantGivesNothingBack = (
  grant: ClaudeResetGrant,
  info: ClaudeResetInfo
): boolean => {
  if (grant.givesBackWeekly) return info.fableWeeklySharePercent === 0;
  return grant.clears.length > 0 && grant.clears.every((window) => grant.percentUsed[window] === 0);
};

/**
 * What a grant would return to the weekly limit now, in percent: Fable's share for a
 * Fable reset, the weekly's own reading for a grant that clears it, null when unknown.
 */
export const claudeGrantWeeklyGiveBack = (
  grant: ClaudeResetGrant,
  info: ClaudeResetInfo
): number | null => {
  if (grant.givesBackWeekly) return info.fableWeeklySharePercent;
  if (!grant.clears.includes('seven_day')) return null;
  return grant.percentUsed.seven_day ?? null;
};

/** A grant this page will spend: usable now, and not a Fable reset that returns 0%. */
export const isClaimableClaudeGrant = (grant: ClaudeResetGrant, info: ClaudeResetInfo): boolean =>
  isUsableClaudeGrant(grant) && !claudeGrantGivesNothingBack(grant, info);

/**
 * The grant a claim spends, as `cpa-route claude reset` picks it: Anthropic's
 * `next_grant_id` when that one is claimable, else the first claimable grant.
 */
export function pickClaudeResetGrant(info: ClaudeResetInfo | undefined): ClaudeResetGrant | null {
  if (!info || info.error || !info.eligible) return null;
  const claimable = (grant: ClaudeResetGrant) => isClaimableClaudeGrant(grant, info);
  const next = info.grants.find((grant) => grant.id === info.nextGrantId);
  if (next && claimable(next)) return next;
  return info.grants.find(claimable) ?? null;
}

export const isClaudeOrganizationUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

// Claim results, as Claude Code reads them. `reset` spent a reset; these six spent
// nothing; anything else leaves the outcome unknown.
const NOT_SPENT = new Set([
  'not_limited',
  'cooldown',
  'already_used',
  'ineligible',
  'rate_limited',
  'auth_error',
]);

/**
 * Not-spent answers that settle a retried request id, as Claude Code reads them on a
 * retry: the earlier attempt landed (`already_used`, `not_limited`) or never will
 * (`ineligible`). `cooldown`, `rate_limited` and `auth_error` leave it open.
 */
export const CLAUDE_RESET_RETRY_SETTLED: ReadonlySet<string> = new Set([
  'already_used',
  'not_limited',
  'ineligible',
]);

export type ClaudeResetClaimOutcome =
  | { outcome: 'reset'; cleared: string[]; resetsLeft: number | null }
  | { outcome: 'not_spent'; result: string; reason: string }
  | { outcome: 'unknown'; result: string; reason: string };

/** What a 2xx claim answer means. */
export function classifyClaudeResetClaim(body: unknown): ClaudeResetClaimOutcome {
  const answer = asRecord(parseMaybeJson(body));
  const result = typeof answer?.result === 'string' ? answer.result : '';
  const reason = typeof answer?.reason === 'string' ? answer.reason : '';
  if (result === 'reset') {
    return {
      outcome: 'reset',
      cleared: stringList(answer?.cleared),
      resetsLeft: isCount(answer?.resets_left) ? answer.resets_left : null,
    };
  }
  if (NOT_SPENT.has(result)) return { outcome: 'not_spent', result, reason };
  return { outcome: 'unknown', result, reason };
}
