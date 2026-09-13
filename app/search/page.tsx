import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import { getCurrentUser } from '@/lib/auth';
import { isRandomSearchCommand, listRandomVideos, searchVideos } from '@/lib/videos';
import { SearchSyntaxError } from '@/lib/search';
import { VideoGrid } from '@/components/VideoGrid';
import { VideoGridSkeleton, EmptyState, Button } from '@/components/ui';
import { Pagination } from '@/components/Pagination';
import { SearchIcon, ShuffleIcon, FilmIcon } from '@/components/icons';

export const metadata = { title: 'Search' };

export const dynamic = 'force-dynamic';

interface SearchPageProps {
  searchParams: Promise<{ q?: string; page?: string; randomSeed?: string }>;
}

async function Results({
  query,
  page,
  userId,
  randomSeed,
}: {
  query: string;
  page: number;
  userId: string;
  randomSeed: string;
}) {
  const isRandom = isRandomSearchCommand(query);
  let result;
  try {
    result = isRandom
      ? await listRandomVideos(userId, page, randomSeed)
      : await searchVideos(query, page, userId);
  } catch (e) {
    // Malformed boolean syntax is a user error, not a crash: explain the
    // query language instead of failing the page.
    if (!isRandom && e instanceof SearchSyntaxError) {
      return (
        <EmptyState
          icon={<SearchIcon className="h-7 w-7" />}
          title={`Couldn't understand “${query}”`}
          body={`${e.message} Use && for AND, || for OR, ! for NOT, and (...) to group terms.`}
        />
      );
    }
    throw e;
  }
  const { items, total, page: currentPage, totalPages } = result;

  if (!query.trim()) {
    return (
      <EmptyState
        icon={<SearchIcon className="h-7 w-7" />}
        title="Search your library"
        body="Look up titles, creators, or words from the original MEGA filenames."
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={isRandom ? <FilmIcon className="h-7 w-7" /> : <SearchIcon className="h-7 w-7" />}
        title={isRandom ? 'No videos in your library yet' : `No results for “${query}”`}
        body={
          isRandom ? (
            'Sync a MEGA account first — then Shuffle has something to pick from.'
          ) : (
            'Check the spelling, try fewer words, or search for a creator name.'
          )
        }
        action={
          isRandom ? (
            <Button href="/account" variant="primary">Go to Account</Button>
          ) : undefined
        }
      />
    );
  }

  const basePath =
    `/search?q=${encodeURIComponent(query)}` +
    (isRandom ? `&randomSeed=${encodeURIComponent(randomSeed)}` : '');

  return (
    <>
      <VideoGrid videos={items} />
      <Pagination
        page={currentPage}
        totalPages={totalPages}
        basePath={basePath}
      />
      {isRandom && totalPages > 1 && (
        <form method="GET" action="/search" className="mt-6 text-center">
          <input type="hidden" name="q" value={query} />
          <Button type="submit" variant="secondary">
            <ShuffleIcon className="h-4 w-4" />
            Reshuffle
          </Button>
        </form>
      )}
      <p className="mt-4 text-center text-xs text-muted">
        {total} result{total === 1 ? '' : 's'}
      </p>
    </>
  );
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const query = params.q ?? '';
  const page = Number(params.page) || 1;
  // A fresh seed per #random search visit gives a fresh ordering; the seed
  // rides along in pagination URLs so pages 1..N share one ordering.
  // Reloading without a seed reshuffles (per spec); paginating keeps it.
  const randomSeed =
    params.randomSeed && params.randomSeed.length > 0
      ? params.randomSeed
      : randomBytes(8).toString('hex');
  const isRandom = isRandomSearchCommand(query);

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <h1 className="mb-1 text-xl font-bold tracking-tight">
          {isRandom ? (
            <span className="inline-flex items-center gap-2">
              <ShuffleIcon className="h-5 w-5 text-accent" />
              Shuffle
            </span>
          ) : query.trim() ? (
            <>Results for “{query}”</>
          ) : (
            'Search'
          )}
        </h1>
        {!isRandom && query.trim() && (
          <p className="mb-5 text-[13px] text-muted">Matching titles, creators, and filenames</p>
        )}

        <Suspense fallback={<VideoGridSkeleton />}>
          <Results query={query} page={page} userId={user.id} randomSeed={randomSeed} />
        </Suspense>
      </div>
    </div>
  );
}
