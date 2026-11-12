/**
 * 单卡额度操作：刷新 + 重置（Codex 重置积分、Claude 储备重置）。
 * A disabled credential may be refreshed (a read; CPA serves it) but never reset: a
 * reset spent on a seat CPA routes nothing to buys nothing.
 * 流程 1:1 移植旧 QuotaSection（confirm modal、resetting 再入守卫、
 * generation-guarded commit、成功/失败通知），仅把 config 换成 adapter。
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useNotificationStore,
} from '@/stores';
import type { AuthFileItem } from '@/types';
import { getStatusFromError, isDisabledAuthFile } from '@/utils/quota';
import { quotaFetchQueueFor } from '../fetchQueue';
import {
  buildResetConfirmation,
  isResetOutcomeUnknown,
  resetFailedNotice,
  resetFailedNoticeDuration,
  resetSuccessNotice,
} from '../resetCopy';
import { getQuotaMap, getQuotaSetter, type QuotaAdapter, type QuotaCardState } from '../providers';

const getQuotaState = (adapter: QuotaAdapter, name: string): QuotaCardState | undefined =>
  getQuotaMap(adapter)[name];

export function useQuotaActions(disableControls: boolean) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const [resettingQuotaName, setResettingQuotaName] = useState<string | null>(null);

  const refreshQuota = useCallback(
    async (file: AuthFileItem, adapter: QuotaAdapter) => {
      if (disableControls) return;
      if (resettingQuotaName === file.name) return;
      if (getQuotaState(adapter, file.name)?.status === 'loading') return;
      const cacheGeneration = captureQuotaCacheGeneration();
      const setQuota = getQuotaSetter(adapter);

      setQuota((prev) => ({
        ...prev,
        [file.name]: adapter.buildLoadingState(),
      }));

      try {
        const data = await quotaFetchQueueFor(adapter.type).run(() => adapter.fetchQuota(file, t));
        commitIfQuotaCacheCurrent(cacheGeneration, () => {
          setQuota((prev) => ({
            ...prev,
            [file.name]: adapter.buildSuccessState(data),
          }));
          showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        commitIfQuotaCacheCurrent(cacheGeneration, () => {
          setQuota((prev) => ({
            ...prev,
            [file.name]: adapter.buildErrorState(message, status),
          }));
          showNotification(
            t('auth_files.quota_refresh_failed', { name: file.name, message }),
            'error'
          );
        });
      }
    },
    [disableControls, resettingQuotaName, showNotification, t]
  );

  const resetQuota = useCallback(
    (file: AuthFileItem, adapter: QuotaAdapter) => {
      const resetQuotaFn = adapter.resetQuota;
      if (!resetQuotaFn) return;
      // The button is not offered on a disabled card (offersQuotaReset); this holds the line.
      if (disableControls || isDisabledAuthFile(file)) return;
      if (getQuotaState(adapter, file.name)?.status === 'loading') return;
      if (resettingQuotaName === file.name) return;
      const confirmation = buildResetConfirmation(
        adapter,
        file,
        getQuotaState(adapter, file.name),
        t
      );
      if (!confirmation) return;

      showConfirmation({
        title: confirmation.title,
        message: confirmation.message,
        confirmText: confirmation.confirmText,
        variant: 'primary',
        onConfirm: async () => {
          const cacheGeneration = captureQuotaCacheGeneration();
          const setQuota = getQuotaSetter(adapter);
          setResettingQuotaName(file.name);
          try {
            const data = await resetQuotaFn(file, t, confirmation.option);
            commitIfQuotaCacheCurrent(cacheGeneration, () => {
              setQuota((prev) => ({
                ...prev,
                [file.name]: adapter.buildSuccessState(data),
              }));
              showNotification(resetSuccessNotice(adapter, file, data, t), 'success');
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : t('common.unknown_error');
            const notify = () =>
              showNotification(
                resetFailedNotice(adapter, file, message, t),
                'error',
                resetFailedNoticeDuration(err)
              );
            if (!commitIfQuotaCacheCurrent(cacheGeneration, notify) && isResetOutcomeUnknown(err)) {
              notify();
            }
          } finally {
            setResettingQuotaName((current) => (current === file.name ? null : current));
          }
        },
      });
    },
    [disableControls, resettingQuotaName, showConfirmation, showNotification, t]
  );

  return { resettingQuotaName, refreshQuota, resetQuota };
}
