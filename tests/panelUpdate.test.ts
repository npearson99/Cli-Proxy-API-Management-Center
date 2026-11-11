import { describe, expect, test } from 'bun:test';
import {
  isNewerPanel,
  isReadOnlyRoute,
  panelUpdateAction,
  readServedLastModified,
} from '@/utils/panelUpdate';

// The release the quota page missed (tr.8), and what the stale tab ran before it.
const SERVED = 'Tue, 10 Nov 2026 22:36:08 GMT';
const OLD = 'Mon, 09 Nov 2026 20:42:54 GMT';

/** document.lastModified's own form: local time, MM/DD/YYYY HH:MM:SS. */
function documentForm(httpDate: string): string {
  const d = new Date(httpDate);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

describe('isNewerPanel', () => {
  test('a page loaded before the release is stale', () => {
    expect(isNewerPanel(SERVED, documentForm(OLD))).toBe(true);
  });

  test('the page that was served is not', () => {
    expect(isNewerPanel(SERVED, documentForm(SERVED))).toBe(false);
  });

  test('a page newer than the server says is not stale', () => {
    // A dev server sends no Last-Modified, and document.lastModified is then load time.
    expect(isNewerPanel(OLD, documentForm(SERVED))).toBe(false);
  });

  test('unknown is not newer', () => {
    for (const served of [null, undefined, '', 'not a date']) {
      expect(isNewerPanel(served, documentForm(OLD))).toBe(false);
    }
    expect(isNewerPanel(SERVED, 'garbage')).toBe(false);
  });

  test('a second apart is newer', () => {
    const later = new Date(Date.parse(SERVED) + 1000).toUTCString();
    expect(isNewerPanel(later, documentForm(SERVED))).toBe(true);
  });
});

describe('readServedLastModified', () => {
  test('asks for one byte, uncached, and reads the header', async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('<', { status: 206, headers: { 'Last-Modified': SERVED } });
    }) as unknown as typeof fetch;
    expect(await readServedLastModified('/management.html', fake)).toBe(SERVED);
    expect(seen[0].cache).toBe('no-store');
    expect((seen[0].headers as Record<string, string>).Range).toBe('bytes=0-0');
  });

  test('a server that ignores Range still answers', async () => {
    const fake = (async () =>
      new Response('<html>'.repeat(1000), { status: 200, headers: { 'Last-Modified': SERVED } })
    ) as unknown as typeof fetch;
    expect(await readServedLastModified('/management.html', fake)).toBe(SERVED);
  });

  test('a failed or refused read is unknown, not an error', async () => {
    const refused = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await readServedLastModified('/management.html', refused)).toBeNull();
    expect(await readServedLastModified('/management.html', down)).toBeNull();
  });
});

describe('isReadOnlyRoute', () => {
  test('pages that only show state', () => {
    for (const hash of ['', '#/', '#/dashboard', '#/quota', '#/logs', '#/quota?x=1']) {
      expect(isReadOnlyRoute(hash)).toBe(true);
    }
  });

  test('pages that edit', () => {
    for (const hash of ['#/config', '#/auth-files', '#/auth-files/oauth-model-alias',
      '#/ai-providers', '#/quick-start', '#/plugins', '#/oauth', '#/system']) {
      expect(isReadOnlyRoute(hash)).toBe(false);
    }
  });
});

describe('panelUpdateAction', () => {
  const stale = { served: SERVED, loaded: documentForm(OLD), reloadedFor: null };

  test('nothing when the page is current or the read failed', () => {
    expect(panelUpdateAction({ ...stale, loaded: documentForm(SERVED), moment: 'load',
      hash: '#/quota' })).toBe('none');
    expect(panelUpdateAction({ ...stale, served: null, moment: 'return',
      hash: '#/quota' })).toBe('none');
  });

  test('a stale page reloads as it loads, on any route: nothing is edited yet', () => {
    for (const hash of ['#/quota', '#/config']) {
      expect(panelUpdateAction({ ...stale, moment: 'load', hash })).toBe('reload');
    }
  });

  test('the 2026-11-11 tab: the quota page left open, looked at again', () => {
    expect(panelUpdateAction({ ...stale, moment: 'return', hash: '#/quota' })).toBe('reload');
    expect(panelUpdateAction({ ...stale, moment: 'hidden', hash: '#/quota' })).toBe('reload');
  });

  test('in use, or on a page that edits, it is offered, not forced', () => {
    expect(panelUpdateAction({ ...stale, moment: 'interval', hash: '#/quota' })).toBe('offer');
    for (const moment of ['return', 'hidden', 'interval'] as const) {
      expect(panelUpdateAction({ ...stale, moment, hash: '#/config' })).toBe('offer');
    }
  });

  test('a reload that came back with the same old page is not tried again', () => {
    for (const moment of ['load', 'return', 'hidden'] as const) {
      expect(panelUpdateAction({ ...stale, reloadedFor: SERVED, moment,
        hash: '#/quota' })).toBe('offer');
    }
    // A later release is a new reason to reload.
    const later = new Date(Date.parse(SERVED) + 86_400_000).toUTCString();
    expect(panelUpdateAction({ ...stale, served: later, reloadedFor: SERVED, moment: 'load',
      hash: '#/quota' })).toBe('reload');
  });
});
