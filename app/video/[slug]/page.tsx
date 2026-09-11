import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getVideoBySlug, getRecommendations } from '@/lib/videos';
import { getCurrentUser } from '@/lib/auth';
import { MegaPlayer } from '@/components/MegaPlayer';
import { PrivatePlayer } from '@/components/PrivatePlayer';
import { Avatar } from '@/components/ui';
import { AlertIcon, CreatorsIcon } from '@/components/icons';
import { formatBytes, formatDuration } from '@/components/format';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import VideoCreatorControl from './VideoCreatorControl';
import RecordWatch from './RecordWatch';

export const dynamic = 'force-dynamic';

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

  const durationLabel = formatDuration(video.duration);
  const sizeLabel = formatBytes(video.fileSize);
  const metaBits = [durationLabel, sizeLabel, video.mimeType].filter(Boolean) as string[];
  const canManageCreator = isPrivate && user && video.account && video.account.userId === user.id;

  return (
    <div className="px-4 py-5 md:px-6">
      {/* History entry for signed-in viewers of playable videos. */}
      {user && !needsReconnect && <RecordWatch videoId={video.id} />}
      <div className="mx-auto max-w-[2000px]">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* ---------------------------------------------- Player column */}
          <div className="min-w-0">
            <div className="overflow-hidden rounded-2xl bg-black">
              {needsReconnect ? (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/15 text-warning">
                    <AlertIcon className="h-6 w-6" />
                  </span>
                  <div>
                    <p className="text-[15px] font-semibold">This video can’t play right now</p>
                    <p className="mt-1 text-sm text-muted">
                      Its MEGA account needs reconnecting.{' '}
                      <Link href="/account" className="text-accent hover:underline">
                        Open Account to reconnect it
                      </Link>
                      .
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

            <h1 className="mt-4 text-lg font-bold leading-snug tracking-tight sm:text-xl">
              {video.title}
            </h1>

            {/* Creator + owner row */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
              {video.creator ? (
                <Link
                  href={`/creator/${video.creator.slug}`}
                  className="group flex min-w-0 items-center gap-3"
                >
                  <Avatar
                    name={video.creator.name}
                    photoUrl={null}
                    size="md"
                    className="h-10 w-10 group-hover:bg-accent group-hover:text-white"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold group-hover:text-accent">
                      {video.creator.name}
                    </span>
                    <span className="block text-xs text-muted">Creator</span>
                  </span>
                </Link>
              ) : (
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar name="?" size="md" className="h-10 w-10" />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold">Unknown Creator</span>
                    <span className="block text-xs text-muted">No creator in filename</span>
                  </span>
                </span>
              )}
              {isPrivate && video.account && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-xs text-muted">
                  <span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">
                    {video.account.label.charAt(0).toUpperCase()}
                  </span>
                  {video.account.label}
                </span>
              )}
            </div>

            {metaBits.length > 0 && (
              <p className="mt-3 text-[13px] text-muted">{metaBits.join('  ·  ')}</p>
            )}

            {canManageCreator && (
              <div className="mt-4 rounded-2xl border border-border bg-surface p-4">
                <VideoCreatorControl
                  videoId={video.id}
                  currentCreator={
                    video.creator
                      ? { id: 0, name: video.creator.name, slug: video.creator.slug, avatar: null }
                      : null
                  }
                />
              </div>
            )}
          </div>

          {/* ---------------------------------------- Recommendations rail */}
          {!isPrivate && recommendations.length > 0 && (
            <aside className="min-w-0" aria-label="Up next">
              <h2 className="mb-3 text-[15px] font-bold">Up next</h2>
              <ul className="flex flex-col gap-3">
                {recommendations.slice(0, 12).map((rec) => (
                  <li key={rec.id}>
                    <Link href={`/video/${rec.slug}`} className="group flex gap-3">
                      <span className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-xl bg-surface sm:w-44">
                        {rec.thumbnail ? (
                          <img
                            src={rec.thumbnail}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center bg-surface-raised text-muted-light">
                            <CreatorsIcon className="h-6 w-6" />
                          </span>
                        )}
                        {formatDuration(rec.duration) && (
                          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/85 px-1 py-px text-[11px] font-medium tabular-nums text-white">
                            {formatDuration(rec.duration)}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 py-0.5">
                        <span className="line-clamp-2 text-sm font-medium leading-snug group-hover:text-accent">
                          {rec.title || rec.megaFilename.replace(/\.[^.]+$/, '')}
                        </span>
                        {rec.creator && (
                          <span className="mt-1 block truncate text-xs text-muted">
                            {rec.creator.name}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
