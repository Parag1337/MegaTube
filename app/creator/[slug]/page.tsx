import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { listVideosByCreator } from '@/lib/videos';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import CreatorActions from './CreatorActions';

export const metadata = { title: 'Creator' };

export const dynamic = 'force-dynamic';

interface CreatorPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string }>;
}

export default async function CreatorPage({ params, searchParams }: CreatorPageProps) {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-[1800px]">
          <p className="text-muted">Please log in to view this creator.</p>
        </div>
      </div>
    );
  }

  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const page = Number(sp.page) || 1;

  const { creator, result } = await listVideosByCreator(user.id, slug, page);
  if (!creator) notFound();

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            {creator.avatar ? (
              <img
                src={`/api/creators/${creator.id}/photo`}
                alt=""
                className="h-16 w-16 rounded-full object-cover"
              />
            ) : (
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent/20 text-2xl font-bold text-accent">
                {creator.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div>
              <h1 className="text-xl font-semibold sm:text-2xl">{creator.name}</h1>
              <p className="text-sm text-muted">
                {result.total} video{result.total === 1 ? '' : 's'}
              </p>
              {creator.description && (
                <p className="mt-2 text-sm text-muted-light">{creator.description}</p>
              )}
            </div>
          </div>
          <CreatorActions creatorId={creator.id} creatorName={creator.name} />
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
    </div>
  );
}