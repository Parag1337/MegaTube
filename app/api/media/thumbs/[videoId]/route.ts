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
  const user = await getCurrentUser();
  if (!user) {
    return new NextResponse(null, { status: 401 });
  }

  const videoId = Number((await params).videoId);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return new NextResponse(null, { status: 400 });
  }

  const video = await prisma.video.findFirst({
    where: { id: videoId, megaAccountId: { not: null } },
    select: {
      id: true,
      thumbnail: true,
      thumbnailAvailable: true,
      megaFa: true,
      fileKeyEncrypted: true,
      megaAccount: { select: { id: true, userId: true, status: true, encryptedSession: true } },
    },
  });

  if (!video || !video.megaAccount || video.megaAccount.userId !== user.id) {
    return new NextResponse(null, { status: 404 });
  }
  if (video.megaAccount.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
    return new NextResponse(null, { status: 410 });
  }
  if (!video.thumbnailAvailable) {
    return new NextResponse(null, { status: 404 });
  }

  for (const ext of ['png', 'jpg']) {
    if (await readableFile(path.join(THUMBS_DIR, `${videoId}.${ext}`))) {
      return serveThumbFile(videoId, ext);
    }
  }

  // thumbnailAvailable but no file on disk: the sync-time fetch failed
  // transiently and sync never retries it (new videos only). Self-heal
  // on demand: MEGA still has the attribute (owner session, same flow as
  // sync), so fetch, store, and serve it now instead of 404ing forever.
  const healed = await healThumbnail(video);
  if (healed) {
    return serveThumbFile(videoId, healed);
  }

  // thumbnailAvailable but the file is missing (e.g. fetch failed during
  // sync) - the next sync will retry.
  return new NextResponse(null, { status: 404 });
}

async function readableFile(absPath: string): Promise<boolean> {
  try {
    const stat = await fsPromises.stat(absPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function serveThumbFile(videoId: number, ext: string): Response {
  const stream = createReadStream(path.join(THUMBS_DIR, `${videoId}.${ext}`));
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
      'Cache-Control': 'private, max-age=3600',
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
