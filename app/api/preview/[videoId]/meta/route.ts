/**
 * Phase 5: preview metadata + bounded on-demand generation (owner only).
 *
 * Answers from the disk sidecar whenever possible; missing assets are
 * enqueued into the bounded preview queue (single-flight per video). The
 * response is hover-centric (`status` mirrors the hover asset) with a
 * separate `timeline` block. `Cache-Control: no-store` — state changes as
 * generation completes.
 */

import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { handlePreviewMeta } from '@/lib/preview/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  const { videoId } = await params;
  return handlePreviewMeta(user?.id ?? null, videoId, {
    want: request.nextUrl.searchParams.get('want'),
    signal: request.signal,
  });
}
