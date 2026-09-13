import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { listCreators } from '@/lib/videos';
import { Avatar, EmptyState, Button } from '@/components/ui';
import { CreatorsIcon } from '@/components/icons';
import CreateCreatorButton from './CreateCreatorButton';

export const metadata = { title: 'Creators' };

export const dynamic = 'force-dynamic';

export default async function CreatorsPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="px-4 py-6 md:px-6">
        <div className="mx-auto max-w-[2000px]">
          <h1 className="mb-6 text-xl font-bold tracking-tight">Creators</h1>
          <EmptyState
            icon={<CreatorsIcon className="h-7 w-7" />}
            title="Sign in to see your creators"
            body="Creators are extracted from your video filenames when you sync."
            action={<Button href="/sign-in" variant="primary">Sign in</Button>}
          />
        </div>
      </div>
    );
  }

  const creators = await listCreators(user.id);

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Creators</h1>
            {creators.length > 0 && (
              <p className="mt-1 text-[13px] text-muted">
                {creators.length} creator{creators.length === 1 ? '' : 's'} in your library
              </p>
            )}
          </div>
          <CreateCreatorButton />
        </div>

        {creators.length === 0 ? (
          <EmptyState
            icon={<CreatorsIcon className="h-7 w-7" />}
            title="No creators yet"
            body="Creators are picked up automatically from “Creator - Title” filenames when you sync — or create one manually."
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {creators.map((creator) => (
              <li key={creator.id}>
                <Link
                  href={`/creator/${creator.slug}`}
                  className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-border-light hover:bg-surface-raised"
                >
                  <Avatar
                    name={creator.name}
                    photoUrl={creator.avatar ? `/api/creators/${creator.id}/photo` : null}
                    size="lg"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold">{creator.name}</span>
                    <span className="mt-0.5 block text-[13px] text-muted">
                      {creator._count.videos} video{creator._count.videos === 1 ? '' : 's'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
