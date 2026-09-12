import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { REPAIR_BATCH_LIMIT, endRepair, repairUserThumbnails, tryBeginRepair } from '@/lib/thumbs/repair';

/**
 * Owner-scoped thumbnail repair: replaces missing/black/broken thumbnails
 * with real frames extracted from the user's own videos. Sequential,
 * bounded per call, safe to re-run. A second call while one is running
 * gets 429 - expensive generation is never parallelized per user, and no
 * endpoint allows touching another user's videos. The slot is shared with
 * the post-sync background repair (same mutex in lib/thumbs/repair).
 */

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const owner = `user:${user.id}`;
    if (!tryBeginRepair(owner)) {
      return NextResponse.json({ error: 'A thumbnail repair is already running.' }, { status: 429 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const rawIds = Array.isArray(body?.videoIds) ? body.videoIds : undefined;
    const videoIds =
      rawIds === undefined
        ? undefined
        : rawIds.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0).slice(0, REPAIR_BATCH_LIMIT);
    const rawLimit = typeof body?.limit === 'number' ? body.limit : undefined;
    const limit =
      rawLimit === undefined
        ? undefined
        : Math.max(1, Math.min(Math.floor(rawLimit), REPAIR_BATCH_LIMIT));

    try {
      const summary = await repairUserThumbnails(user.id, { videoIds, limit });
      return NextResponse.json(summary);
    } finally {
      endRepair(owner);
    }
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
