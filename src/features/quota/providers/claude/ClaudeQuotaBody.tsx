/**
 * Claude 额度渲染体：套餐/额外用量 chip 行 + 储备重置明细 + 用量窗口水位条。
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeQuotaState, ClaudeResetInfo } from '@/types';
import {
  buildResetDisplay,
  claudeGrantGivesNothingBack,
  claudeResetKind,
  formatInstantShort,
  formatRelativeInstant,
  isClaimableClaudeGrant,
  isUsableClaudeGrant,
  parseIsoToMs,
} from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import { describeClaudeFableShare, describeClaudeResetReason } from './data';
import { useNow } from '@/hooks/useNow';
import { QuotaMeter } from '../../components/QuotaMeter';
import { QuotaResetLabel } from '../../components/QuotaResetLabel';
import { collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps, QuotaClassMap } from '../../types';

// Kinds read lower-case inside a sentence ("Use a weekly reset?"), so a row that
// starts with one capitalizes it here rather than in every locale.
const capitalize = (text: string, locale?: string) =>
  text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/** One row per grant: kind and count, use-by date, then usable-now or why not. */
function ClaudeResetGrants({
  resets,
  classes,
}: {
  resets: ClaudeResetInfo;
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
        const endsAtMs = parseIsoToMs(grant.endsAt);
        const deadline = buildResetDisplay(
          endsAtMs === null ? grant.endsAt : formatInstantShort(endsAtMs),
          endsAtMs,
          now,
          locale
        );
        const claimable = isClaimableClaudeGrant(grant, resets);
        let status: string;
        if (claimable) {
          status = grant.givesBackWeekly
            ? t('claude_quota.reset_usable_fable', { share: describeClaudeFableShare(resets, t) })
            : t('claude_quota.reset_usable');
        } else if (isUsableClaudeGrant(grant) && claudeGrantGivesNothingBack(grant, resets)) {
          // Usable, but a Fable reset at a 0% share returns nothing; not offered.
          status = t('claude_quota.reset_reason_nothing_to_give_back');
        } else {
          status = describeClaudeResetReason(grant, resets, t);
        }
        return (
          <div key={grant.id} className={classes.codexResetCreditRow} title={grant.id}>
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
              {deadline && <QuotaResetLabel display={deadline} classes={classes} />}
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
      {quota.resets && <ClaudeResetGrants resets={quota.resets} classes={classes} />}
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
