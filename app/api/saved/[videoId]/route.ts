import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { isVideoSaved, saveVideo, unsaveVideo } from '@/lib/personal';

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
    return NextResponse.json({ videoId, saved: await isVideoSaved(user.id, videoId) });
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
    const saved = await saveVideo(user.id, videoId);
    if (!saved) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }
    return NextResponse.json({ videoId, saved: true, created: saved.created });
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
    await unsaveVideo(user.id, videoId);
    return NextResponse.json({ videoId, saved: false });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
