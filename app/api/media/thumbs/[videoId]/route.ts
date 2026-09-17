import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, promises as fsPromises } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { decryptSecret } from '@/lib/mega/envelope';
import { withMegaSession } from '@/lib/sync/session-cache';
import { getPrivateNodeImage } from '@/lib/mega/attributes';

export const dynamic = 'force-dynamic';

const THUMBS_DIR = path.resolve(process.cwd(), 'data/thumbs');

/**
 * Private MEGA video thumbnail (owner only).
 *
 * Private thumbnails are synced to data/thumbs/<videoId>.<ext> and served
 * through this authenticated route - never through /public, which would
 * expose them to anonymous visitors.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  // Phase 2K: minimal Server-Timing (durations only, no sensitive data) so
  // thumbnail latency can be attributed to auth vs DB vs filesystem.
  const mark = (label: string, t0: number) => `${label};dur=${Math.round(performance.now() - t0)}`;
  const tAll = performance.now();
  const videoId = Number((await params).videoId);
  const validId = Number.isInteger(videoId) && videoId > 0;
  // Phase 1 perf: auth and the video lookup are independent - resolve them
  // concurrently instead of paying two sequential Neon round trips before
  // the first byte. Status precedence is unchanged (401, then 400, then 404).
  const tAuth = performance.now();
  const authPromise = getCurrentUser().then((user) => ({ user, authMs: performance.now() - tAuth }));
  const tDb = performance.now();
  const videoPromise = (validId
    ? prisma.video.findFirst({
        where: { id: videoId, megaAccountId: { not: null } },
        select: {
          id: true,
          thumbnail: true,
          thumbnailAvailable: true,
          megaFa: true,
          fileKeyEncrypted: true,
          megaAccount: { select: { id: true, userId: true, status: true, encryptedSession: true } },
        },
      })
    : Promise.resolve(null)
  ).then((video) => ({ video, dbMs: performance.now() - tDb }));
  const [{ user, authMs }, { video, dbMs }] = await Promise.all([authPromise, videoPromise]);
  const timing = [`auth;dur=${Math.round(authMs)}`, `videodb;dur=${Math.round(dbMs)}`];
  if (!user) {
    return new NextResponse(null, {
      status: 401,
      headers: { 'Server-Timing': [...timing, mark('total', tAll)].join(', ') },
    });
  }

  if (!validId) {
    return new NextResponse(null, {
      status: 400,
      headers: { 'Server-Timing': [...timing, mark('total', tAll)].join(', ') },
    });
  }

  if (!video || !video.megaAccount || video.megaAccount.userId !== user.id) {
    return new NextResponse(null, {
      status: 404,
      headers: { 'Server-Timing': [...timing, mark('total', tAll)].join(', ') },
    });
  }
  if (video.megaAccount.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
    return new NextResponse(null, {
      status: 410,
      headers: { 'Server-Timing': [...timing, mark('total', tAll)].join(', ') },
    });
  }
  // Phase 1 perf: the two local file probes are independent.
  const tFs = performance.now();
  const [hasPng, hasJpg] = await Promise.all([
    readableFile(path.join(THUMBS_DIR, `${videoId}.png`)),
    readableFile(path.join(THUMBS_DIR, `${videoId}.jpg`)),
  ]);
  timing.push(mark('fs', tFs));
  if (hasPng) {
    return withTiming(serveThumbFile(videoId, 'png'), timing, tAll);
  }
  if (hasJpg) {
    return withTiming(serveThumbFile(videoId, 'jpg'), timing, tAll);
  }

  // No file on disk (missing, or removed as broken): without a MEGA-side
  // thumbnail attribute there is nothing to heal from here - use the
  // thumbnail repair action instead, which extracts a real video frame.
  if (!video.thumbnailAvailable) {
    return new NextResponse(null, { status: 404 });
  }

  // thumbnailAvailable but no file on disk: the sync-time fetch failed
  // transiently and sync never retries it (new videos only). Self-heal
  // on demand: MEGA still has the attribute (owner session, same flow as
  // sync), so fetch, store, and serve it now instead of 404ing forever.
  const healed = await healThumbnail(video);
  if (healed) {
    return withTiming(serveThumbFile(videoId, healed), [...timing, mark('heal', tFs)], tAll);
  }

  // thumbnailAvailable but the file is missing (e.g. fetch failed during
  // sync) - the next sync will retry.
  return new NextResponse(null, {
    status: 404,
    headers: { 'Server-Timing': [...timing, mark('total', tAll)].join(', ') },
  });
}

async function readableFile(absPath: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(absPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function withTiming(res: Response, timing: string[], tAll: number): Response {
  const headers = new Headers(res.headers);
  headers.set('Server-Timing', [...timing, `total;dur=${Math.round(performance.now() - tAll)}`].join(', '));
  return new Response(res.body, { status: res.status, headers });
}

function serveThumbFile(videoId: number, ext: string): Response {
  const stream = createReadStream(path.join(THUMBS_DIR, `${videoId}.${ext}`));
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
      // Phase 1 perf: repeat views (back-navigation, revisits) serve thumbnails
      // instantly from the browser cache, with background revalidation after
      // an hour so repaired thumbnails still refresh. No UX change: the same
      // 24 eager images load the same way on first view. `immutable` was
      // rejected: repairs rewrite the same path with new bytes.
      'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
    },
  });
}

async function healThumbnail(video: {
  id: number;
  megaFa: string | null;
  fileKeyEncrypted: string | null;
  megaAccount: { id: number; encryptedSession: string };
}): Promise<'png' | 'jpg' | null> {
  try {
    if (!video.megaFa || !video.fileKeyEncrypted) return null;
    const fileKey = decryptSecret(video.fileKeyEncrypted);
    const image = await withMegaSession(
      video.megaAccount.id,
      video.megaAccount.encryptedSession,
      async (storage) => {
        const request = (storage as unknown as { api: { request: (cmd: Record<string, unknown>) => Promise<unknown> } }).api.request;
        const api = { request: (cmd: Record<string, unknown>) => request.call((storage as unknown as { api: unknown }).api, cmd) };
        return getPrivateNodeImage(api, video.megaFa, 'thumbnail', fileKey);
      },
    );
    if (!image) return null;
    const ext = image.mimeType === 'image/png' ? ('png' as const) : ('jpg' as const);
    await fsPromises.mkdir(THUMBS_DIR, { recursive: true });
    await fsPromises.writeFile(path.join(THUMBS_DIR, `${video.id}.${ext}`), image.data);
    await prisma.video
      .update({ where: { id: video.id }, data: { thumbnail: `/api/media/thumbs/${video.id}` } })
      .catch(() => {});
    return ext;
  } catch (err) {
    console.warn(
      `[thumbs] on-demand heal failed for video ${video.id}: ${err instanceof Error ? err.message.slice(0, 100) : typeof err}`,
    );
    return null;
  }
}
