import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ user: null });
    }
    return NextResponse.json({ user: { id: user.id, email: user.email, createdAt: user.createdAt } });
  } catch {
    return NextResponse.json({ user: null }, { status: 500 });
  }
}
