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

/**
 * The user's combined private library: videos from every linked MEGA
 * account, with an optional filter down to a single account.
 */
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
  // A filter for an account that isn't (or no longer is) the user's renders
  // as "All" - no cross-user leakage by construction.
  const effectiveFilter = activeAccount ? activeAccount.id : undefined;

  const filterBase = effectiveFilter ? `/library?account=${effectiveFilter}` : '/library';

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
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
              className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                effectiveFilter === undefined
                  ? 'bg-accent font-medium text-black'
                  : 'border border-border text-muted hover:bg-card'
              }`}
            >
              All
            </Link>
            {visibleAccounts.map((a) => (
              <Link
                key={a.id}
                href={`/library?account=${a.id}`}
                className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                  effectiveFilter === a.id
                    ? 'bg-accent font-medium text-black'
                    : 'border border-border text-muted hover:bg-card'
                }`}
              >
                {a.label}
              </Link>
            ))}
          </nav>
        )}
      </div>

      {visibleAccounts.length === 0 ? (
        <div className="rounded border border-border bg-card p-10 text-center">
          <p className="text-sm">
            No linked MEGA accounts yet.{' '}
            <Link href="/account" className="text-accent hover:underline">
              Add one on your Account page
            </Link>{' '}
            to sync your private video library here.
          </p>
        </div>
      ) : result.items.length === 0 ? (
        <div className="rounded border border-border bg-card p-10 text-center">
          <p className="text-sm">
            {activeAccount
              ? `No videos found in ${activeAccount.label} yet.`
              : 'No private videos synced yet.'}{' '}
            Use “Sync Now” on your Account page.
          </p>
        </div>
      ) : (
        <>
          <VideoGrid videos={result.items} />
          <Pagination page={result.page} totalPages={result.totalPages} basePath={filterBase} />
        </>
      )}
    </div>
  );
}
