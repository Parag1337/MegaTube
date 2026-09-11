import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { listSavedVideos } from '@/lib/personal';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import { EmptyState } from '@/components/ui';
import { BookmarkIcon } from '@/components/icons';

export const metadata: Metadata = { title: 'Saved Videos' };

export const dynamic = 'force-dynamic';

interface SavedPageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function SavedVideosPage({ searchParams }: SavedPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const result = await listSavedVideos(user.id, page);

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <div className="mb-5">
          <h1 className="text-xl font-bold tracking-tight">Saved Videos</h1>
          <p className="mt-1 text-[13px] text-muted">
            {result.total} bookmarked video{result.total === 1 ? '' : 's'}
          </p>
        </div>

        {result.items.length === 0 ? (
          <EmptyState
            icon={<BookmarkIcon className="h-7 w-7" />}
            title="No saved videos yet"
            body="Open any video's ⋮ menu and choose “Save video” to bookmark it here. A flat list — no folders."
            action={
              <Link
                href="/library"
                className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Browse Library
              </Link>
            }
          />
        ) : (
          <>
            <VideoGrid videos={result.items} priorityStart={4} />
            <Pagination page={result.page} totalPages={result.totalPages} basePath="/account/saved" />
          </>
        )}
      </div>
    </div>
  );
}
