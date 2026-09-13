import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { createSavedFolder, listSavedFolders } from '@/lib/savedFolders';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    return NextResponse.json({ folders: await listSavedFolders(user.id) });
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
    const created = await createSavedFolder(user.id, body?.name);
    if (created === null) {
      return NextResponse.json({ error: 'Folder name is required (max 100 characters).' }, { status: 400 });
    }
    if ('duplicate' in created) {
      return NextResponse.json({ error: 'You already have a folder with that name.' }, { status: 409 });
    }
    return NextResponse.json({ folder: created }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
