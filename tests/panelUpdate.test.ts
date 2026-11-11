import { describe, expect, test } from 'bun:test';
import {
  createPanelUpdateChecker,
  isNewerPanel,
  isReadOnlyRoute,
  panelUpdateAction,
  readServedLastModified,
  type PanelUpdateEnv,
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

  test('a panel installed in the repeated fall-back hour is not newer than itself', () => {
    // document.lastModified has no offset: 1:30 AM PST on 2026-11-01 reads back as
    // 1:30 AM PDT, an hour early. Compared as instants that looked like a newer panel,
    // so every load reloaded once and then offered a banner for the rest of the session.
    const original = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const secondPass = 'Sun, 01 Nov 2026 09:30:00 GMT'; // 1:30 AM PST
      expect(documentForm(secondPass)).toBe('11/01/2026 01:30:00');
      expect(isNewerPanel(secondPass, documentForm(secondPass))).toBe(false);
      // A release across the change is still newer: 12:30 AM PDT, then 1:30 AM PST.
      expect(isNewerPanel(secondPass, documentForm('Sun, 01 Nov 2026 07:30:00 GMT'))).toBe(true);
    } finally {
      // Deleting TZ does not put Bun back on the test runner's UTC.
      process.env.TZ = original ?? 'Etc/UTC';
    }
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

  test('a server that ignores Range still answers, and the page is not downloaded', async () => {
    const whole = new Response('<html>'.repeat(1000), {
      status: 200,
      headers: { 'Last-Modified': SERVED },
    });
    const fake = (async () => whole) as unknown as typeof fetch;
    expect(await readServedLastModified('/management.html', fake)).toBe(SERVED);
    expect(whole.bodyUsed).toBe(true); // cancelled, not left streaming 2.9 MB
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
  const stale = { served: SERVED, loaded: documentForm(OLD), reloadedFor: null, dialogOpen: false };

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

  test('an open dialog is offered, not reloaded: a reset claim may be in flight', () => {
    for (const moment of ['load', 'return', 'hidden'] as const) {
      expect(panelUpdateAction({ ...stale, dialogOpen: true, moment,
        hash: '#/quota' })).toBe('offer');
    }
  });
});

/** A browser for the checker: records what it did, answers reads when told to. */
function fakeEnv(overrides: Partial<PanelUpdateEnv> & { storage?: 'ok' | 'broken' } = {}) {
  const { storage = 'ok', ...rest } = overrides;
  const did = { reloads: 0, offers: 0, reads: 0, stored: null as string | null };
  const reads: Array<(served: string | null) => void> = [];
  const env: PanelUpdateEnv = {
    readServed: () => {
      did.reads += 1;
      return new Promise((resolve) => reads.push(resolve));
    },
    loaded: () => documentForm(OLD),
    hash: () => '#/quota',
    dialogOpen: () => false,
    reloadedFor: () => (storage === 'ok' ? did.stored : null),
    recordReload: (served) => {
      if (storage === 'broken') return false;
      did.stored = served;
      return true;
    },
    reload: () => {
      did.reloads += 1;
    },
    offer: () => {
      did.offers += 1;
    },
    ...rest,
  };
  const answer = async (served: string | null) => {
    const resolve = reads.shift();
    if (!resolve) throw new Error('no read in flight');
    resolve(served);
    await Promise.resolve();
    await Promise.resolve();
  };
  return { env, did, answer };
}

describe('createPanelUpdateChecker', () => {
  test('a stale page reloads once as it loads, and records what it reloaded for', async () => {
    const { env, did, answer } = fakeEnv();
    const checker = createPanelUpdateChecker(env);
    const done = checker.check('load');
    await answer(SERVED);
    await done;
    expect(did).toMatchObject({ reloads: 1, offers: 0, stored: SERVED });
  });

  test('the reload came back with the same old page: offered, not reloaded again', async () => {
    const { env, did, answer } = fakeEnv();
    env.recordReload(SERVED);
    const checker = createPanelUpdateChecker(env);
    const done = checker.check('load');
    await answer(SERVED);
    await done;
    expect(did).toMatchObject({ reloads: 0, offers: 1 });
  });

  test('without sessionStorage it never reloads on its own: nothing would stop a loop', async () => {
    const { env, did, answer } = fakeEnv({ storage: 'broken' });
    const checker = createPanelUpdateChecker(env);
    for (const moment of ['load', 'return'] as const) {
      const done = checker.check(moment);
      await answer(SERVED);
      await done;
    }
    checker.hide();
    expect(did).toMatchObject({ reloads: 0, offers: 3 });
  });

  test('StrictMode: a read that lands after unmount does nothing', async () => {
    const { env, did, answer } = fakeEnv();
    const first = createPanelUpdateChecker(env);
    const firstDone = first.check('load');
    first.dispose();
    const second = createPanelUpdateChecker(env);
    const secondDone = second.check('load');
    await answer(SERVED);
    await firstDone;
    expect(did).toMatchObject({ reloads: 0, offers: 0 });
    await answer(SERVED);
    await secondDone;
    expect(did).toMatchObject({ reloads: 1, offers: 0 });
  });

  test('offered while in use, then reloaded as the tab hides on a read-only page', async () => {
    let hash = '#/config';
    const { env, did, answer } = fakeEnv({ hash: () => hash });
    const checker = createPanelUpdateChecker(env);
    const done = checker.check('interval');
    await answer(SERVED);
    await done;
    expect(did).toMatchObject({ reloads: 0, offers: 1 });
    checker.hide(); // still on the config page
    expect(did).toMatchObject({ reloads: 0, offers: 2, reads: 1 });
    hash = '#/quota';
    checker.hide();
    expect(did).toMatchObject({ reloads: 1, reads: 1, stored: SERVED });
  });

  test('hiding before anything newer was found does nothing', () => {
    const { env, did } = fakeEnv();
    createPanelUpdateChecker(env).hide();
    expect(did).toMatchObject({ reloads: 0, offers: 0, reads: 0 });
  });

  test('the banner button reloads, and the loop guard covers it', async () => {
    const { env, did, answer } = fakeEnv({ hash: () => '#/config' });
    const checker = createPanelUpdateChecker(env);
    const done = checker.check('interval');
    await answer(SERVED);
    await done;
    checker.reloadNow();
    expect(did).toMatchObject({ reloads: 1, stored: SERVED });
  });
});
