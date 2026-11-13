import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { canManagePreviews } from '@/lib/preview/admin';
import { retryPreviewJobs } from '@/lib/preview/jobs';
import { enforcePreviewRateLimit } from '@/lib/preview/rate-limit';

/**
 * Phase 5.1: retry terminal preview jobs (owner-only).
 *
 * Failed jobs are always retryable. Unsupported jobs are only retried when
 * the caller explicitly opts in (`includeUnsupported`), because repeating an
 * unsupported codec/container wastes MEGA bandwidth without a genuine fix.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    if (!canManagePreviews(user)) {
      return NextResponse.json({ error: 'Not authorized.' }, { status: 403 });
    }
    const limited = enforcePreviewRateLimit(user.id, 'admin-retry');
    if (limited) return limited;

    let body: { jobIds?: unknown; includeUnsupported?: unknown } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      // Empty body: retry every failed job in the library.
    }
    const jobIds = Array.isArray(body.jobIds)
      ? body.jobIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
          .slice(0, 100)
      : undefined;

    const result = await retryPreviewJobs({
      userId: user.id,
      jobIds,
      includeUnsupported: body.includeUnsupported === true,
    });

    return NextResponse.json(
      { result },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
