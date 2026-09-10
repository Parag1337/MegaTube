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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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
    <header className="sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="border-b border-border">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-accent">
              <svg className="h-5 w-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
            <span className="hidden font-semibold text-foreground sm:block">{SITE_NAME}</span>
          </Link>

          {/* Desktop Navigation */}
          <nav className="hidden md:flex items-center gap-1">
            <Link
              href="/"
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                pathname === '/' ? 'bg-surface text-foreground' : 'text-muted hover:bg-surface hover:text-foreground'
              }`}
            >
              Home
            </Link>
            {user && (
              <Link
                href="/library"
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  pathname?.startsWith('/library') ? 'bg-surface text-foreground' : 'text-muted hover:bg-surface hover:text-foreground'
                }`}
              >
                Library
              </Link>
            )}
            <Link
              href="/creators"
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                pathname?.startsWith('/creators') ? 'bg-surface text-foreground' : 'text-muted hover:bg-surface hover:text-foreground'
              }`}
            >
              Creators
            </Link>
          </nav>

          {/* Search and User Actions */}
          <div className="flex items-center gap-2">
            <div className="hidden sm:block">
              <SearchBar />
            </div>
            
            {loading ? (
              <div className="h-8 w-8 animate-pulse rounded-full bg-surface" aria-hidden />
            ) : user ? (
              <div className="flex items-center gap-1">
                <Link
                  href="/account"
                  className="rounded-full p-2 text-muted transition-colors hover:bg-surface hover:text-foreground"
                  aria-label="Account"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </Link>
                <form action="/api/auth/logout" method="POST">
                  <button
                    type="submit"
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-foreground"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <Link
                  href="/login"
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-foreground"
                >
                  Sign in
                </Link>
                <Link
                  href="/register"
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
                >
                  Sign up
                </Link>
              </div>
            )}

            {/* Mobile menu button */}
            <button
              type="button"
              className="ml-1 rounded-lg p-2 text-muted md:hidden"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle menu"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {mobileMenuOpen ? (
                  <path d="M18 6L6 18M6 6l12 12"/>
                ) : (
                  <path d="M3 12h18M3 6h18M3 18h18"/>
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <nav className="border-t border-border p-4 md:hidden">
            <div className="mb-4">
              <SearchBar />
            </div>
            <div className="flex flex-col gap-1">
              <Link
                href="/"
                className="rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-surface"
                onClick={() => setMobileMenuOpen(false)}
              >
                Home
              </Link>
              {user && (
                <Link
                  href="/library"
                  className="rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-surface"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  Library
                </Link>
              )}
              <Link
                href="/creators"
                className="rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-surface"
                onClick={() => setMobileMenuOpen(false)}
              >
                Creators
              </Link>
              {user && (
                <Link
                  href="/account"
                  className="rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-surface"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  Account
                </Link>
              )}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
