'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SearchBar } from '@/components/SearchBar';
import { SITE_NAME } from '@/lib/config';

interface UserInfo {
  id: string;
  email: string;
  createdAt: string;
}

export function Header() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // Re-check the session on every navigation: login/register/logout are
  // client-side navigations that do not remount the header, so a fetch-once
  // on mount leaves the header showing a stale logged-out/in state.
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setUser(data.user ?? null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="shrink-0 text-lg font-bold tracking-tight">
          <span className="text-accent">{SITE_NAME.slice(0, 4)}</span>
          {SITE_NAME.slice(4)}
        </Link>

        <SearchBar />

        <nav className="shrink-0 flex items-center gap-2">
          <Link
            href="/creators"
            className="rounded-full px-3 py-2 text-sm text-muted transition-colors hover:bg-card hover:text-foreground"
          >
            Creators
          </Link>

          {loading ? (
            <span className="h-8 w-16 animate-pulse rounded-full bg-card" aria-hidden />
          ) : user ? (
            <>
              <Link
                href="/library"
                className="rounded-full px-3 py-2 text-sm text-muted transition-colors hover:bg-card hover:text-foreground"
              >
                Library
              </Link>
              <Link
                href="/account"
                className="rounded-full px-3 py-2 text-sm text-muted transition-colors hover:bg-card hover:text-foreground"
              >
                Account
              </Link>
              <form action="/api/auth/logout" method="POST" className="inline">
                <button
                  type="submit"
                  className="rounded-full px-3 py-2 text-sm text-muted transition-colors hover:bg-card hover:text-foreground"
                >
                  Logout
                </button>
              </form>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-full px-3 py-2 text-sm text-muted transition-colors hover:bg-card hover:text-foreground"
              >
                Login
              </Link>
              <Link
                href="/register"
                className="rounded-full bg-accent px-3 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90"
              >
                Sign Up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
