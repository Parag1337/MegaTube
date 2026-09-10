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
    return <p className="py-16 text-center text-muted">Type something to search videos.</p>;
  }

  if (items.length === 0) {
    return (
      <p className="py-16 text-center text-muted">
        No videos found for “{query}”.
      </p>
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
  // Search is a per-user view of the catalog: unauthenticated visitors are
  // sent to login instead of leaking catalog existence.
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const query = params.q ?? '';
  const page = Number(params.page) || 1;

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">
        {query.trim() ? <>Search results for “{query}”</> : 'Search'}
      </h1>

      <div className="mb-6 max-w-xl">
        <SearchBar />
      </div>

      <Suspense fallback={<p className="py-16 text-center text-muted">Searching…</p>}>
        <Results query={query} page={page} userId={user.id} />
      </Suspense>
    </div>
  );
}