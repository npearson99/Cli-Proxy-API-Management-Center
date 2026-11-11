import { useCallback, useEffect, useState } from 'react';
import {
  PANEL_CHECK_INTERVAL_MS,
  PANEL_RELOADED_FOR_KEY,
  panelUpdateAction,
  readServedLastModified,
  type PanelCheckMoment,
} from '@/utils/panelUpdate';

function reloadedFor(): string | null {
  try {
    return window.sessionStorage.getItem(PANEL_RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

function reloadFor(served: string) {
  try {
    window.sessionStorage.setItem(PANEL_RELOADED_FOR_KEY, served);
  } catch {
    // Without storage the loop guard is gone, but one reload still gets the new page.
  }
  window.location.reload();
}

/**
 * Keeps an open tab on the installed panel: checks the served page's Last-Modified on
 * load, every PANEL_CHECK_INTERVAL_MS, and as the tab comes back into view. Returns
 * whether a newer panel is waiting for a reload this hook would not do on its own.
 */
export function usePanelUpdateCheck() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let disposed = false;
    let pending: string | null = null;
    const url = window.location.pathname || '/management.html';

    const act = (served: string | null, moment: PanelCheckMoment) => {
      const action = panelUpdateAction({
        served,
        loaded: document.lastModified,
        moment,
        hash: window.location.hash,
        reloadedFor: reloadedFor(),
      });
      if (action === 'reload' && served) {
        reloadFor(served);
      } else if (action === 'offer') {
        pending = served;
        setAvailable(true);
      }
    };

    const check = async (moment: PanelCheckMoment) => {
      const served = await readServedLastModified(url);
      if (!disposed) act(served, moment);
    };

    void check('load');
    const timer = window.setInterval(() => void check('interval'), PANEL_CHECK_INTERVAL_MS);
    const onVisibility = () => {
      if (document.hidden) {
        // Already known to be stale: no read needed to act on it.
        if (pending) act(pending, 'hidden');
      } else {
        void check('return');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const reload = useCallback(() => window.location.reload(), []);
  return { available, reload };
}
