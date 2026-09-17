import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { renameVideo, RenameError } from '@/lib/videoRename';
import { withMegaSession, evictMegaSession } from '@/lib/sync/session-cache';
import { renameMegaNode } from '@/lib/mega/nodeOps';
import { markAccountReauthRequired } from '@/lib/megaAccounts';

/**
 * POST /api/videos/[videoId]/rename { name }
 *
 * Renames the actual file node on the owner's linked MEGA account, then
 * updates MegaTube's metadata. Thin wrapper over lib/videoRename - the
 * session/token never leaves the server.
 */
export async function POST(
  request: Request,
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
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const video = await renameVideo(videoIdNum, user.id, body?.name, {
      withMegaSession,
      renameMegaNode,
      markAccountReauthRequired,
      evictMegaSession,
    });
    return NextResponse.json({ video });
  } catch (err) {
    if (err instanceof RenameError) {
      return NextResponse.json(
        { error: err.message, megaRenamed: err.megaRenamed || undefined },
        { status: err.status },
      );
    }
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
