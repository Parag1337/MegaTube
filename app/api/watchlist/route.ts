import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { listWatchlist } from '@/lib/personal';

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const page = Number(request.nextUrl.searchParams.get('page') ?? '1');
    const result = await listWatchlist(user.id, page);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
