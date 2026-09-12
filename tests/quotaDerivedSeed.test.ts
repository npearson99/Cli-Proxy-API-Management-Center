import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { seedDerivedQuota } from '@/features/quota/derivedSeed';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaAdapter, QuotaCardState } from '@/features/quota/providers';

const t = ((key: string) => key) as TFunction;

const entry = (name: string, type: QuotaFileEntry['type'] = 'claude'): QuotaFileEntry =>
  ({ file: { name }, type }) as QuotaFileEntry;

/** Stands in for a provider whose listing carries headers; observedAtMs marks a seed. */
const adapter = (observedAtMs: number | null, type: QuotaAdapter['type'] = 'claude') =>
  ({
    type,
    deriveQuota: () =>
      observedAtMs === null ? null : ({ status: 'success', observedAtMs } as QuotaCardState),
  }) as unknown as QuotaAdapter;

describe('seeding the quota grid from the auth-file listing', () => {
  test('fills a card that has nothing', () => {
    const next = seedDerivedQuota([entry('a.json')], {}, adapter(1000), t);
    expect(next).toEqual({ 'a.json': { status: 'success', observedAtMs: 1000 } });
  });

  test('fills a card left idle', () => {
    const next = seedDerivedQuota([entry('a.json')], { 'a.json': { status: 'idle' } }, adapter(1000), t);
    expect(next?.['a.json']).toEqual({ status: 'success', observedAtMs: 1000 });
  });

  test('leaves a fetched card alone even when the listing is newer', () => {
    // The fetched card carries the plan tier and extra-usage block that the
    // headers cannot report, so a newer seed is still the poorer answer.
    const fetched: Record<string, QuotaCardState> = { 'a.json': { status: 'success' } };
    expect(seedDerivedQuota([entry('a.json')], fetched, adapter(9999), t)).toBeNull();
  });

  test('leaves a card mid-fetch and a card that failed alone', () => {
    expect(seedDerivedQuota([entry('a.json')], { 'a.json': { status: 'loading' } }, adapter(1), t)).toBeNull();
    expect(
      seedDerivedQuota([entry('a.json')], { 'a.json': { status: 'error', error: 'HTTP 429' } }, adapter(1), t)
    ).toBeNull();
  });

  test('replaces an earlier seed the listing has improved on, and not a later one', () => {
    const seeded: Record<string, QuotaCardState> = {
      'a.json': { status: 'success', observedAtMs: 1000 },
    };
    expect(seedDerivedQuota([entry('a.json')], seeded, adapter(2000), t)?.['a.json']).toEqual({
      status: 'success',
      observedAtMs: 2000,
    });
    expect(seedDerivedQuota([entry('a.json')], seeded, adapter(1000), t)).toBeNull();
    expect(seedDerivedQuota([entry('a.json')], seeded, adapter(500), t)).toBeNull();
  });

  test('skips entries belonging to another provider', () => {
    expect(seedDerivedQuota([entry('a.json', 'codex')], {}, adapter(1000, 'claude'), t)).toBeNull();
  });

  test('is a no-op for a provider with no listing-borne quota', () => {
    const noDerive = { type: 'xai' } as unknown as QuotaAdapter;
    expect(seedDerivedQuota([entry('a.json', 'xai')], {}, noDerive, t)).toBeNull();
  });

  test('reports no change rather than an equal copy, so the grid does not re-render', () => {
    const seeded: Record<string, QuotaCardState> = {
      'a.json': { status: 'success', observedAtMs: 1000 },
      'b.json': { status: 'success', observedAtMs: 1000 },
    };
    expect(seedDerivedQuota([entry('a.json'), entry('b.json')], seeded, adapter(1000), t)).toBeNull();
  });

  test('keeps the cards it did not touch', () => {
    const current: Record<string, QuotaCardState> = { 'b.json': { status: 'success' } };
    const next = seedDerivedQuota([entry('a.json'), entry('b.json')], current, adapter(1000), t);
    expect(next).toEqual({
      'b.json': { status: 'success' },
      'a.json': { status: 'success', observedAtMs: 1000 },
    });
    expect(current['b.json']).toEqual({ status: 'success' });
  });
});
