import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getVideoBySlug, getRecommendations } from '@/lib/videos';
import { getCurrentUser } from '@/lib/auth';
import { MegaPlayer } from '@/components/MegaPlayer';
import { PrivatePlayer } from '@/components/PrivatePlayer';
import { VideoGrid } from '@/components/VideoGrid';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';

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

  // Private videos are only visible to the owner of the linked MEGA account.
  // A non-owner (or logged-out visitor) gets the same 404 as a missing slug,
  // so existence is never leaked.
  if (video.isPrivate) {
    const user = await getCurrentUser();
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

  // Recommendations are a public-catalog feature; for private videos we show
  // nothing (the user's own library is on the account page).
  const recommendations = isPrivate
    ? []
    : await getRecommendations(video.id, video.creator?.id ?? null);

  return (
    <div className="mx-auto max-w-5xl">
      {needsReconnect ? (
        <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-border bg-card px-6 text-center">
          <div>
            <p className="text-base font-medium">This video can’t be played right now.</p>
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
        <div className="flex aspect-video w-full items-center justify-center rounded-xl border border-border bg-card text-sm text-muted">
          Player unavailable for this video.
        </div>
      )}

      <div className="mt-4">
        <h1 className="text-xl font-semibold sm:text-2xl">{video.title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {isPrivate && video.account ? (
            <span>
              From <span className="font-medium text-foreground">{video.account.label}</span>
            </span>
          ) : video.creator ? (
            <Link href={`/creator/${video.creator.slug}`} className="transition-colors hover:text-accent">
              {video.creator.name}
            </Link>
          ) : (
            <span>Unknown Creator</span>
          )}
          {formatBytes(video.fileSize) && (
            <>
              <span aria-hidden>·</span>
              <span>{formatBytes(video.fileSize)}</span>
            </>
          )}
          {video.mimeType && (
            <>
              <span aria-hidden>·</span>
              <span>{video.mimeType}</span>
            </>
          )}
          {typeof video.duration === 'number' && video.duration > 0 && (
            <>
              <span aria-hidden>·</span>
              <span>{formatDuration(video.duration)}</span>
            </>
          )}
        </div>
      </div>

      {!isPrivate && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Recommended</h2>
          {recommendations.length > 0 ? (
            <VideoGrid videos={recommendations} />
          ) : (
            <p className="py-8 text-center text-muted">No recommendations yet.</p>
          )}
        </section>
      )}
    </div>
  );
}