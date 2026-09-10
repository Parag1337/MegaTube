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
    <div>
      <h1 className="mb-4 text-xl font-semibold">My Library</h1>

      {items.length === 0 ? (
        <p className="py-16 text-center text-muted">
          No private videos synced yet.{' '}
          <Link href="/account" className="text-accent hover:underline">
            Add a MEGA account on your Account page
          </Link>{' '}
          to sync your private video library.
        </p>
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
  );
}