import Link from 'next/link';
import { listCreators } from '@/lib/videos';

export const metadata = { title: 'Creators' };

export const dynamic = 'force-dynamic';

export default async function CreatorsPage() {
  const creators = await listCreators();

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <h1 className="mb-6 text-xl font-semibold">Creators</h1>

        {creators.length === 0 ? (
          <div className="flex min-h-[400px] items-center justify-center rounded-lg border border-border bg-surface">
            <div className="text-center">
              <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              <p className="text-muted">No creators yet.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {creators.map((creator) => (
              <Link
                key={creator.slug}
                href={`/creator/${creator.slug}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-hover"
              >
                {creator.avatar ? (
                  <img
                    src={creator.avatar}
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