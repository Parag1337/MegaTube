import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { addToWatchlist, isOnWatchlist, removeFromWatchlist } from '@/lib/personal';

function parseVideoId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const videoId = parseVideoId((await context.params).videoId);
    if (videoId === null) {
      return NextResponse.json({ error: 'Invalid video ID.' }, { status: 400 });
    }
    return NextResponse.json({ videoId, onWatchlist: await isOnWatchlist(user.id, videoId) });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
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
    const added = await addToWatchlist(user.id, videoId);
    if (!added) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }
    return NextResponse.json({ videoId, onWatchlist: true, created: added.created });
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
    await removeFromWatchlist(user.id, videoId);
    return NextResponse.json({ videoId, onWatchlist: false });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
