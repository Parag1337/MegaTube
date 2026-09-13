import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { listSavedVideos } from '@/lib/personal';

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const page = Number(request.nextUrl.searchParams.get('page') ?? '1');
    // ?folder=all (default) | none (uncategorized) | <folderId>
    const rawFolder = request.nextUrl.searchParams.get('folder');
    const folderFilter =
      rawFolder === null || rawFolder === 'all'
        ? { kind: 'all' } as const
        : rawFolder === 'none'
          ? { kind: 'uncategorized' } as const
          : { kind: 'folder', folderId: Number(rawFolder) } as const;
    if (folderFilter.kind === 'folder' && (!Number.isInteger(folderFilter.folderId) || folderFilter.folderId <= 0)) {
      return NextResponse.json({ error: 'Invalid folder.' }, { status: 400 });
    }
    const result = await listSavedVideos(user.id, page, folderFilter);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
