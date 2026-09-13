import { buildHomeFeedPage } from '@/lib/homeFeed';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import { EmptyState, Button } from '@/components/ui';
import { FilmIcon, RefreshIcon } from '@/components/icons';
import { getCurrentUser } from '@/lib/auth';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Home' };

export const dynamic = 'force-dynamic';

interface HomeProps {
  searchParams: Promise<{ page?: string }>;
}

/*
 * ONE continuous mixed Home feed. Visual design (cards, header, spacing,
 * grid, pagination) is unchanged - only the composition comes from the
 * quota-based builder in lib/homeFeed.ts (recent/history/related/random/
 * variety with first-claim de-dup and deterministic interleave).
 */

export default async function HomePage({ searchParams }: HomeProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const feed = await buildHomeFeedPage(user.id, page);

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        {feed.items.length === 0 ? (
          <>
            <h1 className="mb-6 text-xl font-bold tracking-tight">Home</h1>
            <EmptyState
              icon={<FilmIcon className="h-7 w-7" />}
              title="Your library is empty"
              body={
                <>
                  Connect a MEGA account and run a sync — your videos will show
                  up here as soon as they finish indexing.
                </>
              }
              action={
                <Button href="/account" variant="primary">
                  <RefreshIcon className="h-4 w-4" />
                  Connect a MEGA account
                </Button>
              }
            />
          </>
        ) : (
          <>
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h1 className="text-xl font-bold tracking-tight">Home</h1>
              <p className="shrink-0 text-[13px] text-muted">
                {feed.total} video{feed.total === 1 ? '' : 's'} in your library
              </p>
            </div>
            <VideoGrid
              videos={feed.items.map((pick) => ({ ...pick.video, feedSource: pick.source }))}
              priorityStart={page === 1 ? 4 : 0}
            />
            <Pagination page={feed.page} totalPages={feed.totalPages} basePath="/" />
          </>
        )}
      </div>
    </div>
  );
}
