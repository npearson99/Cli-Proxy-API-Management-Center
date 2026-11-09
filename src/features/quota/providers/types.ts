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

export interface QuotaResetDescription {
  /** Handed back to `resetQuota`, so the claim spends what the dialog named. */
  option?: string;
  title: string;
  message: string;
  confirmText: string;
}

export interface QuotaProviderData<TState, TData> {
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
  /** `option` is what `describeReset` chose to spend, when the provider has a choice. */
  resetQuota?: (file: AuthFileItem, t: TFunction, option?: string) => Promise<TData>;
  canResetQuota?: (quota: TState) => boolean;
  /**
   * The confirmation a reset asks for, naming what it is about to spend. Absent: the
   * provider's `reset_confirm_*` keys with the file name. Null: nothing can be spent.
   */
  describeReset?: (file: AuthFileItem, quota: TState, t: TFunction) => QuotaResetDescription | null;
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
