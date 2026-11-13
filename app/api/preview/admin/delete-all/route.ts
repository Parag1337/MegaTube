import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { canManagePreviews } from '@/lib/preview/admin';
import { deleteAllUserPreviews } from '@/lib/preview/jobs';
import { enforcePreviewRateLimit } from '@/lib/preview/rate-limit';

/**
 * Phase 5.1: Delete all previews for the authenticated user.
 *
 * Scopes the deletion to the authenticated user's videos only.
 * Removes all preview artifacts (clips, spritesheets, VTT, sidecars)
 * and resets the preview job queue for those videos.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    if (!canManagePreviews(user)) {
      return NextResponse.json({ error: 'Not authorized.' }, { status: 403 });
    }
    const limited = enforcePreviewRateLimit(user.id, 'admin-delete-all');
    if (limited) return limited;

    const result = await deleteAllUserPreviews(user.id);

    return NextResponse.json(
      { result },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
