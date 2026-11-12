/**
 * 额度页纯逻辑：文件归类、tab 过滤、计数、分页。
 * React-free —— 由 tests/quotaPageLogic.test.ts 直接消费。
 */

import type { AuthFileItem } from '@/types';
import { isDisabledAuthFile } from '@/utils/quota';
import { ANTIGRAVITY_CONFIG } from './providers/antigravity/data';
import { CLAUDE_CONFIG } from './providers/claude/data';
import { CODEX_CONFIG } from './providers/codex/data';
import { KIMI_CONFIG } from './providers/kimi/data';
import { XAI_CONFIG } from './providers/xai/data';
import type { QuotaProviderType } from './providers/types';
import type { QuotaAdapter, QuotaCardState } from './providers';
import { QUOTA_TAB_ORDER, type QuotaSortMode, type QuotaTabId } from './constants';

const QUOTA_FILTER_MAP: Record<QuotaProviderType, (file: AuthFileItem) => boolean> = {
  antigravity: ANTIGRAVITY_CONFIG.filterFn,
  claude: CLAUDE_CONFIG.filterFn,
  codex: CODEX_CONFIG.filterFn,
  kimi: KIMI_CONFIG.filterFn,
  xai: XAI_CONFIG.filterFn,
};

export interface QuotaFileEntry {
  file: AuthFileItem;
  type: QuotaProviderType;
}

export const resolveQuotaProviderType = (file: AuthFileItem): QuotaProviderType | null =>
  QUOTA_TAB_ORDER.find((type) => QUOTA_FILTER_MAP[type](file)) ?? null;

/**
 * 把文件列表归类为额度条目：只过滤不支持额度的文件，
 * 结果按 QUOTA_TAB_ORDER 分组排列（'全部' tab 的卡片顺序即由此决定）。
 *
 * Disabled credentials stay in: a seat cpa-route parked, or one a person switched off,
 * must still show on the page, marked disabled, rather than vanish and read as a
 * failed sign-in. What a disabled seat may not do is decided downstream: it sorts last
 * (sortQuotaEntries), adds no serving capacity (summarizeWeeklyCapacity), and offers no
 * reset (offersQuotaReset, summarizeBankedResets).
 */
export function classifyQuotaFiles(files: AuthFileItem[]): QuotaFileEntry[] {
  const groups = new Map<QuotaProviderType, QuotaFileEntry[]>(
    QUOTA_TAB_ORDER.map((type) => [type, []])
  );
  for (const file of files) {
    const type = resolveQuotaProviderType(file);
    if (!type) continue;
    groups.get(type)?.push({ file, type });
  }
  return QUOTA_TAB_ORDER.flatMap((type) => groups.get(type) ?? []);
}

/** The credential is disabled in CPA, so it serves nothing until someone enables it. */
export const isDisabledQuotaEntry = (entry: { file: { disabled?: unknown } }): boolean =>
  isDisabledAuthFile(entry.file);

export function filterEntriesByTab(entries: QuotaFileEntry[], tab: QuotaTabId): QuotaFileEntry[] {
  if (tab === 'all') return entries;
  return entries.filter((entry) => entry.type === tab);
}

/**
 * Order the grid by whichever credential recovers first.
 *
 * The instant is injected rather than read here: quota lives in the store and
 * arrives asynchronously, and keeping this function store-free is what makes
 * the ordering rules directly testable.
 *
 * Credentials with no instant — not loaded yet, failed, or reporting no
 * upcoming reset — sink to the bottom rather than sorting as "now". They keep
 * their incoming provider-grouped order, so the unloaded tail still reads like
 * the default view instead of an arbitrary shuffle. Because loading is
 * click-to-fetch, that tail is most of the list until the user asks for data.
 *
 * Disabled credentials go after every enabled one in every mode, 'default' included,
 * keeping their relative order: a seat that cannot serve does not belong between
 * seats that can, whatever its reset says.
 *
 * The original index is the final tiebreak, making stability an asserted
 * property rather than an assumption about the engine's sort.
 */
export function sortQuotaEntries(
  entries: QuotaFileEntry[],
  mode: QuotaSortMode,
  resolveNextRecoveryMs: (entry: QuotaFileEntry) => number | null
): QuotaFileEntry[] {
  // 'soonest' and 'weekly' share the ordering rules; the caller expresses the
  // difference entirely through the injected resolver.
  if (mode === 'default') {
    return [
      ...entries.filter((entry) => !isDisabledQuotaEntry(entry)),
      ...entries.filter(isDisabledQuotaEntry),
    ];
  }

  // Decorate once — resolving pokes at provider-shaped state per entry.
  return entries
    .map((entry, index) => ({
      entry,
      index,
      disabled: isDisabledQuotaEntry(entry),
      atMs: resolveNextRecoveryMs(entry),
    }))
    .sort((a, b) => {
      if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
      if (a.atMs === null && b.atMs === null) return a.index - b.index;
      if (a.atMs === null) return 1;
      if (b.atMs === null) return -1;
      return a.atMs - b.atMs || a.index - b.index;
    })
    .map((decorated) => decorated.entry);
}

/**
 * Cards per tab, disabled ones included: the count is what the tab shows. How many of
 * those are disabled is in the page header (countDisabledEntries).
 */
export function buildTabCounts(entries: QuotaFileEntry[]): Record<string, number> {
  const counts: Record<string, number> = { all: entries.length };
  for (const type of QUOTA_TAB_ORDER) {
    counts[type] = 0;
  }
  for (const entry of entries) {
    counts[entry.type] += 1;
  }
  return counts;
}

export const countDisabledEntries = (entries: readonly QuotaFileEntry[]): number =>
  entries.filter(isDisabledQuotaEntry).length;

/**
 * Whether a card offers its reset (Codex reset credit, Claude banked reset): a loaded
 * card whose adapter has one to spend, on an enabled credential. A disabled seat can be
 * read but not reset; CPA routes nothing to it, so a reset there buys nothing.
 */
export const offersQuotaReset = (
  adapter: Pick<QuotaAdapter, 'resetQuota' | 'canResetQuota'>,
  quota: QuotaCardState | undefined,
  disabled: boolean
): boolean =>
  !disabled &&
  quota?.status === 'success' &&
  Boolean(adapter.resetQuota) &&
  Boolean(adapter.canResetQuota?.(quota));

/** A refresh is a read, so a disabled credential's card refreshes like any other. */
export const isQuotaRefreshDisabled = (
  canRefresh: boolean,
  loading: boolean,
  resetting: boolean
): boolean => !canRefresh || loading || resetting;

export interface QuotaPagination<T> {
  pageItems: T[];
  currentPage: number;
  totalPages: number;
}

/** 页码越界时收敛到有效区间（列表缩短后停留在最后一页而不是空页）。 */
export function paginate<T>(items: T[], page: number, pageSize: number): QuotaPagination<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  return {
    pageItems: items.slice(start, start + pageSize),
    currentPage,
    totalPages,
  };
}
