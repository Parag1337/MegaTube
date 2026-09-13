'use client';

/**
 * The one application shell: sticky top header, persistent left sidebar on
 * desktop (collapsible to an icon rail, never hamburger-only), and a bottom
 * tab bar on mobile. Every page renders inside it via the root layout.
 */

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SearchBar } from '@/components/SearchBar';
import { useSession } from '@/components/useSession';
import { Avatar } from '@/components/ui';
import { SITE_NAME } from '@/lib/config';
import {
  AccountIcon,
  BookmarkIcon,
  CloseIcon,
  ExploreIcon,
  HistoryIcon,
  HomeIcon,
  LibraryIcon,
  LogOutIcon,
  MenuIcon,
  SearchIcon,
  SettingsIcon,
  ShuffleIcon,
} from '@/components/icons';

const COLLAPSE_KEY = 'megatube.sidebarCollapsed';

/*
 * Sidebar collapse state, SSR-safe: the server snapshot is always expanded
 * (matching SSR HTML), and the client hydrates from localStorage without a
 * render-time read (which would mismatch hydration) or an effect setState.
 */
type CollapseListener = () => void;
const collapseListeners = new Set<CollapseListener>();

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribeCollapse(fn: CollapseListener): () => void {
  collapseListeners.add(fn);
  return () => {
    collapseListeners.delete(fn);
  };
}

function setCollapsedValue(next: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
  } catch {
    // private mode - state just won't persist
  }
  for (const fn of collapseListeners) fn();
}

function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(subscribeCollapse, readCollapsed, () => false);
  const toggle = () => setCollapsedValue(!readCollapsed());
  return [collapsed, toggle];
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2" aria-label={`${SITE_NAME} home`}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent">
        <svg className="h-4.5 w-4.5 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
      {!compact && (
        <span className="text-[17px] font-bold tracking-tight text-foreground">
          Mega<span className="text-accent">Tube</span>
        </span>
      )}
    </Link>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
  active: (pathname: string | null, search: string) => boolean;
  authed?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    href: '/',
    label: 'Home',
    icon: HomeIcon,
    active: (p) => p === '/',
  },
  {
    href: '/search?q=%23random',
    label: 'Shuffle',
    icon: ShuffleIcon,
    active: (_p, search) => search.includes('q=%23random') || search.includes('q=%2523random'),
  },
  {
    href: '/library',
    label: 'Library',
    icon: LibraryIcon,
    active: (p) => !!p?.startsWith('/library') || !!p?.startsWith('/video/'),
    authed: true,
  },
  {
    href: '/watchlist',
    label: 'Watchlist',
    icon: BookmarkIcon,
    active: (p) => !!p?.startsWith('/watchlist'),
    authed: true,
  },
  {
    href: '/account/history',
    label: 'History',
    icon: HistoryIcon,
    active: (p) => !!p?.startsWith('/account/history'),
    authed: true,
  },
];

function SidebarLink({
  item,
  collapsed,
  active,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className={`flex items-center gap-4 rounded-xl px-3 transition-colors ${
        collapsed ? 'h-12 justify-center px-0' : 'h-11'
      } ${
        active
          ? 'bg-surface-raised font-medium text-foreground'
          : 'text-muted hover:bg-surface-hover hover:text-foreground'
      }`}
    >
      <Icon className="h-[22px] w-[22px] shrink-0" />
      {!collapsed && <span className="truncate text-sm">{item.label}</span>}
      {!collapsed && active && <span aria-hidden className="ml-auto h-5 w-1 rounded-full bg-accent" />}
    </Link>
  );
}

function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="rounded-full transition-transform hover:scale-105"
      >
        <Avatar name={email} size="sm" className="h-8 w-8" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-50 w-60 overflow-hidden rounded-2xl border border-border bg-surface-raised py-2 shadow-2xl shadow-black/60"
        >
          <p className="truncate px-4 pb-2 pt-1 text-[13px] text-muted">{email}</p>
          <div className="border-t border-border pt-1">
            <Link
              href="/account"
              role="menuitem"
              onClick={close}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-surface-hover"
            >
              <AccountIcon className="h-[18px] w-[18px] text-muted" />
              Your account
            </Link>
            <Link
              href="/account/settings"
              role="menuitem"
              onClick={close}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-surface-hover"
            >
              <SettingsIcon className="h-[18px] w-[18px] text-muted" />
              Settings
            </Link>
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-foreground hover:bg-surface-hover"
              >
                <LogOutIcon className="h-[18px] w-[18px] text-muted" />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const { user, loading } = useSession();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();

  const visibleItems = NAV_ITEMS.filter((i) => !i.authed || user);

  return (
    <div className="flex min-h-full flex-col">
      {/* ------------------------------------------------ Header ------- */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-3 sm:gap-3 sm:px-4">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="hidden h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground md:inline-flex"
          >
            <MenuIcon className="h-[22px] w-[22px]" />
          </button>
          <Logo />
          {/* Center search (tablet/desktop) */}
          <div className="hidden min-w-0 flex-1 justify-center px-4 md:flex">
            <div className="w-full max-w-xl">
              <SearchBar />
            </div>
          </div>
          <div className="relative ml-auto flex items-center gap-1 md:ml-0">
            {/* Keyed by route: any navigation remounts it closed. */}
            <MobileSearchToggle key={pathname} />
            {loading ? (
              <span aria-hidden className="mt-skeleton h-8 w-8 rounded-full" />
            ) : user ? (
              <UserMenu email={user.email} />
            ) : (
              <div className="flex items-center gap-1">
                <Link
                  href="/login"
                  className="hidden h-9 items-center rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-hover hover:text-foreground sm:inline-flex"
                >
                  Sign in
                </Link>
                <Link
                  href="/register"
                  className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
                >
                  Sign up
                </Link>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {/* ----------------------------------------------- Sidebar ------ */}
        <aside
          className={`sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 self-start overflow-y-auto px-3 py-4 transition-[width] md:block ${
            collapsed ? 'w-[76px]' : 'w-60'
          }`}
          aria-label="Primary"
        >
          <nav className="flex flex-col gap-1">
            {visibleItems.map((item) => (
              <SidebarLink
                key={item.href}
                item={item}
                collapsed={collapsed}
                active={item.active(pathname, search)}
              />
            ))}
          </nav>
          {!collapsed && user && (
            <div className="mt-6 border-t border-border pt-4">
              <p className="px-3 text-xs font-medium text-muted">You</p>
              <div className="mt-1">
                <SidebarLink
                  item={{
                    href: '/account',
                    label: 'Account',
                    icon: AccountIcon,
                    // History has its own main-nav entry - don't double-highlight.
                    active: (p) => p === '/account' || !!p?.startsWith('/account/settings') || !!p?.startsWith('/account/saved'),
                  }}
                  collapsed={false}
                  active={
                    pathname === '/account' ||
                    !!pathname?.startsWith('/account/settings') ||
                    !!pathname?.startsWith('/account/saved')
                  }
                />
              </div>
            </div>
          )}
          {collapsed && user && (
            <nav className="mt-4 flex flex-col gap-1 border-t border-border pt-4" aria-label="Account">
              <SidebarLink
                item={{
                  href: '/account',
                  label: 'Account',
                  icon: AccountIcon,
                  active: (p) => p === '/account' || !!p?.startsWith('/account/settings') || !!p?.startsWith('/account/saved'),
                }}
                collapsed
                active={
                  pathname === '/account' ||
                  !!pathname?.startsWith('/account/settings') ||
                  !!pathname?.startsWith('/account/saved')
                }
              />
            </nav>
          )}
          {!collapsed && (
            <p className="mt-6 px-3 text-xs leading-relaxed text-muted-light">
              Private library.
              <br />
              Synced from your MEGA accounts.
            </p>
          )}
        </aside>

        {/* ------------------------------------------------- Main ------- */}
        <main className="min-w-0 flex-1 pb-24 md:pb-10">
          {children}
        </main>
      </div>

      {/* ----------------------------------------- Mobile bottom nav ---- */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur md:hidden"
      >
        <div className="grid grid-cols-6">
          <MobileTab
            href="/"
            label="Home"
            icon={HomeIcon}
            active={pathname === '/'}
          />
          <MobileTab
            href="/search?q=%23random"
            label="Shuffle"
            icon={ShuffleIcon}
            active={search.includes('q=%23random') || search.includes('q=%2523random')}
          />
          <MobileTab
            href="/library"
            label="Library"
            icon={LibraryIcon}
            active={!!pathname?.startsWith('/library') || !!pathname?.startsWith('/video/')}
          />
          <MobileTab
            href="/watchlist"
            label="Watchlist"
            icon={BookmarkIcon}
            active={!!pathname?.startsWith('/watchlist')}
          />
          <MobileTab
            href="/account/history"
            label="History"
            icon={HistoryIcon}
            active={!!pathname?.startsWith('/account/history')}
          />
          {user || loading ? (
            <MobileTab
              href="/account"
              label="Account"
              icon={AccountIcon}
              active={pathname === '/account' || !!pathname?.startsWith('/account/settings')}
            />
          ) : (
            <MobileTab href="/login" label="Sign in" icon={ExploreIcon} active={false} />
          )}
        </div>
      </nav>
    </div>
  );
}

/** Mobile search toggle + expanding row (remount-per-route keeps it closed). */
function MobileSearchToggle() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Search"
        aria-expanded={open}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground md:hidden"
      >
        {open ? (
          <CloseIcon className="h-[22px] w-[22px]" />
        ) : (
          <SearchIcon className="h-[22px] w-[22px]" />
        )}
      </button>
      {open && (
        <div className="fixed inset-x-0 top-14 border-b border-border bg-background px-3 py-2 md:hidden">
          <SearchBar id="mobile-search" autoFocus onSubmitted={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

function MobileTab({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-[60px] flex-col items-center justify-center gap-1 text-[11px] ${
        active ? 'font-medium text-foreground' : 'text-muted'
      }`}
    >
      <Icon className="h-[22px] w-[22px]" />
      {label}
      {active && <span aria-hidden className="h-1 w-1 rounded-full bg-accent" />}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <ShellInner>{children}</ShellInner>
    </Suspense>
  );
}
