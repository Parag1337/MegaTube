import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { slugify } from '@/lib/titles';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const creators = await prisma.creator.findMany({
      where: { userId: user.id },
      include: {
        _count: {
          select: { videos: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return NextResponse.json({
      creators: creators.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        avatar: c.avatar,
        description: c.description,
        videoCount: c._count.videos,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description.trim() : undefined;
    const avatar = typeof body?.avatar === 'string' ? body.avatar.trim() : undefined;

    if (!name) {
      return NextResponse.json({ error: 'Creator name is required.' }, { status: 400 });
    }

    if (name.length > 200) {
      return NextResponse.json({ error: 'Creator name is too long.' }, { status: 400 });
    }

    if (description && description.length > 1000) {
      return NextResponse.json({ error: 'Description is too long.' }, { status: 400 });
    }

    // Generate a unique slug for this user
    const baseSlug = slugify(name);
    let slug = baseSlug;
    let counter = 1;

    while (true) {
      const existing = await prisma.creator.findUnique({
        where: { userId_slug: { userId: user.id, slug } },
        select: { id: true },
      });
      if (!existing) break;
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    const creator = await prisma.creator.create({
      data: {
        userId: user.id,
        name,
        slug,
        description,
        avatar,
      },
    });

    return NextResponse.json(
      {
        creator: {
          id: creator.id,
          name: creator.name,
          slug: creator.slug,
          avatar: creator.avatar,
          description: creator.description,
          videoCount: 0,
          createdAt: creator.createdAt,
          updatedAt: creator.updatedAt,
        },
      },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
