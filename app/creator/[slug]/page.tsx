import { notFound } from 'next/navigation';
import { listVideosByCreator } from '@/lib/videos';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';

export const metadata = { title: 'Creator' };

export const dynamic = 'force-dynamic';

interface CreatorPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}

export default async function CreatorPage({ params, searchParams }: CreatorPageProps) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const page = Number(sp.page) || 1;

  const { creator, result } = await listVideosByCreator(slug, page);
  if (!creator) notFound();

  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/20 text-2xl font-bold text-accent">
          {creator.name.charAt(0).toUpperCase()}
        </span>
        <div>
          <h1 className="text-xl font-semibold sm:text-2xl">{creator.name}</h1>
          <p className="text-sm text-muted">
            {result.total} video{result.total === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {result.items.length > 0 ? (
        <>
          <VideoGrid videos={result.items} />
          <Pagination page={result.page} totalPages={result.totalPages} basePath={`/creator/${creator.slug}`} />
        </>
      ) : (
        <p className="py-16 text-center text-muted">No videos by this creator yet.</p>
      )}
    </div>
  );
}