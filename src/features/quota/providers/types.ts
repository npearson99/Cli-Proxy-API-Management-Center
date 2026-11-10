/**
 * 额度提供商数据层契约。
 *
 * data.ts 模块只做「取数 + 状态构造」：不 import React、不 import SCSS，
 * 因此可以被 bun:test 纯逻辑测试直接消费。渲染由同目录的 *QuotaBody 组件承担。
 */

import type { TFunction } from 'i18next';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  KimiQuotaState,
  XaiQuotaState,
} from '@/types';

export type QuotaUpdater<T> = T | ((prev: T) => T);

export type QuotaProviderType = 'antigravity' | 'claude' | 'codex' | 'kimi' | 'xai';

/** useQuotaStore 的结构契约（storeSelector/storeSetter 依赖）。 */
export interface QuotaStore {
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  xaiQuota: Record<string, XaiQuotaState>;
  setAntigravityQuota: (updater: QuotaUpdater<Record<string, AntigravityQuotaState>>) => void;
  setClaudeQuota: (updater: QuotaUpdater<Record<string, ClaudeQuotaState>>) => void;
  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;
  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;
  setXaiQuota: (updater: QuotaUpdater<Record<string, XaiQuotaState>>) => void;
  clearQuotaCache: () => void;
}

export interface QuotaResetDescription<TOption = unknown> {
  /**
   * Handed back to `resetQuota`, so the claim spends what the dialog named, on the
   * premises the dialog stated.
   */
  option?: TOption;
  title: string;
  message: string;
  confirmText: string;
}

export interface QuotaProviderData<TState, TData, TOption = never> {
  type: QuotaProviderType;
  i18nPrefix: string;
  filterFn: (file: AuthFileItem) => boolean;
  fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<TData>;
  /**
   * A card's state built from what `auth-files` already carries, with no upstream
   * request, or null when this credential carries none.
   *
   * Providers whose upstream answers with rate-limit headers get this for free:
   * CPA files the newest set per credential, so the page can paint every card
   * before deciding whether anything is worth fetching live.
   */
  deriveQuota?: (file: AuthFileItem, t: TFunction) => TState | null;
  /**
   * One read that paints a card neither the listing nor a fetch has painted, run once
   * per card per cache generation through the provider's paced queue. For a provider
   * whose cheapest live read already carries everything a card shows, so painting a
   * card costs the one request its supplement would have cost anyway. Throws like
   * `fetchQuota`; the card then shows the error.
   */
  primeQuota?: (file: AuthFileItem, t: TFunction) => Promise<TData>;
  /** `option` is what `describeReset` chose to spend, when the provider has a choice. */
  resetQuota?: (file: AuthFileItem, t: TFunction, option?: TOption) => Promise<TData>;
  canResetQuota?: (quota: TState) => boolean;
  /**
   * The confirmation a reset asks for, naming what it is about to spend. Absent: the
   * provider's `reset_confirm_*` keys with the file name. Null: nothing can be spent.
   */
  describeReset?: (
    file: AuthFileItem,
    quota: TState,
    t: TFunction
  ) => QuotaResetDescription<TOption> | null;
  /** The success notice for a reset that returned `data`; absent: `reset_success`. */
  describeResetSuccess?: (file: AuthFileItem, data: TData, t: TFunction) => string;
  /**
   * Data a card shows that neither the listing nor `deriveQuota` carries, fetched once
   * per card through the provider's paced queue and merged into a card that
   * `needsSupplement`. A live fetch reads the same data itself, so a fetched card
   * never needs it.
   */
  supplementQuota?: (file: AuthFileItem, t: TFunction) => Promise<Partial<TState>>;
  needsSupplement?: (quota: TState) => boolean;
  /** Copies the supplement onto a newer seed replacing a card that already had it. */
  carrySupplement?: (from: TState, to: TState) => TState;
  storeSelector: (state: QuotaStore) => Record<string, TState>;
  storeSetter: keyof QuotaStore;
  buildLoadingState: () => TState;
  buildSuccessState: (data: TData) => TState;
  buildErrorState: (message: string, status?: number) => TState;
}
