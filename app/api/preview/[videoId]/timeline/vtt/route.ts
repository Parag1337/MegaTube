/**
 * Phase 5: WebVTT cue list for the timeline spritesheet (owner only).
 *
 * `#xywh=` cell fragments pointing at the sprite route — exactly the format
 * Vidstack's `DefaultVideoLayout thumbnails` expects. Sprite URLs are
 * route-relative so the VTT works from any origin path.
 */

import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { enforcePreviewRateLimit } from '@/lib/preview/rate-limit';
import { handlePreviewVtt } from '@/lib/preview/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  const limited = user ? enforcePreviewRateLimit(user.id, 'asset') : null;
  if (limited) return limited;
  const { videoId } = await params;
  return handlePreviewVtt(user?.id ?? null, videoId, {
    ifNoneMatch: request.headers.get('if-none-match'),
  });
}
