'use client';

/**
 * MegaTube theme: System / Light / Dark.
 *
 * - Preference persists in localStorage (`megatube.theme`).
 * - `system` follows the OS via matchMedia and reacts to live changes.
 * - The resolved theme is applied as `html[data-theme]` so Tailwind's
 *   CSS-first tokens (`html[data-theme='light']` overrides in globals.css)
 *   switch without a flash (the inline script in the root layout sets the
 *   initial value before first paint).
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'megatube.theme';

const ThemeContext = createContext<{
  theme: ThemeChoice;
  resolved: ResolvedTheme;
  setTheme: (next: ThemeChoice) => void;
}>({ theme: 'system', resolved: 'dark', setTheme: () => {} });

function resolveChoice(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'light' || choice === 'dark') return choice;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function applyResolved(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>('system');
  const [resolved, setResolved] = useState<ResolvedTheme>('dark');

  // Hydrate the stored choice after mount (SSR renders un-themed, matching
  // the server HTML; the pre-paint inline script already set data-theme so
  // there is no visible flash).
  useEffect(() => {
    let stored: ThemeChoice = 'system';
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === 'light' || raw === 'dark' || raw === 'system') stored = raw;
    } catch {
      // private mode - fall back to system
    }
    setThemeState(stored);
    setResolved(resolveChoice(stored));
  }, []);

  // Follow OS changes while in system mode.
  useEffect(() => {
    if (theme !== 'system' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setResolved(query.matches ? 'light' : 'dark');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    const nextResolved = resolveChoice(next);
    setResolved(nextResolved);
    applyResolved(nextResolved);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // private mode - preference just won't persist
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, resolved, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * Inline pre-paint script (rendered via dangerouslySetInnerHTML in the root
 * layout): sets `document.documentElement.dataset.theme` from the stored
 * preference before first paint, so the correct theme applies with no flash.
 */
export const themeInitScript = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var t=s==='light'||s==='dark'?s:(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;
