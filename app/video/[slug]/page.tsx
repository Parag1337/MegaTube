import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getVideoBySlug, getRecommendations } from '@/lib/videos';
import { getCurrentUser } from '@/lib/auth';
import { MegaPlayer } from '@/components/MegaPlayer';
import { PrivatePlayer } from '@/components/PrivatePlayer';
import { VideoGrid } from '@/components/VideoGrid';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import VideoCreatorControl from './VideoCreatorControl';

export const dynamic = 'force-dynamic';

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

interface VideoPageProps {
  params: Promise<{ slug: string }>;
}

export default async function VideoPage({ params }: VideoPageProps) {
  const { slug } = await params;
  const video = await getVideoBySlug(slug);
  if (!video) notFound();

  const user = await getCurrentUser();
  if (video.isPrivate) {
    if (!user || !video.account || video.account.userId !== user.id) {
      notFound();
    }
  }

  const isPrivate = video.isPrivate;
  const needsReconnect =
    isPrivate &&
    video.account !== null &&
    (video.account.status === MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED ||
      video.account.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED);

  const recommendations = isPrivate
    ? []
    : await getRecommendations(video.id, video.creator?.id ?? null);

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-[1800px]">
        <div className="grid gap-6 lg:grid-cols-[1fr_400px]">
          {/* Main content - video player and info */}
          <div className="space-y-4">
            {/* Video Player */}
            <div className="overflow-hidden rounded-lg bg-black">
              {needsReconnect ? (
                <div className="flex aspect-video w-full items-center justify-center bg-surface px-6 text-center">
                  <div>
                    <svg className="mx-auto h-12 w-12 text-muted-light mb-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/>
                      <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <p className="text-base font-medium">This video can&apos;t be played right now.</p>
                    <p className="mt-1 text-sm text-muted">
                      Its MEGA account needs to be reconnected. Open your Account page to reconnect it.
                    </p>
                  </div>
                </div>
              ) : isPrivate ? (
                <PrivatePlayer videoId={video.id} title={video.title} />
              ) : video.embedUrl ? (
                <MegaPlayer embedUrl={video.embedUrl} title={video.title} />
              ) : (
                <div className="flex aspect-video w-full items-center justify-center bg-surface text-sm text-muted">
                  Player unavailable for this video.
                </div>
              )}
            </div>

            {/* Video Info */}
            <div className="space-y-3">
              <h1 className="text-xl font-semibold sm:text-2xl">{video.title}</h1>
              
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
                {isPrivate && video.account ? (
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface">
                      <span className="text-sm font-medium text-accent">
                        {video.account.label.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="text-foreground">{video.account.label}</span>
                  </div>
                ) : video.creator ? (
                  <Link 
                    href={`/creator/${video.creator.slug}`} 
                    className="flex items-center gap-2 transition-colors hover:text-foreground"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface">
                      <span className="text-sm font-medium text-accent">
                        {video.creator.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span>{video.creator.name}</span>
                  </Link>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface">
                      <svg className="h-5 w-5 text-muted-light" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                      </svg>
                    </div>
                    <span>Unknown Creator</span>
                  </div>
                )}

                {formatBytes(video.fileSize) && (
                  <>
                    <span aria-hidden className="text-muted-light">·</span>
                    <span>{formatBytes(video.fileSize)}</span>
                  </>
                )}
                {video.mimeType && (
                  <>
                    <span aria-hidden className="text-muted-light">·</span>
                    <span>{video.mimeType}</span>
                  </>
                )}
                {typeof video.duration === 'number' && video.duration > 0 && (
                  <>
                    <span aria-hidden className="text-muted-light">·</span>
                    <span>{formatDuration(video.duration)}</span>
                  </>
                )}
              </div>

              {/* Creator control for private video owners */}
              {isPrivate && user && video.account && video.account.userId === user.id && (
                <VideoCreatorControl videoId={video.id} currentCreator={video.creator ? { id: 0, name: video.creator.name, slug: video.creator.slug, avatar: null } : null} />
              )}
            </div>
          </div>

          {/* Sidebar - Recommendations */}
          {!isPrivate && recommendations.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Recommended</h2>
              <div className="space-y-3">
                {recommendations.slice(0, 10).map((rec) => (
                  <Link
                    key={rec.id}
                    href={`/video/${rec.slug}`}
                    className="flex gap-3 group"
                  >
                    <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-lg bg-black">
                      {rec.thumbnail ? (
                        <img
                          src={rec.thumbnail}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-surface">
                          <svg className="h-8 w-8 text-muted-light" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="line-clamp-2 text-sm font-medium leading-tight text-foreground group-hover:text-foreground">
                        {rec.title || rec.megaFilename.replace(/\.[^.]+$/, '')}
                      </h3>
                      {rec.creator && (
                        <p className="mt-1 text-xs text-muted">{rec.creator.name}</p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Full recommendations grid below on mobile */}
        {!isPrivate && recommendations.length > 0 && (
          <section className="mt-8 lg:hidden">
            <h2 className="mb-4 text-lg font-semibold">More videos</h2>
            <VideoGrid videos={recommendations} />
          </section>
        )}
      </div>
    </div>
  );
}