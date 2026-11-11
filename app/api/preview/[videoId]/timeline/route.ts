/**
 * Phase 5: timeline spritesheet JPEG (owner only).
 *
 * One canvas of keyframe cells consumed through the WebVTT endpoint by
 * Vidstack's timeline thumbnails. Same conventions as the clip route:
 * owner-only, ETag, private browser caching, eviction refcount.
 */

import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { handlePreviewAsset } from '@/lib/preview/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  const { videoId } = await params;
  return handlePreviewAsset(user?.id ?? null, videoId, 'sprite', {
    ifNoneMatch: request.headers.get('if-none-match'),
    signal: request.signal,
  });
}
