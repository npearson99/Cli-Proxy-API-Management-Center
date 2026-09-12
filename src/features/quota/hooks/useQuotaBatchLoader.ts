/**
 * 混合提供商批量额度加载（原 useQuotaLoader 的跨分区泛化）。
 *
 * 保留的三道守卫与旧实现逐一对应：
 * - loadingRef：并发批量加载去重；
 * - requestIdRef：被超越的响应直接丢弃；
 * - cacheGeneration：断线重连后过期请求不得写入新会话缓存。
 * 每张卡各自落地 —— fetchQueue 会把一页凭证摊到几十秒里发，等最慢的一张回来
 * 再统一提交，等于把已经到手的答案藏起来，中途断线更是整页卡在 loading。
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { quotaFetchQueueFor } from '../fetchQueue';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';

export function useQuotaBatchLoader() {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (targets: QuotaFileEntry[]) => {
      if (loadingRef.current) return;
      if (targets.length === 0) return;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      const cacheGeneration = captureQuotaCacheGeneration();
      setBatchLoading(true);

      try {
        const groups = new Map<QuotaProviderType, QuotaFileEntry[]>();
        targets.forEach((entry) => {
          const group = groups.get(entry.type) ?? [];
          group.push(entry);
          groups.set(entry.type, group);
        });

        await Promise.all(
          Array.from(groups.entries()).map(async ([type, entries]) => {
            const adapter = QUOTA_ADAPTERS[type];
            const setQuota = getQuotaSetter(adapter);

            commitIfQuotaCacheCurrent(cacheGeneration, () => {
              setQuota((prev) => {
                const nextState = { ...prev };
                entries.forEach(({ file }) => {
                  nextState[file.name] = adapter.buildLoadingState();
                });
                return nextState;
              });
            });

            const commitCard = (name: string, build: () => QuotaCardState) => {
              if (requestId !== requestIdRef.current) return;
              commitIfQuotaCacheCurrent(cacheGeneration, () => {
                setQuota((prev) => ({ ...prev, [name]: build() }));
              });
            };

            const queue = quotaFetchQueueFor(type);
            await Promise.all(
              entries.map(async ({ file }) => {
                try {
                  const data = await queue.run(() => adapter.fetchQuota(file, t));
                  commitCard(file.name, () => adapter.buildSuccessState(data));
                } catch (err: unknown) {
                  const message = err instanceof Error ? err.message : t('common.unknown_error');
                  const status = getStatusFromError(err);
                  commitCard(file.name, () => adapter.buildErrorState(message, status));
                }
              })
            );
          })
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setBatchLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [t]
  );

  return { batchLoading, loadQuota };
}
