import { useTranslation } from 'react-i18next';
import { usePanelUpdateCheck } from '@/hooks/usePanelUpdateCheck';
import styles from './PanelUpdateBanner.module.scss';

/** Says a newer panel is installed where reloading on its own could lose an edit. */
export function PanelUpdateBanner() {
  const { t } = useTranslation();
  const { available, reload } = usePanelUpdateCheck();
  if (!available) return null;
  return (
    <div className={styles.banner} role="status">
      <span>{t('panel_update.available')}</span>
      <button type="button" className={styles.reload} onClick={reload}>
        {t('panel_update.reload')}
      </button>
    </div>
  );
}
