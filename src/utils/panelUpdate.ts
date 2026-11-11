/**
 * Whether a newer panel is installed than the one this page is running, and what to do
 * about it.
 *
 * CPA serves management.html with Last-Modified and no Cache-Control. So Chrome may
 * reuse a cached copy for a while after the panel is replaced, and a tab left open keeps
 * the copy it loaded until it reloads. On 2026-11-11 the quota page in Nate's Chrome
 * still ran a panel from before the banked Claude resets, a day after the release that
 * added them.
 *
 * A one-byte ranged read of the page, uncached, returns the served file's Last-Modified;
 * document.lastModified is the one this page loaded.
 */

export const PANEL_CHECK_INTERVAL_MS = 5 * 60_000;

// Last-Modified and document.lastModified both carry whole seconds.
const SLACK_MS = 1_000;

/** sessionStorage key: the served Last-Modified this tab last reloaded for. */
export const PANEL_RELOADED_FOR_KEY = 'cpamc.panel-reloaded-for';

/** document.lastModified's form for an instant: local time, MM/DD/YYYY HH:MM:SS, no zone. */
export function documentLastModifiedForm(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** True when the served panel is newer than the loaded one. Unknown is not newer. */
export function isNewerPanel(served: string | null | undefined, loaded: string): boolean {
  if (!served) return false;
  const servedInstant = Date.parse(served);
  if (Number.isNaN(servedInstant)) return false;
  // document.lastModified carries no offset, so in the hour a fall-back repeats it parses
  // an hour early. The served time goes through the same form, so a file always compares
  // equal to itself; inside that hour a newer file can read as older, never the reverse.
  const servedAt = Date.parse(documentLastModifiedForm(servedInstant));
  const loadedAt = Date.parse(loaded);
  if (Number.isNaN(servedAt) || Number.isNaN(loadedAt)) return false;
  return servedAt - loadedAt >= SLACK_MS;
}

/** The served page's Last-Modified, or null when it cannot be read. */
export async function readServedLastModified(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    // A server that ignores Range sends the whole page; the header is all this needs.
    void response.body?.cancel().catch(() => undefined);
    if (!response.ok) return null;
    return response.headers.get('Last-Modified');
  } catch {
    return null;
  }
}

// Pages that show state and edit none: reloading one loses nothing.
const READ_ONLY_ROUTES = new Set(['/', '/dashboard', '/quota', '/logs']);

function routePath(hash: string): string {
  return hash.replace(/^#/, '').split('?')[0] || '/';
}

export function isReadOnlyRoute(hash: string): boolean {
  return READ_ONLY_ROUTES.has(routePath(hash));
}

/**
 * When a check runs: as the page loads, as the tab comes back into view, as it goes out
 * of view, or on the timer while it is in use.
 */
export type PanelCheckMoment = 'load' | 'return' | 'hidden' | 'interval';

export type PanelUpdateAction = 'none' | 'reload' | 'offer';

/**
 * Reload when nothing can be lost: as the page loads (it was served stale from cache),
 * or on a read-only page while the tab comes back or goes out of view. Anywhere else,
 * offer it: a reload mid-edit would lose the edit. An open dialog is offered too: on a
 * read-only page it is a confirmation, or a reset or clear still in flight, which a
 * reload would cut off with its outcome unknown. So is a login that does not survive a
 * reload (signed in without "remember"): the reload would land on the login page. A
 * reload that came back with the same old page is not tried again, or a cache that will
 * not let go would loop.
 */
export function panelUpdateAction(args: {
  served: string | null | undefined;
  loaded: string;
  moment: PanelCheckMoment;
  hash: string;
  reloadedFor: string | null;
  dialogOpen: boolean;
  keepsLogin: boolean;
}): PanelUpdateAction {
  const { served, loaded, moment, hash, reloadedFor, dialogOpen, keepsLogin } = args;
  if (!isNewerPanel(served, loaded)) return 'none';
  if (reloadedFor && reloadedFor === served) return 'offer';
  if (dialogOpen) return 'offer';
  if (!keepsLogin && routePath(hash) !== '/login') return 'offer';
  if (moment === 'load') return 'reload';
  if ((moment === 'return' || moment === 'hidden') && isReadOnlyRoute(hash)) return 'reload';
  return 'offer';
}

/** What the checker needs from the browser, so it can run without one in tests. */
export interface PanelUpdateEnv {
  readServed(): Promise<string | null>;
  /** document.lastModified */
  loaded(): string;
  /** window.location.hash */
  hash(): string;
  dialogOpen(): boolean;
  /** The login survives a reload: signed in with "remember". */
  keepsLogin(): boolean;
  /** The served version this tab last reloaded for. */
  reloadedFor(): string | null;
  /** Records the version a reload is for; false when it could not be recorded. */
  recordReload(served: string): boolean;
  reload(): void;
  /** A newer panel is waiting for a reload the checker will not do on its own. */
  offer(): void;
}

export interface PanelUpdateChecker {
  check(moment: Exclude<PanelCheckMoment, 'hidden'>): Promise<void>;
  /** The tab went out of view: act on a newer panel already found, without a read. */
  hide(): void;
  /** The banner's button: the user asked for it. */
  reloadNow(): void;
  /** After this, reads still in flight change nothing (StrictMode mounts twice). */
  dispose(): void;
}

export function createPanelUpdateChecker(env: PanelUpdateEnv): PanelUpdateChecker {
  let disposed = false;
  let pending: string | null = null;

  const act = (served: string | null, moment: PanelCheckMoment) => {
    if (disposed) return;
    const action = panelUpdateAction({
      served,
      loaded: env.loaded(),
      moment,
      hash: env.hash(),
      reloadedFor: env.reloadedFor(),
      dialogOpen: env.dialogOpen(),
      keepsLogin: env.keepsLogin(),
    });
    if (action === 'none' || !served) return;
    // A reload this tab cannot record is not tried: on a cache that will not let go it
    // would come back to the same old page and reload again, forever.
    if (action === 'reload' && env.recordReload(served)) {
      env.reload();
      return;
    }
    pending = served;
    env.offer();
  };

  return {
    async check(moment) {
      act(await env.readServed(), moment);
    },
    hide() {
      if (pending) act(pending, 'hidden');
    },
    reloadNow() {
      if (pending) env.recordReload(pending);
      env.reload();
    },
    dispose() {
      disposed = true;
    },
  };
}
