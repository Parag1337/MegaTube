import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { deleteVideo, DeleteVideoError } from '@/lib/videoDelete';
import { withMegaSession, evictMegaSession } from '@/lib/sync/session-cache';
import { deleteMegaNode } from '@/lib/mega/nodeOps';
import { markAccountReauthRequired } from '@/lib/megaAccounts';
import { enqueueSync } from '@/lib/sync/queue';

/**
 * DELETE /api/videos/[videoId]
 *
 * Deletes the actual MEGA file (via the shared `a=d` node op also used by
 * the duplicate-deletion endpoints) plus the MegaTube record. Thin wrapper
 * over lib/videoDelete.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ videoId: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const { videoId } = await params;
    const videoIdNum = Number(videoId);
    if (!Number.isInteger(videoIdNum) || videoIdNum <= 0) {
      return NextResponse.json({ error: 'Invalid video ID.' }, { status: 400 });
    }
    const result = await deleteVideo(videoIdNum, user.id, {
      withMegaSession,
      deleteMegaNode,
      markAccountReauthRequired,
      evictMegaSession,
      enqueueSync,
    });
    return NextResponse.json({ deleted: result });
  } catch (err) {
    if (err instanceof DeleteVideoError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
