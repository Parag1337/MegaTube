'use client';

/**
 * The one application shell: sticky top header, persistent left sidebar on
 * desktop (collapsible to an icon rail, never hamburger-only), and a bottom
 * tab bar on mobile. Every page renders inside it via the root layout.
 */

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { UserButton, useClerk, useUser } from '@clerk/nextjs';
import { SearchBar } from '@/components/SearchBar';
import { useSession } from '@/components/useSession';
import { Avatar } from '@/components/ui';
import { SITE_NAME } from '@/lib/config';
import {
  AccountIcon,
  BookmarkIcon,
  CloseIcon,
  HistoryIcon,
  HomeIcon,
  LibraryIcon,
  LogOutIcon,
  MegaTubeMark,
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
      <MegaTubeMark className="h-8 w-8 shrink-0 text-accent" />
      {!compact && (
        <span className="text-[17px] font-bold tracking-tight text-foreground">
          Mega<span className="text-accent">Tube</span>
        </span>
      )}
    </Link>
  );
}

/**
 * Dedicated public navigation for marketing/auth-adjacent pages: brand mark
 * plus Sign in / Get started. No application sidebar, no search, no bottom
 * tab bar - public pages must never look like the logged-in application is
 * already open.
 */
function PublicHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 lg:px-6">
        <Logo />
        <nav aria-label="Public" className="ml-auto flex items-center gap-1">
          <Link
            href="/sign-in"
            className="hidden h-9 items-center rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-hover hover:text-foreground sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href="/sign-up"
            className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
  active: (pathname: string | null, search: string) => boolean;
  authed?: boolean;
}

const NAV_MAIN: NavItem[] = [
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

const NAV_ACCOUNT: NavItem[] = [
  {
    href: '/account',
    label: 'Account',
    icon: AccountIcon,
    // History has its own main-nav entry - don't double-highlight.
    active: (p) => p === '/account' || !!p?.startsWith('/account/settings') || !!p?.startsWith('/account/saved'),
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
      {!collapsed && (
        <span aria-hidden className="ml-auto h-5 w-1 shrink-0">
          <span className="mt-nav-active-indicator block h-full w-full rounded-full bg-accent" />
        </span>
      )}
    </Link>
  );
}

function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { signOut: clerkSignOut, user: clerkUser } = useClerk();
  const close = () => setOpen(false);

  async function handleSignOut() {
    // Clear the legacy website session, then Clerk (if present), so the
    // user is signed out of both identity layers. /sign-in is the public
    // authentication entry point (the home page requires auth).
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    if (clerkUser) {
      await clerkSignOut({ redirectUrl: '/sign-in' }).catch(() => {});
    }
    router.push('/sign-in');
    router.refresh();
  }

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
            <form
              action="/api/auth/logout"
              method="POST"
              onSubmit={(e) => {
                // Sign out of both layers via JS; the form action remains as
                // a no-JS fallback for the legacy session.
                e.preventDefault();
                void handleSignOut();
              }}
            >
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

/**
 * Clerk account control for Clerk-signed-in users. The UserButton carries
 * MegaTube's own destinations (Account, Settings) alongside Clerk's profile
 * management. Clerk sign-outs land on /sign-out (see ClerkProvider in the
 * root layout), which clears any legacy website session before continuing
 * to /sign-in - signing out of both layers.
 */
function ClerkAccountButton() {
  return (
    <UserButton
      appearance={{
        elements: {
          userButtonAvatarBox: 'h-8 w-8',
        },
      }}
    >
      <UserButton.MenuItems>
        <UserButton.Link
          label="Your account"
          href="/account"
          labelIcon={<AccountIcon className="h-4 w-4" />}
        />
        <UserButton.Link
          label="Settings"
          href="/account/settings"
          labelIcon={<SettingsIcon className="h-4 w-4" />}
        />
      </UserButton.MenuItems>
    </UserButton>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';

  // Hooks must run unconditionally on every render (Rules of Hooks).
  // They are hoisted above the auth-route early return so navigating
  // between auth and app routes doesn't change the hook order.
  const { user, loading } = useSession();
  const { isSignedIn: clerkSignedIn } = useUser();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();

  // Authentication routes use a standalone auth shell: MegaTube branding
  // with no application sidebar, search, or bottom nav. The Clerk
  // sign-in/sign-up components render inside the page itself.
  if (
    pathname === '/sign-in' ||
    pathname?.startsWith('/sign-in/') ||
    pathname === '/sign-up' ||
    pathname?.startsWith('/sign-up/') ||
    pathname === '/login' ||
    pathname?.startsWith('/login/') ||
    pathname === '/register' ||
    pathname?.startsWith('/register/')
  ) {
    const onSignUp =
      pathname === '/sign-up' || pathname?.startsWith('/sign-up/');
    return (
      <div className="flex min-h-full flex-col">
        <header className="border-b border-border">
          <div className="mx-auto flex h-14 max-w-6xl items-center px-4 lg:px-6">
            <Logo />
            <nav aria-label="Public" className="ml-auto flex items-center gap-1">
              {onSignUp ? (
                <Link
                  href="/sign-in"
                  className="inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-hover hover:text-foreground"
                >
                  Sign in
                </Link>
              ) : (
                <Link
                  href="/sign-up"
                  className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
                >
                  Sign up
                </Link>
              )}
            </nav>
          </div>
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
    );
  }

  /*
   * Public marketing/media routes for signed-out visitors use the dedicated
   * public header (no sidebar, search, or bottom nav). The check runs on the
   * client session: while it is loading `user` is null, so visitors never
   * see the application sidebar flash - at the cost of a brief public
   * header for logged-in users on these routes before their session
   * resolves and the app shell below takes over.
   */
  const isPublicRoute =
    pathname === '/' ||
    pathname?.startsWith('/video/') ||
    pathname?.startsWith('/creator/') ||
    pathname === '/creators' ||
    pathname?.startsWith('/creators/');

  if (isPublicRoute && !user) {
    return (
      <div className="flex min-h-full flex-col">
        <PublicHeader />
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
    );
  }

  const showAuthed = !!user;
  const mainItems = NAV_MAIN.filter((i) => !i.authed || showAuthed);
  const accountItems = NAV_ACCOUNT.filter((i) => !i.authed || showAuthed);

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
              clerkSignedIn ? (
                <ClerkAccountButton />
              ) : (
                <UserMenu email={user.email} />
              )
            ) : (
              <div className="flex items-center gap-1">
                <Link
                  href="/sign-in"
                  className="hidden h-9 items-center rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-hover hover:text-foreground sm:inline-flex"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
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
          <nav className="flex flex-col gap-1" aria-label="Main">
            {mainItems.map((item) => (
              <SidebarLink
                key={item.href}
                item={item}
                collapsed={collapsed}
                active={item.active(pathname, search)}
              />
            ))}
          </nav>
          {accountItems.length > 0 && (
            <>
              {!collapsed && (
                <p className="mb-1 mt-6 px-3 text-xs font-medium text-muted">ACCOUNT</p>
              )}
              <nav
                className={`flex flex-col gap-1 ${collapsed ? 'mt-4 border-t border-border pt-4' : ''}`}
                aria-label="Account"
              >
                {accountItems.map((item) => (
                  <SidebarLink
                    key={item.href}
                    item={item}
                    collapsed={collapsed}
                    active={item.active(pathname, search)}
                  />
                ))}
              </nav>
            </>
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
        <div className="grid grid-cols-5">
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
