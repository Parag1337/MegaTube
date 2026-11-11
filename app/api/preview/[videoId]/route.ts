/**
 * Phase 5: hover preview clip bytes (owner only).
 *
 * Small faststart MP4 (a derived asset — the original is never touched).
 * Range-capable like the media route, refcount-protected against LRU
 * eviction while streaming, and browser-cacheable (`private, max-age=3600`
 * + ETag) so repeat hovers within a session cost zero bytes.
 */

import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { handlePreviewAsset } from '@/lib/preview/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  const { videoId } = await params;
  return handlePreviewAsset(user?.id ?? null, videoId, 'clip', {
    rangeHeader: request.headers.get('range'),
    ifNoneMatch: request.headers.get('if-none-match'),
    signal: request.signal,
  });
}
