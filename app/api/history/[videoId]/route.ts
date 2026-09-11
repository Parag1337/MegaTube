import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { recordWatch, removeHistoryItem } from '@/lib/personal';

function parseVideoId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

export async function POST(_request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const videoId = parseVideoId((await context.params).videoId);
    if (videoId === null) {
      return NextResponse.json({ error: 'Invalid video ID.' }, { status: 400 });
    }
    const recorded = await recordWatch(user.id, videoId);
    if (!recorded) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }
    return NextResponse.json({ videoId, lastWatchedAt: recorded.lastWatchedAt });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const videoId = parseVideoId((await context.params).videoId);
    if (videoId === null) {
      return NextResponse.json({ error: 'Invalid video ID.' }, { status: 400 });
    }
    const removed = await removeHistoryItem(user.id, videoId);
    return NextResponse.json({ videoId, removed });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
