import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getVideoBySlug, getRecommendations, listRandomVideos } from '@/lib/videos';
import {
  getSameCreatorVideos,
  getTitleRelatedVideos,
} from '@/lib/recommendations';
import { getCurrentUser } from '@/lib/auth';
import { MegaPlayer } from '@/components/MegaPlayer';
import { PrivatePlayer } from '@/components/PrivatePlayer';
import { Avatar } from '@/components/ui';
import { AlertIcon, CreatorsIcon } from '@/components/icons';
import { VideoGrid } from '@/components/VideoGrid';
import { formatBytes, formatDuration } from '@/components/format';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { ThumbImage } from '@/components/ThumbImage';
import VideoCreatorControl from './VideoCreatorControl';
import { VideoActions } from './VideoActions';
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

  /*
   * Related content, built ONLY from the P2.0 primitives (three bounded
   * queries: title matches, same creator, random pool), all user-scoped
   * with the current video always excluded and no duplicates between the
   * groups. Priority for Up Next (max 4): strongest title matches first,
   * then same-creator videos, then random discovery as the final fallback.
   * Below the player, "From this Creator" is a MIXED section (~24:
   * interleaved creator/title/random) and Discover is a larger random-led
   * mix (~24). Sections shrink gracefully when the library is small - never
   * padded with duplicates. Signed-in viewers get the full split (this also
   * covers private library videos, which previously showed nothing);
   * logged-out viewers of public videos keep the legacy public-only list.
   */
  const UP_NEXT_MAX = 4;
  const SECTION_TARGET = 24;

  /** Round-robin interleave of labeled pools, de-duplicated, capped. */
  function interleavePools<T extends { id: number }>(
    pools: Array<{ source: string; items: T[] }>,
    pattern: string[],
    taken: Set<number>,
    target: number,
  ): { items: T[]; counts: Record<string, number> } {
    const items: T[] = [];
    const counts: Record<string, number> = {};
    const ptrs = pools.map(() => 0);
    const bySource = new Map(pools.map((p) => [p.source, p]));
    let progressed = true;
    let step = 0;
    while (items.length < target && progressed) {
      progressed = false;
      // One full pattern cycle per outer iteration; exhausted sources are
      // skipped so other categories fill naturally.
      for (let k = 0; k < pattern.length && items.length < target; k++) {
        const pool = bySource.get(pattern[(step + k) % pattern.length]);
        if (!pool) continue;
        const idx = pools.indexOf(pool);
        while (ptrs[idx] < pool.items.length && taken.has(pool.items[ptrs[idx]].id)) ptrs[idx]++;
        if (ptrs[idx] < pool.items.length) {
          const v = pool.items[ptrs[idx]++];
          taken.add(v.id);
          items.push(v);
          counts[pool.source] = (counts[pool.source] ?? 0) + 1;
          progressed = true;
        }
      }
      step += pattern.length;
    }
    return { items, counts };
  }

  const titlePool = user
    ? await getTitleRelatedVideos(user.id, video.title, {
        excludeVideoIds: [video.id],
        limit: 24,
      })
    : [];
  const creatorPool = user ? await getSameCreatorVideos(user.id, video.id, 24) : [];
  // Two pages of the deterministic shuffle: the creator section and
  // Discover together can claim up to ~48 videos, so one 24-page pool
  // would starve Discover on larger libraries.
  const randomPool = user
    ? (
        await Promise.all([
          listRandomVideos(user.id, 1, `related-${video.id}`),
          listRandomVideos(user.id, 2, `related-${video.id}`),
        ])
      ).flatMap((r) => r.items)
    : [];

  // Up Next: title matches lead, same creator fills, random only as fallback.
  const upNextTaken = new Set([video.id]);
  const upNext: typeof titlePool = [];
  for (const v of [...titlePool, ...creatorPool, ...randomPool]) {
    if (upNext.length >= UP_NEXT_MAX) break;
    if (upNextTaken.has(v.id)) continue;
    upNextTaken.add(v.id);
    upNext.push(v);
  }

  // "From this Creator": mixed ~40/40/20 creator/title/random interleave.
  const creatorSection = interleavePools(
    [
      { source: 'creator', items: creatorPool },
      { source: 'title', items: titlePool },
      { source: 'random', items: randomPool },
    ],
    ['creator', 'title', 'creator', 'title', 'random'],
    new Set(upNextTaken),
    SECTION_TARGET,
  );

  // Discover: random-led mix of what remains.
  const discoverSection = interleavePools(
    [
      { source: 'random', items: randomPool },
      { source: 'title', items: titlePool },
      { source: 'creator', items: creatorPool },
    ],
    ['random', 'title', 'random', 'creator'],
    new Set([...upNextTaken, ...creatorSection.items.map((v) => v.id)]),
    SECTION_TARGET,
  );

  const legacy = !user && !isPrivate ? await getRecommendations(video.id, video.creator?.id ?? null, 30) : [];
  const upNextAnon = legacy.slice(0, UP_NEXT_MAX);
  // Logged-out viewers cannot split the legacy list by source, so the
  // remainder simply becomes the Discover section.
  const discoverAnon = legacy.slice(UP_NEXT_MAX, UP_NEXT_MAX + SECTION_TARGET);

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

            {user && !needsReconnect && <VideoActions videoId={video.id} />}

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
          {(user ? upNext : upNextAnon).length > 0 && (
            <aside className="min-w-0" aria-label="Up next">
              <h2 className="mb-3 text-[15px] font-bold">Up next</h2>
              <ul className="flex flex-col gap-3">
                {(user ? upNext : upNextAnon).map((rec) => (
                  <li key={rec.id}>
                    <Link href={`/video/${rec.slug}`} className="group flex gap-3">
                      <span className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-xl bg-surface sm:w-44">
                        {rec.thumbnail ? (
                          <ThumbImage src={rec.thumbnail} />
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

        {/* ------------------------------- Below-video related sections --- */}
        {(creatorSection.items.length > 0 || discoverSection.items.length > 0 || discoverAnon.length > 0) && (
          <div className="mt-10 flex flex-col gap-10">
            {video.creator && creatorSection.items.length > 0 && (
              <section aria-labelledby="from-creator">
                <h2 id="from-creator" className="mb-4 text-lg font-bold tracking-tight">
                  From this Creator
                </h2>
                <VideoGrid videos={creatorSection.items} />
              </section>
            )}

            {(discoverSection.items.length > 0 || discoverAnon.length > 0) && (
              <section aria-labelledby="discover-more">
                <h2 id="discover-more" className="mb-4 text-lg font-bold tracking-tight">
                  Discover
                </h2>
                <VideoGrid videos={discoverSection.items.length > 0 ? discoverSection.items : discoverAnon} />
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
