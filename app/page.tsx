import Link from 'next/link';
import { listLibraryVideosForUser } from '@/lib/videos';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import { getCurrentUser } from '@/lib/auth';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Home' };

export const dynamic = 'force-dynamic';

interface HomeProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function HomePage({ searchParams }: HomeProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const { items, total, page: currentPage, totalPages } = await listLibraryVideosForUser(user.id, page);

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <h1 className="mb-6 text-xl font-semibold">My Library</h1>

        {items.length === 0 ? (
          <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-border bg-surface">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <p className="text-muted">
                No private videos synced yet.{' '}
                <Link href="/account" className="text-accent hover:underline">
                  Add a MEGA account on your Account page
                </Link>{' '}
                to sync your private video library.
              </p>
            </div>
          </div>
        ) : (
          <>
            <VideoGrid videos={items} priorityStart={4} />
            <Pagination page={currentPage} totalPages={totalPages} basePath="/" />
            <p className="mt-4 text-center text-xs text-muted">
              {total} video{total === 1 ? '' : 's'} in your private library
            </p>
          </>
        )}
      </div>
    </div>
  );
}