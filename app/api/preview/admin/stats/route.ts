import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { canManagePreviews } from '@/lib/preview/admin';
import { getPreviewFailures, getPreviewLibraryStats } from '@/lib/preview/jobs';

/**
 * Phase 5.1: preview-generation dashboard data.
 *
 * Every number is read from PostgreSQL plus the actual preview artifacts on
 * disk; a job row alone never counts as a completed preview. Server-side
 * authorization + per-user scoping keep this owner-only.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    if (!canManagePreviews(user)) {
      return NextResponse.json({ error: 'Not authorized.' }, { status: 403 });
    }

    const [stats, failures] = await Promise.all([
      getPreviewLibraryStats(user.id),
      getPreviewFailures(user.id, 20),
    ]);

    return NextResponse.json(
      { stats, failures },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
