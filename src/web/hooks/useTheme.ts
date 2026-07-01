import { useState, useEffect, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'open-novel-theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): Theme {
  try {
    return (localStorage.getItem(STORAGE_KEY) as Theme) || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: Theme) {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

/**
 * Hook to manage theme (light/dark/system).
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);

    // Listen for system theme changes when in 'system' mode
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    try { localStorage.setItem(STORAGE_KEY, newTheme); } catch { /* ignore */ }
  }, []);

  const cycleTheme = useCallback(() => {
    const order: Theme[] = ['light', 'dark', 'system'];
    const idx = order.indexOf(theme);
    setTheme(order[(idx + 1) % order.length]);
  }, [theme, setTheme]);

  const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;

  return { theme, resolvedTheme, setTheme, cycleTheme };
}
