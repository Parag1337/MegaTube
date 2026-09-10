import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { listLibraryVideosForUser } from '@/lib/videos';
import { listMegaAccountsForUser, MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';

export const metadata: Metadata = { title: 'My Library' };

export const dynamic = 'force-dynamic';

interface LibraryPageProps {
  searchParams: Promise<{ page?: string; account?: string }>;
}

export default async function LibraryPage({ searchParams }: LibraryPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const rawAccount = params.account ? Number(params.account) : undefined;
  const accountId =
    Number.isInteger(rawAccount) && (rawAccount as number) > 0 ? (rawAccount as number) : undefined;

  const [accounts, result] = await Promise.all([
    listMegaAccountsForUser(user.id),
    listLibraryVideosForUser(user.id, page, accountId),
  ]);

  const visibleAccounts = accounts.filter(
    (a) => a.status !== MEGA_ACCOUNT_STATUSES.DISCONNECTED,
  );
  const activeAccount = accountId ? visibleAccounts.find((a) => a.id === accountId) : null;
  const effectiveFilter = activeAccount ? activeAccount.id : undefined;

  const filterBase = effectiveFilter ? `/library?account=${effectiveFilter}` : '/library';

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">My Library</h1>
            <p className="mt-1 text-sm text-muted">
              {result.total} private video{result.total === 1 ? '' : 's'} across{' '}
              {visibleAccounts.length} linked MEGA account{visibleAccounts.length === 1 ? '' : 's'}.
            </p>
          </div>

          {visibleAccounts.length > 1 && (
            <nav className="flex flex-wrap items-center gap-2" aria-label="Filter by MEGA account">
              <Link
                href="/library"
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  effectiveFilter === undefined
                    ? 'bg-surface text-foreground'
                    : 'text-muted hover:bg-surface hover:text-foreground'
                }`}
              >
                All
              </Link>
              {visibleAccounts.map((a) => (
                <Link
                  key={a.id}
                  href={`/library?account=${a.id}`}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    effectiveFilter === a.id
                      ? 'bg-surface text-foreground'
                      : 'text-muted hover:bg-surface hover:text-foreground'
                  }`}
                >
                  {a.label}
                </Link>
              ))}
            </nav>
          )}
        </div>

        {visibleAccounts.length === 0 ? (
          <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-border bg-surface">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <p className="text-muted">
                No linked MEGA accounts yet.{' '}
                <Link href="/account" className="text-accent hover:underline">
                  Add one on your Account page
                </Link>{' '}
                to sync your private video library here.
              </p>
            </div>
          </div>
        ) : result.items.length === 0 ? (
          <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-border bg-surface">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="text-muted">
                {activeAccount
                  ? `No videos found in ${activeAccount.label} yet.`
                  : 'No private videos synced yet.'}{' '}
                Use “Sync Now” on your Account page.
              </p>
            </div>
          </div>
        ) : (
          <>
            <VideoGrid videos={result.items} />
            <Pagination page={result.page} totalPages={result.totalPages} basePath={filterBase} />
          </>
        )}
      </div>
    </div>
  );
}
