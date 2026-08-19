import { useTranslation } from 'react-i18next';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import type { WeeklyCapacityRow, WeeklyCapacitySummary } from '../weeklyCapacity';
import styles from './WeeklyCapacity.module.scss';

export type WeeklyCapacityProps = {
  summary: WeeklyCapacitySummary;
  resolvedTheme: ResolvedTheme;
};

/**
 * 7 天余量总览：按提供商汇总「还剩几个账号」，跟随上方 tab 过滤。
 *
 * The card grid answers "is this credential nearly out". This answers the
 * question you actually act on — how much room is left in total — in the only
 * unit that survives being summed across a fleet: accounts.
 *
 * One decimal, always. 5.5 is the point of the unit; rounding to 6 would erase
 * exactly the resolution that makes half an account visible.
 */
const formatAccounts = (value: number) => value.toFixed(1);

/** Full → empty, so a nearly-spent provider reads as spent at a glance. */
const toneFor = (row: WeeklyCapacityRow): string => {
  if (row.measured === 0) return styles.toneUnknown;
  const share = row.accountsFree / row.measured;
  if (share <= 0.1) return styles.toneCritical;
  if (share <= 0.3) return styles.toneWarn;
  return styles.toneOk;
};

export function WeeklyCapacity({ summary, resolvedTheme }: WeeklyCapacityProps) {
  const { t } = useTranslation();

  if (summary.rows.length === 0) return null;

  return (
    <section
      className={styles.strip}
      data-reveal
      aria-label={t('quota_management.capacity_title')}
    >
      <div className={styles.heading}>
        <span className={styles.title}>{t('quota_management.capacity_title')}</span>
        {summary.partial && (
          <span className={styles.partialHint}>{t('quota_management.capacity_partial')}</span>
        )}
      </div>

      <div className={styles.row}>
        {summary.rows.map((row) => {
          const label = getTypeLabel(t, row.provider);
          const iconSrc = getAuthFileIcon(row.provider, resolvedTheme);
          const unmeasured = row.total - row.measured;

          return (
            <div key={row.provider} className={styles.stat}>
              <span
                className={styles.iconWrap}
                style={
                  isThemeSurfaceIconProvider(row.provider)
                    ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                    : undefined
                }
              >
                {iconSrc ? (
                  <img src={iconSrc} alt="" className={styles.icon} />
                ) : (
                  <span className={styles.iconFallback}>{label.slice(0, 1).toUpperCase()}</span>
                )}
              </span>

              <div className={styles.body}>
                <span className={styles.label}>{label}</span>
                {row.measured === 0 ? (
                  <span className={`${styles.value} ${styles.toneUnknown}`}>
                    {t('quota_management.capacity_none_measured')}
                  </span>
                ) : (
                  <span className={`${styles.value} ${toneFor(row)}`}>
                    {/* `count` drives i18next pluralisation, so a single-seat
                        provider reads "of 1 account" rather than "1 accounts". */}
                    {t('quota_management.capacity_accounts', {
                      free: formatAccounts(row.accountsFree),
                      count: row.measured,
                    })}
                  </span>
                )}
                {unmeasured > 0 && row.measured > 0 && (
                  <span className={styles.note}>
                    {t('quota_management.capacity_unmeasured', { count: unmeasured })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
