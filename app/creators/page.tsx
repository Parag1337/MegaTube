import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { listCreators } from '@/lib/videos';
import CreateCreatorButton from './CreateCreatorButton';

export const metadata = { title: 'Creators' };

export const dynamic = 'force-dynamic';

export default async function CreatorsPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-[1800px]">
          <h1 className="mb-6 text-xl font-semibold">Creators</h1>
          <p className="text-muted">Please log in to view your creators.</p>
        </div>
      </div>
    );
  }

  const creators = await listCreators(user.id);

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Creators</h1>
          <CreateCreatorButton />
        </div>

        {creators.length === 0 ? (
          <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-border bg-surface">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              <p className="text-muted mb-4">No creators yet.</p>
              <p className="text-sm text-muted-light">Creators will be automatically assigned from video filenames, or you can create them manually.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {creators.map((creator) => (
              <Link
                key={creator.id}
                href={`/creator/${creator.slug}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-hover"
              >
                {creator.avatar ? (
                  <img
                    src={`/api/creators/${creator.id}/photo`}
                    alt=""
                    className="h-12 w-12 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-hover text-lg font-bold text-accent">
                    {creator.name.charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate font-medium">{creator.name}</p>
                  <p className="text-xs text-muted">
                    {creator._count.videos} video{creator._count.videos === 1 ? '' : 's'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}