import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { canManagePreviews } from '@/lib/preview/admin';

/**
 * Phase 5.1: preview-generation preferences (owner-only).
 *
 * `previewAutoGenerate` controls whether MEGA sync enqueues new preview jobs.
 * `previewPaused` pauses the durable worker for this user: queued jobs stay
 * durable and simply resume when it is cleared.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    if (!canManagePreviews(user)) {
      return NextResponse.json({ error: 'Not authorized.' }, { status: 403 });
    }

    let body: { autoGenerate?: unknown; paused?: unknown } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    const data: { previewAutoGenerate?: boolean; previewPaused?: boolean } = {};
    if (typeof body.autoGenerate === 'boolean') data.previewAutoGenerate = body.autoGenerate;
    if (typeof body.paused === 'boolean') data.previewPaused = body.paused;
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: { previewAutoGenerate: true, previewPaused: true },
    });

    return NextResponse.json(
      { autoGenerate: updated.previewAutoGenerate, paused: updated.previewPaused },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
