/**
 * Claude 额度渲染体：套餐/额外用量 chip 行 + 储备重置明细 + 用量窗口水位条。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeQuotaState, ClaudeResetInfo } from '@/types';
import {
  buildResetDisplay,
  claudeGrantGivesNothingBack,
  claudeGrantWeeklyGiveBack,
  claudeResetKind,
  formatInstantShort,
  formatRelativeInstant,
  isClaimableClaudeGrant,
  isUsableClaudeGrant,
  parseIsoToMs,
} from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { claudeNothingBackKey, describeClaudeFableShare, describeClaudeResetReason } from './data';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { claudeGrantRowId, collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps, QuotaClassMap } from '../../types';

// Kinds read lower-case inside a sentence ("Use a weekly reset?"), so a row that
// starts with one capitalizes it here rather than in every locale.
const capitalize = (text: string, locale?: string) =>
  text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/** Resets the seat still holds, and how many of those it could spend right now. */
const countResets = (resets: ClaudeResetInfo) => ({
  left: resets.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0),
  usable: resets.grants
    .filter((grant) => isClaimableClaudeGrant(grant, resets))
    .reduce((sum, grant) => sum + grant.resetsLeft, 0),
});

/**
 * One row per grant: kind and count, use-by date, then usable-now or why not. A grant
 * in its last hour takes the card's emphasis, as an expiring Codex credit does.
 */
function ClaudeResetGrants({
  resets,
  soonestRowId,
  classes,
}: {
  resets: ClaudeResetInfo;
  soonestRowId: string | null;
  classes: QuotaClassMap;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const locale = i18n.resolvedLanguage;

  if (resets.error) {
    return (
      <div className={classes.codexResetCreditsError}>
        {t('claude_quota.resets_failed', { message: resets.error })}
      </div>
    );
  }
  if (!resets.eligible) {
    return (
      <div className={classes.codexResetCreditsError}>
        {t('claude_quota.resets_ineligible', { reason: resets.ineligibleReason ?? '-' })}
      </div>
    );
  }
  if (resets.grants.length === 0) return null;

  return (
    <div className={classes.codexResetCredits}>
      <div className={classes.codexResetCreditsTitle}>
        {t('claude_quota.resets_title', { timezone: resolveTimeZoneLabel() })}
      </div>
      {resets.grants.map((grant) => {
        const rowId = claudeGrantRowId(grant);
        const soon = rowId === soonestRowId;
        const endsAtMs = parseIsoToMs(grant.endsAt);
        const deadline = buildResetDisplay(
          endsAtMs === null ? grant.endsAt : formatInstantShort(endsAtMs),
          endsAtMs,
          now,
          locale
        );
        const claimable = isClaimableClaudeGrant(grant, resets);
        const weeklyBack = claudeGrantWeeklyGiveBack(grant, resets);
        let status: string;
        if (claimable) {
          // A claimable grant at 0% weekly gives back another window it clears (the
          // 5-hour one), or one with no reading: "gives back 0%" would read as nothing.
          status = grant.givesBackWeekly
            ? t('claude_quota.reset_usable_gives_back', {
                share: describeClaudeFableShare(resets, t),
              })
            : weeklyBack !== null && weeklyBack > 0
              ? t('claude_quota.reset_usable_gives_back', { share: `${Math.round(weeklyBack)}%` })
              : t('claude_quota.reset_usable');
        } else if (isUsableClaudeGrant(grant) && claudeGrantGivesNothingBack(grant, resets)) {
          // Usable, but it would return nothing and the grant would be gone; not offered.
          status = t(claudeNothingBackKey(grant));
        } else {
          status = describeClaudeResetReason(grant, resets, t);
        }
        return (
          <div
            key={rowId}
            className={
              soon
                ? `${classes.codexResetCreditRow} ${classes.codexResetCreditRowSoon}`
                : classes.codexResetCreditRow
            }
            title={soon ? `${grant.id}\n${t('quota_management.soonest_row_hint')}` : grant.id}
          >
            <span className={classes.claudeResetGrantMain}>
              <span className={classes.codexResetCreditLabel}>
                {capitalize(
                  t('claude_quota.reset_grant_label', {
                    kind: t(`claude_quota.reset_kind_${claudeResetKind(grant)}`),
                    left: grant.resetsLeft,
                  }),
                  locale
                )}
              </span>
              {grant.label && <span className={classes.claudeResetGrantNote}>{grant.label}</span>}
              <span
                className={
                  claimable
                    ? `${classes.claudeResetGrantStatus} ${classes.claudeResetGrantStatusUsable}`
                    : classes.claudeResetGrantStatus
                }
              >
                {status}
              </span>
            </span>
            <span className={classes.codexResetCreditTime}>
              {deadline && <QuotaResetLabel display={deadline} classes={classes} soon={soon} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ClaudeQuotaBody({ quota, classes }: QuotaBodyProps<ClaudeQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const soonestRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants('claude', quota), now),
    [quota, now]
  );
  const windows = quota.windows ?? [];
  const extraUsage = quota.extraUsage ?? null;
  const planType = quota.planType ?? null;
  const resets = quota.resets;
  const resetCount =
    resets && !resets.error && resets.eligible && resets.grants.length > 0
      ? countResets(resets)
      : null;

  return (
    <>
      {/* 只有「免费填充」的卡片带 observedAtMs：数字有多旧必须写在脸上，否则读者会当成实时值。 */}
      {quota.observedAtMs !== undefined && (
        <div className={classes.codexPlan} title={t('claude_quota.observed_hint')}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.observed_label')}</span>
          <span className={classes.codexPlanValue}>
            {formatRelativeInstant(quota.observedAtMs, now, i18n.resolvedLanguage)}
          </span>
        </div>
      )}
      {planType && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.plan_label')}</span>
          <span className={classes.codexPlanValue}>{t(`claude_quota.${planType}`)}</span>
        </div>
      )}
      {extraUsage && extraUsage.is_enabled && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.extra_usage_label')}</span>
          <span className={classes.codexPlanValue}>
            {`$${(extraUsage.used_credits / 100).toFixed(2)} / $${(extraUsage.monthly_limit / 100).toFixed(2)}`}
          </span>
        </div>
      )}
      {resetCount && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanLabel}>{t('claude_quota.resets_left_label')}</span>
          <span className={classes.codexPlanValue}>{resetCount.left.toString()}</span>
          {resetCount.usable > 0 && (
            <span className={classes.quotaResetRelative}>
              {t('claude_quota.resets_left_usable', { count: resetCount.usable })}
            </span>
          )}
        </div>
      )}
      {resets && (
        <ClaudeResetGrants resets={resets} soonestRowId={soonestRowId} classes={classes} />
      )}
      {windows.length === 0 ? (
        <div className={classes.quotaMessage}>{t('claude_quota.empty_windows')}</div>
      ) : (
        windows.map((window, index) => {
          const used = window.usedPercent;
          const clampedUsed = used === null ? null : Math.max(0, Math.min(100, used));
          const remaining =
            clampedUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedUsed));
          const percentLabel = remaining === null ? '--' : `${Math.round(remaining)}%`;
          const windowLabel = window.labelKey ? t(window.labelKey) : window.label;
          const resetDisplay = buildResetDisplay(
            window.resetLabel,
            window.resetAtMs,
            now,
            i18n.resolvedLanguage
          );

          const soon = window.id === soonestRowId;

          return (
            <div
              key={window.id}
              className={classes.quotaRow}
              title={soon ? t('quota_management.soonest_row_hint') : undefined}
            >
              <div className={classes.quotaRowHeader}>
                <span className={classes.quotaModel}>{windowLabel}</span>
                <div className={classes.quotaMeta}>
                  <span className={classes.quotaPercent}>{percentLabel}</span>
                  {resetDisplay && (
                    <QuotaResetLabel display={resetDisplay} classes={classes} soon={soon} />
                  )}
                </div>
              </div>
              <QuotaMeter percent={remaining} classes={classes} index={index} />
            </div>
          );
        })
      )}
    </>
  );
}
