import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { slugify } from '@/lib/titles';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { id } = await context.params;
    const creatorId = parseInt(id);
    if (isNaN(creatorId)) {
      return NextResponse.json({ error: 'Invalid creator ID.' }, { status: 400 });
    }

    const creator = await prisma.creator.findFirst({
      where: {
        id: creatorId,
        userId: user.id,
      },
      include: {
        _count: {
          select: { videos: true },
        },
      },
    });

    if (!creator) {
      return NextResponse.json({ error: 'Creator not found.' }, { status: 404 });
    }

    return NextResponse.json({
      creator: {
        id: creator.id,
        name: creator.name,
        slug: creator.slug,
        avatar: creator.avatar,
        description: creator.description,
        videoCount: creator._count.videos,
        createdAt: creator.createdAt,
        updatedAt: creator.updatedAt,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { id } = await context.params;
    const creatorId = parseInt(id);
    if (isNaN(creatorId)) {
      return NextResponse.json({ error: 'Invalid creator ID.' }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
    const description = typeof body?.description === 'string' ? body.description.trim() : undefined;
    const avatar = typeof body?.avatar === 'string' ? body.avatar.trim() : undefined;

    if (name && name.length > 200) {
      return NextResponse.json({ error: 'Creator name is too long.' }, { status: 400 });
    }

    if (description && description.length > 1000) {
      return NextResponse.json({ error: 'Description is too long.' }, { status: 400 });
    }

    // Verify ownership
    const existing = await prisma.creator.findFirst({
      where: {
        id: creatorId,
        userId: user.id,
      },
      select: { id: true, name: true, slug: true },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Creator not found.' }, { status: 404 });
    }

    // If name is changing, generate a new slug
    let slug = existing.slug;
    if (name && name !== existing.name) {
      const baseSlug = slugify(name);
      slug = baseSlug;
      let counter = 1;

      while (true) {
        const conflict = await prisma.creator.findUnique({
          where: { userId_slug: { userId: user.id, slug } },
          select: { id: true },
        });
        if (!conflict || conflict.id === creatorId) break;
        slug = `${baseSlug}-${counter}`;
        counter++;
      }
    }

    const creator = await prisma.creator.update({
      where: { id: creatorId },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(avatar !== undefined && { avatar }),
        ...(name && name !== existing.name && { slug }),
      },
    });

    // Phase 2 perf: displayed creator names feed the Home page.
    const { invalidateHomeFeed } = await import('@/lib/feedCache');
    invalidateHomeFeed(user.id);

    return NextResponse.json({
      creator: {
        id: creator.id,
        name: creator.name,
        slug: creator.slug,
        avatar: creator.avatar,
        description: creator.description,
        videoCount: 0, // Not needed for update response
        createdAt: creator.createdAt,
        updatedAt: creator.updatedAt,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const { id } = await context.params;
    const creatorId = parseInt(id);
    if (isNaN(creatorId)) {
      return NextResponse.json({ error: 'Invalid creator ID.' }, { status: 400 });
    }

    // Verify ownership
    const existing = await prisma.creator.findFirst({
      where: {
        id: creatorId,
        userId: user.id,
      },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Creator not found.' }, { status: 404 });
    }

    // Unassign all videos from this creator before deleting
    await prisma.video.updateMany({
      where: { creatorId },
      data: {
        creatorId: null,
        creatorAssignment: 'none',
      },
    });

    // Delete the creator
    await prisma.creator.delete({
      where: { id: creatorId },
    });

    // Phase 2 perf: creator pools feed the Home page - drop cached pages.
    const { invalidateHomeFeed } = await import('@/lib/feedCache');
    invalidateHomeFeed(user.id);

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
