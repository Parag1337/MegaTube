import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const CREATORS_DIR = path.resolve(process.cwd(), 'data/creators');

// Ensure the directory exists
if (!existsSync(CREATORS_DIR)) {
  mkdirSync(CREATORS_DIR, { recursive: true });
}

/**
 * Get creator photo
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return new NextResponse(null, { status: 401 });
    }

    const { id } = await context.params;
    const creatorId = parseInt(id);
    if (isNaN(creatorId)) {
      return new NextResponse(null, { status: 400 });
    }

    const creator = await prisma.creator.findFirst({
      where: {
        id: creatorId,
        userId: user.id,
      },
      select: { id: true, avatar: true },
    });

    if (!creator || !creator.avatar) {
      return new NextResponse(null, { status: 404 });
    }

    const file = path.join(CREATORS_DIR, creator.avatar);
    if (!existsSync(file)) {
      return new NextResponse(null, { status: 404 });
    }

    const stream = createReadStream(file);
    const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    
    const ext = path.extname(creator.avatar).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : 
                        ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 
                        ext === '.webp' ? 'image/webp' : 'image/jpeg';

    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch {
    return new NextResponse(null, { status: 500 });
  }
}

/**
 * Upload creator photo
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
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
      select: { id: true, avatar: true },
    });

    if (!creator) {
      return NextResponse.json({ error: 'Creator not found.' }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.' },
        { status: 400 },
      );
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 5MB.' },
        { status: 400 },
      );
    }

    // Delete old photo if exists
    if (creator.avatar) {
      const oldFile = path.join(CREATORS_DIR, creator.avatar);
      if (existsSync(oldFile)) {
        try {
          unlinkSync(oldFile);
        } catch {
          // Ignore deletion errors
        }
      }
    }

    // Generate new filename
    const ext = file.type === 'image/png' ? '.png' : 
                file.type === 'image/webp' ? '.webp' : '.jpg';
    const filename = `${creatorId}-${Date.now()}${ext}`;
    const filepath = path.join(CREATORS_DIR, filename);

    // Save file
    const buffer = Buffer.from(await file.arrayBuffer());
    createWriteStream(filepath).write(buffer);

    // Update creator record
    const updatedCreator = await prisma.creator.update({
      where: { id: creatorId },
      data: { avatar: filename },
    });

    return NextResponse.json({
      creator: {
        id: updatedCreator.id,
        avatar: updatedCreator.avatar,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

/**
 * Delete creator photo
 */
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

    const creator = await prisma.creator.findFirst({
      where: {
        id: creatorId,
        userId: user.id,
      },
      select: { id: true, avatar: true },
    });

    if (!creator) {
      return NextResponse.json({ error: 'Creator not found.' }, { status: 404 });
    }

    if (creator.avatar) {
      const file = path.join(CREATORS_DIR, creator.avatar);
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // Ignore deletion errors
        }
      }

      // Update creator record
      await prisma.creator.update({
        where: { id: creatorId },
        data: { avatar: null },
      });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
