import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { clearHistory, listHistory } from '@/lib/personal';

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const page = Number(request.nextUrl.searchParams.get('page') ?? '1');
    const result = await listHistory(user.id, page);
    // BigInt (fileSize) is serialized inside serializeVideo; Date objects
    // survive NextResponse.json natively.
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const removed = await clearHistory(user.id);
    return NextResponse.json({ cleared: true, removed });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
