import Link from 'next/link';
import { listCreators } from '@/lib/videos';

export const metadata = { title: 'Creators' };

export const dynamic = 'force-dynamic';

export default async function CreatorsPage() {
  const creators = await listCreators();

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Creators</h1>

      {creators.length === 0 ? (
        <p className="py-16 text-center text-muted">No creators yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {creators.map((creator) => (
            <Link
              key={creator.slug}
              href={`/creator/${creator.slug}`}
              className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-card-hover"
            >
              {creator.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={creator.avatar}
                  alt=""
                  className="h-12 w-12 rounded-full object-cover"
                />
              ) : (
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/20 text-lg font-bold text-accent">
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
  );
}