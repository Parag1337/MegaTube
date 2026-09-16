'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';

export interface SessionUser {
  id: string;
  email: string;
  createdAt: string;
}

interface SessionState {
  user: SessionUser | null;
  loading: boolean;
}

/** Current website session, re-checked on every route change. */
export function useSession(): SessionState {
  const pathname = usePathname();
  return useSessionFetcher(pathname);
}

function useSessionFetcher(pathname: string | null): SessionState {
  const [state, setState] = useState<SessionState>({ user: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    // Phase 2 perf: no synchronous loading:true reset here. The previous
    // user stays rendered across navigations (stale-while-revalidate) until
    // the fresh result lands - this also removes the header-avatar skeleton
    // flash on every route change. Initial mount still starts loading:true.
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setState({ user: data.user ?? null, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ user: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return state;
}

/**
 * Phase 2 perf: one session fetch shared by the whole shell.
 *
 * Every card menu used to run its own useSession() - ~24 duplicate
 * /api/auth/session round trips per grid page, each hitting Clerk + Neon.
 * The provider fetches once per route (same timing/semantics as before) and
 * every consumer below it reuses the result. Tree-scoped React state, not a
 * global cache: sign-out/navigation behavior is unchanged.
 */
const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const state = useSessionFetcher(pathname);
  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

/**
 * Session for components inside the shell (card menus, header): the shared
 * fetch when a provider is above, an identical own fetch otherwise, so
 * behavior outside the provider is unchanged.
 */
export function useSessionState(): SessionState {
  const ctx = useContext(SessionContext);
  if (ctx) return ctx;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useSession();
}
