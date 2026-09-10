import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';

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
      megaAccount: { select: { userId: true, status: true } },
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
    const file = path.join(THUMBS_DIR, `${videoId}.${ext}`);
    try {
      const stream = createReadStream(file);
      const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': ext === 'png' ? 'image/png' : 'image/jpeg',
          'Cache-Control': 'private, max-age=3600',
        },
      });
    } catch {
      // try the other extension
    }
  }

  // thumbnailAvailable but the file is missing (e.g. fetch failed during
  // sync) - the next sync will retry.
  return new NextResponse(null, { status: 404 });
}
