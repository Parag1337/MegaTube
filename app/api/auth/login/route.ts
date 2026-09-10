import { NextRequest, NextResponse } from 'next/server';
import { normalizeEmail, verifyPassword, createSession } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const email = normalizeEmail(body.email ?? '');
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 400 });
    }

    const token = await createSession(user.id);

    return NextResponse.json({ user: { id: user.id, email: user.email }, token });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
