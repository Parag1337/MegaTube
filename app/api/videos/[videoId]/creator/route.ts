import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function PATCH(request: NextRequest, context: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { videoId } = await context.params;
    const videoIdNum = parseInt(videoId);
    if (isNaN(videoIdNum)) {
      return NextResponse.json({ error: 'Invalid video ID.' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const creatorId = typeof body?.creatorId === 'number' ? body.creatorId : null;

    // Verify video ownership
    const video = await prisma.video.findFirst({
      where: {
        id: videoIdNum,
        megaAccount: {
          userId: user.id,
        },
      },
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatar: true,
          },
        },
      },
    });

    if (!video) {
      return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
    }

    // If creatorId is provided, verify it belongs to the user
    if (creatorId !== null) {
      const creator = await prisma.creator.findFirst({
        where: {
          id: creatorId,
          userId: user.id,
        },
        select: { id: true },
      });

      if (!creator) {
        return NextResponse.json({ error: 'Creator not found.' }, { status: 404 });
      }
    }

    // Update the video's creator assignment
    const updatedVideo = await prisma.video.update({
      where: { id: videoIdNum },
      data: {
        creatorId,
        creatorAssignment: creatorId ? 'manual' : 'none',
      },
      include: {
        creator: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatar: true,
          },
        },
      },
    });

    return NextResponse.json({
      video: {
        id: updatedVideo.id,
        creator: updatedVideo.creator,
        creatorAssignment: updatedVideo.creatorAssignment,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
