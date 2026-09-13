import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { listCreators, listLibraryVideosForUser } from '@/lib/videos';
import { listNewVideosForUser } from '@/lib/personal';
import { listMegaAccountsForUser, MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import { Avatar, EmptyState } from '@/components/ui';
import { CreatorsIcon, FilmIcon, LibraryIcon } from '@/components/icons';

export const metadata: Metadata = { title: 'Library' };

export const dynamic = 'force-dynamic';

interface LibraryPageProps {
  searchParams: Promise<{ page?: string; account?: string; view?: string }>;
}

export default async function LibraryPage({ searchParams }: LibraryPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const rawAccount = params.account ? Number(params.account) : undefined;
  const accountId =
    Number.isInteger(rawAccount) && (rawAccount as number) > 0 ? (rawAccount as number) : undefined;
  const showNew = params.view === 'new';
  const showCreators = params.view === 'creators';

  const [accounts, result, creators] = await Promise.all([
    listMegaAccountsForUser(user.id),
    showCreators
      ? null
      : showNew
        ? listNewVideosForUser(user.id, page, accountId)
        : listLibraryVideosForUser(user.id, page, accountId),
    showCreators ? listCreators(user.id) : null,
  ]);

  const visibleAccounts = accounts.filter(
    (a) => a.status !== MEGA_ACCOUNT_STATUSES.DISCONNECTED,
  );
  const activeAccount = accountId ? visibleAccounts.find((a) => a.id === accountId) : null;
  const effectiveFilter = activeAccount ? activeAccount.id : undefined;

  const filterBase = effectiveFilter ? `/library?account=${effectiveFilter}` : '/library';
  const currentView = showCreators ? 'creators' : showNew ? 'new' : null;
  const libraryHref = (view: string | null, account: number | null) => {
    const u = new URLSearchParams();
    if (account) u.set('account', String(account));
    if (view) u.set('view', view);
    const q = u.toString();
    return q ? `/library?${q}` : '/library';
  };
  // View tabs preserve the account filter; pagination preserves both.
  const withView = (view: string | null) => libraryHref(view, effectiveFilter ?? null);
  const pageBase = withView(currentView);

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Library</h1>
            <p className="mt-1 text-[13px] text-muted">
              {showCreators ? (
                <>
                  {creators?.length ?? 0} creator{(creators?.length ?? 0) === 1 ? '' : 's'} in your library
                </>
              ) : showNew ? (
                <>
                  {result!.total} video{result!.total === 1 ? '' : 's'}, newest synced first
                </>
              ) : (
                <>
                  {result!.total} private video{result!.total === 1 ? '' : 's'}
                  {visibleAccounts.length > 0 && (
                    <>
                      {' '}across {visibleAccounts.length} linked MEGA account{visibleAccounts.length === 1 ? '' : 's'}
                    </>
                  )}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="navigation" aria-label="Library view">
          <FilterChip href={withView(null)} active={!showNew && !showCreators} label="All Videos" />
          <FilterChip href={withView('new')} active={showNew} label="New Videos" />
          <FilterChip href={withView('creators')} active={showCreators} label="Creators" />
        </div>

        {visibleAccounts.length > 1 && !showCreators && (
          <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="navigation" aria-label="Filter by MEGA account">
            <FilterChip href={libraryHref(currentView, null)} active={effectiveFilter === undefined} label="All accounts" />
            {visibleAccounts.map((a) => (
              <FilterChip
                key={a.id}
                href={libraryHref(currentView, a.id)}
                active={effectiveFilter === a.id}
                label={a.label}
              />
            ))}
          </div>
        )}

        {showCreators ? (
          (creators?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<CreatorsIcon className="h-7 w-7" />}
              title="No creators yet"
              body="Creators are picked up automatically from “Creator - Title” filenames when you sync."
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {creators!.map((creator) => (
                <li key={creator.id}>
                  <Link
                    href={`/creator/${creator.slug}`}
                    className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-border-light hover:bg-surface-raised"
                  >
                    <Avatar
                      name={creator.name}
                      photoUrl={creator.avatar ? `/api/creators/${creator.id}/photo` : null}
                      size="lg"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-semibold">{creator.name}</span>
                      <span className="mt-0.5 block text-[13px] text-muted">
                        {creator._count.videos} video{creator._count.videos === 1 ? '' : 's'}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : visibleAccounts.length === 0 ? (
          <EmptyState
            icon={<LibraryIcon className="h-7 w-7" />}
            title="No MEGA accounts linked"
            body="Link your first MEGA account to start building your private library."
            action={
              <Link
                href="/account"
                className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Go to Account
              </Link>
            }
          />
        ) : result!.items.length === 0 ? (
          <EmptyState
            icon={<FilmIcon className="h-7 w-7" />}
            title={activeAccount ? `Nothing synced in ${activeAccount.label} yet` : 'No videos synced yet'}
            body="Use “Sync now” on your Account page to pull videos in from MEGA."
            action={
              <Link
                href="/account"
                className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Open Account
              </Link>
            }
          />
        ) : (
          <>
            <VideoGrid videos={result!.items} priorityStart={4} />
            <Pagination page={result!.page} totalPages={result!.totalPages} basePath={pageBase} />
          </>
        )}
      </div>
    </div>
  );
}

function FilterChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex h-9 shrink-0 items-center rounded-xl px-4 text-sm font-medium transition-colors ${
        active
          ? 'bg-foreground text-background'
          : 'bg-surface-raised text-muted hover:bg-surface-overlay hover:text-foreground'
      }`}
    >
      {label}
    </Link>
  );
}
