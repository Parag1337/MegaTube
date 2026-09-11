import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { listLibraryVideosForUser } from '@/lib/videos';
import { listNewVideosForUser } from '@/lib/personal';
import { listMegaAccountsForUser, MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import { EmptyState } from '@/components/ui';
import { FilmIcon, LibraryIcon } from '@/components/icons';

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

  const [accounts, result] = await Promise.all([
    listMegaAccountsForUser(user.id),
    showNew
      ? listNewVideosForUser(user.id, page, accountId)
      : listLibraryVideosForUser(user.id, page, accountId),
  ]);

  const visibleAccounts = accounts.filter(
    (a) => a.status !== MEGA_ACCOUNT_STATUSES.DISCONNECTED,
  );
  const activeAccount = accountId ? visibleAccounts.find((a) => a.id === accountId) : null;
  const effectiveFilter = activeAccount ? activeAccount.id : undefined;

  const filterBase = effectiveFilter ? `/library?account=${effectiveFilter}` : '/library';
  const allHref = filterBase;
  const newHref = effectiveFilter ? `${filterBase}&view=new` : '/library?view=new';
  const pageBase = showNew ? newHref : filterBase;

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">{showNew ? 'New Videos' : 'Library'}</h1>
            <p className="mt-1 text-[13px] text-muted">
              {showNew ? (
                <>
                  {result.total} video{result.total === 1 ? '' : 's'}, newest synced first
                </>
              ) : (
                <>
                  {result.total} private video{result.total === 1 ? '' : 's'}
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
          <FilterChip href={allHref} active={!showNew} label="All videos" />
          <FilterChip href={newHref} active={showNew} label="New videos" />
        </div>

        {visibleAccounts.length > 1 && (
          <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="navigation" aria-label="Filter by MEGA account">
            <FilterChip href={showNew ? '/library?view=new' : '/library'} active={effectiveFilter === undefined} label="All accounts" />
            {visibleAccounts.map((a) => (
              <FilterChip
                key={a.id}
                href={showNew ? `/library?account=${a.id}&view=new` : `/library?account=${a.id}`}
                active={effectiveFilter === a.id}
                label={a.label}
              />
            ))}
          </div>
        )}

        {visibleAccounts.length === 0 ? (
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
        ) : result.items.length === 0 ? (
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
            <VideoGrid videos={result.items} priorityStart={4} />
            <Pagination page={result.page} totalPages={result.totalPages} basePath={pageBase} />
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
