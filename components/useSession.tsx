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

function useSessionFetcher(pathname: string | null, initialUser: SessionUser | null = null): SessionState {
  // Phase 3C: the server seed IS the initial state (loading:false) - the
  // layout just resolved this exact query, so "unknown" never paints:
  // signed-in users get their sidebar/avatar, signed-out visitors get the
  // public header, both on first paint with no skeletal flash. The per-route
  // revalidation below is unchanged: fresh navigations, sign-outs and
  // cross-tab changes all correct the state exactly as before.
  const [state, setState] = useState<SessionState>({ user: initialUser, loading: false });

  useEffect(() => {
    let cancelled = false;
    // Phase 3C: only publish when the identity actually changed. The
    // revalidation fetch runs per route, but its result is almost always
    // identical ({id, email} equal) - publishing a fresh object every time
    // would re-render the whole shell and re-fire user-dependent effects
    // (e.g. VideoActions membership probes) for no visible change.
    // Stale-while-revalidate is preserved: the previous user stays rendered
    // until a genuinely different result lands.
    const publish = (nextUser: SessionUser | null) => {
      if (cancelled) return;
      setState((prev) => {
        if (
          !prev.loading &&
          (prev.user?.id ?? null) === (nextUser?.id ?? null) &&
          (prev.user?.email ?? null) === (nextUser?.email ?? null)
        ) {
          return prev;
        }
        return { user: nextUser, loading: false };
      });
    };
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => publish(data.user ?? null))
      .catch(() => publish(null));
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

export function SessionProvider({
  children,
  initialUser = null,
}: {
  children: ReactNode;
  /** Server-seeded session (first paint); revalidated per route below. */
  initialUser?: SessionUser | null;
}) {
  const pathname = usePathname();
  const state = useSessionFetcher(pathname, initialUser);
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
