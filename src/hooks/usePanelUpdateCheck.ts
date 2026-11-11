import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PANEL_CHECK_INTERVAL_MS,
  PANEL_RELOADED_FOR_KEY,
  createPanelUpdateChecker,
  readServedLastModified,
  type PanelUpdateChecker,
} from '@/utils/panelUpdate';

function reloadedFor(): string | null {
  try {
    return window.sessionStorage.getItem(PANEL_RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

// useAuthStore keeps this only for a login made with "remember"; without it a reload
// lands on the login page.
function keepsLogin(): boolean {
  try {
    return window.localStorage.getItem('isLoggedIn') === 'true';
  } catch {
    return false;
  }
}

function recordReload(served: string): boolean {
  try {
    window.sessionStorage.setItem(PANEL_RELOADED_FOR_KEY, served);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps an open tab on the installed panel: checks the served page's Last-Modified on
 * load, every PANEL_CHECK_INTERVAL_MS, and as the tab comes back into view. Returns
 * whether a newer panel is waiting for a reload this hook would not do on its own.
 */
export function usePanelUpdateCheck() {
  const [available, setAvailable] = useState(false);
  const checkerRef = useRef<PanelUpdateChecker | null>(null);

  useEffect(() => {
    const url = window.location.pathname || '/management.html';
    const checker = createPanelUpdateChecker({
      readServed: () => readServedLastModified(url),
      loaded: () => document.lastModified,
      hash: () => window.location.hash,
      dialogOpen: () => document.querySelector('[aria-modal="true"]') !== null,
      keepsLogin,
      reloadedFor,
      recordReload,
      reload: () => window.location.reload(),
      offer: () => setAvailable(true),
    });
    checkerRef.current = checker;

    void checker.check('load');
    const timer = window.setInterval(() => void checker.check('interval'), PANEL_CHECK_INTERVAL_MS);
    const onVisibility = () => {
      if (document.hidden) checker.hide();
      else void checker.check('return');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      checker.dispose();
      if (checkerRef.current === checker) checkerRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const reload = useCallback(() => {
    if (checkerRef.current) checkerRef.current.reloadNow();
    else window.location.reload();
  }, []);
  return { available, reload };
}
