import { notFound } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { listVideosByCreator } from '@/lib/videos';
import { VideoGrid } from '@/components/VideoGrid';
import { Pagination } from '@/components/Pagination';
import { Avatar, Button, EmptyState } from '@/components/ui';
import { AccountIcon, FilmIcon } from '@/components/icons';
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
      <div className="px-4 py-6 md:px-6">
        <div className="mx-auto max-w-[2000px]">
          <EmptyState
            icon={<AccountIcon className="h-7 w-7" />}
            title="Sign in to view this creator"
            body="Creator pages are part of your private library."
            action={
              <Button href="/sign-in" variant="primary">
                Sign in
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const page = Number(sp.page) || 1;

  const { creator, result } = await listVideosByCreator(user.id, slug, page);
  if (!creator) notFound();

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <Avatar
              name={creator.name}
              photoUrl={creator.avatar ? `/api/creators/${creator.id}/photo` : null}
              size="xl"
            />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{creator.name}</h1>
              <p className="mt-0.5 text-[13px] text-muted">
                {result.total} video{result.total === 1 ? '' : 's'}
              </p>
              {creator.description && (
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">{creator.description}</p>
              )}
            </div>
          </div>
          <div className="shrink-0">
            <CreatorActions creatorId={creator.id} creatorName={creator.name} />
          </div>
        </div>

        {result.items.length > 0 ? (
          <>
            <VideoGrid videos={result.items} priorityStart={4} />
            <Pagination page={result.page} totalPages={result.totalPages} basePath={`/creator/${creator.slug}`} />
          </>
        ) : (
          <EmptyState
            icon={<FilmIcon className="h-7 w-7" />}
            title={`No videos by ${creator.name} yet`}
            body="Videos assigned to this creator — by filename or by hand — will appear here."
          />
        )}
      </div>
    </div>
  );
}
