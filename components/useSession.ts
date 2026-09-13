'use client';

import { useEffect, useState } from 'react';
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
  const [state, setState] = useState<SessionState>({ user: null, loading: true });
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
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
