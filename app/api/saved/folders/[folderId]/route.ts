import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { deleteSavedFolder, renameSavedFolder } from '@/lib/savedFolders';

function parseFolderId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ folderId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const folderId = parseFolderId((await context.params).folderId);
    if (folderId === null) {
      return NextResponse.json({ error: 'Invalid folder ID.' }, { status: 400 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const outcome = await renameSavedFolder(user.id, folderId, body?.name);
    if (outcome === 'not-found') {
      return NextResponse.json({ error: 'Folder not found.' }, { status: 404 });
    }
    if (outcome === 'invalid') {
      return NextResponse.json({ error: 'Folder name is required (max 100 characters).' }, { status: 400 });
    }
    if (outcome === 'duplicate') {
      return NextResponse.json({ error: 'You already have a folder with that name.' }, { status: 409 });
    }
    return NextResponse.json({ folderId, ok: true });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ folderId: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const folderId = parseFolderId((await context.params).folderId);
    if (folderId === null) {
      return NextResponse.json({ error: 'Invalid folder ID.' }, { status: 400 });
    }
    // Videos inside return to uncategorized - never deleted or unsaved.
    const deleted = await deleteSavedFolder(user.id, folderId);
    if (!deleted) {
      return NextResponse.json({ error: 'Folder not found.' }, { status: 404 });
    }
    return NextResponse.json({ folderId, deleted: true, movedBack: deleted.movedBack });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
