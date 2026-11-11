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

/** True when the served panel is newer than the loaded one. Unknown is not newer. */
export function isNewerPanel(served: string | null | undefined, loaded: string): boolean {
  if (!served) return false;
  const servedAt = Date.parse(served);
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

export function isReadOnlyRoute(hash: string): boolean {
  const path = hash.replace(/^#/, '').split('?')[0] || '/';
  return READ_ONLY_ROUTES.has(path);
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
 * offer it: a reload mid-edit would lose the edit. A reload that came back with the same
 * old page is not tried again, or a cache that will not let go would loop.
 */
export function panelUpdateAction(args: {
  served: string | null | undefined;
  loaded: string;
  moment: PanelCheckMoment;
  hash: string;
  reloadedFor: string | null;
}): PanelUpdateAction {
  const { served, loaded, moment, hash, reloadedFor } = args;
  if (!isNewerPanel(served, loaded)) return 'none';
  if (reloadedFor && reloadedFor === served) return 'offer';
  if (moment === 'load') return 'reload';
  if ((moment === 'return' || moment === 'hidden') && isReadOnlyRoute(hash)) return 'reload';
  return 'offer';
}
