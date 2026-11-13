import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { canManagePreviews } from '@/lib/preview/admin';
import { ensureMissingPreviewJobs } from '@/lib/preview/jobs';
import { previewPriorityManual } from '@/lib/preview/config';
import { enforcePreviewRateLimit } from '@/lib/preview/rate-limit';

/**
 * Phase 5.1: "Generate Missing Previews".
 *
 * Scans the whole library, skips videos that already have a valid
 * current-version artifact on disk (and videos already queued/generating),
 * and inserts idempotent durable jobs for the rest. It never launches ffmpeg:
 * the single bounded worker processes the backlog over time.
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
    // Whole-library scan: the most expensive preview endpoint.
    const limited = enforcePreviewRateLimit(user.id, 'admin-generate');
    if (limited) return limited;

    const result = await ensureMissingPreviewJobs({
      userId: user.id,
      priority: previewPriorityManual(),
      retryEligibleFailed: true,
      verifyArtifacts: true,
    });

    return NextResponse.json(
      { result },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
