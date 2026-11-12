import { describe, expect, test } from 'bun:test';
import { QUOTA_PAGE_SIZE } from '@/features/quota/constants';
import {
  buildTabCounts,
  classifyQuotaFiles,
  countDisabledEntries,
  filterEntriesByTab,
  isDisabledQuotaEntry,
  isQuotaRefreshDisabled,
  offersQuotaReset,
  paginate,
  resolveQuotaProviderType,
  sortQuotaEntries,
  type QuotaFileEntry,
} from '@/features/quota/logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '@/features/quota/providers';
import type { AuthFileItem } from '@/types';

const file = (name: string, provider: string, extra: Partial<AuthFileItem> = {}): AuthFileItem =>
  ({ name, provider, ...extra }) as AuthFileItem;

const FILES: AuthFileItem[] = [
  file('codex-a.json', 'codex'),
  file('claude-a.json', 'claude'),
  file('kimi-a.json', 'kimi'),
  file('codex-b.json', 'codex'),
  file('grok-a.json', 'grok'), // 别名归一到 xai
  file('gemini-a.json', 'gemini'), // 不支持额度
  file('claude-off.json', 'claude', { disabled: true }), // 停用
];

describe('resolveQuotaProviderType', () => {
  test('maps provider aliases, rejects unsupported files and keeps disabled ones', () => {
    expect(resolveQuotaProviderType(file('a', 'grok'))).toBe('xai');
    expect(resolveQuotaProviderType(file('a', 'antigravity'))).toBe('antigravity');
    expect(resolveQuotaProviderType(file('a', 'gemini'))).toBeNull();
    // A parked or switched-off seat must still get its card.
    expect(resolveQuotaProviderType(file('a', 'claude', { disabled: true }))).toBe('claude');
    expect(resolveQuotaProviderType(file('a', 'codex', { disabled: true }))).toBe('codex');
  });
});

describe('classifyQuotaFiles', () => {
  test('drops unsupported files and keeps disabled ones', () => {
    const entries = classifyQuotaFiles(FILES);
    expect(entries.map((entry) => entry.file.name)).not.toContain('gemini-a.json');
    expect(entries.map((entry) => entry.file.name)).toContain('claude-off.json');
    expect(entries).toHaveLength(6);
  });

  test('orders entries by provider tab order', () => {
    const entries = classifyQuotaFiles(FILES);
    expect(entries.map((entry) => entry.type)).toEqual([
      'claude',
      'claude',
      'codex',
      'codex',
      'xai',
      'kimi',
    ]);
  });
});

describe('isDisabledQuotaEntry', () => {
  test('reads the disabled flag in every shape the listing sends it', () => {
    const entry = (disabled: unknown) =>
      ({ file: { name: 'x', disabled }, type: 'codex' }) as unknown as QuotaFileEntry;
    expect(isDisabledQuotaEntry(entry(true))).toBe(true);
    expect(isDisabledQuotaEntry(entry('true'))).toBe(true);
    expect(isDisabledQuotaEntry(entry(1))).toBe(true);
    expect(isDisabledQuotaEntry(entry(false))).toBe(false);
    expect(isDisabledQuotaEntry(entry(undefined))).toBe(false);
    expect(isDisabledQuotaEntry(entry('false'))).toBe(false);
  });
});

describe('buildTabCounts', () => {
  test('counts every card a tab shows, disabled ones included, zero-filling empty tabs', () => {
    expect(buildTabCounts(classifyQuotaFiles(FILES))).toEqual({
      all: 6,
      claude: 2,
      antigravity: 0,
      codex: 2,
      xai: 1,
      kimi: 1,
    });
  });

  test('countDisabledEntries counts the disabled cards among them', () => {
    expect(countDisabledEntries(classifyQuotaFiles(FILES))).toBe(1);
    expect(countDisabledEntries([])).toBe(0);
  });
});

describe('filterEntriesByTab', () => {
  const entries = classifyQuotaFiles(FILES);

  test("passes everything through on the 'all' tab", () => {
    expect(filterEntriesByTab(entries, 'all')).toHaveLength(6);
  });

  test('keeps a disabled card in its provider tab', () => {
    expect(filterEntriesByTab(entries, 'claude').map((entry) => entry.file.name)).toEqual([
      'claude-a.json',
      'claude-off.json',
    ]);
  });

  test('filters to a single provider', () => {
    expect(filterEntriesByTab(entries, 'codex').map((entry) => entry.file.name)).toEqual([
      'codex-a.json',
      'codex-b.json',
    ]);
    expect(filterEntriesByTab(entries, 'antigravity')).toEqual([]);
  });
});

describe('isQuotaRefreshDisabled', () => {
  test('blocks a single-card refresh while the same quota is resetting', () => {
    expect(isQuotaRefreshDisabled(true, false, true)).toBe(true);
    expect(isQuotaRefreshDisabled(true, false, false)).toBe(false);
  });
});

describe('offersQuotaReset', () => {
  const codex = QUOTA_ADAPTERS.codex;
  const withCredit = {
    status: 'success',
    rateLimitResetCreditsAvailableCount: 1,
  } as unknown as QuotaCardState;

  test('a loaded card with a reset to spend offers it on an enabled credential', () => {
    expect(offersQuotaReset(codex, withCredit, false)).toBe(true);
  });

  test('a disabled credential never offers a reset, whatever it holds', () => {
    expect(offersQuotaReset(codex, withCredit, true)).toBe(false);
  });

  test('nothing to spend, nothing loaded, or no reset on the provider: no offer', () => {
    const none = { status: 'success', rateLimitResetCreditsAvailableCount: 0 } as QuotaCardState;
    expect(offersQuotaReset(codex, none, false)).toBe(false);
    expect(offersQuotaReset(codex, { ...withCredit, status: 'loading' }, false)).toBe(false);
    expect(offersQuotaReset(codex, undefined, false)).toBe(false);
    expect(offersQuotaReset(QUOTA_ADAPTERS.kimi, withCredit, false)).toBe(false);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 45 }, (_, index) => index);

  test('uses the configured 20-item page size', () => {
    expect(QUOTA_PAGE_SIZE).toBe(20);
    expect(paginate(items, 2, QUOTA_PAGE_SIZE)).toEqual({
      pageItems: items.slice(20, 40),
      currentPage: 2,
      totalPages: 3,
    });
  });

  test('clamps an out-of-range page instead of returning an empty slice', () => {
    expect(paginate(items, 9, QUOTA_PAGE_SIZE).currentPage).toBe(3);
    expect(paginate(items, 9, QUOTA_PAGE_SIZE).pageItems).toEqual(items.slice(40));
    expect(paginate(items, 0, QUOTA_PAGE_SIZE).currentPage).toBe(1);
  });

  test('keeps at least one page when the list is empty', () => {
    expect(paginate([], 1, QUOTA_PAGE_SIZE)).toEqual({
      pageItems: [],
      currentPage: 1,
      totalPages: 1,
    });
  });
});

describe('sortQuotaEntries', () => {
  // The ordering rules among enabled cards; disabled ones have their own block below.
  const entries = classifyQuotaFiles(FILES).filter((entry) => !isDisabledQuotaEntry(entry));
  const byName = (list: QuotaFileEntry[]) => list.map((entry) => entry.file.name);

  /** Recovery instants keyed by file name; anything absent resolves to null. */
  const resolver = (instants: Record<string, number>) => (entry: QuotaFileEntry) =>
    instants[entry.file.name] ?? null;

  test('default mode preserves order but returns a new array', () => {
    const sorted = sortQuotaEntries(entries, 'default', () => 1);
    expect(byName(sorted)).toEqual(byName(entries));
    expect(sorted).not.toBe(entries);
  });

  test('orders loaded credentials by how soon they recover, across providers', () => {
    const sorted = sortQuotaEntries(
      entries,
      'soonest',
      resolver({
        'codex-a.json': 300,
        'claude-a.json': 100,
        'kimi-a.json': 200,
        'codex-b.json': 400,
        'grok-a.json': 50,
      })
    );
    expect(byName(sorted)).toEqual([
      'grok-a.json',
      'claude-a.json',
      'kimi-a.json',
      'codex-a.json',
      'codex-b.json',
    ]);
  });

  test('weekly mode applies the same ordering rules through its own resolver', () => {
    // The mode itself is opaque to sortQuotaEntries: only 'default' short-circuits.
    const sorted = sortQuotaEntries(
      entries,
      'weekly',
      resolver({ 'codex-b.json': 200, 'claude-a.json': 100 })
    );
    expect(byName(sorted).slice(0, 2)).toEqual(['claude-a.json', 'codex-b.json']);
  });

  test('sinks credentials with no instant, keeping their provider-grouped order', () => {
    // Loading is click-to-fetch, so an unloaded tail is the normal case.
    const sorted = sortQuotaEntries(
      entries,
      'soonest',
      resolver({ 'codex-b.json': 200, 'kimi-a.json': 100 })
    );
    expect(byName(sorted)).toEqual([
      'kimi-a.json',
      'codex-b.json',
      // unresolved tail, in the order classifyQuotaFiles produced
      'claude-a.json',
      'codex-a.json',
      'grok-a.json',
    ]);
  });

  test('leaves the order untouched when nothing has loaded', () => {
    expect(byName(sortQuotaEntries(entries, 'soonest', () => null))).toEqual(byName(entries));
  });

  test('breaks ties on the original position, so equal instants stay stable', () => {
    const sorted = sortQuotaEntries(entries, 'soonest', () => 500);
    expect(byName(sorted)).toEqual(byName(entries));
  });

  test('does not mutate the input', () => {
    const input = [...entries];
    sortQuotaEntries(input, 'soonest', resolver({ 'codex-b.json': 1 }));
    expect(input).toEqual(entries);
  });

  test('sorts before paginating, so the globally soonest lands on page one', () => {
    // Last in the default order, first to recover.
    const last = entries[entries.length - 1].file.name;
    const sorted = sortQuotaEntries(entries, 'soonest', resolver({ [last]: 1 }));
    expect(paginate(sorted, 1, 2).pageItems[0].file.name).toBe(last);
  });
});

describe('sortQuotaEntries with disabled credentials', () => {
  const entries = classifyQuotaFiles([
    file('claude-off-b.json', 'claude', { disabled: true }),
    file('claude-a.json', 'claude'),
    file('codex-off.json', 'codex', { disabled: 'true' } as unknown as Partial<AuthFileItem>),
    file('codex-a.json', 'codex'),
    file('claude-off-a.json', 'claude', { disabled: true }),
  ]);
  const byName = (list: QuotaFileEntry[]) => list.map((entry) => entry.file.name);
  const DISABLED_TAIL = ['claude-off-b.json', 'claude-off-a.json', 'codex-off.json'];

  test('default mode puts every disabled card after the enabled ones, keeping their order', () => {
    expect(byName(sortQuotaEntries(entries, 'default', () => null))).toEqual([
      'claude-a.json',
      'codex-a.json',
      ...DISABLED_TAIL,
    ]);
  });

  test('a disabled card that recovers first still sorts after every enabled card', () => {
    for (const mode of ['soonest', 'weekly'] as const) {
      const sorted = sortQuotaEntries(entries, mode, (entry) =>
        entry.file.name.includes('-off') ? 1 : entry.file.name === 'codex-a.json' ? 100 : null
      );
      expect(byName(sorted)).toEqual(['codex-a.json', 'claude-a.json', ...DISABLED_TAIL]);
    }
  });

  test('the disabled tail keeps the order the mode gives it', () => {
    const sorted = sortQuotaEntries(entries, 'soonest', (entry) =>
      entry.file.name === 'codex-off.json' ? 1 : entry.file.name === 'claude-off-a.json' ? 2 : 3
    );
    // Within the tail the mode's own rule holds: by instant, then incoming order.
    expect(byName(sorted).slice(2)).toEqual([
      'codex-off.json',
      'claude-off-a.json',
      'claude-off-b.json',
    ]);
    expect(byName(sortQuotaEntries(entries, 'soonest', () => null)).slice(2)).toEqual(
      DISABLED_TAIL
    );
  });
});
