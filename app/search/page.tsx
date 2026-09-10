import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { searchVideos } from '@/lib/videos';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import { SearchBar } from '@/components/SearchBar';

export const metadata = { title: 'Search' };

export const dynamic = 'force-dynamic';

interface SearchPageProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

async function Results({ query, page, userId }: { query: string; page: number; userId: string }) {
  const { items, total, page: currentPage, totalPages } = await searchVideos(query, page, userId);

  if (!query.trim()) {
    return (
      <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-border bg-surface">
        <div className="text-center">
          <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.3-4.3"/>
          </svg>
          <p className="text-muted">Type something to search videos.</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-border bg-surface">
        <div className="text-center">
          <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            <line x1="8" y1="11" x2="14" y2="11"/>
          </svg>
          <p className="text-muted">
            No videos found for "{query}".
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <VideoGrid videos={items} />
      <Pagination
        page={currentPage}
        totalPages={totalPages}
        basePath={`/search?q=${encodeURIComponent(query)}`}
      />
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

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <h1 className="mb-6 text-xl font-semibold">
          {query.trim() ? <>Search results for "{query}"</> : 'Search'}
        </h1>

        <div className="mb-6 max-w-xl">
          <SearchBar />
        </div>

        <Suspense fallback={<p className="py-16 text-center text-muted">Searching…</p>}>
          <Results query={query} page={page} userId={user.id} />
        </Suspense>
      </div>
    </div>
  );
}