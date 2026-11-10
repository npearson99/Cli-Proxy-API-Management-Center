import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { buildResetDisplay } from '@/utils/quota';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import type { BankedResetSummary } from '../bankedResets';
import strip from './WeeklyCapacity.module.scss';
import styles from './BankedResets.module.scss';

/**
 * Every Claude reset the fleet holds, soonest use-by first, under the capacity strip.
 * Hidden until a seat's reset status has been read or when no seat holds one.
 */
export function BankedResets({ summary }: { summary: BankedResetSummary }) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  if (summary.groups.length === 0) return null;

  return (
    <section className={strip.strip} data-reveal aria-label={t('quota_management.banked_aria')}>
      <div className={strip.heading}>
        <span className={strip.title}>
          {t('quota_management.banked_title', { timezone: resolveTimeZoneLabel() })}
        </span>
        {summary.read < summary.total && (
          <span className={strip.partialHint}>
            {t('quota_management.banked_partial', { read: summary.read, count: summary.total })}
          </span>
        )}
      </div>
      <div className={styles.list}>
        {summary.groups.map((group) => {
          const deadline = buildResetDisplay(null, group.endsAtMs, now, i18n.resolvedLanguage);
          return (
            <div
              key={group.key}
              className={styles.item}
              title={group.fable ? undefined : group.key}
            >
              <span className={styles.name}>
                {group.fable ? t('quota_management.banked_fable') : group.label || group.key}
              </span>
              <span className={styles.count}>
                {t('quota_management.banked_left', { left: group.left, count: group.seats })}
              </span>
              <span className={group.usable > 0 ? styles.usable : styles.idle}>
                {t('quota_management.banked_usable', { count: group.usable })}
              </span>
              <span className={styles.deadline}>
                {deadline
                  ? [deadline.absolute, deadline.relative].filter(Boolean).join(' · ')
                  : '-'}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
